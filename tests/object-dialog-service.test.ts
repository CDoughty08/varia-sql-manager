import { afterEach, describe, expect, it, vi } from 'vitest'
import { unknownOutcomeMessage } from '../src/shared/actions/catalog'
import { noScriptNotice } from '../src/shared/actions/database'
import type { ActionDescribeResult, ActionExecuteResult, ActionScriptResult, DeleteTarget } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { dialogMessages, ObjectDialogService } from '../src/renderer/src/dialogs/ObjectDialogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions, explorerAnswer, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { Platform } from '../src/shared/commands/keybindings'
import type { KeyDownEvent } from '../src/renderer/src/core/keybindings'
import { databaseModel } from './fixtures/database-properties'
import { setOption, type DatabaseDraft } from '../src/renderer/src/dialogs/database-properties'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const ordersRef: ObjectRef = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }
const databaseRef: ObjectRef = { kind: 'database', name: 'AppData' }
const node = (object: ObjectRef, id = 7): ExplorerMenuNode => ({ id, connectionId: 'server-a', ref: { type: 'object', object }, kind: object.kind, label: object.name ?? '', lost: false })
const row = (changes: Partial<DeleteTarget> = {}): ApiResult<ActionDescribeResult> => ({ ok: true, value: { deleteTarget: { name: 'dbo.Orders', type: 'Table', owner: 'dbo', warnings: [], dependentsTruncated: false, ...changes }, elapsedMs: 1 } })
const done: ApiResult<ActionExecuteResult> = { ok: true, value: { steps: [{ status: 'done' }], messages: [], elapsedMs: 1 } }

/** The service over fakes: describe answers at once unless a test holds it, and every request is recorded. */
function setup() {
  const execute = deferred<ApiResult<ActionExecuteResult>>()
  let held: Promise<ApiResult<ActionDescribeResult>> | undefined
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async () => held ?? row()),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async params => ({ ok: true, value: { text: `DROP ${params.target.name}`, database: 'AppData', warnings: [] } as ActionScriptResult })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  const explorer = { listingFolderOf: vi.fn(() => 3 as number | undefined), reconcile: vi.fn() }
  const documents = { newQuery: vi.fn() }, files = { saveCopy: vi.fn(async (name: string) => ({ id: 'f', name, path: '/x/' + name, encoding: 'utf8' as const, readOnly: false })) }
  let ids = 0
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents, files, newId: () => `id-${++ids}` })
  cleanups.push(() => dialogs.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { dialogs, api, connections, explorer, documents, execute, settle, hold: (promise: Promise<ApiResult<ActionDescribeResult>>) => { held = promise } }
}

