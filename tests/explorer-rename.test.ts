import { afterEach, describe, expect, it, vi } from 'vitest'
import { unknownOutcomeMessage } from '../src/shared/actions/catalog'
import type { ActionExecuteResult } from '../src/shared/actions/schema'
import type { ApiResult, ExplorerChildrenResult } from '../src/shared/contracts'
import type { ExplorerChildrenParams } from '../src/shared/explorer/refs'
import { moduleRenameNote, renameMessages, stateJobText } from '../src/renderer/src/actions/ObjectActionService'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions, explorerAnswer, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

/** A connected workbench whose Tables folder lists `tables` (dbo.Orders at first), expanded down to it. */
async function setup() {
  const fixture = workbenchFixture()
  cleanups.push(fixture.dispose)
  let tables = ['Orders']
  fixture.api.explorerChildren.mockImplementation(async (params: ExplorerChildrenParams): Promise<ApiResult<ExplorerChildrenResult>> => {
    const answer = explorerAnswer(params)
    if (params.node.type !== 'folder' || params.node.folder !== 'tables') return { ok: true, value: answer }
    const nodes = tables.map(name => ({ ...answer.nodes[0], ref: { type: 'object' as const, object: { kind: 'table' as const, database: 'AppData', schema: 'dbo', name } }, label: `dbo.${name}` }))
    return { ok: true, value: { nodes, total: nodes.length, elapsedMs: 1 } }
  })
  fixture.api.push(readyBackend())
  fixture.connections.add(connectionInfo('server-a'), connectionOptions)
  const find = async (label: string) => {
    let id: number | undefined
    await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(node => node?.label === label)?.id; expect(id, label).toBeDefined() })
    return id!
  }
  for (const label of ['Databases', 'AppData', 'Tables']) fixture.explorer.expand(await find(label))
  const orders = await find('dbo.Orders')
  return { ...fixture, find, orders, setTables: (names: string[]) => { tables = names }, node: (id: number) => fixture.explorer.menuNode(id)! }
}

