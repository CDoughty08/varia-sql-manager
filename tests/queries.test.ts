import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { cancelSettleMs, newSessionMessage, QueryService, stateReads, type QueryApi } from '../src/renderer/src/services/queries'
import { CommandService } from '../src/renderer/src/core/commands'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { EventBus } from '../src/renderer/src/core/events'
import { deferred, documentFixture } from './fixtures/documents'

const output = (patch: Partial<QueryResult> = {}): QueryResult => ({
  status: 'completed', resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false,
  budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-10-08T21:48:01.1234567+00:00', ...patch
})
function fixture(commandTimeout?: number, wait?: (ms: number) => Promise<void>) {
  const docs = documentFixture()
  const connection: ConnectionInfo & { lost?: true } = { id: 'server-a', server: 'localhost', database: 'master', serverVersion: '17', commandTimeout, generation: 1 }
  const api = {
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: output() })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    confirmSessions: vi.fn<VariaApi['confirmSessions']>(async () => ({ ok: true, value: 'cancel' })),
    // No session until a test says otherwise, as the backend answers for a query that never ran.
    querySessionState: vi.fn<VariaApi['querySessionState']>(async () => ({ ok: false, error: 'This query has no open SQL session.', code: 'SESSION_CLOSED' }))
  }
  const calls: string[] = []
  const results = { begin: vi.fn((tabId: string, _queryId: string) => { calls.push('begin ' + tabId) }), finish: vi.fn() }
  api.execute.mockImplementation(async () => { calls.push('execute'); return { ok: true, value: output() } })
  const queries = new QueryService(docs.documents, api, id => id === connection.id ? connection : undefined, docs.events, results, () => 1000, wait)
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
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: partial, error: undefined, session: undefined })
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
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: output(), error: undefined, session: undefined })
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
    expect(most).toBe(stateReads)
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
    queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'commit' })
    const plan = await queries.confirmSessions('exit', [tab.id, other.id, idle.id, 'gone'])
    expect(queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'exit', tabs: [{ name: 'query.sql', transactions: 1, running: false }, { name: 'other.sql', transactions: 0, running: true }] })
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
