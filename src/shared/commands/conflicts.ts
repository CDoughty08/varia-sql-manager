import { commandDescriptor, isCommandId, type CommandId } from './catalog'
import { contextKeyValues, contextRecord, keysOfScope, type ContextKey, type ContextKeys, type FocusKeys } from './context-keys'
import { intrinsicChords } from './intrinsic'
import { altGrReason, defaultRules, formatLabel, KeySpecError, parseKeySpec, reservedReason, splitChord, toAccelerator, workbenchRules, type Platform, type ResolvedRule } from './keybindings'
import { osKeyVerdict } from './os-keys'
import { isScopeId, scopeOfWhen, shortcutScope, shortcutScopes, type ScopeId } from './scopes'
import { resolveShortcut, ruleLock, sameChords, shortcutLock, typesText } from './shortcut-rules'
import { menuMayShowChords } from './menus'
import { compileWhen, evaluateWhen, referencedKeys } from './when'

/** Representative places focus can be. Each fixes every focus key; keys it does not list are false or ''. */
export const focusSamples: readonly { readonly name: string; readonly keys: Partial<FocusKeys> }[] = [
  { name: 'editorText', keys: { editorFocus: true, editorTextFocus: true, textInputFocus: true, activePanel: 'editor' } },
  { name: 'editorFindInput', keys: { editorFocus: true, inputFocus: true, textInputFocus: true, activePanel: 'editor' } },
  { name: 'explorerTree', keys: { activePanel: 'explorer' } },
  { name: 'activityMonitor', keys: { activePanel: 'editor', activityMonitorFocus: true } },
  { name: 'documentTab', keys: { activePanel: 'editor', documentTabFocus: true } },
  { name: 'documentTabRename', keys: { activePanel: 'editor', documentTabFocus: true, inputFocus: true, textInputFocus: true } },
  { name: 'outputGrid', keys: { activePanel: 'output', outputGridFocus: true } },
  { name: 'outputMessages', keys: { activePanel: 'output', messagesFocus: true } },
  { name: 'tableDesigner', keys: { activePanel: 'editor', designerFocus: true } },
  { name: 'tableDesignerCell', keys: { activePanel: 'editor', designerFocus: true, inputFocus: true, textInputFocus: true } },
  { name: 'searchHitsTab', keys: { activePanel: 'editor', searchHitsFocus: true } },
  { name: 'searchHitsPane', keys: { activePanel: 'explorer', searchHitsFocus: true } },
  { name: 'toolbarSelect', keys: { inputFocus: true, textInputFocus: true } },
  { name: 'queryBarButton', keys: { activePanel: 'editor', queryBarFocus: true } },
  { name: 'queryBarSelect', keys: { activePanel: 'editor', queryBarFocus: true, inputFocus: true, textInputFocus: true } },
  { name: 'titleBar', keys: {} },
  { name: 'quickInput', keys: { inputFocus: true, textInputFocus: true } },
  { name: 'body', keys: {} }
]

export interface Conflict {
  /** `shadow`: a narrower preset scope's rule and a Global one share a key; the narrower wins (`workbenchRules` lists it first). */
  readonly kind: 'overlap' | 'shadow' | 'reserved' | 'typing' | 'modal'
  readonly chord: string
  readonly commands: readonly CommandId[]
  readonly message: string
  /** A `reserved` conflict's reason, from `reservedReason`. */
  readonly reason?: string
}

// Both `when` clauses together may read this many state keys; 2^12 contexts per focus sample is still instant.
const maxEnumeratedKeys = 12
const stateKeys = new Set<string>(keysOfScope('state'))

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
 * Whether two overlapping rules are a shadow rather than a conflict: both workbench rules, one Global (with or without
 * the typing guard) and the other in a narrower preset scope, which wins (`workbenchRules` lists it first). Returns the
 * narrower rule.
 */
function shadowing(a: ResolvedRule, b: ResolvedRule): ResolvedRule | undefined {
  if (a.native || b.native) return undefined
  const scopeA = scopeOfWhen(a.whenSource).id, scopeB = scopeOfWhen(b.whenSource).id
  if (scopeA === 'custom' || scopeB === 'custom' || (scopeA === 'global') === (scopeB === 'global')) return undefined
  return scopeA === 'global' ? b : a
}

