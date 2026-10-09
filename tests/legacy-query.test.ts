import { describe, expect, it, vi } from 'vitest'
import { legacyExecute, legacyLimits } from '../src/renderer/src/results/legacy'
import type { ResultHandle, RowWindow, WindowOptions } from '../src/renderer/src/results/ResultClient'
import { FLAG_NULL, FLAG_OVER_BUDGET, FLAG_TRUNCATED, type ResultKey } from '../src/renderer/src/results/worker-protocol'
import type { ApiResult, QueryEvent, QueryOptions, QueryResult, ResultDescriptor, VariaApi } from '../src/shared/contracts'

const options: QueryOptions = { connectionId: 'c', sessionId: 's', database: 'master', sql: 'SELECT 1', queryId: 'q', maxRows: 1000, timeoutSeconds: 0 }
const descriptor = (resultId: number, rows: number, patch: Partial<ResultDescriptor> = {}): ResultDescriptor => ({
  generation: 1, resultId, index: resultId - 1, batchNumber: 1, iteration: 1, kind: 'rows',
  columns: [{ name: 'id', dataType: 'int', wire: 'text', nullable: false }, { name: 'name', dataType: 'nvarchar', wire: 'text', nullable: true }],
  rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: rows * 10, truncatedCells: 0, state: 'complete', incomplete: false, ...patch
})
const summary = (resultSets: ResultDescriptor[], patch: Partial<QueryResult> = {}): QueryResult => ({
  resultSets, discardedResultSets: 0, messages: ['(1 rows affected)'], recordsAffected: 1, elapsedMs: 5, status: 'completed', completedBatches: 1, totalBatches: 1,
  database: 'master', messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1 }, ...patch
})

/** Results whose cells are (row, column) → text, or a flag-carrying cell; windows honour the text budget as the worker does. */
function results(cell: (resultId: number, row: number, column: number) => { text: string; flags: number } = (_, row, column) => ({ text: column === 0 ? String(row) : 'name ' + row, flags: 0 })) {
  const windows: { key: ResultKey; first: number; count: number; o?: WindowOptions }[] = []
  const released: ResultKey[][] = []
  const listeners = new Map<string, (event: QueryEvent) => void>()
  let fail: ((key: ResultKey, first: number) => Error | undefined) | undefined
  const client = {
    open: (value: ResultDescriptor): ResultHandle => ({
      key: { generation: value.generation, resultId: value.resultId }, columns: value.columns,
      getSnapshot: () => ({ ...value, state: 'complete' }), subscribe: () => () => {}, peekWindow: () => undefined, prefetch: () => {},
      getCell: async () => ({ text: '', isNull: false, truncated: false }), close: async () => {}, dispose: () => {},
      getWindow: async (first, count, o): Promise<RowWindow> => {
        const key = { generation: value.generation, resultId: value.resultId }
        windows.push({ key, first, count, o })
        const error = fail?.(key, first)
        if (error) throw error
        const rows = Math.max(0, Math.min(count, 4096, value.rowsAvailable - first))
        const width = value.columns.length
        const text: string[] = [], flags = new Uint8Array(rows * width)
        let budget = o?.textBudget ?? 1_000_000
        for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) {
          const item = cell(value.resultId, first + r, c)
          if (budget <= 0 && (item.flags & FLAG_NULL) === 0) { text.push(''); flags[r * width + c] = FLAG_OVER_BUDGET; continue }
          text.push(item.text)
          flags[r * width + c] = item.flags
          budget -= item.text.length
        }
        return { first, count: rows, colStart: 0, colEnd: width, text, flags }
      }
    }),
    onQueryEvent: (queryId: string, listener: (event: QueryEvent) => void) => { listeners.set(queryId, listener); return { dispose: () => { listeners.delete(queryId) } } },
    applySummary: vi.fn(),
    release: vi.fn(async (keys: readonly ResultKey[]) => { released.push([...keys]) })
  }
  return { client, windows, released, listeners, failWith: (next: typeof fail) => { fail = next } }
}
const api = (response: ApiResult<QueryResult>) => ({ execute: vi.fn<VariaApi['execute']>(async () => response) })

