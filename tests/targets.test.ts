import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { connectionInfo, connectionOptions, queryOutput, workbenchFixture } from './fixtures/workbench'
import { deferred, documentFixture } from './fixtures/documents'
import { TargetService } from '../src/renderer/src/services/targets'
import type { QueryService } from '../src/renderer/src/services/queries'

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
  it('never give a value opened from the results a server or a database', async () => {
    const { targets, documents, api } = await fixture()
    const value = documents.openText({ name: 'doc1.xml', text: '<a/>', kind: 'xml' })
    targets.update(value.id, { connectionId: 'server-a', database: 'AppData' })
    await targets.changeConnection(value.id, 'server-b')
    targets.changeDatabase(value.id, 'master')
    expect(documents.get(value.id)).toMatchObject({ database: '' })
    expect(documents.get(value.id)?.connectionId).toBeUndefined()
    expect(api.closeQuerySession).not.toHaveBeenCalled()
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
    await vi.waitFor(() => expect(api.closeQuerySession).toHaveBeenCalledWith(tab.id))
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
  it('drop a notice about the old session when a query moves or disconnects, but keep it when only the database changes', async () => {
    const { targets, documents, tab } = await fixture()
    documents.update(tab.id, { sessionNotice: 'lost' })
    targets.changeDatabase(tab.id, 'master')
    expect(documents.get(tab.id)?.sessionNotice).toBe('lost')
    await targets.changeConnection(tab.id, 'server-b')
    expect(documents.get(tab.id)?.sessionNotice).toBeUndefined()
    documents.update(tab.id, { sessionNotice: 'lost' })
    await targets.changeConnection(tab.id, undefined)
    expect(documents.get(tab.id)?.sessionNotice).toBeUndefined()
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
  it('ask about an open transaction before the session ends: Cancel keeps the query where it was, and Commit commits it there first', async () => {
    const { targets, documents, api, queries, files, tab, sessionStates } = await fixture()
    api.execute.mockResolvedValueOnce({ ok: true, value: { ...queryOutput, spid: 61, login: 'reader' } })
    await queries.execute()
    sessionStates.set(tab.id, 1)
    api.closeQuerySession.mockClear()
    await targets.changeConnection(tab.id, 'server-b')
    expect(api.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'changeConnection', tabs: [{ name: 'query.sql', transactions: 1, running: false }] })
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    expect(documents.get(tab.id)?.connectionId).toBe('server-a')
    // A commit that fails leaves the query on its server, with its transaction, and says why.
    api.confirmSessions.mockResolvedValue({ ok: true, value: 'commit' })
    api.closeQuerySession.mockResolvedValueOnce({ ok: false, error: 'The transaction was not committed, and the query stays open.', code: 'SQL_ERROR' })
    await targets.changeConnection(tab.id, 'server-b')
    expect(files.getSnapshot().error).toBe('The transaction was not committed, and the query stays open.')
    expect(documents.get(tab.id)?.connectionId).toBe('server-a')
    expect(await queries.transactionState(tab.id)).toEqual({ transactions: 1 })
    await targets.changeConnection(tab.id, 'server-b')
    expect(api.closeQuerySession.mock.calls).toEqual([[tab.id, { transaction: 'commit' }], [tab.id, { transaction: 'commit' }]])
    expect(documents.get(tab.id)?.connectionId).toBe('server-b')
    expect(queries.getSnapshot()[tab.id]?.session).toBeUndefined()
  })
  it('say the query disconnects when Disconnect or Change Connection to Disconnected ends its session', async () => {
    const { targets, api, tab, sessionStates } = await fixture()
    sessionStates.set(tab.id, 1)
    await targets.changeConnection(tab.id, undefined)
    expect(api.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'disconnectQuery', tabs: [{ name: 'query.sql', transactions: 1, running: false }] })
  })
  it('leave connected a query that finished with a transaction while Disconnect All Queries asked about the others', async () => {
    const { targets, documents, api, queries, tab, sessionStates } = await fixture()
    sessionStates.set(tab.id, 1)
    const busy = documents.create('busy.sql', 'BEGIN TRANSACTION; INSERT t VALUES (1)', 'master', 'server-a')
    const pending = deferred<Awaited<ReturnType<typeof api.execute>>>()
    api.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute(busy.id)
    api.closeQuerySession.mockClear()
    // The running query finishes with an open transaction while the prompt about query.sql is open.
    api.confirmSessions.mockImplementationOnce(async () => {
      pending.resolve({ ok: true, value: { ...queryOutput, spid: 62 } })
      sessionStates.set(busy.id, 1)
      await running
      return { ok: true, value: 'commit' }
    })
    await targets.disconnectAll()
    expect(api.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'disconnectAll', tabs: [{ name: 'query.sql', transactions: 1, running: false }] })
    expect(api.closeQuerySession.mock.calls).toEqual([[tab.id, { transaction: 'commit' }]])
    expect(documents.get(busy.id)?.connectionId).toBe('server-a')
    expect(api.querySessionState.mock.calls.map(([id]) => id)).toEqual([tab.id, busy.id])
  })
  it('disconnect a query that finished during Disconnect All Queries\' prompt when its session has nothing open', async () => {
    const { targets, documents, api, queries, tab, sessionStates } = await fixture()
    sessionStates.set(tab.id, 1)
    const busy = documents.create('busy.sql', 'SELECT 1', 'master', 'server-a')
    const pending = deferred<Awaited<ReturnType<typeof api.execute>>>()
    api.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute(busy.id)
    api.confirmSessions.mockImplementationOnce(async () => {
      pending.resolve({ ok: true, value: { ...queryOutput, spid: 62 } })
      sessionStates.set(busy.id, 0)
      await running
      return { ok: true, value: 'commit' }
    })
    await targets.disconnectAll()
    expect(documents.get(busy.id)?.connectionId).toBeUndefined()
  })
  it('ask once before disconnecting every query, and end each idle session as answered', async () => {
    const { targets, documents, api, tab, startQuery, sessionStates } = await fixture()
    sessionStates.set(tab.id, 2)
    const idle = documents.create('idle.sql', 'SELECT 2', 'master', 'server-b')
    const busy = documents.create('busy.sql', 'SELECT 3', 'master', 'server-a')
    const running = startQuery()
    api.closeQuerySession.mockClear()
    await targets.disconnectAll()
    // The running query is not asked about: it stays connected, as before.
    expect(api.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'disconnectAll', tabs: [{ name: 'query.sql', transactions: 2, running: false }] })
    expect(api.closeQuerySession).not.toHaveBeenCalled()
    api.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'rollback' })
    await targets.disconnectAll()
    expect(api.closeQuerySession.mock.calls).toEqual([[tab.id, { transaction: 'rollback' }], [idle.id]])
    expect(documents.getSnapshot().documents.map(document => document.connectionId)).toEqual([undefined, undefined, 'server-a'])
    expect(documents.get(busy.id)?.connectionId).toBe('server-a')
    await running.finish()
  })
})

