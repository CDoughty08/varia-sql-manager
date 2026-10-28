import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from '../src/main/application-menu'
import { applyMenuState, indexCommandItems, NativeMenuBridge, type MenuItemLike, type MenuLike } from '../src/main/native-menu'
import { commandIds, type CommandId } from '../src/shared/commands/catalog'
import { platforms, type Platform } from '../src/shared/commands/keybindings'
import { commandDescriptor } from '../src/shared/commands/catalog'
import {
  applicationMenus, assignMnemonics, buildMenuModel, contextCommandIds, contextMenuIds, contextMenuRequestSchema, createContextMenuRequestSchema, menuAccelerator, menuCommandIds, menuForMnemonic, menuIds,
  menuRoots, menuStateSchema, menuTitle, mnemonicIndex, nativeItemId, nativeMenuIds, pruneMenu, toggleCommandIds, trimSeparators, type ContextMenuId, type MenuEntry, type MenuId, type SubmenuId
} from '../src/shared/commands/menus'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { scriptCommandIds } from '../src/shared/scripting/catalog'

const brief = (entry: MenuEntry) => entry.kind === 'command' ? entry.nativeId : entry.kind === 'separator' ? '-' : entry.kind === 'role' ? `role:${entry.role}` : `submenu:${entry.nativeId}`
const raw = (menu: MenuId, platform: Platform) => buildMenuModel(menu, platform).map(brief)
/** What a native menu shows: the model without empty submenus. */
const outline = (menu: MenuId, platform: Platform) => pruneMenu(buildMenuModel(menu, platform), () => true, id => buildMenuModel(id, platform)).map(brief)

