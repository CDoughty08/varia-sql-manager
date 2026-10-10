import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerNode, SqlFile, VariaApi } from '../src/shared/contracts'
import type { ExplorerTarget, ObjectRef } from '../src/shared/explorer/refs'
import type { NodeSubtype } from '../src/shared/explorer/catalog'
import { kindSpecs } from '../src/shared/explorer/catalog'
import { scriptErrorCodes, scriptErrorRetryable } from '../src/shared/scripting/catalog'
import { defaultScriptingOptions } from '../src/shared/scripting/options'
import type { ScriptResult } from '../src/shared/scripting/schema'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { scriptFileName, scriptingMessages, scriptObjectLabel, ScriptingService } from '../src/renderer/src/scripting/ScriptingService'
import type { CommandArgs } from '../src/renderer/src/core/types'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions, explorerAnswer, manualTimers, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const on = (object: ObjectRef, subtype?: NodeSubtype, connectionId = 'server-a'): ExplorerTarget =>
  ({ connectionId, ref: { type: 'object', object }, kind: object.kind, ...(subtype ? { subtype } : {}), label: object.name ?? '' })
const ordersRef: ObjectRef = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }
const orders = on(ordersRef), login = on({ kind: 'login', name: 'sa' }), database = on({ kind: 'database', name: 'AppData' })
const index = on({ kind: 'index', database: 'AppData', name: 'IX_Orders', parent: { kind: 'table', schema: 'dbo', name: 'Orders' } }, 'nonclustered')
const ok = (text: string, database = 'AppData', warnings: string[] = []): ApiResult<ScriptResult> => ({ ok: true, value: { text, database, warnings, commands: 3, elapsedMs: 5 } })

/** The service over fakes: each request waits until the test settles it, and cancels go out when `tick` runs. */
function setup() {
  const { timers, advance } = manualTimers()
  const scheduled: (() => void)[] = []
  const requests: { params: Parameters<VariaApi['scriptObjects']>[0]; settle: (result: ApiResult<ScriptResult>) => void }[] = []
  const api = {
    scriptObjects: vi.fn<VariaApi['scriptObjects']>(params => { const pending = deferred<ApiResult<ScriptResult>>(); requests.push({ params, settle: pending.resolve }); return pending.promise }),
    cancelScripting: vi.fn<VariaApi['cancelScripting']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined }))
  }
  const documents = { newQuery: vi.fn() }
  const files = { saveCopy: vi.fn(async (name: string, _content: string) => ({ id: 'file-id', name, path: `/home/me/${name}` }) as { id: string; name: string; path: string } | undefined) }
  const connections = new ConnectionService()
  connections.add(connectionInfo('server-a'), connectionOptions)
  let options = { options: defaultScriptingOptions }
  const store = { getSnapshot: () => options, subscribe: () => () => {} }
  const focusEditor = vi.fn()
  let ids = 0
  const scripting = new ScriptingService({ api, documents, files, connections, options: store, focusEditor, timers, schedule: callback => { scheduled.push(callback) }, newId: () => `id-${++ids}` })
  cleanups.push(() => scripting.dispose())
  const tick = () => scheduled.splice(0).forEach(callback => callback())
  const setOptions = (next: typeof defaultScriptingOptions) => { options = { options: next } }
  return { scripting, api, documents, files, connections, focusEditor, requests, advance, tick, setOptions }
}