describe('ObjectDialogService', () => {
  it('opens loading, describes the object, and is ready with SSMS\'s default options; one dialog at a time', async () => {
    const { dialogs, api, settle, hold } = setup()
    const describe = deferred<ApiResult<ActionDescribeResult>>()
    hold(describe.promise)
    dialogs.open('deleteObject', node(databaseRef))
    expect(dialogs.current).toMatchObject({ dialog: 'deleteObject', phase: 'loading', page: 'general', server: 'server-a.example', login: 'sa', label: 'AppData' })
    expect(api.describeObject.mock.calls).toEqual([[{ connectionId: 'server-a', requestId: 'id-1', dialog: 'deleteObject', target: databaseRef }]])
    expect(() => dialogs.open('deleteObject', node(ordersRef))).toThrow('Close the open dialog first.')
    describe.resolve(row({ name: 'AppData', type: 'Database', isSnapshot: false }))
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', draft: { deleteHistory: true, closeConnections: false } })
  })
  it('shows a failed describe as a value, and greys a snapshot\'s options', async () => {
    const { dialogs, api, settle } = setup()
    api.describeObject.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'dbo.Orders no longer exists. Refresh Object Explorer.', retryable: false } } })
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'loadFailed', error: { code: 'NOT_FOUND' } })
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
    api.describeObject.mockResolvedValueOnce(row({ isSnapshot: true }))
    dialogs.open('deleteObject', node(databaseRef))
    await settle()
    expect(dialogs.current?.draft).toEqual({ deleteHistory: false, closeConnections: false })
  })
  it('scripts the action to each destination through Script As\'s delivery and stays open', async () => {
    const { dialogs, api, documents, settle } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    await dialogs.script('newQuery')
    expect(api.scriptObjectAction.mock.calls[0][0]).toEqual({ action: 'delete', target: ordersRef, closeConnections: false, deleteHistory: false, connectionId: 'server-a', requestId: 'id-2' })
    expect(documents.newQuery.mock.calls).toEqual([['DROP Orders', undefined, 'server-a', 'AppData', false]])
    await dialogs.script('clipboard')
    expect(api.writeClipboardText.mock.calls).toEqual([['DROP Orders']])
    expect(dialogs.current).toMatchObject({ phase: 'ready', notice: 'Script copied to the clipboard.' })
    await dialogs.script('file')
    expect(dialogs.current).toMatchObject({ phase: 'ready', notice: 'Saved dbo.Orders.sql.' })
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
  it('runs OK, closes on success and reloads the listing folder', async () => {
    const { dialogs, api, explorer, execute, settle } = setup()
    dialogs.open('deleteObject', node(databaseRef, 12))
    await settle()
    dialogs.updateDraft({ closeConnections: true })
    const ok = dialogs.ok()
    expect(dialogs.current?.phase).toBe('executing')
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'delete', target: databaseRef, closeConnections: true, deleteHistory: true })
    expect(dialogs.close()).toBe(false)
    execute.resolve(done)
    await ok
    expect(dialogs.current).toBeUndefined()
    expect(explorer.listingFolderOf).toHaveBeenCalledWith(12)
    expect(explorer.reconcile.mock.calls).toEqual([[3]])
  })
  it('keeps DEPENDENTS and partial failures open with the steps, and a later OK can retry', async () => {
    const { dialogs, api, settle, execute } = setup()
    dialogs.open('deleteObject', node(databaseRef))
    await settle()
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', message: 'Delete backup and restore history' }, { status: 'failed', message: 'Cannot drop database "AppData" because it is currently in use.' }],
      messages: [], elapsedMs: 1, error: { code: 'IN_USE', message: 'Cannot drop database "AppData" because it is currently in use. Completed before the failure: Delete backup and restore history.', retryable: true } } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'IN_USE' }, steps: [{ status: 'done' }, { status: 'failed' }] })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'failed', message: 'Could not drop object' }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: 'Could not drop object', retryable: false } } })
    await dialogs.ok()
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'DEPENDENTS' } })
  })
  it('stops a running action through cancelObjectActions and reports Stopped', async () => {
    const { dialogs, api, settle, execute } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    const ok = dialogs.ok()
    dialogs.stop()
    expect(api.cancelObjectActions.mock.calls).toEqual([[['id-2']]])
    execute.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'stopped', error: { message: dialogMessages.stopped } })
    expect(dialogs.close()).toBe(true)
  })
  it('reports a Stop SQL Server confirmed with the steps that completed, and reloads the listing they changed', async () => {
    const { dialogs, api, settle, execute, explorer } = setup()
    dialogs.open('deleteObject', node(databaseRef))
    await settle()
    const ok = dialogs.ok()
    dialogs.stop()
    expect(api.cancelObjectActions).toHaveBeenCalledTimes(1)
    const stopped = { code: 'CANCELLED' as const, message: 'The action was stopped at "Delete backup and restore history"; SQL Server cancelled that statement. Completed before Stop: Close existing connections, Drop the database.', retryable: true }
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', message: 'Close existing connections' }, { status: 'done', message: 'Drop the database' }, { status: 'cancelled', message: 'Delete backup and restore history' }], messages: [], elapsedMs: 1, error: stopped } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'stopped', error: stopped, steps: [{ status: 'done' }, { status: 'done' }, { status: 'cancelled' }] })
    expect(explorer.reconcile).toHaveBeenCalledTimes(1)
    expect(dialogs.close()).toBe(true)
  })
  it('turns a lost backend into the unknown-outcome sentence, and a disconnect into Close only', async () => {
    const { dialogs, connections, settle, execute, api } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    const ok = dialogs.ok()
    execute.resolve({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { message: unknownOutcomeMessage } })
    // Disconnecting while it runs: the request is cancelled, its outcome is unknown, and only Close is left.
    const running = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(running.promise)
    const again = dialogs.ok()
    connections.remove('server-a')
    expect(dialogs.current).toMatchObject({ phase: 'disconnected', error: { message: unknownOutcomeMessage } })
    expect(api.cancelObjectActions).toHaveBeenCalledWith(['id-3'])
    running.resolve(done)
    await again
    expect(dialogs.current?.phase).toBe('disconnected')
    expect(dialogs.close()).toBe(true)
  })
  it('says the server was disconnected when it goes while the dialog waits, and cancels its requests on dispose', async () => {
    const { dialogs, connections, settle, api, hold } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    connections.remove('server-a')
    expect(dialogs.current).toMatchObject({ phase: 'disconnected', error: { message: dialogMessages.disconnected } })
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
    connections.add(connectionInfo('server-a'), connectionOptions)
    hold(new Promise(() => {}))
    dialogs.open('deleteObject', node(ordersRef))
    dialogs.dispose()
    expect(api.cancelObjectActions.mock.calls.at(-1)).toEqual([['id-2']])
  })
})

