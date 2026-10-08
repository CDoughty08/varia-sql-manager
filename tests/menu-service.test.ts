import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../src/shared/commands/keybindings'
import type { ThemeSummary } from '../src/shared/theme/types'
import type { FocusAdapter } from '../src/renderer/src/core/focus'
import type { KeyDownEvent } from '../src/renderer/src/core/keybindings'
import { MenuService, themeMenuItems } from '../src/renderer/src/menus/MenuService'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { manualTimers, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

type FakeKey = KeyDownEvent & { prevented: boolean; stopped: boolean }
function key(value: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean } = {}): FakeKey {
  const event: FakeKey = {
    key: value, code: /^[a-z]$/i.test(value) ? `Key${value.toUpperCase()}` : value, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, altKey: !!modifiers.alt, metaKey: !!modifiers.meta,
    repeat: !!modifiers.repeat, defaultPrevented: false, prevented: false, stopped: false,
    preventDefault: () => { event.prevented = true }, stopPropagation: () => { event.stopped = true }
  }
  return event
}
/** A menu service over the workbench fixture, with focus as a variable and every close, restore, and command recorded in order. */
function setup(options: { platform?: Platform } = {}) {
  const platform = options.platform ?? 'win32', state = { modal: false, findWidget: false, focused: 'editor' as unknown }
  const { timers, pending } = manualTimers()
  const fixture = workbenchFixture({ platform, modal: () => state.modal, timers })
  const order: string[] = []
  const focus: FocusAdapter = { capture: () => state.focused, restore: target => { order.push(`restore ${String(target)}`); state.focused = target } }
  const menus = new MenuService({ platform, commands: fixture.commands, context: fixture.context, keybindings: fixture.keybindings, theme: fixture.theme, focus, modalOpen: () => state.modal,
    findWidgetFocused: () => state.findWidget, timers })
  fixture.commands.onWillExecute(event => order.push(`execute ${event.id} from ${event.source}`))
  let owned = false
  menus.controller.subscribe(() => { if (owned && !menus.ownsKeyboard()) order.push('closed'); owned = menus.ownsKeyboard() })
  cleanups.push(() => { menus.dispose(); fixture.dispose() })
  return { fixture, menus, state, order, pending }
}
const indexOf = (items: readonly ResolvedMenuItem[], id: string) => items.findIndex(item => item.kind === 'command' ? item.id === id : item.kind === 'submenu' && item.key === id)
const titles = (items: readonly ResolvedMenuItem[]) => items.map(item => item.kind === 'separator' ? '-' : item.title)

describe('menu service', () => {
  it('resolves the title-bar menus from the catalogue, with the workbench\'s enablement and keys', () => {
    const { menus, fixture } = setup()
    fixture.documents.create('SQLQuery1.sql', '', 'master')
    const file = menus.resolve('file')
    expect(file.at(-1)).toMatchObject({ kind: 'command', id: 'window.close', title: 'Exit', keybinding: { text: 'Alt+F4' }, enabled: true })
    const connection = menus.resolve('query').find(item => item.key === 'query.connection')
    if (connection?.kind !== 'submenu') throw new Error('Query › Connection is missing')
    expect(connection.items.map(item => item.kind === 'command' ? [item.title, item.enabled] : '-')).toEqual([['Connect…', false], ['Disconnect', false], ['Disconnect All Queries', false], '-', ['Change Connection…', true]])
    fixture.context.set({ backendReady: true })
    expect(menus.resolve('query').find(item => item.key === 'query.connection')).toMatchObject({ items: [{ title: 'Connect…', enabled: true }, {}, {}, {}, {}] })
  })
  it('closes, returns focus, and only then runs the chosen command', () => {
    const { menus, state, order } = setup()
    menus.controller.openMenubar('file', { keyboard: true, focus: 'first' })
    // Focus moved into the menu; it goes back to the editor the menu was opened from.
    state.focused = 'menu item'
    const items = menus.controller.view.levels[0].items
    menus.controller.click(0, indexOf(items, 'file.new'))
    expect(order).toEqual(['closed', 'restore editor', 'execute file.new from menu'])
  })
  it('returns focus when the menus close without a choice, but not when one menu replaces another', () => {
    const { menus, state, order } = setup()
    menus.controller.focusMenubar('edit')
    state.focused = 'Edit button'
    expect(menus.handleKeyDown(key('Escape'))).toBe('consumed')
    expect(order).toEqual(['closed', 'restore editor'])
    order.length = 0
    menus.controller.openMenubar('file', { keyboard: false, focus: 'none' })
    state.focused = 'File menu'
    menus.controller.openContext(menus.resolve('edit'), { kind: 'point', x: 1, y: 1 }, { keyboard: false, label: 'Text field' })
    expect(menus.controller.view.source).toBe('context')
    menus.close('escape')
    expect(order).toEqual(['closed', 'closed', 'restore editor'])
  })
  it('closes before a command from anywhere else runs', async () => {
    const { menus, fixture, order } = setup()
    menus.controller.openMenubar('view', { keyboard: true, focus: 'first' })
    await fixture.commands.execute('file.new', undefined, 'keybinding')
    expect(order).toEqual(['closed', 'restore editor', 'execute file.new from keybinding'])
    // A native menu click (macOS) runs from 'menu' and leaves custom menus alone.
    menus.controller.openMenubar('view', { keyboard: true, focus: 'first' })
    await fixture.commands.execute('file.new', undefined, 'menu')
    expect(menus.ownsKeyboard()).toBe(true)
  })
  it('passes shortcuts through after closing, and consumes every other key while it owns the keyboard', () => {
    const { menus, order } = setup()
    expect(menus.handleKeyDown(key('ArrowDown'))).toBe('passthrough')
    menus.controller.focusMenubar('file')
    const right = key('ArrowRight')
    expect(menus.handleKeyDown(right)).toBe('consumed')
    expect([right.prevented, right.stopped, menus.controller.view.menubar.focused]).toEqual([true, true, 'edit'])
    const save = key('s', { ctrl: true })
    expect(menus.handleKeyDown(save)).toBe('passthrough')
    expect([save.prevented, menus.ownsKeyboard()]).toEqual([false, false])
    expect(order).toEqual(['closed', 'restore editor'])
    // Holding F10 does not toggle the menubar on every repeat.
    menus.controller.focusMenubar('file')
    expect(menus.handleKeyDown(key('F10', { repeat: true }))).toBe('consumed')
    expect(menus.ownsKeyboard()).toBe(true)
    expect(menus.handleKeyDown(key('F10'))).toBe('consumed')
    expect(menus.ownsKeyboard()).toBe(false)
  })
})

