import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, VariaApi } from '../src/shared/contracts'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import { remoteDryRunSchema, remoteResultIds, resultsRemoteQuerySchema, type RemoteDryRun } from '../src/shared/bigquery/remote-view'
import { validateRequest } from '../src/main/validation'
import { RemoteDeclined, RemoteViews, isRemoteView, remoteStop, remoteFilter, remoteHeader, remoteOrderable, remoteSelectionText, unorderableText } from '../src/renderer/src/results/remote-views'
import { ResultError, type DistinctList, type ResultHandle } from '../src/renderer/src/results/ResultClient'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import { EventBus } from '../src/renderer/src/core/events'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { selectAll } from '../src/renderer/src/grid/selection'

// Sort, filter and value lists of a result windowed in BigQuery (docs/bigquery.md, Sort and filter in BigQuery): the
// contract main checks, the renderer's mapping of grid filters, the estimate and prompts before each billed query, and
// what the results service does with a windowed grid. The backend's own checks are BigQueryExecutionChecks.Views.cs.

const columns = [
  { name: 'id', dataType: 'INT64', wire: 'text', nullable: true },
  { name: 'tags', dataType: 'ARRAY<STRING>', wire: 'text', nullable: true },
  { name: 'name', dataType: 'STRING', wire: 'text', nullable: true }
] as ResultColumn[]
const windowed = (resultId = 1) => descriptor(resultId, { columns, rowsStored: 0, rowsAvailable: 5_000, residence: 'remote', revision: 1, rowsTotal: 5_000 })
const estimate = (patch: Partial<BigQueryDryRunResult> = {}): BigQueryDryRunResult => ({ bytesProcessed: 1024, ...patch } as BigQueryDryRunResult)

