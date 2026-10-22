// Test mode's `window.__variaLive` (scripts/live-smoke.mjs): live views on the backend's debug.synthetic source, owned by
// a tab, and the window's visibility, which smoke runs cannot change for real (their windows keep background throttling
// off, so the page always counts as visible). Main enables test mode only in unpackaged smoke runs, and only its test
// schemas accept the synthetic source.
import { liveSources, type LiveProbeId } from '../../../shared/live/catalog'
import type { DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import type { SsisTreeProbe } from '../ssis/SsisTreeProbe'
import { documentOwner, type LiveHandle, type LiveService } from './LiveService'

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

export function liveTestHooks(live: LiveService, documents: DocumentService, panes: PaneService, ssisTree?: SsisTreeProbe) {
  const handles = new Map<string, LiveHandle>()
  const handle = (id: string) => handles.get(id)
  return {
    snapshot: (id?: string) => id === undefined ? live.getSnapshot() : (handle(id) ?? live.get(id))?.getSnapshot(),
    /** The SSIS tree's views: one per connection whose SSISDB node is open. */
    ssisTree: () => (ssisTree?.connections ?? []).map(connectionId => ({ connectionId, id: ssisTree?.handle(connectionId)?.id })),
    frames: (id: string) => live.frames(id),
    setPageHidden: (hidden?: boolean) => live.setPageHidden(hidden),
    subscribeSynthetic: (o: SyntheticOptions = {}): string => {
      const tabId = o.tabId ?? documents.getSnapshot().activeId
      const connectionId = o.connectionId ?? documents.get(tabId)?.connectionId ?? crypto.randomUUID()
      const probes = o.probes ?? liveSources['debug.synthetic'].probes as readonly LiveProbeId[]
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