describe('menu model', () => {
  it('builds the menubar from the catalogue and the extras', () => {
    const windowMenu = ['window.explorer', 'window.editor', 'window.output', 'view.toggleResultsPane', '-', 'document.next', 'document.previous', 'file.closeAll', '-', 'layout.save@window', 'layout.load@window', 'layout.reset@window']
    for (const platform of ['win32', 'linux'] as const) {
      // Exit (Windows) and Quit (Linux): macOS quits from its app menu.
      expect(outline('file', platform)).toEqual(['connection.connect', 'connection.disconnect', 'connection.reconnect', '-', 'file.new', 'file.open', 'file.save', 'file.saveAs', 'file.saveAll', '-', 'file.close', '-', 'submenu:file.recent', '-', 'window.close'])
      expect(outline('window', platform)).toEqual(windowMenu)
    }
    expect(outline('file', 'darwin')).toEqual(['connection.connect', 'connection.disconnect', 'connection.reconnect', '-', 'file.new', 'file.open', 'file.save', 'file.saveAs', 'file.saveAll', '-', 'file.close', '-', 'submenu:file.recent'])
    expect(outline('window', 'darwin')).toEqual([...windowMenu, '-', 'role:minimize', 'role:zoom'])
    for (const platform of platforms) {
      // SSMS's Edit menu: its submenus in the Visual Studio shell's order, Advanced before Bookmarks.
      expect(outline('edit', platform)).toEqual(['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll', '-', 'submenu:edit.findReplace', 'edit.goToLine', '-',
        'submenu:edit.advanced', 'submenu:edit.bookmarks', 'submenu:edit.intellisense'])
      expect(outline('edit.findReplace', platform)).toEqual(['edit.find', 'edit.replace', '-', 'edit.findNext', 'edit.findPrevious'])
      // Word Wrap is here, where SSMS has it, and not in View.
      expect(outline('edit.advanced', platform)).toEqual(['edit.makeUppercase', 'edit.makeLowercase', '-', 'editor.toggleWhitespace', 'editor.toggleWordWrap', '-', 'edit.commentLines', 'edit.uncommentLines',
        'edit.toggleLineComment', '-', 'edit.increaseIndent', 'edit.decreaseIndent'])
      expect(outline('edit.bookmarks', platform)).toEqual(['edit.toggleBookmark', '-', 'edit.previousBookmark', 'edit.nextBookmark', '-', 'edit.clearBookmarks', '-', 'edit.previousBookmarkInDocument', 'edit.nextBookmarkInDocument'])
      expect(outline('edit.intellisense', platform)).toEqual(['edit.insertSnippet', 'edit.surroundWith'])
      expect(outline('view', platform)).toEqual(['workbench.showCommands', 'workbench.quickOpen', '-', 'layout.save', 'layout.load', 'layout.reset', '-', 'submenu:view.theme', '-',
        'view.zoomIn', 'view.zoomOut', 'view.resetZoom', 'view.toggleFullScreen', '-', 'developer.reloadWindow', 'developer.toggleDevTools'])
      expect(outline('query', platform)).toEqual(['submenu:query.connection', 'query.changeDatabase', '-', 'query.execute', 'query.cancel'])
      expect(raw('query', platform)).toEqual(outline('query', platform))
      expect(outline('query.connection', platform)).toEqual(['connection.connect@query.connection', 'query.disconnect', 'query.disconnectAll', 'connection.reconnect@query.connection', '-', 'query.changeConnection', 'connection.environment'])
      expect(outline('theme', platform)).toEqual(['preferences.colorTheme'])
      expect(outline('tools', platform)).toEqual(['preferences.options'])
    }
    expect(buildMenuModel('file', 'win32').at(-1)).toMatchObject({ id: 'window.close', title: 'Exit', role: 'quit', accelerator: 'Alt+F4' })
    expect(buildMenuModel('file', 'linux').at(-1)).toMatchObject({ id: 'window.close', title: 'Quit', role: 'quit', accelerator: 'Ctrl+Q' })
    expect(buildMenuModel('file', 'linux').at(-1)).not.toHaveProperty('mnemonic')
    expect(applicationMenus.map(menu => menu.id)).toEqual(['file', 'edit', 'view', 'query', 'tools', 'window', 'help'])
  })
  it('places submenus like commands, with their own native ids', () => {
    const submenu = (menu: MenuId, platform: Platform) => buildMenuModel(menu, platform).filter(entry => entry.kind === 'submenu')
    expect(submenu('view', 'linux')).toEqual([{ kind: 'submenu', id: 'theme', nativeId: 'view.theme', title: 'Theme', mnemonic: 'h', dynamic: 'theme' }])
    expect(submenu('editor.context', 'win32')).toEqual([{ kind: 'submenu', id: 'query.connection', nativeId: 'query.connection@editor.context', title: 'Connection', mnemonic: 'o' }])
    expect(submenu('edit', 'darwin').map(entry => entry.kind === 'submenu' && [entry.nativeId, entry.title, entry.mnemonic])).toEqual([
      ['edit.findReplace', 'Find and Replace', 'f'], ['edit.advanced', 'Advanced', 'v'], ['edit.bookmarks', 'Bookmarks', 'k'], ['edit.intellisense', 'IntelliSense', 'i']
    ])
    // New (Tables only) comes first, then Script as.
    const [newMenu, scriptAs] = submenu('explorer.context', 'darwin')
    expect(newMenu).toMatchObject({ id: 'explorer.new', nativeId: 'explorer.new', title: 'New', mnemonic: 'n' })
    expect(newMenu.kind === 'submenu' && newMenu.when && [evaluateWhen(newMenu.when, { explorerFolder: 'tables' }), evaluateWhen(newMenu.when, { explorerFolder: 'views' })]).toEqual([true, false])
    expect(scriptAs).toMatchObject({ id: 'explorer.scriptAs', nativeId: 'explorer.scriptAs', title: 'Script as', dynamicTitle: 'scriptAs' })
    expect(scriptAs.kind === 'submenu' && scriptAs.when && [evaluateWhen(scriptAs.when, { explorerScriptTitle: 'table', explorerNode: 'table' }), evaluateWhen(scriptAs.when, { explorerScriptTitle: '', explorerNode: 'database' }),
      evaluateWhen(scriptAs.when, { explorerScriptTitle: 'table', explorerNode: 'background' })]).toEqual([true, false, false])
    expect(submenu('explorer.scriptAs', 'win32').map(entry => entry.kind === 'submenu' && [entry.nativeId, entry.title, entry.mnemonic])).toEqual([
      ['explorer.scriptAs.create', 'CREATE To', 'c'], ['explorer.scriptAs.alter', 'ALTER To', 'a'], ['explorer.scriptAs.createOrAlter', 'CREATE OR ALTER To', 'r'],
      ['explorer.scriptAs.drop', 'DROP To', 'd'], ['explorer.scriptAs.dropAndCreate', 'DROP And CREATE To', 'n'], ['explorer.scriptAs.select', 'SELECT To', 's'],
      ['explorer.scriptAs.insert', 'INSERT To', 'i'], ['explorer.scriptAs.update', 'UPDATE To', 'u'], ['explorer.scriptAs.delete', 'DELETE To', 'e'], ['explorer.scriptAs.execute', 'EXECUTE To', 'x']
    ])
    expect(buildMenuModel('explorer.scriptAs', 'linux').map(entry => entry.kind)).toEqual(['submenu', 'submenu', 'submenu', 'submenu', 'submenu', 'separator', 'submenu', 'submenu', 'submenu', 'submenu', 'separator', 'submenu'])
    expect(menuRoots('explorer.scriptAs.create')).toEqual(['explorer.context'])
    expect(menuRoots('query.connection')).toEqual(['query', 'editor.context'])
    expect(menuRoots('theme')).toEqual(['view'])
    expect(menuRoots('file')).toEqual(['file'])
    expect(nativeMenuIds).toEqual(['file', 'file.recent', 'edit', 'edit.findReplace', 'edit.advanced', 'edit.bookmarks', 'edit.intellisense', 'view', 'theme', 'query', 'query.connection', 'tools', 'window', 'help'])
    expect(menuRoots('edit.bookmarks')).toEqual(['edit'])
  })
  it('carries placement mnemonics, platform titles, and compiled when clauses', () => {
    expect(buildMenuModel('file', 'win32').find(entry => entry.kind === 'command' && entry.id === 'file.saveAs')).toMatchObject({ title: 'Save As…', mnemonic: 'a' })
    expect(buildMenuModel('window', 'linux').find(entry => entry.kind === 'command' && entry.nativeId === 'layout.load@window')).toMatchObject({ title: 'Load Window Layout…', mnemonic: 'a' })
    for (const platform of platforms) for (const menu of menuIds) for (const entry of buildMenuModel(menu, platform)) {
      if (entry.kind !== 'command') continue
      const command = commandDescriptor(entry.id)
      expect(entry.title, entry.nativeId).toBe(command.menus!.find(placement => placement.menu === menu)!.title ?? command.platformTitles?.[platform] ?? command.title)
      expect(entry.role, entry.nativeId).toBe(command.role)
      const when = command.menus!.find(placement => placement.menu === menu)!.when
      expect(entry.when, entry.nativeId).toEqual(when === undefined ? undefined : compileWhen(when))
    }
    const float = buildMenuModel('dockTab.context', 'linux').find(entry => entry.kind === 'command' && entry.id === 'pane.float')
    expect(float?.kind === 'command' && float.when && [evaluateWhen(float.when, { paneFloating: false }), evaluateWhen(float.when, { paneFloating: true })]).toEqual([true, false])
  })
  it('prunes hidden entries, empty submenus, and stray separators', () => {
    const command = (id: CommandId, when?: string): MenuEntry => ({ kind: 'command', id, nativeId: id, title: id, toggle: false, ...(when ? { when: compileWhen(when) } : {}) })
    const submenu = (id: SubmenuId, when?: string, dynamic?: 'theme'): MenuEntry => ({ kind: 'submenu', id, nativeId: id, title: id, ...(when ? { when: compileWhen(when) } : {}), ...(dynamic ? { dynamic } : {}) })
    const separator: MenuEntry = { kind: 'separator' }
    const trees: Partial<Record<SubmenuId, MenuEntry[]>> = {
      'explorer.scriptAs': [submenu('explorer.scriptAs.create')], 'explorer.scriptAs.create': [command('file.save', 'queryRunning')],
      'query.connection': [command('file.open')], theme: []
    }
    const children = (id: SubmenuId) => trees[id] ?? []
    const keep = (context: Record<string, boolean>) => (entry: MenuEntry) => entry.kind !== 'command' && entry.kind !== 'submenu' || !entry.when || evaluateWhen(entry.when, context)
    const entries = [separator, command('file.new', 'hasConnection'), separator, submenu('explorer.scriptAs'), separator, separator, command('file.close'), submenu('query.connection', '!hasConnection'), separator, submenu('theme', undefined, 'theme'), separator]
    expect(pruneMenu(entries, keep({}), children).map(brief)).toEqual(['file.close', 'submenu:query.connection', '-', 'submenu:theme'])
    expect(pruneMenu(entries, keep({ hasConnection: true, queryRunning: true }), children).map(brief)).toEqual(['file.new', '-', 'submenu:explorer.scriptAs', '-', 'file.close', '-', 'submenu:theme'])
    expect(pruneMenu([command('file.new', 'queryRunning'), separator, command('file.open', 'queryRunning')], keep({}), children)).toEqual([])
    // Nesting deeper than maxSubmenuDepth counts as empty, so a cycle cannot recurse forever.
    const cycle = (id: SubmenuId) => id === 'theme' ? [submenu('query.connection')] : [submenu('theme'), command('file.new')]
    expect(pruneMenu([submenu('theme')], () => true, cycle, 0).map(brief)).toEqual(['submenu:theme'])
    expect(pruneMenu([submenu('query.connection')], () => true, () => [submenu('query.connection')], 0)).toEqual([])
    expect(trimSeparators([separator, separator])).toEqual([])
  })
  it('never starts, ends, or doubles a separator', () => {
    for (const platform of platforms) for (const menu of menuIds) {
      const entries = raw(menu, platform)
      expect(entries[0], `${platform} ${menu}`).not.toBe('-')
      expect(entries.at(-1), `${platform} ${menu}`).not.toBe('-')
      expect(entries.some((entry, index) => entry === '-' && entries[index + 1] === '-'), `${platform} ${menu}`).toBe(false)
    }
  })
  it('labels commands with menu titles and platform accelerators', () => {
    const find = (menu: Parameters<typeof buildMenuModel>[0], platform: Platform, nativeId: string) => buildMenuModel(menu, platform).find(entry => entry.kind === 'command' && entry.nativeId === nativeId)
    expect(find('file', 'win32', 'file.open')).toEqual({ kind: 'command', id: 'file.open', nativeId: 'file.open', title: 'Open…', mnemonic: 'o', toggle: false, accelerator: 'Ctrl+O' })
    expect(find('file', 'darwin', 'file.saveAs')).toMatchObject({ title: 'Save As…', accelerator: 'Cmd+Shift+S' })
    expect(find('edit', 'linux', 'edit.redo')).toMatchObject({ accelerator: 'Ctrl+Y' })
    expect(find('edit', 'darwin', 'edit.redo')).toMatchObject({ accelerator: 'Cmd+Shift+Z' })
    expect(find('edit.findReplace', 'darwin', 'edit.replace')).toMatchObject({ title: 'Quick Replace', accelerator: 'Cmd+Alt+F' })
    expect(find('edit.findReplace', 'win32', 'edit.findNext')).toMatchObject({ title: 'Find Next', accelerator: 'F3' })
    expect(find('edit.advanced', 'win32', 'edit.commentLines')).toEqual({ kind: 'command', id: 'edit.commentLines', nativeId: 'edit.commentLines', title: 'Comment Selection', mnemonic: 'm', toggle: false })
    // A bridge chord shows as a label in custom menus, but is no accelerator: Electron accelerators are single chords.
    expect(find('edit.bookmarks', 'win32', 'edit.toggleBookmark')).not.toHaveProperty('accelerator')
    expect(find('edit.advanced', 'linux', 'edit.makeUppercase')).toMatchObject({ accelerator: 'Ctrl+Shift+U' })
    expect(find('edit', 'darwin', 'edit.goToLine')).not.toHaveProperty('accelerator')
    expect(find('query', 'linux', 'query.execute')).toMatchObject({ title: 'Execute', accelerator: 'F5' })
    // On macOS a key equivalent without ⌘ would reach the menu before the page, running Execute from any pane.
    for (const [menu, id] of [['query', 'query.execute'], ['window', 'window.explorer'], ['window', 'document.next'], ['window', 'document.previous']] as const) {
      expect(find(menu, 'darwin', id), id).toMatchObject({ kind: 'command', id })
      expect(find(menu, 'darwin', id), id).not.toHaveProperty('accelerator')
    }
    expect(find('query', 'win32', 'query.cancel')).not.toHaveProperty('accelerator')
    expect(find('edit.advanced', 'linux', 'editor.toggleWordWrap')).toEqual({ kind: 'command', id: 'editor.toggleWordWrap', nativeId: 'editor.toggleWordWrap', title: 'Word Wrap', mnemonic: 'w', toggle: true, accelerator: 'Alt+Z' })
    expect(find('edit.advanced', 'darwin', 'editor.toggleWordWrap')).not.toHaveProperty('accelerator')
    expect(find('window', 'win32', 'layout.reset@window')).toMatchObject({ id: 'layout.reset', title: 'Reset Window Layout' })
    expect(find('window', 'win32', 'window.explorer')).toEqual({ kind: 'command', id: 'window.explorer', nativeId: 'window.explorer', title: 'Object Explorer', mnemonic: 'o', toggle: false, accelerator: 'F8' })
    expect(find('window', 'linux', 'document.next')).toMatchObject({ accelerator: 'Ctrl+Tab' })
    expect(find('view', 'win32', 'workbench.showCommands')).toEqual({ kind: 'command', id: 'workbench.showCommands', nativeId: 'workbench.showCommands', title: 'Command Palette…', mnemonic: 'c', toggle: false, accelerator: 'Ctrl+Shift+P' })
    expect(find('view', 'darwin', 'workbench.quickOpen')).toMatchObject({ title: 'Go to Query…', accelerator: 'Cmd+P' })
    expect(find('query', 'linux', 'query.changeDatabase')).toMatchObject({ title: 'Change Database…', accelerator: 'Ctrl+U' })
    // Tools › Options… carries macOS's settings key, ⌘,; Windows and Linux have none.
    expect(find('tools', 'darwin', 'preferences.options')).toEqual({ kind: 'command', id: 'preferences.options', nativeId: 'preferences.options', title: 'Options…', mnemonic: 'o', toggle: false, accelerator: 'Cmd+,' })
    expect(find('tools', 'win32', 'preferences.options')).not.toHaveProperty('accelerator')
    expect(find('file', 'darwin', 'connection.disconnect')).toEqual({ kind: 'command', id: 'connection.disconnect', nativeId: 'connection.disconnect', title: 'Disconnect from Server…', mnemonic: 'd', toggle: false })
  })
  it('gives each command and submenu item a unique native id, the first placement keeping the bare id', () => {
    for (const platform of platforms) {
      const ids = menuIds.flatMap(menu => buildMenuModel(menu, platform).flatMap(entry => entry.kind === 'command' || entry.kind === 'submenu' ? [entry.nativeId] : []))
      expect(new Set(ids).size, platform).toBe(ids.length)
      for (const legacy of ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'edit.undo', 'edit.redo', 'window.explorer', 'window.editor', 'window.output', 'layout.save', 'layout.load', 'layout.reset', 'view.theme']) {
        expect(ids, `${platform} ${legacy}`).toContain(legacy)
      }
    }
    expect(nativeItemId('layout.save', 'view')).toBe('layout.save')
    expect(nativeItemId('layout.save', 'window')).toBe('layout.save@window')
    expect(() => nativeItemId('file.new', 'edit')).toThrow('file.new has no placement in the edit menu')
  })
  it('finds menus by mnemonic', () => {
    expect(['f', 'E', 'v', 'q', 't', 'W'].map(menuForMnemonic)).toEqual(['file', 'edit', 'view', 'query', 'tools', 'window'])
    expect(['x', '', 'fi', 'alt+f', 'f10'].map(menuForMnemonic)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })
})