describe('menu access keys', () => {
  it('focuses the menubar with F10 and opens a menu with Alt and its letter, first item active', () => {
    const { menus } = setup()
    const f10 = key('F10')
    expect(menus.handleAccessKey('f10', f10)).toBe(true)
    expect([f10.prevented, f10.stopped]).toEqual([true, true])
    expect(menus.controller.view).toMatchObject({ levels: [], mnemonics: true, menubar: { focused: 'file', open: null } })
    menus.close('escape')
    expect(menus.handleAccessKey('alt+q', key('q', { alt: true }))).toBe(true)
    const [query] = menus.controller.view.levels
    expect(menus.controller.view).toMatchObject({ source: 'menubar', mnemonics: true, menubar: { focused: 'query', open: 'query' } })
    expect(query.items[query.active]).toMatchObject({ kind: 'submenu', title: 'Connection' })
    expect(titles(query.items)).toEqual(['Connection', 'Change Database…', '-', 'Execute', 'Cancel Executing Query'])
  })
  it('leaves other keys alone, and Alt+W to Monaco\'s find widget', () => {
    const { menus, state } = setup()
    for (const [chord, event] of [['alt+x', key('x', { alt: true })], ['shift+alt+f', key('f', { alt: true, shift: true })], ['ctrl+f10', key('F10', { ctrl: true })]] as const) {
      expect(menus.handleAccessKey(chord, event), chord).toBe(false)
      expect(event.prevented, chord).toBe(false)
    }
    state.findWidget = true
    const altW = key('w', { alt: true })
    expect(menus.handleAccessKey('alt+w', altW)).toBe(false)
    expect([altW.prevented, menus.ownsKeyboard()]).toEqual([false, false])
    expect(menus.handleAccessKey('alt+v', key('v', { alt: true }))).toBe(true)
  })
  it('opens nothing behind a dialog, but still keeps the key from Windows\' system menu', () => {
    const { menus, state } = setup()
    state.modal = true
    for (const [chord, event] of [['f10', key('F10')], ['alt+f', key('f', { alt: true })]] as const) {
      expect(menus.handleAccessKey(chord, event), chord).toBe(true)
      // The dialog's own handlers still see the key.
      expect([event.prevented, event.stopped], chord).toEqual([true, false])
    }
    expect(menus.ownsKeyboard()).toBe(false)
  })
  it('works over the quick input, which closes as focus moves to the menubar', () => {
    const { menus, fixture } = setup()
    fixture.quickInput.show({ ariaLabel: 'Command Palette', placeholder: '', noun: 'commands', items: [], onDidAccept: () => {} })
    expect(fixture.context.getState().quickInputVisible).toBe(true)
    expect(menus.handleAccessKey('f10', key('F10'))).toBe(true)
    expect(menus.controller.view.menubar.focused).toBe('file')
  })
  it('toggles the menubar with a bare Alt tap, except behind a dialog or the quick input', () => {
    const { menus, state, fixture, order } = setup()
    const altTap = () => { menus.noteKeyDown(key('Alt')); const up = key('Alt'); menus.handleKeyUp(up); return up }
    altTap()
    expect(menus.controller.view.menubar.focused).toBe('file')
    const leave = altTap()
    expect([menus.ownsKeyboard(), leave.prevented, leave.stopped]).toEqual([false, true, true])
    expect(order).toEqual(['closed', 'restore editor'])
    // An Alt tap also closes an open menu.
    menus.controller.openMenubar('edit', { keyboard: false, focus: 'none' })
    altTap()
    expect(menus.ownsKeyboard()).toBe(false)
    // Alt with another key in between is not a tap.
    menus.noteKeyDown(key('Alt'))
    menus.noteKeyDown(key('z', { alt: true }))
    menus.handleKeyUp(key('Alt'))
    expect(menus.ownsKeyboard()).toBe(false)
    state.modal = true
    altTap()
    expect(menus.ownsKeyboard()).toBe(false)
    state.modal = false
    fixture.quickInput.show({ ariaLabel: 'Command Palette', placeholder: '', noun: 'commands', items: [], onDidAccept: () => {} })
    altTap()
    expect(menus.ownsKeyboard()).toBe(false)
  })
  it('does nothing on macOS, whose menu bar is native', () => {
    const { menus } = setup({ platform: 'darwin' })
    expect(menus.handleAccessKey('f10', key('F10'))).toBe(false)
    expect(menus.handleAccessKey('alt+f', key('f', { alt: true }))).toBe(false)
    menus.noteKeyDown(key('Alt'))
    menus.handleKeyUp(key('Alt'))
    expect(menus.ownsKeyboard()).toBe(false)
  })
})

