import { validateShortcut, type RefusalReason } from './conflicts'
import { defaultRules, KeySpecError, parseKeySpec, type Platform, type ResolvedRule } from './keybindings'
import { defaultSchemeId, shortcutScheme, shortcutSchemes, type ShortcutScheme } from './schemes'
import { scopeOfWhen } from './scopes'
import { bindingApplies, emptyShortcutFile, type ShortcutBinding, type ShortcutFile } from './shortcut-schema'
import { ruleLock, sameChords } from './shortcut-rules'

/** A binding that is kept in the file but not applied, with fixed wording for the Shortcuts page's banner. */
export interface ShortcutProblem {
  readonly source: 'scheme' | 'user'
  /** The binding's index in its list (the scheme's or the file's `bindings`); −1 for the file's scheme name. */
  readonly index: number
  readonly code: RefusalReason | 'conflict' | 'unmatched' | 'scheme'
  readonly message: string
}
export interface EffectiveShortcuts {
  /** What every consumer uses: the scheme's and the user's additions, narrowest scope first, then the remaining defaults. */
  readonly rules: readonly ResolvedRule[]
  /** The user's applied additions, in `rules` order. */
  readonly userRules: readonly ResolvedRule[]
  /** Catalogue and scheme rules a removal took out. */
  readonly removed: readonly ResolvedRule[]
  readonly scheme: ShortcutScheme
  readonly gestures: Readonly<Record<string, string>>
  readonly problems: readonly ShortcutProblem[]
}

const memo = new WeakMap<ShortcutFile, Map<Platform, EffectiveShortcuts>>()
const byRank = (rules: readonly ResolvedRule[]) => [...rules].sort((a, b) => scopeOfWhen(b.whenSource).rank - scopeOfWhen(a.whenSource).rank)

/**
 * The effective rules on `platform`: catalogue ⊕ scheme ⊕ user. Removals take out the catalogue or scheme rule of their
 * command and key; additions are checked one by one with `validateShortcut` against what is already effective, and one
 * that is refused or conflicts is not applied but reported. Entries for another platform are skipped. Pure, memoised
 * per file object, and never throws.
 */
export function effectiveRules(platform: Platform, file: ShortcutFile = emptyShortcutFile): EffectiveShortcuts {
  let perPlatform = memo.get(file)
  const cached = perPlatform?.get(platform)
  if (cached) return cached
  const problems: ShortcutProblem[] = []
  const known = shortcutScheme(file.scheme)
  if (!known) problems.push({ source: 'user', index: -1, code: 'scheme', message: 'This version of Varia does not have the chosen scheme, so it uses the default.' })
  const scheme = known ?? shortcutSchemes.find(entry => entry.id === defaultSchemeId)!

  let base: ResolvedRule[] = [...defaultRules(platform)]
  const removed: ResolvedRule[] = []
  const additions: { rule: ResolvedRule; source: 'scheme' | 'user' }[] = []
  const apply = (bindings: readonly ShortcutBinding[], source: 'scheme' | 'user') => {
    bindings.forEach((binding, index) => {
      if (!binding.remove || !bindingApplies(binding, platform)) return
      let chords: string[]
      try { chords = parseKeySpec(binding.key, platform) } catch (error) {
        if (!(error instanceof KeySpecError)) throw error
        problems.push({ source, index, code: 'parse', message: 'This removal names a key Varia cannot read.' }); return
      }
      const matches = (rule: ResolvedRule) => rule.command === binding.command && sameChords(rule.chords, chords)
      const taken = [...base.filter(matches), ...additions.filter(entry => entry.source === 'scheme' && matches(entry.rule)).map(entry => entry.rule)]
      if (!taken.length) { problems.push({ source, index, code: 'unmatched', message: 'This removal matches no default shortcut.' }); return }
      const lock = ruleLock(taken[0])
      if (lock) { problems.push({ source, index, code: 'locked', message: lock.reason }); return }
      base = base.filter(rule => !matches(rule))
      for (let at = additions.length - 1; at >= 0; at--) if (additions[at].source === 'scheme' && matches(additions[at].rule)) additions.splice(at, 1)
      removed.push(...taken)
    })
    bindings.forEach((binding, index) => {
      if (binding.remove || !bindingApplies(binding, platform)) return
      const verdict = validateShortcut([...additions.map(entry => entry.rule), ...base], binding, platform)
      if (verdict.verdict === 'refused' || verdict.verdict === 'conflict' || !verdict.rule) {
        problems.push({ source, index, code: verdict.reason ?? 'conflict', message: verdict.message }); return
      }
      additions.push({ rule: verdict.rule, source })
    })
  }
  apply(scheme.bindings, 'scheme')
  apply(file.bindings, 'user')

  const added = byRank(additions.map(entry => entry.rule))
  const users = new Set(additions.filter(entry => entry.source === 'user').map(entry => entry.rule))
  const result: EffectiveShortcuts = Object.freeze({
    rules: Object.freeze([...added, ...base]),
    userRules: Object.freeze(added.filter(rule => users.has(rule))),
    removed: Object.freeze(removed),
    scheme,
    gestures: Object.freeze({ ...file.gestures }),
    problems: Object.freeze(problems)
  })
  if (!perPlatform) memo.set(file, perPlatform = new Map())
  perPlatform.set(platform, result)
  return result
}