/**
 * Problems with workbench keybindings on `platform`: two commands that can both match one key press, reserved chords,
 * typing keys that are not limited to `!textInputFocus`, and keys on commands that also run while a modal is open
 * unless the key is marked `modal` (a dialog's own keys must win otherwise), or a `modal` key on a command that does
 * not. A preset scope's rule that overlaps a Global one is a `shadow`, which the narrower wins. Native rules belong to
 * Monaco and are not checked.
 */
export function findConflicts(rules: readonly ResolvedRule[], platform: Platform): Conflict[] {
  const conflicts: Conflict[] = []
  for (const [chord, list] of workbenchRules(rules)) {
    for (const rule of list) {
      const reason = reservedReason(chord, platform)
      if (reason) conflicts.push({ kind: 'reserved', chord, commands: [rule.command], reason, message: `${rule.command}: ${chord} is reserved (${reason}).` })
      const { allowInModal } = commandDescriptor(rule.command)
      if (rule.modal && !allowInModal) conflicts.push({ kind: 'modal', chord, commands: [rule.command], message: `${rule.command}: ${chord} is marked modal, but the command does not run while a modal is open.` })
      else if (allowInModal && !rule.modal) conflicts.push({ kind: 'modal', chord, commands: [rule.command], message: `${rule.command} runs while a modal is open, so its workbench key ${chord} must be marked modal or it would take the key from the dialog.` })
      if (typesText(chord)) {
        const sample = findContext([rule], platform, context => context.textInputFocus && active(rule, context))
        if (sample) conflicts.push({ kind: 'typing', chord, commands: [rule.command], message: `${rule.command}: ${chord} types text, so it must not match while text input has focus (it does in ${sample}); add !textInputFocus.` })
      }
    }
    for (let first = 0; first < list.length; first++) for (let second = first + 1; second < list.length; second++) {
      const a = list[first], b = list[second]
      if (a.command === b.command) continue
      const sample = findContext([a, b], platform, context => active(a, context) && active(b, context))
      if (!sample) continue
      const narrow = shadowing(a, b)
      if (narrow) conflicts.push({ kind: 'shadow', chord, commands: [a.command, b.command], message: `${narrow.command} (${scopeOfWhen(narrow.whenSource).title}) shadows ${(narrow === a ? b : a).command} for ${chord}.` })
      else conflicts.push({ kind: 'overlap', chord, commands: [a.command, b.command], message: `${a.command} and ${b.command} both match ${chord} in ${sample}.` })
    }
  }
  return conflicts
}

/**
 * Whether a `findConflicts` result makes a rule set wrong. Shadows are how a narrower scope overrides a Global shortcut,
 * and Linux reports AltGr as its own key, so a user's Ctrl+Alt+letter there (which `validateShortcut` only warns about)
 * is allowed; the catalogue itself still keeps those keys free.
 */
export const isBlockingConflict = (conflict: Conflict, platform: Platform): boolean =>
  conflict.kind !== 'shadow' && !(conflict.kind === 'reserved' && conflict.reason === altGrReason && platform === 'linux')

/** Why `validateShortcut` refuses a shortcut. */
export const refusalReasons = ['unknownCommand', 'locked', 'scope', 'parse', 'chord', 'role', 'reserved', 'system', 'navigation', 'typing', 'taken', 'duplicate', 'complex'] as const
export type RefusalReason = typeof refusalReasons[number]

/** A rule the candidate shares a key with: it overrides the rule (`overrides`), or the rule overrides it. */
export interface ShortcutShadow { readonly rule: ResolvedRule; readonly overrides: boolean }
/**
 * What assigning a shortcut would do. `refused`: Assign is disabled, for `reason`. `conflict`: the key already runs
 * `conflicts` where the candidate would; the user may reassign it (staging their removal), use one of `narrowerScopes`,
 * or cancel. `shadow`: allowed; a narrower scope and a Global shortcut share the key and the narrower wins there.
 * `warning`: allowed, with `warnings`. Shadows and warnings are also listed under a worse verdict.
 */