describe('results.remoteQuery view and distinct', () => {
  const head = { queryId: crypto.randomUUID(), resultId: 7, generation: 1 }
  it('takes a sort or filters for a view, and a column for a value list, strictly', () => {
    const view = { ...head, kind: 'view', sort: [{ column: 0, descending: true }], filters: [{ op: 'in', column: 2, list: 9, rows: [3], nulls: true }, { op: 'between', column: 0, list: 8, rows: [4, 1] }, { op: 'groups', column: 2, list: 9, snapshotId: 4 }, { op: 'notIn', column: 2, rows: [], nulls: true }] }
    expect(validateRequest('results.remoteQuery', view)).toEqual(view)
    const distinct = { ...head, kind: 'distinct', column: 2, filters: [{ op: 'in', column: 0, rows: [], nulls: true }], kept: [{ op: 'groups', column: 2, list: 9, snapshotId: 4 }], fallback: true }
    expect(validateRequest('results.remoteQuery', distinct)).toEqual(distinct)
    const refused: Record<string, unknown>[] = [
      { ...head, kind: 'view' }, { ...head, kind: 'view', sort: [], filters: [] },
      { ...head, kind: 'view', sort: [{ column: 0, descending: false }, { column: 0, descending: true }] },
      { ...head, kind: 'view', filters: [{ op: 'in', column: 0, rows: [1] }] },
      { ...head, kind: 'view', filters: [{ op: 'in', column: 0, list: 2, rows: [1, 2, 3] }] },
      { ...head, kind: 'view', filters: [{ op: 'between', column: 0, rows: [1, 2] }] },
      { ...head, kind: 'view', filters: [{ op: 'between', column: 0, list: 2, rows: [1] }] },
      { ...head, kind: 'view', filters: [{ op: 'in', column: 0, list: 2, rows: [100_000] }] },
      { ...head, kind: 'view', filters: [{ op: 'keepRows', column: 0, rows: [1] }] },
      { ...head, kind: 'view', filters: Array.from({ length: 17 }, () => ({ op: 'notIn', column: 0, rows: [], nulls: true })) },
      { ...head, kind: 'view', sort: Array.from({ length: 17 }, (_, column) => ({ column, descending: false })) },
      { ...head, kind: 'view', sort: [{ column: 0, descending: false, mode: 'value' }] },
      { ...head, kind: 'distinct' }, { ...head, kind: 'distinct', column: -1 }, { ...head, kind: 'distinct', column: 1, sort: [] },
      { ...head, kind: 'load', sort: [{ column: 0, descending: false }] }
    ]
    for (const value of refused) expect(() => validateRequest('results.remoteQuery', value), JSON.stringify(value)).toThrow('Invalid request')
    expect(resultsRemoteQuerySchema.safeParse(view).success).toBe(true)
  })
  it('estimates a view or a value list through bigquery.dryRun, never with a query id or a fallback', () => {
    const remote: RemoteDryRun = { resultId: 7, generation: 1, kind: 'view', sort: [{ column: 0, descending: false }] }
    expect(remoteDryRunSchema.safeParse(remote).success).toBe(true)
    const request = { connectionId: crypto.randomUUID(), remote }
    expect(validateRequest('bigquery.dryRun', request)).toEqual(request)
    for (const value of [{ ...remote, queryId: head.queryId }, { ...remote, fallback: true }, { ...remote, sort: [] }, { ...remote, kind: 'load' }])
      expect(() => validateRequest('bigquery.dryRun', { connectionId: request.connectionId, remote: value }), JSON.stringify(value)).toThrow('Invalid request')
    // Text or a remote request, never both.
    expect(() => validateRequest('bigquery.dryRun', { ...request, sql: 'SELECT 1' })).toThrow('Invalid request')
  })
  it('names the source and every value list a request names, for main to check it owns each', () => {
    expect(remoteResultIds({ resultId: 7, kind: 'view', filters: [{ op: 'in', column: 0, list: 9, rows: [1] }, { op: 'notIn', column: 1, rows: [], nulls: true }, { op: 'groups', column: 2, list: 9, snapshotId: 1 }] } as never)).toEqual([7, 9])
    expect(remoteResultIds({ resultId: 7, kind: 'distinct', column: 0, kept: [{ op: 'between', column: 0, list: 11, rows: [0, 1] }] } as never)).toEqual([7, 11])
    expect(remoteResultIds({ resultId: 7, kind: 'load' } as never)).toEqual([7])
  })
})

/** A value list of result `source`: its own result 40, with a snapshot. */
const list = (source = 1, values?: ResultHandle): DistinctList => ({
  generation: 1, resultId: 40, snapshotId: 5, column: 2, source: { resultId: source, values: values ?? ({} as ResultHandle) },
  summary: { snapshotId: 5, rows: 10, complete: true, nulls: 1, distinct: 4, approximate: false, checked: 1, nullsChecked: true },
  read: vi.fn(async () => ({ total: 4, offset: 0, values: [], checked: 1, nullsChecked: true })), tick: vi.fn(async () => ({ checked: 1, nullsChecked: true })), close: vi.fn(async () => undefined)
})

