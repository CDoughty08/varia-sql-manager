import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from '../src/main/application-menu'
import { platforms } from '../src/shared/commands/keybindings'
import type { ThemeSummary } from '../src/shared/theme/types'

const theme = (id: string, name: string, types: ThemeSummary['types'], usable = true): ThemeSummary => ({ id, name, source: 'user', types, usable, errors: usable ? 0 : 1, warnings: 0 })
const themes: ThemeSummary[] = [
  { id: 'varia-dark', name: 'Varia Dark', source: 'builtin', types: ['dark'], usable: true, errors: 0, warnings: 0 },
  { id: 'varia-light', name: 'Varia Light', source: 'builtin', types: ['light'], usable: true, errors: 0, warnings: 0 },
  theme('harbor', 'Harbor & Sea', ['dark', 'light']), theme('dusk', 'Dusk', ['dark']), theme('paper', 'Paper', ['light']), theme('broken', 'broken', [], false)
]

/**
 * Every item of the native template with its click replaced by what the click does, so a change to the generated
 * menus (ids, labels, roles, accelerators, order, or actions) shows up as a snapshot diff. Regenerate deliberately with
 * `npx vitest run tests/application-menu-snapshot.test.ts -u`.
 */
function describeTemplate(platform: NodeJS.Platform): string {
  const calls: unknown[] = []
  const actions: ApplicationMenuActions = {
    command: id => calls.push(['command', id]), isChecked: id => id === 'editor.toggleWordWrap', setTheme: patch => calls.push(['setTheme', patch]),
    // An item that asks shows it, so the snapshot names the items that act elsewhere when the page lacks the keyboard.
    pageHasKeyFocus: () => { calls.push(['pageHasKeyFocus']); return true }, sendActionToFirstResponder: action => calls.push(['sendActionToFirstResponder', action]),
    createTheme: () => calls.push(['createTheme']), openThemesFolder: () => calls.push(['openThemesFolder']), reloadThemes: () => calls.push(['reloadThemes'])
  }
  const template = applicationMenuTemplate({ theme: { preference: { version: 1, mode: 'system', darkTheme: 'dusk', lightTheme: 'gone' }, themes } }, actions, platform)
  // One line per item, indented by depth, so a diff names the items that changed.
  const visit = (items: readonly MenuItemConstructorOptions[], depth: number): string[] => items.flatMap(item => {
    const { click, submenu, ...rest } = item
    // Key order and Electron's default `enabled: true` are not behaviour.
    const described: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([key, value]) => key !== 'enabled' || value !== true).sort(([a], [b]) => a < b ? -1 : 1))
    if (click) {
      calls.length = 0
      const target = { checked: false }
      ;(click as (menuItem: typeof target) => void)(target)
      described.click = [...calls]
      if (item.type === 'checkbox') described.checkedAfterClick = target.checked
    }
    return ['  '.repeat(depth) + JSON.stringify(described), ...Array.isArray(submenu) ? visit(submenu, depth + 1) : []]
  })
  return visit(template, 0).join('\n') + '\n'
}

describe('native application menu template', () => {
  it.each(platforms)('is pinned on %s', async platform => {
    await expect(describeTemplate(platform)).toMatchFileSnapshot(`fixtures/application-menu.${platform}.txt`)
  })
  const actions: ApplicationMenuActions = { command: () => {}, isChecked: () => false, pageHasKeyFocus: () => true, sendActionToFirstResponder: () => {}, setTheme: () => {}, createTheme: () => {}, openThemesFolder: () => {}, reloadThemes: () => {} }
  const items = (platform: NodeJS.Platform, menu: string, menuActions: ApplicationMenuActions = actions) => {
    const template = applicationMenuTemplate({ theme: { preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, themes } }, menuActions, platform)
    return template.find(item => item.id === 'menu.' + menu)!.submenu as MenuItemConstructorOptions[]
  }
  it.each(platforms)('labels command items, role items included, through the settings title hook on %s', platform => {
    const template = applicationMenuTemplate({ theme: { preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, themes }, title: (id, title) => id === 'file.new' || id === 'edit.copy' ? title + ' (50)' : title }, actions, platform)
    const file = template.find(item => item.id === 'menu.file')!.submenu as MenuItemConstructorOptions[], edit = template.find(item => item.id === 'menu.edit')!.submenu as MenuItemConstructorOptions[]
    expect([file.find(item => item.id === 'file.new')?.label, edit.find(item => item.id === 'edit.copy')?.label, edit.find(item => item.id === 'edit.cut')?.label]).toEqual(['New Query (50)', 'Copy (50)', 'Cut'])
  })
  it.each(platforms)('has Toggle Developer Tools, with its role and key, in View on %s, as every build does', platform => {
    // The template takes no build flag: a packaged build's menu is this one.
    expect(applicationMenuTemplate.length).toBe(3)
    const devTools = items(platform, 'view').find(item => item.role === 'toggleDevTools')
    expect(devTools).toMatchObject({ id: 'developer.toggleDevTools', label: 'Toggle Developer Tools', accelerator: platform === 'darwin' ? 'Cmd+Alt+I' : 'Ctrl+Shift+I' })
  })
  it.each(platforms)('keeps Electron\'s own Zoom In key beside the catalogue\'s on %s', platform => {
    const zoomIn = items(platform, 'view').filter(item => item.role === 'zoomIn')
    const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl'
    // Ctrl+Shift+= is the key Electron's Zoom In role had (Ctrl++); a hidden copy carries it, since an item has one key.
    expect(zoomIn.map(item => [item.accelerator, item.visible ?? true])).toEqual([[`${mod}+=`, true], [`${mod}+Shift+=`, false]])
    expect(zoomIn[1].acceleratorWorksWhenHidden).toBe(platform === 'darwin' ? true : undefined)
  })
  it('runs Delete and Select All from the macOS menu bar through their handlers, which reach the query editor', () => {
    const edit = (platform: NodeJS.Platform) => Object.fromEntries(items(platform, 'edit').filter(item => item.id === 'edit.delete' || item.id === 'edit.selectAll').map(item => [item.id, item.role ?? 'handler']))
    expect(edit('darwin')).toEqual({ 'edit.delete': 'handler', 'edit.selectAll': 'handler' })
    // Elsewhere the menu is hidden and only gives the roles their keys.
    expect(edit('win32')).toEqual({ 'edit.delete': 'delete', 'edit.selectAll': 'selectAll' })
    expect(items('darwin', 'edit').filter(item => item.role).map(item => item.role)).toEqual(['cut', 'copy', 'paste'])
  })
  it('sends Select All and Delete to whatever has the keyboard when it is not the page, as their roles do, on macOS', () => {
    const calls: unknown[] = []
    let pageFocused = false
    const edit = items('darwin', 'edit', { ...actions, command: id => calls.push(['command', id]), pageHasKeyFocus: () => pageFocused, sendActionToFirstResponder: action => calls.push(['firstResponder', action]) })
    const click = (id: string) => (edit.find(item => item.id === id)!.click as (menuItem: object) => void)({})
    // ⌘A is the item's key equivalent, so in a Save sheet's file name or DevTools it must select that text, not the query.
    expect(edit.find(item => item.id === 'edit.selectAll')!.accelerator).toBe('Cmd+A')
    click('edit.selectAll')
    click('edit.delete')
    expect(calls).toEqual([['firstResponder', 'selectAll:'], ['firstResponder', 'delete:']])
    calls.length = 0
    pageFocused = true
    click('edit.selectAll')
    click('edit.delete')
    expect(calls).toEqual([['command', 'edit.selectAll'], ['command', 'edit.delete']])
  })
})
