import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { contextRecord, type ContextKeys } from '../src/shared/commands/context-keys'
import { defaultRules, platforms, resolveKeybinding, type Platform } from '../src/shared/commands/keybindings'
import { CommandService } from '../src/renderer/src/core/commands'
import { KeybindingService, nativeChordTimeout, type KeyDownEvent, type MenuKeyRouter } from '../src/renderer/src/core/keybindings'
import { workbenchFixture } from './fixtures/workbench'
import { effectiveRules } from '../src/shared/commands/effective'
import { emptyShortcutFile, type ShortcutFile } from '../src/shared/commands/shortcut-schema'

interface FakeEvent extends KeyDownEvent { consumed: boolean }
function key(code: string, keyValue: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number; defaultPrevented?: boolean } = {}): FakeEvent {
  const event: FakeEvent = {
    key: keyValue, code, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, altKey: !!modifiers.alt, metaKey: !!modifiers.meta, repeat: !!modifiers.repeat,
    isComposing: !!modifiers.isComposing, keyCode: modifiers.keyCode ?? 0, defaultPrevented: !!modifiers.defaultPrevented, consumed: false,
    preventDefault: () => { event.consumed = true }, stopPropagation: () => { event.consumed = true }
  }
  return event
}
/** Stands for an element inside the query editor, such as Monaco's IME text area. */
const editorNode = new EventTarget()
const mod = (platform: Platform) => platform === 'darwin' ? { meta: true } : { ctrl: true }
const letter = (character: string, platform: Platform, extra: Parameters<typeof key>[2] = {}) => key(`Key${character.toUpperCase()}`, extra.shift ? character.toUpperCase() : character, { ...mod(platform), ...extra })

function service(platform: Platform = 'win32', options: { values?: Partial<ContextKeys>; modal?: boolean; textFocus?: boolean; rules?: ReturnType<typeof defaultRules>; menus?: MenuKeyRouter; keyUp?: (event: FakeEvent) => void } = {}) {
  const state = { values: options.values ?? {}, modal: options.modal ?? false, textFocus: options.textFocus ?? false, now: 1_000_000 }
  const execute = vi.fn<CommandService['execute']>(async () => true)
  const keybindings = new KeybindingService({
    platform, commands: { execute }, context: { get: () => contextRecord(platform, state.values) }, modalOpen: () => state.modal, editorHasTextFocus: () => state.textFocus,
    editorContains: target => target === editorNode, now: () => state.now, ...(options.rules ? { rules: options.rules } : {}), ...(options.menus ? { menus: options.menus } : {}),
    ...(options.keyUp ? { keyUp: options.keyUp as never } : {})
  })
  const press = (event: FakeEvent) => { keybindings.handleKeyDown(event); return event }
  const ran = () => execute.mock.calls.map(call => call[0])
  return { keybindings, execute, state, press, ran }
}
const editorText: Partial<ContextKeys> = { editorFocus: true, editorTextFocus: true, textInputFocus: true, activePanel: 'editor' }
afterEach(() => { vi.restoreAllMocks() })