describe('remote filters', () => {
  it('names values by a value list\'s rows, and refuses what names rows of the grid', () => {
    const named = list()
    expect(remoteFilter({ filter: { op: 'in', column: 2, rows: [3], nulls: false }, list: named })).toEqual({ op: 'in', column: 2, list: 40, rows: [3] })
    expect(remoteFilter({ filter: { op: 'notIn', column: 2, rows: [3], nulls: true }, list: named })).toEqual({ op: 'notIn', column: 2, list: 40, rows: [3], nulls: true })
    expect(remoteFilter({ filter: { op: 'between', column: 2, rows: [4, 1] }, list: named })).toEqual({ op: 'between', column: 2, list: 40, rows: [4, 1] })
    expect(remoteFilter({ filter: { op: 'groups', column: 2, snapshotId: 5 }, list: named })).toEqual({ op: 'groups', column: 2, list: 40, snapshotId: 5 })
    // NULL and not NULL name no list.
    expect(remoteFilter({ filter: { op: 'in', column: 2, rows: [], nulls: true } })).toEqual({ op: 'in', column: 2, rows: [], nulls: true })
    expect(remoteFilter({ filter: { op: 'notIn', column: 2, rows: [], nulls: true } })).toEqual({ op: 'notIn', column: 2, rows: [], nulls: true })
    // Rows of the grid's own result, selected cells, kept rows and duplicates cannot be named in BigQuery.
    const memory = { ...named, source: undefined }
    for (const item of [
      { filter: { op: 'in' as const, column: 2, rows: [3], nulls: false } },
      { filter: { op: 'in' as const, column: 2, rows: [3], nulls: false }, list: memory },
      { filter: { op: 'groups' as const, column: 2, snapshotId: 5 }, list: memory },
      { filter: { op: 'in' as const, column: 2, cells: { ranges: [[0, 1]] as [number, number][] } }, list: named },
      { filter: { op: 'keepRows' as const, cells: { ranges: [[0, 1]] as [number, number][] } } },
      { filter: { op: 'duplicates' as const, columns: [0] } }
    ]) expect(remoteFilter(item), JSON.stringify(item.filter)).toBeUndefined()
  })
  it('orders the types BigQuery can order, and says why a column cannot be sorted', () => {
    expect(columns.map(remoteOrderable)).toEqual([true, false, true])
    for (const dataType of ['STRUCT<a INT64>', 'GEOGRAPHY', 'JSON', 'RANGE<DATE>', 'INTERVAL', 'array<int64>']) expect(remoteOrderable({ dataType }), dataType).toBe(false)
    for (const dataType of ['INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'BOOL', 'STRING', 'BYTES', 'DATE', 'TIME', 'DATETIME', 'TIMESTAMP']) expect(remoteOrderable({ dataType }), dataType).toBe(true)
    const header = remoteHeader(columns)
    expect([...header.filterable]).toEqual([0, 2])
    expect(header.notes.where).toBe(' in BigQuery')
    expect([...header.notes.refused]).toEqual([[1, unorderableText(columns[1])]])
    expect(unorderableText(columns[1])).toContain('ARRAY<STRING>')
  })
})

function remoteFixture(o: { answer?: Awaited<ReturnType<VariaApi['remoteQuery']>>; estimate?: BigQueryDryRunResult | undefined | Error } = {}) {
  const client = fakeResultClient()
  const api = {
    remoteQuery: vi.fn<VariaApi['remoteQuery']>(async params => o.answer ?? { ok: true, value: summaryOf([descriptor(params.kind === 'distinct' ? 41 : 50, { columns: params.kind === 'distinct' ? columns.slice(2) : columns, rowsAvailable: 3 })]) }),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } }))
  }
  const asked: RemoteDryRun[] = []
  const estimateFn = vi.fn(async (_tabId: string, remote: RemoteDryRun) => {
    asked.push(remote)
    if (o.estimate instanceof Error) throw o.estimate
    return 'estimate' in o ? o.estimate as BigQueryDryRunResult | undefined : estimate()
  })
  let ids = 0
  const views = new RemoteViews({ api, client, estimate: estimateFn, newId: () => `00000000-0000-4000-8000-00000000000${++ids}` })
  const source = client.open(windowed())
  return { client, api, views, source, asked, estimate: estimateFn }
}

