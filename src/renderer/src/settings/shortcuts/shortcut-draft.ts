// The Shortcuts page's draft without the DOM: the rows its table shows, and every edit it stages (assign, remove,
// restore, reset, import) as a new `ShortcutFile`. Nothing here saves; OK in Options does (`commitOptions`).
import { commandDescriptor, commandIds, type Category, type CommandId } from '../../../../shared/commands/catalog'
import { validateShortcut, type ShortcutVerdict } from '../../../../shared/commands/conflicts'
import { effectiveRules, type EffectiveShortcuts } from '../../../../shared/commands/effective'
import { keybindingLabel, KeySpecError, parseKeySpec, splitChord, type KeybindingLabel, type Platform, type ResolvedRule } from '../../../../shared/commands/keybindings'
import { scopeOfWhen, shortcutScope, type ScopeId, type ScopeKind } from '../../../../shared/commands/scopes'
import { bindingApplies, shortcutLimits, type ShortcutBinding, type ShortcutFile } from '../../../../shared/commands/shortcut-schema'
import { sameChords, shortcutLock, type ShortcutLock } from '../../../../shared/commands/shortcut-rules'

/** Where a row's shortcut comes from: the catalogue, the user, a default the user removed, or a locked owner. */
export type BindingSource = 'default' | 'user' | 'removed' | ShortcutLock['source']
export const sourceTitles: Readonly<Record<BindingSource | 'builtin', string>> = {
  default: 'Default', user: 'User', removed: 'Removed', editor: 'Editor', system: 'System', dialog: 'Dialog', builtin: 'Built in'
}

export interface BindingRow {
  readonly rule: ResolvedRule
  readonly label: KeybindingLabel
  readonly scope: ScopeKind
  readonly scopeTitle: string
  readonly source: BindingSource
  /** The index in the draft's `bindings` of the user's addition (source `user`) or removal (source `removed`). */
  readonly entry?: number
}
export interface CommandRow {
  readonly id: CommandId
  readonly title: string
  readonly category: Category | 'Other'
  readonly bindings: readonly BindingRow[]
  readonly lock?: ShortcutLock
  /** A user addition or removal on this platform: the row's dot. */
  readonly changed: boolean
  /** The draft has an entry for this command that does not apply (refused or conflicting): the Conflicts chip. */
  readonly problem: boolean
}

/** The scope a rule works in: a bridge chord in the query editor, otherwise its `when`'s preset (or Custom). */
export const ruleScope = (rule: ResolvedRule): ScopeKind => rule.bridge ? 'queryEditor' : scopeOfWhen(rule.whenSource).id
export const scopeTitle = (scope: ScopeKind): string => scope === 'custom' ? 'Custom' : shortcutScope(scope).title

const parses = (key: string, platform: Platform): string[] | undefined => {
  try { return parseKeySpec(key, platform) } catch (error) { if (error instanceof KeySpecError) return undefined; throw error }
}
/** The draft entry a user rule came from: an addition of its command, key and scope that applies on `platform`. */
export function additionIndex(file: ShortcutFile, rule: ResolvedRule, platform: Platform): number {
  const scope = ruleScope(rule)
  return file.bindings.findIndex(binding => !binding.remove && bindingApplies(binding, platform) && binding.command === rule.command && (binding.scope ?? 'global') === scope && sameChords(parses(binding.key, platform) ?? [], rule.chords))
}
/** The draft entry that removed a default rule. */
export function removalIndex(file: ShortcutFile, rule: ResolvedRule, platform: Platform): number {
  return file.bindings.findIndex(binding => binding.remove && bindingApplies(binding, platform) && binding.command === rule.command && sameChords(parses(binding.key, platform) ?? [], rule.chords))
}

/**
 * Every command with its shortcuts on `platform` as the draft makes them, in catalogue order: user additions first
 * (narrowest scope first, as they apply), then the remaining defaults, then the defaults the draft removed.
 */
