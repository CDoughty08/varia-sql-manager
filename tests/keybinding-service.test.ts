import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { contextRecord, type ContextKeys } from '../src/shared/commands/context-keys'
import { defaultRules, platforms, resolveKeybinding, type Platform } from '../src/shared/commands/keybindings'
import { CommandService } from '../src/renderer/src/core/commands'
import { KeybindingService, nativeChordTimeout, type KeyDownEvent, type MenuKeyRouter } from '../src/renderer/src/core/keybindings'
import { workbenchFixture } from './fixtures/workbench'

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

function service(platform: Platform = 'win32', options: { values?: Partial<ContextKeys>; modal?: boolean; textFocus?: boolean; rules?: ReturnType<typeof defaultRules>; menus?: MenuKeyRouter } = {}) {
  const state = { values: options.values ?? {}, modal: options.modal ?? false, textFocus: options.textFocus ?? false, now: 1_000_000 }
  const execute = vi.fn<CommandService['execute']>(async () => true)
  const keybindings = new KeybindingService({
    platform, commands: { execute }, context: { get: () => contextRecord(platform, state.values) }, modalOpen: () => state.modal, editorHasTextFocus: () => state.textFocus,
    editorContains: target => target === editorNode, now: () => state.now, ...(options.rules ? { rules: options.rules } : {}), ...(options.menus ? { menus: options.menus } : {})
  })
  const press = (event: FakeEvent) => { keybindings.handleKeyDown(event); return event }
  const ran = () => execute.mock.calls.map(call => call[0])
  return { keybindings, execute, state, press, ran }
}
const editorText: Partial<ContextKeys> = { editorFocus: true, editorTextFocus: true, textInputFocus: true, activePanel: 'editor' }
afterEach(() => { vi.restoreAllMocks() })

describe('keybinding dispatch', () => {
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
  it('consumes a macOS menu key equivalent where its rule does not apply, so the menu cannot run it there', () => {
    const rules = (platform: Platform) => [resolveKeybinding('query.execute', { key: 'mod+j', when: 'editorFocus' }, platform)!, resolveKeybinding('window.output', { key: 'f6', when: 'editorFocus' }, platform)!]
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
