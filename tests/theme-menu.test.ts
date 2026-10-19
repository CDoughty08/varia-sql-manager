import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions, type ApplicationMenuModel } from '../src/main/application-menu'
import { themeLabel, themeMenuModel, type ThemeMenuItem } from '../src/shared/theme/menu'
import { themeChoice } from '../src/shared/theme/choice'
import type { ThemePreference, ThemeSummary } from '../src/shared/theme/types'

const builtins: ThemeSummary[] = [
  { id: 'varia-dark', name: 'Varia Dark', source: 'builtin', types: ['dark'], usable: true, errors: 0, warnings: 0 },
  { id: 'varia-light', name: 'Varia Light', source: 'builtin', types: ['light'], usable: true, errors: 0, warnings: 0 }
]
const user = (id: string, name: string, types: ThemeSummary['types'], usable = true): ThemeSummary => ({ id, name, source: 'user', types, usable, errors: usable ? 0 : 1, warnings: 0 })
const harbor = user('harbor', 'Harbor', ['dark', 'light']), dusk = user('dusk', 'Dusk', ['dark']), paper = user('paper', 'Paper', ['light']), broken = user('broken', 'broken', [], false)

function model(preference: Partial<ThemePreference> = {}, themes: ThemeSummary[] = [...builtins, harbor, dusk, paper, broken]): ApplicationMenuModel {
  return { theme: { preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light', ...preference }, themes } }
}
function actions() {
  return { command: vi.fn<ApplicationMenuActions['command']>(), isChecked: vi.fn<ApplicationMenuActions['isChecked']>(() => false), pageHasKeyFocus: () => true, sendActionToFirstResponder: vi.fn(), setTheme: vi.fn<ApplicationMenuActions['setTheme']>(), createTheme: vi.fn(), openThemesFolder: vi.fn(), reloadThemes: vi.fn(), openRecent: vi.fn(), clearRecent: vi.fn() } satisfies ApplicationMenuActions
}
function find(items: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  for (const item of items) {
    if (item.id === id) return item
    if (Array.isArray(item.submenu)) {
      try { return find(item.submenu, id) } catch { /* Keep looking. */ }
    }
  }
  throw new Error('Menu item missing: ' + id)
}
const submenu = (items: MenuItemConstructorOptions[], id: string) => find(items, id).submenu as MenuItemConstructorOptions[]
const click = (item: MenuItemConstructorOptions) => (item.click as () => void)()
const radios = (items: MenuItemConstructorOptions[]) => items.map(item => [item.id, item.label, item.checked, item.enabled])

describe('application menu', () => {
  it('keeps the existing menus and commands, with Theme after the layout items', () => {
    const handlers = actions(), template = applicationMenuTemplate(model(), handlers, 'linux')
    expect(template.map(item => item.id)).toEqual(['menu.file', 'menu.edit', 'menu.view', 'menu.query', 'menu.tools', 'menu.window'])
    expect(submenu(template, 'menu.file').map(item => item.id ?? item.role ?? item.type)).toEqual(['connection.connect', 'connection.disconnect', 'connection.reconnect', 'separator', 'file.new', 'file.open', 'file.save', 'file.saveAs', 'file.saveAll', 'separator', 'file.close', 'separator', 'file.recent', 'separator', 'window.close'])
    expect(submenu(template, 'menu.view').map(item => item.id ?? item.role ?? item.type)).toEqual(['workbench.showCommands', 'workbench.quickOpen', 'separator', 'layout.save', 'layout.load', 'layout.reset', 'separator', 'view.theme', 'separator',
      'view.zoomIn', 'zoomIn', 'view.zoomOut', 'view.resetZoom', 'view.toggleFullScreen', 'separator', 'developer.reloadWindow', 'developer.toggleDevTools'])
    expect(submenu(template, 'view.theme').map(item => item.id ?? item.type)).toEqual(['preferences.colorTheme', 'separator', 'theme.mode.dark', 'theme.mode.light', 'theme.mode.system', 'separator', 'theme.dark', 'theme.light', 'separator', 'theme.create', 'theme.openFolder', 'theme.reload'])
    click(find(template, 'file.saveAs'))
    click(find(template, 'window.output'))
    click(find(template, 'preferences.colorTheme'))
    expect(handlers.command.mock.calls).toEqual([['file.saveAs'], ['window.output'], ['preferences.colorTheme']])
    expect(find(template, 'edit.redo').accelerator).toBe('Ctrl+Y')
    expect(find(applicationMenuTemplate(model(), handlers, 'darwin'), 'edit.redo').accelerator).toBe('Cmd+Shift+Z')
  })
  it('shows the mode and each list as radio groups, with dual themes in both and invalid themes disabled', () => {
    const template = applicationMenuTemplate(model({ mode: 'system', lightTheme: 'harbor' }), actions(), 'linux')
    expect(submenu(template, 'view.theme').slice(2, 5).map(item => [item.id, item.label, item.type, item.checked])).toEqual([
      ['theme.mode.dark', 'Dark', 'radio', false], ['theme.mode.light', 'Light', 'radio', false], ['theme.mode.system', 'Follow System', 'radio', true]
    ])
    expect(radios(submenu(template, 'theme.dark'))).toEqual([
      ['theme.dark.varia-dark', 'Varia Dark', true, true], ['theme.dark.harbor', 'Harbor', false, true], ['theme.dark.dusk', 'Dusk', false, true], ['theme.dark.broken', 'broken (invalid)', false, false]
    ])
    expect(radios(submenu(template, 'theme.light'))).toEqual([
      ['theme.light.varia-light', 'Varia Light', false, true], ['theme.light.harbor', 'Harbor', true, true], ['theme.light.paper', 'Paper', false, true], ['theme.light.broken', 'broken (invalid)', false, false]
    ])
    expect(submenu(template, 'theme.dark').every(item => item.type === 'radio')).toBe(true)
  })
  it('keeps a selected theme that cannot be used checked and says what is shown instead', () => {
    const template = applicationMenuTemplate(model({ darkTheme: 'broken', lightTheme: 'gone' }), actions(), 'linux')
    expect(radios(submenu(template, 'theme.dark')).at(-1)).toEqual(['theme.dark.broken', 'broken (invalid: using Varia Dark)', true, false])
    expect(radios(submenu(template, 'theme.light')).at(-1)).toEqual(['theme.light.gone', 'gone (missing: using Varia Light)', true, false])
    const wrongType = applicationMenuTemplate(model({ darkTheme: 'paper' }), actions(), 'linux')
    expect(radios(submenu(wrongType, 'theme.dark')).find(item => item[0] === 'theme.dark.paper')).toEqual(['theme.dark.paper', 'Paper (no dark variant: using Varia Dark)', true, false])
  })
  it('sanitizes, shortens, disambiguates, and escapes theme names', () => {
    const long = 'A'.repeat(60), themes = [...builtins, user('salt', 'Salt & Pepper', ['dark']), user('long', long, ['dark']), user('ocean', 'Ocean', ['dark']), user('ocean-2', 'Ocean', ['dark']), user('bidi', 'Evil‮eman\u0007', ['dark'])]
    const labels = (platform: NodeJS.Platform) => submenu(applicationMenuTemplate(model({}, themes), actions(), platform), 'theme.dark').map(item => item.label)
    expect(labels('linux')).toEqual(['Varia Dark', 'Salt && Pepper', 'A'.repeat(47) + '…', 'Ocean (ocean)', 'Ocean (ocean-2)', 'Evileman'])
    expect(labels('win32')[1]).toBe('Salt && Pepper')
    expect(labels('darwin')[1]).toBe('Salt & Pepper')
    expect([...themeLabel(long)]).toHaveLength(48)
    expect(themeLabel('A'.repeat(48))).toBe('A'.repeat(48))
  })
  it('tells apart themes whose names only look like another one', () => {
    // A word joiner, a tag character, a no-break space, and a doubled space all read as "Varia Dark" in a menu.
    const posers = [user('joiner', 'Varia Dark⁠', ['dark']), user('tag', 'Varia Dark\u{e0041}', ['dark']), user('nbsp', 'Varia Dark', ['dark']), user('spaces', 'Varia  Dark', ['dark'])]
    const labels = submenu(applicationMenuTemplate(model({}, [...builtins, ...posers]), actions(), 'linux'), 'theme.dark').map(item => item.label)
    expect(labels).toEqual(['Varia Dark (varia-dark)', 'Varia Dark (joiner)', 'Varia Dark (tag)', 'Varia Dark (nbsp)', 'Varia  Dark (spaces)'])
    // A braille blank renders as a space, and a Cyrillic а as a Latin a.
    const blanks = [user('trailing', 'Varia Dark\u2800', ['dark']), user('inside', 'Varia\u2800Dark', ['dark']), user('cyrillic', 'V\u0430ria Dark', ['dark'])]
    for (const poser of blanks) {
      const [builtin, shown] = submenu(applicationMenuTemplate(model({}, [...builtins, poser]), actions(), 'linux'), 'theme.dark').map(item => item.label)
      expect([builtin, shown], poser.id).toEqual(['Varia Dark (varia-dark)', `${poser.name} (${poser.id})`])
    }
    // Different names, in one script or another, keep their plain labels.
    const distinct = [user('night', 'Ночь', ['dark']), user('day', 'День', ['dark']), user('harbor', 'Harbor', ['dark']), user('harbot', 'Harbot', ['dark']), user('upper', 'VARIA DARK', ['dark'])]
    expect(submenu(applicationMenuTemplate(model({}, [...builtins, ...distinct]), actions(), 'linux'), 'theme.dark').map(item => item.label)).toEqual(['Varia Dark', 'Ночь', 'День', 'Harbor', 'Harbot', 'VARIA DARK'])
  })
  it('turns clicks into preference changes', () => {
    const handlers = actions()
    const template = applicationMenuTemplate(model({ mode: 'light' }), handlers, 'linux')
    click(find(template, 'theme.dark.dusk'))
    click(find(template, 'theme.light.paper'))
    click(find(template, 'theme.dark.harbor'))
    click(find(template, 'theme.mode.system'))
    expect(handlers.setTheme.mock.calls.map(call => call[0])).toEqual([{ darkTheme: 'dusk', mode: 'dark' }, { lightTheme: 'paper' }, { darkTheme: 'harbor', lightTheme: 'harbor', mode: 'dark' }, { mode: 'system' }])
    click(find(template, 'theme.create'))
    click(find(template, 'theme.openFolder'))
    click(find(template, 'theme.reload'))
    expect([handlers.createTheme, handlers.openThemesFolder, handlers.reloadThemes].map(handler => handler.mock.calls.length)).toEqual([1, 1, 1])
    expect(themeChoice({ version: 1, mode: 'system', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, harbor, 'light')).toEqual({ darkTheme: 'harbor', lightTheme: 'harbor' })
    expect(themeChoice({ version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' }, paper, 'light')).toEqual({ lightTheme: 'paper', mode: 'light' })
  })
})

describe('theme menu model', () => {
  const outline = (items: readonly ThemeMenuItem[]): unknown[] => items.map(item => item.kind === 'separator' ? '-' : item.kind === 'submenu' ? [item.id, item.mnemonic, outline(item.items)] : item.id)
  it('gives every renderer plain labels, PR1 ids, mnemonics for the fixed items only, and the choice each radio makes', () => {
    const themes = [...builtins, user('salt', 'Salt & Pepper', ['dark']), broken]
    const items = themeMenuModel(model({ mode: 'light', lightTheme: 'gone' }, themes).theme)
    expect(outline(items)).toEqual(['theme.mode.dark', 'theme.mode.light', 'theme.mode.system', '-', ['theme.dark', 'k', ['theme.dark.varia-dark', 'theme.dark.salt', 'theme.dark.broken']],
      ['theme.light', 'g', ['theme.light.varia-light', 'theme.light.broken', 'theme.light.gone']], '-', 'theme.create', 'theme.openFolder', 'theme.reload'])
    expect(items.slice(0, 3)).toEqual([
      { kind: 'radio', id: 'theme.mode.dark', label: 'Dark', mnemonic: 'd', checked: false, enabled: true, patch: { mode: 'dark' } },
      { kind: 'radio', id: 'theme.mode.light', label: 'Light', mnemonic: 'l', checked: true, enabled: true, patch: { mode: 'light' } },
      { kind: 'radio', id: 'theme.mode.system', label: 'Follow System', mnemonic: 's', checked: false, enabled: true, patch: { mode: 'system' } }
    ])
    const dark = items[4].kind === 'submenu' ? items[4].items : [], light = items[5].kind === 'submenu' ? items[5].items : []
    expect(dark[1]).toEqual({ kind: 'radio', id: 'theme.dark.salt', label: 'Salt & Pepper', checked: false, enabled: true, patch: { darkTheme: 'salt', mode: 'dark' } })
    expect(dark[2]).toMatchObject({ label: 'broken (invalid)', enabled: false })
    expect(light.at(-1)).toEqual({ kind: 'radio', id: 'theme.light.gone', label: 'gone (missing: using Varia Light)', checked: true, enabled: false })
    expect(items.slice(-3)).toEqual([
      { kind: 'action', id: 'theme.create', label: 'Create Custom Theme…', mnemonic: 't', command: 'preferences.createTheme' },
      { kind: 'action', id: 'theme.openFolder', label: 'Open Themes Folder', mnemonic: 'o', command: 'preferences.openThemesFolder' },
      { kind: 'action', id: 'theme.reload', label: 'Reload Themes', mnemonic: 'r', command: 'preferences.reloadThemes' }
    ])
  })
  it('is what the native menu shows, item for item', () => {
    const state = model({ mode: 'system', darkTheme: 'dusk' })
    const native = submenu(applicationMenuTemplate(state, actions(), 'darwin'), 'view.theme').slice(2)
    const flat = (items: readonly ThemeMenuItem[]): ThemeMenuItem[] => items.flatMap(item => item.kind === 'submenu' ? [item, ...flat(item.items)] : [item])
    const nativeFlat = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => items.flatMap(item => Array.isArray(item.submenu) ? [item, ...nativeFlat(item.submenu)] : [item])
    expect(flat(themeMenuModel(state.theme)).map(item => item.kind === 'separator' ? ['-'] : [item.id, item.label])).toEqual(nativeFlat(native).map(item => item.type === 'separator' ? ['-'] : [item.id, item.label]))
  })
})