describe('inline Rename in Object Explorer', () => {
  it('begins only for an object whose kind and subtype offer Rename, on a live server, selecting it', async () => {
    const { explorer, orders, find } = await setup()
    expect(explorer.beginRename(await find('Tables'))).toBe(false)
    expect(explorer.beginRename(await find('server-a.example'))).toBe(false)
    expect(explorer.renaming.getSnapshot()).toBeUndefined()
    expect(explorer.beginRename(orders)).toBe(true)
    expect(explorer.renaming.getSnapshot()).toBe(orders)
    expect(explorer.getSnapshot().selected).toBe(orders)
    explorer.endRename()
    expect(explorer.renaming.getSnapshot()).toBeUndefined()
  })
  it('runs F2 and the menu\'s Rename as the same command, and not for a folder or a system database', async () => {
    const { commands, explorer, orders, node, find } = await setup()
    explorer.select(orders)
    expect(await commands.execute('explorer.rename', undefined, 'keybinding')).toBe(true)
    expect(explorer.renaming.getSnapshot()).toBe(orders)
    explorer.endRename()
    expect(commands.isEnabled('explorer.rename', { target: { kind: 'explorer', node: node(orders) } })).toBe(true)
    explorer.select(await find('Tables'))
    expect(commands.isEnabled('explorer.rename')).toBe(false)
    const master = { ...node(orders), kind: 'database' as const, subtype: 'system' as const, ref: { type: 'object' as const, object: { kind: 'database' as const, name: 'master' } } }
    expect(commands.isEnabled('explorer.rename', { target: { kind: 'explorer', node: master } })).toBe(false)
  })
  it('commits a new name: sp_rename runs, the box ends, and the folder reloads with the renamed node selected', async () => {
    const { actions, api, explorer, orders, node, setTables, find, commands } = await setup()
    explorer.beginRename(orders)
    setTables(['Orders2'])
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done' }], messages: ['Caution: Changing any part of an object name could break scripts and stored procedures.'], elapsedMs: 1 } })
    expect(await actions.commitRename(node(orders), 'Orders2')).toBe(true)
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'rename', connectionId: 'server-a', target: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }, newName: 'Orders2' })
    expect(explorer.renaming.getSnapshot()).toBeUndefined()
    const renamed = await find('dbo.Orders2')
    await vi.waitFor(() => expect(explorer.getSnapshot().selected).toBe(renamed))
    // A table keeps SQL Server's caution; it is a warning, not a failure.
    expect(commands.getSnapshot()).toEqual({ error: 'Caution: Changing any part of an object name could break scripts and stored procedures.', kind: 'warning' })
  })
  it('adds the definition note for modules, and keeps the folder selected when the new name never appears', async () => {
    const { actions, api, explorer, orders, node, commands, find } = await setup()
    const view = { ...node(orders), kind: 'view' as const, ref: { type: 'object' as const, object: { kind: 'view' as const, database: 'AppData', schema: 'dbo', name: 'Orders' } } }
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done' }], messages: ['Caution: x.'], elapsedMs: 1 } })
    await actions.commitRename(view, 'V2')
    expect(commands.getSnapshot().error).toBe('Caution: x. ' + moduleRenameNote)
    const tables = await find('Tables')
    await vi.waitFor(() => expect(explorer.getSnapshot().selected).toBe(tables))
  })
  it('cancels silently on Escape, an unchanged name or an empty one, and keeps the box for an invalid one', async () => {
    const { actions, api, explorer, orders, node, commands } = await setup()
    for (const text of ['', 'Orders']) {
      explorer.beginRename(orders)
      expect(await actions.commitRename(node(orders), text)).toBe(true)
      expect(explorer.renaming.getSnapshot()).toBeUndefined()
    }
    explorer.beginRename(orders)
    actions.cancelRename()
    expect(explorer.renaming.getSnapshot()).toBeUndefined()
    explorer.beginRename(orders)
    expect(await actions.commitRename(node(orders), 'a\u0000b')).toBe(false)
    expect(explorer.renaming.getSnapshot()).toBe(orders)
    expect(commands.getSnapshot().error).toBe('A name cannot contain U+0000.')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
  it('reports a failure in the banner, with the unknown-outcome sentence for a lost backend', async () => {
    const { actions, api, orders, node, commands } = await setup()
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'The name Taken is already in use in this schema.', retryable: false } } })
    await actions.commitRename(node(orders), 'Taken')
    expect(commands.getSnapshot().error).toBe('Rename failed for dbo.Orders: The name Taken is already in use in this schema.')
    api.executeObjectAction.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await actions.commitRename(node(orders), 'Orders3')
    expect(commands.getSnapshot().error).toBe(unknownOutcomeMessage)
  })
  it('runs one rename per node at a time, says so for a second one, and drops and cancels it when the server disconnects', async () => {
    const { actions, api, connections, orders, node, commands } = await setup()
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const first = actions.commitRename(node(orders), 'A')
    await actions.commitRename(node(orders), 'B')
    expect(api.executeObjectAction).toHaveBeenCalledTimes(1)
    expect(commands.getSnapshot().error).toBe(renameMessages.running('dbo.Orders'))
    commands.clearError()
    connections.remove('server-a')
    expect(api.cancelObjectActions).toHaveBeenCalledWith([api.executeObjectAction.mock.calls[0][0].requestId])
    pending.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await first
    expect(commands.getSnapshot().error).toBe('')
  })
  it('shows a rename blocked on a lock in the status bar, whose Stop cancels it in SQL Server; the object keeps its name', async () => {
    const { actions, api, orders, node, commands, explorer } = await setup()
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const running = actions.commitRename(node(orders), 'Orders2')
    expect(actions.getSnapshot().jobs).toEqual([{ id: expect.any(String), verb: 'rename', label: 'dbo.Orders', newName: 'Orders2', visible: false, stopping: false }])
    // Only a rename that takes a moment shows, so a quick one does not flash in the status bar.
    await vi.waitFor(() => expect(actions.getSnapshot().jobs[0]?.visible).toBe(true))
    const requestId = api.executeObjectAction.mock.calls[0][0].requestId
    actions.stopJobs([requestId])
    actions.stopJobs([requestId])
    expect(api.cancelObjectActions.mock.calls).toEqual([[[requestId]]])
    expect(actions.getSnapshot().jobs[0]).toMatchObject({ stopping: true })
    pending.resolve({ ok: true, value: { steps: [{ status: 'cancelled', message: 'Rename' }], messages: [], elapsedMs: 1, error: { code: 'CANCELLED', message: 'The action was stopped at "Rename"; SQL Server cancelled that statement.', retryable: true } } })
    expect(await running).toBe(true)
    expect(actions.getSnapshot().jobs).toEqual([])
    expect(commands.getSnapshot().error).toBe('')
    expect(explorer.getSnapshot().rows.nodes.some(item => item?.label === 'dbo.Orders')).toBe(true)
  })
  it('reports a Stop SQL Server did not confirm in time as an unknown outcome', async () => {
    const { actions, api, orders, node, commands } = await setup()
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(pending.promise)
    const running = actions.commitRename(node(orders), 'Orders2')
    actions.stopJobs([api.executeObjectAction.mock.calls[0][0].requestId])
    pending.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await running
    expect(commands.getSnapshot().error).toBe(renameMessages.stoppedUnknown)
  })
  it('shows no warning for a database rename, whose MODIFY NAME only confirms the new name', async () => {
    const { actions, api, orders, node, commands } = await setup()
    const database = { ...node(orders), kind: 'database' as const, ref: { type: 'object' as const, object: { kind: 'database' as const, name: 'AppData' } } }
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', message: 'Rename' }], messages: ["The database name 'AppData2' has been set."], elapsedMs: 1 } })
    await actions.commitRename(database, 'AppData2')
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'rename', target: { kind: 'database', name: 'AppData' }, newName: 'AppData2' })
    expect(commands.getSnapshot()).toMatchObject({ error: '' })
  })
  it('keeps the box through a refresh that keeps its node, and ends it without a request when its node leaves the tree or its server is lost', async () => {
    const fixture = await setup(), { explorer, orders, find, setTables, api } = fixture
    explorer.beginRename(orders)
    setTables(['Orders', 'Other'])
    explorer.refresh(await find('Tables'))
    await find('dbo.Other')
    expect(explorer.renaming.getSnapshot()).toBe(orders)
    setTables([])
    explorer.refresh(await find('Tables'))
    await vi.waitFor(() => expect(explorer.renaming.getSnapshot()).toBeUndefined())
    setTables(['Orders'])
    explorer.refresh(await find('Tables'))
    const again = await find('dbo.Orders')
    explorer.beginRename(again)
    api.push({ status: 'restarting', generation: 1, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 }, retryInMs: 0 })
    await vi.waitFor(() => expect(explorer.renaming.getSnapshot()).toBeUndefined())
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
})

