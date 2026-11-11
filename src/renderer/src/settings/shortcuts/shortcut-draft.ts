// The Shortcuts page's draft without the DOM: the rows its table shows, and every edit it stages (assign, remove,
// restore, reset, import) as a new `ShortcutFile`. Nothing here saves; OK in Options does (`commitOptions`).
import { commandDescriptor, commandIds, type Category, type CommandId } from '../../../../shared/commands/catalog'
import { validateShortcut, type ShortcutVerdict } from '../../../../shared/commands/conflicts'
import { effectiveRules, type EffectiveShortcuts } from '../../../../shared/commands/effective'
import { keybindingLabel, KeySpecError, parseKeySpec, splitChord, type KeybindingLabel, type Platform, type ResolvedRule } from '../../../../shared/commands/keybindings'
import { scopeOfWhen, shortcutScope, type ScopeId, type ScopeKind } from '../../../../shared/commands/scopes'
import { bindingApplies, shortcutFileSchema, shortcutFileText, shortcutLimits, type ShortcutBinding, type ShortcutFile } from '../../../../shared/commands/shortcut-schema'
import { sameChords, shortcutLock, type ShortcutLock } from '../../../../shared/commands/shortcut-rules'
import { gestureOverrides } from '../../../../shared/commands/gesture-choices'
import { gestureErrors, validateGestures } from '../../../../shared/commands/gesture-validate'

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

const platforms: readonly Platform[] = ['win32', 'linux', 'darwin']
const otherPlatforms = (platform: Platform): Platform[] => platforms.filter(other => other !== platform)
/** Whether `platform` would refuse `key` for `command` in `scope` (a key it reserves, or cannot read). */
const refusedOn = (file: ShortcutFile, command: CommandId, key: string, scope: ScopeId, platform: Platform): boolean =>
  validateShortcut(effectiveRules(platform, file).rules, { command, key, scope }, platform, { narrowerScopes: false }).verdict === 'refused'
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
  const other = platform === 'darwin' ? 'ctrl' : 'meta'
  // A key with the other modifier is this platform's alone, so it is written as pressed: `mod` there would name the
  // modifier it already has on another platform (Ctrl+Win+J as `mod+meta+j` repeats ⌘ on macOS), which no file may hold.
  if (chords.some(chord => splitChord(chord).modifiers.has(other))) return { key: chords.join(' '), platform }
  const mod = platform === 'darwin' ? 'meta' : 'ctrl'
  const key = chords.map(chord => {
    const { modifiers, key: name } = splitChord(chord)
    // `mod` first, as the catalogue writes it (`mod+shift+e`); the rest keep their canonical order.
    return [...modifiers.has(mod) ? ['mod'] : [], ...[...modifiers].filter(modifier => modifier !== mod), name].join('+')
  }).join(' ')
  return { key }
}

const withBindings = (file: ShortcutFile, bindings: readonly ShortcutBinding[]): ShortcutFile => ({ ...file, bindings })
const without = (file: ShortcutFile, indexes: Iterable<number>): ShortcutFile => {
  const drop = new Set(indexes)
  return withBindings(file, file.bindings.filter((_, index) => !drop.has(index)))
}

/**
 * Whether `rule` is one of the user's: matched by command, chords and scope, since a rule resolved from an earlier draft
 * (Reassign's conflicts after a first removal) is not the same object as the current draft's.
 */
export const isUserRule = (effective: EffectiveShortcuts, rule: ResolvedRule): boolean =>
  effective.userRules.some(user => user === rule || (user.command === rule.command && sameChords(user.chords, rule.chords) && ruleScope(user) === ruleScope(rule)))
/** The draft without `rule`: a user addition is dropped, a default gets a removal entry. Locked rules stay. */
export function removeRule(file: ShortcutFile, rule: ResolvedRule, platform: Platform): ShortcutFile {
  if (shortcutLock(rule.command)) return file
  const added = additionIndex(file, rule, platform)
  if (added >= 0 && isUserRule(effectiveRules(platform, file), rule)) return without(file, [added])
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
  const stored = storedKey(chords, platform)
  // A key another platform refuses (macOS's ⌥ letters type characters, Windows' Ctrl+Alt is AltGr) is kept to this one,
  // so it works here without turning into a problem there.
  const local = !stored.platform && otherPlatforms(platform).some(other => refusedOn(next, command, stored.key, scope, other))
  return withBindings(next, [...next.bindings, { command, ...stored, ...local ? { platform } : {}, ...scope === 'global' ? {} : { scope } }])
}