export interface ShortcutVerdict {
  readonly verdict: 'ok' | 'warning' | 'shadow' | 'conflict' | 'refused'
  /** One sentence for the inspector, built from catalogue titles. */
  readonly message: string
  readonly reason?: RefusalReason
  /** The rule the shortcut becomes; absent when refused. */
  readonly rule?: ResolvedRule
  readonly conflicts: readonly ResolvedRule[]
  readonly shadows: readonly ShortcutShadow[]
  readonly warnings: readonly string[]
  readonly narrowerScopes: readonly ScopeId[]
}
/** A shortcut as the capture box or the user file has it; `command` and `scope` are checked. */
export interface ShortcutDraft { readonly command: string; readonly key: string; readonly scope?: string }

// Keys that work a dialog, a list or a text box; a Global shortcut must not take them without Ctrl, Alt or ⌘.
const navigationKeys = new Set(['enter', 'tab', 'escape', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'contextmenu', 'pause'])
const title = (command: CommandId) => commandDescriptor(command).title
const ruleScopeTitle = (rule: ResolvedRule) => rule.bridge ? shortcutScope('queryEditor').title : scopeOfWhen(rule.whenSource).title

/**
 * Whether `candidate` may join `draft` (the effective rules being edited) on `platform`; runs live in the capture box
 * and again in main on save. Never throws. Effective rules keep zero overlap, except a preset scope shadowing a Global
 * shortcut.
 */
export function validateShortcut(draft: readonly ResolvedRule[], candidate: ShortcutDraft, platform: Platform, options: { readonly narrowerScopes?: boolean } = {}): ShortcutVerdict {
  return validate(draft, candidate, platform, options.narrowerScopes ?? true)
}

