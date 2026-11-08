import { commandDescriptor, type CommandId, type RoleName } from './catalog'
import { compileWhen } from './when'
import { parseKeySpec, splitChord, type Platform, type ResolvedRule } from './keybindings'
import { scopeWhen, shortcutScope, type ScopeId } from './scopes'

/**
 * Which shortcuts a user may change, and how a user shortcut becomes a rule. Editability is derived from the catalogue:
 * a command with a native, non-bridge key belongs to Monaco or Chromium (Editor, locked until Monaco remaps arrive); the
 * clipboard roles, quit and window close stay with the system for good; a dialog's own keys stay with the dialog, since a
 * user shortcut has no scope for one and would run over every other dialog too.
 */
export interface ShortcutLock { readonly source: 'editor' | 'system' | 'dialog'; readonly reason: string }

const systemRoles: Partial<Record<RoleName, string>> = {
  cut: 'The clipboard keys stay with the system.', copy: 'The clipboard keys stay with the system.', paste: 'The clipboard keys stay with the system.',
  delete: 'The editing keys stay with the system.', selectAll: 'The editing keys stay with the system.', quit: 'Quit stays with the system.'
}
const systemCommands: Partial<Record<CommandId, string>> = { 'window.close': 'Closing the window stays with the system.' }
const dialogCommands: Partial<Record<CommandId, string>> = { 'options.focusSearch': 'Search Options works only in the Options dialog, so its key stays with the dialog.' }
const editorReason = 'The editor or the browser handles this key, so it cannot be changed yet.'

/** Why no shortcut of `command` can be added or removed, or undefined when they can. */
export function shortcutLock(command: CommandId): ShortcutLock | undefined {
  const descriptor = commandDescriptor(command)
  const system = (descriptor.role && systemRoles[descriptor.role]) ?? systemCommands[command]
  if (system) return { source: 'system', reason: system }
  const dialog = dialogCommands[command]
  if (dialog) return { source: 'dialog', reason: dialog }
  if (!descriptor.role && (descriptor.keybindings ?? []).some(spec => spec.native && !spec.bridge)) return { source: 'editor', reason: editorReason }
  return undefined
}
/** Why `rule` cannot be removed or reassigned, or undefined when it can. */
export const ruleLock = (rule: ResolvedRule): ShortcutLock | undefined => shortcutLock(rule.command)

// Keys that type or move the caret when pressed without Ctrl, Alt, or ⌘ (Shift still types).
const typingKeys = new Set(['space', 'enter', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right'])
/** Whether `chord` types text or moves the caret in a text box. */
export function typesText(chord: string): boolean {
  const { modifiers, key } = splitChord(chord)
  return !modifiers.has('ctrl') && !modifiers.has('alt') && !modifiers.has('meta') && (key.length === 1 || typingKeys.has(key))
}

export interface ShortcutCandidate {
  readonly command: CommandId
  readonly key: string
  /** Absent is Global. */
  readonly scope?: ScopeId
}

/**
 * The rule a user shortcut becomes on `platform`; throws `KeySpecError` when `key` does not parse. A two-part key is a
 * bridge rule (Monaco dispatches it in editor text, with no `when`); a role command's key is native (main registers it
 * as a menu accelerator) and Global; anything else is a workbench rule with the scope's clause, plus the typing guard for
 * an unmodified typing key. `validateShortcut` decides whether the rule is allowed.
 */
export function resolveShortcut(candidate: ShortcutCandidate, platform: Platform): ResolvedRule {
  const chords = parseKeySpec(candidate.key, platform)
  const descriptor = commandDescriptor(candidate.command)
  const scope = candidate.scope ?? 'global'
  const allowRepeat = (descriptor.keybindings ?? []).some(spec => spec.allowRepeat)
  const base = { command: candidate.command, chords, allowRepeat, modal: descriptor.allowInModal === true }
  if (chords.length > 1) return { ...base, native: true, bridge: true }
  if (descriptor.role) return { ...base, native: true, bridge: false }
  const whenSource = scopeWhen(scope, typesText(chords[0]) && shortcutScope(scope).typing === 'guard')
  return { ...base, native: false, bridge: false, ...(whenSource === undefined ? {} : { when: compileWhen(whenSource), whenSource }) }
}

export const sameChords = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((chord, index) => chord === b[index])
