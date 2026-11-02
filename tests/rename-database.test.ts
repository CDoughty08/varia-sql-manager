import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionDescribeResult, ActionExecuteResult, RenameDatabaseFacts } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import { databaseRenameHooks, ownTabReads } from '../src/renderer/src/actions/database-rename'
import { renameMessages } from '../src/renderer/src/actions/ObjectActionService'
import { databaseModel } from './fixtures/database-properties'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions, explorerAnswer, queryOutput, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const identity = { id: 7, created: '2026-01-02T03:04:05.000' }
const facts = (patch: Partial<RenameDatabaseFacts> = {}): ApiResult<ActionDescribeResult> =>
  ({ ok: true, value: { renameDatabase: { name: 'AppData', identity, userAccess: 0, sessions: 0, withTransaction: 0, loginsDefaulting: 0, canClose: true, connections: ['server-a'], ...patch }, elapsedMs: 1 } })
const done = (...titles: string[]): ApiResult<ActionExecuteResult> => ({ ok: true, value: { steps: titles.map(title => ({ status: 'done' as const, title })), messages: [], elapsedMs: 1 } })

/**
 * A workbench connected to server-a twice (two connections to one server) and to server-b, with Object Explorer expanded to
 * AppData, and query windows: two in AppData on server-a (one per connection, each with a session), one in AppData that never
 * ran, one in AppData on server-b, and one in master on server-a.
 */
async function setup() {
  const fixture = workbenchFixture()
  cleanups.push(fixture.dispose)
  fixture.api.push(readyBackend())
  fixture.connections.add(connectionInfo('server-a'), connectionOptions)
  fixture.connections.add({ ...connectionInfo('server-a2'), server: 'SERVER-A.example ' }, connectionOptions)
  fixture.connections.add(connectionInfo('server-b'), connectionOptions)
  const find = async (label: string, connectionId = 'server-a') => {
    let id: number | undefined
    await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(node => node?.label === label && node.connectionId === connectionId)?.id; expect(id, label).toBeDefined() })
    return id!
  }
  fixture.explorer.expand(await find('Databases'))
  const appData = await find('AppData')
  const run = async (name: string, connectionId: string, database: string) => {
    const tab = fixture.documents.create(name, 'SELECT 1', database, connectionId)
    fixture.api.execute.mockResolvedValueOnce({ ok: true, value: { ...queryOutput, database, spid: 60 } })
    await fixture.queries.execute(tab.id)
    return tab
  }
  const tabs = {
    first: await run('first.sql', 'server-a', 'AppData'), second: await run('second.sql', 'server-a2', 'AppData'), idle: fixture.documents.create('idle.sql', '', 'AppData', 'server-a'),
    other: await run('other.sql', 'server-b', 'AppData'), master: await run('master.sql', 'server-a', 'master')
  }
  const node = () => fixture.explorer.menuNode(appData)!
  return { ...fixture, appData, node, tabs, run, find }
}

