import { describe, expect, it, vi } from 'vitest'
// Monaco's own KeyMod, KeyCode and KeyChord: the DOM-free modules editor.api.js re-exports.
import { KeyMod } from 'monaco-editor/editor/common/services/editorBaseApi.js'
import { KeyCode } from 'monaco-editor/editor/common/standalone/standaloneEnums.js'
import { KeyChord } from 'monaco-editor/base/common/keyCodes.js'
import { bridgeRules, defaultRules, parseKeySpec, platforms, type Platform, type ResolvedRule } from '../src/shared/commands/keybindings'
import { effectiveRules } from '../src/shared/commands/effective'
import { emptyShortcutFile } from '../src/shared/commands/shortcut-schema'
import { bridgeCommandId, followEditorBridge, registerEditorBridge, toMonacoKeybinding, type BridgeMonaco } from '../src/renderer/src/editor/keybinding-bridge'

function fakeMonaco() {
  const commands = new Map<string, (...args: unknown[]) => void>(), rules: { keybinding: number; command: string; when: string }[] = []
  const monaco: BridgeMonaco = { editor: {
    registerCommand: (id, handler) => { commands.set(id, handler); return { dispose: () => commands.delete(id) } },
    addKeybindingRules: added => { rules.push(...added); return { dispose: () => { for (const rule of added) rules.splice(rules.indexOf(rule), 1) } } }
  } }
  return { monaco, commands, rules }
}

describe('editor keybinding bridge', () => {
  it("encodes chords as Monaco's KeyMod and KeyCode numbers on each platform", () => {
    expect(toMonacoKeybinding(['ctrl+k', 'ctrl+k'], 'win32')).toBe(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyK))
    expect(toMonacoKeybinding(['ctrl+k', 'ctrl+x'], 'linux')).toBe(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyX))
    // ⌘ is CtrlCmd on macOS, and ⌃ is WinCtrl there.
    expect(toMonacoKeybinding(['meta+k', 'meta+n'], 'darwin')).toBe(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyN))
    expect(toMonacoKeybinding(['ctrl+g'], 'darwin')).toBe(KeyMod.WinCtrl | KeyCode.KeyG)
    expect(toMonacoKeybinding(['meta+g'], 'win32')).toBe(KeyMod.WinCtrl | KeyCode.KeyG)
    expect(toMonacoKeybinding(['ctrl+shift+alt+f3'], 'win32')).toBe(KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.F3)
    for (const [key, code] of [['/', KeyCode.Slash], ['\\', KeyCode.Backslash], ['`', KeyCode.Backquote], ['0', KeyCode.Digit0], ['f24', KeyCode.F24], ['pagedown', KeyCode.PageDown], ['contextmenu', KeyCode.ContextMenu]] as const) {
      expect(toMonacoKeybinding([key], 'win32'), key).toBe(code)
    }
    expect(() => toMonacoKeybinding([], 'win32')).toThrow()
  })
  it.each(platforms)('registers exactly the catalogue bridge rules in editor text on %s, and removes them on dispose', platform => {
    const { monaco, commands, rules } = fakeMonaco(), execute = vi.fn(async () => true)
    const registration = registerEditorBridge(monaco, { execute }, platform)
    const expected = bridgeRules(platform)
    expect(expected.map(rule => rule.command)).toEqual(['editor.splitDown', 'editor.focusNextGroup', 'editor.focusPreviousGroup', 'edit.toggleBookmark', 'edit.previousBookmark', 'edit.nextBookmark', 'edit.clearBookmarks', 'edit.insertSnippet', 'edit.surroundWith'])
    expect(rules).toEqual(expected.map(rule => ({ keybinding: toMonacoKeybinding(rule.chords, platform), command: bridgeCommandId(rule.command), when: 'editorTextFocus' })))
    expect([...commands.keys()]).toEqual(expected.map(rule => 'varia.' + rule.command))
    commands.get('varia.edit.nextBookmark')!({})
    expect(execute).toHaveBeenCalledWith('edit.nextBookmark', undefined, 'keybinding')
    registration.dispose(); registration.dispose()
    expect([commands.size, rules.length]).toEqual([0, 0])
  })
  it('leaves nothing registered when a registration fails', () => {
    const { monaco, commands } = fakeMonaco()
    monaco.editor.addKeybindingRules = () => { throw new Error('no keybinding service') }
    expect(() => registerEditorBridge(monaco, { execute: vi.fn() }, 'win32')).toThrow('no keybinding service')
    expect(commands.size).toBe(0)
  })
})

