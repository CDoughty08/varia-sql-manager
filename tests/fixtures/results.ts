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
  messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 256 * 1048576, queryBytes: 128 * 1048576, generation: 1, seq: 1 }, completedAt: '2026-10-08T21:48:01.1234567+00:00', ...patch
})

export interface FakeHandle extends ResultHandle {
  snapshot: ResultSnapshot
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly dispose: ReturnType<typeof vi.fn<() => void>>
  readonly getCell: ReturnType<typeof vi.fn<ResultHandle['getCell']>>
  readonly sort: ReturnType<typeof vi.fn<ResultHandle['sort']>>
  readonly search: ReturnType<typeof vi.fn<ResultHandle['search']>>
  readonly profile: ReturnType<typeof vi.fn<ResultHandle['profile']>>
  readonly distinct: ReturnType<typeof vi.fn<ResultHandle['distinct']>>
}

/**
 * ResultClient's surface that ResultsService uses, without a worker: `open` returns one handle per result (its snapshot
 * follows the descriptors it is given), and `emit` delivers a run's events as the worker would.
 */
export function fakeResultClient() {
  const listeners = new Map<string, Set<(event: QueryEvent) => void>>()
  const generationListeners = new Set<(generation: number) => void>()
  const handles = new Map<string, FakeHandle>()
  let snapshots = 0
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
        rowBytes: async first => ({ first, bytes: [], rowsAvailable: 0, estimated: [] }),
        close: vi.fn(async () => { handle.snapshot = { ...handle.snapshot, state: 'released' } }),
        sort: vi.fn<ResultHandle['sort']>(async () => { throw new Error('Sorting is not faked.') }),
        // Identities: row r's is 1000 + r, so a test reads them back as row numbers.
        identify: vi.fn<ResultHandle['identify']>(async () => ({ column: 0, unique: true, approximate: false, rows: handle.snapshot.rowsAvailable })),
        rowIds: vi.fn<ResultHandle['rowIds']>(async (first, count) => ({ firstRow: first, ids: Array.from({ length: Math.max(0, Math.min(count, handle.snapshot.rowsAvailable - first)) }, (_, k) => 1000 + first + k), rows: handle.snapshot.rowsAvailable })),
        findRows: vi.fn<ResultHandle['findRows']>(async ids => {
          const found = ids.map((id, mark) => ({ position: id - 1000, mark })).filter(item => item.position >= 0 && item.position < handle.snapshot.rowsAvailable).sort((a, b) => a.position - b.position)
          return { positions: found.map(item => item.position), marks: found.map(item => item.mark), truncated: false, rows: handle.snapshot.rowsAvailable }
        }),
        // A diff is result 900 + this one's id: a marker, R1 and R2, this result's columns and the hidden tone.
        diff: vi.fn<ResultHandle['diff']>(async right => ({
          descriptor: descriptor(900 + value.resultId, {
            generation: value.generation, index: value.index, kind: 'diff', rowsRead: 3, rowsStored: 3, rowsAvailable: 3,
            columns: [{ name: 'Change', dataType: 'nvarchar(1)', wire: 'text', nullable: true }, { name: 'R1', dataType: 'bigint', wire: 'text', nullable: true }, { name: 'R2', dataType: 'bigint', wire: 'text', nullable: true },
              ...right.columns, { name: '', dataType: 'nvarchar(400)', wire: 'text', nullable: true, role: 'tone' }] as ResultColumn[]
          }),
          key: 'Id', same: 1, changed: 1, added: 1, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: []
        })),
        // A pivot is result 800 + this one's id: its row columns and a Count of rows, two row groups of three rows.
        pivot: vi.fn<ResultHandle['pivot']>(async spec => ({
          descriptor: descriptor(800 + value.resultId, {
            generation: value.generation, index: value.index, kind: 'pivot', rowsRead: 2, rowsStored: 2, rowsAvailable: 2, state: 'complete',
            columns: [...spec.rows.map(column => value.columns[column]), { name: 'Count of rows', dataType: 'bigint', wire: 'text', nullable: false }] as ResultColumn[]
          }),
          rows: 3, rowGroups: 2, columnGroups: 0, approximate: false
        })),
        // A transpose is result 700 + this one's id: Column, then a column per row taken (all rows, or the ranges'), a row a column.
        transpose: vi.fn<ResultHandle['transpose']>(async (spec = {}) => {
          const rows = spec.rows ? spec.rows.reduce((sum, [, count]) => sum + count, 0) : handle.snapshot.rowsAvailable
          return {
            descriptor: descriptor(700 + value.resultId, {
              generation: value.generation, index: value.index, kind: 'transpose', rowsRead: value.columns.length, rowsStored: value.columns.length, rowsAvailable: value.columns.length, state: 'complete',
              columns: [{ name: 'Column', dataType: 'nvarchar(128)', wire: 'text', nullable: false }, ...Array.from({ length: rows }, (_, at) => ({ name: `Row ${at + 1}`, dataType: 'nvarchar(max)', wire: 'text', nullable: true }))] as ResultColumn[]
            }),
            rows, transposed: rows, columns: value.columns.length
          }
        }),
        search: vi.fn<ResultHandle['search']>(async () => ({ rows: 0, total: 0, first: 0, matchRows: [], matchColumns: [], complete: true, approximate: false })),
        profile: vi.fn<ResultHandle['profile']>(async columns => ({ rows: handle.snapshot.rowsAvailable, complete: handle.snapshot.state === 'complete', columns: columns.map(column => ({ column, values: 0, nulls: 0, distinct: 0, distinctExact: true, approximate: false })) })),
        // Distinct snapshots: none of their values unless a test says otherwise; each closes once.
        distinct: vi.fn<ResultHandle['distinct']>(async column => {
          const summary = { snapshotId: ++snapshots, rows: handle.snapshot.rowsAvailable, complete: handle.snapshot.state === 'complete', nulls: 0, distinct: 0, approximate: false, checked: 0, nullsChecked: true }
          return {
            generation: value.generation, resultId: value.resultId, snapshotId: summary.snapshotId, column, summary,
            read: vi.fn(async (o: { offset: number }) => ({ total: 0, offset: o.offset, values: [], checked: 0, nullsChecked: true })),
            tick: vi.fn(async () => ({ checked: 0, nullsChecked: true })),
            close: vi.fn(async () => undefined)
          }
        }),
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
    /** results.close for many results at once; their handles report them released (lost ones stay lost). */
    release: vi.fn(async (keys: readonly { generation: number; resultId: number }[]) => {
      for (const key of keys) { const handle = handles.get(keyOf(key)); if (handle && handle.snapshot.state !== 'lost') handle.snapshot = { ...handle.snapshot, state: 'released' } }
    }),
    onGeneration: (listener: (generation: number) => void) => { generationListeners.add(listener); return { dispose: () => { generationListeners.delete(listener) } } },
    /** The result ids `release` was asked to close, in order. */
    released: () => client.release.mock.calls.flatMap(([keys]) => keys.map(key => key.resultId)),
    /** Delivers an event of the run `queryId` (resultSet events also update the handle, as ResultClient does). */
    emit: (queryId: string, event: QueryEvent) => {
      if (event.type === 'resultSet.opened' || event.type === 'resultSet.closed') { const handle = handles.get(keyOf(event.descriptor)); if (handle) settle(handle, event.descriptor, false) }
      for (const listener of [...listeners.get(queryId) ?? []]) listener(event)
    },
    /** Every result's handle becomes lost, as when the backend restarts, and a new generation is announced. */
    lose: () => {
      for (const handle of handles.values()) handle.snapshot = { ...handle.snapshot, state: 'lost' }
      for (const listener of [...generationListeners]) listener(2)
    },
    handle: (resultId: number, generation = 1) => handles.get(`${generation}:${resultId}`),
    listening: (queryId: string) => listeners.get(queryId)?.size ?? 0,
    windowsInFlight: 0
  }
  return client
}
