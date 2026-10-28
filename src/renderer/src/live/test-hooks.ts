// Test mode's `window.__variaLive` (scripts/live-smoke.mjs): live views on the backend's debug.synthetic source, owned by
// a tab, and the window's visibility, which smoke runs cannot change for real (their windows keep background throttling
// off, so the page always counts as visible). Main enables test mode only in unpackaged smoke runs, and only its test
// schemas accept the synthetic source.
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import { documentOwner, type LiveHandle, type LiveService } from './LiveService'

/** A view's probes when the test names none: the metrics, rows and status probes the smoke suite checks, which the fake
 *  backend's workbench mode implements. The source's grid, log and wide probes serve their own tests and the benchmarks, so
 *  a test opens them by name; the fake backend refuses them, and a default of every catalogued probe would end the view. */
export const defaultSyntheticProbes: readonly LiveProbeId[] = ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status']

export interface SyntheticOptions {
  /** The owner tab; the active one by default. */
  readonly tabId?: string
  /** The view's connection; the tab's own by default (or a new id: the synthetic source runs no SQL). */
  readonly connectionId?: string
  readonly probes?: readonly LiveProbeId[]
  readonly intervalMs?: number
  readonly rows?: number
  readonly tickMs?: number
  readonly endAfterTicks?: number
}

export function liveTestHooks(live: LiveService, documents: DocumentService, panes: PaneService) {
  const handles = new Map<string, LiveHandle>()
  const handle = (id: string) => handles.get(id)
  return {
    snapshot: (id?: string) => id === undefined ? live.getSnapshot() : handle(id)?.getSnapshot(),
    frames: (id: string) => live.frames(id),
    setPageHidden: (hidden?: boolean) => live.setPageHidden(hidden),
    subscribeSynthetic: (o: SyntheticOptions = {}): string => {
      const tabId = o.tabId ?? documents.getSnapshot().activeId
      const connectionId = o.connectionId ?? documents.get(tabId)?.connectionId ?? crypto.randomUUID()
      const probes = o.probes ?? defaultSyntheticProbes
      const created = live.open({
        connectionId, source: 'debug.synthetic', probes: probes.map(probe => ({ probe, ...o.intervalMs ? { intervalMs: o.intervalMs } : {} })),
        args: { ...o.rows !== undefined ? { rows: o.rows } : {}, ...o.tickMs !== undefined ? { tickMs: o.tickMs } : {}, ...o.endAfterTicks !== undefined ? { endAfterTicks: o.endAfterTicks } : {} }
      }, documentOwner(tabId, documents, panes))
      handles.set(created.id, created)
      return created.id
    },
    setUserPaused: (id: string, paused: boolean) => handle(id)?.setUserPaused(paused),
    refresh: (id: string) => handle(id)?.refresh(),
    dispose: (id: string) => { handle(id)?.dispose(); handles.delete(id) },
    ring: (id: string, probe: LiveProbeId) => { const ring = handle(id)?.ring(probe); return ring && { length: ring.length, capacity: ring.capacity, lastTime: ring.lastTime, gaps: Array.from({ length: ring.length }, (_, index) => ring.flags(index)).filter(flags => flags & 1).length } },
    table: (id: string, probe: LiveProbeId) => { const table = handle(id)?.table(probe); return table && { descriptor: table.descriptor, revision: table.revision, state: table.handle.getSnapshot().state } }
  }
}
