import { commandDescriptor, type CommandId } from '../../../../shared/commands/catalog'
import {
  gestureAvailable, gestureDefault, gestureDescriptor, gestureIds, gestureLabel, gestureOptions, gestureScopes, modifiersLabel,
  sameChoice, type GestureChoice, type GestureId, type GestureKind, type GestureModifiers, type PointerAction
} from '../../../../shared/commands/gestures'
import { gestureChoiceText as gestureToken, gestureOverrides, withGestureChoice } from '../../../../shared/commands/gesture-choices'
import { validateGestures, type GestureProblem } from '../../../../shared/commands/gesture-validate'
import { effectiveRules } from '../../../../shared/commands/effective'
import { keybindingLabel, type KeybindingLabel, type Platform } from '../../../../shared/commands/keybindings'
import type { ShortcutFile } from '../../../../shared/commands/shortcut-schema'

/** The Mouse view's groups, in order; `linked` rows are settings of other pages shown with the gestures. */
export type GestureRowGroup = GestureKind | 'linked'
export const gestureRowGroups: readonly { readonly id: GestureRowGroup; readonly title: string }[] = [
  { id: 'modifier', title: 'Modifier behaviours' },
  { id: 'pointerCommand', title: 'Pointer commands · each also has a keyboard path' },
  { id: 'fixed', title: 'Fixed' },
  { id: 'linked', title: 'Linked settings' }
]

/** One choice in a row's dropdown: its stored token (`off`, `none`, `alt`), its modifiers (null for Off) and its label. */
export interface GestureOption { readonly token: string; readonly choice: GestureChoice; readonly label: string }
/** `builtin`: locked (a fixed gesture, or a pointer command v1 cannot remap), as the All view calls it. */
export type GestureSource = 'default' | 'user' | 'builtin' | 'setting'
export const gestureSourceTitles: Readonly<Record<GestureSource, string>> = { default: 'Default', user: 'User', builtin: 'Built-in', setting: 'Setting' }

/** The linked Text Editor setting the Mouse view shows (Monaco's multiCursorModifier). */
export const multiCursorRowId = 'textEditor.multiCursorModifier'
export const multiCursorPage = 'textEditor.general'
export interface LinkedSettings { readonly multiCursorModifier: 'alt' | 'ctrlCmd' }
const defaultLinked: LinkedSettings = { multiCursorModifier: 'alt' }

/** The fields lane G's All view reads (`id`, `title`, `label`, `scopeTitle`, `kind`, `changed`, `locked`) keep their stub's names. */
export interface GestureRow {
  readonly id: GestureId | typeof multiCursorRowId
  readonly kind: GestureRowGroup
  readonly title: string
  readonly description: string
  readonly action: PointerAction
  readonly target: string
  /** The scopes it works in: `Results Grid, Table Designer`. */
  readonly scopeTitle: string
  /** The gesture as it is in the draft: `Ctrl+Drag`, `Off`. */
  readonly label: string
  /** The draft's choice (null for Off); a linked row's modifiers. */
  readonly current: GestureChoice
  /** `current` as its option's token. */
  readonly currentToken: string
  readonly defaultChoice: GestureModifiers
  /** `Ctrl` or `⌘`: what Reset returns to. */
  readonly defaultLabel: string
  /** The dropdown's options; empty for a locked row. */
  readonly options: readonly GestureOption[]
  /** Why a fixed or locked row cannot be remapped. */
  readonly locked?: string
  readonly source: GestureSource
  /** The draft differs from the default; a per-row Reset applies. */
  readonly changed: boolean
  readonly keyboard: readonly CommandId[]
  /** Each keyboard command's key in the draft's rules (`label` undefined when it has none there). */
  readonly keys: readonly { readonly command: CommandId; readonly label?: KeybindingLabel }[]
  /**
   * The draft stores a choice for this gesture that only another platform offers (a hand-edited file): it does not apply
   * here, the row shows the default, and Reset removes it.
   */
  readonly otherPlatform?: true
  /** Clashes and desktop warnings for the draft's choice. */
  readonly problems: readonly GestureProblem[]
  /** The setting page a linked row opens. */
  readonly page?: string
}

const whereText = (id: GestureId) => { const gesture = gestureDescriptor(id); return [gesture.scope, ...gesture.alsoIn ?? []].map(scope => gestureScopes[scope]).join(', ') }
const groupOrder = (kind: GestureRowGroup) => gestureRowGroups.findIndex(entry => entry.id === kind)

function linkedRow(platform: Platform, linked: LinkedSettings): GestureRow {
  const current: GestureModifiers = linked.multiCursorModifier === 'ctrlCmd' ? ['mod'] : ['alt']
  return {
    id: multiCursorRowId, kind: 'linked', title: 'Add Cursor', description: 'Adds another cursor where you click in the query editor (Monaco\'s multi-cursor modifier).',
    action: 'click', target: 'the query editor', scopeTitle: 'SQL Query Editor', label: gestureLabel('click', current, platform), current, currentToken: gestureToken(current), defaultChoice: ['alt'],
    defaultLabel: modifiersLabel(['alt'], platform), options: [], source: 'setting', changed: linked.multiCursorModifier !== defaultLinked.multiCursorModifier,
    keyboard: [], keys: [], problems: [], page: multiCursorPage
  }
}