/** A user entry the draft keeps but does not apply, for the problems banner. */
export interface DraftProblem { readonly index: number; readonly binding: ShortcutBinding; readonly label?: KeybindingLabel; readonly message: string }
export function draftProblems(file: ShortcutFile, platform: Platform, effective: EffectiveShortcuts = effectiveRules(platform, file)): DraftProblem[] {
  return effective.problems.filter(problem => problem.source === 'user' && problem.index >= 0 && file.bindings[problem.index]).map(problem => {
    const binding = file.bindings[problem.index], chords = parses(binding.key, platform)
    return { index: problem.index, binding, ...chords ? { label: keybindingLabel(chords, platform) } : {}, message: problem.message }
  })
}
/**
 * The problems banner's Remove: entries that do not apply here are dropped. One written for every platform keeps working
 * on the others, so it is narrowed to those where it still applies instead of deleted. A copy the file already has is
 * not written again, and when the copies would take the file past what main stores (each entry can become two) the
 * entries are dropped outright: Remove must leave a draft OK can save (#293).
 */
export function removeEntries(file: ShortcutFile, indexes: Iterable<number>, platform: Platform): ShortcutFile {
  const drop = new Set(indexes)
  const dropped = without(file, drop)
  // An entry for every platform keeps a copy for each other platform where it still applies cleanly.
  const fine = new Map(otherPlatforms(platform).map(other => [other, new Set(effectiveRules(other, file).problems.map(problem => problem.index))]))
  const have = new Set(dropped.bindings.map(binding => entryKey(normalEntry(binding))))
  const narrowed = withBindings(file, file.bindings.flatMap((binding, index) => !drop.has(index) ? [binding]
    : binding.platform ? [] : [...fine].filter(([, problems]) => !problems.has(index)).map(([other]) => ({ ...binding, platform: other })).filter(copy => {
      const entry = entryKey(normalEntry(copy))
      if (have.has(entry)) return false
      have.add(entry)
      return true
    })))
  return storable(narrowed) || !storable(dropped) ? narrowed : dropped
}

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
  /** Entries the draft already has. */
  readonly same: number
  /** Entries the file lists more than once that the draft does not have: each is imported once. */
  readonly repeated: number
  /** Additions on this platform that take a key from another command (Merge reassigns it). */
  readonly conflicts: readonly { readonly label: KeybindingLabel; readonly command: string; readonly with: readonly string[] }[]
  /** Additions on this platform that take a key another of the file's entries has: they show as problems after Merge. */
  readonly clashes: number
  /** Removals of a locked key, or of a key no command has here: they show as problems. */
  readonly ignored: number
  /** Records this build does not understand; kept in the file. */
  readonly unknown: number
  readonly gestures: number
  /** The user's own entries, which Replace drops. */
  readonly yours: number
  /** Whether each mode's result is a file main can store (its limits, and its size as main writes it). */
  readonly fits: Readonly<Record<'merge' | 'replace', boolean>>
  /** Which limit each mode's result breaks, when it does not fit. */
  readonly over: Readonly<Record<'merge' | 'replace', ImportOver | undefined>>
}
/** The limit a file is over: its shortcuts, its records this build cannot read, its gestures, or its size. */
export type ImportOver = 'shortcuts' | 'unknown' | 'gestures' | 'size'
const overLimit = (file: ShortcutFile): ImportOver | undefined =>
  file.bindings.length > shortcutLimits.bindings ? 'shortcuts' : file.unknown.length > shortcutLimits.unknown ? 'unknown'
    : Object.keys(file.gestures).length > shortcutLimits.gestures ? 'gestures' : storable(file) ? undefined : 'size'
const counted = (value: number) => value.toLocaleString('en-US')
const overText: Readonly<Record<ImportOver, string>> = {
  shortcuts: `Together they would be more than the ${counted(shortcutLimits.bindings)} shortcuts a file may hold.`,
  gestures: `Together they would set more than the ${counted(shortcutLimits.gestures)} gestures a file may hold.`,
  unknown: `Together they would keep more than the ${counted(shortcutLimits.unknown)} records this version cannot read that a file may hold.`,
  size: `Together they would be larger than the ${shortcutLimits.fileBytes / 1024} KiB a shortcuts file may be.`
}
/**
 * Why Import refuses `mode`, worded by its cause, or undefined when the result fits. Replace keeps the draft's records
 * this version cannot read, and the page has no way to remove those: when Replace does not fit, nothing the user can
 * remove makes either mode fit, so the message says the file cannot be imported instead of asking them to (#292).
 */
