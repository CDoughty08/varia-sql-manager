import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionInfo, connectionOptions, queryOutput, readyBackend, workbenchFixture } from './fixtures/workbench'
import { deferred, TestEditor } from './fixtures/documents'
import type { DisplayQueryResult } from '../src/shared/contracts'
import { contextRecord } from '../src/shared/commands/context-keys'
import type { Platform } from '../src/shared/commands/keybindings'
import { KeybindingService, type KeyDownEvent } from '../src/renderer/src/core/keybindings'
import type { CommandArgs } from '../src/renderer/src/core/types'
import { selectAll, type GridSelection } from '../src/renderer/src/grid/selection'
import type { ExplorerMenuNode, InputTarget, OutputView } from '../src/renderer/src/menus/targets'
import type { ExplorerNodeRef, ObjectRef } from '../src/shared/explorer/refs'
import { fakeDocument, FakeElement } from './fixtures/elements'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function setup() {
  const fixture = workbenchFixture()
  cleanups.push(fixture.dispose)
  return fixture
}
/** The bound query editor, with or without text focus, recording the Monaco commands it is asked to run. */
class FocusableEditor extends TestEditor {
  textFocus = true
  trigger = vi.fn()
  focus = vi.fn()
  hasTextFocus(): boolean { return this.textFocus }
}