describe('ObjectDialogService: Database Properties', () => {
  const properties = (model = databaseModel()): ApiResult<ActionDescribeResult> => ({ ok: true, value: { databaseProperties: model, elapsedMs: 1 } })
  const draftOf = (dialogs: ObjectDialogService) => dialogs.current!.draft as DatabaseDraft
  async function opened(model = databaseModel()) {
    const fixture = setup()
    fixture.api.describeObject.mockResolvedValueOnce(properties(model))
    fixture.dialogs.open('databaseProperties', node(databaseRef, 12))
    await fixture.settle()
    return fixture
  }
  it('opens "Database Properties - AppData" on General with the describe\'s model and a draft of its values', async () => {
    const { dialogs, api } = await opened()
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ dialog: 'databaseProperties', target: databaseRef })
    expect(dialogs.current).toMatchObject({ title: 'Database Properties - AppData', page: 'general', phase: 'ready', model: { general: { name: 'AppData' } } })
    expect(draftOf(dialogs)).toMatchObject({ owner: 'sa', options: { recoveryModel: 'FULL' }, scoped: { maxDop: '0' } })
    dialogs.setPage('options')
    expect(dialogs.current?.page).toBe('options')
    dialogs.setPage('permissions' as never)
    expect(dialogs.current?.page).toBe('options')
    const deleting = setup()
    deleting.dialogs.open('deleteObject', node(ordersRef))
    expect(deleting.dialogs.current?.title).toBe('Delete Object')
  })
  it('says there is nothing to script when nothing changed, and scripts only the changes', async () => {
    const { dialogs, api, documents } = await opened()
    await dialogs.script('newQuery')
    expect(api.scriptObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current).toMatchObject({ phase: 'ready', notice: noScriptNotice })
    dialogs.updateDraft(setOption(setOption(draftOf(dialogs), 'recoveryModel', 'SIMPLE'), 'autoClose', 'true'))
    await dialogs.script('newQuery')
    expect(api.scriptObjectAction.mock.calls[0][0]).toEqual({ action: 'properties', target: databaseRef, closeConnections: false, changes: { options: { recoveryModel: 'SIMPLE', autoClose: 'true' } },
      connectionId: 'server-a', requestId: 'id-2' })
    expect(documents.newQuery).toHaveBeenCalledTimes(1)
  })
  it('closes without a request when nothing changed', async () => {
    const { dialogs, api } = await opened()
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(api.confirmOpenConnections).not.toHaveBeenCalled()
  })
  it('asks Open Connections before an exclusive change: No and a failed prompt send nothing, Yes closes the connections', async () => {
    const { dialogs, api, execute, explorer } = await opened()
    dialogs.updateDraft(setOption(draftOf(dialogs), 'restrictAccess', 'SINGLE_USER'))
    await dialogs.ok()
    expect(api.confirmOpenConnections).toHaveBeenCalledTimes(1)
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current?.phase).toBe('ready')
    api.confirmOpenConnections.mockRejectedValueOnce(new Error('The window closed.'))
    await dialogs.ok()
    api.confirmOpenConnections.mockResolvedValueOnce({ ok: false, error: 'Untrusted IPC sender.' })
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current?.phase).toBe('ready')
    api.confirmOpenConnections.mockResolvedValueOnce({ ok: true, value: true })
    const ok = dialogs.ok()
    await vi.waitFor(() => expect(api.executeObjectAction).toHaveBeenCalledTimes(1))
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'properties', closeConnections: true, changes: { options: { restrictAccess: 'SINGLE_USER' } } })
    execute.resolve(done)
    await ok
    expect(dialogs.current).toBeUndefined()
    expect(explorer.reconcile.mock.calls).toEqual([[3]])
  })
  it('runs a change SSMS does not close connections for without asking, and never asks before Script', async () => {
    const { dialogs, api, execute } = await opened()
    dialogs.updateDraft(setOption(draftOf(dialogs), 'readOnly', 'true'))
    await dialogs.script('clipboard')
    expect(api.confirmOpenConnections).not.toHaveBeenCalled()
    expect(api.scriptObjectAction.mock.calls[0][0]).toMatchObject({ closeConnections: false })
    dialogs.updateDraft(setOption(draftOf(dialogs), 'readOnly', 'false'))
    dialogs.updateDraft(setOption(draftOf(dialogs), 'pageVerify', 'NONE'))
    const ok = dialogs.ok()
    expect(api.confirmOpenConnections).not.toHaveBeenCalled()
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ closeConnections: false, changes: { options: { pageVerify: 'NONE' } } })
    execute.resolve(done)
    await ok
  })
  it('asks Open Connections at once when connections joined after the dialog counted none (IN_USE before anything ran), as SSMS counts them at OK', async () => {
    const { dialogs, api, execute } = await opened(databaseModel({ sessions: 0 }))
    dialogs.updateDraft(setOption(draftOf(dialogs), 'restrictAccess', 'SINGLE_USER'))
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'IN_USE', message: 'Other connections use the database.', retryable: true } } })
    api.confirmOpenConnections.mockResolvedValueOnce({ ok: true, value: true })
    const ok = dialogs.ok()
    await vi.waitFor(() => expect(api.executeObjectAction).toHaveBeenCalledTimes(2))
    expect(api.confirmOpenConnections).toHaveBeenCalledTimes(1)
    expect(api.executeObjectAction.mock.calls.map(call => call[0].action === 'properties' && call[0].closeConnections)).toEqual([false, true])
    execute.resolve(done)
    await ok
    expect(dialogs.current).toBeUndefined()
  })
  it('keeps IN_USE when a step had run, and asks on the next OK; a change SSMS never asks about keeps its advice', async () => {
    const { dialogs, api } = await opened(databaseModel({ sessions: 0 }))
    dialogs.updateDraft(setOption(setOption(draftOf(dialogs), 'autoClose', 'true'), 'readOnly', 'true'))
    const inUse = { code: 'IN_USE', message: 'Other connections use the database.', retryable: true } as const
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done' }, { status: 'failed' }], messages: [], elapsedMs: 1, error: inUse } })
    await dialogs.ok()
    expect(api.confirmOpenConnections).not.toHaveBeenCalled()
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: inUse })
    await dialogs.ok()
    expect(api.confirmOpenConnections).toHaveBeenCalledTimes(1)
    expect(api.executeObjectAction).toHaveBeenCalledTimes(1)
    const broker = await opened(databaseModel({ sessions: 0 }))
    broker.dialogs.updateDraft(setOption(draftOf(broker.dialogs), 'brokerEnabled', 'true'))
    broker.api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'failed' }], messages: [], elapsedMs: 1, error: inUse } })
    await broker.dialogs.ok()
    expect(broker.api.confirmOpenConnections).not.toHaveBeenCalled()
    expect(broker.dialogs.current).toMatchObject({ phase: 'failed', error: inUse })
  })
  it('runs nothing when the server goes while Open Connections is asked', async () => {
    const { dialogs, api, connections } = await opened()
    const answer = deferred<ApiResult<boolean>>()
    api.confirmOpenConnections.mockReturnValueOnce(answer.promise)
    dialogs.updateDraft(setOption(draftOf(dialogs), 'readOnly', 'true'))
    const ok = dialogs.ok()
    expect(dialogs.current?.phase).toBe('confirming')
    connections.remove('server-a')
    answer.resolve({ ok: true, value: true })
    await ok
    expect(dialogs.current?.phase).toBe('disconnected')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
})