describe('editor keybinding bridge following the rules', () => {
  /** A rule source as KeybindingService is one: rules, and a listener per swap. */
  function source(platform: Platform, initial: readonly ResolvedRule[] = defaultRules(platform)) {
    let rules = initial
    const listeners = new Set<() => void>()
    return {
      getRules: () => rules,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next: readonly ResolvedRule[]) => { rules = next; listeners.forEach(listener => listener()) },
      listeners
    }
  }
  const keyOf = (platform: Platform, spec: string) => toMonacoKeybinding(parseKeySpec(spec, platform), platform)

  it.each(platforms)("registers the user's two-part chords again when the rules change on %s, and only the new ones", platform => {
    const { monaco, commands, rules } = fakeMonaco(), execute = vi.fn(async () => true), report = vi.fn()
    const rulesSource = source(platform)
    const registration = followEditorBridge(monaco, { execute }, platform, rulesSource, report)
    expect(rules).toHaveLength(bridgeRules(platform).length)
    const effective = effectiveRules(platform, { ...emptyShortcutFile, bindings: [
      { command: 'edit.nextBookmark', key: 'mod+k mod+n', remove: true }, { command: 'edit.nextBookmark', key: 'mod+k mod+j', scope: 'queryEditor' }
    ] })
    expect(effective.problems).toEqual([])
    rulesSource.set(effective.rules)
    const next = rules.filter(rule => rule.command === 'varia.edit.nextBookmark').map(rule => rule.keybinding)
    expect(next).toEqual([keyOf(platform, 'mod+k mod+j')])
    expect(rules).toHaveLength(bridgeRules(platform).length)
    expect(commands.has('varia.edit.nextBookmark')).toBe(true)
    commands.get('varia.edit.nextBookmark')!()
    expect(execute).toHaveBeenCalledWith('edit.nextBookmark', undefined, 'keybinding')
    expect(report).not.toHaveBeenCalled()
    registration.dispose()
    expect([commands.size, rules.length, rulesSource.listeners.size]).toEqual([0, 0, 0])
  })
  it('leaves Monaco alone when a swap does not change the bridge rules', () => {
    const { monaco } = fakeMonaco()
    const add = vi.spyOn(monaco.editor, 'addKeybindingRules')
    const rulesSource = source('win32')
    followEditorBridge(monaco, { execute: vi.fn() }, 'win32', rulesSource, vi.fn())
    rulesSource.set([...defaultRules('win32')].filter(rule => rule.command !== 'file.new'))
    expect(add).toHaveBeenCalledOnce()
  })
  it('keeps the previous chords and reports when registering the new ones fails', () => {
    const { monaco, rules } = fakeMonaco(), report = vi.fn()
    const rulesSource = source('linux')
    followEditorBridge(monaco, { execute: vi.fn() }, 'linux', rulesSource, report)
    const before = [...rules]
    const add = monaco.editor.addKeybindingRules
    let failures = 1
    monaco.editor.addKeybindingRules = added => { if (failures-- > 0) throw new Error('no keybinding service'); return add(added) }
    rulesSource.set(defaultRules('linux').filter(rule => rule.command !== 'edit.clearBookmarks'))
    expect(report).toHaveBeenCalledWith(new Error('no keybinding service'))
    expect(rules).toEqual(before)
  })
})