describe('role-backed commands', () => {
  it('run Electron\'s roles through main, after the menu has put focus back', async () => {
    const { commands, api } = setup()
    const roles = [['edit.cut', 'cut'], ['edit.copy', 'copy'], ['edit.paste', 'paste'], ['edit.delete', 'delete'], ['edit.selectAll', 'selectAll'], ['view.zoomIn', 'zoomIn'], ['view.zoomOut', 'zoomOut'],
      ['view.resetZoom', 'resetZoom'], ['view.toggleFullScreen', 'togglefullscreen'], ['developer.reloadWindow', 'reload'], ['developer.toggleDevTools', 'toggleDevTools']] as const
    for (const [id, role] of roles) {
      api.runRole.mockClear()
      expect(await commands.execute(id, undefined, 'menu'), id).toBe(true)
      expect(api.runRole.mock.calls, id).toEqual([[role]])
    }
  })
  it('delete and select all in the query editor with its own commands, which no role reaches', async () => {
    const { commands, api, documents } = setup()
    const editor = new FocusableEditor()
    documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
    cleanups.push(() => binding.dispose())
    const binding = documents.bindEditor(editor.asEditor())
    await commands.execute('edit.delete', undefined, 'menu')
    await commands.execute('edit.selectAll', undefined, 'menu')
    expect(editor.trigger.mock.calls).toEqual([['menu', 'deleteRight', null], ['menu', 'editor.action.selectAll', null]])
    expect(api.runRole).not.toHaveBeenCalled()
    // Cut, Copy, and Paste reach the editor's EditContext through the role.
    await commands.execute('edit.paste', undefined, 'menu')
    expect(api.runRole.mock.calls).toEqual([['paste']])
    editor.textFocus = false
    await commands.execute('edit.selectAll', undefined, 'menu')
    expect(api.runRole.mock.calls).toEqual([['paste'], ['selectAll']])
  })
  it('report a failed role in the command banner', async () => {
    const { commands, api } = setup()
    api.runRole.mockResolvedValueOnce({ ok: false, error: 'Untrusted IPC sender.' })
    expect(await commands.execute('view.zoomIn', undefined, 'palette')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “View: Zoom In”: Untrusted IPC sender.')
  })
  it('keep working behind a dialog only for text editing', async () => {
    const fixture = workbenchFixture({ modal: () => true })
    cleanups.push(fixture.dispose)
    expect(await fixture.commands.execute('edit.copy', undefined, 'menu')).toBe(true)
    expect(await fixture.commands.execute('view.zoomIn', undefined, 'menu')).toBe(false)
    expect(fixture.api.runRole.mock.calls).toEqual([['copy']])
  })
})

describe('results pane toggle', () => {
  it('hides showing results and puts focus in the editor, or shows them, and is checked while they show', async () => {
    const { commands, panes, host, documents, context } = setup()
    const editor = new FocusableEditor()
    documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
    const binding = documents.bindEditor(editor.asEditor())
    cleanups.push(() => binding.dispose())
    expect(context.getState().outputPaneVisible).toBe(false)
    expect(commands.isToggled('view.toggleResultsPane')).toBe(false)
    await commands.execute('view.toggleResultsPane', undefined, 'keybinding')
    expect(host.reveal).toHaveBeenCalledWith('output')
    expect(host.closePane).not.toHaveBeenCalled()
    panes.set({ explorer: true, editor: true, output: true })
    expect(context.getState().outputPaneVisible).toBe(true)
    expect(commands.isToggled('view.toggleResultsPane')).toBe(true)
    await commands.execute('view.toggleResultsPane', undefined, 'keybinding')
    expect(host.closePane).toHaveBeenCalledWith('output')
    expect(editor.focus).toHaveBeenCalledOnce()
  })
  it('publishes pane visibility only when it changes', () => {
    const { panes } = setup()
    const listener = vi.fn()
    panes.subscribe(listener)
    panes.set({ explorer: true, editor: true, output: false })
    panes.set({ explorer: true, editor: true, output: false })
    expect(listener).toHaveBeenCalledOnce()
    expect(panes.getSnapshot()).toEqual({ explorer: true, editor: true, output: false })
  })
})

describe('connection and document commands', () => {
  it('disconnect the active query, or every query that is not running', async () => {
    const { commands, documents, connections, api, context, startQuery, files } = setup()
    connections.add(connectionInfo('server-a'), connectionOptions)
    connections.add(connectionInfo('server-b'), connectionOptions)
    const idle = documents.create('idle.sql', 'SELECT 2', 'master', 'server-b')
    const offline = documents.create('offline.sql', '', 'master')
    const active = documents.create('active.sql', 'SELECT 1', 'master', 'server-a')
    expect(context.getState()).toMatchObject({ anyDocumentConnected: true, activeDocumentConnected: true })
    await commands.execute('query.disconnect', undefined, 'menu')
    expect(documents.get(active.id)?.connectionId).toBeUndefined()
    expect(api.closeQuerySession.mock.calls).toEqual([[active.id]])
    // Disconnect All leaves a running query connected and says so.
    documents.activate(idle.id)
    const running = startQuery()
    documents.create('another.sql', '', 'master', 'server-a')
    api.closeQuerySession.mockClear()
    await commands.execute('query.disconnectAll', undefined, 'menu')
    expect(documents.get(idle.id)?.connectionId).toBe('server-b')
    expect(documents.getSnapshot().documents.filter(document => document.connectionId).map(document => document.id)).toEqual([idle.id])
    expect(api.closeQuerySession).toHaveBeenCalledOnce()
    expect(files.getSnapshot().error).toBe('1 query is still running and stayed connected.')
    expect(documents.get(offline.id)?.connectionId).toBeUndefined()
    await running.finish()
    expect(context.getState().anyDocumentConnected).toBe(true)
    await commands.execute('query.disconnectAll', undefined, 'menu')
    expect(context.getState().anyDocumentConnected).toBe(false)
    expect(commands.isEnabled('query.disconnectAll')).toBe(false)
  })
  it('end each session under the document lock, one task for all queries', async () => {
    const { targets, documents, connections, api } = setup()
    connections.add(connectionInfo('server-a'), connectionOptions)
    documents.create('one.sql', '', 'master', 'server-a')
    documents.create('two.sql', '', 'master', 'server-a')
    const closing = deferred<Awaited<ReturnType<typeof api.closeQuerySession>>>()
    api.closeQuerySession.mockReturnValueOnce(closing.promise)
    const task = targets.disconnectAll()
    expect(documents.getSnapshot().busy).toBe(true)
    closing.resolve({ ok: true, value: { closed: true } })
    await task
    expect(documents.getSnapshot()).toMatchObject({ busy: false })
    expect(api.closeQuerySession).toHaveBeenCalledTimes(2)
  })
  it('close every query from Window › Close All Documents', async () => {
    const { commands, documents } = setup()
    expect(commands.isEnabled('file.closeAll')).toBe(false)
    documents.create('one.sql', '', 'master')
    documents.create('two.sql', '', 'master')
    expect(commands.isEnabled('file.closeAll')).toBe(true)
    expect(await commands.execute('file.closeAll', undefined, 'menu')).toBe(true)
    expect(documents.getSnapshot().documents).toEqual([])
  })
})

describe('context menu commands', () => {
  const field = (facts: Partial<Omit<InputTarget, 'kind' | 'element'>> = {}): CommandArgs => ({
    target: { kind: 'input', element: {} as HTMLElement, readOnly: false, secret: false, hasSelection: true, empty: false, canUndo: true, canRedo: true, ...facts }
  })
  it('enable a text field\'s editing commands by what the field allows', () => {
    const { commands } = setup()
    const enabled = (args?: CommandArgs) => (['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'] as const).filter(id => commands.isEnabled(id, args))
    expect(enabled()).toEqual(['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'])
    expect(enabled(field())).toEqual(['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'])
    expect(enabled(field({ hasSelection: false }))).toEqual(['edit.undo', 'edit.redo', 'edit.paste', 'edit.selectAll'])
    expect(enabled(field({ secret: true }))).toEqual(['edit.undo', 'edit.redo', 'edit.paste', 'edit.delete', 'edit.selectAll'])
    expect(enabled(field({ readOnly: true }))).toEqual(['edit.undo', 'edit.redo', 'edit.copy', 'edit.selectAll'])
    expect(enabled(field({ empty: true, hasSelection: false, canUndo: false, canRedo: false }))).toEqual(['edit.paste'])
    // Other targets (the editor's menu) leave them enabled.
    expect(enabled({ target: { kind: 'editor', tabId: 'x' }, tabId: 'x' })).toHaveLength(7)
  })
  it('undo and redo in the field the menu was opened for, the editor\'s find inputs included', async () => {
    const { commands, documents } = setup()
    const editor = new FocusableEditor()
    documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
    const binding = documents.bindEditor(editor.asEditor())
    cleanups.push(() => binding.dispose())
    const execCommand = vi.fn()
    vi.stubGlobal('document', { execCommand, activeElement: null })
    cleanups.push(() => vi.unstubAllGlobals())
    expect(await commands.execute('edit.undo', field(), 'menu')).toBe(true)
    expect(await commands.execute('edit.redo', field(), 'menu')).toBe(true)
    expect(execCommand.mock.calls).toEqual([['undo'], ['redo']])
    expect(editor.trigger).not.toHaveBeenCalled()
    expect(await commands.execute('edit.undo', field({ canUndo: false }), 'menu')).toBe(false)
  })
  it('close every query but the one whose tab the menu is for', async () => {
    const { commands, documents, startQuery, files, connections } = setup()
    const one = documents.create('one.sql', '', 'master'), two = documents.create('two.sql', '', 'master')
    expect(commands.isEnabled('file.closeOthers', { tabId: one.id })).toBe(true)
    expect(commands.isEnabled('file.closeOthers', { tabId: 'gone' })).toBe(false)
    connections.add(connectionInfo('server-a'), connectionOptions)
    const three = documents.create('three.sql', 'SELECT 3', 'master', 'server-a')
    const running = startQuery()
    expect(await commands.execute('file.closeOthers', { tabId: one.id }, 'menu')).toBe(true)
    // The running query stays open and is reported; without a tab, the active query is kept.
    expect(documents.getSnapshot().documents.map(document => document.id)).toEqual([one.id, three.id])
    expect(files.getSnapshot().error).toBe('1 query is still running and stayed open.')
    await running.finish()
    expect(await commands.execute('file.closeOthers', undefined, 'palette')).toBe(true)
    expect(documents.getSnapshot().documents.map(document => document.id)).toEqual([three.id])
    expect(commands.isEnabled('file.closeOthers')).toBe(false)
    expect(documents.get(two.id)).toBeUndefined()
  })
  it('copy a saved query\'s path and show it in its folder through main, and stay disabled for an unsaved one', async () => {
    const { commands, documents, api } = setup()
    const saved = documents.create('saved.sql', '', 'master', undefined, false, { id: '6f0c9a77-0d3b-4c39-9a2e-36c4a1f5e6a1', name: 'saved.sql', path: '/queries/saved.sql' })
    const unsaved = documents.create('SQLQuery2.sql', '', 'master')
    for (const id of ['file.copyPath', 'file.revealInFolder'] as const) {
      expect(commands.isEnabled(id), id).toBe(false)
      expect(commands.isEnabled(id, { tabId: saved.id }), id).toBe(true)
    }
    expect(await commands.execute('file.copyPath', { tabId: saved.id }, 'menu')).toBe(true)
    expect(await commands.execute('file.revealInFolder', { tabId: saved.id }, 'menu')).toBe(true)
    expect(await commands.execute('file.copyPath', { tabId: unsaved.id }, 'menu')).toBe(false)
    expect(api.writeClipboardText.mock.calls).toEqual([['/queries/saved.sql']])
    expect(api.revealSqlFile.mock.calls).toEqual([['6f0c9a77-0d3b-4c39-9a2e-36c4a1f5e6a1']])
    api.revealSqlFile.mockResolvedValueOnce({ ok: false, error: 'This SQL file is no longer open. Use Save As to select a file.' })
    expect(await commands.execute('file.revealInFolder', { tabId: saved.id }, 'menu')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “File: Open Containing Folder”: This SQL file is no longer open. Use Save As to select a file.')
  })
  it('float, dock, and close the panel whose tab the menu is for', async () => {
    const { commands, host } = setup()
    const tab = (pane: 'explorer' | 'output'): CommandArgs => ({ target: { kind: 'dockTab', pane, floating: false } })
    vi.mocked(host.paneLocation).mockImplementation(pane => pane === 'output' ? 'floating' : 'grid')
    const enabled = (args?: CommandArgs) => (['pane.float', 'pane.dock', 'pane.close'] as const).filter(id => commands.isEnabled(id, args))
    expect(enabled(tab('explorer'))).toEqual(['pane.float', 'pane.close'])
    expect(enabled(tab('output'))).toEqual(['pane.dock', 'pane.close'])
    expect(enabled()).toEqual([])
    await commands.execute('pane.float', tab('explorer'), 'menu')
    await commands.execute('pane.dock', tab('output'), 'menu')
    await commands.execute('pane.close', tab('output'), 'menu')
    expect([vi.mocked(host.floatPane).mock.calls, vi.mocked(host.dockPane).mock.calls, vi.mocked(host.closePane).mock.calls]).toEqual([[['explorer']], [['output']], [['output']]])
    vi.mocked(host.paneLocation).mockReturnValue('closed')
    expect(enabled(tab('output'))).toEqual([])
  })
  it('open the focused element\'s menu for Shift+F10, except over the quick input', async () => {
    const { commands, menus, quickInput } = setup()
    const open = vi.spyOn(menus, 'openForElement').mockReturnValue(true)
    const focused = {}
    vi.stubGlobal('document', { activeElement: focused })
    cleanups.push(() => vi.unstubAllGlobals())
    expect(await commands.execute('workbench.showContextMenu', undefined, 'keybinding')).toBe(true)
    expect(open.mock.calls).toEqual([[focused, { keyboard: true }]])
    quickInput.show({ ariaLabel: 'Command Palette', placeholder: '', noun: 'commands', items: [], onDidAccept: () => {} })
    expect(commands.isEnabled('workbench.showContextMenu')).toBe(false)
  })
})

describe('Object Explorer commands', () => {
  let ids = 1000
  /** A context menu's target: a node of server-a (unless named), as the tree captures it when the menu opens. */
  const at = (ref: ExplorerNodeRef, connectionId = 'server-a', lost = false): CommandArgs => ({ target: { kind: 'explorer', node: {
    id: ++ids, lost, connectionId, ref, label: 'node', kind: ref.type === 'folder' ? 'folder' : ref.object.kind, ...(ref.type === 'folder' ? { folder: ref.folder } : {})
  } } })
  const on = (object: ObjectRef, connectionId?: string, lost?: boolean) => at({ type: 'object', object }, connectionId, lost)
  const appDataRef: ObjectRef = { kind: 'database', name: 'AppData' }
  const server = on({ kind: 'server' }), appData = on(appDataRef), orders = on({ kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' })
  const tables = at({ type: 'folder', owner: appDataRef, folder: 'tables' }), background: CommandArgs = { target: { kind: 'explorer' } }
  function connected() {
    const fixture = setup()
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    return fixture
  }
  /** The tree's node with this label, once loaded. */
  const find = async (fixture: ReturnType<typeof setup>, label: string) => {
    let id: number | undefined
    await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(node => node?.label === label)?.id; expect(id, label).toBeDefined() })
    return id!
  }
  it('open a new query on a server\'s or database\'s connection and put focus in its editor', async () => {
    const { commands, documents } = connected()
    const editor = new FocusableEditor()
    documents.create('SQLQuery1.sql', '', 'master')
    const binding = documents.bindEditor(editor.asEditor())
    cleanups.push(() => binding.dispose())
    expect(await commands.execute('explorer.newQuery', server, 'menu')).toBe(true)
    expect(documents.active).toMatchObject({ connectionId: 'server-a', database: 'master', dirty: false })
    expect(await commands.execute('explorer.newQuery', appData, 'menu')).toBe(true)
    expect(documents.active).toMatchObject({ connectionId: 'server-a', database: 'AppData' })
    expect(editor.focus).toHaveBeenCalledTimes(2)
    for (const args of [on({ kind: 'server' }, 'gone'), on({ kind: 'server' }, 'server-a', true), orders, tables, background]) expect(commands.isEnabled('explorer.newQuery', args)).toBe(false)
  })
  it('act on the selected node from F5, the toolbar, and the palette', async () => {
    const fixture = connected(), { commands, documents, explorer, api } = fixture
    // Connecting selects and expands the server.
    expect(explorer.target()).toMatchObject({ kind: 'server', connectionId: 'server-a' })
    expect(commands.isEnabled('explorer.newQuery')).toBe(true)
    expect(await commands.execute('explorer.copyName', undefined, 'palette')).toBe(true)
    explorer.select(await find(fixture, 'Databases'))
    explorer.expand(await find(fixture, 'Databases'))
    expect(commands.isEnabled('explorer.newQuery')).toBe(false)
    expect(commands.isEnabled('explorer.copyName')).toBe(false)
    explorer.select(await find(fixture, 'AppData'))
    expect(await commands.execute('explorer.newQuery', undefined, 'palette')).toBe(true)
    expect(documents.active).toMatchObject({ connectionId: 'server-a', database: 'AppData' })
    expect(commands.isEnabled('explorer.selectTopRows')).toBe(false)
    explorer.expand(await find(fixture, 'AppData'))
    explorer.expand(await find(fixture, 'Tables'))
    explorer.select(await find(fixture, 'dbo.Orders'))
    expect(await commands.execute('explorer.scriptCreateToClipboard', undefined, 'palette')).toBe(true)
    expect(await commands.execute('explorer.copyName', undefined, 'palette')).toBe(true)
    expect(api.writeClipboardText.mock.calls).toEqual([['server-a.example'], ['CREATE TABLE [dbo].[Orders] (Id int);'], ['[dbo].[Orders]']])
    expect(api.scriptTable.mock.calls).toEqual([['server-a', 'AppData', 'dbo', 'Orders']])
  })
  it('select the top 1000 rows of a table by its columns and run them on its database', async () => {
    const { commands, documents, api, model } = connected()
    expect(await commands.execute('explorer.selectTopRows', orders, 'menu')).toBe(true)
    expect(api.tableColumns.mock.calls).toEqual([['server-a', 'AppData', 'dbo', 'Orders']])
    const script = ['/****** Script for SelectTopNRows command from Varia SQL Manager ******/', 'SELECT TOP (1000) [Id]', '      ,[CustomerName]', '  FROM [AppData].[dbo].[Orders]'].join('\n')
    const tab = documents.active!
    expect(model(tab.id).getValue()).toBe(script)
    // The menu can make it again, so closing it asks nothing. It ran on AppData (the result then names the database).
    expect(tab).toMatchObject({ connectionId: 'server-a', dirty: false })
    expect(api.execute.mock.calls.map(([options]) => [options.sql, options.database, options.sessionId])).toEqual([[script, 'AppData', tab.id]])
    api.tableColumns.mockResolvedValueOnce({ ok: false, error: 'Table was not found.' })
    expect(await commands.execute('explorer.selectTopRows', orders, 'menu')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “Object Explorer: Select Top 1000 Rows”: Table was not found.')
    expect(documents.getSnapshot().documents).toHaveLength(1)
    expect(commands.isEnabled('explorer.selectTopRows', tables)).toBe(false)
  })
  it('script a table as CREATE to a new query, a file, or the clipboard', async () => {
    const { commands, documents, api, model } = connected()
    const created = 'CREATE TABLE [dbo].[Orders] (Id int);'
    expect(await commands.execute('explorer.scriptCreateToNewQuery', orders, 'toolbar')).toBe(true)
    expect(documents.active).toMatchObject({ name: 'dbo.Orders.sql', connectionId: 'server-a', database: 'AppData', dirty: true })
    expect(model(documents.active!.id).getValue()).toBe(created)
    expect(await commands.execute('explorer.scriptCreateToFile', orders, 'menu')).toBe(true)
    expect(api.saveSqlFile.mock.calls).toEqual([[{ name: 'dbo.Orders.sql', content: created, saveAs: true }]])
    expect(api.releaseSqlFile.mock.calls).toEqual([['file-id']])
    expect(await commands.execute('explorer.scriptCreateToClipboard', orders, 'menu')).toBe(true)
    expect(api.writeClipboardText.mock.calls).toEqual([[created]])
    expect(api.scriptTable).toHaveBeenCalledTimes(3)
    expect(documents.getSnapshot().documents).toHaveLength(1)
    api.scriptTable.mockResolvedValueOnce({ ok: false, error: 'Table was not found.' })
    expect(await commands.execute('explorer.scriptCreateToNewQuery', orders, 'toolbar')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “Object Explorer: Script Table as CREATE to New Query Editor Window”: Table was not found.')
  })
  it('copy a node\'s name: the server as connected to, or the quoted object name', async () => {
    const { commands, api } = connected()
    const column = on({ kind: 'column', database: 'AppData', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'Id' })
    const parameter = on({ kind: 'parameter', database: 'AppData', parent: { kind: 'procedure', schema: 'dbo', name: 'Ship' }, name: '@id' })
    for (const args of [server, appData, on({ kind: 'login', name: 'sa' }), orders, column, parameter]) expect(await commands.execute('explorer.copyName', args, 'menu')).toBe(true)
    expect(api.writeClipboardText.mock.calls).toEqual([['server-a.example'], ['[AppData]'], ['[sa]'], ['[dbo].[Orders]'], ['[Id]'], ['@id']])
    const returnValue = on({ kind: 'returnValue', database: 'AppData', parent: { kind: 'function', schema: 'dbo', name: 'Total' } })
    for (const args of [tables, background, returnValue, on({ kind: 'server' }, 'gone'), on({ kind: 'server' }, 'server-a', true)]) expect(commands.isEnabled('explorer.copyName', args)).toBe(false)
  })
  it('refresh the node the menu is for, else the selected node; the empty area refreshes everything', async () => {
    const { commands, explorer } = connected()
    const refresh = vi.spyOn(explorer, 'refresh')
    await commands.execute('explorer.refresh', tables, 'menu')
    await commands.execute('explorer.refresh', background, 'menu')
    await commands.execute('explorer.refresh', undefined, 'keybinding')
    const root = explorer.rootIds[0]
    expect(refresh.mock.calls).toEqual([[(tables.target as { node: { id: number } }).node.id], [undefined], [root]])
  })
  it('open Filter Settings for a folder that can be filtered, and remove a folder\'s filter', async () => {
    const fixture = connected(), { commands, explorer } = fixture
    const filtered: CommandArgs = { target: { kind: 'explorer', node: { ...(tables.target as { node: ExplorerMenuNode }).node, filtered: true } } }
    // From the menu's node (this one is not in the tree, so it fails with a message); the server, a database and the
    // empty area cannot be filtered.
    expect(await commands.execute('explorer.filter', tables, 'menu')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “Object Explorer: Filter Settings…”: Select a folder that can be filtered.')
    for (const args of [server, appData, background, on({ kind: 'server' }, 'server-a', true)]) expect(commands.isEnabled('explorer.filter', args)).toBe(false)
    expect(commands.isEnabled('explorer.removeFilter', tables)).toBe(false)
    expect(commands.isEnabled('explorer.removeFilter', filtered)).toBe(true)
    // From the selection: the toolbar, the palette, and the capped row's Enter.
    expect(commands.isEnabled('explorer.filter')).toBe(false)
    explorer.expand(await find(fixture, 'Databases'))
    const databases = await find(fixture, 'Databases')
    explorer.select(databases)
    expect(await commands.execute('explorer.filter', undefined, 'toolbar')).toBe(true)
    expect(explorer.filterDialog.getSnapshot()).toBe(databases)
    explorer.closeFilter()
    explorer.setFilter(databases, { name: { op: 'contains', value: 'App' } })
    expect(commands.isEnabled('explorer.removeFilter')).toBe(true)
    expect(await commands.execute('explorer.removeFilter', undefined, 'palette')).toBe(true)
    expect(explorer.filter(databases)).toBeUndefined()
    expect(commands.isEnabled('explorer.removeFilter')).toBe(false)
  })
  it('stop every load and collapse everything below the servers', async () => {
    const { commands, explorer } = connected()
    const stop = vi.spyOn(explorer, 'stop'), collapse = vi.spyOn(explorer, 'collapseAll')
    expect(commands.isEnabled('explorer.collapseAll')).toBe(true)
    await commands.execute('explorer.stop', undefined, 'toolbar')
    await commands.execute('explorer.collapseAll', undefined, 'toolbar')
    expect([stop.mock.calls.length, collapse.mock.calls.length]).toEqual([1, 1])
  })
  it('disconnect a server node\'s server without asking which, unless a query runs on it', async () => {
    const { commands, documents, host, quickInput, startQuery } = connected()
    expect(await commands.execute('connection.disconnect', server, 'menu')).toBe(true)
    expect(vi.mocked(host.disconnect).mock.calls).toEqual([['server-a']])
    expect(quickInput.getSnapshot()).toMatchObject({ visible: false })
    documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'server-a')
    const running = startQuery()
    expect(commands.isEnabled('connection.disconnect', server)).toBe(false)
    expect(commands.isEnabled('connection.disconnect', on({ kind: 'server' }, 'gone'))).toBe(false)
    // The picker stays available; it disables that server's row instead.
    expect(commands.isEnabled('connection.disconnect')).toBe(true)
    await running.finish()
    expect(commands.isEnabled('connection.disconnect', server)).toBe(true)
  })
  it('reconnect or remove a lost server from its menu, and pick among the lost ones elsewhere', async () => {
    const { commands, host, connections, quickInput } = connected()
    connections.add(connectionInfo('server-l', 0), connectionOptions)
    expect(connections.get('server-l')).toMatchObject({ lost: true })
    const lost = on({ kind: 'server' }, 'server-l', true)
    expect(await commands.execute('connection.reconnect', lost, 'menu')).toBe(true)
    expect(await commands.execute('connection.removeLost', lost, 'menu')).toBe(true)
    expect([vi.mocked(host.reconnect).mock.calls, vi.mocked(host.disconnect).mock.calls]).toEqual([[['server-l']], [['server-l']]])
    // Not for a live server, nor for a lost one that was reconnected or removed meanwhile.
    for (const args of [server, on({ kind: 'server' }, 'server-x', true)]) {
      expect(commands.isEnabled('connection.reconnect', args)).toBe(false)
      expect(commands.isEnabled('connection.removeLost', args)).toBe(false)
    }
    expect(await commands.execute('connection.removeLost', undefined, 'palette')).toBe(true)
    expect(quickInput.getSnapshot()).toMatchObject({ visible: true, ariaLabel: 'Remove Lost Connection', rows: [{ item: { id: 'server-l' } }] })
  })
  it('leave a server lost with a backend restart alone, even when the restart comes while a command waits', async () => {
    const { commands, documents, api, connections } = connected()
    const columns = deferred<Awaited<ReturnType<typeof api.tableColumns>>>(), script = deferred<Awaited<ReturnType<typeof api.scriptTable>>>()
    api.tableColumns.mockReturnValueOnce(columns.promise)
    api.scriptTable.mockReturnValueOnce(script.promise)
    const selecting = commands.execute('explorer.selectTopRows', orders, 'menu'), scripting = commands.execute('explorer.scriptCreateToNewQuery', orders, 'menu')
    // The backend restarts: server-a's generation is gone, and Object Explorer shows it as lost.
    api.push({ status: 'restarting', generation: 1, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 }, retryInMs: 0 })
    expect(connections.get('server-a')).toMatchObject({ lost: true })
    columns.resolve({ ok: true, value: { columns: [{ name: 'Id', dataType: 'int' }], truncated: false } })
    script.resolve({ ok: true, value: { sql: 'CREATE TABLE [dbo].[Orders] (Id int);' } })
    await Promise.all([selecting, scripting])
    expect(documents.getSnapshot().documents).toHaveLength(0)
    expect(api.execute).not.toHaveBeenCalled()
    api.push(readyBackend(2))
    for (const id of ['explorer.newQuery', 'explorer.copyName', 'connection.disconnect'] as const) expect(commands.isEnabled(id, server), id).toBe(false)
    for (const id of ['explorer.selectTopRows', 'explorer.scriptCreateToNewQuery', 'explorer.scriptCreateToFile', 'explorer.scriptCreateToClipboard', 'explorer.copyName'] as const) expect(commands.isEnabled(id, orders), id).toBe(false)
    expect(await commands.execute('explorer.newQuery', server, 'menu')).toBe(false)
    expect(documents.getSnapshot().documents).toHaveLength(0)
  })
  it('reconnect or remove a server lost with a backend restart from its node\'s menu, and reconnect a lost query from Query › Connection', async () => {
    const { commands, documents, api, connections, host, menus, quickInput } = connected()
    const tab = documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'server-a')
    connections.add(connectionInfo('server-b'), connectionOptions)
    api.push({ status: 'restarting', generation: 1, lost: { generation: 1, reason: 'crash', connections: 2, queries: 0 }, retryInMs: 0 })
    api.push(readyBackend(2))
    const lost = on({ kind: 'server' }, 'server-b', true)
    const items = (resolved: ReturnType<typeof menus.resolve>) => resolved.map(item => item.kind === 'command' ? [item.title, item.enabled] : item.kind)
    expect(items(menus.resolve('explorer.context', lost.target))).toEqual([['Connect…', true], ['Reconnect…', true], ['Remove', true]])
    // A lost server's node acts on that server, not on the active query's lost one.
    expect(await commands.execute('connection.reconnect', lost, 'menu')).toBe(true)
    expect(await commands.execute('connection.removeLost', lost, 'menu')).toBe(true)
    expect([vi.mocked(host.reconnect).mock.calls, vi.mocked(host.disconnect).mock.calls]).toEqual([[['server-b']], [['server-b']]])
    const connection = menus.resolve('query').find(item => item.key === 'query.connection')
    if (connection?.kind !== 'submenu') throw new Error('Query › Connection is missing')
    expect(items(connection.items)).toEqual([['Connect…', true], ['Disconnect', false], ['Disconnect All Queries', false], ['Reconnect…', true], 'separator', ['Change Connection…', true]])
    expect(await commands.execute('connection.reconnect', { tabId: tab.id }, 'menu')).toBe(true)
    expect(vi.mocked(host.reconnect).mock.calls.at(-1)).toEqual(['server-a'])
    expect(quickInput.getSnapshot()).toMatchObject({ visible: false })
    // Once the server is reconnected or removed, its node can do neither.
    connections.remove('server-b')
    for (const id of ['connection.reconnect', 'connection.removeLost'] as const) expect(commands.isEnabled(id, lost), id).toBe(false)
  })
})

describe('Query Output commands', () => {
  const results: DisplayQueryResult = { ...queryOutput, messages: ['hello'], resultSets: [
    { columns: [{ name: 'Id', dataType: 'int' }, { name: '', dataType: 'nvarchar' }], rows: [['1', 'a'], ['2', null]], truncated: false },
    { columns: [{ name: 'Microsoft SQL Server 2005 XML Showplan', dataType: 'xml' }], rows: [['<ShowPlanXML/>']], truncated: false, kind: 'executionPlan' }
  ] }
  const block = (resultIndex = 0): GridSelection => ({ resultIndex, anchor: { row: 0, column: 0 }, focus: { row: 1, column: 1 }, mode: 'cells' })
  /** A query that has run and shows `value`, and targets for its views, each over an element of the fake document. */
  async function ran(platform: Platform = 'win32', value: DisplayQueryResult = results) {
    const fixture = workbenchFixture({ platform })
    cleanups.push(fixture.dispose)
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const tab = fixture.documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'server-a')
    fixture.api.execute.mockResolvedValueOnce({ ok: true, value })
    await fixture.queries.execute()
    const doc = fakeDocument()
    const element = (view: OutputView, resultIndex = 0, text = '') => new FakeElement(doc, 'div', { textContent: text, attributes: { 'data-output-view': view, 'data-tab-id': tab.id, 'data-result-index': String(resultIndex) } })
    const on = (view: OutputView, options: { resultIndex?: number; selectedText?: string; text?: string } = {}): CommandArgs => ({ tabId: tab.id, target: {
      kind: 'output', tabId: tab.id, view, resultIndex: options.resultIndex ?? 0, selectedText: options.selectedText ?? '', element: element(view, options.resultIndex, options.text).dom
    } })
    return { ...fixture, tab, doc, element, on }
  }
  it('copy the grid\'s selected cells as tab-separated text, with or without headers, in the platform\'s line breaks', async () => {
    const { commands, api, resultSelection, tab, on, element } = await ran()
    const enabled = (args: CommandArgs) => (['output.copy', 'output.copyWithHeaders', 'output.selectAll'] as const).filter(id => commands.isEnabled(id, args))
    expect(enabled(on('grid'))).toEqual(['output.selectAll'])
    resultSelection.set(tab.id, block())
    expect(enabled(on('grid'))).toEqual(['output.copy', 'output.copyWithHeaders', 'output.selectAll'])
    expect(await commands.execute('output.copy', on('grid'), 'menu')).toBe(true)
    expect(await commands.execute('output.copyWithHeaders', on('grid'), 'menu')).toBe(true)
    expect(api.writeClipboardText.mock.calls).toEqual([['1\ta\r\n2\tNULL'], ['Id\t(No column name)\r\n1\ta\r\n2\tNULL']])
    // A selection in another result set, the XML plan's result, and a closed query's results have nothing to copy.
    resultSelection.set(tab.id, block(1))
    expect(enabled(on('grid'))).toEqual(['output.selectAll'])
    expect(enabled(on('grid', { resultIndex: 1 }))).toEqual([])
    expect(enabled({ target: { kind: 'output', tabId: 'gone', view: 'grid', resultIndex: 0, selectedText: '', element: element('grid').dom } })).toEqual([])
    const linux = await ran('linux')
    linux.resultSelection.set(linux.tab.id, selectAll(0))
    expect(await linux.commands.execute('output.copyWithHeaders', linux.on('grid'), 'menu')).toBe(true)
    expect(linux.api.writeClipboardText.mock.calls).toEqual([['Id\t(No column name)\n1\ta\n2\tNULL']])
  })
  it('copy and select the text of Messages and the XML plan', async () => {
    const { commands, api, doc, on } = await ran()
    const messages = on('messages', { selectedText: 'hello', text: 'hello\nCompleted.' })
    expect((['output.copy', 'output.copyWithHeaders', 'output.selectAll'] as const).filter(id => commands.isEnabled(id, messages))).toEqual(['output.copy', 'output.selectAll'])
    expect(await commands.execute('output.copy', messages, 'menu')).toBe(true)
    expect(api.writeClipboardText.mock.calls).toEqual([['hello']])
    expect(commands.isEnabled('output.copy', on('plan'))).toBe(false)
    // Select All selects only that view's text.
    expect(await commands.execute('output.selectAll', on('plan', { resultIndex: 1, text: '<ShowPlanXML/>' }), 'menu')).toBe(true)
    expect(doc.selection).toBe('<ShowPlanXML/>')
    expect(commands.isEnabled('output.selectAll', on('messages'))).toBe(false)
  })
  it('select every cell from the menu, and from Edit › Select All while the grid has focus', async () => {
    const { commands, api, resultSelection, tab, on, element } = await ran()
    expect(await commands.execute('output.selectAll', on('grid'), 'menu')).toBe(true)
    expect(resultSelection.get(tab.id, 0)).toEqual(selectAll(0))
    resultSelection.clear(tab.id)
    vi.stubGlobal('document', { activeElement: element('grid') })
    cleanups.push(() => vi.unstubAllGlobals())
    expect(await commands.execute('edit.selectAll', undefined, 'menu')).toBe(true)
    expect(resultSelection.get(tab.id, 0)).toEqual(selectAll(0))
    expect(api.runRole).not.toHaveBeenCalled()
    // A text field's own menu still selects the field's text.
    const input = new FakeElement(fakeDocument(), 'input', { value: 'x' })
    expect(await commands.execute('edit.selectAll', { target: { kind: 'input', element: input.dom, readOnly: false, secret: false, hasSelection: false, empty: false, canUndo: true, canRedo: true } }, 'menu')).toBe(true)
    expect(api.runRole.mock.calls).toEqual([['selectAll']])
  })
  it('copy with headers from Ctrl+Shift+C in a focused grid, and leave the key alone elsewhere', async () => {
    const { commands, api, resultSelection, tab, element } = await ran()
    resultSelection.set(tab.id, block())
    vi.stubGlobal('document', { activeElement: element('grid') })
    cleanups.push(() => vi.unstubAllGlobals())
    const focus = { grid: true }
    const keybindings = new KeybindingService({ platform: 'win32', commands, context: { get: () => contextRecord('win32', { activePanel: 'output', outputGridFocus: focus.grid }) }, modalOpen: () => false, editorHasTextFocus: () => false })
    const press = () => {
      const event = { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      keybindings.handleKeyDown(event satisfies KeyDownEvent)
      return event.preventDefault.mock.calls.length > 0
    }
    expect(press()).toBe(true)
    await vi.waitFor(() => expect(api.writeClipboardText.mock.calls).toEqual([['Id\t(No column name)\r\n1\ta\r\n2\tNULL']]))
    focus.grid = false
    expect(press()).toBe(false)
  })
  it('refuse to copy more than the clipboard limit, with a message in the banner', async () => {
    const huge = 'x'.repeat(5_000_000)
    const { commands, api, resultSelection, tab, on } = await ran('win32', { ...queryOutput, resultSets: [{ columns: [{ name: 'a', dataType: 'nvarchar' }], rows: [[huge], [huge]], truncated: false }] })
    resultSelection.set(tab.id, selectAll(0))
    expect(await commands.execute('output.copy', on('grid'), 'menu')).toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “Query: Copy”: The selection is too large to copy.')
    expect(await commands.execute('output.copy', on('messages', { selectedText: huge + huge }), 'menu')).toBe(false)
    expect(api.writeClipboardText).not.toHaveBeenCalled()
  })
})