describe('BigQuery location switch (decision 18)', () => {
  function bigQueryFixture(sessionLocation: string | undefined) {
    const docs = documentFixture()
    const queries = {
      isRunning: vi.fn(() => false), mayHaveTransaction: vi.fn(async () => false),
      confirmSessions: vi.fn<QueryService['confirmSessions']>(async () => new Map([['x', 'commit' as const]])),
      sessionEnded: vi.fn(), sessionNote: vi.fn<QueryService['sessionNote']>(), sessionLocation: vi.fn(() => sessionLocation),
      confirmLocationSwitch: vi.fn<QueryService['confirmLocationSwitch']>(async () => true)
    }
    const files = { clearError: vi.fn(), reportError: vi.fn() }
    const connection = { id: 'bq', server: 'demo', database: '', serverVersion: '', commandTimeout: 0, generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'demo', authentication: 'applicationDefault' } as { provider: 'bigquery'; project: string; authentication: string; location?: string } }
    const locations: Record<string, string> = { sales_us: 'US', sales_eu: 'EU' }
    const targets = new TargetService(docs.documents, queries, { get: () => connection as never }, files, undefined, (_id, dataset) => locations[dataset])
    const tab = docs.documents.create('q.sql', 'SELECT 1', 'sales_us', 'bq')
    queries.confirmSessions.mockImplementation(async () => new Map([[tab.id, 'commit' as const]]))
    return { ...docs, queries, files, targets, tab, connection }
  }
  it('asks before a dataset in another location ends the session, then ends it as answered and shows its note', async () => {
    const f = bigQueryFixture('US')
    f.api.closeQuerySession.mockResolvedValueOnce({ ok: true, value: { closed: true, note: { code: 'sessionExpired' } } })
    f.targets.changeDatabase(f.tab.id, 'sales_eu')
    await vi.waitFor(() => expect(f.documents.get(f.tab.id)?.database).toBe('sales_eu'))
    expect(f.queries.confirmLocationSwitch).toHaveBeenCalledExactlyOnceWith(f.tab.id, { dataset: 'sales_eu', from: 'US', to: 'EU' })
    expect(f.queries.confirmSessions).toHaveBeenCalledExactlyOnceWith('switchLocation', [f.tab.id])
    expect(f.api.closeQuerySession).toHaveBeenCalledExactlyOnceWith(f.tab.id, { transaction: 'commit' })
    expect(f.queries.sessionNote).toHaveBeenCalledExactlyOnceWith(f.tab.id, { code: 'sessionExpired' })
  })
  it("keeps the dataset and session on Don't Switch, and asks nothing in the same location or with no session", async () => {
    const f = bigQueryFixture('US')
    f.queries.confirmLocationSwitch.mockResolvedValueOnce(false)
    f.targets.changeDatabase(f.tab.id, 'sales_eu')
    await vi.waitFor(() => expect(f.queries.confirmLocationSwitch).toHaveBeenCalled())
    await vi.waitFor(() => expect(f.documents.getSnapshot().busy).toBe(false))
    expect(f.documents.get(f.tab.id)?.database).toBe('sales_us')
    expect(f.api.closeQuerySession).not.toHaveBeenCalled()
    // Locations compare without case (BigQuery names US and us alike).
    const same = bigQueryFixture('us')
    same.documents.update(same.tab.id, { database: 'other' })
    same.targets.changeDatabase(same.tab.id, 'sales_us')
    expect(same.documents.get(same.tab.id)?.database).toBe('sales_us')
    expect(same.queries.confirmLocationSwitch).not.toHaveBeenCalled()
    const none = bigQueryFixture(undefined)
    none.targets.changeDatabase(none.tab.id, 'sales_eu')
    expect(none.documents.get(none.tab.id)?.database).toBe('sales_eu')
    expect(none.queries.confirmLocationSwitch).not.toHaveBeenCalled()
  })
  it('keeps the dataset when a commit at the switch is refused', async () => {
    const f = bigQueryFixture('US')
    f.api.closeQuerySession.mockResolvedValueOnce({ ok: false, error: 'The transaction was not committed, and the query stays open.', code: 'JOB_RUNNING' })
    f.targets.changeDatabase(f.tab.id, 'sales_eu')
    await vi.waitFor(() => expect(f.files.reportError).toHaveBeenCalledWith('The transaction was not committed, and the query stays open.'))
    expect(f.documents.get(f.tab.id)?.database).toBe('sales_us')
  })
  it('asks nothing on a connection with a fixed location, whose sessions never move', () => {
    const f = bigQueryFixture('US')
    f.connection.options.location = 'US'
    f.targets.changeDatabase(f.tab.id, 'sales_eu')
    expect(f.documents.get(f.tab.id)?.database).toBe('sales_eu')
    expect(f.queries.confirmLocationSwitch).not.toHaveBeenCalled()
  })
  it('asks again when the same dataset is chosen again, as the location-mismatch advice says', async () => {
    const f = bigQueryFixture('US')
    f.documents.update(f.tab.id, { database: 'sales_eu' })
    f.targets.changeDatabase(f.tab.id, 'sales_eu')
    await vi.waitFor(() => expect(f.queries.confirmLocationSwitch).toHaveBeenCalledExactlyOnceWith(f.tab.id, { dataset: 'sales_eu', from: 'US', to: 'EU' }))
  })
  it('says the dataset was not changed while another document task runs, rather than dropping the choice', async () => {
    const f = bigQueryFixture('US')
    let finish!: () => void
    const task = f.documents.runTask(() => new Promise<void>(resolve => { finish = resolve }))
    f.targets.changeDatabase(f.tab.id, 'sales_eu')
    expect(f.files.reportError).toHaveBeenCalledExactlyOnceWith('The dataset was not changed: wait for the current task to finish, then choose sales_eu again.')
    expect(f.queries.confirmLocationSwitch).not.toHaveBeenCalled()
    finish()
    await task
    expect(f.documents.get(f.tab.id)?.database).toBe('sales_us')
  })
})
