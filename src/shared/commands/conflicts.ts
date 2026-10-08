import { commandDescriptor, type CommandId } from './catalog'
import { contextKeyValues, contextRecord, keysOfScope, type ContextKey, type ContextKeys, type FocusKeys } from './context-keys'
import { reservedReason, splitChord, workbenchRules, type Platform, type ResolvedRule } from './keybindings'
import { evaluateWhen, referencedKeys } from './when'

/** Representative places focus can be. Each fixes every focus key; keys it does not list are false or ''. */
export const focusSamples: readonly { readonly name: string; readonly keys: Partial<FocusKeys> }[] = [
  { name: 'editorText', keys: { editorFocus: true, editorTextFocus: true, textInputFocus: true, activePanel: 'editor' } },
  { name: 'editorFindInput', keys: { editorFocus: true, inputFocus: true, textInputFocus: true, activePanel: 'editor' } },
  { name: 'explorerTree', keys: { activePanel: 'explorer' } },
  { name: 'outputGrid', keys: { activePanel: 'output' } },
  { name: 'toolbarSelect', keys: { inputFocus: true, textInputFocus: true } },
  { name: 'titleBar', keys: {} },
  { name: 'quickInput', keys: { inputFocus: true, textInputFocus: true } },
  { name: 'body', keys: {} }
]

export interface Conflict {
  readonly kind: 'overlap' | 'reserved' | 'typing' | 'modal'
  readonly chord: string
  readonly commands: readonly CommandId[]
  readonly message: string
}

// Both `when` clauses together may read this many state keys; 2^12 contexts per focus sample is still instant.
const maxEnumeratedKeys = 12
const stateKeys = new Set<string>(keysOfScope('state'))
// Keys that type or move the caret when pressed without Ctrl, Alt, or ⌘ (Shift still types).
const typingKeys = new Set(['space', 'enter', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right'])
const typesText = (chord: string) => {
  const { modifiers, key } = splitChord(chord)
  return !modifiers.has('ctrl') && !modifiers.has('alt') && !modifiers.has('meta') && (key.length === 1 || typingKeys.has(key))
}

type Context = ReturnType<typeof contextRecord>
/**
 * The first focus sample, combined with some assignment of the state keys `rules` read, where `holds` is true. Focus
 * keys come from the samples and static keys from the platform; only state keys vary freely.
 */
function findContext(rules: readonly ResolvedRule[], platform: Platform, holds: (context: Context) => boolean): string | undefined {
  const keys = [...new Set(rules.flatMap(rule => rule.when ? referencedKeys(rule.when) : []))].filter((key): key is ContextKey => stateKeys.has(key))
  if (keys.length > maxEnumeratedKeys) throw new Error(`Keybindings for ${rules[0].chords[0]} read ${keys.length} state keys; conflict analysis enumerates at most ${maxEnumeratedKeys}.`)
  const assignments = function* (index: number, values: Record<string, boolean | string>): Generator<Record<string, boolean | string>> {
    if (index === keys.length) { yield values; return }
    for (const value of contextKeyValues(keys[index])) yield* assignments(index + 1, { ...values, [keys[index]]: value })
  }
  for (const sample of focusSamples) for (const values of assignments(0, {})) {
    if (holds(contextRecord(platform, { ...sample.keys, ...values } as Partial<ContextKeys>))) return sample.name
  }
  return undefined
}
const active = (rule: ResolvedRule, context: Context) => !rule.when || evaluateWhen(rule.when, context)

/**
 * Problems with workbench keybindings on `platform`: two commands that can both match one key press, reserved chords,
 * typing keys that are not limited to `!textInputFocus`, and keys on commands that also run while a modal is open
 * (a dialog's own keys must win). Native rules belong to Monaco and are not checked.
 */
export function findConflicts(rules: readonly ResolvedRule[], platform: Platform): Conflict[] {
  const conflicts: Conflict[] = []
  for (const [chord, list] of workbenchRules(rules)) {
    for (const rule of list) {
      const reason = reservedReason(chord, platform)
      if (reason) conflicts.push({ kind: 'reserved', chord, commands: [rule.command], message: `${rule.command}: ${chord} is reserved (${reason}).` })
      if (commandDescriptor(rule.command).allowInModal) conflicts.push({ kind: 'modal', chord, commands: [rule.command], message: `${rule.command} runs while a modal is open, so it cannot have the workbench key ${chord}.` })
      if (typesText(chord)) {
        const sample = findContext([rule], platform, context => context.textInputFocus && active(rule, context))
        if (sample) conflicts.push({ kind: 'typing', chord, commands: [rule.command], message: `${rule.command}: ${chord} types text, so it must not match while text input has focus (it does in ${sample}); add !textInputFocus.` })
      }
    }
    for (let first = 0; first < list.length; first++) for (let second = first + 1; second < list.length; second++) {
      const a = list[first], b = list[second]
      if (a.command === b.command) continue
      const sample = findContext([a, b], platform, context => active(a, context) && active(b, context))
      if (sample) conflicts.push({ kind: 'overlap', chord, commands: [a.command, b.command], message: `${a.command} and ${b.command} both match ${chord} in ${sample}.` })
    }
  }
  return conflicts
}