describe('ScriptingService', () => {
  it('sends one request with the stored options and opens the script in a new, unmarked query on the object\'s database', async () => {
    const { scripting, api, documents, focusEditor, requests, setOptions } = setup()
    setOptions({ ...defaultScriptingOptions, scriptUseDatabase: false })
    const running = scripting.run('create', 'newQuery', orders)
    expect(api.scriptObjects.mock.calls).toEqual([[{ connectionId: 'server-a', requestId: 'id-1', targets: [ordersRef], verb: 'create', options: { ...defaultScriptingOptions, scriptUseDatabase: false } }]])
    requests[0].settle(ok('CREATE TABLE [dbo].[Orders] (Id int)'))
    await running
    expect(documents.newQuery.mock.calls).toEqual([['CREATE TABLE [dbo].[Orders] (Id int)', undefined, 'server-a', 'AppData', false]])
    expect(focusEditor).toHaveBeenCalledOnce()
    // Databases and server objects open on master, as the backend reports.
    const scripted = scripting.run('create', 'newQuery', login)
    requests[1].settle(ok('CREATE LOGIN [sa]', 'master'))
    await scripted
    expect(documents.newQuery.mock.calls[1]).toEqual(['CREATE LOGIN [sa]', undefined, 'server-a', 'master', false])
    expect(scripting.getSnapshot()).toEqual({ jobs: [] })
  })
  it('suggests a file named after the object, says where it saved, and stays quiet when the dialog is cancelled', async () => {
    const { scripting, files, requests } = setup()
    for (const [target, name] of [[orders, 'dbo.Orders.sql'], [index, 'dbo.Orders.IX_Orders.sql'], [login, 'sa.sql'], [database, 'AppData.sql']] as const) {
      const running = scripting.run('drop', 'file', target)
      requests.at(-1)!.settle(ok('DROP …'))
      await running
      expect(files.saveCopy.mock.calls.at(-1)).toEqual([name, 'DROP …'])
      expect(scripting.getSnapshot().notice).toMatchObject({ text: `Saved ${name}.`, kind: 'info' })
    }
    files.saveCopy.mockResolvedValueOnce(undefined)
    scripting.dismissNotice()
    const cancelled = scripting.run('create', 'file', orders)
    requests.at(-1)!.settle(ok('CREATE …'))
    await cancelled
    expect(scripting.getSnapshot().notice).toBeUndefined()
    expect(scriptFileName({ kind: 'trigger', database: 'AppData', parent: { kind: 'view', schema: 'Sales', name: 'V' }, name: 'trg' })).toBe('Sales.V.trg.sql')
  })
  it('copies to the clipboard with a notice that clears after 4 seconds, and reports a failed copy', async () => {
    const { scripting, api, requests, advance } = setup()
    const running = scripting.run('select', 'clipboard', orders)
    requests[0].settle(ok('SELECT [Id] FROM [dbo].[Orders]'))
    await running
    expect(api.writeClipboardText.mock.calls).toEqual([['SELECT [Id] FROM [dbo].[Orders]']])
    expect(scripting.getSnapshot().notice).toMatchObject({ text: scriptingMessages.clipboard, kind: 'info' })
    advance(3999)
    expect(scripting.getSnapshot().notice).toBeDefined()
    advance(1)
    expect(scripting.getSnapshot().notice).toBeUndefined()
    api.writeClipboardText.mockResolvedValueOnce({ ok: false, error: 'The clipboard is busy.' })
    const failing = scripting.run('select', 'clipboard', orders)
    requests[1].settle(ok('SELECT 1'))
    await expect(failing).rejects.toThrow('The clipboard is busy.')
  })
  it('shows a request in the status bar only after 300 ms, and tells the context keys it runs', async () => {
    const { scripting, requests, advance } = setup()
    const running = scripting.run('create', 'clipboard', orders)
    expect(scripting.running.getSnapshot()).toBe(true)
    expect(scripting.getSnapshot().jobs).toEqual([{ id: 'id-1', label: 'dbo.Orders', visible: false }])
    advance(299)
    expect(scripting.getSnapshot().jobs[0].visible).toBe(false)
    advance(1)
    expect(scripting.getSnapshot().jobs[0].visible).toBe(true)
    requests[0].settle(ok('CREATE …'))
    await running
    expect(scripting.running.getSnapshot()).toBe(false)
    expect(scripting.getSnapshot().jobs).toEqual([])
  })
  it('ignores a repeat of a request still on its way, and runs at most four at once', async () => {
    const { scripting, api, requests } = setup()
    const first = scripting.run('create', 'newQuery', orders)
    await scripting.run('create', 'newQuery', orders)
    expect(api.scriptObjects).toHaveBeenCalledOnce()
    const others = [scripting.run('create', 'clipboard', orders), scripting.run('drop', 'newQuery', orders), scripting.run('create', 'newQuery', login)]
    await expect(scripting.run('select', 'newQuery', orders)).rejects.toThrow(scriptingMessages.cap)
    expect(api.scriptObjects).toHaveBeenCalledTimes(4)
    requests.forEach(request => request.settle(ok('…')))
    await Promise.all([first, ...others])
    // A finished request frees its slot and its key.
    const again = scripting.run('select', 'newQuery', orders)
    requests[4].settle(ok('…'))
    await again
    expect(api.scriptObjects).toHaveBeenCalledTimes(5)
  })
  it('cancels in one batch per tick, opens nothing for a cancelled request, and says so', async () => {
    const { scripting, api, documents, requests, tick } = setup()
    const first = scripting.run('create', 'newQuery', orders), second = scripting.run('drop', 'clipboard', login)
    scripting.cancel(['unknown'])
    expect(scripting.getSnapshot().jobs).toHaveLength(2)
    scripting.cancel(['id-1'])
    scripting.cancelAll()
    expect(scripting.getSnapshot()).toMatchObject({ jobs: [], notice: { text: scriptingMessages.cancelled, kind: 'info' } })
    expect(scripting.running.getSnapshot()).toBe(false)
    expect(api.cancelScripting).not.toHaveBeenCalled()
    tick()
    expect(api.cancelScripting.mock.calls).toEqual([[['id-1', 'id-2']]])
    // The backend answers anyway (here, before it saw the cancel): the result is dropped.
    requests[0].settle(ok('CREATE …'))
    requests[1].settle({ ok: false, error: 'The operation was cancelled.' })
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(documents.newQuery).not.toHaveBeenCalled()
    expect(api.writeClipboardText).not.toHaveBeenCalled()
  })
  it('stops the requests of a server that disconnects or is lost, and reports why nothing opened', async () => {
    const { scripting, api, documents, connections, requests, tick } = setup()
    connections.add(connectionInfo('server-b'), connectionOptions)
    const onA = scripting.run('create', 'newQuery', orders), onB = scripting.run('create', 'newQuery', on(ordersRef, undefined, 'server-b'))
    connections.remove('server-a')
    expect(scripting.getSnapshot().jobs.map(job => job.id)).toEqual(['id-2'])
    tick()
    expect(api.cancelScripting.mock.calls).toEqual([[['id-1']]])
    requests[0].settle({ ok: false, error: 'The operation was cancelled.' })
    await expect(onA).rejects.toThrow(scriptingMessages.disconnected)
    // A backend restart loses server-b; its answer, arriving later, is not used.
    connections.markLostBefore(2)
    requests[1].settle(ok('CREATE …'))
    await expect(onB).rejects.toThrow(scriptingMessages.disconnected)
    expect(documents.newQuery).not.toHaveBeenCalled()
    await expect(scripting.run('create', 'newQuery', orders)).rejects.toThrow(scriptingMessages.notConnected)
  })
  it('reports a disconnect when the backend cancels a script before the server leaves the connection list', async () => {
    const { scripting, documents, connections, requests } = setup()
    const running = scripting.run('create', 'newQuery', orders)
    // The backend answers its disconnect's cancellation first; App.disconnect removes the connection after.
    requests[0].settle({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await expect(running).rejects.toThrow(scriptingMessages.disconnected)
    connections.remove('server-a')
    expect(documents.newQuery).not.toHaveBeenCalled()
  })
  it('turns error values and failed requests into messages, and notes warnings for 8 seconds', async () => {
    const { scripting, requests, advance } = setup()
    const failed = scripting.run('create', 'newQuery', orders)
    requests[0].settle({ ok: true, value: { database: 'AppData', warnings: [], commands: 1, elapsedMs: 1, error: { code: 'ENCRYPTED', message: 'dbo.Orders is encrypted.', retryable: false } } })
    await expect(failed).rejects.toThrow('dbo.Orders is encrypted.')
    const refused = scripting.run('create', 'newQuery', orders)
    requests[1].settle({ ok: false, error: 'Invalid request parameters.' })
    await expect(refused).rejects.toThrow('Invalid request parameters.')
    const warned = scripting.run('create', 'clipboard', orders)
    requests[2].settle(ok('CREATE …', 'AppData', ['Descriptive headers were left out.', 'A second warning.']))
    await warned
    expect(scripting.getSnapshot().notice).toMatchObject({ kind: 'warning', text: 'Scripted dbo.Orders with a warning: Descriptive headers were left out.', title: 'Descriptive headers were left out.\nA second warning.' })
    advance(7999)
    expect(scripting.getSnapshot().notice?.kind).toBe('warning')
    advance(1)
    expect(scripting.getSnapshot().notice).toBeUndefined()
  })
  it('refuses what it cannot script before sending anything', async () => {
    const { scripting, api, connections } = setup()
    const folder: ExplorerTarget = { connectionId: 'server-a', ref: { type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' }, kind: 'folder', folder: 'tables', label: 'Tables' }
    for (const [verb, target] of [['create', folder], ['alter', orders], ['execute', orders], ['create', on({ kind: 'certificate', database: 'AppData', name: 'C' })], ['create', undefined]] as const) {
      expect(scripting.canRun(verb, target), verb).toBe(false)
      await expect(scripting.run(verb, 'newQuery', target)).rejects.toThrow('Select an object in Object Explorer that can be scripted.')
    }
    expect(scripting.canRun('create', orders)).toBe(true)
    connections.markLostBefore(2)
    expect(scripting.canRun('create', orders)).toBe(false)
    expect(api.scriptObjects).not.toHaveBeenCalled()
  })
  it('names objects with hidden characters made visible, in at most 400 characters', () => {
    expect(scriptObjectLabel({ kind: 'table', schema: 'dbo', name: 'a\u202eb' })).toBe('dbo.a⟨U+202E⟩b')
    expect(scriptObjectLabel({ kind: 'login', name: 'sa' })).toBe('sa')
    const long = scriptObjectLabel({ kind: 'table', schema: 's', name: 'x'.repeat(500) })
    expect([...long]).toHaveLength(400)
    expect(long.endsWith('…')).toBe(true)
  })
  it('cancels what still runs when it is disposed', () => {
    const { scripting, api } = setup()
    void scripting.run('create', 'newQuery', orders)
    scripting.dispose()
    expect(api.cancelScripting.mock.calls).toEqual([[['id-1']]])
    expect(scripting.running.getSnapshot()).toBe(false)
  })
})

describe('Script As commands', () => {
  const procedure = (name: string, subtype: NodeSubtype): ExplorerNode => ({ ref: { type: 'object', object: { kind: 'procedure', database: 'AppData', schema: 'dbo', name } }, label: `dbo.${name}`, icon: kindSpecs.procedure.icon, subtype, hasChildren: true })
  function connected() {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    // Tables also lists two procedures and a table type's index, so one folder holds every node the tests select.
    fixture.api.explorerChildren.mockImplementation(async params => {
      const answer = explorerAnswer(params)
      if (params.node.type !== 'folder' || params.node.folder !== 'tables') return { ok: true, value: answer }
      const extra: ExplorerNode[] = [procedure('Ship', 'sql'), procedure('ClrShip', 'clr'),
        { ref: { type: 'object', object: { kind: 'index', database: 'AppData', name: 'IX_Type', parent: { kind: 'tableType', schema: 'dbo', name: 'OrderList' } } }, label: 'IX_Type', icon: kindSpecs.index.icon, subtype: 'nonclustered', hasChildren: false }]
      return { ok: true, value: { ...answer, nodes: [...answer.nodes, ...extra], total: answer.nodes.length + extra.length } }
    })
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    return fixture
  }
  const find = async (fixture: ReturnType<typeof connected>, label: string) => {
    let id: number | undefined
    await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(node => node?.label === label)?.id; expect(id, label).toBeDefined() })
    return id!
  }
  const select = async (fixture: ReturnType<typeof connected>, label: string): Promise<CommandArgs> => {
    for (const folder of ['Databases', 'AppData', 'Tables']) {
      const id = await find(fixture, folder)
      if (!fixture.explorer.node(id)?.expanded) fixture.explorer.expand(id)
    }
    const id = await find(fixture, label)
    fixture.explorer.select(id)
    return { target: { kind: 'explorer', node: fixture.explorer.menuNode(id)! } }
  }

  it('show every error code in the command banner as its message', async () => {
    const fixture = connected(), { commands, api } = fixture
    await select(fixture, 'dbo.Orders')
    for (const code of scriptErrorCodes) {
      api.scriptObjects.mockResolvedValueOnce({ ok: true, value: { database: 'AppData', warnings: [], commands: 0, elapsedMs: 1, error: { code, message: `${code}: dbo.Orders could not be scripted.`, retryable: scriptErrorRetryable[code] } } })
      expect(await commands.execute('explorer.scriptCreateToClipboard', undefined, 'palette'), code).toBe(false)
      expect(commands.getSnapshot().error).toBe(`Could not run “Object Explorer: Script as CREATE to Clipboard”: ${code}: dbo.Orders could not be scripted.`)
    }
    expect(api.writeClipboardText).not.toHaveBeenCalled()
  })
  it('publish each selected node\'s Script As keys, a child\'s from its parent', async () => {
    const fixture = connected(), { context } = fixture
    await select(fixture, 'dbo.Orders')
    expect(context.getState()).toMatchObject({ explorerScriptTitle: 'table', explorerScriptCreate: 'enabled', explorerScriptAlter: 'disabled', explorerScriptExecute: 'disabled', explorerSelectionModifiable: false })
    await select(fixture, 'dbo.Ship')
    expect(context.getState()).toMatchObject({ explorerScriptTitle: 'procedure', explorerScriptAlter: 'enabled', explorerScriptSelect: '', explorerScriptExecute: 'enabled', explorerSelectionModifiable: true })
    await select(fixture, 'dbo.ClrShip')
    expect(context.getState()).toMatchObject({ explorerScriptTitle: 'procedure', explorerSelectionModifiable: false })
    // A table type's index has no Script submenu.
    await select(fixture, 'IX_Type')
    expect(context.getState()).toMatchObject({ explorerScriptTitle: '', explorerScriptCreate: '' })
    await select(fixture, 'Tables')
    expect(context.getState()).toMatchObject({ explorerScriptTitle: '', explorerSelectionModifiable: false })
  })
  it('offer Script As… in the palette with the selection\'s enabled scripts, grouped by verb, and run the one accepted', async () => {
    const fixture = connected(), { commands, quickInput, api } = fixture
    expect(commands.isEnabled('explorer.scriptAs')).toBe(false)
    await select(fixture, 'dbo.Ship')
    expect(await commands.execute('explorer.scriptAs', undefined, 'palette')).toBe(true)
    const view = quickInput.getSnapshot()
    expect(view).toMatchObject({ visible: true, title: 'Script Stored Procedure as', ariaLabel: 'Script Stored Procedure as', placeholder: 'Select a script type and destination' })
    const rows = view.rows.map(row => [row.group ?? '', row.item.label])
    expect(rows.slice(0, 4)).toEqual([['CREATE To', 'CREATE to New Query Editor Window'], ['', 'CREATE to File…'], ['', 'CREATE to Clipboard'], ['ALTER To', 'ALTER to New Query Editor Window']])
    expect(rows).toHaveLength(18)
    expect(rows.some(([, label]) => label.startsWith('SELECT'))).toBe(false)
    quickInput.accept(rows.findIndex(([, label]) => label === 'EXECUTE to Clipboard'))
    await vi.waitFor(() => expect(api.writeClipboardText).toHaveBeenCalledOnce())
    expect(api.scriptObjects.mock.calls.map(([params]) => [params.verb, params.targets[0].name])).toEqual([['execute', 'Ship']])
    expect(quickInput.getSnapshot().visible).toBe(false)
    // While a document task runs, only the clipboard can take a script.
    const task = deferred<void>(), busy = fixture.documents.runTask(() => task.promise)
    expect(await commands.execute('explorer.scriptAs', undefined, 'palette')).toBe(true)
    expect(quickInput.getSnapshot().rows.map(row => row.item.label)).toEqual(['CREATE', 'ALTER', 'CREATE OR ALTER', 'DROP', 'DROP And CREATE', 'EXECUTE'].map(verb => `${verb} to Clipboard`))
    task.resolve()
    await busy
  })
  it('save a File… script that arrives during another file task once it ends, and two File… scripts one after the other', async () => {
    const fixture = connected(), { api, scripting, files } = fixture
    const dialogs: ReturnType<typeof deferred<ApiResult<SqlFile | null>>>[] = []
    api.saveSqlFile.mockImplementation(() => { const dialog = deferred<ApiResult<SqlFile | null>>(); dialogs.push(dialog); return dialog.promise })
    // An Open dialog (any file task) is up when the script arrives.
    const task = deferred<void>(), busy = fixture.documents.runTask(() => task.promise)
    const first = scripting.run('create', 'file', orders)
    await vi.waitFor(() => expect(api.scriptObjects).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.saveSqlFile).not.toHaveBeenCalled()
    task.resolve(); await busy
    await vi.waitFor(() => expect(api.saveSqlFile).toHaveBeenCalledOnce())
    expect(api.saveSqlFile.mock.calls[0][0]).toMatchObject({ name: 'dbo.Orders.sql', content: '-- create dbo.Orders', saveAs: true })
    // A second File… script waits for the first Save dialog, then gets its own.
    const second = scripting.run('drop', 'file', orders)
    await vi.waitFor(() => expect(api.scriptObjects).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.saveSqlFile).toHaveBeenCalledOnce()
    dialogs[0].resolve({ ok: true, value: { id: 'f1', name: 'dbo.Orders.sql', path: '/tmp/dbo.Orders.sql' } })
    await first
    await vi.waitFor(() => expect(api.saveSqlFile).toHaveBeenCalledTimes(2))
    expect(api.saveSqlFile.mock.calls[1][0]).toMatchObject({ content: '-- drop dbo.Orders' })
    dialogs[1].resolve({ ok: true, value: { id: 'f2', name: 'dbo.Orders.sql', path: '/tmp/dbo.Orders (2).sql' } })
    await second
    expect(files.getSnapshot().error).toBe('')
    expect(scripting.getSnapshot().notice?.text).toBe('Saved dbo.Orders.sql.')
  })
  it('modify a T-SQL module as ALTER in a new query, but not a CLR one', async () => {
    const fixture = connected(), { commands, api, documents, model } = fixture
    const menu = await select(fixture, 'dbo.Ship')
    expect(await commands.execute('explorer.modify', menu, 'menu')).toBe(true)
    expect(api.scriptObjects.mock.calls.map(([params]) => params.verb)).toEqual(['alter'])
    expect(model(documents.active!.id).getValue()).toBe('-- alter dbo.Ship')
    expect(documents.active).toMatchObject({ connectionId: 'server-a', database: 'AppData', dirty: false })
    expect(fixture.focusEditor).toHaveBeenCalledOnce()
    const clr = await select(fixture, 'dbo.ClrShip')
    expect(commands.isEnabled('explorer.modify', clr)).toBe(false)
    expect(commands.isEnabled('explorer.scriptAlterToNewQuery', clr)).toBe(true)
    // A node's own menu: the CLR procedure's Modify stays off even while the T-SQL one is selected.
    await select(fixture, 'dbo.Ship')
    expect(commands.isEnabled('explorer.modify', clr)).toBe(false)
  })
  it('enable Cancel Scripting only while a request runs, and cancel it on the backend', async () => {
    const fixture = connected(), { commands, api } = fixture
    await select(fixture, 'dbo.Orders')
    expect(commands.isEnabled('explorer.cancelScripting')).toBe(false)
    const held = deferred<ApiResult<ScriptResult>>()
    api.scriptObjects.mockReturnValueOnce(held.promise)
    const running = commands.execute('explorer.scriptDropToNewQuery', undefined, 'palette')
    await vi.waitFor(() => expect(commands.isEnabled('explorer.cancelScripting')).toBe(true))
    expect(await commands.execute('explorer.cancelScripting', undefined, 'palette')).toBe(true)
    expect(commands.isEnabled('explorer.cancelScripting')).toBe(false)
    const [params] = api.scriptObjects.mock.calls[0]
    expect(api.cancelScripting.mock.calls).toEqual([[[params.requestId]]])
    held.resolve(ok('DROP TABLE [dbo].[Orders]'))
    expect(await running).toBe(true)
    expect(fixture.documents.getSnapshot().documents).toHaveLength(0)
    expect(fixture.scripting.getSnapshot().notice?.text).toBe(scriptingMessages.cancelled)
  })
})
