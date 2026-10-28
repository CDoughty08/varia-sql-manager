// A LiveService stand-in for the services that own live views: `open` returns handles that record what their owner asks
// (args, probe settings, pause, refresh) and let a test set the view's snapshot and deliver ticks.
import { vi } from 'vitest'
import type { LiveArgs } from '../../src/shared/live/schema'
import type { LiveProbeId, LiveSourceId } from '../../src/shared/live/catalog'
import type { AppliedTick, LiveHandle, LiveOwner, LiveProbeOptions, LiveSnapshot, LiveSpec, LiveTable } from '../../src/renderer/src/live/LiveService'

export interface FakeLiveHandle extends LiveHandle {
  readonly spec: LiveSpec
  readonly owner: LiveOwner
  readonly args: LiveArgs[]
  readonly probes: { readonly probe: LiveProbeId; readonly patch: LiveProbeOptions }[]
  readonly paused: boolean[]
  refreshes: number
  disposed: boolean
  /** Replaces the view's snapshot and tells its subscribers. */
  set(snapshot: Partial<LiveSnapshot>): void
  /** Delivers a tick to `onTick` listeners, as the service does before it acknowledges one. */
  deliver(tick: AppliedTick['tick']): void
  tables: Map<string, LiveTable>
}

export function fakeLiveHandle(spec: LiveSpec, owner: LiveOwner): FakeLiveHandle {
  const listeners = new Set<() => void>(), ticks = new Set<(tick: AppliedTick) => void>()
  let snapshot: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: spec.connectionId }
  const handle: FakeLiveHandle = {
    id: crypto.randomUUID(), source: spec.source as LiveSourceId, ownerKey: owner.key, spec, owner, args: [], probes: [], paused: [], refreshes: 0, disposed: false, tables: new Map(),
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: next => { snapshot = { ...snapshot, ...next }; for (const listener of [...listeners]) listener() },
    deliver: tick => { for (const listener of [...ticks]) listener({ subscriptionId: snapshot.subscriptionId ?? 'sub', tick }) },
    setProbe: (probe, patch) => { handle.probes.push({ probe, patch }) },
    setArgs: args => { handle.args.push(args) },
    setUserPaused: paused => { handle.paused.push(paused); handle.set(paused ? { status: 'paused', pausedBy: 'user' } : { status: 'live', pausedBy: undefined }) },
    refresh: () => { handle.refreshes++ },
    probeOptions: () => undefined,
    track: vi.fn(),
    ring: () => undefined,
    table: (probe, index = 0) => handle.tables.get(`${probe}:${index}`),
    onTick: listener => { ticks.add(listener); return { dispose: () => { ticks.delete(listener) } } },
    dispose: () => { handle.disposed = true }
  }
  return handle
}

/** `LiveService.open` for a service under test: every handle it made, newest last. */
export function fakeLive() {
  const handles: FakeLiveHandle[] = []
  return { handles, open: vi.fn((spec: LiveSpec, owner: LiveOwner) => { const handle = fakeLiveHandle(spec, owner); handles.push(handle); return handle as LiveHandle }) }
}