describe('Rename of a database (D3c)', () => {
  it('reads the database first and, with no other session, renames it at once; the query windows on that server follow the new name', async () => {
    const { actions, api, node, tabs, documents, commands } = await setup()
    api.describeObject.mockResolvedValueOnce(facts())
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    expect(await actions.commitRename(node(), 'Sales')).toBe(true)
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ connectionId: 'server-a', dialog: 'renameDatabase', target: { kind: 'database', name: 'AppData' } })
    expect(api.confirmAction).not.toHaveBeenCalled()
    expect(api.executeObjectAction.mock.calls[0][0]).toEqual({ action: 'rename', connectionId: 'server-a', requestId: expect.any(String), target: { kind: 'database', name: 'AppData' }, newName: 'Sales', closeConnections: false, identity })
    expect(commands.getSnapshot().error).toBe('')
    // Every connection to the server, whatever its spelling, and a window that never ran; not another server's, nor another database's.
    expect([tabs.first, tabs.second, tabs.idle, tabs.other, tabs.master].map(tab => documents.get(tab.id)?.database)).toEqual(['Sales', 'Sales', 'Sales', 'AppData', 'master'])
  })
  it('asks before closing other connections, naming its own windows with open transactions, and closes them on Close Connections and Rename', async () => {
    const { actions, api, node, sessionStates, tabs } = await setup()
    sessionStates.set(tabs.first.id, 2)
    sessionStates.set(tabs.second.id, 'unchecked')
    sessionStates.set(tabs.other.id, 1)
    api.describeObject.mockResolvedValueOnce(facts({ sessions: 3, withTransaction: 2 }))
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'closeAndRename' })
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const running = actions.commitRename(node(), 'Sales')
    await vi.waitFor(() => expect(api.executeObjectAction).toHaveBeenCalled())
    // Two windows hold a session in it (the one that never ran holds none), and both may have a transaction; another server's does not count.
    expect(api.confirmAction.mock.calls[0][0]).toEqual({ prompt: 'renameDatabase', facts: { database: 'AppData', sessions: 3, transactions: 2, tabs: 2, tabsWithTransactions: ['first.sql', 'second.sql'], canClose: true } })
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ closeConnections: true, identity })
    // The status bar says the job is closing connections.
    expect(actions.getSnapshot().jobs).toEqual([expect.objectContaining({ label: 'AppData', newName: 'Sales', step: renameMessages.closing })])
    pending.resolve(done('Close existing connections', 'Rename', 'Restore multi-user access'))
    await running
    expect(actions.getSnapshot().jobs).toEqual([])
  })
  it('asks when the sessions could not be counted, and waits for them on Rename When Free', async () => {
    const { actions, api, node } = await setup()
    api.describeObject.mockResolvedValueOnce(facts({ sessions: undefined, withTransaction: undefined, canClose: false }))
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'renameWhenFree' })
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    await actions.commitRename(node(), 'Sales')
    expect(api.confirmAction.mock.calls[0][0].facts).toEqual({ database: 'AppData', tabs: 2, tabsWithTransactions: [], canClose: false })
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ closeConnections: false, identity })
    expect(actions.getSnapshot().jobs).toEqual([])
  })
  it('names the wait in the status bar while Rename When Free waits for the other connections, which can last until Stop', async () => {
    const { actions, api, node } = await setup()
    api.describeObject.mockResolvedValueOnce(facts({ sessions: 2, withTransaction: 0 }))
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'renameWhenFree' })
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const running = actions.commitRename(node(), 'Sales')
    await vi.waitFor(() => expect(api.executeObjectAction).toHaveBeenCalled())
    expect(actions.getSnapshot().jobs).toEqual([expect.objectContaining({ label: 'AppData', newName: 'Sales', step: renameMessages.waiting })])
    expect(renameMessages.waiting).toBe('Waiting for connections to close')
    pending.resolve(done('Rename'))
    await running
    expect(actions.getSnapshot().jobs).toEqual([])
  })
  it('sends nothing on Cancel, or when the describe refuses or fails, which it reports', async () => {
    const { actions, api, node, commands, tabs, documents } = await setup()
    api.describeObject.mockResolvedValueOnce(facts({ sessions: 1 }))
    await actions.commitRename(node(), 'Sales')
    expect(api.confirmAction).toHaveBeenCalledTimes(1)
    expect(commands.getSnapshot().error).toBe('')
    api.describeObject.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: 'The database must be online to be renamed.', retryable: false } } })
    await actions.commitRename(node(), 'Sales')
    expect(commands.getSnapshot().error).toBe('Rename failed for AppData: The database must be online to be renamed.')
    api.describeObject.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await actions.commitRename(node(), 'Sales')
    expect(commands.getSnapshot().error).toBe('Rename failed for AppData: The SQL backend stopped.')
    api.describeObject.mockResolvedValueOnce(facts({ sessions: 1 }))
    api.confirmAction.mockResolvedValueOnce({ ok: false, error: 'Invalid confirmation.' })
    await actions.commitRename(node(), 'Sales')
    expect(commands.getSnapshot().error).toBe('Rename failed for AppData: Invalid confirmation.')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(documents.get(tabs.first.id)?.database).toBe('AppData')
  })
  it('refuses a second rename of the database while the first reads its facts or asks', async () => {
    const { actions, api, node, commands } = await setup()
    const asked = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(asked.promise)
    const first = actions.commitRename(node(), 'Sales')
    await actions.commitRename(node(), 'Other')
    expect(commands.getSnapshot().error).toBe(renameMessages.running('AppData'))
    expect(api.describeObject).toHaveBeenCalledTimes(1)
    asked.resolve(facts())
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    await first
    expect(api.executeObjectAction.mock.calls.map(call => (call[0] as { newName?: string }).newName)).toEqual(['Sales'])
  })
  it('shows the rename in the status bar with Stop from Enter: Stop cancels the describe, and a second rename meanwhile is refused as running', async () => {
    const { actions, api, node, commands } = await setup()
    const asked = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(asked.promise)
    const first = actions.commitRename(node(), 'Sales')
    await vi.waitFor(() => expect(actions.getSnapshot().jobs).toEqual([expect.objectContaining({ label: 'AppData', newName: 'Sales', step: renameMessages.reading, visible: true, stopping: false })]))
    // The describe goes out under the job's request id, which the status bar's Stop cancels.
    const { requestId } = api.describeObject.mock.calls[0][0]
    expect(actions.getSnapshot().jobs[0].id).toBe(requestId)
    await actions.commitRename(node(), 'Other')
    expect(commands.getSnapshot().error).toBe(renameMessages.running('AppData'))
    commands.clearError()
    actions.stopJobs([requestId])
    expect(api.cancelObjectActions).toHaveBeenCalledWith([requestId])
    asked.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await first
    // Stopped before anything ran: nothing more is sent, and nothing is reported.
    expect(api.confirmAction).not.toHaveBeenCalled()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(commands.getSnapshot().error).toBe('')
    expect(actions.getSnapshot().jobs).toEqual([])
  })
  it('sends nothing when Stop came while the prompt asked', async () => {
    const { actions, api, node, commands } = await setup()
    api.describeObject.mockResolvedValueOnce(facts({ sessions: 1 }))
    const answer = deferred<Awaited<ReturnType<typeof api.confirmAction>>>()
    api.confirmAction.mockReturnValueOnce(answer.promise)
    const running = actions.commitRename(node(), 'Sales')
    await vi.waitFor(() => expect(api.confirmAction).toHaveBeenCalled())
    actions.stopJobs([actions.getSnapshot().jobs[0]!.id])
    answer.resolve({ ok: true, value: 'closeAndRename' })
    await running
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(commands.getSnapshot().error).toBe('')
    expect(actions.getSnapshot().jobs).toEqual([])
  })
  it('counts and moves the windows of a connection to the same server under another name, as the describe names it', async () => {
    const { actions, api, node, connections, run, sessionStates, documents, tabs, find, explorer, properties } = await setup()
    connections.add({ ...connectionInfo('alias'), server: '.' }, connectionOptions)
    const alias = await run('alias.sql', 'alias', 'AppData')
    explorer.expand(await find('Databases', 'alias'))
    const sheet = properties.open(explorer.menuNode(await find('AppData', 'alias'))!)
    await vi.waitFor(() => expect(properties.get(sheet)?.phase).not.toBe('loading'))
    sessionStates.set(alias.id, 1)
    api.describeObject.mockResolvedValueOnce(facts({ sessions: 1, withTransaction: 1, connections: ['server-a', 'server-a2', 'alias'] }))
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'closeAndRename' })
    api.executeObjectAction.mockResolvedValueOnce(done('Close existing connections', 'Rename', 'Restore multi-user access'))
    await actions.commitRename(node(), 'Sales')
    // Its window holds the open transaction that closing rolls back, so the prompt names it, and it follows the new name.
    expect(api.confirmAction.mock.calls[0][0].facts).toMatchObject({ tabs: 3, tabsWithTransactions: ['alias.sql'] })
    expect([alias, tabs.first, tabs.other].map(tab => documents.get(tab.id)?.database)).toEqual(['Sales', 'Sales', 'AppData'])
    expect(documents.get(sheet)).toMatchObject({ name: 'Database Properties - Sales', database: 'Sales' })
  })
  it('says why Rename is unavailable for a database whose state greys it', async () => {
    const { actions, node, commands, api } = await setup()
    const at = (database: { state: number; readOnly?: boolean; standby?: boolean }) => ({ ...node(), database: { userAccess: 0, readOnly: false, standby: false, ...database } })
    expect(actions.canRun('rename', at({ state: 6 }))).toBe(false)
    // F2 reaches the greyed Rename: the banner says why, and nothing is read or renamed.
    await expect(commands.execute('explorer.rename', { target: { kind: 'explorer', node: at({ state: 6 }) } }, 'keybinding')).resolves.toBe(false)
    // A notice, not a failure: nothing failed.
    expect(commands.getSnapshot()).toEqual({ error: 'Rename is unavailable: the database must be online to be renamed.', kind: 'warning' })
    expect(api.describeObject).not.toHaveBeenCalled()
    expect(actions.unavailable('rename', at({ state: 6 }))).toBe('Rename is unavailable: the database must be online to be renamed.')
    expect(actions.unavailable('rename', at({ state: 0, readOnly: true }))).toBe('Rename is unavailable: a read-only database cannot be renamed.')
    expect(actions.unavailable('rename', at({ state: 0, standby: true }))).toBe('Rename is unavailable: a read-only database cannot be renamed.')
    expect(actions.unavailable('bringOnline', at({ state: 0 }))).toBe('Bring Online is unavailable: the database is online.')
    expect(actions.unavailable('rename', at({ state: 0 }))).toBeUndefined()
    expect(actions.unavailable('rename', node())).toBeUndefined()
  })
  it('names the logins whose default database it was in a toast', async () => {
    const { actions, api, node, notifications } = await setup()
    api.describeObject.mockResolvedValueOnce(facts({ loginsDefaulting: 2 }))
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    await actions.commitRename(node(), 'Sales')
    expect(notifications.getSnapshot().visible).toEqual([expect.objectContaining({ severity: 'warning', message: renameMessages.loginsDefaulting(2, 'AppData') })])
    expect(renameMessages.loginsDefaulting(2, 'AppData')).toBe('2 logins have AppData as their default database, which no longer exists under that name. They cannot connect without naming a database until their defaults are changed.')
    expect(renameMessages.loginsDefaulting(1, 'AppData')).toBe('1 login has AppData as its default database, which no longer exists under that name. It cannot connect without naming a database until its default is changed.')
  })
  it('follows a rename that completed before a later step failed, and reports that step; a failed or stopped rename keeps the old name', async () => {
    const { actions, api, node, commands, tabs, documents } = await setup()
    const failure = (steps: ActionExecuteResult['steps'], code: 'SQL_ERROR' | 'CANCELLED', message: string): ApiResult<ActionExecuteResult> =>
      ({ ok: true, value: { steps, messages: [], elapsedMs: 1, error: { code, message, retryable: true } } })
    // MODIFY NAME failed (1801) and the access came back on the old name.
    api.describeObject.mockResolvedValue(facts({ sessions: 1 }))
    api.confirmAction.mockResolvedValue({ ok: true, value: 'closeAndRename' })
    api.executeObjectAction.mockResolvedValueOnce(failure([{ status: 'done', title: 'Close existing connections' }, { status: 'failed', title: 'Rename' }, { status: 'skipped', title: 'Restore multi-user access' },
      { status: 'done', title: 'Restore multi-user access', compensates: true }], 'SQL_ERROR', 'Database \'Sales\' already exists. Then "Restore multi-user access" completed.'))
    await actions.commitRename(node(), 'Sales')
    expect(commands.getSnapshot().error).toBe('Rename failed for AppData: Database \'Sales\' already exists. Then "Restore multi-user access" completed.')
    expect(documents.get(tabs.first.id)?.database).toBe('AppData')
    // Stopped during MODIFY NAME: the steps say SINGLE_USER was undone.
    commands.clearError()
    api.executeObjectAction.mockResolvedValueOnce(failure([{ status: 'done', title: 'Close existing connections' }, { status: 'cancelled', title: 'Rename' }, { status: 'skipped', title: 'Restore multi-user access' },
      { status: 'done', title: 'Restore multi-user access', compensates: true }], 'CANCELLED', 'The action was stopped at "Rename". Then "Restore multi-user access" completed.'))
    await actions.commitRename(node(), 'Sales')
    expect(commands.getSnapshot().error).toBe('Rename failed for AppData: The action was stopped at "Rename". Then "Restore multi-user access" completed.')
    expect(documents.get(tabs.first.id)?.database).toBe('AppData')
    // Renamed, but the access could not be restored: the windows follow, and the error says the rename happened.
    commands.clearError()
    api.executeObjectAction.mockResolvedValueOnce(failure([{ status: 'done', title: 'Close existing connections' }, { status: 'done', title: 'Rename' }, { status: 'failed', title: 'Restore multi-user access' },
      { status: 'failed', title: 'Restore multi-user access', compensates: true }], 'SQL_ERROR', 'Failed. Then "Restore multi-user access" failed.'))
    await actions.commitRename(node(), 'Sales')
    expect(commands.getSnapshot().error).toBe('AppData was renamed to Sales, but: Failed. Then "Restore multi-user access" failed.')
    expect(documents.get(tabs.first.id)?.database).toBe('Sales')
  })
  it('retitles a Database Properties document on that server, which Properties on the renamed database then finds', async () => {
    const { actions, api, node, properties, documents } = await setup()
    const id = properties.open(node())
    await vi.waitFor(() => expect(properties.get(id)?.phase).not.toBe('loading'))
    expect(documents.get(id)?.name).toBe('Database Properties - AppData')
    api.describeObject.mockResolvedValueOnce(facts())
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    await actions.commitRename(node(), 'Sales')
    expect(documents.get(id)).toMatchObject({ name: 'Database Properties - Sales', database: 'Sales' })
    expect(properties.get(id)).toMatchObject({ target: { kind: 'database', name: 'Sales' }, label: 'Sales' })
    // A clean document reads the database again, under its new name.
    await vi.waitFor(() => expect(api.describeObject.mock.calls.at(-1)?.[0]).toMatchObject({ dialog: 'databaseProperties', target: { name: 'Sales' } }))
  })
  it('gives a Database Properties document with unsaved changes the identity the rename read, so Apply sends its changes to the renamed database', async () => {
    const { actions, api, node, properties } = await setup()
    // MODIFY NAME gives the database a new create_date (sys.databases: "created or renamed"); the reply reads it under the new name.
    const renamed = { id: 7, created: '2026-11-02T14:03:12.077' }
    api.describeObject.mockImplementation(async params => params.dialog === 'databaseProperties'
      ? { ok: true, value: { databaseProperties: databaseModel({ general: { ...databaseModel().general, name: params.target.name ?? '', id: identity.id, created: identity.created } }), elapsedMs: 1 } }
      : facts())
    const id = properties.open(node())
    await vi.waitFor(() => expect(properties.get(id)?.phase).toBe('ready'))
    properties.updateDraft(id, { owner: 'AppUser' })
    expect(properties.get(id)?.changed).toBe(true)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Rename' }], messages: [], elapsedMs: 1, identity: renamed } })
    await actions.commitRename(node(), 'Sales')
    expect(properties.get(id)).toMatchObject({ changed: true, draft: { owner: 'AppUser' }, target: { name: 'Sales' }, model: { general: { name: 'Sales', id: 7, created: renamed.created } } })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Change the owner' }], messages: [], elapsedMs: 1 } })
    expect(await properties.apply(id)).toBe(true)
    expect(api.executeObjectAction.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'properties', target: { kind: 'database', name: 'Sales' }, changes: { owner: 'AppUser' }, identity: renamed })
  })
  it('keeps the identity a document read when the rename reply names another database or none', async () => {
    const { actions, api, node, properties } = await setup()
    api.describeObject.mockImplementation(async params => params.dialog === 'databaseProperties'
      ? { ok: true, value: { databaseProperties: databaseModel({ general: { ...databaseModel().general, name: params.target.name ?? '', id: identity.id, created: identity.created } }), elapsedMs: 1 } }
      : facts())
    const id = properties.open(node())
    await vi.waitFor(() => expect(properties.get(id)?.phase).toBe('ready'))
    properties.updateDraft(id, { owner: 'AppUser' })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Rename' }], messages: [], elapsedMs: 1, identity: { id: 8, created: '2026-11-02T14:03:12.077' } } })
    await actions.commitRename(node(), 'Sales')
    expect(properties.get(id)?.model?.general).toMatchObject({ name: 'Sales', id: 7, created: identity.created })
  })
  it('moves the home database of the connections opened in it, so New Query on the server opens in the new name', async () => {
    const { actions, api, node, connections, commands, documents, explorer } = await setup()
    connections.add({ ...connectionInfo('home'), server: 'server-a.example', database: 'appdata' }, { ...connectionOptions, database: 'appdata' })
    connections.add({ ...connectionInfo('elsewhere'), database: 'AppData' }, connectionOptions)
    api.describeObject.mockResolvedValueOnce(facts())
    api.executeObjectAction.mockResolvedValueOnce(done('Rename'))
    await actions.commitRename(node(), 'Sales')
    // Another server's AppData is another database; the saved options keep what the user connected with.
    expect(['home', 'elsewhere', 'server-a'].map(id => connections.get(id)?.database)).toEqual(['Sales', 'AppData', 'master'])
    expect(connections.get('home')?.options.database).toBe('appdata')
    let server: number | undefined
    await vi.waitFor(() => { server = explorer.getSnapshot().rows.nodes.find(row => row?.connectionId === 'home' && row.ref.type === 'object' && row.ref.object.kind === 'server')?.id; expect(server).toBeDefined() })
    await expect(commands.execute('explorer.newQuery', { target: { kind: 'explorer', node: explorer.menuNode(server!)! } }, 'menu')).resolves.toBe(true)
    expect(documents.active).toMatchObject({ connectionId: 'home', database: 'Sales' })
  })
})

