import { describe, expect, it, vi } from 'vitest'
// Monaco's own KeyMod, KeyCode and KeyChord: the DOM-free modules editor.api.js re-exports.
import { KeyMod } from 'monaco-editor/editor/common/services/editorBaseApi.js'
import { KeyCode } from 'monaco-editor/editor/common/standalone/standaloneEnums.js'
import { KeyChord } from 'monaco-editor/base/common/keyCodes.js'
import { bridgeRules, platforms } from '../src/shared/commands/keybindings'
import { bridgeCommandId, registerEditorBridge, toMonacoKeybinding, type BridgeMonaco } from '../src/renderer/src/editor/keybinding-bridge'

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
    expect(expected.map(rule => rule.command)).toEqual(['edit.toggleBookmark', 'edit.previousBookmark', 'edit.nextBookmark', 'edit.clearBookmarks', 'edit.insertSnippet', 'edit.surroundWith'])
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