describe('status-bar state jobs', () => {
  it('words each verb, a later step and a stop, with Stop named for the verb', () => {
    const rename = { verb: 'rename', label: 'Sales', newName: 'Sales2', stopping: false } as const
    expect(stateJobText(rename)).toEqual({ text: 'Renaming Sales to Sales2…', stop: 'Stop rename' })
    expect(stateJobText({ ...rename, step: 'Closing connections' })).toEqual({ text: 'Renaming Sales to Sales2: Closing connections…', stop: 'Stop rename' })
    expect(stateJobText({ ...rename, step: 'Closing connections', stopping: true }).text).toBe('Stopping the rename of Sales to Sales2…')
    expect(stateJobText({ verb: 'disable', label: 'app_user', stopping: false })).toEqual({ text: 'Disabling app_user…', stop: 'Stop disable' })
    expect(stateJobText({ verb: 'enable', label: 'app_user', stopping: true })).toEqual({ text: 'Stopping the enable of app_user…', stop: 'Stop enable' })
  })
  it('runs any verb as one job per node: a second action is refused, a step shows, and Stop and a disconnect reach it', async () => {
    const { actions, api, orders, node, commands, connections } = await setup()
    const pending = deferred<ApiResult<ActionExecuteResult>>()
    const run = vi.fn((_requestId: string) => pending.promise)
    const first = actions.runStateJob(node(orders), 'disable', undefined, run)
    const job = run.mock.calls[0][0]
    expect(actions.getSnapshot().jobs).toEqual([{ id: job, verb: 'disable', label: 'dbo.Orders', visible: false, stopping: false }])
    expect(await actions.runStateJob(node(orders), 'rename', 'B', run)).toBeUndefined()
    expect(commands.getSnapshot().error).toBe(renameMessages.running('dbo.Orders', 'disable'))
    expect(commands.getSnapshot().error).toBe('An action on dbo.Orders is already running. Wait for it, or stop it in the status bar.')
    actions.setJobStep(job, 'Closing connections')
    expect(actions.getSnapshot().jobs[0]).toMatchObject({ step: 'Closing connections' })
    actions.setJobStep('other', 'Ignored')
    expect(actions.getSnapshot().jobs[0]).toMatchObject({ step: 'Closing connections' })
    actions.stopJobs([job])
    expect(api.cancelObjectActions.mock.calls).toEqual([[[job]]])
    connections.remove('server-a')
    pending.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    expect(await first).toMatchObject({ dropped: true, stopped: true, result: { ok: false, code: 'CANCELLED' } })
    expect(actions.getSnapshot().jobs).toEqual([])
    expect(run).toHaveBeenCalledOnce()
  })
  it('hands back a thrown request as a value, and runs nothing for a lost server', async () => {
    const { actions, orders, node, connections } = await setup()
    const failure = new Error('IPC lost')
    expect(await actions.runStateJob(node(orders), 'enable', undefined, async () => { throw failure })).toEqual({ thrown: failure, dropped: false, stopped: false })
    expect(actions.getSnapshot().jobs).toEqual([])
    const lost = node(orders)
    connections.remove('server-a')
    const run = vi.fn()
    expect(await actions.runStateJob(lost, 'enable', undefined, run)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })
})
