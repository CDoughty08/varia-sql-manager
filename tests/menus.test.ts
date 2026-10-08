import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from '../src/main/application-menu'
import { commandIds } from '../src/shared/commands/catalog'
import { platforms, type Platform } from '../src/shared/commands/keybindings'
import { applicationMenus, buildMenuModel, menuCommandIds, menuForMnemonic, menuIds, menuStateSchema, nativeItemId, toggleCommandIds, type MenuEntry } from '../src/shared/commands/menus'

const brief = (entry: MenuEntry) => entry.kind === 'command' ? entry.nativeId : entry.kind === 'separator' ? '-' : entry.kind === 'role' ? `role:${entry.role}` : `submenu:${entry.id}`
const outline = (menu: Parameters<typeof buildMenuModel>[0], platform: Platform) => buildMenuModel(menu, platform).map(brief)
const displayRoles = ['role:reload', 'role:toggleDevTools', 'role:resetZoom', 'role:zoomIn', 'role:zoomOut', 'role:togglefullscreen']

describe('menu model', () => {
  it('builds the menubar from the catalogue and the extras', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(outline('file', platform)).toEqual(['file.new', 'file.open', 'file.save', 'file.saveAs', '-', 'file.close', '-', 'role:quit'])
      expect(outline('window', platform)).toEqual(['window.explorer', 'window.editor', 'window.output', '-', 'layout.save@window', 'layout.load@window', 'layout.reset@window'])
    }
    expect(outline('file', 'darwin')).toEqual(['file.new', 'file.open', 'file.save', 'file.saveAs', '-', 'file.close'])
    expect(outline('window', 'darwin')).toEqual(['window.explorer', 'window.editor', 'window.output', '-', 'layout.save@window', 'layout.load@window', 'layout.reset@window', '-', 'role:minimize', 'role:zoom'])
    for (const platform of platforms) {
      expect(outline('edit', platform)).toEqual(['edit.undo', 'edit.redo', '-', 'role:cut', 'role:copy', 'role:paste', 'role:selectAll'])
      expect(outline('view', platform)).toEqual(['layout.save', 'layout.load', 'layout.reset', '-', 'submenu:view.theme', '-', ...displayRoles])
      expect(outline('query', platform)).toEqual(['query.execute', 'query.cancel'])
      expect(outline('theme', platform)).toEqual([])
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
    expect(find('query', 'darwin', 'query.execute')).toMatchObject({ title: 'Execute', accelerator: 'F5' })
    expect(find('window', 'win32', 'layout.reset@window')).toMatchObject({ id: 'layout.reset', title: 'Reset Window Layout' })
    expect(find('window', 'win32', 'window.explorer')).toEqual({ kind: 'command', id: 'window.explorer', nativeId: 'window.explorer', title: 'Object Explorer', toggle: false })
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
  // Commit 2 builds the native template from this model; until then it must describe today's menus exactly.
  it.each(['win32', 'linux'] as const)('matches the current application menu on %s', platform => {
    const command = vi.fn<ApplicationMenuActions['command']>()
    const template = applicationMenuTemplate({ theme: { preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, themes: [] } },
      { command, setTheme: vi.fn(), createTheme: vi.fn(), openThemesFolder: vi.fn(), reloadThemes: vi.fn() }, platform)
    const legacy = (item: MenuItemConstructorOptions) => [item.id ?? '', item.type === 'separator' ? '-' : item.label ?? `role:${item.role}`, item.accelerator?.replace('CmdOrCtrl', 'Ctrl') ?? '']
    const current = (entry: MenuEntry) => entry.kind === 'command' ? [entry.nativeId, entry.title, entry.accelerator ?? ''] : entry.kind === 'submenu' ? [entry.id, entry.title, ''] : entry.kind === 'role' ? ['', `role:${entry.role}`, ''] : ['', '-', '']
    for (const top of template) {
      const menu = top.id!.replace('menu.', '') as Parameters<typeof buildMenuModel>[0]
      const expected = (top.submenu as MenuItemConstructorOptions[]).map(legacy)
      // Today's Window layout items have no ids; the model names them layout.*@window.
      expect(buildMenuModel(menu, platform).map(current).map(([id, ...rest], index) => [expected[index]?.[0] === '' && id.includes('@') ? '' : id, ...rest]), menu).toEqual(expected)
    }
  })
  it('finds menus by mnemonic', () => {
    expect(['f', 'E', 'v', 'q', 'W'].map(menuForMnemonic)).toEqual(['file', 'edit', 'view', 'query', 'window'])
    expect(['x', '', 'fi', 'alt+f'].map(menuForMnemonic)).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('menu state', () => {
  it('covers every command with a menubar placement and every toggle', () => {
    expect(menuCommandIds).toEqual(commandIds.filter(id => id !== 'window.close'))
    expect(toggleCommandIds).toEqual([])
  })
  it('accepts unique catalogue ids only', () => {
    expect(menuStateSchema.parse({ disabled: ['file.save', 'query.cancel'], checked: [] })).toEqual({ disabled: ['file.save', 'query.cancel'], checked: [] })
    expect(menuStateSchema.safeParse({ disabled: [...menuCommandIds], checked: [] }).success).toBe(true)
    for (const value of [
      { disabled: ['file.nope'], checked: [] }, { disabled: ['window.close'], checked: [] }, { disabled: ['__proto__'], checked: [] }, { disabled: [], checked: ['file.new'] },
      { disabled: ['file.save', 'file.save'], checked: [] }, { disabled: [...menuCommandIds, 'file.new'], checked: [] }, { disabled: [], checked: [], extra: true },
      { disabled: [] }, { checked: [] }, { disabled: 'file.save', checked: [] }, { disabled: [1], checked: [] }, null, [], 'file.save'
    ]) expect(menuStateSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
  })
})
