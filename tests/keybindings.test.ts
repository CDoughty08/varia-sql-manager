import { describe, expect, it } from 'vitest'
import type { CommandId } from '../src/shared/commands/catalog'
import { contextRecord, type ContextKeys } from '../src/shared/commands/context-keys'
import {
  ariaLabel, chordFromEvent, defaultRules, formatLabel, keybindingLabel, KeySpecError, parseKeySpec, platforms, primaryRule, reservedChords, reservedReason,
  resolveKeybinding, specForPlatform, toAccelerator, toPlatform, workbenchRules, type KeyEventLike, type Platform
} from '../src/shared/commands/keybindings'
import { applicationMenus, menuAccelerator, menuCommandIds } from '../src/shared/commands/menus'
import { evaluateWhen } from '../src/shared/commands/when'

const event = (key: string, code: string, modifiers: Partial<Pick<KeyEventLike, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode'>> = {}, altGraph = false): KeyEventLike =>
  ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers, getModifierState: (name: string) => name === 'AltGraph' && altGraph })
const letter = (character: string) => `Key${character.toUpperCase()}`
/** The command a key press runs on `platform` in a context, as the dispatcher will resolve it. */
const commandFor = (input: KeyEventLike, platform: Platform, values: Partial<ContextKeys> = {}): CommandId | undefined => {
  const chord = chordFromEvent(input, platform)
  const context = contextRecord(platform, values)
  return chord === undefined ? undefined : workbenchRules(defaultRules(platform)).get(chord)?.find(rule => !rule.when || evaluateWhen(rule.when, context))?.command
}