export function commandRows(file: ShortcutFile, platform: Platform, effective: EffectiveShortcuts = effectiveRules(platform, file)): CommandRow[] {
  const users = new Set(effective.userRules)
  const problemCommands = new Set(effective.problems.filter(problem => problem.source === 'user' && problem.index >= 0).map(problem => file.bindings[problem.index]?.command))
  const byCommand = new Map<CommandId, BindingRow[]>()
  const push = (rule: ResolvedRule, source: BindingSource, entry?: number) => {
    const scope = ruleScope(rule)
    const row: BindingRow = { rule, label: keybindingLabel(rule.chords, platform), scope, scopeTitle: scopeTitle(scope), source, ...entry !== undefined && entry >= 0 ? { entry } : {} }
    const list = byCommand.get(rule.command)
    if (list) list.push(row); else byCommand.set(rule.command, [row])
  }
  for (const rule of effective.rules) {
    if (users.has(rule)) push(rule, 'user', additionIndex(file, rule, platform))
    else push(rule, shortcutLock(rule.command)?.source ?? 'default')
  }
  for (const rule of effective.removed) push(rule, 'removed', removalIndex(file, rule, platform))
  return commandIds.map(id => {
    const descriptor = commandDescriptor(id), bindings = byCommand.get(id) ?? [], lock = shortcutLock(id)
    return {
      id, title: descriptor.title, category: descriptor.category ?? 'Other', bindings, ...lock ? { lock } : {},
      changed: bindings.some(row => row.source === 'user' || row.source === 'removed'), problem: problemCommands.has(id)
    }
  })
}

/**
 * How a recorded chord is written to the file: with `mod` for Ctrl (⌘ on macOS), so it travels between platforms, and
 * with `platform` only when it uses a modifier one platform alone has (the Windows or Super key, or macOS's ⌃).
 */
export function storedKey(chords: readonly string[], platform: Platform): { readonly key: string; readonly platform?: Platform } {
  let local = false
  const key = chords.map(chord => {
    const { modifiers, key: name } = splitChord(chord)
    const mod = platform === 'darwin' ? 'meta' : 'ctrl', other = platform === 'darwin' ? 'ctrl' : 'meta'
    if (modifiers.has(other)) local = true
    // `mod` first, as the catalogue writes it (`mod+shift+e`); the rest keep their canonical order.
    return [...modifiers.has(mod) ? ['mod'] : [], ...[...modifiers].filter(modifier => modifier !== mod), name].join('+')
  }).join(' ')
  return local ? { key, platform } : { key }
}

const withBindings = (file: ShortcutFile, bindings: readonly ShortcutBinding[]): ShortcutFile => ({ ...file, bindings })
const without = (file: ShortcutFile, indexes: Iterable<number>): ShortcutFile => {
  const drop = new Set(indexes)
  return withBindings(file, file.bindings.filter((_, index) => !drop.has(index)))
}

/** The draft without `rule`: a user addition is dropped, a default gets a removal entry. Locked rules stay. */
export function removeRule(file: ShortcutFile, rule: ResolvedRule, platform: Platform): ShortcutFile {
  if (shortcutLock(rule.command)) return file
  const added = additionIndex(file, rule, platform)
  if (added >= 0 && effectiveRules(platform, file).userRules.includes(rule)) return without(file, [added])
  if (removalIndex(file, rule, platform) >= 0) return file
  return withBindings(file, [...file.bindings, { command: rule.command, ...storedKey(rule.chords, platform), remove: true }])
}
/** A removed default back: its removal entry is dropped. */
export function restoreRule(file: ShortcutFile, rule: ResolvedRule, platform: Platform): ShortcutFile {
  const index = removalIndex(file, rule, platform)
  return index < 0 ? file : without(file, [index])
}
/** A row's Reset: the user's entry behind it is dropped. */
export function resetRow(file: ShortcutFile, row: BindingRow): ShortcutFile {
  return row.entry === undefined ? file : without(file, [row.entry])
}
/** Reset command: every entry of `command` that applies on `platform` is dropped. */
export function resetCommand(file: ShortcutFile, command: CommandId, platform: Platform): ShortcutFile {
  return withBindings(file, file.bindings.filter(binding => binding.command !== command || !bindingApplies(binding, platform)))
}
/** What Reset All would drop on `platform`, and what it keeps for other platforms. */
export function resetAllCounts(file: ShortcutFile, platform: Platform): { readonly here: number; readonly elsewhere: number; readonly gestures: number } {
  const here = file.bindings.filter(binding => bindingApplies(binding, platform)).length
  return { here, elsewhere: file.bindings.length - here, gestures: Object.keys(file.gestures).length }
}
/** Reset All: the entries that apply on `platform` (every entry with `everywhere`) and every gesture choice are dropped. */
export function resetAll(file: ShortcutFile, platform: Platform, everywhere = false): ShortcutFile {
  return { ...file, bindings: everywhere ? [] : file.bindings.filter(binding => !bindingApplies(binding, platform)), gestures: {} }
}

