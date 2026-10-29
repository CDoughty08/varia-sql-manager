import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ResultDescriptor } from '../src/shared/contracts'
import { limits } from '../src/shared/ipc/wire/protocol'
import { liveProbes, liveSources, type LiveProbeId, type LiveProbeSpec, type LiveSourceSpec } from '../src/shared/live/catalog'
import type { LiveEnd, LiveEvent, LiveSubscribeParams, LiveTick, LiveUpdateResult } from '../src/shared/live/schema'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import { documentOwner, LiveService, liveServiceLimits, type LiveCatalog, type LiveOwner, type LiveSpec, type PageVisibility } from '../src/renderer/src/live/LiveService'
import { bindChart, ChartView, probeCurrent } from '../src/renderer/src/live/ChartView'
import { ringGap } from '../src/renderer/src/live/ring'
import { formatClock } from '../src/renderer/src/live/chart-format'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import { FakeCanvas, FakeChartEnvironment, fakeOwner } from './fixtures/fake-canvas'
import { liveIndicator } from '../src/renderer/src/live/status'
import type { LivePatch, LiveStream, ResultHandle } from '../src/renderer/src/results/ResultClient'
import type { ResultKey } from '../src/renderer/src/results/worker-protocol'
import { ActivityMonitorService, type ActivityMonitorServiceOptions } from '../src/renderer/src/activity/ActivityMonitorService'

// LiveService against a fake ResultClient: each stream records what the service sent, and the test plays the backend's
// side (events, update answers, the end). As the real ones do, the backend refuses an update NOT_FOUND until it has
// registered the subscription (just before live.opened), and main refuses a 17th stream that has not ended. Timers and
// the clock are vitest's fake ones.

interface FakeStream {
  params: LiveSubscribeParams
  onEvent: (event: LiveEvent, bytes: number) => void
  acks: number[]
  updates: LivePatch[]
  /** Answers updates at once unless a test holds them. */
  hold: boolean
  held: (() => void)[]
  answer: (patch: LivePatch) => ApiResult<LiveUpdateResult>
  cancelled: boolean
  /** live.opened was delivered: the backend has registered the subscription. */
  registered: boolean
  ended: boolean
  end(result: ApiResult<LiveEnd>): void
  stream: LiveStream
}

class FakeClient {
  readonly streams: FakeStream[] = []
  readonly released: ResultKey[][] = []
  readonly handles = new Map<number, { state: string }>()
  /** A cancelled stream's end arrives only when the test sends it, as main's does a moment later. */
  holdCancel = false
  live(params: LiveSubscribeParams, onEvent: (event: LiveEvent, bytes: number) => void): LiveStream {
    let settle!: (result: ApiResult<LiveEnd>) => void
    const done = new Promise<ApiResult<LiveEnd>>(resolve => { settle = resolve })
    const running = this.streams.filter(stream => !stream.ended).length
    const fake: FakeStream = {
      params: structuredClone(params), onEvent, acks: [], updates: [], hold: false, held: [], cancelled: false, registered: false, ended: false,
      answer: () => ({ ok: true, value: { applied: true, probes: params.probes.map(probe => ({ probe: probe.probe, intervalMs: probe.intervalMs, effectiveIntervalMs: probe.intervalMs, paused: false })) } }),
      end: result => { if (!fake.ended) { fake.ended = true; settle(result) } },
      stream: {
        subscriptionId: params.subscriptionId,
        done,
        update: patch => {
          fake.updates.push(structuredClone(patch))
          if (fake.ended || fake.cancelled || !fake.registered) return Promise.resolve({ ok: false, error: 'This live view has ended.', code: 'NOT_FOUND' })
          if (!fake.hold) return Promise.resolve(fake.answer(patch))
          return new Promise(resolve => fake.held.push(() => resolve(fake.answer(patch))))
        },
        cancel: () => {
          if (fake.ended) return
          fake.cancelled = true
          if (!this.holdCancel) fake.end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } })
        },
        ack: bytes => { fake.acks.push(bytes) }
      }
    }
    this.streams.push(fake)
    if (running >= liveServiceLimits.handles) fake.end({ ok: false, error: 'Too many live streams are open in this window.', code: 'TOO_MANY_REQUESTS' })
    return fake.stream
  }
  open(descriptor: ResultDescriptor): ResultHandle {
    const state = { state: 'complete' }
    this.handles.set(descriptor.resultId, state)
    return { key: { generation: descriptor.generation, resultId: descriptor.resultId }, getSnapshot: () => state } as unknown as ResultHandle
  }
  release(keys: readonly ResultKey[]): Promise<void> { this.released.push([...keys]); return Promise.resolve() }
  get last(): FakeStream { return this.streams.at(-1)! }
}

class Flag {
  private readonly listeners = new Set<() => void>()
  constructor(public value: boolean) {}
  set(value: boolean) { this.value = value; for (const listener of [...this.listeners]) listener() }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}
function owner(o: { visible?: boolean; connectionId?: string } = {}) {
  const visible = new Flag(o.visible ?? true)
  let connectionId = o.connectionId, closed = false
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const value: LiveOwner = {
    key: 'test', visible: () => visible.value, connectionId: () => connectionId, closed: () => closed,
    subscribe: listener => { listeners.add(listener); const stop = visible.subscribe(listener); return () => { listeners.delete(listener); stop() } }
  }
  return { value, show: (shown: boolean) => visible.set(shown), move: (id: string | undefined) => { connectionId = id; notify() }, close: () => { closed = true; notify() } }
}
function settingsStore(patch: Partial<SettingsValues> = {}) {
  let values: SettingsValues = { ...defaultSettings, ...patch }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ values }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: Partial<SettingsValues>) => { values = { ...values, ...next }; for (const listener of [...listeners]) listener() }
  }
}

let client: FakeClient
let page: Flag & PageVisibility
let settings: ReturnType<typeof settingsStore>
let service: LiveService
const connectionId = '6f1e3a52-8a8b-4d63-9a43-2c1e1e0d7c11'
const otherConnection = '0b6f2f8e-0b0e-4f6a-9d61-6d8c2b7f1e22'
const allProbes: LiveProbeId[] = ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status']
const spec = (probes: LiveProbeId[] = allProbes, extra: Partial<LiveSpec> = {}): LiveSpec => ({ connectionId, source: 'debug.synthetic', probes: probes.map(probe => ({ probe })), ...extra })
function makeService(o: { settings?: Partial<SettingsValues>; catalog?: LiveCatalog; serverOf?: (connectionId: string) => string | undefined } = {}) {
  settings = settingsStore(o.settings)
  service = new LiveService({ client, settings, page, schedule: callback => callback(), ...o.catalog ? { catalog: o.catalog } : {}, ...o.serverOf ? { serverOf: o.serverOf } : {} })
  return service
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

let nextResult = 1
const descriptor = (resultId = nextResult++): ResultDescriptor => ({
  generation: 1, resultId, columns: [{ name: 'id', dataType: 'int', wire: 'text', nullable: false }, { name: 'label', dataType: 'nvarchar', wire: 'text', nullable: false }, { name: 'value', dataType: 'int', wire: 'text', nullable: false }],
  rowsStored: 3, rowsAvailable: 3, bytesStored: 30, truncatedCells: 0, state: 'complete', statement: 0
} as unknown as ResultDescriptor)
const opened = (fake: FakeStream, o: { spid?: number } = {}): LiveEvent => ({
  type: 'live.opened', seq: 0, source: fake.params.source, ...o.spid ? { spid: o.spid } : {},
  probes: fake.params.probes.map(probe => ({ probe: probe.probe, intervalMs: probe.intervalMs, minIntervalMs: 1000, maxIntervalMs: 3_600_000, state: 'ok' as const }))
})
let seq = 0
function tick(fake: FakeStream, o: { gap?: 'baseline' | 'resumed' | 'late'; table?: ResultDescriptor; retired?: number[]; resume?: string; sampledAt?: number; errors?: LiveTick['errors'] } = {}): LiveTick {
  return {
    type: 'live.tick', seq: ++seq, sampledAt: o.sampledAt ?? Date.now(), ...o.resume ? { resume: o.resume } : {}, ...o.errors ? { errors: o.errors } : {},
    samples: fake.params.probes.filter(probe => !o.errors?.some(error => error.probe === probe.probe)).map(probe => ({
      probe: probe.probe, costMs: 1, effectiveIntervalMs: probe.intervalMs, ...o.gap ? { gap: o.gap } : {},
      ...probe.probe === 'debug.synthetic.metrics' ? { metrics: [seq, 50, null] } : {},
      ...probe.probe === 'debug.synthetic.table' ? { tables: [{ table: 0, descriptor: o.table ?? descriptor(), revision: seq, ...o.retired ? { retired: o.retired } : {} }] } : {},
      ...probe.probe === 'debug.synthetic.status' ? { status: [{ id: 'samples', value: seq }] } : {}
    }))
  } as LiveTick
}
const deliver = (fake: FakeStream, event: LiveEvent, bytes = 100) => {
  if (event.type === 'live.opened') fake.registered = true
  fake.onEvent(event, bytes)
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') })
  client = new FakeClient()
  page = Object.assign(new Flag(false), { hidden(this: Flag) { return this.value } }) as Flag & PageVisibility
  seq = 0
})
afterEach(() => { service?.dispose(); vi.useRealTimers() })