describe('key specs', () => {
  it('parse into canonical chords per platform', () => {
    expect(parseKeySpec('mod+shift+p', 'win32')).toEqual(['ctrl+shift+p'])
    expect(parseKeySpec('mod+shift+p', 'linux')).toEqual(['ctrl+shift+p'])
    expect(parseKeySpec('mod+shift+p', 'darwin')).toEqual(['shift+meta+p'])
    expect(parseKeySpec('meta+alt+shift+ctrl+x', 'win32')).toEqual(['ctrl+shift+alt+meta+x'])
    expect(parseKeySpec('cmd+option+f', 'darwin')).toEqual(['alt+meta+f'])
    expect(parseKeySpec('Ctrl+Shift+P', 'win32')).toEqual(['ctrl+shift+p'])
    expect(parseKeySpec('mod+k mod+c', 'win32')).toEqual(['ctrl+k', 'ctrl+c'])
    expect(parseKeySpec('mod+k mod+c', 'darwin')).toEqual(['meta+k', 'meta+c'])
    expect(parseKeySpec('ctrl+mod+p', 'darwin')).toEqual(['ctrl+meta+p'])
    for (const key of ['f1', 'f24', 'pageup', 'contextmenu', 'pause', '/', '\\', ',', '.', ';', "'", '[', ']', '-', '=', '`', '0', 'space']) expect(parseKeySpec(`alt+${key}`, 'win32'), key).toEqual([`alt+${key}`])
  })
  it('reject repeated modifiers, missing or unknown keys, and more than two parts', () => {
    const invalid: [string, Platform][] = [['mod+mod+p', 'win32'], ['ctrl+mod+p', 'linux'], ['cmd+meta+p', 'darwin'], ['ctrl+', 'win32'], ['ctrl++', 'win32'], ['', 'win32'],
      ['ctrl+foo', 'win32'], ['f25', 'win32'], ['hyper+a', 'win32'], ['a b c', 'win32'], ['ctrl+k+c', 'win32']]
    for (const [spec, platform] of invalid) expect(() => parseKeySpec(spec, platform), spec).toThrow(KeySpecError)
    expect(parseKeySpec(' ctrl+k  ctrl+c ', 'win32')).toEqual(['ctrl+k', 'ctrl+c'])
  })
  it('allow two-part chords only on native keybindings', () => {
    expect(() => resolveKeybinding('file.new', { key: 'mod+k mod+n' }, 'win32')).toThrow(/only native keybindings may be chords/)
    expect(resolveKeybinding('file.new', { key: 'mod+k mod+n', native: true }, 'darwin')).toMatchObject({ chords: ['meta+k', 'meta+n'], native: true, allowRepeat: false })
  })
  it('apply platform overrides, null meaning unbound', () => {
    const spec = { key: 'mod+e', win: 'ctrl+shift+e', mac: null }
    expect(specForPlatform(spec, 'win32')).toBe('ctrl+shift+e')
    expect(specForPlatform(spec, 'linux')).toBe('mod+e')
    expect(specForPlatform(spec, 'darwin')).toBeUndefined()
    expect(specForPlatform({ win: 'ctrl+e', linux: 'ctrl+e' }, 'darwin')).toBeUndefined()
    expect(resolveKeybinding('file.new', { key: 'f5', when: 'editorFocus', allowRepeat: true }, 'linux')).toMatchObject({ chords: ['f5'], whenSource: 'editorFocus', allowRepeat: true, native: false, when: { type: 'key', key: 'editorFocus' } })
  })
  it('map unknown platforms to Linux', () => {
    expect(['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'aix', undefined, 7].map(toPlatform)).toEqual(['win32', 'darwin', 'linux', 'linux', 'linux', 'linux', 'linux', 'linux', 'linux'])
  })
})

describe('key events', () => {
  it('read letters from the layout, or the physical key when the layout types something else', () => {
    expect(chordFromEvent(event('n', 'KeyN', { ctrlKey: true }), 'win32')).toBe('ctrl+n')
    expect(chordFromEvent(event('N', 'KeyN', { ctrlKey: true, shiftKey: true }), 'win32')).toBe('ctrl+shift+n')
    expect(chordFromEvent(event('a', 'KeyQ', { ctrlKey: true }), 'win32')).toBe('ctrl+a')
    expect(chordFromEvent(event('q', 'KeyA', { ctrlKey: true }), 'linux')).toBe('ctrl+q')
    expect(chordFromEvent(event('ы', 'KeyS', { ctrlKey: true }), 'win32')).toBe('ctrl+s')
    expect(chordFromEvent(event('π', 'KeyP', { altKey: true }), 'darwin')).toBe('alt+p')
    expect(chordFromEvent(event('p', 'KeyP', { metaKey: true, shiftKey: true }), 'darwin')).toBe('shift+meta+p')
    expect(chordFromEvent(event('ü', 'BracketLeft', { ctrlKey: true }), 'win32')).toBe('ctrl+[')
  })
  it('read digits and punctuation from the physical key, so Shift does not change them', () => {
    expect(chordFromEvent(event('!', 'Digit1', { ctrlKey: true, shiftKey: true }), 'win32')).toBe('ctrl+shift+1')
    expect(chordFromEvent(event('&', 'Digit1', { ctrlKey: true }), 'win32')).toBe('ctrl+1')
    expect(chordFromEvent(event('/', 'Slash', { ctrlKey: true }), 'linux')).toBe('ctrl+/')
    expect(chordFromEvent(event('?', 'Slash', { shiftKey: true }), 'win32')).toBe('shift+/')
    expect(chordFromEvent(event('/', 'Digit7', { shiftKey: true }), 'win32')).toBe('shift+7')
    expect(chordFromEvent(event('5', 'Numpad5'), 'win32')).toBe('5')
    expect(chordFromEvent(event('+', 'NumpadAdd'), 'win32')).toBeUndefined()
  })
  it('name the other keys', () => {
    expect(chordFromEvent(event('F5', 'F5'), 'win32')).toBe('f5')
    expect(chordFromEvent(event('F24', 'F24', { shiftKey: true }), 'win32')).toBe('shift+f24')
    expect(chordFromEvent(event('ArrowUp', 'ArrowUp', { altKey: true }), 'win32')).toBe('alt+up')
    expect(chordFromEvent(event('End', 'Numpad1'), 'win32')).toBe('end')
    expect(chordFromEvent(event(' ', 'Space', { ctrlKey: true }), 'win32')).toBe('ctrl+space')
    expect(chordFromEvent(event(' ', 'Space', { altKey: true }), 'darwin')).toBe('alt+space')
    expect(chordFromEvent(event('Enter', 'NumpadEnter', { ctrlKey: true }), 'win32')).toBe('ctrl+enter')
    expect(chordFromEvent(event('Pause', 'Pause', { altKey: true }), 'win32')).toBe('alt+pause')
    expect(chordFromEvent(event('Cancel', 'Pause', { ctrlKey: true }), 'win32')).toBe('ctrl+pause')
    expect(chordFromEvent(event('Tab', 'Tab', { ctrlKey: true, shiftKey: true }), 'linux')).toBe('ctrl+shift+tab')
    expect(chordFromEvent(event('ContextMenu', 'ContextMenu'), 'win32')).toBe('contextmenu')
    expect(chordFromEvent(event('Escape', 'Escape'), 'darwin')).toBe('escape')
  })
  it('ignore composition, dead keys, and modifier-only presses', () => {
    expect(chordFromEvent(event('a', 'KeyA', { ctrlKey: true, isComposing: true }), 'win32')).toBeUndefined()
    expect(chordFromEvent(event('a', 'KeyA', { ctrlKey: true, keyCode: 229 }), 'win32')).toBeUndefined()
    expect(chordFromEvent(event('Process', 'KeyA'), 'win32')).toBeUndefined()
    expect(chordFromEvent(event('Dead', 'BracketLeft', { shiftKey: true }), 'linux')).toBeUndefined()
    expect(chordFromEvent(event('Unidentified', 'KeyA'), 'linux')).toBeUndefined()
    for (const [key, code] of [['Control', 'ControlLeft'], ['Shift', 'ShiftRight'], ['Alt', 'AltLeft'], ['Meta', 'MetaLeft'], ['AltGraph', 'AltRight'], ['CapsLock', 'CapsLock']]) {
      expect(chordFromEvent(event(key, code, { ctrlKey: true, shiftKey: true }), 'win32'), key).toBeUndefined()
    }
  })
  it('drop Ctrl and Alt for AltGr on Windows and Linux, but not for ⌥ on macOS', () => {
    expect(chordFromEvent(event('@', 'KeyQ', { ctrlKey: true, altKey: true }, true), 'win32')).toBe('q')
    expect(chordFromEvent(event('€', 'KeyE', { ctrlKey: true, altKey: true, shiftKey: true }, true), 'linux')).toBe('shift+e')
    expect(chordFromEvent(event('n', 'KeyN', { ctrlKey: true, altKey: true }), 'win32')).toBe('ctrl+alt+n')
    expect(chordFromEvent(event('π', 'KeyP', { altKey: true }, true), 'darwin')).toBe('alt+p')
  })
  it('produce chords that parse back unchanged', () => {
    const samples = [event('N', 'KeyN', { ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }), event('!', 'Digit1', { shiftKey: true }), event('PageDown', 'PageDown', { ctrlKey: true }), event('?', 'Slash', { metaKey: true, shiftKey: true })]
    for (const platform of platforms) for (const sample of samples) {
      const chord = chordFromEvent(sample, platform)!
      expect(parseKeySpec(chord, platform), chord).toEqual([chord])
    }
  })
})

describe('keybinding labels', () => {
  const table: [Record<Platform, string>, Record<Platform, [label: string, aria: string, accelerator: string | undefined]>][] = [
    [{ win32: 'ctrl+shift+p', linux: 'ctrl+shift+p', darwin: 'shift+meta+p' }, {
      win32: ['Ctrl+Shift+P', 'Control+Shift+P', 'Ctrl+Shift+P'], linux: ['Ctrl+Shift+P', 'Control+Shift+P', 'Ctrl+Shift+P'], darwin: ['⇧⌘P', 'Shift+Command+P', 'Cmd+Shift+P']
    }],
    [{ win32: 'f5', linux: 'f5', darwin: 'f5' }, { win32: ['F5', 'F5', 'F5'], linux: ['F5', 'F5', 'F5'], darwin: ['F5', 'F5', 'F5'] }],
    [{ win32: 'ctrl+enter', linux: 'ctrl+enter', darwin: 'meta+enter' }, {
      win32: ['Ctrl+Enter', 'Control+Enter', 'Ctrl+Enter'], linux: ['Ctrl+Enter', 'Control+Enter', 'Ctrl+Enter'], darwin: ['⌘↩', 'Command+Enter', 'Cmd+Enter']
    }],
    [{ win32: 'alt+pause', linux: 'alt+pause', darwin: 'alt+pause' }, { win32: ['Alt+Pause', 'Alt+Pause', undefined], linux: ['Alt+Pause', 'Alt+Pause', undefined], darwin: ['⌥Pause', 'Option+Pause', undefined] }],
    [{ win32: 'ctrl+tab', linux: 'ctrl+tab', darwin: 'ctrl+tab' }, { win32: ['Ctrl+Tab', 'Control+Tab', 'Ctrl+Tab'], linux: ['Ctrl+Tab', 'Control+Tab', 'Ctrl+Tab'], darwin: ['⌃⇥', 'Control+Tab', 'Ctrl+Tab'] }],
    [{ win32: 'ctrl+shift+alt+meta+x', linux: 'ctrl+shift+alt+meta+x', darwin: 'ctrl+shift+alt+meta+x' }, {
      win32: ['Ctrl+Shift+Alt+Win+X', 'Control+Shift+Alt+Windows+X', 'Ctrl+Shift+Alt+Super+X'], linux: ['Ctrl+Shift+Alt+Super+X', 'Control+Shift+Alt+Super+X', 'Ctrl+Shift+Alt+Super+X'],
      darwin: ['⌃⌥⇧⌘X', 'Control+Option+Shift+Command+X', 'Cmd+Ctrl+Alt+Shift+X']
    }],
    [{ win32: 'ctrl+/', linux: 'ctrl+/', darwin: 'meta+/' }, { win32: ['Ctrl+/', 'Control+Slash', 'Ctrl+/'], linux: ['Ctrl+/', 'Control+Slash', 'Ctrl+/'], darwin: ['⌘/', 'Command+Slash', 'Cmd+/'] }],
    [{ win32: 'shift+pagedown', linux: 'shift+pagedown', darwin: 'shift+pagedown' }, {
      win32: ['Shift+PageDown', 'Shift+Page Down', 'Shift+PageDown'], linux: ['Shift+PageDown', 'Shift+Page Down', 'Shift+PageDown'], darwin: ['⇧⇟', 'Shift+Page Down', 'Shift+PageDown']
    }],
    [{ win32: 'contextmenu', linux: 'shift+f10', darwin: 'escape' }, { win32: ['Menu', 'Context Menu', undefined], linux: ['Shift+F10', 'Shift+F10', 'Shift+F10'], darwin: ['⎋', 'Escape', 'Escape'] }]
  ]
  it.each(table)('show %o per platform', (chords, expected) => {
    for (const platform of platforms) {
      const chord = chords[platform]
      expect([formatLabel(chord, platform), ariaLabel(chord, platform), toAccelerator([chord], platform)], `${platform} ${chord}`).toEqual(expected[platform])
    }
  })
  it('join two-part chords and never make accelerators of them', () => {
    expect(keybindingLabel(['ctrl+k', 'ctrl+c'], 'win32')).toEqual({ parts: ['Ctrl+K', 'Ctrl+C'], text: 'Ctrl+K Ctrl+C', aria: 'Control+K, then Control+C' })
    expect(keybindingLabel(['meta+k', 'meta+c'], 'darwin')).toEqual({ parts: ['⌘K', '⌘C'], text: '⌘K ⌘C', aria: 'Command+K, then Command+C' })
    expect(toAccelerator(['ctrl+k', 'ctrl+c'], 'win32')).toBeUndefined()
    expect(toAccelerator([], 'win32')).toBeUndefined()
  })
  it('give every menu command with a primary keybinding an accelerator, only with ⌘ on macOS', () => {
    // Electron has no accelerator name for Pause, so Cancel's menu item shows no key.
    const unnamed = new Set(['win32 query.cancel', 'linux query.cancel'])
    for (const platform of platforms) for (const id of menuCommandIds) {
      const rule = primaryRule(id, platform), accelerator = menuAccelerator(id, platform)
      // macOS menus would take keys without ⌘ before the page does.
      const shown = rule && !unnamed.has(`${platform} ${id}`) && (platform !== 'darwin' || rule.chords[0].includes('meta+'))
      if (shown) expect(accelerator, `${platform} ${id}`).toMatch(platform === 'darwin' ? /^Cmd(\+(Ctrl|Alt|Shift))*\+[^+]+$/ : /^((Ctrl|Alt|Shift|Super)\+)*[^+]+$/)
      else expect(accelerator, `${platform} ${id}`).toBeUndefined()
    }
    expect((['query.execute', 'window.explorer', 'document.next', 'document.previous'] as const).map(id => menuAccelerator(id, 'darwin'))).toEqual([undefined, undefined, undefined, undefined])
    expect(menuAccelerator('query.execute', 'win32')).toBe('F5')
  })
})

describe('default keybindings', () => {
  it('resolve once per platform, in catalogue order', () => {
    expect(defaultRules('win32')).toBe(defaultRules('win32'))
    expect(Object.isFrozen(defaultRules('darwin'))).toBe(true)
    const native = ['edit.find', 'edit.replace', 'edit.toggleLineComment', 'edit.commentLines', 'edit.uncommentLines']
    const clipboard = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'], display = ['view.zoomIn', 'view.zoomIn', 'view.zoomOut', 'view.resetZoom', 'view.toggleFullScreen', 'developer.toggleDevTools']
    const output = ['output.copy', 'output.copyWithHeaders', 'output.selectAll', 'output.saveResultsAs']
    for (const platform of ['win32', 'linux'] as const) {
      expect(defaultRules(platform).map(rule => rule.command)).toEqual(['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'file.close', 'window.close', 'edit.undo', 'edit.redo', 'edit.redo', ...clipboard,
        'window.explorer', 'view.toggleResultsPane', 'window.switchPane', 'window.switchPane', 'query.execute', 'query.execute', 'query.execute', 'query.cancel', 'workbench.showCommands', 'workbench.showCommands', 'workbench.showContextMenu',
        'workbench.showContextMenu', 'workbench.quickOpen', 'explorer.refresh', 'explorer.rename', 'explorer.delete',
        'query.changeDatabase', 'document.next', 'document.next', 'document.previous', 'document.previous', 'editor.toggleWordWrap', ...native, ...display, ...output])
    }
    expect(defaultRules('darwin').map(rule => rule.command)).toEqual(['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'edit.undo', 'edit.redo', ...clipboard, 'window.explorer', 'view.toggleResultsPane', 'window.switchPane', 'window.switchPane',
      'query.execute', 'query.execute', 'workbench.showCommands', 'workbench.showCommands', 'workbench.showContextMenu', 'workbench.quickOpen', 'explorer.refresh', 'explorer.rename', 'explorer.delete', 'explorer.delete', 'query.changeDatabase',
      'document.next', 'document.previous', ...native,
      'preferences.options', ...display, ...output])
    expect(defaultRules('win32').find(rule => rule.command === 'window.close')?.chords).toEqual(['alt+f4'])
    expect(defaultRules('linux').find(rule => rule.command === 'window.close')?.chords).toEqual(['ctrl+q'])
  })
  it('pick the first one-chord rule as the primary, native or not', () => {
    expect(primaryRule('edit.redo', 'win32')).toMatchObject({ chords: ['ctrl+y'], native: true })
    expect(primaryRule('edit.redo', 'darwin')).toMatchObject({ chords: ['shift+meta+z'], native: true })
    expect(primaryRule('query.execute', 'linux')).toMatchObject({ chords: ['f5'], whenSource: 'editorFocus', native: false })
    expect(primaryRule('file.saveAs', 'darwin')?.chords).toEqual(['shift+meta+s'])
    expect(primaryRule('window.explorer', 'win32')?.chords).toEqual(['f8'])
    expect(primaryRule('file.close', 'linux')?.chords).toEqual(['ctrl+w'])
    expect(primaryRule('query.cancel', 'win32')?.chords).toEqual(['alt+pause'])
    expect(primaryRule('query.cancel', 'darwin')).toBeUndefined()
    // Two-part chords have no single-key label or accelerator.
    expect(primaryRule('edit.commentLines', 'win32')).toBeUndefined()
    expect(primaryRule('window.editor', 'win32')).toBeUndefined()
  })
  it('leave native keys out of the dispatch table', () => {
    for (const platform of platforms) {
      const table = workbenchRules(defaultRules(platform))
      expect([...table.values()].flat().every(rule => !rule.native && rule.chords.length === 1), platform).toBe(true)
      expect(table.has(platform === 'darwin' ? 'meta+z' : 'ctrl+z'), platform).toBe(false)
    }
  })
  // Before PR2, main's before-input-event and bindFileShortcuts mapped Ctrl/⌘ letters through fileShortcut (this table),
  // and Monaco's addAction bound F5 and Ctrl/⌘+Enter in the editor; the catalogue must give the same commands. Ctrl/⌘
  // letters it left alone stay unbound, except the keys PR2 and PR3 add: the palette, Change Database, and the results
  // pane toggle (SSMS) everywhere, and the SSMS Execute key in the editor on Windows and Linux.
  it('match the legacy file shortcuts and editor actions', () => {
    const legacy: Readonly<Record<string, CommandId>> = { n: 'file.new', o: 'file.open', s: 'file.save', w: 'file.close', 'shift+s': 'file.saveAs' }
    const palette: Readonly<Record<string, CommandId>> = { p: 'workbench.quickOpen', 'shift+p': 'workbench.showCommands', u: 'query.changeDatabase', r: 'view.toggleResultsPane' }
    const added: Readonly<Record<Platform, Readonly<Record<string, CommandId>>>> = { win32: { e: 'query.execute' }, linux: { e: 'query.execute' }, darwin: {} }
    for (const platform of platforms) {
      const primary = platform === 'darwin' ? 'metaKey' : 'ctrlKey'
      for (const character of 'abcdefghijklmnopqrstuvwxyz') for (const shiftKey of [false, true]) {
        const input = event(shiftKey ? character.toUpperCase() : character, letter(character), { [primary]: true, shiftKey })
        const name = `${shiftKey ? 'shift+' : ''}${character}`
        expect(commandFor(input, platform), `${platform} ${name}`).toBe(legacy[name] ?? palette[name])
        if (!shiftKey) expect(commandFor(input, platform, { editorFocus: true }), `${platform} ${name} in the editor`).toBe(legacy[name] ?? palette[name] ?? added[platform][name])
        for (const extra of ['altKey', platform === 'darwin' ? 'ctrlKey' : 'metaKey']) {
          expect(commandFor(event(character, letter(character), { [primary]: true, shiftKey, [extra]: true }), platform), `${platform} ${extra} ${character}`).toBeUndefined()
        }
      }
      const enter = event('Enter', 'Enter', { [primary]: true }), f5 = event('F5', 'F5')
      expect(commandFor(f5, platform, { editorFocus: true })).toBe('query.execute')
      expect(commandFor(enter, platform, { editorFocus: true, inputFocus: true })).toBe('query.execute')
      expect(commandFor(f5, platform, { activePanel: 'output' })).toBeUndefined()
      expect(commandFor(enter, platform, {})).toBeUndefined()
    }
    expect(commandFor(event('n', 'KeyN', { ctrlKey: true, altKey: true }), 'win32')).toBeUndefined()
    expect(commandFor(event('n', 'KeyN', { ctrlKey: true, metaKey: true }), 'linux')).toBeUndefined()
    expect(commandFor(event('n', 'KeyN', { ctrlKey: true }), 'darwin')).toBeUndefined()
  })
})

describe('reserved keys', () => {
  it('list canonical chords only', () => {
    for (const platform of platforms) for (const chord of reservedChords(platform).keys()) expect(parseKeySpec(chord, platform), `${platform} ${chord}`).toEqual([chord])
  })
  it('cover every menu mnemonic and the editor chord prefix', () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const menu of applicationMenus) expect(reservedReason(`alt+${menu.mnemonic}`, platform), menu.id).toBe('opens a menu')
      expect(reservedReason('ctrl+k', platform)).toBeDefined()
    }
    expect(reservedReason('meta+k', 'darwin')).toBeDefined()
  })
  it('protect AltGr on Windows and Linux and ⌥ typing on macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(reservedReason('ctrl+alt+n', platform)).toBe('AltGr types characters with Ctrl+Alt')
      expect(reservedReason('ctrl+shift+alt+e', platform)).toBe('AltGr types characters with Ctrl+Alt')
      expect(reservedReason('ctrl+alt+f5', platform)).toBeUndefined()
      expect(reservedReason('alt+z', platform)).toBeUndefined()
    }
    for (const chord of ['alt+p', 'shift+alt+2', 'alt+/', 'alt+space']) expect(reservedReason(chord, 'darwin'), chord).toBe('⌥ types characters on macOS')
    for (const chord of ['alt+f5', 'alt+meta+n', 'ctrl+alt+p', 'alt+enter']) expect(reservedReason(chord, 'darwin'), chord).toBeUndefined()
    expect(reservedReason('ctrl+alt+n', 'darwin')).toBeUndefined()
  })
  it('follow Electron and Monaco per platform', () => {
    expect(reservedReason('ctrl+q', 'linux')).toBeDefined()
    expect(reservedReason('ctrl+q', 'win32')).toBeUndefined()
    expect(reservedReason('ctrl+shift+a', 'linux')).toBeDefined()
    expect(reservedReason('ctrl+shift+a', 'win32')).toBeUndefined()
    expect(reservedReason('meta+q', 'darwin')).toBeDefined()
    expect(reservedReason('ctrl+e', 'darwin')).toBe('an emacs editing key')
    expect(reservedReason('ctrl+e', 'win32')).toBeUndefined()
  })
})
