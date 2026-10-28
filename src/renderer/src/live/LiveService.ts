// Live views' lifecycle in the renderer (docs/ipc.md, Live subscriptions): each view subscribes through LiveService, which
// keeps the subscription in step with what the user can see. The backend schedules every sample and the renderer never
// polls; the only timers here are the hidden-view hysteresis, the 150 ms settings debounce, the moment a probe turns stale
// and the back-off before an update the backend refused for now is sent again. Every frame is applied synchronously and
// only then acknowledged, so the next one can come.
import type { ApiResult, ResultDescriptor } from '../../../shared/contracts'
import { limits, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import { liveProbes, liveSources, type LiveProbeId, type LiveProbeSpec, type LiveSourceId, type LiveSourceSpec } from '../../../shared/live/catalog'
import type { LiveArgs, LiveEnd, LiveErrorCode, LiveEvent, LiveFilter, LiveOpenedEvent, LiveProbeError, LiveProbePatch, LiveSort, LiveSubscribeParams, LiveTick, LiveUpdateResult } from '../../../shared/live/schema'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import type { LivePatch, LiveStream, ResultClient, ResultHandle } from '../results/ResultClient'
import type { ResultKey } from '../results/worker-protocol'
import type { DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import { MetricRing, ringBytesPerSample, ringGap, ringMaxCapacity, ringReset } from './ring'

const MiB = 1024 * 1024
export const liveServiceLimits = {
  /** Open handles in a window: main runs at most this many live streams on the results port. */
  handles: limits.live.portStreams,
  /** Hidden views that keep their status probes running (a source's `hidden: 'statusOnly'`). */
  statusOnly: 4,
  /** A status-only view samples at most this often: the catalogue's hidden interval, which docs/live.md states. */
  statusOnlyIntervalMs: limits.live.hiddenIntervalMs,
  ringBytesPerHandle: 4 * MiB,
  ringBytes: 32 * MiB,
  settingsDebounceMs: 150,
  /** An update refused for now (too many requests, busy, timed out) is sent again after 1 s, doubling to 30 s. */
  retryMs: { first: 1000, max: 30_000 },
  /** Track lists kept per table for the samples that answer them: well above what one sample can span (a list per row
   *  of a held arrow key, one update in flight at a time, samples of at most 5 s). */
  trackHistory: 64
} as const

/** What a live view belongs to: its visibility pauses the view, and its end ends it. */
export interface LiveOwner {
  readonly key: string
  visible(): boolean
  /** Called whenever visible(), connectionId() or closed() may have changed. */
  subscribe(listener: () => void): () => void
  /** The connection the owner now follows: a Reconnect moves a tab to the new connection, and the view follows it.
   *  Undefined: the owner lost its connection, and the view ends. */
  connectionId?(): string | undefined
  /** The owner is gone (its tab closed): the view ends and its handle is disposed. */
  closed?(): boolean
}
/** Whether the window can be seen: minimized and hidden windows on every platform, occluded ones on macOS. */
export interface PageVisibility { hidden(): boolean; subscribe(listener: () => void): () => void }
export interface LiveSettingsSource { getSnapshot(): { readonly values: SettingsValues }; subscribe(listener: () => void): () => void }
export interface LiveCatalog {
  readonly sources: Readonly<Record<string, LiveSourceSpec>>
  readonly probes: Readonly<Record<string, LiveProbeSpec>>
}

export interface LiveProbeOptions { intervalMs?: number; paused?: boolean; sort?: LiveSort[]; view?: string; filter?: LiveFilter }
export interface LiveSpec {
  connectionId: string
  source: LiveSourceId
  args?: LiveArgs
  probes: readonly ({ probe: LiveProbeId } & LiveProbeOptions)[]
  /** Hidden, keep the probes without tables running at 30 s or slower instead of pausing, where the source allows it
   *  (an SSIS execution this window started, so its end is still seen). At most 4 such views a window; others pause. */
  whileHidden?: 'statusOnly'
}

export type LiveStatus = 'connecting' | 'live' | 'paused' | 'dormant' | 'lost' | 'ended'
export type LiveProbeState = 'fresh' | 'stale' | 'failing' | 'limited' | 'unavailable' | 'paused'
export interface LiveProbeSnapshot {
  readonly state: LiveProbeState
  /** The interval the view asked for, and the one the backend runs (longer when it backs off). */
  readonly intervalMs: number
  readonly effectiveIntervalMs: number
  /** The newest sample's time (the backend's clock, Unix ms). */
  readonly lastSampleAt?: number
  readonly costMs?: number
  readonly error?: LiveProbeError
  /** Why the backend opened the probe limited or unavailable, and its note. */
  readonly reason?: LiveErrorCode
  readonly note?: string
}
export interface LiveSnapshot {
  readonly status: LiveStatus
  readonly pausedBy?: 'hidden' | 'user'
  /** Hidden, but its probes without tables keep running (LiveSpec.whileHidden). */
  readonly hiddenMode?: 'statusOnly'
  readonly probes: Readonly<Record<string, LiveProbeSnapshot>>
  readonly connectionId: string
  /** The running subscription's id: a new one each time the view subscribes again. */
  readonly subscriptionId?: string
  readonly spid?: number
  /** How the last subscription ended (status ended). */
  readonly ended?: LiveEnd
  /** Why the view cannot run (status ended or lost), or why its last settings change failed. */
  readonly error?: { readonly code: ErrorCode | LiveErrorCode; readonly message: string }
}
/** A table of a probe's latest sample: an ordinary stored result. */
export interface LiveTable {
  readonly probe: LiveProbeId
  readonly index: number
  readonly mode: 'snapshot' | 'append'
  readonly descriptor: ResultDescriptor
  readonly handle: ResultHandle
  readonly revision?: number
  readonly segment?: number
  readonly diff?: { readonly added: number; readonly removed: number; readonly changed: number }
  /** Where each tracked key went (-1: gone), in the order of the track list with this seq; `keys` is that list when the
   *  view still knows it (every list since the newest one answered), so a grid can map its rows without asking again. */
  readonly tracked?: { readonly seq: number; readonly rows: readonly number[]; readonly keys?: readonly string[] }
  /** Rows of this revision that left the source and stay one revision because they were tracked (LiveGrid mutes them). */
  readonly departed?: readonly number[]
  /** Append: the segment this one rolled on from, and whether the table started again (a new filter or args). */
  readonly rolledFrom?: number
  readonly restarted?: boolean
}
export interface AppliedTick { readonly subscriptionId: string; readonly tick: LiveTick }
export interface LiveFrames { readonly events: number; readonly ticks: number; readonly lastSeq: number; readonly updates: number; readonly lastPatch?: LivePatch; readonly subscriptions: number }

export interface LiveHandle extends ExternalStore<LiveSnapshot>, Disposable {
  /** Stable for the view's life; each subscription it makes has its own id (LiveSnapshot.subscriptionId). */
  readonly id: string
  readonly source: LiveSourceId
  readonly ownerKey: string
  /** Changes a probe's settings; changes within 150 ms go as one update. A member present as undefined drops that
   *  setting (sort, view, filter) or restores the default interval. */
  setProbe(probe: LiveProbeId, patch: LiveProbeOptions): void
  /** Replaces the source's arguments (live.update `args`): the subscription, its history and its state carry on, and a
   *  later subscription (out of dormancy, after a Reconnect) uses them. A refusal is reported on the view. */
  setArgs(args: LiveArgs): void
  /** Pause / Resume: no SQL while paused, whatever the view's visibility. */
  setUserPaused(paused: boolean): void
  /** Refresh now: every running probe samples at once (a dormant view subscribes again). */
  refresh(): void
  /** A probe's settings as the view wants them (what setProbe last set), read only; undefined for a probe it does not run. */
  probeOptions(probe: LiveProbeId): Readonly<LiveProbeOptions> | undefined
  /** Follows rows of a keyed snapshot table across revisions (each key: the key columns' cell texts joined with U+001F).
   *  `linger`: how many of the first keys (the selected rows) stay one revision when they leave; all of them by default. */
  track(probe: LiveProbeId, keys: readonly string[], table?: number, linger?: number): void
  /** A metrics probe's history, for charts; read only. */
  ring(probe: LiveProbeId): MetricRing | undefined
  table(probe: LiveProbeId, index?: number): LiveTable | undefined
  /** Each applied tick, synchronously, before it is acknowledged. */
  onTick(listener: (tick: AppliedTick) => void): Disposable
}
export interface LiveHandleSummary { readonly id: string; readonly source: LiveSourceId; readonly connectionId: string; readonly ownerKey: string; readonly status: LiveStatus }
export interface LiveServiceSnapshot { readonly handles: readonly LiveHandleSummary[] }
/** An open view's state as `peek` reports it: `stale` unless every probe is fresh and running. */
export interface LivePeek { readonly id: string; readonly connectionId: string; readonly snapshot: LiveSnapshot; readonly stale: boolean }

/** A tab's visibility: it is the active document and the editor area shows. */
export function documentOwner(tabId: string, documents: Pick<DocumentService, 'getSnapshot' | 'get' | 'subscribe'>, panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>): LiveOwner {
  return {
    key: 'tab:' + tabId,
    visible: () => documents.getSnapshot().activeId === tabId && panes.getSnapshot().editor,
    connectionId: () => documents.get(tabId)?.connectionId,
    closed: () => !documents.get(tabId),
    subscribe: listener => {
      const stopDocuments = documents.subscribe(listener), stopPanes = panes.subscribe(listener)
      return () => { stopDocuments(); stopPanes() }
    }
  }
}
/** The page's own visibility (document.visibilityState). */
export function documentPage(target: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>): PageVisibility {
  return {
    hidden: () => target.visibilityState !== 'visible',
    subscribe: listener => {
      target.addEventListener('visibilitychange', listener)
      return () => target.removeEventListener('visibilitychange', listener)
    }
  }
}

const tooMany = 'Too many live views are open in this window. Close one and retry.'
const invalidSpec = 'This live view names probes its source does not have.'
export const sameSort = (left?: readonly LiveSort[], right?: readonly LiveSort[]) => (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((key, at) => key.column === right![at].column && key.descending === right![at].descending && key.table === right![at].table)
const sameFilter = (left?: LiveFilter, right?: LiveFilter) => left === right || (!!left && !!right && left.text === right.text && (left.columns ?? []).join('\u001f') === (right.columns ?? []).join('\u001f') && !!left.columns === !!right.columns)
const lostCodes: ReadonlySet<ErrorCode> = new Set(['BACKEND_LOST', 'RESULT_UNAVAILABLE', 'BACKEND_UNAVAILABLE'])
/** Errors of an update to a stream that is ending: its end reports what happened. Updates wait for live.opened, so a
 *  subscription the backend has not registered yet never answers NOT_FOUND. */
const endingCodes: ReadonlySet<ErrorCode> = new Set(['NOT_FOUND', 'CANCELLED'])
/** Refusals that may pass: the update is sent again after a back-off. Any other is not, until the view changes again. */
const retryCodes: ReadonlySet<ErrorCode> = new Set(['TOO_MANY_REQUESTS', 'BUSY', 'TIMEOUT', 'BACKEND_UNAVAILABLE'])

interface ProbeSettings { intervalMs: number; paused: boolean; sort?: LiveSort[]; view?: string; filter?: LiveFilter }
interface Wanted { paused: boolean; probes: Map<LiveProbeId, ProbeSettings> }
/** What the backend runs: the subscription's settings, then each update it accepted. `virtual`: a subscription made while
 *  paused pauses every probe instead (subscribe has no subscription-wide pause), so resuming unpauses the probes. */
interface Sent extends Wanted { virtual: boolean; args: LiveArgs | undefined }
interface StreamRecord {
  readonly live: LiveStream
  readonly subscriptionId: string
  readonly connectionId: string
  sent: Sent
  /** The tracked keys' seq the backend accepted, by probe/table. */
  readonly tracked: Map<string, number>
  opened: boolean
  /** True once live.opened arrives, false if the stream ends or is stopped first. The backend registers a subscription
   *  just before live.opened, so every update waits for it rather than being refused NOT_FOUND. */
  readonly ready: Promise<boolean>
  becameReady(opened: boolean): void
  /** Its end arrived: a new subscription may take its place in main's and the backend's counts. */
  settled: boolean
  /** The backend refused the last update and has not accepted one since: the view shows what still runs. */
  refused?: { code: ErrorCode; message: string }
  /** Every result this stream delivered that no later sample retired, by result id: an append table's older segments are
   *  not the table the view shows, but a finished source may keep them too, and closing the view must release them. */
  readonly results: Map<number, ResultKey>
}
interface ProbeRuntime {
  opened?: { state: 'ok' | 'limited' | 'unavailable'; reason?: LiveErrorCode; note?: string; minIntervalMs: number; maxIntervalMs: number }
  effectiveIntervalMs?: number
  lastSampleAt?: number
  /** When the probe last delivered, opened or resumed, on this side's clock: what stale counts from. */
  since?: number
  costMs?: number
  error?: LiveProbeError
}

export class LiveService extends SnapshotStore<LiveServiceSnapshot> implements Disposable {
  readonly timers: Timers
  readonly now: () => number
  readonly catalog: LiveCatalog
  private readonly handles = new Map<string, Handle>()
  private readonly schedule: (callback: () => void) => void
  private readonly stopSettings: () => void
  private readonly stopPage: () => void
  private pageOverride: boolean | undefined
  private flushing = false
  private disposed = false
  statusOnly = 0

  constructor(readonly o: {
    client: Pick<ResultClient, 'live' | 'open' | 'release'>
    settings: LiveSettingsSource
    page: PageVisibility
    timers?: Timers
    now?: () => number
    /** Coalesces snapshot notifications: an animation frame in the app. */
    schedule?: (callback: () => void) => void
    catalog?: LiveCatalog
  }) {
    super({ handles: [] })
    this.timers = o.timers ?? browserTimers
    this.now = o.now ?? (() => Date.now())
    this.schedule = o.schedule ?? (callback => queueMicrotask(callback))
    this.catalog = o.catalog ?? { sources: liveSources, probes: liveProbes }
    let values = o.settings.getSnapshot().values
    this.stopSettings = o.settings.subscribe(() => {
      const next = o.settings.getSnapshot().values
      if (next === values) return
      const history = next['liveData.historyMinutes'] !== values['liveData.historyMinutes']
      const delays = next['liveData.pauseAfterSeconds'] !== values['liveData.pauseAfterSeconds'] || next['liveData.stopAfterHiddenMinutes'] !== values['liveData.stopAfterHiddenMinutes']
      values = next
      for (const handle of [...this.handles.values()]) {
        // Views already hidden take the new delays too, counted from when they hid.
        if (delays) handle.hiddenDelaysChanged()
        handle.visibilityChanged()
      }
      if (history) this.rebalance()
    })
    this.stopPage = o.page.subscribe(() => this.pageChanged())
  }

  get client() { return this.o.client }
  get settings(): SettingsValues { return this.o.settings.getSnapshot().values }
  /** Whether hidden views pause: the setting, and nothing else. */
  get pauseWhenHidden(): boolean { return this.settings['liveData.pauseWhenHidden'] }
  pageHidden(): boolean { return this.pageOverride ?? this.o.page.hidden() }

  /** Test mode: the window counts as hidden (or visible) whatever it is; undefined goes back to the real state. Smoke runs
   *  keep their window visible to the page (background throttling is off), so only this can hide it. */
  setPageHidden(hidden: boolean | undefined): void {
    this.pageOverride = hidden
    this.pageChanged()
  }

  /** Opens a live view; it subscribes at once. A view that cannot run (too many in this window, or probes its source does
   *  not have) is a handle that has ended with the reason: never an exception. */
  open(spec: LiveSpec, owner: LiveOwner): LiveHandle {
    const source = this.catalog.sources[spec.source]
    const valid = !!source && spec.probes.length >= 1 && spec.probes.length <= limits.live.probes && new Set(spec.probes.map(probe => probe.probe)).size === spec.probes.length &&
      spec.probes.every(probe => this.catalog.probes[probe.probe]?.source === spec.source)
    const failure = this.disposed ? { code: 'PORT_CLOSED' as const, message: 'The workbench closed.' } : !valid ? { code: 'INVALID_PARAMS' as const, message: invalidSpec }
      : this.handles.size >= liveServiceLimits.handles ? { code: 'TOO_MANY_REQUESTS' as const, message: tooMany } : undefined
    const handle = new Handle(this, spec, owner, failure)
    if (failure) return handle
    this.handles.set(handle.id, handle)
    handle.start()
    this.changed()
    this.rebalance()
    return handle
  }

  /** Open views of a source, as they are: it never subscribes, so a badge or summary that reads it starts no sampling of
   *  its own, and a paused or hidden view reads as stale. */
  peek(source: LiveSourceId, connectionId?: string): readonly LivePeek[] {
    return [...this.handles.values()].filter(handle => handle.source === source && (connectionId === undefined || handle.connectionId === connectionId)).map(handle => {
      const snapshot = handle.getSnapshot()
      return { id: handle.id, connectionId: handle.connectionId, snapshot, stale: snapshot.status !== 'live' || !!snapshot.hiddenMode || Object.values(snapshot.probes).some(probe => probe.state !== 'fresh') }
    })
  }

  get(id: string): LiveHandle | undefined { return this.handles.get(id) }
  /** Test mode's frame counters. */
  frames(id: string): LiveFrames | undefined { return this.handles.get(id)?.frames() }

  /** Fits every ring in memory: each handle's in 4 MiB, all of them in 32 MiB, never more than the history setting asks. */
  rebalance(): void {
    const handles = [...this.handles.values()]
    const wanted = handles.map(handle => handle.wantedRings())
    let total = 0
    const capped = wanted.map(rings => {
      const bytes = rings.reduce((sum, ring) => sum + ring.capacity * ringBytesPerSample(ring.ring.series), 0)
      const scale = Math.min(1, liveServiceLimits.ringBytesPerHandle / Math.max(1, bytes))
      const sized = rings.map(ring => ({ ring: ring.ring, capacity: Math.floor(ring.capacity * scale) }))
      total += sized.reduce((sum, ring) => sum + ring.capacity * ringBytesPerSample(ring.ring.series), 0)
      return sized
    })
    const scale = Math.min(1, liveServiceLimits.ringBytes / Math.max(1, total))
    for (const rings of capped) for (const { ring, capacity } of rings) ring.resize(Math.floor(capacity * scale))
  }

  /** A handle's state changed: the service's list is published with the next frame. */
  changed(): void {
    if (this.flushing || this.disposed) return
    this.flushing = true
    this.schedule(() => {
      this.flushing = false
      if (this.disposed) return
      this.publish({ handles: [...this.handles.values()].map(handle => ({ id: handle.id, source: handle.source, connectionId: handle.connectionId, ownerKey: handle.ownerKey, status: handle.status })) })
    })
  }
  defer(callback: () => void): void { this.schedule(callback) }

  /** A status-only slot came free: hidden views that paused only because the slots were full take it, oldest first. */
  statusOnlyFreed(): void {
    for (const handle of [...this.handles.values()]) {
      if (this.statusOnly >= liveServiceLimits.statusOnly) return
      handle.claimStatusOnly()
    }
  }

  removed(handle: Handle): void {
    if (this.handles.get(handle.id) !== handle) return
    this.handles.delete(handle.id)
    this.changed()
    this.rebalance()
  }

  private pageChanged(): void {
    for (const handle of [...this.handles.values()]) handle.visibilityChanged()
  }

  dispose(): void {
    if (this.disposed) return
    for (const handle of [...this.handles.values()]) handle.dispose()
    this.disposed = true
    this.stopSettings()
    this.stopPage()
    this.clearListeners()
  }
}

class Handle implements LiveHandle {
  readonly id = crypto.randomUUID()
  readonly source: LiveSourceId
  readonly ownerKey: string
  connectionId: string
  status: LiveStatus = 'connecting'
  private readonly listeners = new Set<() => void>()
  private readonly tickListeners = new Set<(tick: AppliedTick) => void>()
  private readonly settings = new Map<LiveProbeId, ProbeSettings>()
  private readonly runtime = new Map<LiveProbeId, ProbeRuntime>()
  private readonly rings = new Map<LiveProbeId, MetricRing>()
  private readonly tables = new Map<LiveProbeId, Map<number, LiveTable>>()
  private readonly tracks = new Map<string, { probe: LiveProbeId; table: number; keys: string[]; seq: number; linger?: number }>()
  /** The track lists sent per table since the newest one a sample answered, by seq: a sample names the list it answers by
   *  seq alone, and while one sample runs the grid may send many (each active row of a held Down arrow). */
  private readonly trackHistory = new Map<string, { seq: number; keys: readonly string[] }[]>()
  private args: LiveArgs | undefined
  private readonly whileHidden: 'statusOnly' | undefined
  private snapshot: LiveSnapshot
  private stream: StreamRecord | undefined
  /** The last subscription this view stopped: the next one waits for its end (see restart). */
  private previous: StreamRecord | undefined
  private pendingStart = false
  private kept: ResultKey[] = []
  private resume: string | undefined
  private ended: LiveEnd | undefined
  private error: { code: ErrorCode | LiveErrorCode; message: string } | undefined
  /** The error is a refused update's (a later accepted one clears it), not the stream's end. */
  private updateError = false
  private spid: number | undefined
  private userPaused = false
  private hidden = false
  private hiddenPaused = false
  private statusOnly = false
  private pauseTimer: unknown
  private dormantTimer: unknown
  private staleTimer: unknown
  private debounceTimer: unknown
  private retryTimer: unknown
  private retries = 0
  /** When the pending hidden timers started, so a change of their delays counts from then. */
  private pauseArmedAt: number | undefined
  private dormantArmedAt: number | undefined
  private ownerConnection: string | undefined
  private readonly stopOwner: () => void
  private chain: Promise<void> = Promise.resolve()
  private syncQueued = false
  private trackSeq = 0
  private counts = { events: 0, ticks: 0, lastSeq: -1, updates: 0, subscriptions: 0, lastPatch: undefined as LivePatch | undefined }
  private notifyQueued = false
  private disposed = false

  constructor(private readonly service: LiveService, spec: LiveSpec, private readonly owner: LiveOwner, failure?: { code: ErrorCode; message: string }) {
    this.source = spec.source
    this.ownerKey = owner.key
    this.connectionId = spec.connectionId
    this.args = spec.args
    this.whileHidden = spec.whileHidden
    for (const probe of spec.probes) {
      const catalogue = service.catalog.probes[probe.probe]
      const interval = catalogue?.intervalMs ?? { default: limits.live.intervalMs.min, min: limits.live.intervalMs.min, max: limits.live.intervalMs.max }
      this.settings.set(probe.probe, { intervalMs: clamp(probe.intervalMs ?? interval.default, interval.min, interval.max), paused: !!probe.paused, ...probe.sort ? { sort: probe.sort } : {}, ...probe.view ? { view: probe.view } : {}, ...probe.filter ? { filter: probe.filter } : {} })
      this.runtime.set(probe.probe, {})
    }
    if (failure) {
      this.status = 'ended'
      this.error = failure
      this.disposed = true
      this.stopOwner = () => {}
      this.snapshot = this.build()
      return
    }
    this.ownerConnection = owner.connectionId?.()
    this.stopOwner = owner.subscribe(() => this.ownerChanged())
    this.hidden = this.computeHidden()
    this.snapshot = this.build()
  }

  getSnapshot = (): LiveSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ---- Lifecycle -------------------------------------------------------------------------------------------------

  /** Subscribes with the view's current settings: its first time, out of dormancy, and after a Reconnect. */
  start(): void {
    if (this.disposed) return
    const desired = this.desired()
    const subscriptionId = this.counts.subscriptions === 0 ? this.id : crypto.randomUUID()
    this.counts.subscriptions++
    const probes = [...this.settings.keys()].map(probe => {
      const wanted = desired.probes.get(probe)!
      return { probe, intervalMs: wanted.intervalMs, ...(desired.paused || wanted.paused ? { paused: true } : {}), ...wanted.sort ? { sort: wanted.sort } : {}, ...wanted.view ? { view: wanted.view } : {}, ...wanted.filter ? { filter: wanted.filter } : {} }
    })
    const args = this.args
    const params: LiveSubscribeParams = { subscriptionId, connectionId: this.connectionId, source: this.source, probes, ...args ? { args } : {}, ...this.resume ? { resume: this.resume } : {} }
    const sent: Sent = { paused: desired.paused, virtual: desired.paused, args, probes: new Map([...desired.probes].map(([probe, settings]) => [probe, { ...settings }])) }
    let becameReady!: (opened: boolean) => void
    const ready = new Promise<boolean>(resolve => { becameReady = resolve })
    let record!: StreamRecord
    const live = this.service.client.live(params, (event, bytes) => this.applyEvent(record, event, bytes))
    record = { live, subscriptionId, connectionId: this.connectionId, sent, tracked: new Map(), opened: false, ready, becameReady, settled: false, results: new Map() }
    this.stream = record
    this.ended = undefined
    this.error = undefined
    this.updateError = false
    this.retries = 0
    this.clearTimer('retryTimer')
    this.status = this.runningStatus(record)
    const now = this.service.now()
    for (const runtime of this.runtime.values()) { runtime.opened = undefined; runtime.since = now }
    void live.done.then(result => {
      record.settled = true
      record.becameReady(false)
      this.streamEnded(record, result)
    })
    // Subscribed while hidden (at launch, or after a Reconnect): the hysteresis runs from now.
    if (this.hidden) { this.clearTimer('pauseTimer'); this.clearTimer('dormantTimer'); this.startHiddenTimers() }
    // The new subscription follows the same rows: each tracked table goes again with a new seq once it opens.
    if (this.tracks.size > 0) {
      for (const track of this.tracks.values()) track.seq = ++this.trackSeq
      this.queueSync()
    }
    this.changed()
  }

  /** Subscribes again once the subscription this view last stopped has ended: main and the backend count a cancelled
   *  stream until its end arrives, so a Reconnect with every slot taken would otherwise be refused its own slot. */
  private restart(): void {
    const previous = this.previous
    if (!previous || previous.settled) { this.start(); return }
    this.status = 'connecting'
    this.changed()
    if (this.pendingStart) return
    this.pendingStart = true
    void previous.live.done.then(() => {
      this.pendingStart = false
      if (!this.disposed && !this.stream && this.status === 'connecting') this.start()
    })
  }

  /** Ends the running subscription, if any, without reporting its end: the view moves on (dormant, or a new
   *  subscription). Its results are released by the backend; the view's tables then read released. */
  private stop(): void {
    const record = this.stream
    this.stream = undefined
    this.clearTimer('retryTimer')
    if (!record) return
    this.previous = record
    record.becameReady(false)
    record.live.cancel()
  }

  private applyEvent(record: StreamRecord, event: LiveEvent, bytes: number): void {
    if (record !== this.stream) { record.live.ack(bytes); return }
    this.counts.events++
    this.counts.lastSeq = event.seq
    if (event.type === 'live.opened') this.applyOpened(record, event)
    else this.applyTick(record, event)
    record.live.ack(bytes)
    this.armStale()
    this.changed()
  }

  private applyOpened(record: StreamRecord, event: LiveOpenedEvent): void {
    record.opened = true
    this.spid = event.spid
    const now = this.service.now()
    let rings = false
    for (const probe of event.probes) {
      const runtime = this.runtime.get(probe.probe)
      if (!runtime) continue
      runtime.opened = { state: probe.state, reason: probe.reason, note: probe.note, minIntervalMs: probe.minIntervalMs, maxIntervalMs: probe.maxIntervalMs }
      runtime.effectiveIntervalMs = probe.intervalMs
      runtime.since = now
      const series = this.service.catalog.probes[probe.probe]?.series?.length ?? 0
      if (series > 0 && !this.rings.has(probe.probe)) { this.rings.set(probe.probe, new MetricRing(2, series)); rings = true }
    }
    if (this.status === 'connecting') this.status = this.runningStatus(record)
    if (rings) this.service.rebalance()
    record.becameReady(true)
  }

  private applyTick(record: StreamRecord, tick: LiveTick): void {
    this.counts.ticks++
    if (tick.spid !== undefined) this.spid = tick.spid
    if (tick.resume !== undefined) this.resume = tick.resume
    const now = this.service.now()
    for (const sample of tick.samples) {
      const runtime = this.runtime.get(sample.probe)
      if (!runtime) continue
      runtime.lastSampleAt = tick.sampledAt
      runtime.since = now
      runtime.costMs = sample.costMs
      runtime.effectiveIntervalMs = sample.effectiveIntervalMs
      runtime.error = undefined
      const ring = this.rings.get(sample.probe)
      if (ring && sample.metrics) ring.push(tick.sampledAt, sample.metrics, sample.gap === 'reset' ? ringGap | ringReset : sample.gap ? ringGap : 0)
      for (const entry of [...sample.tables ?? [], ...sample.append ?? []]) {
        for (const retired of entry.retired ?? []) record.results.delete(retired)
        record.results.set(entry.descriptor.resultId, { generation: entry.descriptor.generation, resultId: entry.descriptor.resultId })
      }
      for (const entry of sample.tables ?? []) {
        const keys = entry.tracked && this.answered(sample.probe + '/' + entry.table, entry.tracked.seq)
        this.setTable(sample.probe, {
          probe: sample.probe, index: entry.table, mode: 'snapshot', descriptor: entry.descriptor, handle: this.service.client.open(entry.descriptor), revision: entry.revision,
          ...entry.diff ? { diff: entry.diff } : {}, ...entry.tracked ? { tracked: { ...entry.tracked, ...keys ? { keys } : {} } } : {}, ...entry.departed ? { departed: entry.departed } : {}
        })
      }
      for (const entry of sample.append ?? []) {
        this.setTable(sample.probe, {
          probe: sample.probe, index: entry.table, mode: 'append', descriptor: entry.descriptor, handle: this.service.client.open(entry.descriptor), segment: entry.segment,
          ...entry.rolledFrom !== undefined ? { rolledFrom: entry.rolledFrom } : {}, ...entry.restarted ? { restarted: true } : {}
        })
      }
    }
    for (const error of tick.errors ?? []) {
      const runtime = this.runtime.get(error.probe)
      if (runtime) runtime.error = error
    }
    const applied: AppliedTick = { subscriptionId: record.subscriptionId, tick }
    for (const listener of [...this.tickListeners]) {
      try { listener(applied) } catch (error) { onUnexpectedError(error) }
    }
  }

  private setTable(probe: LiveProbeId, table: LiveTable): void {
    const tables = this.tables.get(probe) ?? new Map<number, LiveTable>()
    tables.set(table.index, table)
    this.tables.set(probe, tables)
  }

  private streamEnded(record: StreamRecord, result: ApiResult<LiveEnd>): void {
    if (record !== this.stream || this.disposed) return
    this.stream = undefined
    this.clearTimer('retryTimer')
    this.updateError = false
    if (result.ok) {
      const end = result.value
      if (end.resume !== undefined) this.resume = end.resume
      if (end.ended === 'sourceEnded') {
        const kept = new Set(end.kept ?? [])
        this.kept = [...kept].flatMap(resultId => record.results.get(resultId) ?? [])
      }
      this.ended = end
      this.error = end.ended === 'failed' && end.code && end.message ? { code: end.code, message: end.message } : undefined
      this.status = 'ended'
    } else {
      const code = result.code ?? 'BACKEND_ERROR'
      this.error = { code, message: result.error }
      this.status = lostCodes.has(code) ? 'lost' : 'ended'
    }
    this.clearTimer('staleTimer')
    // An ended view runs nothing, so its status-only slot goes to a hidden view waiting for one.
    this.leaveStatusOnly()
    this.changed()
  }

  /** The owner moved (a Reconnect), lost its connection, closed, or showed or hid. */
  private ownerChanged(): void {
    if (this.disposed) return
    if (this.owner.closed?.()) { this.dispose(); return }
    const connection = this.owner.connectionId?.()
    if (connection !== this.ownerConnection) {
      this.ownerConnection = connection
      if (connection !== undefined && connection !== this.connectionId) {
        this.connectionId = connection
        this.stop()
        if (this.status !== 'dormant') this.restart()
        this.changed()
      } else if (connection === undefined && (this.stream || this.pendingStart || this.status === 'dormant')) {
        // The owner no longer has a connection (its tab was disconnected): the view ends as if the server had, and a
        // dormant one never subscribes again on the connection it no longer has.
        this.stop()
        this.ended = { ended: 'disconnected', ticks: this.counts.ticks, elapsedMs: 0 }
        this.status = 'ended'
        this.leaveStatusOnly()
        this.changed()
      }
    }
    this.visibilityChanged()
  }

  private computeHidden(): boolean {
    return this.service.pauseWhenHidden && (this.service.pageHidden() || !this.owner.visible())
  }

  visibilityChanged(): void {
    if (this.disposed) return
    const hidden = this.computeHidden()
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) { this.startHiddenTimers(); return }
    this.clearTimer('pauseTimer')
    this.clearTimer('dormantTimer')
    this.hiddenPaused = false
    this.leaveStatusOnly()
    // Back in view: a dormant view subscribes again (its history continues, with a gap); a paused one resumes at once.
    if (this.status === 'dormant') this.restart()
    else this.resumeRunning()
  }

  private startHiddenTimers(): void {
    if (this.statusOnly) return
    const now = this.service.now()
    this.armPause(now)
    this.armDormant(now)
  }

  private armPause(from: number): void {
    this.clearTimer('pauseTimer')
    this.pauseArmedAt = from
    const due = from + this.service.settings['liveData.pauseAfterSeconds'] * 1000
    this.pauseTimer = this.service.timers.setTimeout(() => { this.pauseTimer = undefined; this.pauseArmedAt = undefined; this.hiddenLong() }, Math.max(0, due - this.service.now()))
  }

  private armDormant(from: number): void {
    this.clearTimer('dormantTimer')
    this.dormantArmedAt = from
    const due = from + this.service.settings['liveData.stopAfterHiddenMinutes'] * 60_000
    this.dormantTimer = this.service.timers.setTimeout(() => { this.dormantTimer = undefined; this.dormantArmedAt = undefined; this.goDormant() }, Math.max(0, due - this.service.now()))
  }

  /** The pause or stop delay changed: the hidden timers still pending run to the new delay from when they started. */
  hiddenDelaysChanged(): void {
    if (this.disposed || !this.hidden) return
    if (this.pauseArmedAt !== undefined) this.armPause(this.pauseArmedAt)
    if (this.dormantArmedAt !== undefined) this.armDormant(this.dormantArmedAt)
  }

  private statusOnlyAllowed(): boolean {
    return this.whileHidden === 'statusOnly' && this.service.catalog.sources[this.source]?.hidden === 'statusOnly'
  }

  /** Hidden for the pause delay: pause, or keep only the status probes where the view and its source allow it. */
  private hiddenLong(): void {
    if (this.disposed || !this.hidden || this.statusOnly || this.hiddenPaused) return
    if (this.statusOnlyAllowed() && !this.userPaused && this.service.statusOnly < liveServiceLimits.statusOnly) this.enterStatusOnly()
    else this.hiddenPaused = true
    this.resumeRunning()
  }

  /** A slot came free: a hidden view that paused only because every slot was taken keeps its status probes after all. */
  claimStatusOnly(): void {
    if (this.disposed || !this.hidden || this.statusOnly || !this.hiddenPaused || this.userPaused || !this.statusOnlyAllowed() || !this.stream) return
    if (this.service.statusOnly >= liveServiceLimits.statusOnly) return
    this.hiddenPaused = false
    this.enterStatusOnly()
    this.resumeRunning()
  }

  private enterStatusOnly(): void {
    this.statusOnly = true
    this.service.statusOnly++
    this.clearTimer('dormantTimer')
  }

  /** Hidden for the stop delay: the subscription ends, and what the backend held with it; the view keeps its history. */
  private goDormant(): void {
    if (this.disposed || !this.hidden || this.statusOnly) return
    if (this.status !== 'connecting' && this.status !== 'live' && this.status !== 'paused') return
    this.stop()
    this.status = 'dormant'
    this.clearTimer('staleTimer')
    this.changed()
  }

  private leaveStatusOnly(): void {
    if (!this.statusOnly) return
    this.statusOnly = false
    this.service.statusOnly--
    this.service.statusOnlyFreed()
  }

  /** Pause, resume or settings: the running subscription is told the difference. */
  private resumeRunning(): void {
    if (this.stream) {
      this.restatus(this.stream)
      this.queueSync()
    }
    this.armStale()
    this.changed()
  }

  /** A running view's status follows what it shows (shown()); coming out of a pause, its probes count stale from now. */
  private restatus(record: StreamRecord): void {
    if (this.status !== 'live' && this.status !== 'paused' && this.status !== 'connecting') return
    const before = this.status
    this.status = this.runningStatus(record)
    if (before === 'paused' && this.status !== 'paused') {
      const now = this.service.now()
      for (const runtime of this.runtime.values()) runtime.since = now
    }
  }

  private runningStatus(record: StreamRecord): LiveStatus {
    return this.shown(record).paused ? 'paused' : record.opened ? 'live' : 'connecting'
  }

  private pausedNow(): boolean { return this.userPaused || this.hiddenPaused }

  // ---- What the backend runs -------------------------------------------------------------------------------------

  private desired(): Wanted {
    const statusOnly = this.statusOnly && !this.userPaused
    const probes = new Map<LiveProbeId, ProbeSettings>()
    for (const [probe, settings] of this.settings) {
      if (!statusOnly) { probes.set(probe, settings); continue }
      const tables = (this.service.catalog.probes[probe]?.tables?.length ?? 0) > 0
      const interval = this.service.catalog.probes[probe]?.intervalMs.max ?? limits.live.intervalMs.max
      probes.set(probe, tables ? { ...settings, paused: true } : { ...settings, intervalMs: Math.min(interval, Math.max(liveServiceLimits.statusOnlyIntervalMs, settings.intervalMs)) })
    }
    return { paused: !statusOnly && this.pausedNow(), probes }
  }

  /** What the view shows: what it wants, or, while the backend refuses the change, what the backend still runs. A refused
   *  pause never reads Paused while the server is still sampled. */
  private shown(record = this.stream): Wanted {
    if (!record?.refused) return this.desired()
    const sent = record.sent
    return { paused: sent.paused, probes: new Map([...sent.probes].map(([probe, settings]) => [probe, sent.virtual ? { ...settings, paused: true } : settings])) }
  }

  /** The update that takes the backend from `sent` to `wanted`, or undefined when they already agree. */
  private patchFor(sent: Sent, wanted: Wanted): LivePatch | undefined {
    const patch: LivePatch = {}
    const probes: LiveProbePatch[] = []
    const unpause = sent.virtual && !wanted.paused
    if (!sent.virtual && sent.paused !== wanted.paused) patch.paused = wanted.paused
    for (const [probe, want] of wanted.probes) {
      const had = sent.probes.get(probe)!
      const entry: LiveProbePatch = { probe }
      const clear: ('sort' | 'view' | 'filter')[] = []
      if (want.intervalMs !== had.intervalMs) entry.intervalMs = want.intervalMs
      // Subscribed while paused: every probe was paused, so resuming unpauses each one the view runs.
      const hadPaused = sent.virtual ? true : had.paused
      if (unpause || !sent.virtual) { if (want.paused !== hadPaused) entry.paused = want.paused }
      if (!sameSort(want.sort, had.sort)) { if (want.sort) entry.sort = want.sort; else clear.push('sort') }
      if (want.view !== had.view) { if (want.view) entry.view = want.view; else clear.push('view') }
      if (!sameFilter(want.filter, had.filter)) { if (want.filter) entry.filter = want.filter; else clear.push('filter') }
      if (clear.length) entry.clear = clear
      if (Object.keys(entry).length > 1) probes.push(entry)
    }
    if (probes.length) patch.probes = probes
    if (this.args !== sent.args && this.args) patch.args = this.args
    return Object.keys(patch).length ? patch : undefined
  }

  /** Brings the backend to what the view wants, one update at a time, each from what the backend last accepted. */
  private queueSync(): void {
    if (this.syncQueued) return
    this.syncQueued = true
    this.enqueue(async () => {
      this.syncQueued = false
      for (;;) {
        const record = this.stream
        if (!record || this.disposed) return
        const ready = await record.ready
        if (record !== this.stream || this.disposed) continue
        if (!ready) return
        const wanted = this.desired()
        const patch = this.patchFor(record.sent, wanted)
        const tracks = [...this.tracks].filter(([key, track]) => record.tracked.get(key) !== track.seq).slice(0, limits.live.probes)
        const update: LivePatch | undefined = tracks.length ? { ...patch, track: tracks.map(([, track]) => ({ probe: track.probe, table: track.table, seq: track.seq, keys: [...track.keys], ...track.linger !== undefined ? { linger: track.linger } : {} })) } : patch
        for (const [key, track] of tracks) this.remember(key, track.seq, track.keys)
        if (!update) {
          // The view came back to what the backend runs: a refusal no longer matters.
          if (record.refused) this.accepted(record)
          return
        }
        const sent: Sent = { paused: wanted.paused, virtual: record.sent.virtual && wanted.paused, args: this.args, probes: new Map([...wanted.probes].map(([probe, settings]) => [probe, { ...settings }])) }
        this.counts.updates++
        this.counts.lastPatch = update
        const result = await record.live.update(update)
        if (record !== this.stream) continue
        if (!result.ok) { this.refused(record, result); return }
        record.sent = sent
        for (const [key, track] of tracks) record.tracked.set(key, track.seq)
        this.accepted(record, result.value)
      }
    })
  }

  /** The backend took an update (or no longer needs the refused one): the view shows what it wants again. */
  private accepted(record: StreamRecord, result?: LiveUpdateResult): void {
    for (const probe of result?.probes ?? []) {
      const runtime = this.runtime.get(probe.probe)
      if (runtime) runtime.effectiveIntervalMs = probe.effectiveIntervalMs
    }
    record.refused = undefined
    this.retries = 0
    this.clearTimer('retryTimer')
    if (this.updateError) { this.error = undefined; this.updateError = false }
    this.restatus(record)
    this.armStale()
    this.changed()
  }

  /** The backend refused an update: the view shows what it still runs and why, and one refused for now goes again after
   *  a back-off. The update to a stream that is ending says nothing; its end will. */
  private refused(record: StreamRecord, result: { error: string; code?: ErrorCode }): void {
    if (result.code !== undefined && endingCodes.has(result.code)) return
    const code = result.code ?? 'BACKEND_ERROR'
    record.refused = { code, message: result.error }
    this.reportUpdateError(code, result.error)
    if (retryCodes.has(code)) {
      this.clearTimer('retryTimer')
      const delay = Math.min(liveServiceLimits.retryMs.max, liveServiceLimits.retryMs.first * 2 ** this.retries++)
      this.retryTimer = this.service.timers.setTimeout(() => { this.retryTimer = undefined; this.queueSync() }, delay)
    }
    this.restatus(record)
    this.armStale()
    this.changed()
  }

  private reportUpdateError(code: ErrorCode, message: string): void {
    this.error = { code, message }
    this.updateError = true
    this.changed()
  }

  /** Updates go one at a time, in order: a resume never overtakes the pause before it. */
  private enqueue(task: () => Promise<void> | void): void {
    this.chain = this.chain.then(task).catch(onUnexpectedError)
  }

  // ---- The handle's API ------------------------------------------------------------------------------------------

  setProbe(probe: LiveProbeId, patch: LiveProbeOptions): void {
    const settings = this.settings.get(probe)
    if (!settings || this.disposed) return
    const catalogue = this.service.catalog.probes[probe]?.intervalMs
    const next: ProbeSettings = { ...settings }
    if ('intervalMs' in patch) next.intervalMs = clamp(patch.intervalMs ?? catalogue?.default ?? settings.intervalMs, catalogue?.min ?? limits.live.intervalMs.min, catalogue?.max ?? limits.live.intervalMs.max)
    if ('paused' in patch) next.paused = !!patch.paused
    for (const key of ['sort', 'view', 'filter'] as const) {
      if (!(key in patch)) continue
      if (patch[key] === undefined) delete next[key]
      else Object.assign(next, { [key]: patch[key] })
    }
    const interval = next.intervalMs !== settings.intervalMs
    this.settings.set(probe, next)
    if (interval) this.service.rebalance()
    this.clearTimer('debounceTimer')
    this.debounceTimer = this.service.timers.setTimeout(() => { this.debounceTimer = undefined; this.queueSync(); this.changed() }, liveServiceLimits.settingsDebounceMs)
  }

  setArgs(args: LiveArgs): void {
    if (this.disposed) return
    this.args = args
    this.queueSync()
  }

  setUserPaused(paused: boolean): void {
    if (this.disposed || this.userPaused === paused) return
    this.userPaused = paused
    // A hidden view the user pauses stays paused when they resume it until it shows again, and goes dormant in time.
    if (paused && this.statusOnly) {
      this.hiddenPaused = true
      this.leaveStatusOnly()
      this.armDormant(this.service.now())
    }
    this.resumeRunning()
  }

  refresh(): void {
    if (this.disposed) return
    if (this.status === 'dormant') { this.restart(); return }
    const record = this.stream
    if (!record || this.pausedNow()) return
    this.enqueue(async () => {
      if (!await record.ready || record !== this.stream) return
      this.counts.updates++
      this.counts.lastPatch = { refresh: true }
      const result = await record.live.update({ refresh: true })
      if (record !== this.stream) return
      if (!result.ok) { if (result.code === undefined || !endingCodes.has(result.code)) this.reportUpdateError(result.code ?? 'BACKEND_ERROR', result.error) }
      else if (this.updateError && !record.refused) { this.error = undefined; this.updateError = false; this.changed() }
    })
  }

  probeOptions(probe: LiveProbeId): Readonly<LiveProbeOptions> | undefined {
    const settings = this.settings.get(probe)
    return settings && { ...settings, ...settings.sort ? { sort: settings.sort.map(key => ({ ...key })) } : {} }
  }

  track(probe: LiveProbeId, keys: readonly string[], table = 0, linger?: number): void {
    if (this.disposed || !this.settings.has(probe)) return
    // A key too long to send is left out, and so is its place among the lingering ones.
    const fits = (key: string) => key.length <= limits.live.keyCharacters
    const list = keys.filter(fits).slice(0, limits.live.trackedKeys)
    const lingering = linger === undefined ? undefined : Math.min(list.length, keys.slice(0, Math.max(0, linger)).filter(fits).length)
    this.tracks.set(probe + '/' + table, { probe, table, keys: list, seq: ++this.trackSeq, ...lingering !== undefined ? { linger: lingering } : {} })
    this.queueSync()
  }

  /** Keeps a track list as it is sent, for the samples that answer it by seq: every list since the newest answered one
   *  (answered), at most liveServiceLimits.trackHistory per table. */
  private remember(key: string, seq: number, keys: readonly string[]): void {
    const history = this.trackHistory.get(key) ?? []
    // A list sent again (after a refusal) is the same list.
    if (history.at(-1)?.seq === seq) return
    history.push({ seq, keys })
    if (history.length > liveServiceLimits.trackHistory) history.shift()
    this.trackHistory.set(key, history)
  }
  /** The keys of the list a sample answers. The backend accepts lists in seq order and answers the one it held when the
   *  sample came due, so once a sample answers a seq, no later sample answers an older one: those lists go. */
  private answered(key: string, seq: number): readonly string[] | undefined {
    const history = this.trackHistory.get(key)
    const index = history?.findIndex(item => item.seq === seq) ?? -1
    if (!history || index < 0) return undefined
    history.splice(0, index)
    return history[0].keys
  }

  ring(probe: LiveProbeId): MetricRing | undefined { return this.rings.get(probe) }
  table(probe: LiveProbeId, index = 0): LiveTable | undefined { return this.tables.get(probe)?.get(index) }

  onTick(listener: (tick: AppliedTick) => void): Disposable {
    this.tickListeners.add(listener)
    return { dispose: () => { this.tickListeners.delete(listener) } }
  }

  frames(): LiveFrames {
    const { lastPatch, ...counts } = this.counts
    return { ...counts, ...lastPatch ? { lastPatch } : {} }
  }

  /** The rings this handle wants for the history setting and each probe's interval (before memory caps). */
  wantedRings(): { ring: MetricRing; capacity: number }[] {
    const minutes = this.service.settings['liveData.historyMinutes']
    return [...this.rings].map(([probe, ring]) => {
      const runtime = this.runtime.get(probe), settings = this.settings.get(probe)
      const interval = Math.max(limits.live.intervalMs.min, clamp(settings?.intervalMs ?? limits.live.intervalMs.min, runtime?.opened?.minIntervalMs ?? 0, runtime?.opened?.maxIntervalMs ?? limits.live.intervalMs.max))
      return { ring, capacity: Math.min(ringMaxCapacity, Math.ceil(minutes * 60_000 / interval)) }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopOwner()
    this.stop()
    for (const timer of ['pauseTimer', 'dormantTimer', 'staleTimer', 'debounceTimer', 'retryTimer'] as const) this.clearTimer(timer)
    // A finished source's last tables were kept for the view; nothing reads them now.
    if (this.kept.length) void this.service.client.release(this.kept)
    this.kept = []
    this.tickListeners.clear()
    if (this.status !== 'lost') this.status = 'ended'
    this.snapshot = this.build()
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { onUnexpectedError(error) }
    }
    this.listeners.clear()
    this.service.removed(this)
    // After it left the service's list, so the slot goes to another view.
    this.leaveStatusOnly()
  }

  // ---- Snapshots -------------------------------------------------------------------------------------------------

  /** The stale deadline closest ahead: a probe that delivered nothing for twice its interval turns stale then. */
  private armStale(): void {
    this.clearTimer('staleTimer')
    if (this.disposed || !this.stream) return
    const shown = this.shown()
    if (shown.paused) return
    const now = this.service.now()
    let next = Number.POSITIVE_INFINITY
    for (const [probe, runtime] of this.runtime) {
      const deadline = this.staleAt(probe, runtime, shown)
      if (deadline !== undefined && deadline > now) next = Math.min(next, deadline)
    }
    if (next !== Number.POSITIVE_INFINITY) this.staleTimer = this.service.timers.setTimeout(() => { this.staleTimer = undefined; this.changed(); this.armStale() }, next - now)
  }

  private staleAt(probe: LiveProbeId, runtime: ProbeRuntime, shown: Wanted): number | undefined {
    const want = shown.probes.get(probe)
    if (runtime.since === undefined || !want || want.paused || runtime.opened?.state === 'unavailable') return undefined
    return runtime.since + 2 * (runtime.effectiveIntervalMs ?? want.intervalMs)
  }

  private build(): LiveSnapshot {
    const now = this.service.now()
    const shown = this.shown()
    const running = !!this.stream && (this.status === 'live' || this.status === 'connecting' || this.status === 'paused')
    const probes: Record<string, LiveProbeSnapshot> = {}
    for (const [probe, settings] of this.settings) {
      const runtime = this.runtime.get(probe)!
      const want = shown.probes.get(probe)!
      const stale = this.staleAt(probe, runtime, shown)
      const state: LiveProbeState = runtime.opened?.state === 'unavailable' ? 'unavailable'
        : !running || shown.paused || want.paused ? 'paused'
          : runtime.error ? 'failing'
            : stale !== undefined && now >= stale ? 'stale'
              : runtime.opened?.state === 'limited' ? 'limited' : 'fresh'
      probes[probe] = {
        state, intervalMs: settings.intervalMs, effectiveIntervalMs: runtime.effectiveIntervalMs ?? want.intervalMs,
        ...runtime.lastSampleAt !== undefined ? { lastSampleAt: runtime.lastSampleAt } : {}, ...runtime.costMs !== undefined ? { costMs: runtime.costMs } : {},
        ...runtime.error ? { error: runtime.error } : {}, ...runtime.opened?.reason ? { reason: runtime.opened.reason } : {}, ...runtime.opened?.note ? { note: runtime.opened.note } : {}
      }
    }
    // A pause the backend has not taken back (a refused resume) is nobody's wish: it reads Paused, with the error.
    const pausedBy = this.status === 'dormant' ? (this.userPaused ? 'user' : 'hidden')
      : this.status === 'paused' ? (this.userPaused ? 'user' : this.hiddenPaused ? 'hidden' : undefined) : undefined
    return {
      status: this.status, ...pausedBy ? { pausedBy } : {}, ...this.statusOnly && !this.userPaused && this.stream ? { hiddenMode: 'statusOnly' as const } : {}, probes, connectionId: this.connectionId,
      ...this.stream ? { subscriptionId: this.stream.subscriptionId } : {}, ...this.spid !== undefined && this.stream ? { spid: this.spid } : {},
      ...this.ended ? { ended: this.ended } : {}, ...this.error ? { error: this.error } : {}
    }
  }

  /** Listeners hear of changes once a frame; the service's list follows. */
  private changed(): void {
    this.service.changed()
    if (this.notifyQueued || this.disposed) return
    this.notifyQueued = true
    this.service.defer(() => {
      this.notifyQueued = false
      if (this.disposed) return
      this.snapshot = this.build()
      for (const listener of [...this.listeners]) {
        try { listener() } catch (error) { onUnexpectedError(error) }
      }
    })
  }

  private clearTimer(name: 'pauseTimer' | 'dormantTimer' | 'staleTimer' | 'debounceTimer' | 'retryTimer'): void {
    if (name === 'pauseTimer') this.pauseArmedAt = undefined
    if (name === 'dormantTimer') this.dormantArmedAt = undefined
    if (this[name] === undefined) return
    this.service.timers.clearTimeout(this[name])
    this[name] = undefined
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.round(value))) }