function validate(draft: readonly ResolvedRule[], candidate: ShortcutDraft, platform: Platform, offerScopes: boolean): ShortcutVerdict {
  const warnings: string[] = []
  const refuse = (reason: RefusalReason, message: string): ShortcutVerdict => ({ verdict: 'refused', reason, message, conflicts: [], shadows: [], warnings, narrowerScopes: [] })
  const { command, key } = candidate
  if (!isCommandId(command)) return refuse('unknownCommand', 'This version of Varia has no such command.')
  const scope = candidate.scope ?? 'global'
  if (!isScopeId(scope)) return refuse('scope', 'This version of Varia has no such scope.')
  const lock = shortcutLock(command)
  if (lock) return refuse('locked', lock.reason)
  let chords: string[]
  try { chords = parseKeySpec(key, platform) } catch (error) {
    if (error instanceof KeySpecError) return refuse('parse', 'That is not a key Varia can bind.')
    throw error
  }
  const label = chords.map(chord => formatLabel(chord, platform)).join(' ')
  const { title: scopeTitle, typing, rank } = shortcutScope(scope)
  const descriptor = commandDescriptor(command)
  const prefix = parseKeySpec('mod+k', platform)[0]
  if (chords.length > 1 && (scope !== 'queryEditor' || chords[0] !== prefix))
    return refuse('chord', `Two-part shortcuts must start with ${formatLabel(prefix, platform)} and apply in the ${shortcutScope('queryEditor').title}.`)
  if (descriptor.role && scope !== 'global') return refuse('role', `${descriptor.title} works everywhere, so its shortcuts are Global.`)
  // A role key works only as the menu's accelerator, and macOS menus take only ⌘ keys from the page.
  if (descriptor.role && (!toAccelerator(chords, platform) || !menuMayShowChords(chords, platform))) return refuse('role', `The menu cannot register ${label} for ${descriptor.title}.`)

  // A command's own default key, in its own scope, is never refused: restoring it is always allowed.
  const ruleScope = (rule: ResolvedRule) => rule.bridge ? 'queryEditor' : scopeOfWhen(rule.whenSource).id
  const isDefault = defaultRules(platform).some(rule => rule.command === command && sameChords(rule.chords, chords) && ruleScope(rule) === scope)
  if (chords.length === 1 && !isDefault) {
    const chord = chords[0], { modifiers, key: name } = splitChord(chord)
    const os = osKeyVerdict(chord, platform)
    const reserved = reservedReason(chord, platform)
    // reservedReason keeps Ctrl+Alt+letter on Linux too, for the catalogue; Linux reports AltGr as its own key.
    if (reserved && !(reserved === altGrReason && platform === 'linux')) return refuse('reserved', `${label} is reserved: ${reserved}.`)
    if (os?.level === 'refused') return refuse('system', `The system takes ${label}: ${os.reason}.`)
    if (os) warnings.push(`The system may take ${label}: ${os.reason}.`)
    const plain = !modifiers.has('ctrl') && !modifiers.has('alt') && !modifiers.has('meta')
    if (scope === 'global' && plain && navigationKeys.has(name)) return refuse('navigation', `${label} works dialogs, lists and text, so it cannot be a Global shortcut.`)
    if (typing === 'refuse' && typesText(chord)) return refuse('typing', `${label} types text in the ${scopeTitle}.`)
  }

  const rule = resolveShortcut({ command, key, scope }, platform)
  const conflicts: ResolvedRule[] = [], shadows: ShortcutShadow[] = []
  for (const other of draft) {
    if (!sameChords(other.chords, chords)) continue
    let overlap: string | undefined, adds: string | undefined
    try {
      overlap = findContext([rule, other], platform, context => active(rule, context) && active(other, context))
      // The same command's key in another scope: allowed when the new one reaches somewhere the old one does not.
      if (overlap && other.command === command) adds = findContext([rule, other], platform, context => active(rule, context) && !active(other, context))
    } catch {
      return refuse('complex', `${label} is used by ${title(other.command)} in a way Varia cannot check.`)
    }
    if (!overlap) continue
    if (other.command === command) {
      if (!adds) return refuse('duplicate', `${label} is already a shortcut for ${descriptor.title} there.`)
      continue
    }
    // The workbench sees a key before Monaco and Chromium, so a one-part shortcut may take a locked native key where it
    // applies (as Close does with Delete on a tab); a two-part key Monaco itself dispatches cannot be shared.
    if (ruleLock(other)) {
      if (chords.length > 1) return refuse('taken', `${label} belongs to ${title(other.command)}, which cannot be changed.`)
      warnings.push(`Where this shortcut applies, it takes ${label} from ${title(other.command)}.`)
      continue
    }
    const narrow = shadowing(rule, other)
    if (narrow) shadows.push({ rule: other, overrides: narrow === rule })
    else conflicts.push(other)
  }
  if (chords.length === 1) for (const preset of shortcutScopes) {
    const id = preset.id
    const builtIn = intrinsicChords(id, platform).get(chords[0])
    if (builtIn && findContext([rule], platform, context => active(rule, context) && (preset.when === undefined || evaluateWhen(compileWhen(preset.when), context))))
      warnings.push(`In the ${preset.title}, ${label} also does its own “${builtIn}”.`)
  }

  const base = { rule, shadows, warnings }
  if (conflicts.length) {
    const narrowerScopes = offerScopes
      ? shortcutScopes.filter(preset => preset.rank > rank).map(preset => preset.id).filter(id => {
        const verdict = validate(draft, { command, key, scope: id }, platform, false).verdict
        return verdict !== 'refused' && verdict !== 'conflict'
      })
      : []
    const names = [...new Set(conflicts.map(other => `${title(other.command)} (${ruleScopeTitle(other)})`))].join(', ')
    return { ...base, verdict: 'conflict', conflicts, narrowerScopes, message: `${label} is already used by ${names}.` }
  }
  const done = { ...base, conflicts, narrowerScopes: [] }
  if (shadows.length) {
    const [shadow] = shadows
    return { ...done, verdict: 'shadow', message: shadow.overrides ? `In the ${scopeTitle} this overrides ${title(shadow.rule.command)} (Global).` : `${title(shadow.rule.command)} overrides this in the ${ruleScopeTitle(shadow.rule)}.` }
  }
  if (warnings.length) return { ...done, verdict: 'warning', message: warnings[0] }
  return { ...done, verdict: 'ok', message: scope === 'global' ? `${label} is not used.` : `${label} is not used in the ${scopeTitle}.` }
}