describe('LiveService', () => {
  it('subscribes with each probe\'s catalogue interval, applies every frame before acknowledging it, and keeps history', async () => {
    makeService()
    const view = owner()
    const handle = service.open(spec(), view.value)
    expect(client.streams).toHaveLength(1)
    const fake = client.last
    expect(fake.params).toEqual({ subscriptionId: handle.id, connectionId, source: 'debug.synthetic', probes: allProbes.map(probe => ({ probe, intervalMs: liveProbes[probe].intervalMs.default })) })
    expect(handle.getSnapshot()).toMatchObject({ status: 'connecting', subscriptionId: handle.id, connectionId })
    deliver(fake, opened(fake, { spid: 61 }))
    expect(handle.getSnapshot()).toMatchObject({ status: 'live', spid: 61 })
    expect(fake.acks).toEqual([100])

    const seen: number[] = []
    handle.onTick(applied => {
      // Listeners see the tick applied (ring and table) and not yet acknowledged.
      seen.push(applied.tick.seq, handle.ring('debug.synthetic.metrics')!.length, fake.acks.length)
      expect(handle.table('debug.synthetic.table')?.revision).toBe(applied.tick.seq)
    })
    const first = descriptor()
    deliver(fake, tick(fake, { gap: 'baseline', table: first }), 250)
    expect(seen).toEqual([1, 1, 1])
    expect(fake.acks).toEqual([100, 250])
    const ring = handle.ring('debug.synthetic.metrics')!
    expect([ring.length, ring.flags(0) & ringGap, ring.value(0, 0), ring.value(0, 2)]).toEqual([1, ringGap, 1, Number.NaN])
    expect(handle.table('debug.synthetic.table')).toMatchObject({ probe: 'debug.synthetic.table', index: 0, mode: 'snapshot', descriptor: first, revision: 1 })
    expect(handle.ring('debug.synthetic.status')).toBeUndefined()
    vi.advanceTimersByTime(1000)
    deliver(fake, tick(fake))
    expect(ring.length).toBe(2)
    expect(ring.flags(1)).toBe(0)
    expect(handle.getSnapshot().probes['debug.synthetic.status']).toMatchObject({ state: 'fresh', intervalMs: 1000, effectiveIntervalMs: 1000, costMs: 1, lastSampleAt: Date.now() })
    // A listener that throws costs nothing: the frame is still acknowledged.
    handle.onTick(() => { throw new Error('consumer bug') })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    deliver(fake, tick(fake), 77)
    expect(fake.acks.at(-1)).toBe(77)
    expect(errors).toHaveBeenCalledOnce()
    errors.mockRestore()
    await settle()
    expect(fake.updates).toEqual([])
  })

  it('pauses 2 s after its owner hides, resumes at once when it shows, and goes dormant after 5 min hidden', async () => {
    makeService()
    const view = owner()
    const handle = service.open(spec(), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    deliver(fake, tick(fake, { gap: 'baseline' }))
    // A glance away shorter than the delay sends nothing.
    view.show(false)
    vi.advanceTimersByTime(1900)
    view.show(true)
    vi.advanceTimersByTime(10_000)
    await settle()
    expect(fake.updates).toEqual([])
    view.show(false)
    vi.advanceTimersByTime(1999)
    await settle()
    expect(fake.updates).toEqual([])
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'hidden' })
    expect(Object.values(handle.getSnapshot().probes).map(probe => probe.state)).toEqual(['paused', 'paused', 'paused'])
    view.show(true)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }, { paused: false }])
    expect(handle.getSnapshot().status).toBe('live')

    view.show(false)
    vi.advanceTimersByTime(2000)
    deliver(fake, tick(fake, { resume: 'cursorA1' }))
    vi.advanceTimersByTime(5 * 60_000 - 2000 - 1)
    expect(fake.cancelled).toBe(false)
    vi.advanceTimersByTime(1)
    expect(fake.cancelled).toBe(true)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: 'dormant', pausedBy: 'hidden' })
    expect(handle.getSnapshot().subscriptionId).toBeUndefined()
    const ring = handle.ring('debug.synthetic.metrics')!
    const kept = ring.length
    // Showing it again subscribes again: a new subscription id, the resume token, and the same history.
    view.show(true)
    expect(client.streams).toHaveLength(2)
    const again = client.last
    expect(again.params.subscriptionId).not.toBe(handle.id)
    expect(again.params).toMatchObject({ resume: 'cursorA1', connectionId })
    expect(again.params.probes.every(probe => probe.paused === undefined)).toBe(true)
    deliver(again, opened(again))
    deliver(again, tick(again, { gap: 'baseline' }))
    expect(handle.ring('debug.synthetic.metrics')).toBe(ring)
    expect(ring.length).toBe(kept + 1)
    expect(ring.flags(ring.length - 1) & ringGap).toBe(ringGap)
    expect(handle.getSnapshot()).toMatchObject({ status: 'live', subscriptionId: again.params.subscriptionId })
  })

  it('pauses when the window hides, as when the owner does', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.status']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    page.set(true)
    vi.advanceTimersByTime(2000)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    // The test override wins over the real state, and undefined hands it back.
    service.setPageHidden(false)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ paused: false })
    service.setPageHidden(undefined)
    vi.advanceTimersByTime(2000)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ paused: true })
    expect(handle.getSnapshot().pausedBy).toBe('hidden')
  })

  it('tells charts when the window hides or shows, the test override included', () => {
    makeService()
    let calls = 0
    const stop = service.page.subscribe(() => { calls++ })
    expect(service.page.hidden()).toBe(false)
    page.set(true)
    expect([service.page.hidden(), calls]).toEqual([true, 1])
    service.setPageHidden(false)
    expect([service.page.hidden(), calls]).toEqual([false, 2])
    service.setPageHidden(undefined)
    expect([service.page.hidden(), calls]).toEqual([true, 3])
    stop()
    page.set(false)
    expect(calls).toBe(3)
  })

  it('follows a tab: active and in the editor area, or hidden; closing the tab ends the view', async () => {
    makeService()
    let snapshot = { documents: [{ id: 'a', connectionId }, { id: 'b' }], activeId: 'a' } as unknown as ReturnType<Parameters<typeof documentOwner>[1]['getSnapshot']>
    let panes = { explorer: true, editor: true, output: true }
    const documentListeners = new Set<() => void>(), paneListeners = new Set<() => void>()
    const documents = { getSnapshot: () => snapshot, get: (id: string) => snapshot.documents.find(document => document.id === id), subscribe: (listener: () => void) => { documentListeners.add(listener); return () => { documentListeners.delete(listener) } } }
    const paneStore = { getSnapshot: () => panes, subscribe: (listener: () => void) => { paneListeners.add(listener); return () => { paneListeners.delete(listener) } } }
    const tab = documentOwner('a', documents, paneStore)
    expect(tab.key).toBe('tab:a')
    const handle = service.open(spec(['debug.synthetic.table']), tab)
    const fake = client.last
    deliver(fake, opened(fake))
    const table = descriptor()
    deliver(fake, tick(fake, { table }))
    const change = (next: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...next }; documentListeners.forEach(listener => listener()) }
    change({ activeId: 'b' })
    vi.advanceTimersByTime(2000)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    change({ activeId: 'a' })
    await settle()
    expect(fake.updates.at(-1)).toEqual({ paused: false })
    panes = { ...panes, editor: false }
    paneListeners.forEach(listener => listener())
    vi.advanceTimersByTime(2000)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ paused: true })
    panes = { ...panes, editor: true }
    paneListeners.forEach(listener => listener())
    expect(documentListeners.size + paneListeners.size).toBe(2)
    change({ documents: snapshot.documents.filter(document => document.id !== 'a'), activeId: 'b' })
    expect(fake.cancelled).toBe(true)
    expect(handle.getSnapshot().status).toBe('ended')
    expect(service.getSnapshot().handles).toEqual([])
    expect(documentListeners.size + paneListeners.size).toBe(0)
  })

  it('keeps a user pause through visibility changes, and runs no SQL while paused', async () => {
    makeService()
    const view = owner()
    const handle = service.open(spec(), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    handle.setUserPaused(true)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'user' })
    view.show(false)
    vi.advanceTimersByTime(3000)
    view.show(true)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    expect(handle.getSnapshot().pausedBy).toBe('user')
    // Refresh does nothing while paused.
    handle.refresh()
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    handle.setUserPaused(false)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }, { paused: false }])
    handle.refresh()
    await settle()
    expect(fake.updates.at(-1)).toEqual({ refresh: true })
    // Paused by the user while hidden: showing it does not resume it.
    view.show(false)
    vi.advanceTimersByTime(2000)
    handle.setUserPaused(true)
    view.show(true)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ paused: true })
    expect(handle.getSnapshot().pausedBy).toBe('user')
  })

  it('sends one update at a time, so a resume never overtakes the pause before it', async () => {
    makeService()
    const view = owner()
    const handle = service.open(spec(['debug.synthetic.status']), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    fake.hold = true
    handle.setUserPaused(true)
    await settle()
    handle.setUserPaused(false)
    handle.setUserPaused(true)
    handle.setUserPaused(false)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    fake.held.shift()!()
    await settle()
    // The three later changes ended where they started from the backend's view: running, so one resume follows.
    expect(fake.updates).toEqual([{ paused: true }, { paused: false }])
    fake.held.shift()!()
    await settle()
    expect(fake.updates).toHaveLength(2)
  })

  it('debounces settings changes into one update, and clears what a change drops', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table', 'debug.synthetic.status']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    handle.setProbe('debug.synthetic.table', { sort: [{ column: 'value', descending: true }] })
    vi.advanceTimersByTime(100)
    handle.setProbe('debug.synthetic.status', { intervalMs: 3000 })
    handle.setProbe('debug.synthetic.table', { intervalMs: 5000 })
    vi.advanceTimersByTime(149)
    await settle()
    expect(fake.updates).toEqual([])
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toEqual([{ probes: [{ probe: 'debug.synthetic.table', intervalMs: 5000, sort: [{ column: 'value', descending: true }] }, { probe: 'debug.synthetic.status', intervalMs: 3000 }] }])
    handle.setProbe('debug.synthetic.table', { sort: undefined, intervalMs: undefined })
    vi.advanceTimersByTime(150)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, clear: ['sort'] }] })
    expect(handle.getSnapshot().probes['debug.synthetic.table'].intervalMs).toBe(1000)
    // Intervals are clamped to the probe's own minimum: below it is the minimum, which changes nothing here.
    handle.setProbe('debug.synthetic.status', { intervalMs: 500 })
    vi.advanceTimersByTime(150)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ probes: [{ probe: 'debug.synthetic.status', intervalMs: 1000 }] })
    // Track sends the keys with a fresh sequence number each time, and drops keys longer than the limit; a list the next
    // one replaced before it went is never sent.
    handle.track('debug.synthetic.table', ['5', 'x'.repeat(513), '7'])
    await settle()
    handle.track('debug.synthetic.table', ['8'])
    handle.track('debug.synthetic.table', ['9'])
    await settle()
    expect(fake.updates.slice(-2)).toEqual([{ track: [{ probe: 'debug.synthetic.table', table: 0, seq: 1, keys: ['5', '7'] }] }, { track: [{ probe: 'debug.synthetic.table', table: 0, seq: 3, keys: ['9'] }] }])
    // How many of the first keys linger goes with the list, counting only the keys that are sent.
    handle.track('debug.synthetic.table', ['1', 'x'.repeat(513), '2', '3'], 0, 3)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ track: [{ probe: 'debug.synthetic.table', table: 0, seq: 4, keys: ['1', '2', '3'], linger: 2 }] })
    // The settings as the view wants them, a copy the caller cannot change them through.
    handle.setProbe('debug.synthetic.table', { sort: [{ column: 'value', descending: true, table: 0 }] })
    const options = handle.probeOptions('debug.synthetic.table')!
    expect(options.sort).toEqual([{ column: 'value', descending: true, table: 0 }])
    options.sort![0].descending = false
    expect(handle.probeOptions('debug.synthetic.table')?.sort?.[0].descending).toBe(true)
    expect(handle.probeOptions('debug.synthetic.log')).toBeUndefined()
  })

  it('gives a table the keys its tracked rows answer, its departed rows, and an append segment\'s roll and restart', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table', 'debug.synthetic.log']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    handle.track('debug.synthetic.table', ['5', '7'])
    await settle()
    handle.track('debug.synthetic.table', ['8'])
    handle.track('debug.synthetic.table', ['9'])
    await settle()
    // Sent: seq 1 (5, 7) and seq 3 (9); seq 2 was replaced before it went.
    expect(fake.updates.map(update => update.track?.[0].seq)).toEqual([1, 3])
    const sample = (tracked: { seq: number; rows: number[] }, departed?: number[], log?: Record<string, unknown>) => ({
      type: 'live.tick', seq: ++seq, sampledAt: Date.now(),
      samples: [
        { probe: 'debug.synthetic.table', costMs: 1, effectiveIntervalMs: 1000, tables: [{ table: 0, descriptor: descriptor(), revision: seq, tracked, ...departed ? { departed } : {} }] },
        { probe: 'debug.synthetic.log', costMs: 1, effectiveIntervalMs: 1000, append: [{ table: 0, descriptor: descriptor(), segment: 1, ...log }] }
      ]
    }) as unknown as LiveTick
    deliver(fake, sample({ seq: 1, rows: [2, -1] }, [2], { rolledFrom: 7 }))
    expect(handle.table('debug.synthetic.table')).toMatchObject({ tracked: { seq: 1, rows: [2, -1], keys: ['5', '7'] }, departed: [2] })
    expect(handle.table('debug.synthetic.log')).toMatchObject({ mode: 'append', segment: 1, rolledFrom: 7 })
    expect(handle.table('debug.synthetic.log')?.restarted).toBeUndefined()
    deliver(fake, sample({ seq: 3, rows: [0] }, undefined, { restarted: true, retired: [3] }))
    expect(handle.table('debug.synthetic.table')).toMatchObject({ tracked: { seq: 3, rows: [0], keys: ['9'] } })
    expect(handle.table('debug.synthetic.table')?.departed).toBeUndefined()
    expect(handle.table('debug.synthetic.log')).toMatchObject({ restarted: true })
    // A seq the view never sent (or long forgotten) has rows but no keys: the grid then keeps its rows where they are.
    deliver(fake, sample({ seq: 2, rows: [4] }))
    expect(handle.table('debug.synthetic.table')?.tracked).toEqual({ seq: 2, rows: [4] })
  })

  it('keeps every track list a sample may still answer, however many went while one sample ran', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    // Holding Down while one sample runs: each new active row sends a list, and the backend accepts each in turn.
    for (let id = 10; id < 16; id++) { handle.track('debug.synthetic.table', [String(id)]); await settle() }
    expect(fake.updates.map(update => update.track?.[0].seq)).toEqual([1, 2, 3, 4, 5, 6])
    const sample = (tracked: { seq: number; rows: number[] }) => ({
      type: 'live.tick', seq: ++seq, sampledAt: Date.now(),
      samples: [{ probe: 'debug.synthetic.table', costMs: 1, effectiveIntervalMs: 1000, tables: [{ table: 0, descriptor: descriptor(), revision: seq, tracked }] }]
    }) as unknown as LiveTick
    // The sample came due with the first list.
    deliver(fake, sample({ seq: 1, rows: [3] }))
    expect(handle.table('debug.synthetic.table')?.tracked).toEqual({ seq: 1, rows: [3], keys: ['10'] })
    deliver(fake, sample({ seq: 4, rows: [5] }))
    expect(handle.table('debug.synthetic.table')?.tracked?.keys).toEqual(['13'])
    // Answered lists before the newest answer can never be answered again: they go.
    deliver(fake, sample({ seq: 2, rows: [5] }))
    expect(handle.table('debug.synthetic.table')?.tracked?.keys).toBeUndefined()
    deliver(fake, sample({ seq: 6, rows: [1] }))
    expect(handle.table('debug.synthetic.table')?.tracked?.keys).toEqual(['15'])
  })

  it('keeps at most 64 track lists a table while no sample answers, dropping the oldest', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    // A probe that keeps failing answers no list, while every selection change sends one.
    for (let id = 1; id <= 70; id++) { handle.track('debug.synthetic.table', [String(id)]); await settle() }
    expect(fake.updates).toHaveLength(70)
    const sample = (tracked: { seq: number; rows: number[] }) => ({
      type: 'live.tick', seq: ++seq, sampledAt: Date.now(),
      samples: [{ probe: 'debug.synthetic.table', costMs: 1, effectiveIntervalMs: 1000, tables: [{ table: 0, descriptor: descriptor(), revision: seq, tracked }] }]
    }) as unknown as LiveTick
    // The six oldest went: a sample answering one has rows but no keys; the oldest kept still has its keys.
    deliver(fake, sample({ seq: 6, rows: [0] }))
    expect(handle.table('debug.synthetic.table')?.tracked).toEqual({ seq: 6, rows: [0] })
    deliver(fake, sample({ seq: 7, rows: [0] }))
    expect(handle.table('debug.synthetic.table')?.tracked?.keys).toEqual(['7'])
  })

  it('holds every update until live.opened, so a pause or tracked keys sent at once are never refused NOT_FOUND', async () => {
    makeService()
    const view = owner()
    const handle = service.open(spec(['debug.synthetic.table', 'debug.synthetic.status']), view.value)
    const fake = client.last
    // A view restored paused, following rows, before the backend registered its subscription.
    handle.setUserPaused(true)
    handle.track('debug.synthetic.table', ['5'])
    handle.refresh()
    await settle()
    expect(fake.updates).toEqual([])
    deliver(fake, opened(fake))
    await settle()
    expect(fake.updates).toEqual([{ paused: true, track: [{ probe: 'debug.synthetic.table', table: 0, seq: 1, keys: ['5'] }] }])
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'user' })
    expect(handle.getSnapshot().error).toBeUndefined()
    handle.setUserPaused(false)
    await settle()
    // Out of dormancy the new subscription follows the same rows, with a new seq, once it is open.
    view.show(false)
    vi.advanceTimersByTime(5 * 60_000)
    await settle()
    view.show(true)
    const again = client.last
    expect(again).not.toBe(fake)
    await settle()
    expect(again.updates).toEqual([])
    deliver(again, opened(again))
    await settle()
    expect(again.updates).toEqual([{ track: [{ probe: 'debug.synthetic.table', table: 0, seq: 2, keys: ['5'] }] }])
    // A stream that ends before it opens sends nothing it held.
    const third = service.open(spec(['debug.synthetic.status']), owner().value)
    third.setUserPaused(true)
    client.last.end({ ok: false, error: 'Too many live views are open for this server. Close one and retry.', code: 'BUSY' })
    await settle()
    expect(client.last.updates).toEqual([])
    expect(third.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'BUSY' } })
  })

  it('never reads Paused while the backend refuses the pause, says why, and sends it again after a back-off', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.status']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    fake.answer = () => ({ ok: false, error: 'Too many pending backend requests.', code: 'TOO_MANY_REQUESTS' })
    handle.setUserPaused(true)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    // The server is still sampled: the view says so, and every tick still counts.
    expect(handle.getSnapshot()).toMatchObject({ status: 'live', error: { code: 'TOO_MANY_REQUESTS' }, probes: { 'debug.synthetic.status': { state: 'fresh' } } })
    expect(handle.getSnapshot().pausedBy).toBeUndefined()
    deliver(fake, tick(fake))
    expect(liveIndicator(handle.getSnapshot(), Date.now())).toEqual({ tone: 'live', label: 'Live · every 1 s', detail: 'Updated just now · Too many pending backend requests.' })
    vi.advanceTimersByTime(999)
    await settle()
    expect(fake.updates).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }, { paused: true }])
    vi.advanceTimersByTime(1999)
    await settle()
    expect(fake.updates).toHaveLength(2)
    fake.answer = () => ({ ok: true, value: { applied: true, probes: [{ probe: 'debug.synthetic.status', intervalMs: 1000, effectiveIntervalMs: 1000, paused: true }] } })
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toHaveLength(3)
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'user' })
    expect(handle.getSnapshot().error).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    await settle()
    expect(fake.updates).toHaveLength(3)

    // A refused resume reads Paused (nobody's wish) with the reason, and goes again too.
    fake.answer = () => ({ ok: false, error: 'The SQL backend is busy.', code: 'BUSY' })
    handle.setUserPaused(false)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', error: { code: 'BUSY' }, probes: { 'debug.synthetic.status': { state: 'paused' } } })
    expect(liveIndicator(handle.getSnapshot(), Date.now())).toMatchObject({ tone: 'paused', label: 'Paused', detail: expect.stringContaining('The SQL backend is busy.') })
    // The view changing back to what runs makes the refusal moot.
    handle.setUserPaused(true)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'user' })
    expect(handle.getSnapshot().error).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    await settle()
    expect(fake.updates).toHaveLength(4)
  })

  it('does not send a refusal that will not pass again by itself, sends it with the next change, and clears its error once one is accepted', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.status']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    fake.answer = () => ({ ok: false, error: 'The request is not valid.', code: 'INVALID_REQUEST' })
    handle.setProbe('debug.synthetic.status', { intervalMs: 5000 })
    vi.advanceTimersByTime(150)
    await settle()
    vi.advanceTimersByTime(60_000)
    await settle()
    expect(fake.updates).toEqual([{ probes: [{ probe: 'debug.synthetic.status', intervalMs: 5000 }] }])
    expect(handle.getSnapshot().error).toEqual({ code: 'INVALID_REQUEST', message: 'The request is not valid.' })
    // What the backend runs is still the old interval, so the next change goes from there.
    fake.answer = () => ({ ok: true, value: { applied: true, probes: [{ probe: 'debug.synthetic.status', intervalMs: 2000, effectiveIntervalMs: 2000, paused: false }] } })
    handle.setProbe('debug.synthetic.status', { intervalMs: 2000 })
    vi.advanceTimersByTime(150)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ probes: [{ probe: 'debug.synthetic.status', intervalMs: 2000 }] })
    expect(handle.getSnapshot().error).toBeUndefined()
    // A refused refresh is reported, and the next accepted update clears it.
    fake.answer = () => ({ ok: false, error: 'Too many pending backend requests.', code: 'TOO_MANY_REQUESTS' })
    handle.refresh()
    await settle()
    expect(handle.getSnapshot().error?.code).toBe('TOO_MANY_REQUESTS')
    fake.answer = () => ({ ok: true, value: { applied: true, probes: [] } })
    handle.refresh()
    await settle()
    expect(handle.getSnapshot().error).toBeUndefined()
  })

  it('shows the interval the backend runs when an update slows a probe', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.status']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    fake.answer = () => ({ ok: true, value: { applied: true, probes: [{ probe: 'debug.synthetic.status', intervalMs: 2000, effectiveIntervalMs: 4000, paused: false }] } })
    handle.setProbe('debug.synthetic.status', { intervalMs: 2000 })
    vi.advanceTimersByTime(150)
    await settle()
    expect(handle.getSnapshot().probes['debug.synthetic.status']).toMatchObject({ intervalMs: 2000, effectiveIntervalMs: 4000 })
    expect(liveIndicator(handle.getSnapshot(), Date.now()).label).toBe('Slowed to 4 s')
  })

  it('changes a running view\'s arguments in place, keeps its history, and subscribes again with them', async () => {
    makeService()
    const view = owner()
    const handle = service.open(spec(['debug.synthetic.metrics'], { args: { rows: 3 } }), view.value)
    const fake = client.last
    handle.setArgs({ rows: 5 })
    await settle()
    expect(fake.updates).toEqual([])
    deliver(fake, opened(fake))
    deliver(fake, tick(fake))
    await settle()
    expect(fake.updates).toEqual([{ args: { rows: 5 } }])
    const ring = handle.ring('debug.synthetic.metrics')!
    expect(ring.length).toBe(1)
    fake.answer = () => ({ ok: false, error: 'Invalid arguments for this source.', code: 'INVALID_PARAMS' })
    handle.setArgs({ rows: 7 })
    await settle()
    expect(handle.getSnapshot().error).toEqual({ code: 'INVALID_PARAMS', message: 'Invalid arguments for this source.' })
    expect(handle.getSnapshot().status).toBe('live')
    handle.setArgs({ rows: 9 })
    view.show(false)
    vi.advanceTimersByTime(5 * 60_000)
    await settle()
    view.show(true)
    expect(client.last.params.args).toEqual({ rows: 9 })
    expect(handle.ring('debug.synthetic.metrics')).toBe(ring)
  })

  it('pauses a view opened or reconnected while its owner is hidden once the pause delay passes', async () => {
    makeService()
    const view = owner({ visible: false, connectionId })
    const handle = service.open(spec(['debug.synthetic.status']), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    vi.advanceTimersByTime(1999)
    await settle()
    expect(fake.updates).toEqual([])
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    fake.end({ ok: false, error: 'The SQL backend restarted.', code: 'BACKEND_LOST' })
    await settle()
    // A Reconnect while hidden: the hysteresis runs again from the new subscription.
    view.show(true)
    view.show(false)
    view.move(otherConnection)
    const again = client.last
    deliver(again, opened(again))
    vi.advanceTimersByTime(2000)
    await settle()
    expect(again.updates).toEqual([{ paused: true }])
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'hidden', connectionId: otherConnection })
  })

  it('applies new hidden delays to views already hidden, counted from when they hid', async () => {
    makeService({ settings: { 'liveData.pauseAfterSeconds': 60 } })
    const view = owner()
    const handle = service.open(spec(['debug.synthetic.status']), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    view.show(false)
    vi.advanceTimersByTime(1000)
    settings.set({ 'liveData.pauseAfterSeconds': 2 })
    vi.advanceTimersByTime(999)
    await settle()
    expect(fake.updates).toEqual([])
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
    vi.advanceTimersByTime(58_000)
    settings.set({ 'liveData.stopAfterHiddenMinutes': 1 })
    expect(fake.cancelled).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(fake.cancelled).toBe(true)
    await settle()
    expect(handle.getSnapshot().status).toBe('dormant')
  })

  it('counts stale from a resume, not from the last sample before the pause', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.status']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    deliver(fake, tick(fake))
    handle.setUserPaused(true)
    await settle()
    vi.advanceTimersByTime(60_000)
    handle.setUserPaused(false)
    await settle()
    expect(handle.getSnapshot().probes['debug.synthetic.status'].state).toBe('fresh')
    vi.advanceTimersByTime(1999)
    expect(handle.getSnapshot().probes['debug.synthetic.status'].state).toBe('fresh')
    vi.advanceTimersByTime(1)
    expect(handle.getSnapshot().probes['debug.synthetic.status'].state).toBe('stale')
  })

  it('waits for the old stream\'s end before subscribing on a Reconnect, so a full window keeps its slot', async () => {
    makeService()
    client.holdCancel = true
    const views = Array.from({ length: liveServiceLimits.handles }, () => owner({ connectionId }))
    const handles = views.map(view => service.open(spec(['debug.synthetic.status']), view.value))
    for (const fake of [...client.streams]) deliver(fake, opened(fake))
    const old = client.streams[0]
    views[0].move(otherConnection)
    expect(old.cancelled).toBe(true)
    expect(client.streams).toHaveLength(16)
    expect(handles[0].getSnapshot()).toMatchObject({ status: 'connecting', connectionId: otherConnection })
    // Moving again while it waits subscribes once, on the latest connection.
    const third = '9d3c1f0a-5e2b-4c7d-8a6f-1b2c3d4e5f60'
    views[0].move(third)
    await settle()
    expect(client.streams).toHaveLength(16)
    old.end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } })
    await settle()
    expect(client.streams).toHaveLength(17)
    expect(client.last.ended).toBe(false)
    expect(client.last.params.connectionId).toBe(third)
    deliver(client.last, opened(client.last))
    expect(handles[0].getSnapshot()).toMatchObject({ status: 'live', connectionId: third })
    // Losing the connection while it waits ends the view, and nothing subscribes later.
    const next = client.streams[1]
    views[1].move(otherConnection)
    views[1].move(undefined)
    next.end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } })
    await settle()
    expect(client.streams).toHaveLength(17)
    expect(handles[1].getSnapshot()).toMatchObject({ status: 'ended', ended: { ended: 'disconnected' } })
  })

  it('keeps a dormant view dormant through a Reconnect, and subscribes on the new connection when it shows', async () => {
    makeService()
    const view = owner({ connectionId })
    const handle = service.open(spec(['debug.synthetic.status']), view.value)
    deliver(client.last, opened(client.last))
    view.show(false)
    vi.advanceTimersByTime(5 * 60_000)
    await settle()
    expect(handle.getSnapshot().status).toBe('dormant')
    view.move(otherConnection)
    expect(client.streams).toHaveLength(1)
    expect(handle.getSnapshot()).toMatchObject({ status: 'dormant', connectionId: otherConnection })
    view.show(true)
    expect(client.streams).toHaveLength(2)
    expect(client.last.params.connectionId).toBe(otherConnection)
  })

  it('reads every way the backend can go away as lost', async () => {
    makeService()
    const codes = ['BACKEND_LOST', 'RESULT_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'PORT_CLOSED'] as const
    const handles = codes.map(code => {
      const handle = service.open(spec(['debug.synthetic.status']), owner().value)
      client.last.end({ ok: false, error: 'Gone.', code })
      return handle
    })
    await settle()
    expect(handles.map(handle => handle.getSnapshot().status)).toEqual(['lost', 'lost', 'lost', 'ended'])
  })

  it('releases only the tables a finished source kept when the view closes', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    const left = descriptor(), right = descriptor()
    deliver(fake, { type: 'live.tick', seq: 1, sampledAt: Date.now(), samples: [{ probe: 'debug.synthetic.table', costMs: 1, effectiveIntervalMs: 1000, tables: [{ table: 0, descriptor: left, revision: 1 }, { table: 1, descriptor: right, revision: 1 }] }] } as LiveTick)
    expect(handle.table('debug.synthetic.table', 1)?.descriptor).toEqual(right)
    fake.end({ ok: true, value: { ended: 'sourceEnded', kept: [right.resultId], ticks: 1, elapsedMs: 1000 } })
    await settle()
    handle.dispose()
    expect(client.released).toEqual([[{ generation: 1, resultId: right.resultId }]])
  })

  it('samples a status-only view no more often than the catalogue hidden interval', () => {
    expect(liveServiceLimits.statusOnlyIntervalMs).toBe(limits.live.hiddenIntervalMs)
  })

  it('releases the older append segments a finished source kept, not only the newest, and nothing retired', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    // Three segments: the second rolls from the first, and the third retires the first (the table keeps two segments' worth).
    const first = descriptor(), second = descriptor(), third = descriptor()
    const append = (entry: object, seq: number) => deliver(fake, { type: 'live.tick', seq, sampledAt: Date.now(), samples: [{ probe: 'debug.synthetic.table', costMs: 1, effectiveIntervalMs: 1000, append: [entry] }] } as LiveTick)
    append({ table: 0, descriptor: first, segment: 1 }, 1)
    append({ table: 0, descriptor: second, segment: 2, rolledFrom: 1 }, 2)
    append({ table: 0, descriptor: third, segment: 3, rolledFrom: 2, retired: [first.resultId] }, 3)
    expect(handle.table('debug.synthetic.table', 0)?.descriptor).toEqual(third)
    fake.end({ ok: true, value: { ended: 'sourceEnded', kept: [third.resultId, second.resultId, first.resultId], ticks: 3, elapsedMs: 3000 } })
    await settle()
    handle.dispose()
    expect(client.released).toEqual([[{ generation: 1, resultId: third.resultId }, { generation: 1, resultId: second.resultId }]])
  })

  it('frees a status-only slot when its view ends, is lost or closes, and hands it to a hidden view waiting for one', async () => {
    const source: LiveSourceSpec = { ...liveSources['debug.synthetic'], hidden: 'statusOnly' }
    const catalog: LiveCatalog = { sources: { 'debug.synthetic': source }, probes: liveProbes as Record<string, LiveProbeSpec> }
    makeService({ catalog })
    const views = Array.from({ length: 6 }, () => owner())
    // The fourth runs only a status probe, so only its hidden mode can make it read stale.
    const handles = views.map((view, index) => service.open(spec(index === 3 ? ['debug.synthetic.status'] : ['debug.synthetic.table', 'debug.synthetic.status'], { whileHidden: 'statusOnly' }), view.value))
    const fakes = [...client.streams]
    for (const fake of fakes) deliver(fake, opened(fake))
    for (const view of views.slice(0, 5)) view.show(false)
    vi.advanceTimersByTime(2000)
    await settle()
    expect(service.statusOnly).toBe(4)
    expect(fakes[4].updates).toEqual([{ paused: true }])
    expect(handles[4].getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'hidden' })
    // Badges never read a status-only view as fresh.
    deliver(fakes[3], tick(fakes[3]))
    expect(handles[3].getSnapshot()).toMatchObject({ status: 'live', hiddenMode: 'statusOnly', probes: { 'debug.synthetic.status': { state: 'fresh' } } })
    expect(service.peek('debug.synthetic').find(peek => peek.id === handles[3].id)?.stale).toBe(true)
    // An execution finished while hidden: its slot goes to the view that was waiting, before that one goes dormant.
    fakes[0].end({ ok: true, value: { ended: 'sourceEnded', ticks: 3, elapsedMs: 3000 } })
    await settle()
    expect(service.statusOnly).toBe(4)
    expect(fakes[4].updates.at(-1)).toEqual({ paused: false, probes: [{ probe: 'debug.synthetic.table', paused: true }, { probe: 'debug.synthetic.status', intervalMs: 30_000 }] })
    expect(handles[4].getSnapshot()).toMatchObject({ status: 'live', hiddenMode: 'statusOnly' })
    vi.advanceTimersByTime(10 * 60_000)
    expect(fakes[4].cancelled).toBe(false)
    // Lost, and closed, free theirs too.
    fakes[1].end({ ok: false, error: 'The SQL backend restarted.', code: 'BACKEND_LOST' })
    await settle()
    expect(service.statusOnly).toBe(3)
    handles[2].dispose()
    expect(service.statusOnly).toBe(2)
    views[5].show(false)
    vi.advanceTimersByTime(2000)
    await settle()
    expect(service.statusOnly).toBe(3)
    expect(fakes[5].updates).toEqual([{ probes: [{ probe: 'debug.synthetic.table', paused: true }, { probe: 'debug.synthetic.status', intervalMs: 30_000 }] }])
  })

  it('turns a probe stale after twice its interval without a sample, and fresh again with the next one', () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.status', 'debug.synthetic.table']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    deliver(fake, tick(fake))
    vi.advanceTimersByTime(1999)
    expect(handle.getSnapshot().probes['debug.synthetic.status'].state).toBe('fresh')
    vi.advanceTimersByTime(1)
    expect(handle.getSnapshot().probes['debug.synthetic.status'].state).toBe('stale')
    deliver(fake, tick(fake, { errors: [{ probe: 'debug.synthetic.table', code: 'BLOCKED', message: 'A lock blocked the sample.', number: 1222, retryInMs: 1000, terminal: false }] }))
    const probes = handle.getSnapshot().probes
    expect(probes['debug.synthetic.status'].state).toBe('fresh')
    expect(probes['debug.synthetic.table']).toMatchObject({ state: 'failing', error: { code: 'BLOCKED' } })
    // Paused probes never turn stale.
    handle.setUserPaused(true)
    vi.advanceTimersByTime(60_000)
    expect(handle.getSnapshot().probes['debug.synthetic.status'].state).toBe('paused')
  })

  it('reports a lost backend, keeps history, and follows a Reconnect to the new connection', async () => {
    makeService()
    const view = owner({ connectionId })
    const handle = service.open(spec(), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    const table = descriptor()
    deliver(fake, tick(fake, { gap: 'baseline', table }))
    fake.end({ ok: false, error: 'The SQL backend restarted.', code: 'BACKEND_LOST' })
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: 'lost', error: { code: 'BACKEND_LOST' } })
    expect(handle.ring('debug.synthetic.metrics')!.length).toBe(1)
    expect(handle.table('debug.synthetic.table')?.descriptor).toEqual(table)
    // Nothing resubscribes by itself: the old connection id is gone with its backend.
    vi.advanceTimersByTime(60_000)
    expect(client.streams).toHaveLength(1)
    view.move(otherConnection)
    expect(client.streams).toHaveLength(2)
    expect(client.last.params).toMatchObject({ connectionId: otherConnection })
    expect(handle.getSnapshot()).toMatchObject({ status: 'connecting', connectionId: otherConnection })
    expect(handle.getSnapshot().error).toBeUndefined()
    // A tab that loses its connection ends the view.
    view.move(undefined)
    expect(client.last.cancelled).toBe(true)
    expect(handle.getSnapshot()).toMatchObject({ status: 'ended', ended: { ended: 'disconnected' } })
    // A dormant one too: showing it later subscribes nothing on the connection it no longer has.
    const hiddenView = owner({ connectionId })
    const sleeper = service.open(spec(['debug.synthetic.status']), hiddenView.value)
    deliver(client.last, opened(client.last))
    hiddenView.show(false)
    vi.advanceTimersByTime(5 * 60_000)
    expect(sleeper.getSnapshot().status).toBe('dormant')
    const streams = client.streams.length
    hiddenView.move(undefined)
    hiddenView.show(true)
    expect(client.streams).toHaveLength(streams)
    expect(sleeper.getSnapshot()).toMatchObject({ status: 'ended', ended: { ended: 'disconnected' } })
  })

  it('ends with the backend\'s reason: disconnected, failed, or a refused subscription', async () => {
    makeService()
    const a = service.open(spec(['debug.synthetic.status']), owner().value)
    client.last.end({ ok: true, value: { ended: 'disconnected', ticks: 4, elapsedMs: 4000 } })
    const b = service.open(spec(['debug.synthetic.status']), owner().value)
    client.last.end({ ok: true, value: { ended: 'failed', code: 'BACKEND_ERROR', message: 'The live view failed.', ticks: 0, elapsedMs: 1 } })
    const c = service.open(spec(['debug.synthetic.status']), owner().value)
    client.last.end({ ok: false, error: 'Too many live views are open for this server. Close one and retry.', code: 'BUSY' })
    await settle()
    expect(a.getSnapshot()).toMatchObject({ status: 'ended', ended: { ended: 'disconnected' } })
    expect(b.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'BACKEND_ERROR', message: 'The live view failed.' } })
    expect(c.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'BUSY' } })
  })

  it('keeps a finished source\'s last tables until the view closes, then releases them', async () => {
    makeService()
    const handle = service.open(spec(['debug.synthetic.table']), owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    const first = descriptor(), last = descriptor()
    deliver(fake, tick(fake, { table: first }))
    deliver(fake, tick(fake, { table: last }))
    fake.end({ ok: true, value: { ended: 'sourceEnded', kept: [last.resultId], ticks: 2, elapsedMs: 2000 } })
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: 'ended', ended: { ended: 'sourceEnded' } })
    expect(handle.table('debug.synthetic.table')?.descriptor).toEqual(last)
    expect(client.released).toEqual([])
    handle.dispose()
    expect(client.released).toEqual([[{ generation: 1, resultId: last.resultId }]])
  })

  it('refuses a 17th view in the window as a value, and counts a closed one as gone', () => {
    makeService()
    const views = Array.from({ length: liveServiceLimits.handles }, () => service.open(spec(['debug.synthetic.status']), owner().value))
    expect(client.streams).toHaveLength(16)
    const refused = service.open(spec(['debug.synthetic.status']), owner().value)
    expect(client.streams).toHaveLength(16)
    expect(refused.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'TOO_MANY_REQUESTS', message: 'Too many live views are open in this window. Close one and retry.' } })
    refused.setUserPaused(true)
    refused.refresh()
    expect(client.streams).toHaveLength(16)
    views[0].dispose()
    expect(client.streams[0].cancelled).toBe(true)
    service.open(spec(['debug.synthetic.status']), owner().value)
    expect(client.streams).toHaveLength(17)
    const wrong = service.open({ connectionId, source: 'debug.synthetic', probes: [] }, owner().value)
    expect(wrong.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'INVALID_PARAMS' } })
  })

  it('runs at most 8 background views, gives their slots to views that open when the window is full, and hands slots back as views close', async () => {
    makeService()
    client.holdCancel = true
    const background = () => service.open(spec(['debug.synthetic.status'], { background: true }), owner().value)
    const chips = Array.from({ length: 8 }, background)
    // The ninth waits for a slot rather than failing, and runs nothing, even when its owner hides and shows again.
    const ninth = owner()
    chips.push(service.open(spec(['debug.synthetic.status'], { background: true }), ninth.value))
    expect(client.streams).toHaveLength(liveServiceLimits.background)
    expect(chips[8].getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    chips[8].refresh()
    ninth.show(false)
    ninth.show(true)
    await settle()
    expect(client.streams).toHaveLength(8)
    expect(chips[8].getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    // Views the user opens fill the other 8 slots, then take background slots, newest first.
    const views = Array.from({ length: liveServiceLimits.handles - liveServiceLimits.background }, () => service.open(spec(['debug.synthetic.status']), owner().value))
    expect(client.streams).toHaveLength(16)
    const extra = service.open(spec(['debug.synthetic.status']), owner().value)
    expect(chips[7].getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    expect(client.streams[7].cancelled).toBe(true)
    // The new view subscribes only once the stream it replaces has ended, so main never sees a 17th stream.
    expect(client.streams).toHaveLength(16)
    expect(extra.getSnapshot().status).toBe('connecting')
    client.streams[7].end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } })
    await settle()
    expect(client.streams).toHaveLength(17)
    expect(client.last.ended).toBe(false)
    expect(chips.slice(0, 7).every(chip => chip.getSnapshot().waiting === undefined)).toBe(true)
    // With every slot taken by views the user opened and no background view left running, one more is refused.
    for (let i = 0; i < 7; i++) service.open(spec(['debug.synthetic.status']), owner().value)
    for (const fake of client.streams.filter(fake => fake.cancelled && !fake.ended)) fake.end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } })
    await settle()
    expect(chips.every(chip => chip.getSnapshot().waiting)).toBe(true)
    expect(service.open(spec(['debug.synthetic.status']), owner().value).getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'TOO_MANY_REQUESTS' } })
    const running = () => client.streams.filter(fake => !fake.ended && !fake.cancelled).length
    expect(running()).toBe(16)
    // A closed view's slot goes to the oldest waiting background view, after the closed view's stream has ended.
    const streams = client.streams.length
    views[0].dispose()
    expect(chips[0].getSnapshot().waiting).toBeUndefined()
    expect(client.streams).toHaveLength(streams)
    client.streams.find(fake => fake.cancelled && !fake.ended)!.end({ ok: true, value: { ended: 'cancelled', ticks: 0, elapsedMs: 0 } })
    await settle()
    expect(client.streams).toHaveLength(streams + 1)
    expect(client.last.params.subscriptionId).not.toBe(chips[0].id)
    expect(chips[0].getSnapshot().status).toBe('connecting')
    expect(chips.slice(1).every(chip => chip.getSnapshot().waiting)).toBe(true)
  })

  it('never takes over an ended background view, which its owner disposes', async () => {
    makeService()
    const chips = Array.from({ length: liveServiceLimits.background }, () => service.open(spec(['debug.synthetic.status'], { background: true }), owner().value))
    client.streams[7].end({ ok: false, error: 'Too many live views are reading this server.', code: 'TOO_MANY_REQUESTS' })
    await settle()
    expect(chips[7].getSnapshot().status).toBe('ended')
    for (let i = 0; i < liveServiceLimits.handles - liveServiceLimits.background; i++) service.open(spec(['debug.synthetic.status']), owner().value)
    service.open(spec(['debug.synthetic.status']), owner().value)
    expect(chips[7].getSnapshot()).toMatchObject({ status: 'ended' })
    expect(chips[7].getSnapshot().waiting).toBeUndefined()
    expect(chips[6].getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
  })

  it('passes a freed slot over a waiting background view that has since lost its connection', async () => {
    makeService()
    const views = Array.from({ length: liveServiceLimits.handles }, () => service.open(spec(['debug.synthetic.status']), owner().value))
    const gone = owner({ connectionId }), next = owner({ connectionId })
    const first = service.open(spec(['debug.synthetic.status'], { background: true }), gone.value)
    const second = service.open(spec(['debug.synthetic.status'], { background: true }), next.value)
    // Waiting is not a pause: nothing hid the view.
    expect(first.getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    expect(first.getSnapshot().pausedBy).toBeUndefined()
    gone.move(undefined)
    expect(first.getSnapshot().status).toBe('ended')
    views[0].dispose()
    await settle()
    expect(first.getSnapshot().status).toBe('ended')
    expect(second.getSnapshot().status).toBe('connecting')
    expect(client.last.params.subscriptionId).toBe(second.id)
  })

  it('keeps a hidden background view dormant when a slot frees, and subscribes it when it shows', async () => {
    makeService()
    const views = Array.from({ length: liveServiceLimits.handles }, () => service.open(spec(['debug.synthetic.status']), owner().value))
    const chip = owner({ visible: false })
    const handle = service.open(spec(['debug.synthetic.status'], { background: true }), chip.value)
    expect(handle.getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    views[3].dispose()
    await settle()
    expect(handle.getSnapshot().waiting).toBeUndefined()
    expect(handle.getSnapshot().status).toBe('dormant')
    expect(client.streams).toHaveLength(16)
    chip.show(true)
    await settle()
    expect(client.streams).toHaveLength(17)
    expect(handle.getSnapshot().status).toBe('connecting')
  })

  it('gives a freed slot to a waiting background view only while fewer than 8 background views run', async () => {
    makeService()
    const chips = Array.from({ length: liveServiceLimits.background + 1 }, () => service.open(spec(['debug.synthetic.status'], { background: true }), owner().value))
    expect(chips[8].getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    const view = service.open(spec(['debug.synthetic.status']), owner().value)
    view.dispose()
    await settle()
    expect(chips[8].getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    expect(client.streams).toHaveLength(liveServiceLimits.background + 1)
    chips[0].dispose()
    await settle()
    expect(chips[8].getSnapshot().waiting).toBeUndefined()
    expect(client.streams).toHaveLength(liveServiceLimits.background + 2)
  })

  it('gives a background view\'s slot on the same server to a view the backend refuses at its per-server cap', async () => {
    const servers: Record<string, string> = { [connectionId]: 'sql01', [otherConnection]: 'sql01', third: 'sql02' }
    makeService({ serverOf: id => servers[id] })
    const busy = (fake: FakeStream) => fake.end({ ok: false, error: 'Too many live views are open for this server. Close one and retry.', code: 'BUSY' })
    const elsewhere = service.open(spec(['debug.synthetic.status'], { background: true, connectionId: 'third' }), owner({ connectionId: 'third' }).value)
    const chip = service.open(spec(['debug.synthetic.status'], { background: true }), owner({ connectionId }).value)
    deliver(client.streams[0], opened(client.streams[0]))
    deliver(client.streams[1], opened(client.streams[1]))
    // A view the user opens on the same server, through another connection, is refused: the chips there give way, the
    // other server's stay, and the view subscribes again once the chips' stream has ended.
    const view = service.open(spec(['debug.synthetic.status'], { connectionId: otherConnection }), owner({ connectionId: otherConnection }).value)
    busy(client.last)
    await settle()
    expect(client.streams[1].cancelled).toBe(true)
    expect(client.streams[0].cancelled).toBe(false)
    expect(chip.getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    expect(elsewhere.getSnapshot().waiting).toBeUndefined()
    expect(client.streams).toHaveLength(4)
    expect(client.last.params).toMatchObject({ connectionId: otherConnection, source: 'debug.synthetic' })
    expect(view.getSnapshot().status).toBe('connecting')
    deliver(client.last, opened(client.last))
    expect(view.getSnapshot().status).toBe('live')
    // Closing it hands the slot back to the chips.
    view.dispose()
    await settle()
    expect(chip.getSnapshot().waiting).toBeUndefined()
    expect(client.last.params.connectionId).toBe(connectionId)
  })

  it('ends a view the backend refuses again, or that has no background view on its server to take over', async () => {
    const servers: Record<string, string> = { [connectionId]: 'sql01', [otherConnection]: 'sql02' }
    makeService({ serverOf: id => servers[id] })
    const busy = (fake: FakeStream) => fake.end({ ok: false, error: 'Too many live views are open for this server. Close one and retry.', code: 'BUSY' })
    const chip = service.open(spec(['debug.synthetic.status'], { background: true }), owner({ connectionId }).value)
    const second = service.open(spec(['debug.synthetic.status'], { background: true }), owner({ connectionId }).value)
    deliver(client.streams[0], opened(client.streams[0]))
    deliver(client.streams[1], opened(client.streams[1]))
    const other = service.open(spec(['debug.synthetic.status'], { connectionId: otherConnection }), owner({ connectionId: otherConnection }).value)
    busy(client.last)
    await settle()
    expect(other.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'BUSY' } })
    expect(chip.getSnapshot().waiting).toBeUndefined()
    // On the same server, one background view gives way; a second refusal ends the view rather than take another.
    const view = service.open(spec(['debug.synthetic.status']), owner({ connectionId }).value)
    busy(client.last)
    await settle()
    expect(second.getSnapshot().waiting).toBe(true)
    busy(client.last)
    await settle()
    expect(view.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'BUSY' } })
    expect(chip.getSnapshot().waiting).toBeUndefined()
  })

  it('takes over no background view that is dormant, which holds no subscription the backend counts', async () => {
    makeService({ serverOf: () => 'sql01' })
    const hidden = owner()
    const chip = service.open(spec(['debug.synthetic.status'], { background: true }), hidden.value)
    deliver(client.last, opened(client.last))
    hidden.show(false)
    vi.advanceTimersByTime(defaultSettings['liveData.stopAfterHiddenMinutes'] * 60_000 + 1000)
    await settle()
    expect(chip.getSnapshot().status).toBe('dormant')
    const view = service.open(spec(['debug.synthetic.status']), owner().value)
    client.last.end({ ok: false, error: 'Too many live views are open for this server. Close one and retry.', code: 'BUSY' })
    await settle()
    expect(view.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'BUSY' } })
    expect(chip.getSnapshot().waiting).toBeUndefined()
  })

  it('keeps a background view the backend refuses waiting, and tries it again when a view closes', async () => {
    makeService()
    const chip = service.open(spec(['debug.synthetic.status'], { background: true }), owner().value)
    client.last.end({ ok: false, error: 'Too many live views are open for this server. Close one and retry.', code: 'BUSY' })
    await settle()
    expect(chip.getSnapshot()).toMatchObject({ status: 'dormant', waiting: true })
    expect(chip.getSnapshot().error).toBeUndefined()
    const view = service.open(spec(['debug.synthetic.status']), owner().value)
    view.dispose()
    await settle()
    expect(client.streams).toHaveLength(3)
    expect(client.last.params.subscriptionId).not.toBe(chip.id)
    expect(chip.getSnapshot().status).toBe('connecting')
  })

  it('never pauses hidden views while Pause live views that are hidden is off, and applies the setting at once', async () => {
    makeService({ settings: { 'liveData.pauseWhenHidden': false } })
    const view = owner()
    service.open(spec(['debug.synthetic.status']), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    view.show(false)
    vi.advanceTimersByTime(10 * 60_000)
    await settle()
    expect(fake.updates).toEqual([])
    expect(fake.cancelled).toBe(false)
    settings.set({ 'liveData.pauseWhenHidden': true, 'liveData.pauseAfterSeconds': 5 })
    vi.advanceTimersByTime(4999)
    await settle()
    expect(fake.updates).toEqual([])
    vi.advanceTimersByTime(1)
    await settle()
    expect(fake.updates).toEqual([{ paused: true }])
  })

  it('subscribes paused when it starts hidden and paused, and unpauses each probe when it shows', async () => {
    makeService()
    const view = owner({ connectionId })
    const handle = service.open(spec(['debug.synthetic.status', 'debug.synthetic.table'], { probes: [{ probe: 'debug.synthetic.status' }, { probe: 'debug.synthetic.table', paused: true }] }), view.value)
    deliver(client.last, opened(client.last))
    view.show(false)
    vi.advanceTimersByTime(2000)
    await settle()
    client.last.end({ ok: false, error: 'The SQL backend restarted.', code: 'BACKEND_LOST' })
    await settle()
    // A Reconnect while hidden and paused: the new subscription pauses every probe, and sends nothing more.
    view.move(otherConnection)
    const fake = client.last
    expect(fake.params.probes).toEqual([{ probe: 'debug.synthetic.status', intervalMs: 1000, paused: true }, { probe: 'debug.synthetic.table', intervalMs: 1000, paused: true }])
    deliver(fake, opened(fake))
    await settle()
    expect(fake.updates).toEqual([])
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'hidden' })
    view.show(true)
    await settle()
    // The probe the view itself paused stays paused.
    expect(fake.updates).toEqual([{ probes: [{ probe: 'debug.synthetic.status', paused: false }] }])
    view.show(false)
    vi.advanceTimersByTime(2000)
    await settle()
    expect(fake.updates.at(-1)).toEqual({ paused: true })
  })

  it('keeps a hidden view\'s status probes at 30 s where its source allows it, for at most 4 views', async () => {
    const source: LiveSourceSpec = { ...liveSources['debug.synthetic'], hidden: 'statusOnly' }
    const catalog: LiveCatalog = { sources: { 'debug.synthetic': source }, probes: liveProbes as Record<string, LiveProbeSpec> }
    makeService({ catalog })
    const views = Array.from({ length: 5 }, () => owner())
    const handles = views.map(view => service.open(spec(['debug.synthetic.table', 'debug.synthetic.status'], { whileHidden: 'statusOnly' }), view.value))
    const fakes = [...client.streams]
    for (const fake of fakes) deliver(fake, opened(fake))
    // Without whileHidden a view of the same source pauses as any other.
    const plain = owner()
    service.open(spec(['debug.synthetic.status']), plain.value)
    const plainFake = client.last
    deliver(plainFake, opened(plainFake))
    for (const view of [...views, plain]) view.show(false)
    vi.advanceTimersByTime(2000)
    await settle()
    for (const fake of fakes.slice(0, 4)) expect(fake.updates).toEqual([{ probes: [{ probe: 'debug.synthetic.table', paused: true }, { probe: 'debug.synthetic.status', intervalMs: 30_000 }] }])
    expect(fakes[4].updates).toEqual([{ paused: true }])
    expect(plainFake.updates).toEqual([{ paused: true }])
    expect(handles[0].getSnapshot()).toMatchObject({ status: 'live', hiddenMode: 'statusOnly' })
    expect(handles[0].getSnapshot().probes['debug.synthetic.table'].state).toBe('paused')
    // They never go dormant: their end must still be seen.
    vi.advanceTimersByTime(10 * 60_000)
    expect(fakes.slice(0, 4).map(fake => fake.cancelled)).toEqual([false, false, false, false])
    expect(fakes[4].cancelled).toBe(true)
    views[0].show(true)
    await settle()
    expect(fakes[0].updates.at(-1)).toEqual({ probes: [{ probe: 'debug.synthetic.table', paused: false }, { probe: 'debug.synthetic.status', intervalMs: 1000 }] })
    expect(handles[0].getSnapshot().hiddenMode).toBeUndefined()
    // A user pause while status-only pauses it all, and it then goes dormant like any other hidden view.
    handles[1].setUserPaused(true)
    await settle()
    expect(fakes[1].updates.at(-1)).toEqual({ paused: true, probes: [{ probe: 'debug.synthetic.table', paused: false }, { probe: 'debug.synthetic.status', intervalMs: 1000 }] })
    vi.advanceTimersByTime(5 * 60_000)
    expect(fakes[1].cancelled).toBe(true)
    // The slot it freed goes to the next view that hides.
    views[0].show(false)
    vi.advanceTimersByTime(2000)
    await settle()
    expect(fakes[0].updates.at(-1)).toEqual({ probes: [{ probe: 'debug.synthetic.table', paused: true }, { probe: 'debug.synthetic.status', intervalMs: 30_000 }] })
  })

  it('peeks at open views without subscribing, and reads paused or hidden ones as stale', async () => {
    makeService()
    expect(service.peek('debug.synthetic')).toEqual([])
    expect(client.streams).toHaveLength(0)
    const view = owner()
    const handle = service.open(spec(['debug.synthetic.status']), view.value)
    const fake = client.last
    deliver(fake, opened(fake))
    deliver(fake, tick(fake))
    expect(service.peek('debug.synthetic').map(peek => [peek.id, peek.stale])).toEqual([[handle.id, false]])
    expect(service.peek('debug.synthetic', otherConnection)).toEqual([])
    handle.setUserPaused(true)
    expect(service.peek('debug.synthetic')[0]).toMatchObject({ stale: true, snapshot: { status: 'paused' } })
    await settle()
    // However often it is read.
    for (let i = 0; i < 100; i++) service.peek('debug.synthetic')
    expect(client.streams).toHaveLength(1)
    expect(fake.updates).toEqual([{ paused: true }])
  })

  it('sizes history by the setting and the interval, within 4 MiB a view and 32 MiB in all', () => {
    const series = Array.from({ length: 64 }, (_, index) => ({ id: 's' + index, unit: 'count' as const, label: 'S' + index, counter: 'gauge' as const }))
    const wide: LiveProbeSpec = { id: 'debug.synthetic.metrics', source: 'debug.synthetic', label: 'Wide', description: 'Wide.', intervalMs: { default: 1000, min: 1000, max: 3_600_000 }, series }
    const catalog: LiveCatalog = { sources: liveSources, probes: { ...liveProbes, 'debug.synthetic.metrics': wide } }
    makeService({ catalog, settings: { 'liveData.historyMinutes': 5 } })
    const open = (intervalMs?: number) => {
      const handle = service.open({ connectionId, source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.metrics', ...intervalMs ? { intervalMs } : {} }] }, owner().value)
      deliver(client.last, opened(client.last))
      return handle.ring('debug.synthetic.metrics')!
    }
    const perSample = 8 + 1 + 8 * 64
    const first = open()
    expect(first.capacity).toBe(300)
    settings.set({ 'liveData.historyMinutes': 120 })
    // 7,200 samples of 64 series take 3.6 MiB: within a view's 4 MiB.
    expect(first.capacity).toBe(7200)
    const slow = open(10_000)
    expect(slow.capacity).toBe(720)
    const rings = [first, slow, ...Array.from({ length: 14 }, () => open())]
    const total = rings.reduce((sum, ring) => sum + ring.bytes, 0)
    expect(total).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(rings.every(ring => ring.bytes <= 4 * 1024 * 1024)).toBe(true)
    expect(first.capacity).toBeLessThan(7200)
    expect(first.capacity).toBeGreaterThan(3600)
    expect(Math.abs(first.capacity * perSample * 15 + slow.bytes - total)).toBeLessThan(15 * perSample)
  })

  it('tells its listeners once a frame however many frames arrive, while acknowledging each at once', () => {
    const queued: (() => void)[] = []
    settings = settingsStore()
    service = new LiveService({ client, settings, page, schedule: callback => { queued.push(callback) } })
    const handle = service.open(spec(['debug.synthetic.status']), owner().value)
    const fake = client.last
    let calls = 0, listed = 0
    handle.subscribe(() => calls++)
    service.subscribe(() => listed++)
    deliver(fake, opened(fake))
    for (let i = 0; i < 3; i++) deliver(fake, tick(fake))
    expect(fake.acks).toHaveLength(4)
    expect([calls, listed]).toEqual([0, 0])
    expect(handle.getSnapshot().status).toBe('connecting')
    queued.splice(0).forEach(callback => callback())
    expect([calls, listed]).toEqual([1, 1])
    expect(handle.getSnapshot()).toMatchObject({ status: 'live', probes: { 'debug.synthetic.status': { state: 'fresh' } } })
    expect(service.getSnapshot().handles).toEqual([{ id: handle.id, source: 'debug.synthetic', connectionId, ownerKey: 'test', status: 'live' }])
  })

  it('cancels every view when it is disposed', () => {
    makeService()
    service.open(spec(['debug.synthetic.status']), owner().value)
    service.open(spec(['debug.synthetic.table']), owner().value)
    service.dispose()
    expect(client.streams.map(fake => fake.cancelled)).toEqual([true, true])
    const late = service.open(spec(['debug.synthetic.status']), owner().value)
    expect(late.getSnapshot()).toMatchObject({ status: 'ended', error: { code: 'PORT_CLOSED' } })
    expect(client.streams).toHaveLength(2)
  })

  it('opens a view the user paused with every probe paused, so nothing samples until Resume', async () => {
    makeService()
    const view = owner({ connectionId })
    const handle = service.open(spec(['debug.synthetic.status', 'debug.synthetic.table'], { probes: [{ probe: 'debug.synthetic.status' }, { probe: 'debug.synthetic.table', paused: true }], paused: true }), view.value)
    const fake = client.last
    expect(fake.params.probes).toEqual([{ probe: 'debug.synthetic.status', intervalMs: 1000, paused: true }, { probe: 'debug.synthetic.table', intervalMs: 1000, paused: true }])
    deliver(fake, opened(fake))
    await settle()
    expect(fake.updates).toEqual([])
    expect(handle.getSnapshot()).toMatchObject({ status: 'paused', pausedBy: 'user' })
    // Resume runs what the view runs; the probe it paused itself stays paused.
    handle.setUserPaused(false)
    await settle()
    expect(fake.updates).toEqual([{ probes: [{ probe: 'debug.synthetic.status', paused: false }] }])
    expect(handle.getSnapshot().status).toBe('live')
  })

  it('subscribes an Activity Monitor paused when Retry restarts a paused monitor', async () => {
    makeService()
    const monitorId = 'monitor-1', view = owner({ connectionId })
    const documents = {
      registerProvider: () => ({ dispose: () => {} }), activate: () => {}, getSnapshot: () => ({ documents: [] }),
      openCustom: () => ({ id: monitorId }), get: (id: string) => id === monitorId ? { id, connectionId, kind: 'activityMonitor' } : undefined
    } as unknown as ActivityMonitorServiceOptions['documents']
    const connections = { get: () => ({ id: connectionId, server: 'sql01', lost: false }) } as unknown as ActivityMonitorServiceOptions['connections']
    const activity = new ActivityMonitorService({ documents, connections, live: service, owner: () => view.value, settings: () => defaultSettings })
    const running = (fake: FakeStream) => fake.params.probes.filter(probe => !probe.paused).map(probe => probe.probe)
    activity.open(connectionId)
    expect(running(client.last)).toEqual(['activity.overview'])
    deliver(client.last, opened(client.last))
    activity.setPaused(monitorId, true)
    await settle()
    client.last.end({ ok: true, value: { ended: 'failed', code: 'BACKEND_ERROR', message: 'The live view failed.', ticks: 0, elapsedMs: 1 } })
    await settle()
    // Retry while paused: no probe runs, not even before the pause could reach the backend.
    activity.retry(monitorId)
    expect(client.streams).toHaveLength(2)
    expect(running(client.last)).toEqual([])
    expect(activity.handle(monitorId)?.getSnapshot()).toMatchObject({ pausedBy: 'user' })
    activity.setPaused(monitorId, false)
    deliver(client.last, opened(client.last))
    await settle()
    expect(client.last.updates).toEqual([{ probes: [{ probe: 'activity.overview', paused: false }] }])
    activity.dispose()
  })
})

