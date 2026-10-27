// Test mode's `window.__variaLive` (scripts/live-smoke.mjs): live views on the backend's debug.synthetic source, owned by
// a tab, and the window's visibility, which smoke runs cannot change for real (their windows keep background throttling
// off, so the page always counts as visible). Main enables test mode only in unpackaged smoke runs, and only its test
// schemas accept the synthetic source. A grid of a view's table can be mounted above the workbench (live-grid-smoke.mjs).
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import type { LiveGridSnapshot, LiveGridState } from './LiveGrid'
import { documentOwner, type LiveHandle, type LiveService } from './LiveService'
import type { TestGrid } from './test-grid'

export interface SyntheticOptions {
  /** The owner tab; the active one by default. */
  readonly tabId?: string
  /** The view's connection; the tab's own by default (or a new id: the synthetic source runs no SQL). */
  readonly connectionId?: string
  /** The metrics, table and status probes by default: the ones the fake backend (live-smoke.mjs) runs too. */
  readonly probes?: readonly LiveProbeId[]
  readonly intervalMs?: number
  readonly rows?: number
  readonly tickMs?: number
  readonly endAfterTicks?: number
  readonly logRows?: number
  readonly logLevel?: number
}

const defaultProbes: readonly LiveProbeId[] = ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status']

export function liveTestHooks(live: LiveService, documents: DocumentService, panes: PaneService, mount?: (handle: LiveHandle, probe: LiveProbeId, table: number, state?: LiveGridState) => TestGrid) {
  const handles = new Map<string, LiveHandle>()
  let mounted: TestGrid | undefined
  /** Grid states an owner keeps across remounts (mountGrid's keepState), by view, probe and table. */
  const kept = new Map<string, LiveGridState>()
  const gridState = (snapshot: LiveGridSnapshot | undefined) => snapshot && {
    newRows: snapshot.newRows, following: snapshot.following, sort: snapshot.sort, revision: snapshot.table?.revision, resultId: snapshot.table?.descriptor.resultId,
    rows: snapshot.table?.handle.getSnapshot().rowsAvailable, lost: snapshot.lost, released: snapshot.released, activeRow: snapshot.selection?.active.row, activeKey: snapshot.activeKey
  }
  const handle = (id: string) => handles.get(id)
  return {
    snapshot: (id?: string) => id === undefined ? live.getSnapshot() : handle(id)?.getSnapshot(),
    frames: (id: string) => live.frames(id),
    setPageHidden: (hidden?: boolean) => live.setPageHidden(hidden),
    subscribeSynthetic: (o: SyntheticOptions = {}): string => {
      const tabId = o.tabId ?? documents.getSnapshot().activeId
      const connectionId = o.connectionId ?? documents.get(tabId)?.connectionId ?? crypto.randomUUID()
      const probes = o.probes ?? defaultProbes
      const created = live.open({
        connectionId, source: 'debug.synthetic', probes: probes.map(probe => ({ probe, ...o.intervalMs ? { intervalMs: o.intervalMs } : {} })),
        args: {
          ...o.rows !== undefined ? { rows: o.rows } : {}, ...o.tickMs !== undefined ? { tickMs: o.tickMs } : {}, ...o.endAfterTicks !== undefined ? { endAfterTicks: o.endAfterTicks } : {},
          ...o.logRows !== undefined ? { logRows: o.logRows } : {}, ...o.logLevel !== undefined ? { logLevel: o.logLevel } : {}
        }
      }, documentOwner(tabId, documents, panes))
      handles.set(created.id, created)
      return created.id
    },
    setUserPaused: (id: string, paused: boolean) => handle(id)?.setUserPaused(paused),
    refresh: (id: string) => handle(id)?.refresh(),
    dispose: (id: string) => { handle(id)?.dispose(); handles.delete(id) },
    ring: (id: string, probe: LiveProbeId) => { const ring = handle(id)?.ring(probe); return ring && { length: ring.length, capacity: ring.capacity, lastTime: ring.lastTime, gaps: Array.from({ length: ring.length }, (_, index) => ring.flags(index)).filter(flags => flags & 1).length } },
    /** Mounts a grid of the view's table (one at a time); false without the view or a mount. */
    /** `keepState`: the grid's state is kept across mounts of the same table, as an owner document keeps it. */
    mountGrid: (id: string, probe: LiveProbeId, table = 0, o: { keepState?: boolean } = {}): boolean => {
      const view = handle(id)
      if (!view || !mount) return false
      mounted?.dispose()
      const key = `${id}/${probe}/${table}`
      let state = o.keepState ? kept.get(key) : undefined
      if (o.keepState && !state) kept.set(key, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
      mounted = mount(view, probe, table, state)
      return true
    },
    unmountGrid: () => { mounted?.dispose(); mounted = undefined },
    grid: () => gridState(mounted?.grid()?.getSnapshot()),
    sortGrid: (column: number | string | undefined, descending?: boolean) => mounted?.grid()?.sortBy(column, descending),
    /** Save Results As of the mounted grid, as its owner's command would (main's dialog is the suite's stub). */
    saveGrid: (suggestedName: string) => mounted?.grid()?.save(suggestedName, 'csv'),
    table: (id: string, probe: LiveProbeId) => { const table = handle(id)?.table(probe); return table && { descriptor: table.descriptor, revision: table.revision, state: table.handle.getSnapshot().state } }
  }
}