describe('keybinding dispatch', () => {
  it.each(platforms)('runs Rename on F2 and Delete on Delete (and ⌘⌫ on macOS) only in Object Explorer, consuming the key so the Delete role does not also run, on %s', platform => {
    const { press, ran, state } = service(platform, { values: { activePanel: 'explorer' } })
    const deleteKey = () => key('Delete', 'Delete'), backspace = () => key('Backspace', 'Backspace', { meta: true })
    expect(press(key('F2', 'F2')).consumed).toBe(true)
    const pressed = press(deleteKey())
    // preventDefault keeps Electron from also running the hidden application menu's Delete role accelerator.
    expect(pressed.consumed).toBe(true)
    if (platform === 'darwin') expect(press(backspace()).consumed).toBe(true)
    expect(ran()).toEqual(platform === 'darwin' ? ['explorer.rename', 'explorer.delete', 'explorer.delete'] : ['explorer.rename', 'explorer.delete'])
    // In the Rename box, a filter field or the editor, the keys edit text.
    for (const values of [{ activePanel: 'explorer', inputFocus: true, textInputFocus: true }, editorText, { activePanel: 'output' }] as Partial<ContextKeys>[]) {
      state.values = values
      expect(press(key('F2', 'F2')).consumed, JSON.stringify(values)).toBe(false)
      expect(press(deleteKey()).consumed, JSON.stringify(values)).toBe(false)
    }
    expect(ran()).toHaveLength(platform === 'darwin' ? 3 : 2)
  })
  it.each(platforms)('runs and consumes workbench keys on %s, and leaves every other key alone', platform => {
    const { press, execute, ran } = service(platform)
    expect(press(letter('n', platform)).consumed).toBe(true)
    expect(execute).toHaveBeenLastCalledWith('file.new', undefined, 'keybinding')
    expect(press(letter('s', platform, { shift: true })).consumed).toBe(true)
    expect(press(letter('j', platform)).consumed).toBe(false)
    // Monaco owns undo, find, and comments.
    for (const character of ['z', 'f']) expect(press(letter(character, platform)).consumed, character).toBe(false)
    expect(press(key('Slash', '/', mod(platform))).consumed).toBe(false)
    expect(press(key('KeyN', 'n')).consumed).toBe(false)
    expect(press(key('F8', 'F8')).consumed).toBe(true)
    // Ctrl+Shift+S is Save All on Windows and Linux, as in SSMS; ⇧⌘S stays Save As on macOS.
    expect(ran()).toEqual(['file.new', platform === 'darwin' ? 'file.saveAs' : 'file.saveAll', 'window.explorer'])
  })
  it('adds the SSMS keys on Windows and Linux only', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { press, ran } = service(platform, { values: editorText })
      press(key('KeyE', 'e', { ctrl: true })); press(key('Pause', 'Pause', { alt: true })); press(key('F4', 'F4', { ctrl: true })); press(key('PageDown', 'PageDown', { ctrl: true })); press(key('PageUp', 'PageUp', { ctrl: true })); press(key('KeyZ', 'z', { alt: true }))
      expect(ran(), platform).toEqual(['query.execute', 'query.cancel', 'file.close', 'document.next', 'document.previous', 'editor.toggleWordWrap'])
    }
    const mac = service('darwin', { values: editorText })
    for (const event of [key('KeyE', 'e', { ctrl: true }), key('Pause', 'Pause', { alt: true }), key('F4', 'F4', { ctrl: true }), key('PageDown', 'PageDown', { ctrl: true }), key('KeyZ', 'Ω', { alt: true })]) expect(mac.press(event).consumed, event.code).toBe(false)
    mac.press(key('Tab', 'Tab', { ctrl: true })); mac.press(key('Tab', 'Tab', { ctrl: true, shift: true }))
    expect(mac.ran()).toEqual(['document.next', 'document.previous'])
  })
  it('consumes an auto-repeated key without running it again, unless the rule allows repeats', () => {
    const { press, ran } = service('linux')
    expect(press(letter('n', 'linux', { repeat: true })).consumed).toBe(true)
    expect(press(key('Tab', 'Tab', { ctrl: true, repeat: true })).consumed).toBe(true)
    expect(press(key('Tab', 'Tab', { ctrl: true, shift: true, repeat: true })).consumed).toBe(true)
    expect(ran()).toEqual(['document.next', 'document.previous'])
  })
  it('neither consumes nor runs keys while a modal is open', () => {
    const { press, execute, state } = service('win32', { modal: true })
    for (const event of [letter('n', 'win32'), key('F8', 'F8'), key('Tab', 'Tab', { ctrl: true })]) expect(press(event).consumed).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    state.modal = false
    expect(press(letter('n', 'win32')).consumed).toBe(true)
  })
  it('dispatches only keys marked modal while a modal is open', () => {
    const rules = [resolveKeybinding('edit.undo', { key: 'f7', modal: true }, 'win32')!, resolveKeybinding('file.new', { key: 'f6' }, 'win32')!, resolveKeybinding('edit.redo', { key: 'f9', when: 'queryRunning', modal: true }, 'win32')!]
    const { press, ran, state } = service('win32', { modal: true, rules })
    expect(press(key('F7', 'F7')).consumed).toBe(true)
    expect(press(key('F6', 'F6')).consumed).toBe(false)
    expect(press(key('F9', 'F9')).consumed).toBe(false)
    state.values = { queryRunning: true }
    expect(press(key('F9', 'F9')).consumed).toBe(true)
    state.modal = false
    press(key('F6', 'F6'))
    expect(ran()).toEqual(['edit.undo', 'edit.redo', 'file.new'])
  })
  it('opens context menus with Shift+F10 and the context-menu key, in dialogs too (text fields have menus there)', () => {
    for (const platform of platforms) {
      const { press, ran, state } = service(platform)
      expect(press(key('F10', 'F10', { shift: true })).consumed, platform).toBe(true)
      state.modal = true
      expect(press(key('F10', 'F10', { shift: true })).consumed, platform).toBe(true)
      // The context-menu key is a Windows and Linux key; macOS opens menus with Ctrl+click or Shift+F10.
      expect(press(key('ContextMenu', 'ContextMenu')).consumed, platform).toBe(platform !== 'darwin')
      expect(press(letter('n', platform)).consumed, platform).toBe(false)
      expect(ran(), platform).toEqual(['workbench.showContextMenu', 'workbench.showContextMenu', ...platform === 'darwin' ? [] : ['workbench.showContextMenu']])
    }
  })
  it('ignores IME composition, handled events, and modifier-only presses', () => {
    const { press, execute } = service('win32')
    for (const event of [letter('n', 'win32', { isComposing: true }), letter('n', 'win32', { keyCode: 229 }), letter('n', 'win32', { defaultPrevented: true }), key('ControlLeft', 'Control', { ctrl: true }), key('Quote', 'Dead', { ctrl: true })]) {
      expect(press(event).consumed).toBe(false)
    }
    expect(execute).not.toHaveBeenCalled()
  })
  it('runs F5 by focus: Execute in the editor, Refresh in Object Explorer, nothing in Query Output', () => {
    for (const platform of platforms) {
      const { press, ran, state } = service(platform, { values: editorText })
      expect(press(key('F5', 'F5')).consumed).toBe(true)
      state.values = { activePanel: 'explorer' }
      expect(press(key('F5', 'F5')).consumed).toBe(true)
      // macOS menus carry no F5 key equivalent (menus.ts), so the key is left alone there too.
      state.values = { activePanel: 'output' }
      expect(press(key('F5', 'F5')).consumed, platform).toBe(false)
      // A text field in the explorer does not refresh it.
      state.values = { activePanel: 'explorer', inputFocus: true, textInputFocus: true }
      expect(press(key('F5', 'F5')).consumed, platform).toBe(false)
      expect(ran(), platform).toEqual(['query.execute', 'explorer.refresh'])
    }
  })
  it('runs Ctrl+S as Save Results As in a results grid and as Save everywhere else, consuming it on every platform', () => {
    for (const platform of platforms) {
      const { press, ran, state } = service(platform, { values: editorText })
      expect(press(letter('s', platform)).consumed, platform).toBe(true)
      state.values = { activePanel: 'output', outputGridFocus: true }
      expect(press(letter('s', platform)).consumed, platform).toBe(true)
      // Messages are not a grid: Save saves the query.
      state.values = { activePanel: 'output' }
      expect(press(letter('s', platform)).consumed, platform).toBe(true)
      expect(ran(), platform).toEqual(['file.save', 'output.saveResultsAs', 'file.save'])
    }
  })
  it.each(platforms)('runs a results grid’s Copy and Select All, and Select All in Messages, from the catalogue on %s', platform => {
    const { press, execute, ran, state } = service(platform, { values: { activePanel: 'output', outputGridFocus: true } })
    expect(press(letter('c', platform)).consumed).toBe(true)
    expect(execute).toHaveBeenLastCalledWith('output.copy', undefined, 'keybinding')
    expect(press(letter('a', platform)).consumed).toBe(true)
    // Messages: Select All selects only their text; Ctrl+C stays Chromium's copy of the selected text.
    state.values = { activePanel: 'output', messagesFocus: true }
    expect(press(letter('a', platform)).consumed).toBe(true)
    expect(press(letter('c', platform)).consumed).toBe(false)
    // Anywhere else the keys are Chromium's and Monaco's (the Edit roles).
    for (const values of [editorText, { activePanel: 'output' }, { activePanel: 'explorer', explorerFocus: true }] as Partial<ContextKeys>[]) {
      state.values = values
      expect(press(letter('a', platform)).consumed, JSON.stringify(values)).toBe(false)
      expect(press(letter('c', platform)).consumed, JSON.stringify(values)).toBe(false)
    }
    expect(ran()).toEqual(['output.copy', 'output.selectAll', 'output.selectAll'])
  })
  it.each(platforms)('runs Peek on Space in the Object Explorer tree, but not while type-ahead collects a name or in a text field, on %s', platform => {
    const { press, execute, ran, state } = service(platform, { values: { activePanel: 'explorer', explorerFocus: true } })
    expect(press(key('Space', ' ')).consumed).toBe(true)
    expect(execute).toHaveBeenLastCalledWith('explorer.peek', undefined, 'keybinding')
    // Shift+Space and a held Space do not peek again; the tree swallows Shift+Space itself.
    expect(press(key('Space', ' ', { shift: true })).consumed).toBe(false)
    expect(press(key('Space', ' ', { repeat: true })).consumed).toBe(true)
    for (const values of [{ activePanel: 'explorer', explorerFocus: true, explorerTypeAhead: true }, { activePanel: 'explorer', inputFocus: true, textInputFocus: true },
      { activePanel: 'explorer' }, editorText, { activePanel: 'output', outputGridFocus: true }] as Partial<ContextKeys>[]) {
      state.values = values
      expect(press(key('Space', ' ')).consumed, JSON.stringify(values)).toBe(false)
    }
    expect(ran()).toEqual(['explorer.peek'])
  })
  it.each(platforms)('focuses the Options search on Ctrl+E (⌘E) over the modal Options dialog only, on %s', platform => {
    const { press, execute, ran, state } = service(platform, { modal: true, values: { optionsDialogFocus: true } })
    expect(press(letter('e', platform)).consumed).toBe(true)
    expect(execute).toHaveBeenLastCalledWith('options.focusSearch', undefined, 'keybinding')
    state.values = { optionsDialogFocus: true, inputFocus: true, textInputFocus: true }
    expect(press(letter('e', platform)).consumed).toBe(true)
    // Another dialog keeps its keys.
    state.values = {}
    expect(press(letter('e', platform)).consumed).toBe(false)
    expect(press(letter('e', platform, { shift: true })).consumed).toBe(false)
    expect(ran()).toEqual(['options.focusSearch', 'options.focusSearch'])
  })
  it('consumes a macOS menu key equivalent where its rule does not apply, so the menu cannot run it there', () => {
    const rules = (platform: Platform) => [resolveKeybinding('query.execute', { key: 'mod+j', when: 'editorFocus' }, platform)!, resolveKeybinding('window.results', { key: 'f6', when: 'editorFocus' }, platform)!]
    for (const platform of platforms) {
      const { press, ran } = service(platform, { values: { activePanel: 'output' }, rules: rules(platform) })
      // ⌘J reaches the page before the menu, and the Execute item would show it; F6 has no ⌘, so no menu shows it.
      expect(press(letter('j', platform)).consumed, platform).toBe(platform === 'darwin')
      expect(press(key('F6', 'F6')).consumed, platform).toBe(false)
      expect(ran(), platform).toEqual([])
    }
  })
  it('runs Execute from the editor\'s find widget, as Monaco\'s addAction did, and not from other inputs', () => {
    const { press, ran, state } = service('win32', { values: { editorFocus: true, inputFocus: true, textInputFocus: true, activePanel: 'editor' } })
    expect(press(key('Enter', 'Enter', { ctrl: true })).consumed).toBe(true)
    state.values = { inputFocus: true, textInputFocus: true }
    expect(press(key('Enter', 'Enter', { ctrl: true })).consumed).toBe(false)
    expect(ran()).toEqual(['query.execute'])
  })
  // Ctrl/⌘+K Ctrl/⌘+U is Monaco's Uncomment Selection; Ctrl/⌘+U alone is Change Database.
  it.each(platforms)("lets Monaco's chord prefix and the next key through in editor text on %s", platform => {
    const { press, ran, state } = service(platform, { values: editorText, textFocus: true })
    expect(press(letter('k', platform)).consumed).toBe(false)
    expect(press(letter('u', platform)).consumed).toBe(false)
    expect(ran()).toEqual([])
    // Held modifiers between the two parts do not end the chord.
    press(letter('k', platform)); press(key(platform === 'darwin' ? 'MetaLeft' : 'ControlLeft', platform === 'darwin' ? 'Meta' : 'Control', mod(platform)))
    expect(press(letter('u', platform)).consumed).toBe(false)
    expect(press(letter('u', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['query.changeDatabase'])
    // Outside editor text, Ctrl/⌘+K is not a prefix.
    state.textFocus = false
    press(letter('k', platform))
    expect(press(letter('u', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['query.changeDatabase', 'query.changeDatabase'])
  })
  // Varia's own chords (Bookmarks, Insert Snippet, Surround With) are Monaco's to dispatch through the bridge: their second
  // keys are workbench keys elsewhere (New Query, Go to Query, Save), which must not run.
  it.each(platforms)("passes the second key of Varia's editor chords through to Monaco on %s", platform => {
    const { press, ran, state } = service(platform, { values: editorText, textFocus: true })
    for (const character of ['n', 'p', 's', 'k', 'l', 'x']) {
      expect(press(letter('k', platform)).consumed, character).toBe(false)
      expect(press(letter(character, platform)).consumed, character).toBe(false)
    }
    expect(ran()).toEqual([])
    // Outside editor text Ctrl/⌘+K does nothing, so New Query still has its key.
    state.textFocus = false
    press(letter('k', platform))
    expect(press(letter('n', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['file.new'])
  })
  it.each(platforms)('runs Make Uppercase and Lowercase in editor text only, and Go To Line in the editor on %s', platform => {
    const { press, ran } = service(platform, { values: editorText, textFocus: true })
    expect(press(letter('u', platform, { shift: true })).consumed).toBe(true)
    expect(press(letter('l', platform, { shift: true })).consumed).toBe(true)
    // ⌃G on macOS, where ⌘G is Find Next; Ctrl+G elsewhere.
    expect(press(key('KeyG', 'g', { ctrl: true })).consumed).toBe(true)
    expect(ran()).toEqual(['edit.makeUppercase', 'edit.makeLowercase', 'edit.goToLine'])
    const outside = service(platform, { values: { activePanel: 'explorer' } })
    // macOS's menu would run ⇧⌘U from its key equivalent, so there the key is consumed without running anything.
    const menuKey = platform === 'darwin'
    for (const event of [letter('u', platform, { shift: true }), letter('l', platform, { shift: true })]) expect(outside.press(event).consumed, event.code).toBe(menuKey)
    expect(outside.press(key('KeyG', 'g', { ctrl: true })).consumed).toBe(false)
    expect(outside.ran()).toEqual([])
    // In the find widget (editorFocus without text focus) Ctrl+G still goes to a line; the case keys are the widget's.
    const find = service(platform, { values: { editorFocus: true, inputFocus: true, textInputFocus: true, activePanel: 'editor' } })
    expect(find.press(letter('u', platform, { shift: true })).consumed).toBe(menuKey)
    expect(find.press(key('KeyG', 'g', { ctrl: true })).consumed).toBe(true)
    expect(find.ran()).toEqual(['edit.goToLine'])
  })
  // Monaco stops waiting for the second key after 5 s (and on a dead key); a later key is the workbench's again.
  it.each(platforms)('gives keys back to the workbench once Monaco stops waiting for the chord on %s', platform => {
    const { press, ran, state } = service(platform, { values: editorText, textFocus: true })
    press(letter('k', platform))
    state.now += nativeChordTimeout
    expect(press(letter('u', platform)).consumed).toBe(false)
    expect(ran()).toEqual([])
    press(letter('k', platform))
    state.now += nativeChordTimeout + 1
    expect(press(key('F5', 'F5')).consumed).toBe(true)
    press(letter('k', platform))
    state.now += nativeChordTimeout + 1
    expect(press(letter('u', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['query.execute', 'query.changeDatabase'])
    press(letter('k', platform))
    expect(press(key('Quote', 'Dead')).consumed).toBe(false)
    expect(press(letter('u', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['query.execute', 'query.changeDatabase', 'query.changeDatabase'])
  })
  it('forgets a pending chord prefix when focus moves or the window loses focus', () => {
    const { keybindings, press, ran } = service('win32', { values: editorText, textFocus: true })
    const listeners = new Map<string, EventListener>()
    const target = { addEventListener: vi.fn((type: string, listener: EventListener, _options?: boolean) => { listeners.set(type, listener) }), removeEventListener: vi.fn() }
    const attached = keybindings.attach(target as unknown as EventTarget)
    expect(target.addEventListener.mock.calls.map(call => [call[0], call[2]])).toEqual([['keydown', true], ['keyup', true], ['focusout', true], ['blur', undefined]])
    for (const type of ['focusout', 'blur']) {
      press(letter('k', 'win32'))
      listeners.get(type)!(new Event(type))
      expect(press(letter('u', 'win32')).consumed, type).toBe(true)
    }
    expect(ran()).toEqual(['query.changeDatabase', 'query.changeDatabase'])
    // Monaco 0.57 moves focus to its IME text area after Ctrl+K; focus moving within the editor keeps the chord.
    press(letter('k', 'win32'))
    listeners.get('focusout')!({ type: 'focusout', relatedTarget: editorNode } as unknown as Event)
    expect(press(letter('u', 'win32')).consumed).toBe(false)
    press(letter('k', 'win32'))
    listeners.get('focusout')!({ type: 'focusout', relatedTarget: new EventTarget() } as unknown as Event)
    expect(press(letter('u', 'win32')).consumed).toBe(true)
    expect(ran()).toEqual(['query.changeDatabase', 'query.changeDatabase', 'query.changeDatabase'])
    const event = letter('n', 'win32')
    listeners.get('keydown')!(event as unknown as Event)
    expect(event.consumed).toBe(true)
    attached.dispose()
    expect(target.removeEventListener.mock.calls.map(call => call[0])).toEqual(['keydown', 'keyup', 'focusout', 'blur'])
  })
  it('consumes a key whose command is unavailable, and the command does not run', async () => {
    const fixture = workbenchFixture()
    try {
      const keybindings = new KeybindingService({ platform: 'win32', commands: fixture.commands, context: fixture.context, modalOpen: () => false, editorHasTextFocus: () => false })
      const execute = vi.spyOn(fixture.commands, 'execute'), cancel = vi.spyOn(fixture.queries, 'cancel')
      const event = key('Pause', 'Pause', { alt: true })
      keybindings.handleKeyDown(event)
      expect(event.consumed).toBe(true)
      expect(execute).toHaveBeenCalledWith('query.cancel', undefined, 'keybinding')
      await expect(execute.mock.results[0].value).resolves.toBe(false)
      expect(cancel).not.toHaveBeenCalled()
    } finally { fixture.dispose() }
  })
  it('passes the key the tab focus names, so a key on a focused tab acts on it and menus act on the active document', () => {
    const execute = vi.fn<CommandService['execute']>(async () => true)
    let focused: string | undefined = 'b'
    const keybindings = new KeybindingService({ platform: 'win32', commands: { execute }, context: { get: () => contextRecord('win32') }, modalOpen: () => false, editorHasTextFocus: () => false,
      keyArgs: () => focused ? { tabId: focused } : undefined })
    keybindings.handleKeyDown(letter('n', 'win32'))
    expect(execute).toHaveBeenLastCalledWith('file.new', { tabId: 'b' }, 'keybinding')
    focused = undefined
    keybindings.handleKeyDown(letter('n', 'win32'))
    expect(execute).toHaveBeenLastCalledWith('file.new', undefined, 'keybinding')
  })
  it('contains a failing command service', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const keybindings = new KeybindingService({ platform: 'win32', commands: { execute: () => { throw new Error('boom') } }, context: { get: () => contextRecord('win32') }, modalOpen: () => false, editorHasTextFocus: () => false })
    expect(() => keybindings.handleKeyDown(letter('n', 'win32'))).not.toThrow()
    const throwing = new KeybindingService({ platform: 'win32', commands: { execute: vi.fn() }, context: { get: () => { throw new Error('context') } }, modalOpen: () => false, editorHasTextFocus: () => false })
    expect(() => throwing.handleKeyDown(letter('n', 'win32'))).not.toThrow()
    expect(error).toHaveBeenCalledTimes(2)
  })
  it('gives keys to the menus first while they own the keyboard, then to menu access keys, then to rules', () => {
    const calls: string[] = [], menu = { owns: false, result: 'consumed' as 'consumed' | 'passthrough', access: false }
    const menus: MenuKeyRouter = {
      noteKeyDown: event => { calls.push(`note ${event.key}`) }, ownsKeyboard: () => menu.owns,
      handleKeyDown: event => { calls.push(`menu ${event.key}`); return menu.result },
      handleAccessKey: chord => { calls.push(`access ${chord}`); return menu.access }, handleKeyUp: event => { calls.push(`up ${event.key}`) }
    }
    const { press, ran, state, keybindings } = service('win32', { menus, values: editorText, textFocus: true })
    const step = (event: FakeEvent) => { calls.length = 0; press(event); return [...calls] }
    expect(step(letter('n', 'win32'))).toEqual(['note n', 'access ctrl+n'])
    expect(ran()).toEqual(['file.new'])
    menu.owns = true
    expect(step(letter('n', 'win32'))).toEqual(['note n', 'menu n'])
    expect(ran()).toEqual(['file.new'])
    // The menus closed for a shortcut, which then runs as usual.
    menu.result = 'passthrough'
    expect(step(letter('n', 'win32'))).toEqual(['note n', 'menu n', 'access ctrl+n'])
    expect(ran()).toEqual(['file.new', 'file.new'])
    menu.owns = false
    menu.access = true
    expect(step(key('F8', 'F8'))).toEqual(['note F8', 'access f8'])
    expect(ran()).toEqual(['file.new', 'file.new'])
    // Dialogs: the menus decide what access keys do there; rules not marked modal stay off.
    menu.access = false
    state.modal = true
    expect(step(key('F8', 'F8'))).toEqual(['note F8', 'access f8'])
    state.modal = false
    // IME composition and handled events never reach the menus or the rules.
    expect(step(letter('n', 'win32', { isComposing: true }))).toEqual(['note n'])
    expect(step(letter('n', 'win32', { defaultPrevented: true }))).toEqual([])
    // After Ctrl+K in editor text the next key is Monaco's, even F10.
    press(letter('k', 'win32'))
    expect(step(key('F10', 'F10'))).toEqual(['note F10'])
    calls.length = 0
    keybindings.handleKeyUp(key('AltLeft', 'Alt'))
    expect(calls).toEqual(['up Alt'])
    // Releases also reach the workbench's keyUp (Peek forgets a Ctrl+hover there), after the menus, and consume nothing.
    const released: string[] = []
    const withKeyUp = service('win32', { menus, keyUp: event => { released.push(event.key) } })
    calls.length = 0
    withKeyUp.keybindings.handleKeyUp(key('ControlLeft', 'Control'))
    expect(calls).toEqual(['up Control'])
    expect(released).toEqual(['Control'])
    expect(ran()).toEqual(['file.new', 'file.new'])
  })
  it('labels primary keybindings per platform', () => {
    const labels = (platform: Platform, id: CommandId) => service(platform).keybindings.lookup(id)
    expect(labels('win32', 'file.new')).toEqual({ parts: ['Ctrl+N'], text: 'Ctrl+N', aria: 'Control+N' })
    expect(labels('darwin', 'file.saveAs')).toEqual({ parts: ['⇧⌘S'], text: '⇧⌘S', aria: 'Shift+Command+S' })
    expect(labels('linux', 'query.execute')?.text).toBe('F5')
    expect(labels('win32', 'edit.redo')?.text).toBe('Ctrl+Y')
    expect(labels('darwin', 'query.cancel')).toBeUndefined()
    expect(labels('win32', 'window.editor')).toBeUndefined()
    expect(labels('win32', 'edit.commentLines')).toEqual({ parts: ['Ctrl+K', 'Ctrl+C'], text: 'Ctrl+K Ctrl+C', aria: 'Control+K, then Control+C' })
    expect(labels('darwin', 'edit.uncommentLines')?.text).toBe('⌘K ⌘U')
  })
  it('rejects conflicting rules in development and keeps the first in production', () => {
    const conflicting = [resolveKeybinding('file.new', { key: 'f6' }, 'win32')!, resolveKeybinding('file.open', { key: 'f6' }, 'win32')!]
    const options = { platform: 'win32' as const, context: { get: () => contextRecord('win32') }, modalOpen: () => false, editorHasTextFocus: () => false, rules: conflicting }
    expect(() => new KeybindingService({ ...options, commands: { execute: vi.fn() }, onConflict: 'throw' })).toThrow('file.new and file.open both match f6')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const execute = vi.fn<CommandService['execute']>(async () => true)
    new KeybindingService({ ...options, commands: { execute }, onConflict: 'log' }).handleKeyDown(key('F6', 'F6'))
    expect(error).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('file.new', undefined, 'keybinding')
  })
})

const userFile = (bindings: ShortcutFile['bindings']): ShortcutFile => ({ ...emptyShortcutFile, bindings })
/** New Query moved from Ctrl/⌘+N to Ctrl/⌘+Shift+F9, as the Shortcuts page would save it. */
const remapped = (platform: Platform) => {
  const effective = effectiveRules(platform, userFile([{ command: 'file.new', key: 'mod+n', remove: true }, { command: 'file.new', key: 'mod+shift+f9' }]))
  expect(effective.problems, platform).toEqual([])
  return effective.rules
}
const f9 = (platform: Platform) => key('F9', 'F9', { ...mod(platform), shift: true })

describe('keybinding rules at run time', () => {
  it.each(platforms)('swaps every table, label and listener at once with setRules on %s', platform => {
    const { press, ran, keybindings } = service(platform)
    const changes = vi.fn()
    const unsubscribe = keybindings.subscribe(changes)
    expect(keybindings.lookup('file.new')?.text).toBe(platform === 'darwin' ? '⌘N' : 'Ctrl+N')
    const revision = keybindings.getRevision()
    const rules = remapped(platform)
    keybindings.setRules(rules)
    expect([keybindings.getRules(), keybindings.getRevision(), changes.mock.calls.length]).toEqual([rules, revision + 1, 1])
    expect(keybindings.lookup('file.new')?.text).toBe(platform === 'darwin' ? '⇧⌘F9' : 'Ctrl+Shift+F9')
    // The old key is free (nothing else has it), and the new one runs the command.
    expect(press(letter('n', platform)).consumed).toBe(false)
    expect(press(f9(platform)).consumed).toBe(true)
    expect(ran()).toEqual(['file.new'])
    // The same rules again change nothing; going back restores the catalogue's key.
    keybindings.setRules(rules)
    expect(changes).toHaveBeenCalledOnce()
    keybindings.setRules(defaultRules(platform))
    expect(press(letter('n', platform)).consumed).toBe(true)
    expect(press(f9(platform)).consumed).toBe(false)
    unsubscribe()
    keybindings.setRules(rules)
    expect(changes).toHaveBeenCalledTimes(2)
  })
  it('logs conflicting rules from setRules instead of throwing, and a failing listener does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { keybindings, press, ran } = service('win32')
    const second = vi.fn()
    keybindings.subscribe(() => { throw new Error('listener failed') })
    keybindings.subscribe(second)
    const clash = [resolveKeybinding('file.new', { key: 'f6' }, 'win32')!, resolveKeybinding('file.open', { key: 'f6' }, 'win32')!]
    expect(() => keybindings.setRules(clash)).not.toThrow()
    expect(error).toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    press(key('F6', 'F6'))
    expect(ran()).toEqual(['file.new'])
  })
  it.each(platforms)("keeps Monaco's pending chord prefix across a swap on %s, and dispatches by the new rules after it", platform => {
    const { press, ran, state, keybindings } = service(platform, { values: editorText, textFocus: true })
    expect(press(letter('k', platform)).consumed).toBe(false)
    keybindings.setRules(remapped(platform))
    // Monaco still waits for the chord's second key, whatever the rules: it is not dispatched, even if it is now a shortcut.
    expect(press(f9(platform)).consumed).toBe(false)
    expect(press(f9(platform)).consumed).toBe(true)
    // A swap after Monaco stopped waiting leaves nothing pending.
    press(letter('k', platform))
    state.now += nativeChordTimeout + 1
    keybindings.setRules(defaultRules(platform))
    expect(press(letter('n', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['file.new', 'file.new'])
  })
  it('follows the new rules for macOS menu key equivalents', () => {
    const before = (platform: Platform) => [resolveKeybinding('query.execute', { key: 'mod+j', when: 'editorFocus' }, platform)!]
    const after = (platform: Platform) => [resolveKeybinding('query.execute', { key: 'mod+l', when: 'editorFocus' }, platform)!]
    for (const platform of platforms) {
      const { press, ran, keybindings } = service(platform, { values: { activePanel: 'output' }, rules: before(platform) })
      expect(press(letter('j', platform)).consumed, platform).toBe(platform === 'darwin')
      keybindings.setRules(after(platform))
      // ⌘J is no longer the Execute item's key equivalent, so the page leaves it alone; ⌘L is now.
      expect(press(letter('j', platform)).consumed, platform).toBe(false)
      expect(press(letter('l', platform)).consumed, platform).toBe(platform === 'darwin')
      expect(ran(), platform).toEqual([])
    }
  })
})

describe('key capture', () => {
  function capturing(platform: Platform, options: Parameters<typeof service>[1] = {}) {
    const calls: string[] = []
    const menus: MenuKeyRouter = {
      noteKeyDown: event => { calls.push(`note ${event.key}`) }, ownsKeyboard: () => false, handleKeyDown: () => 'passthrough',
      handleAccessKey: chord => { calls.push(`access ${chord}`); return false }, handleKeyUp: event => { calls.push(`up ${event.key}`) }
    }
    const setup = service(platform, { menus, ...options })
    const chords: string[] = [], prefixes: string[] = []
    const stop = setup.keybindings.capture(chord => { chords.push(chord) }, { onPrefix: chord => { prefixes.push(chord) } })
    return { ...setup, calls, chords, prefixes, stop }
  }
  it.each(platforms)('records chords instead of menus, access keys and dispatch on %s, and dispatches again once stopped', platform => {
    const { press, ran, calls, chords, stop, keybindings } = capturing(platform)
    expect(keybindings.capturing).toBe(true)
    expect(press(letter('n', platform)).consumed).toBe(true)
    expect(press(key('F10', 'F10')).consumed).toBe(true)
    expect(press(key('F4', 'F4', { alt: true })).consumed).toBe(true)
    // Escape and Enter are recorded, as SSMS does; modifier presses alone record nothing and pass.
    expect(press(key('Escape', 'Escape')).consumed).toBe(true)
    expect(press(key('Enter', 'Enter')).consumed).toBe(true)
    expect(press(key('ShiftLeft', 'Shift', { shift: true })).consumed).toBe(false)
    expect(chords).toEqual([platform === 'darwin' ? 'meta+n' : 'ctrl+n', 'f10', 'alt+f4', 'escape', 'enter'])
    expect([ran(), calls]).toEqual([[], []])
    // A bare Alt release is part of a chord, not a tap that focuses the menubar.
    keybindings.handleKeyUp(key('AltLeft', 'Alt'))
    expect(calls).toEqual([])
    stop()
    expect(keybindings.capturing).toBe(false)
    expect(press(letter('n', platform)).consumed).toBe(true)
    expect(ran()).toEqual(['file.new'])
    expect(chords).toHaveLength(5)
  })
  it.each(platforms)('never captures Tab or Shift+Tab, so focus leaves the box, on %s', platform => {
    const { press, chords } = capturing(platform)
    expect(press(key('Tab', 'Tab')).consumed).toBe(false)
    expect(press(key('Tab', 'Tab', { shift: true })).consumed).toBe(false)
    // Ctrl+Tab is a chord like any other.
    expect(press(key('Tab', 'Tab', { ctrl: true })).consumed).toBe(true)
    expect(chords).toEqual(['ctrl+tab'])
  })
  it.each(platforms)('makes a two-part chord from Ctrl/⌘+K and the next chord within the timeout on %s', platform => {
    const { press, chords, prefixes, state } = capturing(platform)
    const prefix = platform === 'darwin' ? 'meta+k' : 'ctrl+k', c = platform === 'darwin' ? 'meta+c' : 'ctrl+c'
    expect(press(letter('k', platform)).consumed).toBe(true)
    expect([chords, prefixes]).toEqual([[], [prefix]])
    press(letter('c', platform))
    expect(chords).toEqual([`${prefix} ${c}`])
    // Escape after the prefix is the second part too.
    press(letter('k', platform)); press(key('Escape', 'Escape'))
    expect(chords.at(-1)).toBe(`${prefix} escape`)
    // After the timeout the next chord stands alone; Tab forgets the prefix.
    press(letter('k', platform))
    state.now += nativeChordTimeout + 1
    press(letter('c', platform))
    press(letter('k', platform)); press(key('Tab', 'Tab')); press(letter('c', platform))
    expect(chords.slice(2)).toEqual([c, c])
    expect(prefixes).toHaveLength(4)
  })
  it('ignores repeats, IME composition and dead keys, and takes keys before modal rules', () => {
    const { press, chords, ran } = capturing('win32', { modal: true, values: { optionsDialogFocus: true } as Partial<ContextKeys> })
    // Options' Ctrl+E is a modal rule (options.focusSearch); the capture box in Options records it instead.
    expect(press(key('KeyE', 'e', { ctrl: true })).consumed).toBe(true)
    expect(press(key('KeyE', 'e', { ctrl: true, repeat: true })).consumed).toBe(true)
    expect(press(key('KeyE', 'e', { isComposing: true })).consumed).toBe(false)
    expect(press(key('BracketLeft', 'Dead')).consumed).toBe(false)
    expect(press(key('KeyE', 'e', { ctrl: true, defaultPrevented: true })).consumed).toBe(false)
    expect([chords, ran()]).toEqual([['ctrl+e'], []])
  })
  it('lets a later capture replace an earlier one, whose stop then does nothing', () => {
    const { press, chords, stop, keybindings } = capturing('linux')
    const later: string[] = []
    const stopLater = keybindings.capture(chord => { later.push(chord) })
    press(key('F7', 'F7'))
    stop()
    press(key('F8', 'F8'))
    expect([chords, later]).toEqual([[], ['f7', 'f8']])
    stopLater(); stopLater()
    expect(keybindings.capturing).toBe(false)
  })
  it('keeps a capture prefix across setRules', () => {
    const { press, chords, keybindings } = capturing('win32')
    press(key('KeyK', 'k', { ctrl: true }))
    keybindings.setRules(remapped('win32'))
    press(key('KeyX', 'x', { ctrl: true }))
    expect(chords).toEqual(['ctrl+k ctrl+x'])
  })
})

describe('key capture beside menus and teardown', () => {
  it('leaves keys to a menu that owns the keyboard while a capture records', () => {
    const calls: string[] = [], menu = { owns: true }
    const menus: MenuKeyRouter = {
      noteKeyDown: event => { calls.push(`note ${event.key}`) }, ownsKeyboard: () => menu.owns,
      handleKeyDown: event => { calls.push(`menu ${event.key}`); return 'consumed' },
      handleAccessKey: () => false, handleKeyUp: event => { calls.push(`up ${event.key}`) }
    }
    const { keybindings, press } = service('win32', { menus })
    const chords: string[] = []
    keybindings.capture(chord => { chords.push(chord) })
    press(key('Escape', 'Escape'))
    keybindings.handleKeyUp(key('Escape', 'Escape'))
    expect([calls, chords]).toEqual([['note Escape', 'menu Escape', 'up Escape'], []])
    menu.owns = false
    calls.length = 0
    press(key('Escape', 'Escape'))
    keybindings.handleKeyUp(key('Escape', 'Escape'))
    expect([calls, chords]).toEqual([[], ['escape']])
  })
  it('says when a waiting Ctrl+K is dropped: Tab, a dead key, or a key after the timeout', () => {
    const { keybindings, press, state } = service('win32')
    const events: string[] = []
    keybindings.capture(chord => { events.push(chord) }, { onPrefix: chord => { events.push(`prefix ${chord}`) }, onPrefixCancel: () => { events.push('cancel') } })
    const ctrlK = () => key('KeyK', 'k', { ctrl: true })
    press(ctrlK()); press(key('Tab', 'Tab'))
    press(ctrlK()); press(key('BracketLeft', 'Dead'))
    press(ctrlK()); state.now += nativeChordTimeout + 1; press(key('F7', 'F7'))
    // Nothing waits, so these cancel nothing; a completed chord is not a cancel either.
    press(key('Tab', 'Tab')); press(ctrlK()); press(key('KeyC', 'c', { ctrl: true }))
    expect(events).toEqual(['prefix ctrl+k', 'cancel', 'prefix ctrl+k', 'cancel', 'prefix ctrl+k', 'cancel', 'f7', 'prefix ctrl+k', 'ctrl+k ctrl+c'])
  })
  it('forgets the capture when the service is disposed', () => {
    const { keybindings, press, ran } = service('win32')
    const chords: string[] = []
    keybindings.capture(chord => { chords.push(chord) })
    keybindings.dispose()
    expect(keybindings.capturing).toBe(false)
    press(key('F8', 'F8'))
    expect([chords, ran()]).toEqual([[], ['window.explorer']])
  })
})
