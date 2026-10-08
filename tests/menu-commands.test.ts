import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'
import { deferred, TestEditor } from './fixtures/documents'
import type { CommandArgs } from '../src/renderer/src/core/types'
import type { InputTarget } from '../src/renderer/src/menus/targets'

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
    connections.add(connectionInfo('server-a'))
    connections.add(connectionInfo('server-b'))
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
    connections.add(connectionInfo('server-a'))
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
    connections.add(connectionInfo('server-a'))
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