// A chart of a view, as LiveChart binds it: whether its newest sample reads "now" follows the probe's state and the
// interval the backend runs, never the spacing of the samples in the ring.
describe('charts of a live view', () => {
  const metrics = 'debug.synthetic.metrics'
  function chartOf(handle: ReturnType<LiveService['open']>) {
    const owner = fakeOwner(), env = new FakeChartEnvironment()
    env.time = Date.now()
    const canvas = new FakeCanvas(owner, 400, 100)
    const view = new ChartView({
      canvas: canvas as unknown as HTMLCanvasElement, root: owner.createElement('div') as unknown as HTMLElement, ring: () => handle.ring(metrics), title: 'Wave',
      series: [{ index: 1, label: 'Wave', color: 'charts.blue' }], scale: { unit: 'percent', max: 100 }, window: { spanMs: 600_000, end: 'live' }, colors: resolveBuiltin('dark').colors, env, labels: 'axes',
      current: probeCurrent(handle.getSnapshot(), metrics, Date.now())
    })
    const bound = bindChart(view, handle, metrics)
    let told = 0
    view.subscribe(() => { told++ })
    const draw = () => { env.time = Date.now(); env.flush() }
    return { view, env, canvas, bound, told: () => told, newest: () => view.table(1).rows[0]?.time, axisEnd: () => { canvas.context.reset(); view.setTitle('Wave'); draw(); return canvas.context.texts.at(-1)?.text }, draw }
  }
  /** A tick with one metrics sample, run at the given interval. */
  const sample = (fake: FakeStream, effectiveIntervalMs: number, gap?: 'resumed'): LiveTick => ({
    type: 'live.tick', seq: ++seq, sampledAt: Date.now(),
    samples: fake.params.probes.map(probe => ({ probe: probe.probe, costMs: 1, effectiveIntervalMs, ...gap ? { gap } : {}, ...probe.probe === metrics ? { metrics: [seq, 50, null] } : {} }))
  } as LiveTick)
  function openMetrics(intervalMs: number, others: LiveProbeId[] = []) {
    makeService()
    const handle = service.open({ connectionId, source: 'debug.synthetic', probes: [{ probe: metrics, intervalMs }, ...others.map(probe => ({ probe }))] }, owner().value)
    const fake = client.last
    deliver(fake, opened(fake))
    return { handle, fake }
  }
  const state = (handle: ReturnType<LiveService['open']>) => handle.getSnapshot().probes[metrics].state

  it('keeps "now" through an interval raised from 2 s to 10 s, and turns to clock times only when the probe goes stale', async () => {
    const { handle, fake } = openMetrics(2000)
    const chart = chartOf(handle)
    for (let at = 0; at < 5; at++) { deliver(fake, sample(fake, 2000)); vi.advanceTimersByTime(2000) }
    fake.answer = () => ({ ok: true, value: { applied: true, probes: [{ probe: metrics, intervalMs: 10_000, effectiveIntervalMs: 10_000, paused: false }] } })
    handle.setProbe(metrics, { intervalMs: 10_000 })
    vi.advanceTimersByTime(150)
    await settle()
    deliver(fake, sample(fake, 10_000))
    vi.advanceTimersByTime(5000)
    // Five seconds after a 10 s probe's sample, the probe is fresh and the chart still says so.
    expect(state(handle)).toBe('fresh')
    chart.draw()
    expect(chart.newest()).toBe('now')
    expect(chart.axisEnd()).toBe('now')
    deliver(fake, sample(fake, 10_000))
    const last = Date.now()
    vi.advanceTimersByTime(19_999)
    chart.draw()
    expect(chart.newest()).toBe('now')
    // Twice the interval without a sample: stale, and the chart reads clock times without a tick.
    vi.advanceTimersByTime(1)
    expect(state(handle)).toBe('stale')
    expect(chart.newest()).toBe(formatClock(last))
    expect(chart.axisEnd()).toBe(formatClock(last))
    // Told when the first sample made it current, when the new interval resized its ring, and when it went stale.
    expect(chart.told()).toBe(3)
  })

  it('keeps "now" after an off-schedule refresh sample, a back-off and a first slow sample', () => {
    const { handle, fake } = openMetrics(10_000, ['debug.synthetic.status'])
    const chart = chartOf(handle)
    // A 10 s probe's first sample: 15 s on (one and a half intervals) it is still current.
    deliver(fake, sample(fake, 10_000))
    vi.advanceTimersByTime(15_000)
    chart.draw()
    expect(chart.newest()).toBe('now')
    // A Refresh sample 3 s after a regular one, then the next regular sample 7 s later.
    deliver(fake, sample(fake, 10_000))
    vi.advanceTimersByTime(3000)
    handle.refresh()
    deliver(fake, sample(fake, 10_000))
    vi.advanceTimersByTime(7000)
    deliver(fake, sample(fake, 10_000))
    vi.advanceTimersByTime(7000)
    chart.draw()
    expect(chart.newest()).toBe('now')
    // Backed off to 40 s (the cost doubled it twice): 30 s after a sample, three times the interval asked, it is current.
    for (let at = 0; at < 3; at++) {
      deliver(fake, sample(fake, 40_000))
      vi.advanceTimersByTime(30_000)
      // The view's other probe ticks: the chart hears of the view's state again, and still reads it as current.
      deliver(fake, { type: 'live.tick', seq: ++seq, sampledAt: Date.now(), samples: [{ probe: 'debug.synthetic.status', costMs: 1, effectiveIntervalMs: 1000, status: [{ id: 'samples', value: seq }] }] } as LiveTick)
      chart.draw()
      expect(chart.newest()).toBe('now')
      vi.advanceTimersByTime(10_000)
    }
    // Current from the first sample on, never stale.
    expect(chart.told()).toBe(1)
  })

  it('reads clock times at once when paused, and "now" again with the first sample after the resume', async () => {
    const { handle, fake } = openMetrics(1000)
    const chart = chartOf(handle)
    for (let at = 0; at < 5; at++) { deliver(fake, sample(fake, 1000)); vi.advanceTimersByTime(1000) }
    const last = Date.now() - 1000
    chart.draw()
    expect(chart.newest()).toBe('now')
    handle.setUserPaused(true)
    await settle()
    expect(chart.newest()).toBe(formatClock(last))
    vi.advanceTimersByTime(60_000)
    // Resumed, the probe is fresh again before its first sample: the pre-pause sample is still a minute old.
    handle.setUserPaused(false)
    await settle()
    expect(state(handle)).toBe('fresh')
    expect(chart.newest()).toBe(formatClock(last))
    deliver(fake, sample(fake, 1000, 'resumed'))
    chart.draw()
    expect(chart.newest()).toBe('now')
    // The first sample, the pause, the first sample after the resume.
    expect(chart.told()).toBe(3)
  })

  it('redraws a paused view\'s chart and lists its table again when the history setting shrinks its ring', async () => {
    const { handle, fake } = openMetrics(1000)
    const chart = chartOf(handle)
    for (let at = 0; at < 400; at++) { deliver(fake, sample(fake, 1000)); vi.advanceTimersByTime(1000) }
    handle.setUserPaused(true)
    await settle()
    chart.draw()
    const draws = chart.view.stats.draws, told = chart.told()
    expect(chart.view.table().total).toBe(400)
    settings.set({ 'liveData.historyMinutes': 5 })
    expect(handle.ring(metrics)!.capacity).toBe(300)
    chart.draw()
    expect(chart.view.stats.draws).toBe(draws + 1)
    expect(chart.told()).toBe(told + 1)
    expect(chart.view.table().total).toBe(300)
    // A resize that changes nothing tells nobody.
    service.rebalance()
    expect(chart.told()).toBe(told + 1)
    chart.bound.dispose()
    settings.set({ 'liveData.historyMinutes': 2 })
    expect(chart.told()).toBe(told + 1)
  })
})