describe('remote views', () => {
  it('estimates, asks, then sorts in BigQuery, and shows the new result as the view', async () => {
    const f = remoteFixture()
    const view = await f.views.view('t1', f.source, [{ column: 0, descending: true, mode: 'value' }], [{ filter: { op: 'notIn', column: 2, rows: [], nulls: true } }], new AbortController().signal)
    expect(f.asked).toEqual([{ resultId: 1, generation: 1, kind: 'view', sort: [{ column: 0, descending: true }], filters: [{ op: 'notIn', column: 2, rows: [], nulls: true }] }])
    expect(f.api.remoteQuery).toHaveBeenCalledWith({ queryId: '00000000-0000-4000-8000-000000000001', resultId: 1, generation: 1, kind: 'view', sort: [{ column: 0, descending: true }], filters: [{ op: 'notIn', column: 2, rows: [], nulls: true }] })
    expect(isRemoteView(view)).toBe(true)
    expect(view).toMatchObject({ viewId: 0, base: f.source, complete: true, approximate: false, rows: 3, baseRows: 5_000 })
    expect(view.key).toEqual({ generation: 1, resultId: 50 })
    // Closing the view releases its own result.
    await view.close()
    expect(f.client.open.mock.results.at(-1)!.value.close).toHaveBeenCalled()
  })
  it('runs nothing when a prompt is declined, and says why an estimate failed', async () => {
    const declined = remoteFixture({ estimate: undefined })
    await expect(declined.views.view('t1', declined.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal)).rejects.toBeInstanceOf(RemoteDeclined)
    expect(declined.api.remoteQuery).not.toHaveBeenCalled()
    const failed = remoteFixture({ estimate: new Error('BigQuery refused the estimate.') })
    await expect(failed.views.view('t1', failed.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal)).rejects.toThrow('BigQuery refused the estimate.')
    expect(failed.api.remoteQuery).not.toHaveBeenCalled()
  })
  it('asks for the original query again only when the estimate said the table is gone', async () => {
    const f = remoteFixture({ estimate: estimate({ fallback: true }) })
    await f.views.view('t1', f.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal)
    expect(f.api.remoteQuery.mock.calls[0][0]).toMatchObject({ kind: 'view', fallback: true })
  })
  it('cancels the query when stopped, and closes a result that answered after it', async () => {
    const f = remoteFixture()
    const stop = new AbortController()
    let answer!: (value: Awaited<ReturnType<VariaApi['remoteQuery']>>) => void
    f.api.remoteQuery.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const running = f.views.view('t1', f.source, [{ column: 0, descending: false, mode: 'value' }], [], stop.signal)
    await vi.waitFor(() => expect(f.api.remoteQuery).toHaveBeenCalled())
    stop.abort()
    expect(f.api.cancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    answer({ ok: true, value: summaryOf([descriptor(50, { columns })]) })
    await expect(running).rejects.toBeInstanceOf(RemoteDeclined)
    expect(f.client.open.mock.results.at(-1)!.value.close).toHaveBeenCalled()
  })
  it('turns a refusal or a failed job into an error with its code', async () => {
    const refused = remoteFixture({ answer: { ok: false, error: 'The result is gone.', code: 'REMOTE_EXPIRED' } as never })
    const error = await refused.views.view('t1', refused.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(ResultError)
    expect(error).toMatchObject({ code: 'REMOTE_EXPIRED', message: 'The result is gone.' })
    const failed = remoteFixture({ answer: { ok: true, value: summaryOf([], { status: 'failed', error: { code: 'QUERY_FAILED', message: 'Resources exceeded. Filter the result first.' } } as never) } })
    await expect(failed.views.view('t1', failed.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal)).rejects.toThrow('Resources exceeded. Filter the result first.')
  })
  it('gives the query\'s messages to the tab, a stop\'s as information and a failure\'s as errors', async () => {
    const said: unknown[] = []
    const lines = [{ text: 'BigQuery job p:US.job_1.', kind: 'info' as const }, { text: 'The sort or filter was cancelled.', kind: 'error' as const }]
    const stopped = remoteFixture({ answer: { ok: true, value: summaryOf([], { status: 'cancelled', messages: lines }) } })
    const views = new RemoteViews({ api: stopped.api, client: stopped.client, estimate: async () => estimate(), messages: (tabId, messages) => said.push([tabId, messages]) })
    await expect(views.view('t1', stopped.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal)).rejects.toThrow()
    expect(said).toEqual([['t1', [lines[0], { ...lines[1], kind: 'info' }]]])
    said.length = 0
    const failed = remoteFixture({ answer: { ok: true, value: summaryOf([], { status: 'failed', messages: lines, error: { code: 'QUERY_FAILED', message: 'No.' } } as never) } })
    const failing = new RemoteViews({ api: failed.api, client: failed.client, estimate: async () => estimate(), messages: (tabId, messages) => said.push([tabId, messages]) })
    await expect(failing.view('t1', failed.source, [{ column: 0, descending: false, mode: 'value' }], [], new AbortController().signal)).rejects.toThrow('No.')
    expect(said).toEqual([['t1', lines]])
  })
  it('keeps a given-up query\'s lines out of Messages, but says what a Stop left billed', async () => {
    for (const [reason, kept] of [[undefined, false], [remoteStop, true]] as const) {
      const said: unknown[] = []
      const f = remoteFixture()
      const views = new RemoteViews({ api: f.api, client: f.client, estimate: async () => estimate(), messages: (_tabId, messages) => said.push(...messages) })
      const stop = new AbortController()
      let answer!: (value: Awaited<ReturnType<VariaApi['remoteQuery']>>) => void
      f.api.remoteQuery.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
      const running = views.view('t1', f.source, [{ column: 0, descending: false, mode: 'value' }], [], stop.signal)
      await vi.waitFor(() => expect(f.api.remoteQuery).toHaveBeenCalled())
      stop.abort(reason)
      answer({ ok: true, value: summaryOf([], { status: 'cancelled', messages: [{ text: 'Varia asked BigQuery to cancel job j.', kind: 'error' }] }) })
      await expect(running).rejects.toBeInstanceOf(RemoteDeclined)
      expect(said.length > 0, String(reason)).toBe(kept)
    }
  })
  it('refuses a filter that names rows of the grid before estimating anything', async () => {
    const f = remoteFixture()
    await expect(f.views.view('t1', f.source, [], [{ filter: { op: 'keepRows', cells: { ranges: [[0, 2]] } } }], new AbortController().signal)).rejects.toThrow('does not hold')
    expect(f.estimate).not.toHaveBeenCalled()
  })
  it('lists a column\'s values into a small result whose snapshot the funnel reads, and closes both together', async () => {
    const f = remoteFixture()
    const values = await f.views.values('t1', f.source, 2, [{ filter: { op: 'notIn', column: 0, rows: [], nulls: true } }], [{ filter: { op: 'in', column: 2, rows: [], nulls: true } }])
    expect(f.api.remoteQuery.mock.calls[0][0]).toMatchObject({ kind: 'distinct', column: 2, filters: [{ op: 'notIn', column: 0, rows: [], nulls: true }], kept: [{ op: 'in', column: 2, rows: [], nulls: true }] })
    const listed = f.client.open.mock.results.at(-1)!.value
    // The list's own result is read from its first column, and names the source's column.
    expect(listed.distinct).toHaveBeenCalledWith(0, {})
    expect(values).toMatchObject({ resultId: 41, column: 2, source: { resultId: 1, values: listed } })
    await values.close()
    expect(listed.close).toHaveBeenCalled()
  })
})

function serviceFixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(async () => ({ ok: true, value: { rows: 3, bytes: 10, truncatedCells: 0, partial: false, capped: 0 } })),
    saveResults: vi.fn<VariaApi['saveResults']>(async () => ({ ok: true, value: { rows: 3, bytes: 10, truncatedCells: 0, partial: false, capped: 0, fileName: 'out.csv', format: 'csv' as const } })),
    cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {})
  }
  const remote = {
    view: vi.fn<RemoteViews['view']>(async (_tabId, source, keys, filters) => {
      const handle = client.open(descriptor(50, { columns, rowsAvailable: 3 }))
      return Object.assign(Object.create(handle), { viewId: 0, base: source, keys, filters: filters.map(item => item.filter), rows: 3, baseRows: 5_000, complete: true, approximate: false, remote: true })
    }),
    values: vi.fn<RemoteViews['values']>(async () => list())
  }
  const service = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, remote: remote as unknown as RemoteViews })
  service.begin('t1', 'q1')
  client.emit('q1', { type: 'resultSet.opened', descriptor: windowed() })
  service.finish('t1', 'q1', { summary: summaryOf([windowed()]) })
  const key = service.getSnapshot().t1!.sets[0].key
  service.registerGrid('t1', key, { selectAll: () => {}, repaint: () => {}, fitColumn: () => {}, filterColumn: () => {} })
  const tab = () => service.getSnapshot().t1!
  return { client, service, remote, key, tab, api }
}