describe('Object Explorer: Properties key', () => {
  const press = (platform: Platform): KeyDownEvent => ({
    key: 'i', code: 'KeyI', ctrlKey: platform !== 'darwin', metaKey: platform === 'darwin', altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 73, defaultPrevented: false,
    preventDefault: () => {}, stopPropagation: () => {}
  })
  async function explorerWith(platform: Platform) {
    const fixture = workbenchFixture({ platform })
    cleanups.push(fixture.dispose)
    fixture.api.explorerChildren.mockImplementation(async params => ({ ok: true, value: explorerAnswer(params) }))
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const find = async (label: string) => {
      let id: number | undefined
      await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(node => node?.label === label)?.id; expect(id, label).toBeDefined() })
      return id!
    }
    fixture.explorer.expand(await find('Databases'))
    fixture.explorer.select(await find('AppData'))
    fixture.focused.panel = 'explorer'
    return fixture
  }
  it('opens Database Properties with Cmd+I on macOS while Object Explorer has focus, once', async () => {
    const { keybindings, dialogs, api, commands } = await explorerWith('darwin')
    keybindings.handleKeyDown(press('darwin'))
    await vi.waitFor(() => expect(dialogs.current?.dialog).toBe('databaseProperties'))
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ dialog: 'databaseProperties', target: { kind: 'database', name: 'AppData' } })
    // A second press while the dialog is open does nothing.
    expect(commands.isEnabled('explorer.properties')).toBe(false)
    keybindings.handleKeyDown(press('darwin'))
    expect(api.describeObject).toHaveBeenCalledTimes(1)
  })
  it.each(['win32', 'linux'] as const)('has no Properties key on %s, where Alt+Enter stays reserved', async platform => {
    const { keybindings, dialogs, api } = await explorerWith(platform)
    keybindings.handleKeyDown(press(platform))
    keybindings.handleKeyDown({ ...press(platform), key: 'i', ctrlKey: false, metaKey: true })
    expect(dialogs.current).toBeUndefined()
    expect(api.describeObject).not.toHaveBeenCalled()
  })
})