export function importRefusal(summary: Pick<ImportSummary, 'over'>, mode: 'merge' | 'replace'): string | undefined {
  if (!summary.over[mode]) return undefined
  const replace = summary.over.replace
  if (replace) return replace === 'unknown'
    ? `Your shortcuts and this file together keep more than the ${counted(shortcutLimits.unknown)} records this version cannot read that a file may hold. They cannot be removed here, so this file cannot be imported.`
    : `This file, with the records of yours this version cannot read, would be larger than the ${shortcutLimits.fileBytes / 1024} KiB a shortcuts file may be. They cannot be removed here, so this file cannot be imported.`
  return `${overText[summary.over.merge!]} Choose Replace, or remove some of yours first.`
}
/** A file main would store: valid, within every limit, and under the size limit in the form main writes. */
export const storable = (file: ShortcutFile): boolean => shortcutFileSchema.safeParse(file).success && shortcutFileText(file) !== undefined
/** An entry as the file compares it: Global is the same scope written or not. */
const normalEntry = (binding: ShortcutBinding): ShortcutBinding => {
  if (binding.remove || binding.scope !== 'global') return binding
  const { scope: _global, ...rest } = binding
  return rest
}
export function importSummary(draft: ShortcutFile, incoming: ShortcutFile, platform: Platform): ImportSummary {
  const have = new Set(draft.bindings.map(binding => entryKey(normalEntry(binding)))), listed = new Set<string>()
  const added: ShortcutBinding[] = []
  // An entry the file lists twice is not one the draft has: it counts as repeated, not as the same as the user's (#292).
  let same = 0, repeated = 0
  for (const binding of incoming.bindings.map(normalEntry)) {
    const entry = entryKey(binding)
    if (have.has(entry)) same++
    else if (listed.has(entry)) repeated++
    else { listed.add(entry); added.push(binding) }
  }
  const effective = effectiveRules(platform, draft)
  const conflicts: ImportSummary['conflicts'][number][] = []
  let clashes = 0, ignored = 0
  // Each entry's key is parsed once, and the additions seen so far are a set of scope and chords: comparing each entry
  // with every earlier one made a 1,024-entry preview quadratic (#291).
  const seen = new Set<string>()
  for (const binding of added) {
    if (!bindingApplies(binding, platform)) continue
    const chords = parses(binding.key, platform)
    if (!chords) continue
    if (binding.remove) {
      const known = [...effective.rules, ...effective.removed].some(rule => rule.command === binding.command && sameChords(rule.chords, chords))
      if (shortcutLock(binding.command) || !known) ignored++
      continue
    }
    // The draft's rules are memoised, and the preview names no narrower scope, so each entry is one scan.
    const verdict = validateShortcut(effective.rules, { command: binding.command, key: chords.join(' '), scope: binding.scope ?? 'global' }, platform, { narrowerScopes: false })
    if (verdict.verdict === 'conflict') conflicts.push({ label: keybindingLabel(chords, platform), command: commandDescriptor(binding.command).title, with: verdict.conflicts.map(rule => commandDescriptor(rule.command).title) })
    const keyed = [binding.scope ?? 'global', ...chords].join(' ')
    if (seen.has(keyed)) clashes++
    else seen.add(keyed)
  }
  const over = { merge: overLimit(mergeImport(draft, incoming, platform)), replace: overLimit(replaceImport(draft, incoming)) }
  return {
    shortcuts: incoming.bindings.length, added: added.length, same, repeated, conflicts, clashes, ignored, unknown: incoming.unknown.length,
    gestures: Object.keys(incoming.gestures).length, yours: draft.bindings.length, fits: { merge: !over.merge, replace: !over.replace }, over
  }
}
/**
 * Merge: the file's entries join the draft's. An addition that conflicts on this platform reassigns the key (the other
 * command's shortcut is removed, on the addition's platform alone when it names one); one that is refused stays in the
 * file and shows in the problems banner. The draft keeps its scheme, the file's gesture choices win, and its unknown
 * records are kept beside the draft's.
 */
