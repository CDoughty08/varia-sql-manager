// The Activity Monitor documents (docs/activity-monitor.md): one per connection, each a renderer-only tab whose content
// is one live subscription to the `activity` source. The service keeps each monitor's choices (interval, chart window,
// panes, expanded charts, Pause) outside React, so a tab switch remounts the view without losing them, and keeps the
// subscription in step with them: a probe runs only while a pane that reads it is shown, and the live layer pauses the
// whole view while its tab is hidden.
import {
  activityLiveProbes, activityPanes, chartWindowsMinutes, defaultChartWindowMinutes, defaultPanes, maxExpandedTiles, paneProbes, probeIntervalMs, tileSpecs,
  activityIntervalsSeconds, activityIntervalDefaults, type ActivityPane, type ActivityProbe, type ChartWindowMinutes
} from '../../../shared/activity/catalog'
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { ActivityContextState } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveHandle, LiveOwner, LiveSpec } from '../live/LiveService'
import type { ConnectionService } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { TileTone } from '../../../shared/theme/tones'
import { crossings, type TileReading } from './tiles'

/** A monitor's two pane slots: the first, and the one split view adds. */
export type PaneSlot = 'primary' | 'secondary'
export interface MonitorState {
  readonly id: string
  /** The server it was opened on: a reconnect moves it only to a connection to that server. */
  readonly server: string
  readonly intervalSeconds: number
  readonly windowMinutes: ChartWindowMinutes
  /** Pause: no SQL until Resume (SSMS's meaning); the charts keep their history and show a gap. */
  readonly paused: boolean
  readonly split: boolean
  readonly primary: ActivityPane
  readonly secondary: ActivityPane
  /** The first pane's share of the panes area in split view. */
  readonly splitRatio: number
  /** Tiles whose chart is expanded (tileSpecs indexes), oldest first; at most maxExpandedTiles. */
  readonly expanded: readonly number[]
  /** Bumps when the monitor subscribes again (Retry), so the view takes the new handle. */
  readonly generation: number
}
export interface ActivityMonitorSnapshot { readonly monitors: Readonly<Record<string, MonitorState>> }

export const splitLimits = { minimum: 0.25, maximum: 0.75, default: 0.55, step: 0.05 } as const
const clampRatio = (ratio: number) => Number.isFinite(ratio) ? Math.round(Math.min(splitLimits.maximum, Math.max(splitLimits.minimum, ratio)) * 100) / 100 : splitLimits.default
export const monitorTitle = (server: string) => `${server} - Activity Monitor`

export interface ActivityMonitorServiceOptions {
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot'>
  readonly connections: Pick<ConnectionService, 'get'>
  readonly live: { open(spec: LiveSpec, owner: LiveOwner): LiveHandle }
  /** What a monitor's subscription follows: its tab (documentOwner in the app). */
  readonly owner: (documentId: string) => LiveOwner
  readonly settings: () => SettingsValues
  /** Puts focus in the monitor's view once it has rendered. */
  readonly focus?: (documentId: string) => void
}

/** The settings' choices for a new monitor, each kept to what the catalogue offers. */
export function initialMonitor(id: string, server: string, values: SettingsValues): MonitorState {
  const interval = Number(values['activityMonitor.refreshIntervalSeconds']), window = Number(values['activityMonitor.chartWindowMinutes'])
  const pane = (value: string): ActivityPane | undefined => (activityPanes as readonly string[]).includes(value) ? value as ActivityPane : undefined
  const primary = pane(values['activityMonitor.primaryPane']) ?? defaultPanes.primary
  const second = values['activityMonitor.secondaryPane']
  // A second pane equal to the first, or none, starts unsplit; Split View then offers the default second pane.
  const secondary = pane(second) ?? defaultPanes.secondary
  return {
    id, server, primary, secondary: secondary === primary ? activityPanes.find(item => item !== primary)! : secondary, split: second !== 'none' && secondary !== primary,
    intervalSeconds: (activityIntervalsSeconds as readonly number[]).includes(interval) ? interval : activityIntervalDefaults.refreshIntervalSeconds,
    windowMinutes: (chartWindowsMinutes as readonly number[]).includes(window) ? window as ChartWindowMinutes : defaultChartWindowMinutes,
    paused: false, splitRatio: splitLimits.default, expanded: tileSpecs.flatMap((tile, index) => tile.defaultExpanded ? [index] : []).slice(0, maxExpandedTiles), generation: 0
  }
}