/** What Assign checks: the candidate against the draft's effective rules. */
export function verdictFor(file: ShortcutFile, command: CommandId, chords: readonly string[], scope: ScopeId, platform: Platform): ShortcutVerdict {
  return validateShortcut(effectiveRules(platform, file).rules, { command, key: chords.join(' '), scope }, platform)
}
/**
 * The draft with the shortcut added in `scope`. `reassign` lists the rules it takes the key from (the conflict sheet's
 * Reassign): each is removed first. Restoring a removed default drops its removal instead of adding an entry.
 */
export function assignShortcut(file: ShortcutFile, command: CommandId, chords: readonly string[], scope: ScopeId, platform: Platform, reassign: readonly ResolvedRule[] = []): ShortcutFile {
  let next = file
  for (const rule of reassign) next = removeRule(next, rule, platform)
  const removed = effectiveRules(platform, next).removed.find(rule => rule.command === command && sameChords(rule.chords, chords) && ruleScope(rule) === scope)
  if (removed) return restoreRule(next, removed, platform)
  return withBindings(next, [...next.bindings, { command, ...storedKey(chords, platform), ...scope === 'global' ? {} : { scope } }])
}

/** A user entry the draft keeps but does not apply, for the problems banner. */
export interface DraftProblem { readonly index: number; readonly binding: ShortcutBinding; readonly label?: KeybindingLabel; readonly message: string }
export function draftProblems(file: ShortcutFile, platform: Platform, effective: EffectiveShortcuts = effectiveRules(platform, file)): DraftProblem[] {
  return effective.problems.filter(problem => problem.source === 'user' && problem.index >= 0 && file.bindings[problem.index]).map(problem => {
    const binding = file.bindings[problem.index], chords = parses(binding.key, platform)
    return { index: problem.index, binding, ...chords ? { label: keybindingLabel(chords, platform) } : {}, message: problem.message }
  })
}
export const removeEntries = (file: ShortcutFile, indexes: Iterable<number>): ShortcutFile => without(file, indexes)

const entryKey = (value: unknown) => JSON.stringify(value)
/** How many entries differ between the draft and what main stored: additions, removals, gesture choices and the scheme. */
export function stagedChanges(draft: ShortcutFile, stored: ShortcutFile): number {
  const count = (list: readonly unknown[]) => { const map = new Map<string, number>(); for (const item of list) map.set(entryKey(item), (map.get(entryKey(item)) ?? 0) + 1); return map }
  const a = count(draft.bindings), b = count(stored.bindings)
  let changes = 0
  for (const key of new Set([...a.keys(), ...b.keys()])) changes += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0))
  for (const id of new Set([...Object.keys(draft.gestures), ...Object.keys(stored.gestures)])) if (draft.gestures[id] !== stored.gestures[id]) changes++
  if (draft.scheme !== stored.scheme) changes++
  return changes
}
export const sameShortcuts = (a: ShortcutFile, b: ShortcutFile): boolean => a === b || (stagedChanges(a, b) === 0 && entryKey(a.unknown) === entryKey(b.unknown))

