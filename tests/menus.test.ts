import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from '../src/main/application-menu'
import { applyMenuState, indexCommandItems, NativeMenuBridge, type MenuItemLike, type MenuLike } from '../src/main/native-menu'
import { commandIds, type CommandId } from '../src/shared/commands/catalog'
import { platforms, type Platform } from '../src/shared/commands/keybindings'
import { applicationMenus, buildMenuModel, menuCommandIds, menuForMnemonic, menuIds, menuStateSchema, nativeItemId, toggleCommandIds, type MenuEntry } from '../src/shared/commands/menus'

const brief = (entry: MenuEntry) => entry.kind === 'command' ? entry.nativeId : entry.kind === 'separator' ? '-' : entry.kind === 'role' ? `role:${entry.role}` : `submenu:${entry.id}`
const outline = (menu: Parameters<typeof buildMenuModel>[0], platform: Platform) => buildMenuModel(menu, platform).map(brief)
const displayRoles = ['role:reload', 'role:toggleDevTools', 'role:resetZoom', 'role:zoomIn', 'role:zoomOut', 'role:togglefullscreen']

describe('menu model', () => {
  it('builds the menubar from the catalogue and the extras', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(outline('file', platform)).toEqual(['connection.connect', 'connection.disconnect', '-', 'file.new', 'file.open', 'file.save', 'file.saveAs', '-', 'file.close', '-', 'role:quit'])
      expect(outline('window', platform)).toEqual(['window.explorer', 'window.editor', 'window.output', '-', 'document.next', 'document.previous', '-', 'layout.save@window', 'layout.load@window', 'layout.reset@window'])
    }
    expect(outline('file', 'darwin')).toEqual(['connection.connect', 'connection.disconnect', '-', 'file.new', 'file.open', 'file.save', 'file.saveAs', '-', 'file.close'])
    expect(outline('window', 'darwin')).toEqual(['window.explorer', 'window.editor', 'window.output', '-', 'document.next', 'document.previous', '-', 'layout.save@window', 'layout.load@window', 'layout.reset@window', '-', 'role:minimize', 'role:zoom'])
    for (const platform of platforms) {
      expect(outline('edit', platform)).toEqual(['edit.undo', 'edit.redo', '-', 'role:cut', 'role:copy', 'role:paste', 'role:selectAll', '-', 'edit.find', 'edit.replace', '-', 'edit.toggleLineComment', 'edit.commentLines', 'edit.uncommentLines'])
      expect(outline('view', platform)).toEqual(['workbench.showCommands', 'workbench.quickOpen', '-', 'layout.save', 'layout.load', 'layout.reset', '-', 'editor.toggleWordWrap', '-', 'submenu:view.theme', '-', ...displayRoles])
      expect(outline('query', platform)).toEqual(['query.execute', 'query.cancel', '-', 'query.changeConnection', 'query.changeDatabase'])
      expect(outline('theme', platform)).toEqual(['preferences.colorTheme'])
    }
    expect(applicationMenus.map(menu => menu.id)).toEqual(['file', 'edit', 'view', 'query', 'window'])
  })
  it('never starts, ends, or doubles a separator', () => {
    for (const platform of platforms) for (const menu of menuIds) {
      const entries = outline(menu, platform)
      expect(entries[0], `${platform} ${menu}`).not.toBe('-')
      expect(entries.at(-1), `${platform} ${menu}`).not.toBe('-')
      expect(entries.some((entry, index) => entry === '-' && entries[index + 1] === '-'), `${platform} ${menu}`).toBe(false)
    }
  })
  it('labels commands with menu titles and platform accelerators', () => {
    const find = (menu: Parameters<typeof buildMenuModel>[0], platform: Platform, nativeId: string) => buildMenuModel(menu, platform).find(entry => entry.kind === 'command' && entry.nativeId === nativeId)
    expect(find('file', 'win32', 'file.open')).toEqual({ kind: 'command', id: 'file.open', nativeId: 'file.open', title: 'Open…', toggle: false, accelerator: 'Ctrl+O' })
    expect(find('file', 'darwin', 'file.saveAs')).toMatchObject({ title: 'Save As…', accelerator: 'Cmd+Shift+S' })
    expect(find('edit', 'linux', 'edit.redo')).toMatchObject({ accelerator: 'Ctrl+Y' })
    expect(find('edit', 'darwin', 'edit.redo')).toMatchObject({ accelerator: 'Cmd+Shift+Z' })
    expect(find('edit', 'darwin', 'edit.replace')).toMatchObject({ accelerator: 'Cmd+Alt+F' })
    expect(find('edit', 'win32', 'edit.commentLines')).toEqual({ kind: 'command', id: 'edit.commentLines', nativeId: 'edit.commentLines', title: 'Comment Selection', toggle: false })
    expect(find('query', 'darwin', 'query.execute')).toMatchObject({ title: 'Execute', accelerator: 'F5' })
    expect(find('query', 'win32', 'query.cancel')).not.toHaveProperty('accelerator')
    expect(find('view', 'linux', 'editor.toggleWordWrap')).toEqual({ kind: 'command', id: 'editor.toggleWordWrap', nativeId: 'editor.toggleWordWrap', title: 'Word Wrap', toggle: true, accelerator: 'Alt+Z' })
    expect(find('view', 'darwin', 'editor.toggleWordWrap')).not.toHaveProperty('accelerator')
    expect(find('window', 'win32', 'layout.reset@window')).toMatchObject({ id: 'layout.reset', title: 'Reset Window Layout' })
    expect(find('window', 'win32', 'window.explorer')).toEqual({ kind: 'command', id: 'window.explorer', nativeId: 'window.explorer', title: 'Object Explorer', toggle: false, accelerator: 'F8' })
    expect(find('window', 'darwin', 'document.next')).toMatchObject({ accelerator: 'Ctrl+Tab' })
    expect(find('view', 'win32', 'workbench.showCommands')).toEqual({ kind: 'command', id: 'workbench.showCommands', nativeId: 'workbench.showCommands', title: 'Command Palette…', toggle: false, accelerator: 'Ctrl+Shift+P' })
    expect(find('view', 'darwin', 'workbench.quickOpen')).toMatchObject({ title: 'Go to Query…', accelerator: 'Cmd+P' })
    expect(find('query', 'linux', 'query.changeDatabase')).toMatchObject({ title: 'Change Database…', accelerator: 'Ctrl+U' })
    expect(find('file', 'darwin', 'connection.disconnect')).toEqual({ kind: 'command', id: 'connection.disconnect', nativeId: 'connection.disconnect', title: 'Disconnect from Server…', toggle: false })
  })
  it('gives each command item a unique native id, the first placement keeping the bare command id', () => {
    for (const platform of platforms) {
      const ids = menuIds.flatMap(menu => buildMenuModel(menu, platform).flatMap(entry => entry.kind === 'command' ? [entry.nativeId] : []))
      expect(new Set(ids).size, platform).toBe(ids.length)
      for (const legacy of ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'edit.undo', 'edit.redo', 'window.explorer', 'window.editor', 'window.output', 'layout.save', 'layout.load', 'layout.reset']) {
        expect(ids, `${platform} ${legacy}`).toContain(legacy)
      }
    }
    expect(nativeItemId('layout.save', 'view')).toBe('layout.save')
    expect(nativeItemId('layout.save', 'window')).toBe('layout.save@window')
    expect(() => nativeItemId('file.new', 'edit')).toThrow('file.new has no placement in the edit menu')
  })
  it('finds menus by mnemonic', () => {
    expect(['f', 'E', 'v', 'q', 'W'].map(menuForMnemonic)).toEqual(['file', 'edit', 'view', 'query', 'window'])
    expect(['x', '', 'fi', 'alt+f', 'f10'].map(menuForMnemonic)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })
})

