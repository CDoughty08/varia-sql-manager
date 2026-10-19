import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { cancelSettleMs, newSessionMessage, QueryService, type QueryApi } from '../src/renderer/src/services/queries'
import { CommandService } from '../src/renderer/src/core/commands'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
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
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: output() })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    confirmSessions: vi.fn<VariaApi['confirmSessions']>(async () => ({ ok: true, value: 'cancel' }))
  }
  const calls: string[] = []
  const results = { begin: vi.fn((tabId: string, _queryId: string) => { calls.push('begin ' + tabId) }), finish: vi.fn() }
  api.execute.mockImplementation(async () => { calls.push('execute'); return { ok: true, value: output() } })
  const queries = new QueryService(docs.documents, api, id => id === connection.id ? connection : undefined, docs.events, results, () => 1000, wait, () => ({ ...defaultSettings, ...settings }))
  const tab = docs.documents.create('query.sql', 'SELECT 1', 'master', connection.id)
  const events: WorkbenchEvent[] = []
  docs.events.subscribe(event => { events.push(event) })
  return { ...docs, bus: docs.events, queries, queryApi: api, connection, tab, events, results, calls }
}
describe('query orchestration', () => {
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
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: partial, error: undefined, session: { connectionId: 'server-a', transactions: 0 } })
    queryApi.execute.mockResolvedValueOnce({ ok: false, error: 'Backend unavailable', code: 'BACKEND_LOST' })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: undefined, error: 'Backend unavailable' })
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
    documents.update(tab.id, { sessionNotice: true })
    await queries.execute()
    expect(results.finish.mock.calls[0][2]).toMatchObject({ notice: newSessionMessage })
    expect(documents.get(tab.id)?.sessionNotice).toBe(false)
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
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: output(), error: undefined, session: { connectionId: 'server-a', transactions: 0 } })
  })
  it('tracks the open transaction the probe reports, for the connection it ran on', async () => {
    const { queries, queryApi, tab, documents, bus, connection } = fixture()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 2, spid: 53, login: 'sa' }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', transactions: 2, spid: 53, login: 'sa' })
    expect(queries.transactions(tab.id)).toBe(2)
    // A run under way keeps it; a failure that leaves the session alone keeps it too.
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute()
    expect(queries.transactions(tab.id)).toBe(2)
    pending.resolve({ ok: false, error: 'A query is already running in this tab.', code: 'SESSION_BUSY' }); await running
    expect(queries.transactions(tab.id)).toBe(2)
    // Moving the query elsewhere, or losing its connection, leaves the session's transaction behind (SQL Server rolls it back).
    documents.update(tab.id, { connectionId: 'server-b' })
    expect(queries.transactions(tab.id)).toBe(0)
    documents.update(tab.id, { connectionId: 'server-a' })
    connection.lost = true
    expect(queries.transactions(tab.id)).toBe(0)
    delete connection.lost
    expect(queries.transactions(tab.id)).toBe(2)
    // A session that ended, or one the backend found lost, has none.
    bus.emit({ type: 'session.ended', tabId: tab.id })
    expect(queries.getSnapshot()[tab.id].session).toBeUndefined()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 1, spid: 53 }) })
    await queries.execute()
    expect(queries.transactions(tab.id)).toBe(1)
    queryApi.execute.mockResolvedValueOnce({ ok: false, error: 'The SQL session was lost.', code: 'SESSION_LOST' })
    await queries.execute()
    expect(queries.transactions(tab.id)).toBe(0)
    // A summary without a probe (the session closed during the script) has none either.
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 1 }) })
    await queries.execute()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed' }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', transactions: 0 })
  })
  it('keeps a session the probe could not read as one that may hold a transaction, and asks about it', async () => {
    const { queries, queryApi, tab } = fixture()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 2, spid: 53, login: 'sa' }) })
    await queries.execute()
    // SET SHOWPLAN_XML ON (or NOEXEC, PARSEONLY, FMTONLY, a probe timeout): the session is open, its count unknown.
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53 }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', transactions: 2, spid: 53, login: 'sa', unchecked: true })
    expect(queries.transactions(tab.id)).toBe(2)
    expect(queries.mayHaveTransaction(tab.id)).toBe(true)
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'commit' })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map([[tab.id, 'commit']]))
    expect(queryApi.confirmSessions).toHaveBeenLastCalledWith({ action: 'close', tabs: [{ name: 'query.sql', transactions: 2, running: false, unchecked: true }] })
    // A session with nothing known before it may still have begun one in the script the probe could not follow.
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 0, spid: 53, login: 'sa' }) })
    await queries.execute()
    expect(queries.mayHaveTransaction(tab.id)).toBe(false)
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 53 }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', transactions: 0, spid: 53, login: 'sa', unchecked: true })
    expect(queries.mayHaveTransaction(tab.id)).toBe(true)
    // A new session (another SPID) keeps nothing of the old one; a probe that reads again clears it.
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ spid: 70 }) })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id].session).toEqual({ connectionId: 'server-a', transactions: 0, spid: 70, unchecked: true })
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 0, spid: 70, login: 'sa' }) })
    await queries.execute()
    expect(queries.mayHaveTransaction(tab.id)).toBe(false)
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
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 1 }) })
    await queries.execute(tab.id)
    const pending = deferred<ApiResult<QueryResult>>()
    queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = queries.execute(other.id)
    // The cancel lands, and the query stops with a transaction it had opened: it is rolled back, never committed.
    queryApi.cancel.mockImplementationOnce(async () => { pending.resolve({ ok: true, value: output({ status: 'cancelled', transactionCount: 1 }) }); return { ok: true, value: { cancelled: true } } })
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'commit' })
    const plan = await queries.confirmSessions('exit', [tab.id, other.id, idle.id, 'gone'])
    expect(queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'exit', tabs: [{ name: 'query.sql', transactions: 1, running: false }, { name: 'other.sql', transactions: 0, running: true }] })
    expect(queryApi.cancel).toHaveBeenCalledOnce()
    expect(queries.isRunning(other.id)).toBe(false)
    expect(plan).toEqual(new Map([[tab.id, 'commit'], [other.id, 'rollback']]))
    await run
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'rollback' })
    expect(await queries.confirmSessions('close', [tab.id])).toEqual(new Map([[tab.id, 'rollback']]))
  })
  it('changes nothing on Cancel, and reports a prompt that failed', async () => {
    const { queries, queryApi, tab } = fixture()
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ transactionCount: 1 }) })
    await queries.execute()
    expect(await queries.confirmSessions('changeConnection', [tab.id])).toBeUndefined()
    expect(queries.transactions(tab.id)).toBe(1)
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: false, error: 'Untrusted IPC sender.' })
    await expect(queries.confirmSessions('changeConnection', [tab.id])).rejects.toThrow('Untrusted IPC sender.')
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