/** What Import would do to the draft, for its preview. */
export interface ImportSummary {
  readonly shortcuts: number
  /** Entries the draft does not have yet. */
  readonly added: number
  readonly same: number
  /** Additions on this platform that take a key from another command (Merge reassigns it). */
  readonly conflicts: readonly { readonly label: KeybindingLabel; readonly command: string; readonly with: readonly string[] }[]
  /** Records this build does not understand; kept in the file. */
  readonly unknown: number
  readonly gestures: number
  /** The user's own entries, which Replace drops. */
  readonly yours: number
  /** Merge would leave more entries than the file may hold. */
  readonly tooMany: boolean
}
export function importSummary(draft: ShortcutFile, incoming: ShortcutFile, platform: Platform): ImportSummary {
  const have = new Set(draft.bindings.map(entryKey))
  const added = incoming.bindings.filter(binding => !have.has(entryKey(binding)))
  const conflicts: ImportSummary['conflicts'][number][] = []
  for (const binding of added) {
    if (binding.remove || !bindingApplies(binding, platform)) continue
    const chords = parses(binding.key, platform)
    if (!chords) continue
    const verdict = verdictFor(draft, binding.command, chords, binding.scope ?? 'global', platform)
    if (verdict.verdict === 'conflict') conflicts.push({ label: keybindingLabel(chords, platform), command: commandDescriptor(binding.command).title, with: verdict.conflicts.map(rule => commandDescriptor(rule.command).title) })
  }
  return {
    shortcuts: incoming.bindings.length, added: added.length, same: incoming.bindings.length - added.length, conflicts, unknown: incoming.unknown.length,
    gestures: Object.keys(incoming.gestures).length, yours: draft.bindings.length,
    tooMany: draft.bindings.length + added.length > shortcutLimits.bindings || draft.unknown.length + incoming.unknown.length > shortcutLimits.unknown
  }
}
/**
 * Merge: the file's entries join the draft's. An addition that conflicts on this platform reassigns the key (the other
 * command's shortcut is removed); one that is refused stays in the file and shows in the problems banner. The file's
 * gesture choices win; its unknown records are kept beside the draft's.
 */
export function mergeImport(draft: ShortcutFile, incoming: ShortcutFile, platform: Platform): ShortcutFile {
  const have = new Set(draft.bindings.map(entryKey))
  let next: ShortcutFile = draft
  for (const binding of incoming.bindings) {
    if (have.has(entryKey(binding))) continue
    const chords = !binding.remove && bindingApplies(binding, platform) ? parses(binding.key, platform) : undefined
    if (chords) {
      const verdict = verdictFor(next, binding.command, chords, binding.scope ?? 'global', platform)
      if (verdict.verdict === 'conflict') for (const rule of verdict.conflicts) next = removeRule(next, rule, platform)
    }
    next = withBindings(next, [...next.bindings, binding])
  }
  const unknown = [...next.unknown, ...incoming.unknown.filter(record => !next.unknown.some(own => entryKey(own) === entryKey(record)))]
  return { ...next, scheme: incoming.scheme, gestures: { ...next.gestures, ...incoming.gestures }, unknown }
}
/**
 * Replace: the file's entries instead of the user's. Records this version cannot read (a newer build's) are not the
 * user's to lose by importing, so the draft's stay beside the file's.
 */
export const replaceImport = (draft: ShortcutFile, incoming: ShortcutFile): ShortcutFile => ({
  ...incoming, unknown: [...incoming.unknown, ...draft.unknown.filter(record => !incoming.unknown.some(own => entryKey(own) === entryKey(record)))]
})

/**
 * The Options dialog's shortcut edit: the stored file and revision it started from, and the draft. `replace` is set once
 * the user has been told another window saved first and chose OK again, so the next save replaces the newer file.
 */
export interface ShortcutEdit { readonly base: { readonly file: ShortcutFile; readonly revision: number }; readonly draft: ShortcutFile; readonly replace?: boolean }
export const startShortcutEdit = (stored: { readonly file: ShortcutFile; readonly revision: number }): ShortcutEdit => ({ base: { file: stored.file, revision: stored.revision }, draft: stored.file })
/**
 * An untouched draft follows the stored file (another window's save, a hand edit, a load that finished late); an edited
 * one keeps the revision it started from, so main refuses its save as STALE instead of overwriting the newer file.
 */
export function followStored(edit: ShortcutEdit, stored: { readonly file: ShortcutFile; readonly revision: number }): ShortcutEdit {
  if (stored.revision === edit.base.revision && stored.file === edit.base.file) return edit
  return sameShortcuts(edit.draft, edit.base.file) ? startShortcutEdit(stored) : edit
}
/** The file OK saves, or undefined when the draft has no changes. */
export const shortcutsToSave = (edit: ShortcutEdit): ShortcutFile | undefined => sameShortcuts(edit.draft, edit.base.file) ? undefined : edit.draft
/** The revision a save starts from: the edit's own, or, once the user chose to replace a newer file, the latest. */
export const saveRevision = (edit: ShortcutEdit, latest: number): number => edit.replace ? latest : edit.base.revision