export function mergeImport(draft: ShortcutFile, incoming: ShortcutFile, platform: Platform): ShortcutFile {
  // One pass over the draft's effective rules: re-resolving the growing file per entry made a 1,024-entry import
  // quadratic, freezing the page for a minute or more. An entry that conflicts only with another of the file's stays,
  // and shows in the problems banner (the preview counts it).
  const effective = effectiveRules(platform, draft)
  const have = new Set(draft.bindings.map(binding => entryKey(normalEntry(binding)))), taken = new Set<ResolvedRule>(), drop = new Set<number>()
  const removals: ShortcutBinding[] = [], additions: ShortcutBinding[] = []
  for (const binding of incoming.bindings.map(normalEntry)) {
    const entry = entryKey(binding)
    if (have.has(entry)) continue
    have.add(entry)
    additions.push(binding)
    const chords = !binding.remove && bindingApplies(binding, platform) ? parses(binding.key, platform) : undefined
    const verdict = chords && validateShortcut(effective.rules, { command: binding.command, key: chords.join(' '), scope: binding.scope ?? 'global' }, platform, { narrowerScopes: false })
    if (verdict?.verdict !== 'conflict') continue
    for (const rule of verdict.conflicts) {
      if (taken.has(rule) || shortcutLock(rule.command)) continue
      taken.add(rule)
      // As removeRule: the user's own addition is dropped, a default gets one removal entry.
      const own = isUserRule(effective, rule) ? additionIndex(draft, rule, platform) : -1
      if (own >= 0) { drop.add(own); continue }
      const stored = storedKey(rule.chords, platform)
      const removal: ShortcutBinding = { command: rule.command, ...stored, ...binding.platform && !stored.platform ? { platform: binding.platform } : {}, remove: true }
      if (removalIndex(draft, rule, platform) < 0 && !have.has(entryKey(removal))) { have.add(entryKey(removal)); removals.push(removal) }
    }
  }
  const next = withBindings(draft, [...draft.bindings.filter((_, index) => !drop.has(index)), ...removals, ...additions])
  const unknown = [...next.unknown, ...incoming.unknown.filter(record => !next.unknown.some(own => entryKey(own) === entryKey(record)))]
  return { ...next, gestures: { ...next.gestures, ...incoming.gestures }, unknown }
}
/**
 * Replace: the file's entries and scheme instead of the user's. Records this version cannot read (a newer build's) are
 * not the user's to lose by importing, so the draft's stay beside the file's.
 */
export const replaceImport = (draft: ShortcutFile, incoming: ShortcutFile): ShortcutFile => ({
  ...incoming, unknown: [...incoming.unknown, ...draft.unknown.filter(record => !incoming.unknown.some(own => entryKey(own) === entryKey(record)))]
})

/**
 * The Options dialog's shortcut edit: the stored file and revision it started from, and the draft. `replace` is the newer
 * revision the user was told another window saved, once they chose OK again: the next save replaces that revision and no
 * later one. `early` marks a draft begun before the service had loaded main's file (so built on the defaults).
 */
export interface ShortcutEdit {
  readonly base: { readonly file: ShortcutFile; readonly revision: number }
  readonly draft: ShortcutFile
  readonly replace?: number
  readonly early?: true
}
export const startShortcutEdit = (stored: { readonly file: ShortcutFile; readonly revision: number; readonly loaded?: boolean }): ShortcutEdit =>
  ({ base: { file: stored.file, revision: stored.revision }, draft: stored.file, ...stored.loaded === false ? { early: true as const } : {} })
/**
 * An untouched draft follows the stored file (another window's save, a hand edit, a load that finished late); an edited
 * one keeps the revision it started from, so main refuses its save as STALE instead of overwriting the newer file.
 */
export function followStored(edit: ShortcutEdit, stored: { readonly file: ShortcutFile; readonly revision: number }): ShortcutEdit {
  if (stored.revision === edit.base.revision && stored.file === edit.base.file) return edit
  if (sameShortcuts(edit.draft, edit.base.file)) return startShortcutEdit(stored)
  // A save newer than the one the user agreed to replace has not been shown to them: OK must warn again.
  if (edit.replace !== undefined && stored.revision > edit.replace) { const { replace: _seen, ...rest } = edit; return rest }
  return edit
}
/** The file OK saves, or undefined when the draft has no changes. */
export const shortcutsToSave = (edit: ShortcutEdit): ShortcutFile | undefined => sameShortcuts(edit.draft, edit.base.file) ? undefined : edit.draft
/** The revision a save starts from: the edit's own, or, once the user chose to replace a newer file, that file's. */
export const saveRevision = (edit: ShortcutEdit): number => edit.replace ?? edit.base.revision
/** The first gesture clash in the draft on `platform`, which OK refuses to save (a warning does not block). */
export const gestureClash = (file: ShortcutFile, platform: Platform, validate = validateGestures): string | undefined =>
  gestureErrors(validate(platform, gestureOverrides(file.gestures, platform)))[0]?.message