describe('mnemonics', () => {
  it('underline the first occurrence that starts a word, else the first occurrence', () => {
    expect(mnemonicIndex('Save As…', 'a')).toBe(5)
    expect(mnemonicIndex('Save As…', 'S')).toBe(0)
    expect(mnemonicIndex('Connect to Server…', 'e')).toBe(4)
    expect(mnemonicIndex('Toggle Line Comment', 'l')).toBe(7)
    expect(mnemonicIndex('Create Custom Theme…', 't')).toBe(14)
    expect(mnemonicIndex('Cut', 't')).toBe(2)
    expect(mnemonicIndex('Select Top 1000 Rows', '1')).toBe(11)
    expect(mnemonicIndex('Execute', 'q')).toBe(-1)
  })
  it('assign explicit letters first, then free letters that start words, then any free letter', () => {
    const items = [{ title: 'Connect to Server…', mnemonic: 'e' }, { title: 'Exit' }, null, { title: 'Quit' }, { title: 'New Query', mnemonic: 'n' }, { title: 'Next Query' }]
    expect(assignMnemonics(items)).toEqual([4, 1, -1, 0, 0, 3])
    // Explicit duplicates both keep their letter; theme names (null) and titles without a free letter get none.
    expect(assignMnemonics([{ title: 'Copy', mnemonic: 'c' }, { title: 'Cut', mnemonic: 'c' }, { title: 'Dark Theme Ünïcode', mnemonic: null }, { title: 'C' }, { title: '…' }])).toEqual([0, 0, -1, -1, -1])
    expect(assignMnemonics([{ title: 'Missing', mnemonic: 'z' }, { title: 'Zoom' }])).toEqual([-1, 0])
    expect(assignMnemonics([{ title: 'Ünïcode' }, { title: '𝒜b' }, { title: '2 Up' }])).toEqual([0, 2, 0])
  })
})

