import type { LiveProbeId } from '../../src/shared/live/catalog'
import type { AppliedTick, LiveHandle, LiveOwner, LiveProbeOptions, LiveSnapshot, LiveSpec } from '../../src/renderer/src/live/LiveService'

/** A live view as a test sees it: the spec and owner it was opened with, and every call the view made since. */
export interface FakeLiveView {
  readonly spec: LiveSpec
  readonly owner: LiveOwner
  readonly calls: ({ readonly method: 'setProbe'; readonly probe: LiveProbeId; readonly patch: LiveProbeOptions } | { readonly method: 'setUserPaused'; readonly paused: boolean } | { readonly method: 'refresh' | 'dispose' })[]
  disposed: boolean
  readonly handle: LiveHandle
}

/** LiveService's `open`, recording each view instead of subscribing: ActivityMonitorService tests and the workbench fixture. */
export function fakeLiveViews() {
  const views: FakeLiveView[] = []
  const open = (spec: LiveSpec, owner: LiveOwner): LiveHandle => {
    const snapshot: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: spec.connectionId }
    // Each probe's options as opened and patched since, as LiveService's probeOptions reports them.
    const options = new Map<LiveProbeId, LiveProbeOptions>(spec.probes.map(({ probe, ...rest }) => [probe, { ...rest }]))
    const view: FakeLiveView = {
      spec: structuredClone(spec), owner, calls: [], disposed: false,
      handle: {
        id: crypto.randomUUID(), source: spec.source, ownerKey: owner.key,
        getSnapshot: () => snapshot, subscribe: () => () => {},
        setProbe: (probe, patch) => { view.calls.push({ method: 'setProbe', probe, patch: { ...patch } }); if (options.has(probe)) options.set(probe, { ...options.get(probe), ...patch }) },
        probeOptions: probe => options.get(probe),
        setArgs: () => {},
        setUserPaused: paused => { view.calls.push({ method: 'setUserPaused', paused }) },
        refresh: () => { view.calls.push({ method: 'refresh' }) },
        track: () => {},
        ring: () => undefined,
        table: () => undefined,
        onTick: (_listener: (tick: AppliedTick) => void) => ({ dispose: () => {} }),
        onRings: () => ({ dispose: () => {} }),
        dispose: () => { if (!view.disposed) { view.disposed = true; view.calls.push({ method: 'dispose' }) } }
      }
    }
    views.push(view)
    return view.handle
  }
  return { views, open, get last(): FakeLiveView { return views.at(-1)! } }
}