describe('a windowed grid in the results service', () => {
  it('sorts in BigQuery, refusing a column BigQuery cannot order with why', async () => {
    const f = serviceFixture()
    f.service.cycleSort('t1', f.key, 1)
    expect(f.remote.view).not.toHaveBeenCalled()
    expect(f.tab().jobNotice).toBe(unorderableText(columns[1]))
    expect(f.service.canOrderColumn('t1', f.key, 1)).toBe(false)
    expect(f.service.canFilterColumn('t1', f.key, 1)).toBe(false)
    expect(f.service.canFilterColumn('t1', f.key, 2)).toBe(true)
    f.service.cycleSort('t1', f.key, 0)
    await vi.waitFor(() => expect(f.service.sortOf('t1', f.key)?.view).toBeDefined())
    expect(f.remote.view.mock.calls[0][2]).toEqual([{ column: 0, descending: false, mode: 'value' }])
    expect(isRemoteView(f.service.sortOf('t1', f.key)!.view)).toBe(true)
  })
  it('copies and saves a view built in BigQuery as its own result, never as a view id of the source', async () => {
    const f = serviceFixture()
    f.service.cycleSort('t1', f.key, 0)
    await vi.waitFor(() => expect(f.service.sortOf('t1', f.key)?.view).toBeDefined())
    f.service.setSelection('t1', f.key, selectAll(f.key))
    await f.service.copy('t1', f.key, false)
    expect(f.api.copyResults).toHaveBeenCalledTimes(1)
    const copied = f.api.copyResults.mock.calls[0][0]
    expect(copied).toMatchObject({ resultId: 50 })
    expect(copied).not.toHaveProperty('viewId')
    await f.service.saveAs('t1', f.key, 'SQLQuery1')
    const saved = f.api.saveResults.mock.calls[0][0]
    expect(saved).toMatchObject({ resultId: 50 })
    expect(saved).not.toHaveProperty('viewId')
  })
  it('keeps what the grid showed, silently, when a cost prompt is declined', async () => {
    const f = serviceFixture()
    f.remote.view.mockRejectedValueOnce(new RemoteDeclined())
    f.service.cycleSort('t1', f.key, 0)
    await vi.waitFor(() => expect(f.service.sortOf('t1', f.key)).toBeUndefined())
    expect(f.tab().jobNotice).toBe('')
  })
  it('says why a failed remote sort did not apply', async () => {
    const f = serviceFixture()
    f.remote.view.mockRejectedValueOnce(new Error('BigQuery ran out of resources.'))
    f.service.cycleSort('t1', f.key, 0)
    await vi.waitFor(() => expect(f.tab().jobNotice).toBe('Could not sort the results: BigQuery ran out of resources.'))
  })
  it('refuses the filters that name the grid\'s rows, saying why', () => {
    const f = serviceFixture()
    expect(f.service.filterDuplicates('t1', f.key, true)).toBe(false)
    expect(f.tab().jobNotice).toBe(remoteSelectionText)
    expect(f.service.canFilterDuplicates('t1', f.key, true)).toBe(false)
    expect(f.service.canKeepSelectedRows('t1', f.key)).toBe(false)
    expect(f.service.canFilterSelection('t1', f.key, 'notNull')).toBe(false)
  })
  it('lists values in BigQuery, ticked by every filter when the column has its own', async () => {
    const f = serviceFixture()
    await f.service.columnValues('t1', f.key, 2)
    expect(f.remote.values).toHaveBeenLastCalledWith('t1', expect.anything(), 2, [], undefined, undefined)
    await expect(f.service.columnValues('t1', f.key, 1)).rejects.toThrow('cannot sort or group')
  })
  it('filters by a value list\'s row, keeping the list with the filter, and refuses a row of the grid itself', async () => {
    const f = serviceFixture()
    const named = list()
    expect(f.service.applyColumnFilter('t1', f.key, 2, { kind: 'equals', row: 1 })).toBe(false)
    // A list of another result is not this grid's.
    expect(f.service.applyColumnFilter('t1', f.key, 2, { kind: 'equals', row: 1, list: list(9) })).toBe(false)
    expect(f.service.applyColumnFilter('t1', f.key, 2, { kind: 'equals', row: 1, list: named })).toBe(true)
    await vi.waitFor(() => expect(f.remote.view).toHaveBeenCalled())
    expect(f.remote.view.mock.calls[0][3]).toEqual([expect.objectContaining({ filter: { op: 'in', column: 2, rows: [1], nulls: false }, list: named })])
    // NULL filters name no list.
    expect(f.service.applyColumnFilter('t1', f.key, 0, { kind: 'notNull' })).toBe(true)
  })
})