describe('context menu model', () => {
  it('lists each context menu\'s commands through its submenus', () => {
    // The editor menu's Connection submenu is Query › Connection.
    expect(contextCommandIds('editor.context')).toEqual(['edit.cut', 'edit.copy', 'edit.paste', 'query.execute', 'query.cancel', 'workbench.showCommands', 'connection.connect', 'connection.environment', 'connection.reconnect',
      'query.changeConnection', 'query.disconnect', 'query.disconnectAll', 'edit.insertSnippet', 'edit.surroundWith'])
    expect(contextCommandIds('documentTab.context')).toEqual(['file.save', 'file.saveAs', 'file.close', 'file.closeOthers', 'file.closeAll', 'file.copyPath', 'file.revealInFolder'])
    expect(contextCommandIds('dockTab.context')).toEqual(['pane.float', 'pane.dock', 'pane.close'])
    expect(contextCommandIds('input.context')).toEqual(['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'])
    for (const menu of contextMenuIds) expect(contextCommandIds(menu), menu).toEqual(commandIds.filter(id => menuIds.some(inner => menuRoots(inner).includes(menu) && commandDescriptor(id).menus?.some(placement => placement.menu === inner))))
    expect(contextMenuRequestSchema.safeParse({ token: 1, menu: 'editor.context', x: 0, y: 0, visible: ['query.execute'], disabled: [], checked: [] }).success).toBe(true)
    expect(contextMenuRequestSchema.safeParse({ token: 1, menu: 'editor.context', x: 0, y: 0, visible: ['file.save'], disabled: [], checked: [] }).success).toBe(false)
  })
  const trees: Partial<Record<ContextMenuId, CommandId[]>> = { 'editor.context': ['query.execute', 'query.cancel', 'editor.toggleWordWrap'], 'documentTab.context': ['file.save', 'file.close'] }
  const schema = createContextMenuRequestSchema(menu => trees[menu] ?? [])
  const request = { token: 7, menu: 'editor.context', x: 10, y: 32767, visible: ['query.execute', 'query.cancel', 'editor.toggleWordWrap'], disabled: ['query.cancel'], checked: ['editor.toggleWordWrap'] }
  it('accepts a request for commands of its own menu', () => {
    expect(schema.parse(request)).toEqual(request)
    expect(schema.safeParse({ ...request, token: 2 ** 31 - 1, x: 0, disabled: [], checked: [] }).success).toBe(true)
  })
  it('rejects foreign ids, ids that are not visible, duplicates, too many, and malformed numbers', () => {
    for (const change of [
      { visible: ['file.save'] }, { visible: ['file.new'] }, { visible: ['__proto__'] }, { visible: [] }, { disabled: ['file.save'] }, { visible: ['query.execute'], disabled: ['query.cancel'], checked: [] },
      { visible: ['query.execute'], disabled: [], checked: ['editor.toggleWordWrap'] }, { checked: ['query.execute'] }, { visible: ['query.execute', 'query.execute'] }, { disabled: ['query.cancel', 'query.cancel'] },
      { visible: Array(65).fill('query.execute') }, { menu: 'documentTab.context' }, { menu: 'nope.context' }, { x: -1 }, { y: 32768 }, { x: 1.5 }, { token: 0 }, { token: 2 ** 31 }, { token: 1.5 },
      { token: '7' }, { extra: true }
    ]) expect(schema.safeParse({ ...request, ...change }).success, JSON.stringify(change)).toBe(false)
    for (const key of ['token', 'menu', 'x', 'y', 'visible', 'disabled', 'checked']) {
      const partial: Record<string, unknown> = { ...request }
      delete partial[key]
      expect(schema.safeParse(partial).success, key).toBe(false)
    }
  })
})