interface SearchToken { readonly name: string; readonly value: string }
/** As the Shortcuts page splits its search box (`shortcuts-search.ts`): lower-case words and `@name:value` tokens. */
function parseSearch(text: string): { words: string[]; tokens: SearchToken[] } {
  const words: string[] = [], tokens: SearchToken[] = []
  for (const part of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (part.startsWith('@') && part.length > 1) {
      const at = part.indexOf(':')
      tokens.push(at < 0 ? { name: part.slice(1), value: '' } : { name: part.slice(1, at), value: part.slice(at + 1) })
    } else words.push(part)
  }
  return { words, tokens }
}
/** The page's token rules for a gesture row: prefixes for `kind` and `source`, and a token it does not know filters nothing. */
function tokenMatches({ name, value }: SearchToken, row: GestureRow): boolean {
  switch (name) {
    case 'modified': return row.changed
    case 'conflicts': return row.problems.length > 0
    case 'unbound': return row.current === null
    case 'source': return row.source.startsWith(value) || gestureSourceTitles[row.source].toLowerCase().startsWith(value) || (row.source === 'builtin' && 'fixed'.startsWith(value))
    case 'scope': return row.scopeTitle.toLowerCase().includes(value)
    case 'command': return [row.id, ...row.keyboard].some(id => id.toLowerCase().includes(value))
    case 'kind': return !value || 'mouse'.startsWith(value)
    default: return true
  }
}
function matches(row: GestureRow, words: readonly string[], tokens: readonly SearchToken[]): boolean {
  if (!tokens.every(token => tokenMatches(token, row))) return false
  const text = [row.title, row.id, row.description, row.scopeTitle, row.label, row.target, row.locked ?? '', ...row.keyboard.map(command => commandDescriptor(command).title)].join(' ').toLowerCase()
  return words.every(word => text.includes(word))
}

/**
 * The gestures as the Shortcuts page lists them, in group order: each with the draft's choice, what it may choose on
 * `platform`, and its problems; then, given `linked` (the Mouse view does; the All view does not), the linked editor
 * setting. Gestures that do not exist on `platform` are left out.
 * `search` is the page's text, read by the page's rules: every word must match (titles, ids, scopes, bindings,
 * keyboard commands), and `@` tokens filter (`@kind:m` is a prefix of mouse; a token it does not know filters nothing).
 * Keyboard paths are labelled from the draft's own rules.
 */
export function gestureRows(draft: ShortcutFile, platform: Platform, search: string, linked?: LinkedSettings): readonly GestureRow[] {
  const overrides = gestureOverrides(draft.gestures, platform)
  const problems = validateGestures(platform, overrides)
  const rules = effectiveRules(platform, draft).rules
  const keyOf = (command: CommandId) => {
    const rule = rules.find(candidate => candidate.command === command && candidate.chords.length === 1) ?? rules.find(candidate => candidate.command === command)
    return rule && keybindingLabel(rule.chords, platform)
  }
  const rows: GestureRow[] = gestureIds.filter(id => gestureAvailable(id, platform)).map(id => {
    const gesture = gestureDescriptor(id), fallback = gestureDefault(id, platform)
    const current = overrides.has(id) ? overrides.get(id)! : fallback
    const options = gestureOptions(id, platform).map(choice => ({ token: gestureToken(choice), choice, label: choice === null ? 'Off' : modifiersLabel(choice, platform) }))
    const otherPlatform = Object.hasOwn(draft.gestures, id) && !overrides.has(id)
    const modified = !sameChoice(current, fallback) || otherPlatform
    return {
      id, kind: gesture.kind, title: gesture.title, description: gesture.description, action: gesture.action, target: gesture.target, scopeTitle: whereText(id),
      label: current === null ? 'Off' : gestureLabel(gesture.action, current, platform), current, currentToken: gestureToken(current), defaultChoice: fallback, defaultLabel: modifiersLabel(fallback, platform),
      options, locked: gesture.locked, source: gesture.locked ? 'builtin' : modified ? 'user' : 'default', changed: modified, keyboard: gesture.keyboard ?? [],
      keys: (gesture.keyboard ?? []).map(command => ({ command, label: keyOf(command) })), ...otherPlatform ? { otherPlatform: true as const } : {},
      problems: problems.filter(problem => problem.id === id)
    }
  })
  if (linked) rows.push(linkedRow(platform, linked))
  rows.sort((a, b) => groupOrder(a.kind) - groupOrder(b.kind))
  const { words, tokens } = parseSearch(search)
  return words.length || tokens.length ? rows.filter(row => matches(row, words, tokens)) : rows
}

/** The draft with a gesture set to `choice`, or reset to its default when `choice` is undefined (the file keeps only changes). */
export function setGesture(draft: ShortcutFile, id: GestureId, choice: GestureChoice | undefined, platform: Platform): ShortcutFile {
  return { ...draft, gestures: withGestureChoice(draft.gestures, id, choice, platform) }
}
