import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { cancelSettleMs, lostSessionMessage, newSessionMessage, QueryService, sessionRequests, stateBudgetMs, type QueryApi } from '../src/renderer/src/services/queries'
import { CommandService } from '../src/renderer/src/core/commands'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import type { ResultsService } from '../src/renderer/src/results/ResultsService'
import { EventBus } from '../src/renderer/src/core/events'
import { deferred, documentFixture } from './fixtures/documents'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'

const output = (patch: Partial<QueryResult> = {}): QueryResult => ({
  status: 'completed', resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false,
  budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-10-08T21:48:01.1234567+00:00', ...patch
})
/** `commandTimeout` is the profile's Advanced property; `settings` are Tools › Options'. */
function fixture(commandTimeout?: number, wait?: (ms: number) => Promise<void>, settings: Partial<SettingsValues> = {}) {
  const docs = documentFixture()
  // The backend reports the connection string's timeout (0 unless the profile set one); queries read the profile's.
  const connection: ConnectionInfo & { lost?: true; options: { advanced?: { commandTimeout?: number } } } = {
    id: 'server-a', server: 'localhost', database: 'master', serverVersion: '17', commandTimeout: commandTimeout ?? 0, generation: 1, options: commandTimeout === undefined ? {} : { advanced: { commandTimeout } }
  }
  const api = {
    estimatePlan: vi.fn<VariaApi['estimatePlan']>(async () => ({ ok: true, value: { plans: [], database: 'master' } })),
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: output() })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    confirmSessions: vi.fn<VariaApi['confirmSessions']>(async () => ({ ok: true, value: 'cancel' })),
    // No session until a test says otherwise, as the backend answers for a query that never ran.
    querySessionState: vi.fn<VariaApi['querySessionState']>(async () => ({ ok: false, error: 'This query has no open SQL session.', code: 'SESSION_CLOSED' }))
  }
  const calls: string[] = []
  const results = { begin: vi.fn<ResultsService['begin']>(tabId => { calls.push('begin ' + tabId) }), finish: vi.fn() }
  api.execute.mockImplementation(async () => { calls.push('execute'); return { ok: true, value: output() } })
  const queries = new QueryService(docs.documents, api, id => id === connection.id ? connection : undefined, docs.events, results, () => 1000, wait, () => ({ ...defaultSettings, ...settings }))
  const tab = docs.documents.create('query.sql', 'SELECT 1', 'master', connection.id)
  const events: WorkbenchEvent[] = []
  docs.events.subscribe(event => { events.push(event) })
  return { ...docs, bus: docs.events, queries, queryApi: api, connection, tab, events, results, calls }
}
describe('query orchestration', () => {
  it('collects session choices without cancelling an execution until the complete preflight is applied', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute()
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    const prepared = await f.queries.prepareSessions('disconnect', [f.tab.id])
    expect(prepared?.plan.get(f.tab.id)).toBe('rollback')
    expect(f.queryApi.cancel).not.toHaveBeenCalled()
    f.queryApi.cancel.mockImplementationOnce(async () => { pending.resolve({ ok: true, value: output({ status: 'cancelled' }) }); return { ok: true, value: { cancelled: true } } })
    await f.queries.cancelPreparedSessions(prepared!)
    await run
    expect(f.queryApi.cancel).toHaveBeenCalledTimes(1)
    expect(f.queries.isRunning(f.tab.id)).toBe(false)
  })
  it.each(['response', 'rejection'] as const)('fails strict cancellation on %s without treating acknowledgement as completion', async kind => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute()
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    const prepared = await f.queries.prepareSessions('disconnect', [f.tab.id])
    if (kind === 'response') f.queryApi.cancel.mockResolvedValueOnce({ ok: false, error: 'Cancel transport failed.' })
    else f.queryApi.cancel.mockRejectedValueOnce(new Error('Cancel transport failed.'))
    await expect(f.queries.cancelPreparedSessions(prepared!)).rejects.toThrow('outcome may be unknown')
    expect(f.queries.isRunning(f.tab.id)).toBe(true)
    pending.resolve({ ok: true, value: output() })
    await run
  })
  it('retains tabs when cancellation settles without execution completion and rejects a superseded preflight', async () => {
    const f = fixture(undefined, ms => ms === cancelSettleMs ? Promise.resolve() : new Promise(() => {})), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute()
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    const prepared = await f.queries.prepareSessions('disconnect', [f.tab.id])
    await expect(f.queries.cancelPreparedSessions(prepared!)).rejects.toThrow('has not reported completion')
    expect(f.documents.get(f.tab.id)).toBeDefined()
    pending.resolve({ ok: true, value: output() })
    await run
    await f.queries.execute()
    expect(prepared?.current()).toBe(false)
    await expect(f.queries.cancelPreparedSessions(prepared!)).rejects.toThrow('session changed')
  })
  it('preserves original result provenance after disconnect and reconnect until another execution replaces it', async () => {
    const f = fixture()
    f.queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53 }) })
    await f.queries.execute()
    const before = f.queries.getSnapshot()[f.tab.id], provenance = before.provenance
    f.queries.sessionEnded(f.tab.id)
    Object.assign(f.connection, { generation: 2 })
    expect(f.queries.getSnapshot()[f.tab.id]).toMatchObject({ summary: before.summary, provenance })
    expect(f.queries.getSnapshot()[f.tab.id].session).toBeUndefined()
    expect(provenance).toMatchObject({ generation: 1, connectionId: 'server-a', database: 'master' })
    expect(f.results.finish).toHaveBeenCalledTimes(1)
    await f.queries.execute()
    expect(f.queries.getSnapshot()[f.tab.id].provenance).toMatchObject({ generation: 2 })
    expect(f.queries.getSnapshot()[f.tab.id].provenance?.queryId).not.toBe(provenance?.queryId)
  })
  it('requests session estimation explicitly, publishes its SPID and preserves grids, toggles and statistics', async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { includeActualPlan: true, includeClientStatistics: true, includeLivePlan: true })
    await f.queries.execute()
    const previous = f.queries.getSnapshot()[f.tab.id], statistics = f.queries.statistics.getSnapshot()
    f.queryApi.estimatePlan.mockResolvedValueOnce({ ok: true, value: { database: 'tempdb', plans: [], session: { spid: 55, login: 'reader' } } })
    await f.queries.estimate(f.tab.id, 'session')
    expect(f.queryApi.estimatePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'session' }))
    expect(f.queries.getSnapshot()[f.tab.id]).toMatchObject({ summary: previous.summary, session: { connectionId: f.connection.id, spid: 55 }, estimated: { mode: 'session' } })
    expect(f.documents.get(f.tab.id)).toMatchObject({ database: 'master', includeActualPlan: true, includeLivePlan: true, includeClientStatistics: true })
    expect(f.queries.statistics.getSnapshot()).toBe(statistics)
    expect(f.results.begin).toHaveBeenCalledTimes(1)
    expect(f.results.finish).toHaveBeenCalledTimes(1)
  })
  it('forgets a session lost during estimate cleanup, keeps grids, and marks the next execution as a new session', async () => {
    const f = fixture()
    f.queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 51 }) })
    await f.queries.execute()
    const summary = f.queries.getSnapshot()[f.tab.id].summary
    f.queryApi.estimatePlan.mockResolvedValueOnce({ ok: false, code: 'SESSION_LOST', error: 'Capture cleanup failed; session closed.' })
    await f.queries.estimate(f.tab.id, 'session')
    expect(f.queries.getSnapshot()[f.tab.id]).toMatchObject({ summary, estimated: { error: expect.stringContaining('session closed') } })
    expect(f.queries.getSnapshot()[f.tab.id].session).toBeUndefined()
    expect(f.documents.get(f.tab.id)?.sessionNotice).toBe('lost')
  })
  it('uses the running-query close prompt while session estimation owns the session, without trying to read its transaction', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    f.queryApi.estimatePlan.mockReturnValueOnce(pending.promise)
    const run = f.queries.estimate(f.tab.id, 'session')
    expect(await f.queries.confirmSessions('close', [f.tab.id])).toBeUndefined()
    expect(f.queryApi.querySessionState).not.toHaveBeenCalled()
    expect(f.queryApi.confirmSessions).toHaveBeenCalledWith({ action: 'close', tabs: [{ name: 'query.sql', running: true, transactions: 0 }] })
    expect(f.queryApi.cancel).not.toHaveBeenCalled()
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    f.queryApi.cancel.mockImplementationOnce(async () => {
      pending.resolve({ ok: false, code: 'CANCELLED', error: 'Cancelled; capture cleanup completed.' })
      return { ok: true, value: { cancelled: true } }
    })
    expect(await f.queries.confirmSessions('close', [f.tab.id])).toEqual(new Map([[f.tab.id, 'rollback']]))
    await run
  })
  it('requests live capture per query tab and retains run identity until the next execution', async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { includeLivePlan: true })
    await f.queries.execute()
    const args = f.queryApi.execute.mock.calls[0][0]
    expect(args.includeLivePlan).toBe(true)
    expect(args).not.toHaveProperty('includeActualPlan')
    expect(args).not.toHaveProperty('includeClientStatistics')
    expect(f.queries.getSnapshot()[f.tab.id].livePlan?.queryId).toBe(args.queryId)
    f.documents.update(f.tab.id, { includeLivePlan: false })
    await f.queries.execute()
    expect(f.queryApi.execute.mock.calls[1][0]).not.toHaveProperty('includeLivePlan')
    expect(f.queries.getSnapshot()[f.tab.id].livePlan).toBeUndefined()
  })
  it('keeps client statistics opt-in independent and separates comparisons when live capture changes', async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { includeClientStatistics: true })
    await f.queries.execute()
    expect(f.queryApi.execute.mock.calls[0][0]).toMatchObject({ includeClientStatistics: true })
    expect(f.queryApi.execute.mock.calls[0][0]).not.toHaveProperty('includeLivePlan')
    f.documents.update(f.tab.id, { includeLivePlan: true })
    await f.queries.execute()
    expect(f.queryApi.execute.mock.calls[1][0]).toMatchObject({ includeClientStatistics: true, includeLivePlan: true })
    f.documents.update(f.tab.id, { includeLivePlan: false, includeActualPlan: true })
    await f.queries.execute()
    expect(f.queries.statistics.getSnapshot()[f.tab.id].map(run => [run.scope, run.actualPlan, run.livePlan])).toEqual([[1, false, false], [2, true, true], [3, true, false]])
  })
  it('preserves an estimate output choice through completion and opens each new estimate on its plan', async () => {
    const { queries, queryApi, tab, bus } = fixture()
    bus.emit({ type: 'query.outputSelected', tabId: tab.id, view: 'messages' })
    expect(queries.getSnapshot()[tab.id]).toBeUndefined()
    const pending = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    queryApi.estimatePlan.mockReturnValueOnce(pending.promise)
    const run = queries.estimate()
    expect(queries.getSnapshot()[tab.id].estimated?.view).toBe('plan')
    bus.emit({ type: 'query.outputSelected', tabId: tab.id, view: 'messages' })
    pending.resolve({ ok: true, value: { plans: [], database: 'master' } })
    await run
    expect(queries.getSnapshot()[tab.id].estimated?.view).toBe('messages')
    await queries.estimate()
    expect(queries.getSnapshot()[tab.id].estimated?.view).toBe('plan')
  })
  it('keeps the ordinary transaction decision when closing during an isolated estimate', async () => {
    const { queries, queryApi, tab } = fixture()
    const pending = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    queryApi.estimatePlan.mockReturnValueOnce(pending.promise)
    queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 1, checked: true } })
    const run = queries.estimate()
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'commit' })
    queryApi.cancel.mockImplementationOnce(async () => {
      pending.resolve({ ok: false, error: 'Estimate cancelled.', code: 'CANCELLED' })
      return { ok: true, value: { cancelled: true } }
    })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map([[tab.id, 'commit']]))
    expect(queryApi.querySessionState).toHaveBeenCalledExactlyOnceWith(tab.id)
    expect(queryApi.confirmSessions.mock.calls).toEqual([
      [{ action: 'close', tabs: [{ name: 'query.sql', transactions: 1, running: false }] }]
    ])
    await run
  })
  it('keeps an estimate running when the transaction prompt is cancelled, and stops it on close without a transaction', async () => {
    const { queries, queryApi, tab } = fixture()
    const pending = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    queryApi.estimatePlan.mockReturnValueOnce(pending.promise)
    queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 1, checked: true } })
    const run = queries.estimate()
    expect(await queries.confirmSessions('close', [tab.id])).toBeUndefined()
    expect(queryApi.cancel).not.toHaveBeenCalled()
    expect(queries.isRunning(tab.id)).toBe(true)
    queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 0, checked: true } })
    queryApi.cancel.mockImplementationOnce(async () => {
      pending.resolve({ ok: false, error: 'Estimate cancelled.', code: 'CANCELLED' })
      return { ok: true, value: { cancelled: true } }
    })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map())
    expect(queryApi.confirmSessions).toHaveBeenCalledOnce()
    expect(queryApi.cancel).toHaveBeenCalledOnce()
    await run
  })
  it('estimates the selected text without streaming results or changing the ordinary session and actual-plan toggle', async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { includeActualPlan: true, includeClientStatistics: true, includeLivePlan: true })
    f.queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 47, login: 'reader' }) })
    await f.queries.execute()
    const statistics = f.queries.statistics.getSnapshot()
    vi.spyOn(f.documents, 'getExecuteText').mockReturnValue({ sql: 'SELECT selected', startLine: 9 })
    f.results.begin.mockClear(); f.results.finish.mockClear(); f.queryApi.execute.mockClear()
    const previous = f.queries.getSnapshot()[f.tab.id]
    const deferredPlan = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    f.queryApi.estimatePlan.mockReturnValue(deferredPlan.promise)
    const pending = f.queries.estimate()
    expect(f.queries.isRunning(f.tab.id)).toBe(true)
    expect(f.queries.canExecute()).toBe(false)
    await f.queries.estimate(); await f.queries.execute()
    expect(f.queryApi.estimatePlan).toHaveBeenCalledTimes(1)
    expect(f.queryApi.estimatePlan).toHaveBeenCalledWith({ connectionId: f.connection.id, sessionId: f.tab.id, database: 'master', sql: 'SELECT selected', startLine: 9, requestId: expect.any(String) })
    await f.queries.cancel()
    expect(f.queryApi.cancel).toHaveBeenCalledWith(f.queryApi.estimatePlan.mock.calls[0][0].requestId)
    expect(f.queries.isRunning(f.tab.id)).toBe(true)
    deferredPlan.resolve({ ok: true, value: { plans: [{ xml: '<ShowPlanXML/>', batchNumber: 1, iteration: 1 }], database: 'tempdb' } })
    await pending
    expect(f.queries.getSnapshot()[f.tab.id]).toMatchObject({ summary: previous.summary, session: previous.session, estimated: { result: { database: 'tempdb' } } })
    expect(f.queries.statistics.getSnapshot()).toBe(statistics)
    expect(f.documents.active).toMatchObject({ database: 'master', includeActualPlan: true, includeClientStatistics: true })
    expect(f.results.begin).not.toHaveBeenCalled(); expect(f.results.finish).not.toHaveBeenCalled(); expect(f.queryApi.execute).not.toHaveBeenCalled()
    await f.queries.execute()
    expect(f.queries.getSnapshot()[f.tab.id].estimated).toBeUndefined()
    expect(f.queryApi.execute).toHaveBeenCalledWith(expect.objectContaining({ includeActualPlan: true }))
  })
  it('shows estimate failures separately and skips blank SQL', async () => {
    const f = fixture()
    f.queryApi.estimatePlan.mockResolvedValue({ ok: false, error: 'SHOWPLAN permission denied', code: 'SQL_ERROR' })
    await f.queries.estimate()
    expect(f.queries.getSnapshot()[f.tab.id].estimated?.error).toBe('SHOWPLAN permission denied')
    expect(f.queries.isRunning(f.tab.id)).toBe(false)
    vi.spyOn(f.documents, 'getExecuteText').mockReturnValue({ sql: '  ', startLine: 1 })
    await f.queries.estimate()
    expect(f.queryApi.estimatePlan).toHaveBeenCalledTimes(1)
    f.queries.dispose()
  })
  it('does not resurrect a closed tab when its cancelled estimate answers late', async () => {
    const f = fixture(undefined, async () => {})
    const pending = deferred<Awaited<ReturnType<VariaApi['estimatePlan']>>>()
    f.queryApi.estimatePlan.mockReturnValue(pending.promise)
    const run = f.queries.estimate()
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    await f.queries.confirmSessions('close', [f.tab.id])
    await f.documents.runTask(() => f.documents.close(f.tab.id, 'rollback'))
    f.queries.forget(f.tab.id)
    pending.resolve({ ok: true, value: { plans: [], database: 'master' } })
    await run
    expect(f.queries.getSnapshot()[f.tab.id]).toBeUndefined()
    expect(f.results.begin).not.toHaveBeenCalled(); expect(f.results.finish).not.toHaveBeenCalled()
  })
  it('caps retained estimate XML across tabs while preserving ordinary results and the newest estimate', async () => {
    const f = fixture()
    await f.queries.execute()
    const summary = f.queries.getSnapshot()[f.tab.id].summary
    f.queryApi.estimatePlan.mockResolvedValue({ ok: true, value: { database: 'master', plans: [{ xml: 'x'.repeat(2_097_152), batchNumber: 1, iteration: 1 }] } })
    await f.queries.estimate(f.tab.id)
    f.bus.emit({ type: 'query.outputSelected', tabId: f.tab.id, view: 'results' })
    for (let i = 0; i < 8; i++) {
      const tab = f.documents.create(`q${i}.sql`, 'SELECT 1', 'master', f.connection.id)
      await f.queries.estimate(tab.id)
    }
    const states = Object.values(f.queries.getSnapshot())
    expect(states.filter(state => state.estimated?.result)).toHaveLength(8)
    expect(f.queries.getSnapshot()[f.tab.id]).toMatchObject({ summary, estimated: { view: 'results', error: expect.stringContaining('released to limit memory') } })
    expect(f.queries.getSnapshot()[f.documents.active!.id].estimated?.result).toBeDefined()
  })
  it('reserves execution before notifying statistics listeners, preventing a reentrant second execution', async () => {
    const { documents, queries, queryApi, tab } = fixture()
    documents.update(tab.id, { includeClientStatistics: true })
    const unsub = queries.statistics.subscribe(() => { if (queries.statistics.getSnapshot()[tab.id]?.at(-1)?.status === 'running') void queries.execute() })
    await queries.execute()
    expect(queryApi.execute).toHaveBeenCalledOnce()
    expect(queries.statistics.getSnapshot()[tab.id]).toHaveLength(1)
    unsub()
  })
  it('collects only included executions, retains comparisons across result replacement, and forgets closed tabs', async () => {
    const { documents, queries, queryApi, tab, bus } = fixture()
    await queries.execute()
    expect(queryApi.execute.mock.calls[0][0]).not.toHaveProperty('includeClientStatistics')
    expect(queries.statistics.getSnapshot()).toEqual({})
    documents.update(tab.id, { includeClientStatistics: true })
    queryApi.execute.mockResolvedValue({ ok: true, value: output({ spid: 50, clientStatistics: { counters: { BytesReceived: 400 } } }) })
    await queries.execute(); await queries.execute()
    expect(queryApi.execute.mock.calls[1][0]).toHaveProperty('includeClientStatistics', true)
    expect(queries.statistics.getSnapshot()[tab.id]).toHaveLength(2)
    bus.emit({ type: 'session.ended', tabId: tab.id }); await queries.execute()
    expect(queries.statistics.getSnapshot()[tab.id].at(-1)?.scope).toBe(2)
    bus.emit({ type: 'documents.closed', tabId: tab.id })
    expect(queries.statistics.getSnapshot()).toEqual({})
  })
  it.each([0, 7, undefined])('uses the document session and preserves timeout %s', async timeout => {
    const { queries, queryApi, tab } = fixture(timeout)
    await queries.execute()
    // Rows are bounded by the backend's memory budget only, and every result set up to 1,000 is kept.
    expect(queryApi.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: tab.id, sql: 'SELECT 1', startLine: 1, timeoutSeconds: timeout ?? 0, maxRows: 0, maxResultSets: 1000 }))
    expect(queryApi.execute.mock.calls[0][0]).not.toHaveProperty('stopOnError')
  })
  it('takes the execution time-out from Tools › Options unless the profile sets a command timeout', async () => {
    const options = { 'queryExecution.executionTimeout': 30 }
    const fromSettings = fixture(undefined, undefined, options)
    await fromSettings.queries.execute()
    expect(fromSettings.queryApi.execute.mock.calls[0][0].timeoutSeconds).toBe(30)
    // An explicit 0 in the profile means no timeout, whatever Options says.
    for (const timeout of [0, 7]) {
      const fromProfile = fixture(timeout, undefined, options)
      await fromProfile.queries.execute()
      expect(fromProfile.queryApi.execute.mock.calls[0][0].timeoutSeconds).toBe(timeout)
    }
  })
  it('sends stopOnError only when it is on, and the result-set limit Options sets', async () => {
    const { queries, queryApi } = fixture(undefined, undefined, { 'queryExecution.stopOnError': true, 'queryResults.grid.maxResultSets': 5 })
    await queries.execute()
    expect(queryApi.execute.mock.calls[0][0]).toMatchObject({ stopOnError: true, maxResultSets: 5, maxRows: 0 })
  })
  it('sends the limit on rows kept that Options sets, and none by default', async () => {
    const limited = fixture(undefined, undefined, { 'queryResults.grid.maxRows': 250_000 })
    await limited.queries.execute()
    expect(limited.queryApi.execute.mock.calls[0][0]).toMatchObject({ maxRows: 250_000 })
    const plain = fixture()
    await plain.queries.execute()
    expect(plain.queryApi.execute.mock.calls[0][0]).toMatchObject({ maxRows: 0 })
    // Discard results after execution is asked of the backend only when on.
    expect(plain.queryApi.execute.mock.calls[0][0]).not.toHaveProperty('discardResults')
    const discarding = fixture(undefined, undefined, { 'queryResults.grid.discardResults': true })
    await discarding.queries.execute()
    expect(discarding.queryApi.execute.mock.calls[0][0]).toMatchObject({ discardResults: true })
  })
  it('delivers events to later listeners when an earlier one throws', () => {
    const bus = new EventBus(), received: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bus.subscribe(() => { throw new Error('listener failure') })
    bus.subscribe(event => { received.push(event.type) })
    bus.emit({ type: 'documents.changed' })
    expect(received).toEqual(['documents.changed'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
  it('keeps running state consistent when a listener throws', async () => {
    const { queries, queryApi, tab, events } = fixture()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    events.length = 0
    queries.subscribe(() => { throw new Error('listener failure') })
    await queries.execute()
    expect(queryApi.execute).toHaveBeenCalledTimes(1)
    expect(queries.isRunning(tab.id)).toBe(false)
    expect(events.map(event => event.type).filter(type => type.startsWith('query.'))).toEqual(['query.started', 'query.finished'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
  it('reserves execution synchronously and routes completion back to the original tab', async () => {
    const { documents, queries, queryApi, tab, events } = fixture()
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const first = queries.execute()
    await queries.execute()
    expect(queryApi.execute).toHaveBeenCalledTimes(1)
    const other = documents.create('other.sql', 'SELECT 2', 'master', 'server-a')
    pending.resolve({ ok: true, value: output({ database: 'changed' }) })
    await first
    expect(queries.getSnapshot()[tab.id].summary?.database).toBe('changed')
    expect(documents.get(tab.id)?.database).toBe('changed')
    expect(documents.active?.id).toBe(other.id)
    expect(queries.getSnapshot()[other.id]).toBeUndefined()
    const started = events.find(event => event.type === 'query.started')
    expect(events.find(event => event.type === 'query.finished')).toMatchObject({ tabId: tab.id, queryId: started && 'queryId' in started ? started.queryId : undefined })
  })
  it('blocks commands during asynchronous close/retarget work and ignores empty or disconnected documents', async () => {
    const { documents, queries, queryApi, tab, model } = fixture()
    const commands = new CommandService()
    commands.register('query.execute', { when: () => queries.canExecute(), run: () => queries.execute() })
    const pending = deferred<void>(), transition = documents.runTask(() => pending.promise)
    await commands.run('query.execute'); await queries.execute()
    expect(queryApi.execute).not.toHaveBeenCalled()
    pending.resolve(); await transition
    model(tab.id).edit('   ')
    await commands.run('query.execute')
    documents.update(tab.id, { connectionId: undefined })
    model(tab.id).edit('SELECT 1')
    await commands.run('query.execute')
    expect(queryApi.execute).not.toHaveBeenCalled()
  })
  it('cancels the currently active execution while retaining running state until completion', async () => {
    const { documents, queries, queryApi, tab } = fixture()
    const first = deferred<ApiResult<QueryResult>>(), second = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const left = queries.execute()
    const other = documents.create('other.sql', 'SELECT 2', 'master', 'server-a'), right = queries.execute()
    const rightId = queries.getSnapshot()[other.id].running!.queryId
    await queries.cancel()
    expect(queryApi.cancel).toHaveBeenLastCalledWith(rightId)
    expect(queries.isRunning(other.id)).toBe(true)
    documents.activate(tab.id)
    await queries.cancel()
    expect(queryApi.cancel).toHaveBeenLastCalledWith(queries.getSnapshot()[tab.id].running!.queryId)
    first.resolve({ ok: true, value: output({ status: 'cancelled' }) })
    second.resolve({ ok: true, value: output({ status: 'cancelled' }) })
    await Promise.all([left, right])
    expect(queries.isConnectionRunning('server-a')).toBe(false)
  })
  it('retains failed-script partial output and reports transport errors separately', async () => {
    const { queries, queryApi, tab } = fixture()
    const partial = output({ status: 'failed', messages: [{ text: 'Earlier batch output', kind: 'info' }], error: { code: 'SQL_ERROR', message: 'Bad SQL', batchNumber: 2, iteration: 1 } })
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: partial })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: partial, error: undefined, session: undefined, provenance: expect.objectContaining({ connectionId: 'server-a', generation: 1, database: 'master' }) })
    queryApi.execute.mockResolvedValueOnce({ ok: false, error: 'Backend unavailable', code: 'BACKEND_LOST' })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: undefined, error: 'Backend unavailable', session: undefined, provenance: expect.objectContaining({ connectionId: 'server-a', generation: 1 }) })
  })
  it('does not let a late cancel failure overwrite a completed result', async () => {
    const { queries, queryApi, tab } = fixture()
    const execute = deferred<ApiResult<QueryResult>>(), cancel = deferred<ApiResult<{ cancelled: boolean }>>()
    queryApi.execute.mockReturnValueOnce(execute.promise); queryApi.cancel.mockReturnValueOnce(cancel.promise)
    const execution = queries.execute(), cancellation = queries.cancel()
    execute.resolve({ ok: true, value: output() }); await execution
    cancel.resolve({ ok: false, error: 'Old cancellation failed' }); await cancellation
    expect(queries.getSnapshot()[tab.id].error).toBeUndefined()
  })
  it('ignores completion after disposal', async () => {
    const { queries, queryApi, events } = fixture()
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const execution = queries.execute()
    queries.dispose()
    pending.resolve({ ok: true, value: output() }); await execution
    expect(events.some(event => event.type === 'query.finished')).toBe(false)
  })
  it('follows the run\'s results before the script is sent, and ends them with the summary or main\'s failure', async () => {
    const { queries, queryApi, tab, results, calls } = fixture()
    await queries.execute()
    expect(calls).toEqual(['begin ' + tab.id, 'execute'])
    const queryId = results.begin.mock.calls[0][1]
    expect(results.finish).toHaveBeenLastCalledWith(tab.id, queryId, { summary: output(), error: undefined, code: undefined, notice: undefined })
    expect(queries.getSnapshot()[tab.id].running).toBeUndefined()
    queryApi.execute.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped while this script was running. It was not re-run.', code: 'BACKEND_LOST' })
    await queries.execute()
    expect(results.finish).toHaveBeenLastCalledWith(tab.id, results.begin.mock.calls[1][1], { summary: undefined, error: 'The SQL backend stopped while this script was running. It was not re-run.', code: 'BACKEND_LOST', notice: undefined })
  })
  it('says once that a query runs in a new session after a reconnect, before its own messages', async () => {
    const { documents, queries, tab, results } = fixture()
    documents.update(tab.id, { sessionNotice: 'restarted' })
    await queries.execute()
    expect(results.finish.mock.calls[0][2]).toMatchObject({ notice: newSessionMessage })
    expect(documents.get(tab.id)?.sessionNotice).toBeUndefined()
    await queries.execute()
    expect(results.finish.mock.calls[1][2]).toMatchObject({ notice: undefined })
  })
  it('records when a run started', async () => {
    const { queries, queryApi, tab } = fixture()
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const execution = queries.execute()
    expect(queries.getSnapshot()[tab.id].running).toEqual({ queryId: expect.any(String), connectionId: 'server-a', startedAt: 1000 })
    pending.resolve({ ok: true, value: output() })
    await execution
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: output(), error: undefined, session: undefined, provenance: expect.objectContaining({ connectionId: 'server-a', generation: 1 }) })
  })
  it('keeps the SPID and login the summary reports, for the connection it ran on, and reads no transaction while executing', async () => {
    const { queries, queryApi, tab, documents, bus } = fixture()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53, login: 'sa' }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', spid: 53, login: 'sa' })
    // A run under way keeps it; a failure that leaves the session alone keeps it too.
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', spid: 53, login: 'sa' })
    pending.resolve({ ok: false, error: 'A query is already running in this tab.', code: 'SESSION_BUSY' }); await running
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', spid: 53, login: 'sa' })
    // A session that ended, or one the backend found lost, has none; nor does a summary without a SPID (the session closed
    // during the script, or never opened).
    bus.emit({ type: 'session.ended', tabId: tab.id })
    expect(queries.getSnapshot()[tab.id].session).toBeUndefined()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53, login: 'sa' }) })
    await queries.execute()
    queryApi.execute.mockResolvedValueOnce({ ok: false, error: 'The SQL session was lost.', code: 'SESSION_LOST' })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toBeUndefined()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 54, login: 'sa' }) })
    await queries.execute()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed' }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toBeUndefined()
    // As in SSMS, nothing asks the session about its transaction after a script: only ending it does.
    expect(queryApi.querySessionState).not.toHaveBeenCalled()
    documents.update(tab.id, { connectionId: 'server-a' })
    expect(queryApi.querySessionState).not.toHaveBeenCalled()
  })
  it('shows a first run\'s SID immediately and ignores its late event after the summary closed the session', async () => {
    const { queries, queryApi, tab, results } = fixture()
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute()
    const opened = results.begin.mock.calls[0][2]!
    const event = { type: 'session.opened', spid: 51, login: 'reader' } as const
    opened(event)
    expect(queries.getSnapshot()[tab.id]).toMatchObject({ running: expect.any(Object), session: { connectionId: 'server-a', spid: 51, login: 'reader' } })
    pending.resolve({ ok: true, value: output({ status: 'failed' }) })
    await running
    opened(event)
    expect(queries.getSnapshot()[tab.id].session).toBeUndefined()
  })
  it('reads an idle session\'s transaction on demand, and treats what it cannot read as one that may be open', async () => {
    const { queries, queryApi, tab, documents, connection } = fixture()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53, login: 'sa' }) })
    await queries.execute()
    queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 2, checked: true } })
    expect(await queries.transactionState(tab.id)).toEqual({ transactions: 2 })
    expect(queryApi.querySessionState).toHaveBeenLastCalledWith(tab.id)
    // SET SHOWPLAN_*, NOEXEC, PARSEONLY or FMTONLY ON kept the SELECT from returning a count.
    queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 0, checked: false } })
    expect(await queries.transactionState(tab.id)).toEqual({ transactions: 0, unchecked: true })
    // A busy session, no answer in time, or a failed request: it may hold one.
    for (const failure of [{ ok: false, error: 'busy', code: 'SESSION_BUSY' }, { ok: false, error: 'late', code: 'TIMEOUT' }, { ok: false, error: 'Too many pending backend requests.', code: 'TOO_MANY_REQUESTS' }, { ok: false, error: 'no code' }] as const) {
      queryApi.querySessionState.mockResolvedValueOnce(failure)
      expect(await queries.transactionState(tab.id), failure.error).toEqual({ transactions: 0, unchecked: true })
    }
    queryApi.querySessionState.mockRejectedValueOnce(new Error('IPC failed'))
    expect(await queries.mayHaveTransaction(tab.id)).toBe(true)
    // No session, or one lost (SQL Server rolled it back): nothing open, and the status bar forgets it.
    for (const code of ['SESSION_LOST', 'SESSION_CLOSED', 'BACKEND_LOST', 'CONNECTION_LOST', 'NOT_CONNECTED'] as const) {
      queryApi.querySessionState.mockResolvedValueOnce({ ok: false, error: code, code })
      expect(await queries.transactionState(tab.id), code).toEqual({ transactions: 0 })
    }
    expect(queries.getSnapshot()[tab.id].session).toBeUndefined()
    // A query moved off its connection, a lost connection, or no connection at all is not asked.
    const calls = queryApi.querySessionState.mock.calls.length
    connection.lost = true
    expect(await queries.mayHaveTransaction(tab.id)).toBe(false)
    delete connection.lost
    documents.update(tab.id, { connectionId: undefined })
    expect(await queries.mayHaveTransaction(tab.id)).toBe(false)
    expect(await queries.mayHaveTransaction('gone')).toBe(false)
    expect(queryApi.querySessionState).toHaveBeenCalledTimes(calls)
  })
  it('reads the sessions a few at a time before one prompt, and sends only those that need asking', async () => {
    const { queries, queryApi, documents } = fixture()
    const tabs = Array.from({ length: 20 }, (_, index) => documents.create(`q${index}.sql`, 'SELECT 1', 'master', 'server-a'))
    let reading = 0, most = 0
    queryApi.querySessionState.mockImplementation(async id => {
      most = Math.max(most, ++reading)
      await new Promise(resolve => { setTimeout(resolve, 1) })
      reading--
      const index = tabs.findIndex(tab => tab.id === id)
      return index === 3 ? { ok: true, value: { transactionCount: 1, checked: true } } : index === 7 ? { ok: true, value: { transactionCount: 0, checked: false } }
        : index === 9 ? { ok: false, error: 'No session.', code: 'SESSION_CLOSED' } : { ok: true, value: { transactionCount: 0, checked: true } }
    })
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'rollback' })
    expect(await queries.confirmSessions('closeAll', tabs.map(tab => tab.id))).toEqual(new Map([[tabs[3].id, 'rollback'], [tabs[7].id, 'rollback']]))
    expect(queryApi.querySessionState).toHaveBeenCalledTimes(20)
    expect(most).toBe(sessionRequests)
    expect(queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'closeAll', tabs: [{ name: 'q3.sql', transactions: 1, running: false }, { name: 'q7.sql', transactions: 0, running: false, unchecked: true }] })
  })
  it('hands a run that settles after its tab closed to the results, so its sets are released', async () => {
    const waited: number[] = []
    const { queries, queryApi, tab, documents, results } = fixture(undefined, async ms => { waited.push(ms) })
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = queries.execute()
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map([[tab.id, 'rollback']]))
    expect(waited).toEqual([cancelSettleMs])
    await documents.runTask(() => documents.close(tab.id, 'rollback'))
    queries.forget(tab.id)
    const late = output({ status: 'cancelled', resultSets: [{ resultId: 7, generation: 1, index: 0, columns: [], rowsRead: 1, rowsStored: 1, rowsAvailable: 1, bytesStored: 1, truncatedCells: 0, state: 'complete' }] as unknown as QueryResult['resultSets'] })
    pending.resolve({ ok: true, value: late }); await run
    expect(results.finish).toHaveBeenLastCalledWith(tab.id, expect.any(String), { summary: late, error: undefined, code: undefined })
    expect(queries.getSnapshot()[tab.id]).toBeUndefined()
  })
  it('asks main only about open transactions and running queries, cancels the running ones, and plans how each session ends', async () => {
    const { queries, queryApi, tab, documents } = fixture()
    const other = documents.create('other.sql', 'SELECT 2', 'master', 'server-a'), idle = documents.create('idle.sql', 'SELECT 3', 'master', 'server-a')
    expect(await queries.confirmSessions('exit', [tab.id, other.id, idle.id])).toEqual(new Map())
    expect(queryApi.confirmSessions).not.toHaveBeenCalled()
    await queries.execute(tab.id)
    queryApi.querySessionState.mockClear()
    queryApi.querySessionState.mockImplementation(async id => id === tab.id ? { ok: true, value: { transactionCount: 1, checked: true } } : { ok: false, error: 'No session.', code: 'SESSION_CLOSED' })
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = queries.execute(other.id)
    // The cancel lands, and the query stops with a transaction it had opened: it is rolled back, never committed.
    queryApi.cancel.mockImplementationOnce(async () => { pending.resolve({ ok: true, value: output({ status: 'cancelled' }) }); return { ok: true, value: { cancelled: true } } })
    // As SSMS asks each window, the executing query is asked about first (Keep Running is the default) and the open
    // transaction then (Yes is the default), so Enter never cancels a running query.
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' }).mockResolvedValueOnce({ ok: true, value: 'commit' })
    const plan = await queries.confirmSessions('exit', [tab.id, other.id, idle.id, 'gone'])
    expect(queryApi.confirmSessions.mock.calls).toEqual([[{ action: 'exit', tabs: [{ name: 'other.sql', transactions: 0, running: true }] }], [{ action: 'exit', tabs: [{ name: 'query.sql', transactions: 1, running: false }] }]])
    expect(queryApi.cancel).toHaveBeenCalledOnce()
    // An executing query's session is not read: it is busy, and is cancelled and rolled back whatever it holds.
    expect(queryApi.querySessionState.mock.calls.map(([id]) => id)).toEqual([tab.id, idle.id])
    expect(queries.isRunning(other.id)).toBe(false)
    expect(plan).toEqual(new Map([[tab.id, 'commit'], [other.id, 'rollback']]))
    await run
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'rollback' })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map([[tab.id, 'rollback']]))
  })
  it('changes nothing on Cancel, and reports a prompt that failed', async () => {
    const { queries, queryApi, tab } = fixture()
    queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 1, checked: true } })
    expect(await queries.confirmSessions('changeConnection', [tab.id])).toBeUndefined()
    expect(queryApi.confirmSessions).toHaveBeenLastCalledWith({ action: 'changeConnection', tabs: [{ name: 'query.sql', transactions: 1, running: false }] })
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: false, error: 'Untrusted IPC sender.' })
    await expect(queries.confirmSessions('changeConnection', [tab.id])).rejects.toThrow('Untrusted IPC sender.')
  })
  it('cancels nothing until both prompts are answered: Keep Running, or Cancel on the transactions, keeps everything', async () => {
    const { queries, queryApi, tab, documents } = fixture()
    const other = documents.create('other.sql', 'SELECT 2', 'master', 'server-a')
    queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 1, checked: true } })
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = queries.execute(other.id)
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'cancel' })
    expect(await queries.confirmSessions('exit', [tab.id, other.id])).toBeUndefined()
    expect(queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'exit', tabs: [{ name: 'other.sql', transactions: 0, running: true }] })
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' }).mockResolvedValueOnce({ ok: true, value: 'cancel' })
    expect(await queries.confirmSessions('exit', [tab.id, other.id])).toBeUndefined()
    expect(queryApi.confirmSessions).toHaveBeenCalledTimes(3)
    expect(queryApi.cancel).not.toHaveBeenCalled()
    expect(queries.isRunning(other.id)).toBe(true)
    pending.resolve({ ok: true, value: output() }); await run
  })
  it('keeps only a few cancels in flight, so main\'s reserve for the control lane is never exceeded', async () => {
    const { queries, queryApi, documents } = fixture(undefined, async () => {})
    const tabs = Array.from({ length: 20 }, (_, index) => documents.create(`q${index}.sql`, 'WAITFOR DELAY', 'master', 'server-a'))
    const runs = tabs.map(tab => {
      const pending = deferred<ApiResult<QueryResult>>()
      queryApi.execute.mockReturnValueOnce(pending.promise)
      return { run: queries.execute(tab.id), pending }
    })
    let cancelling = 0, most = 0
    queryApi.cancel.mockImplementation(async () => {
      most = Math.max(most, ++cancelling)
      await new Promise(resolve => { setTimeout(resolve, 1) })
      cancelling--
      return { ok: true, value: { cancelled: true } }
    })
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    expect(await queries.confirmSessions('closeAll', tabs.map(tab => tab.id))).toEqual(new Map(tabs.map(tab => [tab.id, 'rollback'])))
    expect(queryApi.cancel).toHaveBeenCalledTimes(20)
    expect(most).toBe(sessionRequests)
    for (const { run, pending } of runs) { pending.resolve({ ok: true, value: output({ status: 'cancelled' }) }); await run }
  })
  it('asks once the state reads\' time budget is spent, treating the sessions not read as ones that may be open', async () => {
    const budget = deferred<void>(), waited: number[] = []
    const { queries, queryApi, documents, tab } = fixture(undefined, ms => { waited.push(ms); return budget.promise })
    const tabs = [tab, ...Array.from({ length: 11 }, (_, index) => documents.create(`q${index}.sql`, 'SELECT 1', 'master', 'server-a'))]
    // An unresponsive backend or server: no read ever answers.
    queryApi.querySessionState.mockImplementation(() => new Promise(() => {}))
    const asking = queries.confirmSessions('exit', tabs.map(item => item.id))
    await new Promise(resolve => { setTimeout(resolve, 1) })
    expect(waited).toEqual([stateBudgetMs])
    expect(queryApi.querySessionState).toHaveBeenCalledTimes(sessionRequests)
    expect(queryApi.confirmSessions).not.toHaveBeenCalled()
    budget.resolve()
    expect(await asking).toBeUndefined()
    expect(queryApi.querySessionState).toHaveBeenCalledTimes(sessionRequests)
    expect(queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'exit', tabs: tabs.map(item => ({ name: item.name, transactions: 0, running: false, unchecked: true })) })
  })
  it('says that a query runs in a new session when a state read found its session lost', async () => {
    const { queries, queryApi, tab, documents, results } = fixture()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53, login: 'sa' }) })
    await queries.execute()
    // Killed, or the server failed over: Close All reads it (nothing open), and the user keeps the query.
    queryApi.querySessionState.mockResolvedValueOnce({ ok: false, error: 'The SQL session was lost, so SQL Server rolled back its transaction.', code: 'SESSION_LOST' })
    expect(await queries.confirmSessions('closeAll', [tab.id])).toEqual(new Map())
    expect(documents.get(tab.id)?.sessionNotice).toBe('lost')
    await queries.execute()
    expect(results.finish.mock.calls[1][2]).toMatchObject({ notice: lostSessionMessage })
    expect(documents.get(tab.id)?.sessionNotice).toBeUndefined()
    // A notice already waiting (a Reconnect after the backend restarted) is the one shown.
    documents.update(tab.id, { sessionNotice: 'restarted' })
    queryApi.querySessionState.mockResolvedValueOnce({ ok: false, error: 'lost', code: 'SESSION_LOST' })
    await queries.transactionState(tab.id)
    expect(documents.get(tab.id)?.sessionNotice).toBe('restarted')
  })
  it('stops waiting for a cancelled query that does not stop, so its session still closes', async () => {
    const waited: number[] = []
    const { queries, queryApi, tab } = fixture(undefined, async ms => { waited.push(ms) })
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = queries.execute()
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map([[tab.id, 'rollback']]))
    expect(waited).toEqual([cancelSettleMs])
    expect(queries.isRunning(tab.id)).toBe(true)
    pending.resolve({ ok: true, value: output({ status: 'cancelled' }) }); await run
  })
})