const themeModel = { theme: { preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, themes: [] } } as const
function template(platform: NodeJS.Platform, checked: readonly CommandId[] = []) {
  const actions = { command: vi.fn<ApplicationMenuActions['command']>(), isChecked: vi.fn<ApplicationMenuActions['isChecked']>(id => checked.includes(id)), pageHasKeyFocus: () => true, sendActionToFirstResponder: vi.fn(), setTheme: vi.fn(), createTheme: vi.fn(), openThemesFolder: vi.fn(), reloadThemes: vi.fn(), openRecent: vi.fn(), clearRecent: vi.fn() }
  return { actions, items: applicationMenuTemplate({ theme: { ...themeModel.theme, themes: [] } }, actions, platform) }
}
function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap(item => [item, ...Array.isArray(item.submenu) ? flatten(item.submenu) : []])
}
const item = (items: readonly MenuItemConstructorOptions[], id: string) => flatten(items).find(entry => entry.id === id)!
const click = (entry: MenuItemConstructorOptions, target: Partial<Electron.MenuItem> = {}) => (entry.click as (menuItem: Partial<Electron.MenuItem>) => void)(target)

describe('application menu template', () => {
  it('follows the model on every platform, with the app menu and Window role on macOS', () => {
    for (const platform of platforms) {
      const { items } = template(platform)
      const menubar = items.filter(entry => entry.id)
      expect(menubar.map(entry => entry.id), platform).toEqual(['menu.file', 'menu.edit', 'menu.view', 'menu.query', 'menu.tools', 'menu.window', 'menu.help'])
      expect(items.map(entry => entry.id ?? entry.role), platform).toEqual(platform === 'darwin' ? ['appMenu', 'menu.file', 'menu.edit', 'menu.view', 'menu.query', 'menu.tools', 'menu.window', 'menu.help'] : menubar.map(entry => entry.id))
      expect(item(items, 'menu.window').role, platform).toBe(platform === 'darwin' ? 'window' : undefined)
      for (const top of menubar) {
        const menu = top.id!.slice('menu.'.length) as Parameters<typeof buildMenuModel>[0]
        // Hidden copies of role items only carry further keys (Zoom In's Ctrl+Shift+=).
        const entries = (top.submenu as MenuItemConstructorOptions[]).filter(entry => entry.visible !== false)
          .map(entry => entry.type === 'separator' ? '-' : entry.role && !entry.id ? `role:${entry.role}` : entry.submenu ? `submenu:${entry.id}` : entry.id)
        expect(entries, `${platform} ${menu}`).toEqual(outline(menu, platform))
      }
    }
  })
  it('labels command items and never registers their accelerators', () => {
    for (const platform of platforms) {
      const commands = flatten(template(platform).items).filter(entry => entry.id && !entry.role && commandIds.includes(entry.id.split('@')[0] as CommandId))
      expect(commands.length, platform).toBeGreaterThan(20)
      for (const entry of commands) expect(entry.registerAccelerator, `${platform} ${entry.id}`).toBe(false)
    }
    const { items } = template('win32')
    expect(item(items, 'file.new')).toMatchObject({ label: 'New Query', accelerator: 'Ctrl+N', type: 'normal' })
    expect(item(items, 'layout.save@window')).toMatchObject({ label: 'Save Window Layout…' })
    expect(item(items, 'layout.save@window')).not.toHaveProperty('accelerator')
    expect(item(items, 'editor.toggleWordWrap')).toMatchObject({ label: 'Word Wrap', type: 'checkbox', accelerator: 'Alt+Z' })
    expect(item(template('darwin').items, 'file.new')).toMatchObject({ accelerator: 'Cmd+N' })
    expect(item(items, 'view.theme').submenu).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'theme.mode.dark' })]))
  })
  it('renders role-backed commands as Electron roles with the catalogue\'s accelerator or none', () => {
    for (const platform of platforms) {
      const roles = flatten(template(platform).items).filter(entry => entry.role && entry.id && commandIds.includes(entry.id.split('@')[0] as CommandId))
      // The macOS menu bar runs Delete and Select All through their handlers, which reach the query editor.
      expect(roles.map(entry => entry.id), platform).toEqual([...platform === 'darwin' ? [] : ['window.close'], 'edit.cut', 'edit.copy', 'edit.paste', ...platform === 'darwin' ? [] : ['edit.delete', 'edit.selectAll'],
        'view.zoomIn', 'view.zoomOut', 'view.resetZoom', 'view.toggleFullScreen', 'developer.reloadWindow', 'developer.toggleDevTools'])
      for (const entry of roles) {
        const id = entry.id as CommandId
        const label = menuTitle(id, platform, commandDescriptor(id).menus?.[0]?.title)
        expect(entry, `${platform} ${id}`).toEqual({ id, label, role: commandDescriptor(id).role, accelerator: menuAccelerator(id, platform) ?? '' })
      }
      // Electron's own role accelerators never apply: every role item names its accelerator, if only as none.
      for (const entry of flatten(template(platform).items)) if (entry.role && !['appMenu', 'window', 'minimize', 'zoom'].includes(entry.role)) expect(entry, `${platform} ${entry.role}`).toHaveProperty('accelerator')
    }
    const { items } = template('linux')
    expect(item(items, 'edit.copy')).toMatchObject({ role: 'copy', accelerator: 'Ctrl+C' })
    expect(item(items, 'edit.delete')).toMatchObject({ role: 'delete', accelerator: 'Delete' })
    expect(item(items, 'view.zoomIn')).toMatchObject({ role: 'zoomIn', accelerator: 'Ctrl+=' })
    // macOS menus show only keys with ⌘, so Delete has none there.
    expect(item(template('darwin').items, 'edit.delete')).toMatchObject({ label: 'Delete', type: 'normal' })
    expect(item(template('darwin').items, 'edit.delete')).not.toHaveProperty('accelerator')
    expect(item(template('darwin').items, 'edit.selectAll')).toMatchObject({ label: 'Select All', accelerator: 'Cmd+A', type: 'normal' })
    expect(item(template('darwin').items, 'view.toggleFullScreen')).toMatchObject({ role: 'togglefullscreen', accelerator: 'Cmd+Ctrl+F' })
    expect(item(template('win32').items, 'window.close')).toMatchObject({ label: 'Exit', role: 'quit', accelerator: 'Alt+F4' })
    expect(item(template('linux').items, 'window.close')).toMatchObject({ label: 'Quit', role: 'quit', accelerator: 'Ctrl+Q' })
  })
  it('never gives Reload a key: Ctrl+R and ⌘R toggle the results pane', () => {
    const reloadKeys = /^(?:Ctrl|Cmd|CmdOrCtrl|CommandOrControl|Control|Command)\+(?:Shift\+)?R$/i
    for (const platform of platforms) {
      const entries = flatten(template(platform).items)
      const reload = entries.filter(entry => entry.role === 'reload' || entry.role === 'forceReload' || entry.id?.startsWith('developer.reloadWindow'))
      expect(reload.map(entry => [entry.id, entry.role, entry.accelerator]), platform).toEqual([['developer.reloadWindow', 'reload', '']])
      const keyed = entries.filter(entry => typeof entry.accelerator === 'string' && reloadKeys.test(entry.accelerator))
      expect(keyed.map(entry => [entry.id, entry.role, entry.registerAccelerator]), platform).toEqual([['view.toggleResultsPane', undefined, false]])
    }
    expect(item(template('darwin').items, 'view.toggleResultsPane')).toMatchObject({ label: 'Show Results Pane', type: 'checkbox', accelerator: 'Cmd+R' })
  })
  it('sends clicks as command ids, and keeps checkboxes on the renderer\'s state', () => {
    const { items, actions } = template('linux', ['editor.toggleWordWrap'])
    click(item(items, 'layout.load@window'))
    click(item(items, 'query.execute'))
    const target: Partial<Electron.MenuItem> = { checked: false }
    click(item(items, 'editor.toggleWordWrap'), target)
    expect(target.checked).toBe(true)
    expect(actions.command.mock.calls).toEqual([['layout.load'], ['query.execute'], ['editor.toggleWordWrap']])
    const plain: Partial<Electron.MenuItem> = { checked: false }
    click(item(template('linux').items, 'editor.toggleWordWrap'), plain)
    expect(plain.checked).toBe(false)
  })
})