/** The panes a monitor shows: the first, and the second in split view. */
export const shownPanes = (state: Pick<MonitorState, 'primary' | 'secondary' | 'split'>): ActivityPane[] => state.split ? [state.primary, state.secondary] : [state.primary]
/** Every live probe of the source, with the monitor's interval and paused unless a shown pane reads it. */
export function probeSettings(state: MonitorState): { probe: LiveProbeId; intervalMs: number; paused: boolean }[] {
  const running = new Set<ActivityProbe>(paneProbes(shownPanes(state)))
  return activityLiveProbes.map(probe => ({ probe, intervalMs: probeIntervalMs(probe, state.intervalSeconds), paused: !running.has(probe) }))
}

export class ActivityMonitorService extends SnapshotStore<ActivityMonitorSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'activityMonitor' as const
  readonly saves = false
  /** Nothing to save, so Save All has nothing of it to save either. */
  readonly inSaveAll = false
  private readonly handles = new Map<string, LiveHandle>()
  /** Each monitor's tile tones as last shown, so a view remounted by a tab switch never repeats a crossing already said. */
  private readonly tones = new Map<string, readonly (TileTone | undefined)[]>()
  private readonly registration: Disposable
  private readonly contextStore = new (class extends SnapshotStore<ActivityContextState> { set(value: ActivityContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  private disposed = false

  constructor(private readonly options: ActivityMonitorServiceOptions) {
    super({ monitors: {} })
    this.registration = options.documents.registerProvider(this)
  }

  /** The monitors' context keys (activityPaused, activitySplit) for the active document. */
  get context(): ExternalStore<ActivityContextState> { return this.contextStore }
  get(id: string): MonitorState | undefined { return this.getSnapshot().monitors[id] }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }
  /** The open monitor of a connection: its document follows the connection, so a reconnect keeps it. */
  monitorOf(connectionId: string): string | undefined {
    return this.options.documents.getSnapshot().documents.find(document => document.kind === 'activityMonitor' && document.connectionId === connectionId && this.get(document.id))?.id
  }

  /** Opens the connection's monitor, or activates the one it has (one per connection, as in SSMS). */
  open(connectionId: string): string {
    if (this.disposed) throw new Error('The Activity Monitor is not available.')
    const existing = this.monitorOf(connectionId)
    if (existing) {
      this.options.documents.activate(existing)
      this.options.focus?.(existing)
      return existing
    }
    const connection = this.options.connections.get(connectionId)
    if (!connection) throw new Error('Connect to the server first.')
    if (connection.lost) throw new Error('This connection was lost when the SQL backend restarted. Reconnect it first.')
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('activityMonitor', monitorTitle(label), connection.id, 'master')
    this.put(initialMonitor(document.id, connection.server, this.options.settings()))
    this.startView(document.id)
    this.options.focus?.(document.id)
    return document.id
  }

  private startView(id: string): void {
    const state = this.get(id), connectionId = this.options.documents.get(id)?.connectionId
    if (!state || !connectionId) return
    // A paused monitor subscribes paused (Retry while paused): pausing after it opened would let a sample run first.
    const handle = this.options.live.open({ connectionId, source: 'activity', probes: probeSettings(state), ...state.paused ? { paused: true } : {} }, this.options.owner(id))
    this.handles.set(id, handle)
  }

  /** Subscribes again (Retry after an error, or after the view ended): history starts over with a new handle. */
  retry(id: string): void {
    const state = this.get(id)
    if (!state) return
    this.handles.get(id)?.dispose()
    this.handles.delete(id)
    this.put({ ...state, generation: state.generation + 1 })
    this.startView(id)
  }

  setPaused(id: string, paused: boolean): void {
    const state = this.get(id)
    if (!state || state.paused === paused) return
    this.put({ ...state, paused })
    this.handles.get(id)?.setUserPaused(paused)
  }
  togglePause(id: string): void { const state = this.get(id); if (state) this.setPaused(id, !state.paused) }
  refresh(id: string): void { if (!this.get(id)?.paused) this.handles.get(id)?.refresh() }

  setInterval(id: string, seconds: number): void {
    const state = this.get(id)
    if (!state || state.intervalSeconds === seconds || !(activityIntervalsSeconds as readonly number[]).includes(seconds)) return
    this.update(state, { ...state, intervalSeconds: seconds })
  }
  setWindow(id: string, minutes: number): void {
    const state = this.get(id)
    if (!state || state.windowMinutes === minutes || !(chartWindowsMinutes as readonly number[]).includes(minutes)) return
    this.put({ ...state, windowMinutes: minutes as ChartWindowMinutes })
  }
  toggleSplit(id: string): void { const state = this.get(id); if (state) this.update(state, { ...state, split: !state.split }) }
  /** Shows a pane in a slot; the pane the other slot showed moves to this slot's old pane, so the two never match. */
  setPane(id: string, slot: PaneSlot, pane: ActivityPane): void {
    const state = this.get(id)
    if (!state || state[slot] === pane) return
    const other: PaneSlot = slot === 'primary' ? 'secondary' : 'primary'
    this.update(state, { ...state, [slot]: pane, ...state[other] === pane ? { [other]: state[slot] } : {} })
  }
  setSplitRatio(id: string, ratio: number): void {
    const state = this.get(id), next = clampRatio(ratio)
    if (state && state.splitRatio !== next) this.put({ ...state, splitRatio: next })
  }
  /** Expands or collapses a tile's chart; a third expanded chart takes the place of the oldest. */
  toggleTile(id: string, index: number): void {
    const state = this.get(id)
    if (!state || !tileSpecs[index]) return
    const expanded = state.expanded.includes(index) ? state.expanded.filter(item => item !== index) : [...state.expanded, index].slice(-maxExpandedTiles)
    this.put({ ...state, expanded })
  }

  /** What the tiles' live region says for these readings: each threshold crossed upward since the monitor's last ones. */
  noteTones(id: string, readings: readonly Pick<TileReading, 'caption' | 'tone'>[]): string | undefined {
    if (!this.get(id)) return undefined
    const said = crossings(this.tones.get(id) ?? [], readings)
    this.tones.set(id, readings.map(reading => reading.tone))
    return said
  }

  /** A change of panes or interval: the probes whose settings moved are told, in one debounced live update. */
  private update(before: MonitorState, after: MonitorState): void {
    this.put(after)
    const handle = this.handles.get(after.id)
    if (!handle) return
    const old = new Map(probeSettings(before).map(entry => [entry.probe, entry]))
    for (const entry of probeSettings(after)) {
      const previous = old.get(entry.probe)!
      const patch = { ...previous.intervalMs !== entry.intervalMs ? { intervalMs: entry.intervalMs } : {}, ...previous.paused !== entry.paused ? { paused: entry.paused } : {} }
      if (Object.keys(patch).length) handle.setProbe(entry.probe, patch)
    }
  }

  private put(state: MonitorState): void {
    this.publish({ monitors: { ...this.getSnapshot().monitors, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    this.contextStore.set({ byDocument: Object.fromEntries(Object.values(this.getSnapshot().monitors).map(state => [state.id, { paused: state.paused, split: state.split }])) })
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  /** Nothing to save (`saves`): File › Save is disabled on a monitor, and a Save that reaches it saves nothing. */
  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  closed(id: string): void {
    const handle = this.handles.get(id)
    this.handles.delete(id)
    this.tones.delete(id)
    try { handle?.dispose() } catch (error) { onUnexpectedError(error) }
    if (!this.get(id)) return
    const monitors = { ...this.getSnapshot().monitors }
    delete monitors[id]
    this.publish({ monitors })
    this.publishContext()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.handles.values()) handle.dispose()
    this.handles.clear()
    this.registration.dispose()
    this.clearListeners()
    this.contextStore.clear()
  }
}
