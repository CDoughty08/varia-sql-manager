import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { QueryService } from '../src/renderer/src/services/queries'
import { CommandService } from '../src/renderer/src/core/commands'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { EventBus } from '../src/renderer/src/core/events'
import { deferred, documentFixture } from './fixtures/documents'

const output = (patch: Partial<QueryResult> = {}): QueryResult => ({ status: 'completed', resultSets: [], messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false, ...patch })
function fixture(commandTimeout?: number) {
  const docs = documentFixture()
  const connection: ConnectionInfo = { id: 'server-a', server: 'localhost', database: 'master', serverVersion: '17', commandTimeout, generation: 1 }
  const api = {
    execute: vi.fn<VariaApi['execute']>(async () => ({ ok: true, value: output() })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } }))
  }
  const queries = new QueryService(docs.documents, api, id => id === connection.id ? connection : undefined, docs.events)
  const tab = docs.documents.create('query.sql', 'SELECT 1', 'master', connection.id)
  const events: WorkbenchEvent[] = []
  docs.events.subscribe(event => { events.push(event) })
  return { ...docs, queries, queryApi: api, connection, tab, events }
}
describe('query orchestration', () => {
  it.each([0, 7, undefined])('uses the document session and preserves timeout %s', async timeout => {
    const { queries, queryApi, tab } = fixture(timeout)
    await queries.execute()
    expect(queryApi.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: tab.id, sql: 'SELECT 1', startLine: 1, timeoutSeconds: timeout ?? 0 }))
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
    expect(queries.getSnapshot()[tab.id].result?.database).toBe('changed')
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
    const partial = output({ status: 'failed', messages: ['Earlier batch output'], error: { code: 'SQL_ERROR', message: 'Bad SQL', batchNumber: 2, iteration: 1 } })
    queryApi.execute.mockResolvedValueOnce({ ok: true, value: partial })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id]).toEqual({ result: partial, error: undefined })
    queryApi.execute.mockResolvedValueOnce({ ok: false, error: 'Backend unavailable' })
    await queries.execute()
    expect(queries.getSnapshot()[tab.id]).toEqual({ result: undefined, error: 'Backend unavailable' })
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
})
