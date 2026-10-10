import { vi } from 'vitest'
import type { QueryEvent, QueryResult, ResultColumn, ResultDescriptor } from '../../src/shared/contracts'
import type { ResultHandle, ResultSnapshot } from '../../src/renderer/src/results/ResultClient'

/** A result descriptor of `rows` complete rows; `patch` overrides any field. */
export const descriptor = (resultId: number, patch: Partial<ResultDescriptor> = {}): ResultDescriptor => ({
  generation: 1, resultId, index: resultId - 1, batchNumber: 1, iteration: 1, kind: 'rows',
  columns: [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }, { name: '', dataType: 'nvarchar', wire: 'text', nullable: true }] as ResultColumn[],
  rowsRead: 2, rowsStored: 2, rowsAvailable: 2, bytesStored: 20, truncatedCells: 0, state: 'complete', incomplete: false, ...patch
})
/** A summary of `sets`, completed unless `patch` says otherwise. */
export const summaryOf = (sets: ResultDescriptor[], patch: Partial<QueryResult> = {}): QueryResult => ({
  resultSets: sets, discardedResultSets: 0, messages: [], recordsAffected: -1, elapsedMs: 5, status: 'completed', completedBatches: 1, totalBatches: 1, database: 'master',
  messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 256 * 1048576, queryBytes: 128 * 1048576 }, completedAt: '2026-10-08T21:48:01.1234567+00:00', ...patch
})

export interface FakeHandle extends ResultHandle {
  snapshot: ResultSnapshot
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly dispose: ReturnType<typeof vi.fn<() => void>>
  readonly getCell: ReturnType<typeof vi.fn<ResultHandle['getCell']>>
}

/**
 * ResultClient's surface that ResultsService uses, without a worker: `open` returns one handle per result (its snapshot
 * follows the descriptors it is given), and `emit` delivers a run's events as the worker would.
 */
export function fakeResultClient() {
  const listeners = new Map<string, Set<(event: QueryEvent) => void>>()
  const handles = new Map<string, FakeHandle>()
  const keyOf = (value: { generation: number; resultId: number }) => `${value.generation}:${value.resultId}`
  const settle = (handle: FakeHandle, value: ResultDescriptor, final: boolean) => {
    handle.snapshot = {
      rowsRead: Math.max(handle.snapshot.rowsRead, value.rowsRead), rowsStored: Math.max(handle.snapshot.rowsStored, value.rowsStored), rowsAvailable: Math.max(handle.snapshot.rowsAvailable, value.rowsAvailable),
      bytesStored: value.bytesStored, truncatedCells: value.truncatedCells, state: handle.snapshot.state === 'released' || handle.snapshot.state === 'lost' ? handle.snapshot.state : final || value.state === 'complete' ? 'complete' : 'open',
      incomplete: value.incomplete, ...value.truncated ? { truncated: value.truncated } : {}
    }
  }
  const client = {
    open: vi.fn((value: ResultDescriptor): ResultHandle => {
      const existing = handles.get(keyOf(value))
      if (existing) return existing
      const handle: FakeHandle = {
        key: { generation: value.generation, resultId: value.resultId }, columns: value.columns,
        snapshot: { rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'open', incomplete: false },
        getSnapshot: () => handle.snapshot, subscribe: () => () => {},
        getWindow: async first => ({ first, count: 0, colStart: 0, colEnd: value.columns.length, text: [], flags: new Uint8Array(0) }),
        peekWindow: () => undefined, prefetch: () => {}, measure: async () => ({ rows: 0, widths: new Uint16Array(value.columns.length) }),
        getCell: vi.fn<ResultHandle['getCell']>(async () => ({ text: '', isNull: true, truncated: false, error: false, formatted: false })),
        close: vi.fn(async () => { handle.snapshot = { ...handle.snapshot, state: 'released' } }),
        dispose: vi.fn()
      }
      settle(handle, value, false)
      handles.set(keyOf(value), handle)
      return handle
    }),
    onQueryEvent: (queryId: string, listener: (event: QueryEvent) => void) => {
      const set = listeners.get(queryId) ?? new Set()
      set.add(listener)
      listeners.set(queryId, set)
      return { dispose: () => { set.delete(listener) } }
    },
    applySummary: vi.fn((summary: QueryResult) => { for (const value of summary.resultSets) { const handle = handles.get(keyOf(value)); if (handle) settle(handle, value, true) } }),
    /** Delivers an event of the run `queryId` (resultSet events also update the handle, as ResultClient does). */
    emit: (queryId: string, event: QueryEvent) => {
      if (event.type === 'resultSet.opened' || event.type === 'resultSet.closed') { const handle = handles.get(keyOf(event.descriptor)); if (handle) settle(handle, event.descriptor, false) }
      for (const listener of [...listeners.get(queryId) ?? []]) listener(event)
    },
    /** Every result's handle becomes lost, as when the backend restarts. */
    lose: () => { for (const handle of handles.values()) handle.snapshot = { ...handle.snapshot, state: 'lost' } },
    handle: (resultId: number, generation = 1) => handles.get(`${generation}:${resultId}`),
    listening: (queryId: string) => listeners.get(queryId)?.size ?? 0,
    windowsInFlight: 0
  }
  return client
}
