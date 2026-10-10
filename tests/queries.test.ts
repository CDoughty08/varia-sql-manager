import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { newSessionMessage, QueryService, type QueryApi } from '../src/renderer/src/services/queries'
import { CommandService } from '../src/renderer/src/core/commands'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { EventBus } from '../src/renderer/src/core/events'
import { deferred, documentFixture } from './fixtures/documents'

const output = (patch: Partial<QueryResult> = {}): QueryResult => ({
  status: 'completed', resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false,
  budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-10-08T21:48:01.1234567+00:00', ...patch
})
function fixture(commandTimeout?: number) {
  const docs = documentFixture()
  const connection: ConnectionInfo = { id: 'server-a', server: 'localhost', database: 'master', serverVersion: '17', commandTimeout, generation: 1 }
  const api = {
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: output() })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } }))
  }
  const calls: string[] = []
  const results = { begin: vi.fn((tabId: string, _queryId: string) => { calls.push('begin ' + tabId) }), finish: vi.fn() }
  api.execute.mockImplementation(async () => { calls.push('execute'); return { ok: true, value: output() } })
  const queries = new QueryService(docs.documents, api, id => id === connection.id ? connection : undefined, docs.events, results, () => 1000)
  const tab = docs.documents.create('query.sql', 'SELECT 1', 'master', connection.id)
  const events: WorkbenchEvent[] = []
  docs.events.subscribe(event => { events.push(event) })
  return { ...docs, queries, queryApi: api, connection, tab, events, results, calls }
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
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: partial, error: undefined })
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
    expect(queries.getSnapshot()[tab.id]).toEqual({ summary: output(), error: undefined })
  })
})
