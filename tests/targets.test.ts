import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { connectionInfo, connectionOptions, queryOutput, workbenchFixture } from './fixtures/workbench'
import { deferred } from './fixtures/documents'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
async function fixture() {
  const value = workbenchFixture()
  cleanups.push(value.dispose)
  value.connections.add({ ...connectionInfo('server-a'), database: 'Sales' }, connectionOptions)
  value.connections.add(connectionInfo('server-b'), connectionOptions)
  const tab = value.documents.create('query.sql', 'SELECT 1', 'AppData', 'server-a')
  // A finished query leaves results, which a target change keeps (SSMS).
  value.api.execute.mockResolvedValueOnce({ ok: true, value: { ...queryOutput, database: 'AppData' } })
  await value.queries.execute()
  expect(value.queries.getSnapshot()[tab.id]?.summary).toBeDefined()
  expect(value.results.getSnapshot()[tab.id]?.status).toBe('completed')
  return { ...value, tab }
}

describe('query targets', () => {
  it('keep results when the same target is chosen again', async () => {
    const { targets, documents, queries, tab } = await fixture()
    const update = vi.spyOn(documents, 'update')
    targets.update(tab.id, { connectionId: 'server-a', database: 'AppData' })
    targets.changeDatabase(tab.id, 'AppData')
    expect(update).not.toHaveBeenCalled()
    expect(queries.getSnapshot()[tab.id]?.summary).toBeDefined()
  })
  it('keep results when the database changes', async () => {
    const { targets, documents, queries, results, tab } = await fixture()
    targets.changeDatabase(tab.id, 'master')
    expect(documents.get(tab.id)).toMatchObject({ connectionId: 'server-a', database: 'master' })
    expect(queries.getSnapshot()[tab.id]?.summary).toBeDefined()
    expect(results.getSnapshot()[tab.id]?.status).toBe('completed')
  })
  it('keep a running query\'s state when its target changes', async () => {
    const { targets, queries, tab, startQuery } = await fixture()
    const running = startQuery()
    targets.update(tab.id, { database: 'master' })
    expect(queries.isRunning(tab.id)).toBe(true)
    await running.finish()
  })
  it('end the session before moving a query to another server, under the document lock, keeping its results', async () => {
    const { targets, documents, api, queries, results, tab } = await fixture()
    const closing = deferred<ApiResult<{ closed: boolean }>>()
    api.closeQuerySession.mockReturnValueOnce(closing.promise)
    const change = targets.changeConnection(tab.id, 'server-b')
    expect(api.closeQuerySession).toHaveBeenCalledWith(tab.id)
    expect(documents.getSnapshot().busy).toBe(true)
    expect(documents.get(tab.id)?.connectionId).toBe('server-a')
    // A second change while the first is pending is ignored.
    await targets.changeConnection(tab.id, 'server-b')
    expect(api.closeQuerySession).toHaveBeenCalledOnce()
    closing.resolve({ ok: true, value: { closed: true } })
    await change
    expect(documents.get(tab.id)).toMatchObject({ connectionId: 'server-b', database: 'master' })
    expect(documents.getSnapshot().busy).toBe(false)
    expect(queries.getSnapshot()[tab.id]?.summary).toBeDefined()
    expect(results.getSnapshot()[tab.id]?.status).toBe('completed')
  })
  it('keep the session, database, and results when the current server is chosen again', async () => {
    const { targets, documents, api, queries, tab } = await fixture()
    await targets.changeConnection(tab.id, 'server-a')
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(documents.get(tab.id)).toMatchObject({ connectionId: 'server-a', database: 'AppData' })
    expect(queries.getSnapshot()[tab.id]?.summary).toBeDefined()
    await targets.changeConnection(tab.id, undefined)
    api.closeQuerySession.mockClear()
    await targets.changeConnection(tab.id, undefined)
    await targets.changeConnection(tab.id, 'gone')
    expect(api.closeQuerySession).not.toHaveBeenCalled()
  })
  it('keep the database when a query is disconnected, and use the server\'s default when it moves', async () => {
    const { targets, documents, tab } = await fixture()
    await targets.changeConnection(tab.id, undefined)
    expect(documents.get(tab.id)).toMatchObject({ connectionId: undefined, database: 'AppData' })
    await targets.changeConnection(tab.id, 'server-a')
    expect(documents.get(tab.id)).toMatchObject({ connectionId: 'server-a', database: 'Sales' })
  })
  it('report a failed session close in the file banner and leave the target alone', async () => {
    const { targets, documents, files, api, tab } = await fixture()
    files.reportError('Earlier failure.')
    api.closeQuerySession.mockResolvedValueOnce({ ok: false, error: 'The session could not be closed.' })
    const clear = vi.spyOn(files, 'clearError')
    await targets.changeConnection(tab.id, 'server-b')
    expect(clear).toHaveBeenCalled()
    expect(files.getSnapshot().error).toBe('The session could not be closed.')
    expect(documents.get(tab.id)?.connectionId).toBe('server-a')
    expect(documents.getSnapshot().busy).toBe(false)
  })
  it('ignore unknown tabs and run document tasks only when the lock is free', async () => {
    const { targets, documents, api } = await fixture()
    await targets.changeConnection('missing', 'server-b')
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    const hold = deferred<void>(), task = documents.runTask(() => hold.promise)
    const action = vi.fn<() => Promise<void>>(async () => {})
    await targets.runDocumentTask(action)
    expect(action).not.toHaveBeenCalled()
    hold.resolve(); await task
    await targets.runDocumentTask(action)
    expect(action).toHaveBeenCalledOnce()
  })
})
