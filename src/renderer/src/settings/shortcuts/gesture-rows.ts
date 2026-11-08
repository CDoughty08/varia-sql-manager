import { commandDescriptor, type CommandId } from '../../../../shared/commands/catalog'
import {
  gestureAvailable, gestureDefault, gestureDescriptor, gestureIds, gestureLabel, gestureOptions, gestureScopes, modifiersLabel,
  sameChoice, type GestureChoice, type GestureId, type GestureKind, type GestureModifiers, type PointerAction
} from '../../../../shared/commands/gestures'
import { gestureChoiceText as gestureToken, gestureOverrides, withGestureChoice } from '../../../../shared/commands/gesture-choices'
import { validateGestures, type GestureProblem } from '../../../../shared/commands/gesture-validate'
import type { Platform } from '../../../../shared/commands/keybindings'
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
export type GestureSource = 'default' | 'user' | 'fixed' | 'setting'

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
    keyboard: [], problems: [], page: multiCursorPage
  }
}

function matches(row: GestureRow, terms: readonly string[]): boolean {
  const text = [row.title, row.id, row.description, row.scopeTitle, row.label, row.target, row.locked ?? '', ...row.keyboard.map(command => commandDescriptor(command).title)].join(' ').toLowerCase()
  return terms.every(term => {
    if (!term.startsWith('@')) return text.includes(term)
    // The page's tokens: gestures are all `@kind:mouse`, and `@modified` finds the changed ones.
    if (term === '@modified') return row.changed
    if (term === '@kind:mouse') return true
    if (term === '@kind:keyboard') return false
    if (term.startsWith('@source:')) return ({ user: row.source === 'user', default: row.source === 'default', builtin: row.source === 'fixed', fixed: row.source === 'fixed', setting: row.source === 'setting' } as Record<string, boolean>)[term.slice(8)] ?? false
    return text.includes(term)
  })
}

/**
 * The gestures as the Shortcuts page lists them, in group order: each with the draft's choice, what it may choose on
 * `platform`, and its problems; then, given `linked` (the Mouse view does; the All view does not), the linked editor
 * setting. Gestures that do not exist on `platform` are left out.
 * `search` is the page's text: every word must match (titles, ids, scopes, bindings, keyboard commands), and the
 * `@modified`, `@kind:` and `@source:` tokens filter.
 */
export function gestureRows(draft: ShortcutFile, platform: Platform, search: string, linked?: LinkedSettings): readonly GestureRow[] {
  const overrides = gestureOverrides(draft.gestures, platform)
  const problems = validateGestures(platform, overrides)
  const rows: GestureRow[] = gestureIds.filter(id => gestureAvailable(id, platform)).map(id => {
    const gesture = gestureDescriptor(id), fallback = gestureDefault(id, platform)
    const current = overrides.has(id) ? overrides.get(id)! : fallback
    const options = gestureOptions(id, platform).map(choice => ({ token: gestureToken(choice), choice, label: choice === null ? 'Off' : modifiersLabel(choice, platform) }))
    const modified = !sameChoice(current, fallback)
    return {
      id, kind: gesture.kind, title: gesture.title, description: gesture.description, action: gesture.action, target: gesture.target, scopeTitle: whereText(id),
      label: current === null ? 'Off' : gestureLabel(gesture.action, current, platform), current, currentToken: gestureToken(current), defaultChoice: fallback, defaultLabel: modifiersLabel(fallback, platform),
      options, locked: gesture.locked, source: gesture.kind === 'fixed' ? 'fixed' : modified ? 'user' : 'default', changed: modified, keyboard: gesture.keyboard ?? [],
      problems: problems.filter(problem => problem.id === id)
    }
  })
  if (linked) rows.push(linkedRow(platform, linked))
  rows.sort((a, b) => groupOrder(a.kind) - groupOrder(b.kind))
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.length ? rows.filter(row => matches(row, terms)) : rows
}

/** The draft with a gesture set to `choice`, or reset to its default when `choice` is undefined (the file keeps only changes). */
export function setGesture(draft: ShortcutFile, id: GestureId, choice: GestureChoice | undefined, platform: Platform): ShortcutFile {
  return { ...draft, gestures: withGestureChoice(draft.gestures, id, choice, platform) }
}