describe('a greyed database action in the palette', () => {
  it('shows the reason F2 gives on the greyed row', async () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    // AppData is offline.
    fixture.api.explorerChildren.mockImplementation(async params => {
      const answer = explorerAnswer(params)
      return { ok: true, value: { ...answer, nodes: answer.nodes.map(item => item.ref.type === 'object' && item.ref.object.kind === 'database'
        ? { ...item, sublabel: '(Offline)', status: 'unavailable' as const, hasChildren: false, database: { state: 6, userAccess: 0, readOnly: false, standby: false } } : item) } }
    })
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const find = async (label: string) => {
      let id: number | undefined
      await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(item => item?.label === label)?.id; expect(id, label).toBeDefined() })
      return id!
    }
    fixture.explorer.expand(await find('Databases'))
    fixture.explorer.select(await find('AppData'))
    await fixture.commands.execute('workbench.showCommands', undefined, 'keybinding')
    const row = (id: string) => fixture.quickInput.getSnapshot().rows.find(entry => entry.item.id === id)?.item
    expect(row('explorer.rename')).toMatchObject({ disabled: true, disabledHint: 'Rename is unavailable: the database must be online to be renamed.' })
    expect(row('explorer.takeOffline')).toMatchObject({ disabled: true, disabledHint: 'Take Offline is unavailable: the database is offline.' })
    expect(row('explorer.bringOnline')).toMatchObject({ label: expect.stringContaining('Bring') })
    expect(row('explorer.bringOnline')?.disabled).toBeUndefined()
  })
})

describe('database rename hooks', () => {
  it('reads the open transaction of at most ownTabReads windows, counting the rest', async () => {
    const documents = Array.from({ length: ownTabReads + 4 }, (_, index) => ({ id: `t${index}`, name: `q${index}.sql`, kind: 'sql', connectionId: 'a', database: 'AppData' }))
    const transactionState = vi.fn(async () => ({ transactions: 1 }))
    const hooks = databaseRenameHooks({
      documents: { getSnapshot: () => ({ documents }) } as never, queries: { getSnapshot: () => Object.fromEntries(documents.map(item => [item.id, { session: { connectionId: 'a', spid: 1 } }])), transactionState } as never,
      connections: { getSnapshot: () => [{ id: 'a', server: 's' }], subscribe: () => () => {} } as never, targets: { changeDatabase: vi.fn() }, properties: { databaseRenamed: vi.fn() }
    })
    const tabs = await hooks.tabs('a', 'AppData')
    expect(tabs.count).toBe(ownTabReads + 4)
    expect(tabs.withTransactions).toHaveLength(ownTabReads)
    expect(transactionState).toHaveBeenCalledTimes(ownTabReads)
  })
})