describe('menu state', () => {
  it('covers every command in a native menu, except Electron roles, and every toggle', () => {
    // The other theme commands are in the palette only: the native Theme submenu keeps PR1's items for them.
    const roles = ['window.close', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll', 'view.zoomIn', 'view.zoomOut', 'view.resetZoom', 'view.toggleFullScreen', 'developer.reloadWindow', 'developer.toggleDevTools']
    // Context-menu commands and the keyboard-only ones are not in the native menu bar either.
    const unplaced = ['file.closeOthers', 'file.copyPath', 'file.revealInFolder', 'workbench.showContextMenu', 'explorer.refresh', 'preferences.createTheme', 'preferences.openThemesFolder',
      'preferences.reloadThemes', 'preferences.setTheme', 'pane.float', 'pane.dock', 'pane.close', 'explorer.newQuery', 'explorer.selectTopRows', 'explorer.rename', 'explorer.delete', 'explorer.properties', 'explorer.newTable', ...scriptCommandIds,
      'explorer.scriptAs', 'explorer.modify', 'explorer.cancelScripting', 'explorer.copyName', 'output.copy', 'output.copyWithHeaders', 'output.selectAll', 'backend.restart',
      'connection.removeLost', 'explorer.stop', 'explorer.collapseAll', 'explorer.filter', 'explorer.filterLoaded', 'explorer.removeFilter', 'window.switchPane',
      'output.saveResultsAs', 'output.closeResults', 'output.openValue', 'editor.toggleOvertype', 'file.openRecent', 'file.clearRecent', 'file.recoverUnsaved', 'editor.toggleLineNumbers',
      // The table designer's menu and toolbar strip; its menubar menu is a follow-up.
      'tableDesigner.setPrimaryKey', 'tableDesigner.removePrimaryKey', 'tableDesigner.insertColumn', 'tableDesigner.deleteColumn', 'tableDesigner.generateChangeScript', 'tableDesigner.properties', 'tableDesigner.stop']
    expect(menuCommandIds).toEqual(commandIds.filter(id => ![...roles, ...unplaced].includes(id)))
    // Query › Connection is a native submenu too.
    for (const id of ['preferences.colorTheme', 'connection.connect', 'query.disconnect', 'query.disconnectAll', 'query.changeConnection', 'file.closeAll', 'view.toggleResultsPane'] as const) expect(menuCommandIds).toContain(id)
    for (const id of commandIds) {
      const placed = commandDescriptor(id).menus?.some(placement => nativeMenuIds.includes(placement.menu)) ?? false
      expect(menuCommandIds.includes(id), id).toBe(placed && !commandDescriptor(id).role)
    }
    expect(toggleCommandIds).toEqual(['view.toggleResultsPane', 'editor.toggleWordWrap', 'editor.toggleOvertype', 'editor.toggleWhitespace', 'editor.toggleLineNumbers'])
    // Main checks only toggles the schema names.
    expect(menuStateSchema.safeParse({ disabled: [], checked: ['editor.toggleWhitespace', 'editor.toggleLineNumbers'] }).success).toBe(true)
  })
  it('accepts unique catalogue ids only', () => {
    expect(menuStateSchema.parse({ disabled: ['file.save', 'query.cancel'], checked: ['editor.toggleWordWrap'] })).toEqual({ disabled: ['file.save', 'query.cancel'], checked: ['editor.toggleWordWrap'] })
    expect(menuStateSchema.safeParse({ disabled: [...menuCommandIds], checked: [] }).success).toBe(true)
    for (const value of [
      { disabled: ['file.nope'], checked: [] }, { disabled: ['window.close'], checked: [] }, { disabled: ['__proto__'], checked: [] }, { disabled: [], checked: ['file.new'] },
      { disabled: ['file.save', 'file.save'], checked: [] }, { disabled: [...menuCommandIds, 'file.new'], checked: [] }, { disabled: [], checked: [], extra: true },
      { disabled: [], checked: ['editor.toggleWordWrap', 'editor.toggleWordWrap'] }, { disabled: ['explorer.refresh'], checked: [] },
      { disabled: [] }, { checked: [] }, { disabled: 'file.save', checked: [] }, { disabled: [1], checked: [] }, null, [], 'file.save'
    ]) expect(menuStateSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
  })
})

/** A native menu shaped like Electron's: items with ids, enabled and checked flags, and submenus. */
function fakeMenu(): MenuLike & { all: MenuItemLike[] } {
  const entry = (id: string, submenu?: MenuLike): MenuItemLike => ({ id, enabled: true, checked: false, ...(submenu ? { submenu } : {}) })
  const theme = { items: [entry('theme.mode.dark'), entry('theme.reload')] }
  const items = [
    entry('menu.file', { items: [entry('file.new'), entry('file.save'), entry('')] }),
    entry('menu.view', { items: [entry('layout.save'), entry('editor.toggleWordWrap'), entry('view.theme', theme)] }),
    entry('menu.window', { items: [entry('layout.save@window'), entry('query.cancel')] })
  ]
  const all = flattenLike(items)
  return { items, all }
}
const flattenLike = (items: readonly MenuItemLike[]): MenuItemLike[] => items.flatMap(entry => [entry, ...entry.submenu ? flattenLike(entry.submenu.items) : []])
const states = (menu: { all: MenuItemLike[] }) => Object.fromEntries(menu.all.filter(entry => entry.id).map(entry => [entry.id, [entry.enabled, entry.checked]]))

describe('native menu bridge', () => {
  it('indexes command items, including duplicates and submenus', () => {
    const index = indexCommandItems(fakeMenu())
    expect([...index.keys()].sort()).toEqual(['editor.toggleWordWrap', 'file.new', 'file.save', 'layout.save', 'query.cancel'])
    expect(index.get('layout.save')!.map(entry => entry.id)).toEqual(['layout.save', 'layout.save@window'])
  })
  it('applies state in place and enables everything without one', () => {
    const menu = fakeMenu(), index = indexCommandItems(menu)
    applyMenuState(index, { disabled: ['file.save', 'layout.save'], checked: ['editor.toggleWordWrap'] })
    expect(states(menu)).toMatchObject({ 'file.new': [true, false], 'file.save': [false, false], 'layout.save': [false, false], 'layout.save@window': [false, false], 'editor.toggleWordWrap': [true, true], 'theme.mode.dark': [true, false] })
    applyMenuState(index, null)
    expect(menu.all.every(entry => entry.enabled && !entry.checked)).toBe(true)
  })
  it('validates renderer state, re-applies it after a rebuild, and resets', () => {
    let built = fakeMenu()
    const install = vi.fn()
    const bridge = new NativeMenuBridge({ build: () => (built = fakeMenu()), install })
    bridge.rebuild()
    expect(install).toHaveBeenCalledWith(built)
    expect(bridge.applyState({ disabled: ['query.cancel'], checked: ['editor.toggleWordWrap'] })).toBe(true)
    expect(states(built)).toMatchObject({ 'query.cancel': [false, false], 'editor.toggleWordWrap': [true, true] })
    expect(bridge.isChecked('editor.toggleWordWrap')).toBe(true)
    expect(bridge.applyState({ disabled: ['query.cancel'], checked: [], extra: 1 })).toBe(false)
    expect(bridge.applyState({ disabled: ['not.a.command'], checked: [] })).toBe(false)
    expect(bridge.isChecked('editor.toggleWordWrap')).toBe(true)
    const before = built
    bridge.rebuild()
    expect(built).not.toBe(before)
    expect(states(built)).toMatchObject({ 'query.cancel': [false, false], 'editor.toggleWordWrap': [true, true], 'file.new': [true, false] })
    bridge.reset()
    expect(built.all.every(entry => entry.enabled && !entry.checked)).toBe(true)
    expect(bridge.isChecked('editor.toggleWordWrap')).toBe(false)
  })
})
