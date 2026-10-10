import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../src/shared/commands/keybindings'
import type { ThemeSummary } from '../src/shared/theme/types'
import type { FocusAdapter } from '../src/renderer/src/core/focus'
import type { KeyDownEvent } from '../src/renderer/src/core/keybindings'
import { MenuService, themeMenuItems } from '../src/renderer/src/menus/MenuService'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { MenuTargetService } from '../src/renderer/src/menus/targets'
import { fakeDocument, FakeElement } from './fixtures/elements'
import { connectionInfo, connectionOptions, manualTimers, readyBackend, workbenchFixture } from './fixtures/workbench'

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
    expect(connection.items.map(item => item.kind === 'command' ? [item.title, item.enabled] : '-')).toEqual([['Connect…', false], ['Disconnect', false], ['Disconnect All Queries', false], ['Reconnect…', false], '-', ['Change Connection…', true]])
    fixture.api.push(readyBackend())
    expect(menus.resolve('query').find(item => item.key === 'query.connection')).toMatchObject({ items: [{ title: 'Connect…', enabled: true }, {}, {}, {}, {}, {}] })
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
  it('toggles the menubar with a bare Alt tap, also over the quick input, but not behind a dialog', () => {
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
    // As F10 and Alt+letter do: the quick input closes as focus moves to the menubar.
    fixture.quickInput.show({ ariaLabel: 'Command Palette', placeholder: '', noun: 'commands', items: [], onDidAccept: () => {} })
    altTap()
    expect(menus.controller.view.menubar.focused).toBe('file')
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
  it('cancels a bare Alt tap on a pointer press, the wheel, focus moving, or blur, and remembers focus outside the menus', () => {
    const { menus, state, order } = setup()
    const fake = fakeWindow()
    menus.attach(fake.window)
    // Alt+wheel scrolls the editor faster; a window manager's Alt+drag moves focus out of the page and back.
    for (const type of ['pointerdown', 'wheel', 'focusin', 'blur']) {
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
  it('takes the keyboard when Tab reaches a menubar button, and lets Tab move on from it', () => {
    const { menus, state, order } = setup()
    const fake = fakeWindow()
    menus.attach(fake.window)
    const button = (id: string) => ({ closest: (selector: string) => selector === '.title-bar-menus [data-menu]' ? { getAttribute: () => id } : null })
    state.focused = 'toolbar button'
    fake.fire('focusin', { target: element() })
    // The button itself is never a place to return to (capture skips the menubar).
    state.focused = undefined
    fake.fire('focusin', { target: button('file') })
    expect(menus.controller.view).toMatchObject({ levels: [], mnemonics: true, menubar: { focused: 'file', open: null } })
    menus.handleKeyDown(key('ArrowRight'))
    expect(menus.controller.view.menubar.focused).toBe('edit')
    // Moving between buttons, the menubar already owns the keyboard.
    fake.fire('focusin', { target: button('edit') })
    menus.handleKeyDown(key('ArrowDown'))
    expect(menus.controller.view).toMatchObject({ source: 'menubar', menubar: { open: 'edit' } })
    menus.handleKeyDown(key('Escape'))
    menus.handleKeyDown(key('Escape'))
    expect(order).toEqual(['closed', 'restore toolbar button'])
    // Tab and Shift+Tab leave it as from any control: the browser moves focus on from the button, and nothing moves it
    // back, also after a menu opened and closed back to the button.
    for (const tab of [key('Tab'), key('Tab', { shift: true })]) {
      order.length = 0
      fake.fire('focusin', { target: button('file') })
      menus.handleKeyDown(key('ArrowDown'))
      menus.handleKeyDown(key('Escape'))
      expect(menus.controller.view.menubar.focused).toBe('file')
      expect(menus.handleKeyDown(tab)).toBe('passthrough')
      expect([tab.prevented, tab.stopped, menus.ownsKeyboard()]).toEqual([false, false, false])
      expect(order).toEqual(['closed'])
    }
    // Reached with F10 instead, the menubar gives focus back on Tab, as on Escape.
    order.length = 0
    menus.handleAccessKey('f10', key('F10'))
    const tab = key('Tab')
    expect(menus.handleKeyDown(tab)).toBe('consumed')
    expect(order).toEqual(['closed', 'restore toolbar button'])
    // Not behind a dialog.
    state.modal = true
    fake.fire('focusin', { target: button('view') })
    expect(menus.ownsKeyboard()).toBe(false)
  })
  it('lets the keys follow focus that leaves the focused menubar by itself, and leaves focus there', () => {
    const { menus, order } = setup()
    const fake = fakeWindow()
    menus.attach(fake.window)
    menus.handleAccessKey('f10', key('F10'))
    // Its own menus keep it.
    fake.fire('focusin', { target: element('.menu-layer') })
    expect(menus.ownsKeyboard()).toBe(true)
    // A screen reader or a script focuses the editor.
    fake.fire('focusin', { target: element() })
    expect(menus.ownsKeyboard()).toBe(false)
    expect(order).toEqual(['closed'])
    expect(menus.handleKeyDown(key('q'))).toBe('passthrough')
    // An open menu keeps the keyboard until it closes.
    menus.handleAccessKey('alt+q', key('q', { alt: true }))
    fake.fire('focusin', { target: element() })
    expect(menus.controller.view.menubar.open).toBe('query')
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

describe('context menus', () => {
  /**
   * Context menus over fake elements: two query tabs, the editor, a dialog with a field, a password field, and a
   * button, and a field outside it. Focus is the fake document's; restores and commands are recorded in order.
   */
  function setup() {
    const state = { modal: false }
    const fixture = workbenchFixture({ modal: () => state.modal })
    const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
    const first = fixture.documents.create('one.sql', 'SELECT 1', 'master'), second = fixture.documents.create('two.sql', 'SELECT 2', 'master')
    const tab = (id: string) => { const button = make('button', { className: 'tab-select' }); return { button, tab: make('div', { className: 'query-tab', attributes: { 'data-tab-id': id } }).append(button) } }
    const one = tab(first.id), two = tab(second.id)
    one.tab.rect = { left: 100, top: 40, right: 200, bottom: 68 }
    const line = make('span'), editor = make('div', { className: 'editor-host' }).append(line)
    const field = make('input', { value: 'localhost', selectionStart: 0, selectionEnd: 5 }), password = make('input', { type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 })
    const dialog = make('form', { attributes: { 'aria-modal': 'true' } }).append(field, password, make('button'))
    const outside = make('input', { value: 'x' }), layer = make('div', { className: 'menu-layer' }).append(make('div', { className: 'menu-item' }))
    make('body').append(one.tab, two.tab, editor, dialog, outside, layer)
    const targets = new MenuTargetService({ editor: () => ({ container: editor.dom, tabId: fixture.documents.getSnapshot().activeId }), commandEnabled: () => true })
    for (const element of [one.tab, two.tab]) targets.register(element.dom, registered => ({ kind: 'documentTab', tabId: (registered as unknown as FakeElement).dataset.tabId }))
    const names = new Map<unknown, string>([[one.button, 'tab one'], [two.button, 'tab two'], [line, 'editor text'], [field, 'server field'], [password, 'password field'], [outside, 'outside field']])
    const order: string[] = []
    const focus: FocusAdapter = { capture: () => doc.activeElement ?? undefined, restore: target => { order.push(`restore ${names.get(target) ?? String(target)}`); (target as FakeElement | undefined)?.focus() } }
    const caret = { left: 300, top: 120, right: 300, bottom: 139 }
    const menus = new MenuService({ platform: 'win32', commands: fixture.commands, context: fixture.context, keybindings: fixture.keybindings, theme: fixture.theme, focus, modalOpen: () => state.modal,
      targets, editorCaret: () => caret, modalContains: element => dialog.contains(element as unknown as FakeElement) })
    fixture.commands.onWillExecute(event => order.push(`execute ${event.id} from ${event.source}`))
    cleanups.push(() => { menus.dispose(); fixture.dispose() })
    doc.activeElement = line
    const event = (target: FakeElement, x = 10, y = 20) => ({ target: target as unknown as EventTarget, clientX: x, clientY: y, prevented: false, preventDefault() { this.prevented = true } })
    return { fixture, menus, state, doc, order, one, two, line, editor, field, password, outside, layer, caret, event, first, second, targets }
  }
  const level = (menus: MenuService) => menus.controller.view.levels[0]
  const enablement = (items: readonly ResolvedMenuItem[]) => items.map(item => item.kind === 'command' ? `${item.title} ${item.enabled ? '+' : '-'}` : '-')

  it('opens at the pointer for what was right-clicked, focusing it first and outlining it while open', () => {
    const { menus, one, doc, order, event } = setup()
    const click = event(one.button, 120, 50)
    menus.openFromEvent(click)
    expect(click.prevented).toBe(true)
    expect(doc.activeElement).toBe(one.button)
    expect(menus.controller.view).toMatchObject({ source: 'context', mnemonics: false })
    expect(level(menus)).toMatchObject({ label: 'Query tab', active: -1, anchor: { kind: 'point', x: 120, y: 50 } })
    expect(enablement(level(menus).items)).toEqual(['Save +', 'Save As… +', '-', 'Close +', 'Close All But This +', 'Close All +', '-', 'Copy Full Path -', 'Open Containing Folder -'])
    expect(one.tab.hasAttribute('data-menu-target')).toBe(true)
    menus.close('escape')
    expect(one.tab.hasAttribute('data-menu-target')).toBe(false)
    expect(order).toEqual(['restore tab one'])
  })
  it('runs a chosen command with the target as its arguments, after focus is back', async () => {
    const { menus, fixture, one, order, event, first } = setup()
    menus.openFromEvent(event(one.button))
    const items = level(menus).items
    expect(items[indexOf(items, 'file.closeOthers')]).toMatchObject({ args: { tabId: first.id, target: { kind: 'documentTab', tabId: first.id } } })
    menus.controller.click(0, indexOf(items, 'file.closeOthers'))
    expect(order).toEqual(['restore tab one', 'execute file.closeOthers from menu'])
    expect(one.tab.hasAttribute('data-menu-target')).toBe(false)
    await vi.waitFor(() => expect(fixture.documents.getSnapshot().documents.map(document => document.id)).toEqual([first.id]))
  })
  it('opens the focused element\'s menu from the keyboard, below it, first item active with access keys', () => {
    const { menus, one, line, doc, caret } = setup()
    doc.activeElement = one.button
    expect(menus.openForElement(one.button.dom, { keyboard: true })).toBe(true)
    expect(menus.controller.view.mnemonics).toBe(true)
    expect(level(menus)).toMatchObject({ active: 0, anchor: { kind: 'below', rect: { left: 108, top: 40, right: 200, bottom: 68 } } })
    menus.close('escape')
    // The query editor's menu opens below the caret line.
    doc.activeElement = line
    expect(menus.openForElement(line.dom, { keyboard: true })).toBe(true)
    expect(level(menus)).toMatchObject({ label: 'Query editor', active: 0, anchor: { kind: 'below', rect: caret } })
    expect(titles(level(menus).items)).toEqual(['Connection', '-', 'Execute', 'Cancel Executing Query', '-', 'Cut', 'Copy', 'Paste', '-', 'Command Palette…'])
    expect(menus.openForElement(null, { keyboard: true })).toBe(false)
  })
  it('opens a tree\'s menu from the keyboard for its active row, below that row, with focus left on the tree', async () => {
    const { menus, doc, fixture, targets } = setup()
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const root = fixture.explorer.rootIds[0]
    const row = new FakeElement(doc, 'div', { attributes: { id: `oe-${root}`, 'data-row-id': String(root) } }), other = new FakeElement(doc, 'div')
    row.rect = { left: 10, top: 100, right: 260, bottom: 122 }
    const tree = new FakeElement(doc, 'div', { attributes: { tabindex: '0', 'aria-activedescendant': `oe-${root}` } }).append(row)
    tree.rect = { left: 0, top: 50, right: 300, bottom: 400 }
    const view = Object.assign(tree, { scrollTop: 0, clientTop: 0, clientHeight: 350 })
    targets.register(row.dom, element => { const node = fixture.explorer.menuNode(Number(element.getAttribute('data-row-id'))); return node ? { kind: 'explorer', node } : null })
    targets.register(tree.dom, () => ({ kind: 'explorer' }))
    doc.activeElement = tree
    expect(menus.openForElement(tree.dom, { keyboard: true })).toBe(true)
    expect(level(menus)).toMatchObject({ label: 'Object Explorer', active: 0, anchor: { kind: 'below', rect: { left: 18, top: 100, right: 260, bottom: 122 } } })
    expect(titles(level(menus).items)).toEqual(['Connect…', 'Disconnect', '-', 'New Query', '-', 'Copy Name', '-', 'Refresh'])
    expect([row.hasAttribute('data-menu-target'), tree.hasAttribute('data-menu-target'), doc.activeElement]).toEqual([true, false, tree])
    expect(view.scrollTop).toBe(0)
    menus.close('escape')
    // A row scrolled out of the tree's view: the tree scrolls it back into view, and the menu stays within the tree.
    row.rect = { left: 10, top: 500, right: 260, bottom: 522 }
    expect(menus.openForElement(tree.dom, { keyboard: true })).toBe(true)
    expect(view.scrollTop).toBe(122)
    expect(level(menus)).toMatchObject({ label: 'Object Explorer', anchor: { kind: 'below', rect: { left: 18, top: 400, right: 260, bottom: 400 } } })
    menus.close('escape')
    row.rect = { left: 10, top: -40, right: 260, bottom: -18 }
    expect(menus.openForElement(tree.dom, { keyboard: true })).toBe(true)
    expect(view.scrollTop).toBe(32)
    expect(level(menus)).toMatchObject({ anchor: { kind: 'below', rect: { left: 18, top: 50, right: 260, bottom: 50 } } })
    menus.close('escape')
    row.rect = { left: 10, top: 100, right: 260, bottom: 122 }
    // An active descendant outside the tree, or none, leaves the tree's own menu: the empty area's.
    tree.setAttribute('aria-activedescendant', 'elsewhere')
    doc.ids.set('elsewhere', other)
    expect(menus.openForElement(tree.dom, { keyboard: true })).toBe(true)
    expect(titles(level(menus).items)).toEqual(['Connect…', '-', 'Refresh'])
    expect(tree.hasAttribute('data-menu-target')).toBe(true)
  })
  it('opens a results grid\'s menu from the keyboard below its active cell, with focus in the grid', () => {
    const { menus, doc, first } = setup()
    const cell = new FakeElement(doc, 'div', { className: 'rg-c is-act', attributes: { role: 'gridcell' } })
    cell.rect = { left: 400, top: 300, right: 480, bottom: 324 }
    const grid = new FakeElement(doc, 'div', { attributes: { 'data-output-view': 'grid', 'data-tab-id': first.id, 'data-result-index': '0' } }).append(cell)
    expect(menus.openForElement(grid.dom, { keyboard: true })).toBe(true)
    expect(level(menus)).toMatchObject({ label: 'Query output', active: 0, anchor: { kind: 'below', rect: { left: 408, top: 300, right: 480, bottom: 324 } } })
    expect(titles(level(menus).items)).toEqual(['Copy', 'Copy with Headers', '-', 'Select All', '-', 'Save Results As…'])
    expect(doc.activeElement).toBe(grid)
    expect(grid.hasAttribute('data-menu-target')).toBe(false)
  })
  it('ignores events in the menus themselves, and shows nothing (not even the browser\'s menu) where nothing has one', () => {
    const { menus, layer, event, doc } = setup()
    for (const target of [layer.children[0], new FakeElement(doc, 'div')]) {
      const click = event(target)
      menus.openFromEvent(click)
      expect(click.prevented).toBe(true)
      expect(menus.ownsKeyboard()).toBe(false)
    }
  })
  it('gives text fields Undo, the clipboard, Delete, and Select All, by what the field allows', () => {
    const { menus, outside, password, state, doc, event } = setup()
    menus.openFromEvent(event(outside))
    expect(level(menus).label).toBe('Text field')
    expect(enablement(level(menus).items)).toEqual(['Undo +', 'Redo +', '-', 'Cut -', 'Copy -', 'Paste +', 'Delete -', '-', 'Select All +'])
    expect(level(menus).items.find(item => item.kind === 'command' && item.id === 'edit.copy')).toMatchObject({ args: { target: { kind: 'input', element: outside, hasSelection: false } } })
    // The field is outlined while its menu is open, since its selection does not show without focus.
    expect(outside.hasAttribute('data-menu-target')).toBe(true)
    menus.close('escape')
    expect(outside.hasAttribute('data-menu-target')).toBe(false)
    state.modal = true
    menus.openFromEvent(event(password))
    expect(doc.activeElement).toBe(password)
    // Nothing is copied out of a password field.
    expect(enablement(level(menus).items)).toEqual(['Undo +', 'Redo +', '-', 'Cut -', 'Copy -', 'Paste +', 'Delete +', '-', 'Select All +'])
  })
  it('opens only for text fields of the open dialog while a dialog is open', () => {
    const { menus, state, field, outside, one, line, event, order } = setup()
    state.modal = true
    for (const target of [outside, one.button, line]) {
      menus.openFromEvent(event(target))
      expect(menus.ownsKeyboard()).toBe(false)
    }
    expect(menus.openForElement(field.dom, { keyboard: true })).toBe(true)
    const items = level(menus).items
    expect(items[indexOf(items, 'edit.cut')]).toMatchObject({ enabled: true })
    // Cut runs behind the dialog: it is a text-editing command, and focus is back in the field first.
    menus.controller.click(0, indexOf(items, 'edit.cut'))
    expect(order).toEqual(['restore server field', 'execute edit.cut from menu'])
  })
  it('opens nothing when everything in the menu is hidden', () => {
    const { fixture, doc, event } = setup()
    const background = new FakeElement(doc, 'div'), targets = new MenuTargetService()
    targets.register(background.dom, () => ({ kind: 'explorer' }))
    const menus = new MenuService({ platform: 'win32', commands: fixture.commands, context: fixture.context, keybindings: fixture.keybindings, theme: fixture.theme,
      focus: { capture: () => undefined, restore: () => {} }, modalOpen: () => false, targets })
    cleanups.push(() => menus.dispose())
    // Every context menu has items for some target today, so resolution is made to hide them all.
    vi.spyOn(menus, 'resolve').mockReturnValue([{ kind: 'separator', key: 'sep:0' }])
    expect(menus.openForElement(background.dom, { keyboard: true })).toBe(false)
    menus.openFromEvent(event(background))
    expect([menus.ownsKeyboard(), background.hasAttribute('data-menu-target')]).toEqual([false, false])
  })
  it('opens from the window\'s contextmenu event, and stops listening when detached', () => {
    const { menus, one, event } = setup()
    const listeners = new Map<string, (event: unknown) => void>()
    const document = { addEventListener: () => {}, removeEventListener: () => {} }
    const window = { document, addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener) }, removeEventListener: (type: string) => { listeners.delete(type) } }
    const attached = menus.attach(window as unknown as Window)
    listeners.get('contextmenu')!(event(one.button))
    expect(level(menus).label).toBe('Query tab')
    attached.dispose()
    expect(listeners.has('contextmenu')).toBe(false)
  })
})