describe('menu window listeners', () => {
  function fakeWindow() {
    const listeners = new Map<string, (event?: unknown) => void>()
    const document = { visibilityState: 'visible', addEventListener: (type: string, listener: () => void) => { listeners.set('document ' + type, listener) }, removeEventListener: (type: string) => { listeners.delete('document ' + type) } }
    const window = { document, addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) }, removeEventListener: (type: string) => { listeners.delete(type) } }
    return { window: window as unknown as Window, document, listeners, fire: (type: string, event: unknown = {}) => listeners.get(type)!(event) }
  }
  /** An element inside the given containers (selectors as MenuService asks for them). */
  const element = (...containers: string[]) => ({ closest: (selectors: string) => selectors.split(', ').some(selector => containers.some(container => selector.endsWith(container))) ? {} : null })

  it('closes on a press outside the menus, scrolling outside a menu, resizing, blur, and hiding', () => {
    const { menus } = setup()
    const fake = fakeWindow()
    const attached = menus.attach(fake.window)
    const open = () => menus.controller.openMenubar('file', { keyboard: false, focus: 'none' })
    open()
    fake.fire('pointerdown', { target: element('.title-bar-menus') })
    fake.fire('pointerdown', { target: element('.menu-layer') })
    fake.fire('wheel', { target: element('.menu') })
    expect(menus.ownsKeyboard()).toBe(true)
    for (const [type, event] of [['pointerdown', { target: element() }], ['wheel', { target: element() }], ['scroll', { target: null }], ['resize', {}], ['blur', {}]] as const) {
      open()
      fake.fire(type, event)
      expect(menus.ownsKeyboard(), type).toBe(false)
    }
    open()
    fake.document.visibilityState = 'hidden'
    fake.fire('document visibilitychange')
    expect(menus.ownsKeyboard()).toBe(false)
    attached.dispose()
    expect(fake.listeners.size).toBe(0)
  })
  it('cancels a bare Alt tap on a pointer press or blur, and remembers focus outside the menus', () => {
    const { menus, state, order } = setup()
    const fake = fakeWindow()
    menus.attach(fake.window)
    for (const type of ['pointerdown', 'blur']) {
      menus.noteKeyDown(key('Alt'))
      fake.fire(type, { target: element() })
      menus.handleKeyUp(key('Alt'))
      expect(menus.ownsKeyboard(), type).toBe(false)
    }
    state.focused = 'server field'
    fake.fire('focusin')
    // Focus in a transient surface (the quick input) is not remembered: the menus go back to the field before it.
    state.focused = undefined
    fake.fire('focusin')
    menus.controller.focusMenubar('file')
    menus.close('escape')
    expect(order).toEqual(['closed', 'restore server field'])
  })
  it('clears its timers and listeners when disposed', () => {
    const { menus, pending } = setup()
    const fake = fakeWindow()
    menus.attach(fake.window)
    menus.controller.openMenubar('view', { keyboard: false, focus: 'none' })
    const theme = indexOf(menus.controller.view.levels[0].items, 'view.theme')
    menus.controller.pointerEnterItem(0, theme, { x: 1, y: 1 })
    expect(pending.size).toBeGreaterThan(0)
    menus.dispose()
    expect([pending.size, fake.listeners.size, menus.ownsKeyboard()]).toEqual([0, 0, false])
  })
})