const themeModel = { theme: { preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, themes: [] } } as const
function template(platform: NodeJS.Platform, checked: readonly CommandId[] = []) {
  const actions = { command: vi.fn<ApplicationMenuActions['command']>(), isChecked: vi.fn<ApplicationMenuActions['isChecked']>(id => checked.includes(id)), setTheme: vi.fn(), createTheme: vi.fn(), openThemesFolder: vi.fn(), reloadThemes: vi.fn() }
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
      expect(menubar.map(entry => entry.id), platform).toEqual(['menu.file', 'menu.edit', 'menu.view', 'menu.query', 'menu.window'])
      expect(items.map(entry => entry.id ?? entry.role), platform).toEqual(platform === 'darwin' ? ['appMenu', 'menu.file', 'menu.edit', 'menu.view', 'menu.query', 'menu.window'] : menubar.map(entry => entry.id))
      expect(item(items, 'menu.window').role, platform).toBe(platform === 'darwin' ? 'window' : undefined)
      for (const top of menubar) {
        const menu = top.id!.slice('menu.'.length) as Parameters<typeof buildMenuModel>[0]
        const entries = (top.submenu as MenuItemConstructorOptions[]).map(entry => entry.type === 'separator' ? '-' : entry.role ? `role:${entry.role}` : entry.submenu ? `submenu:${entry.id}` : entry.id)
        expect(entries, `${platform} ${menu}`).toEqual(outline(menu, platform))
      }
    }
  })
  it('labels command items and never registers their accelerators', () => {
    for (const platform of platforms) {
      const commands = flatten(template(platform).items).filter(entry => entry.id && commandIds.includes(entry.id.split('@')[0] as CommandId))
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
  it('covers every command with a menubar placement and every toggle', () => {
    // The other theme commands are in the palette only: the Theme submenu keeps PR1's main-owned items for them.
    expect(menuCommandIds).toEqual(commandIds.filter(id => !['window.close', 'explorer.refresh', 'preferences.createTheme', 'preferences.openThemesFolder', 'preferences.reloadThemes'].includes(id)))
    expect(toggleCommandIds).toEqual(['editor.toggleWordWrap'])
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