describe('a windowed grid going away', () => {
  it('closes its views built in BigQuery when the results or the tab close, as the backend frees only the source', async () => {
    for (const close of ['results', 'tab'] as const) {
      const f = serviceFixture()
      f.service.cycleSort('t1', f.key, 0)
      await vi.waitFor(() => expect(f.service.sortOf('t1', f.key)?.view).toBeDefined())
      const derived = f.client.open(descriptor(50, { columns }))
      if (close === 'results') f.service.closeResults('t1')
      else f.service.release('t1')
      expect(derived.close, close).toHaveBeenCalled()
    }
  })
  it('drops a query\'s lines that answer after the tab closed, opening no run', () => {
    const f = serviceFixture()
    f.service.remoteMessages('t1', [{ text: 'BigQuery job p:US.job_1.', kind: 'info' }])
    expect(f.tab().messages.at(-1)?.text).toBe('BigQuery job p:US.job_1.')
    f.service.release('t1')
    f.service.remoteMessages('t1', [{ text: 'The sort or filter was cancelled.', kind: 'info' }])
    expect(f.service.getSnapshot().t1).toBeUndefined()
  })
  it('takes a BigQuery value list only while the result is windowed, and a list of its rows only while in memory', () => {
    const client = fakeResultClient(), timers = manualTimers()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const service = new ResultsService({ client, api, events: new EventBus(), frame: callback => callback(), timers: timers.timers })
    service.begin('t1', 'q1')
    const memory = descriptor(1, { columns })
    client.emit('q1', { type: 'resultSet.opened', descriptor: memory })
    service.finish('t1', 'q1', { summary: summaryOf([memory]) })
    const key = service.getSnapshot().t1!.sets[0].key
    service.registerGrid('t1', key, { selectAll: () => {}, repaint: () => {}, fitColumn: () => {}, filterColumn: () => {} })
    // Loaded into memory while the funnel held a BigQuery list: its rows are the list's, not the result's.
    expect(service.applyColumnFilter('t1', key, 2, { kind: 'equals', row: 1, list: list(1) })).toBe(false)
    const f = serviceFixture()
    expect(f.service.applyColumnFilter('t1', f.key, 2, { kind: 'equals', row: 1, list: { ...list(1), source: undefined, resultId: 1 } })).toBe(false)
  })
  it('treats a type this build does not know as one BigQuery cannot order, as the backend does', () => {
    expect(remoteOrderable({ dataType: 'FUTURE_TYPE' })).toBe(false)
    expect(remoteOrderable({ dataType: 'STRINGS' })).toBe(false)
    expect(remoteOrderable({ dataType: 'INT64' })).toBe(true)
  })
})