describe('View › Theme items', () => {
  const summary = (id: string, name: string, types: ThemeSummary['types'], source: ThemeSummary['source'] = 'user'): ThemeSummary => ({ id, name, source, types, usable: true, errors: 0, warnings: 0 })
  const theme = {
    preference: { version: 1 as const, mode: 'dark' as const, darkTheme: 'dusk', lightTheme: 'gone' },
    themes: [summary('varia-dark', 'Varia Dark', ['dark'], 'builtin'), summary('varia-light', 'Varia Light', ['light'], 'builtin'), summary('dusk', 'Dusk', ['dark'])]
  }
  it('choose modes and themes through preferences.setTheme, with the choice as arguments', () => {
    const items = themeMenuItems(theme)
    expect(items.slice(0, 3)).toEqual([
      { kind: 'command', key: 'theme.mode.dark', id: 'preferences.setTheme', title: 'Dark', mnemonic: 'd', checked: true, radio: true, enabled: true, args: { theme: { mode: 'dark' } } },
      { kind: 'command', key: 'theme.mode.light', id: 'preferences.setTheme', title: 'Light', mnemonic: 'l', checked: false, radio: true, enabled: true, args: { theme: { mode: 'light' } } },
      { kind: 'command', key: 'theme.mode.system', id: 'preferences.setTheme', title: 'Follow System', mnemonic: 's', checked: false, radio: true, enabled: true, args: { theme: { mode: 'system' } } }
    ])
    const [dark, light] = items.filter(item => item.kind === 'submenu')
    expect(dark).toMatchObject({ key: 'theme.dark', title: 'Dark Theme', mnemonic: 'k' })
    expect(dark.kind === 'submenu' && dark.items.map(item => item.kind === 'command' && [item.title, item.mnemonic, item.checked, item.args])).toEqual([
      ['Varia Dark', null, false, { theme: { darkTheme: 'varia-dark' } }], ['Dusk', null, true, { theme: { darkTheme: 'dusk' } }]
    ])
    // A chosen theme that is gone is shown, checked and disabled, with nothing to choose.
    expect(light.kind === 'submenu' && light.items.at(-1)).toEqual({ kind: 'command', key: 'theme.light.gone', id: 'preferences.setTheme', title: 'gone (missing: using Varia Light)', mnemonic: null, checked: true, radio: true, enabled: false })
    expect(items.slice(-3).map(item => item.kind === 'command' && [item.key, item.id, item.mnemonic])).toEqual([
      ['theme.create', 'preferences.createTheme', 't'], ['theme.openFolder', 'preferences.openThemesFolder', 'o'], ['theme.reload', 'preferences.reloadThemes', 'r']
    ])
  })
  it('apply a choice from the menu and show main\'s new state', async () => {
    const { menus, fixture } = setup()
    const view = menus.resolve('view'), submenu = view.find(item => item.key === 'view.theme')
    if (submenu?.kind !== 'submenu') throw new Error('View › Theme is missing')
    expect(titles(submenu.items)).toEqual(['Color Theme…', '-', 'Dark', 'Light', 'Follow System', '-', 'Dark Theme', 'Light Theme', '-', 'Create Custom Theme…', 'Open Themes Folder', 'Reload Themes'])
    const light = submenu.items[3]
    expect(light).toMatchObject({ kind: 'command', id: 'preferences.setTheme', args: { theme: { mode: 'light' } }, enabled: true, radio: true, checked: false })
    const state = { ...fixture.theme.state, preference: { ...fixture.theme.state.preference, mode: 'light' as const } }
    fixture.api.setThemePreference.mockResolvedValueOnce({ ok: true, value: state })
    if (light.kind !== 'command') throw new Error('Light is not a command')
    expect(await fixture.commands.execute(light.id, light.args, 'menu')).toBe(true)
    expect(fixture.api.setThemePreference).toHaveBeenCalledWith({ mode: 'light' })
    expect(fixture.theme.receive).toHaveBeenCalledWith(state)
    // Without a choice there is nothing to run; a failure reaches the command banner.
    expect(fixture.commands.isEnabled('preferences.setTheme')).toBe(false)
    expect(await fixture.commands.execute('preferences.setTheme', { theme: { mode: 'dark' } }, 'menu')).toBe(false)
    expect(fixture.commands.getSnapshot().error).toBe('Could not run “Preferences: Set Color Theme”: Not in this fixture.')
    vi.restoreAllMocks()
  })
})