describe('legacy results table', () => {
  it('materialises every set as display rows, then releases the results', async () => {
    const fixture = results((resultId, row, column) => column === 1 && row === 1 ? { text: '', flags: FLAG_NULL } : column === 1 && row === 2 ? { text: 'cut', flags: FLAG_TRUNCATED } : { text: `${resultId}:${row}:${column}`, flags: 0 })
    const plan = descriptor(2, 1, { kind: 'executionPlan', batchNumber: 2, iteration: 3, columns: [{ name: 'Microsoft SQL Server 2005 XML Showplan', dataType: 'nvarchar', wire: 'text', role: 'plan', nullable: true }] })
    const sets = [descriptor(1, 3, { truncated: 'rowLimit', incomplete: true }), plan]
    const backend = api({ ok: true, value: summary(sets) })
    const result = await legacyExecute(backend, fixture.client, options)
    expect(backend.execute).toHaveBeenCalledWith({ ...options, maxRows: 1000, maxResultSets: 10 })
    expect(fixture.client.applySummary).toHaveBeenCalledWith(summary(sets))
    if (!result.ok) throw new Error(result.error)
    expect(result.value).toEqual({
      messages: ['(1 rows affected)'], recordsAffected: 1, elapsedMs: 5, status: 'completed', completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false,
      resultSets: [
        { columns: [{ name: 'id', dataType: 'int' }, { name: 'name', dataType: 'nvarchar' }], rows: [['1:0:0', '1:0:1'], ['1:1:0', null], ['1:2:0', 'cut… [cell truncated]']], truncated: true, incomplete: true, batchNumber: 1, iteration: 1, kind: 'rows' },
        { columns: [{ name: 'Microsoft SQL Server 2005 XML Showplan', dataType: 'nvarchar' }], rows: [['2:0:0']], truncated: false, incomplete: false, batchNumber: 2, iteration: 3, kind: 'executionPlan' }
      ]
    })
    expect(fixture.windows.map(window => [window.key.resultId, window.o?.maxCellChars])).toEqual([[1, legacyLimits.cellCharacters], [2, legacyLimits.planCharacters]])
    expect(fixture.released).toEqual([sets])
  })

  it('stops at 100,000 cells and 4,000,000 characters, as the old table did', async () => {
    const cells = results()
    const big = descriptor(1, 60_000)
    let result = await legacyExecute(api({ ok: true, value: summary([big, descriptor(2, 5)]) }), cells.client, options)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.resultSets.map(set => [set.rows.length, set.truncated])).toEqual([[50_000, true], [0, true]])
    expect(result.value.messages.filter(message => message.includes('display limits'))).toHaveLength(1)
    expect(Math.max(...cells.windows.map(window => window.count))).toBeLessThanOrEqual(4096)
    const characters = results((_, row) => ({ text: 'x'.repeat(1000), flags: row < 0 ? FLAG_NULL : 0 }))
    result = await legacyExecute(api({ ok: true, value: summary([descriptor(1, 3000)]) }), characters.client, options)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.resultSets[0].rows.length).toBe(2000)
    expect(result.value.resultSets[0].truncated).toBe(true)
  })

  it('sizes windows of large rows to fit the results worker cache', async () => {
    const cells = results()
    // 150 rows of about 2 MiB each (a large xml column): a window may cover at most half the worker's 64 MiB cache.
    const large = descriptor(1, 150, { bytesStored: 150 * 2 * 1024 * 1024 })
    const result = await legacyExecute(api({ ok: true, value: summary([large]) }), cells.client, options)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.resultSets[0].rows).toHaveLength(150)
    expect(cells.windows.map(window => window.count)).toEqual([...Array.from({ length: 9 }, () => 16), 6])
  })

  it('keeps the rows read before a failure and says some could not be loaded', async () => {
    const fixture = results()
    fixture.failWith((key, first) => key.resultId === 1 && first > 0 ? new Error('The results worker stopped. Try again.') : undefined)
    const result = await legacyExecute(api({ ok: true, value: summary([descriptor(1, 5000), descriptor(2, 2)]) }), fixture.client, options)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.resultSets.map(set => [set.rows.length, set.truncated])).toEqual([[4096, true], [0, true]])
    expect(result.value.messages.at(-1)).toBe('Some rows could not be loaded: The results worker stopped. Try again.')
    expect(result.value.messages.some(message => message.includes('display limits'))).toBe(false)
    expect(fixture.released).toHaveLength(1)
  })

  it('passes failures through unchanged, such as a backend lost mid-script', async () => {
    const lost: ApiResult<QueryResult> = { ok: false, error: 'The SQL backend stopped while this script was running. It was not re-run.', code: 'BACKEND_LOST' }
    const fixture = results()
    expect(await legacyExecute(api(lost), fixture.client, options)).toEqual(lost)
    expect(fixture.released).toEqual([])
    expect(fixture.listeners.size).toBe(0)
  })

  it('reports the rows read so far across the script while it runs', async () => {
    const fixture = results()
    const progress = vi.fn()
    let finish!: (value: ApiResult<QueryResult>) => void
    const backend = { execute: vi.fn<VariaApi['execute']>(() => new Promise(resolve => { finish = resolve })) }
    const running = legacyExecute(backend, fixture.client, options, progress)
    const emit = fixture.listeners.get('q')!
    emit({ type: 'resultSet.opened', descriptor: descriptor(1, 0) })
    emit({ type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [{ resultId: 1, rowsRead: 500, rowsStored: 500, rowsAvailable: 448, bytesStored: 1 }] })
    emit({ type: 'resultSet.closed', descriptor: descriptor(1, 700) })
    emit({ type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [{ resultId: 2, rowsRead: 40, rowsStored: 40, rowsAvailable: 0, bytesStored: 1 }] })
    emit({ type: 'messages', messages: ['ignored'] })
    expect(progress.mock.calls.map(call => call[0])).toEqual([0, 500, 700, 740])
    finish({ ok: true, value: summary([]) })
    await running
    expect(fixture.listeners.size).toBe(0)
  })
})
