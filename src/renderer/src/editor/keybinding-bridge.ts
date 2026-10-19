// Varia's own two-part editor chords (Ctrl+K Ctrl+K and the like). Monaco owns chord mode in editor text, so these
// are registered with Monaco from the catalogue and Monaco dispatches them; the workbench never swallows the second key,
// which would leave Monaco waiting and eat the keystroke after it.
import type { CommandId } from '../../../shared/commands/catalog'
import { bridgeRules, splitChord, type Platform, type ResolvedRule } from '../../../shared/commands/keybindings'
import type { CommandService } from '../core/commands'
import type { Disposable } from '../core/types'

/** Monaco's KeyMod bits. */
const keyMod = { ctrlCmd: 2048, shift: 1024, alt: 512, winCtrl: 256 } as const
/** Monaco's KeyCode values for the keys the catalogue can name (`keyNames`). */
const keyCodes: Readonly<Record<string, number>> = {
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((key, index) => [key, 31 + index])),
  ...Object.fromEntries([...'0123456789'].map((key, index) => [key, 21 + index])),
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`f${index + 1}`, 59 + index])),
  ';': 85, '=': 86, ',': 87, '-': 88, '.': 89, '/': 90, '`': 91, '[': 92, '\\': 93, ']': 94, "'": 95,
  backspace: 1, tab: 2, enter: 3, pause: 7, escape: 9, space: 10, pageup: 11, pagedown: 12, end: 13, home: 14, left: 15, up: 16, right: 17, down: 18,
  insert: 19, delete: 20, contextmenu: 58
}

function chordCode(chord: string, platform: Platform): number {
  const { modifiers, key } = splitChord(chord), code = keyCodes[key]
  if (code === undefined) throw new Error(`Monaco has no key code for "${key}".`)
  // CtrlCmd is ⌘ on macOS and Ctrl elsewhere; WinCtrl is the other one.
  const mac = platform === 'darwin'
  return code | (modifiers.has('ctrl') ? (mac ? keyMod.winCtrl : keyMod.ctrlCmd) : 0) | (modifiers.has('meta') ? (mac ? keyMod.ctrlCmd : keyMod.winCtrl) : 0)
    | (modifiers.has('shift') ? keyMod.shift : 0) | (modifiers.has('alt') ? keyMod.alt : 0)
}

/** Monaco's numeric keybinding for canonical chords: one, or two combined as `KeyChord(a, b)`. */
export function toMonacoKeybinding(chords: readonly string[], platform: Platform): number {
  if (chords.length < 1 || chords.length > 2) throw new Error('A keybinding has one or two parts.')
  const [first, second] = chords.map(chord => chordCode(chord, platform))
  return second === undefined ? first : (first | ((second & 0xffff) << 16)) >>> 0
}

/** The parts of Monaco's API the bridge uses, so tests can pass a fake. */
export interface BridgeMonaco {
  readonly editor: {
    registerCommand(id: string, handler: (...args: unknown[]) => void): Disposable
    addKeybindingRules(rules: { keybinding: number; command: string; when: string }[]): Disposable
  }
}
export const bridgeCommandId = (id: CommandId): string => 'varia.' + id

/**
 * Registers each bridge rule with Monaco: a `varia.<id>` command that runs the catalogue command as its key would, and
 * the chord in editor text. One Disposable removes everything, so a reloaded module or a disposed workbench leaves none.
 */
export function registerEditorBridge(monaco: BridgeMonaco, commands: Pick<CommandService, 'execute'>, platform: Platform, rules: readonly ResolvedRule[] = bridgeRules(platform)): Disposable {
  const registrations: Disposable[] = []
  try {
    for (const rule of rules) {
      const command = bridgeCommandId(rule.command)
      registrations.push(monaco.editor.registerCommand(command, () => { void commands.execute(rule.command, undefined, 'keybinding') }))
    }
    registrations.push(monaco.editor.addKeybindingRules(rules.map(rule => ({ keybinding: toMonacoKeybinding(rule.chords, platform), command: bridgeCommandId(rule.command), when: 'editorTextFocus' }))))
  } catch (error) {
    registrations.forEach(registration => registration.dispose())
    throw error
  }
  return { dispose: () => registrations.splice(0).forEach(registration => registration.dispose()) }
}
