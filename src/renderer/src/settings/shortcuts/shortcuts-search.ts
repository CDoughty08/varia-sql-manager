// The Shortcuts page's search box without the DOM: free words over a command's title, id, category and key labels,
// `@` tokens (`@modified`, `@source:user`, `@scope:editor`, `@command:query.`, `@kind:mouse`), the Modified, Conflicts
// and Unbound chips (which add or remove their tokens), and Record Keys, which filters by the exact chord pressed.
import { sameChords } from '../../../../shared/commands/shortcut-rules'
import { sourceTitles, type BindingRow, type CommandRow } from './shortcut-draft'

/** The search box's length, as Options' own search box. */
export const shortcutSearchChars = 256

export type ChipToken = 'modified' | 'conflicts' | 'unbound'
export const chipTokens: readonly ChipToken[] = ['modified', 'conflicts', 'unbound']
/** The tokens the box understands, for its placeholder and the docs. */
export const tokenNames = ['modified', 'conflicts', 'unbound', 'source', 'scope', 'command', 'kind'] as const
export interface SearchToken { readonly name: string; readonly value: string }
export interface ShortcutQuery {
  /** Free words, lower case; every word must match. */
  readonly words: readonly string[]
  readonly tokens: readonly SearchToken[]
}

/** Splits the box's text into words and `@name:value` tokens (case-folded, at most `shortcutSearchChars`). */
export function parseShortcutQuery(text: string): ShortcutQuery {
  const words: string[] = [], tokens: SearchToken[] = []
  for (const part of text.slice(0, shortcutSearchChars).toLowerCase().split(/\s+/).filter(Boolean)) {
    if (part.startsWith('@') && part.length > 1) {
      const at = part.indexOf(':')
      tokens.push(at < 0 ? { name: part.slice(1), value: '' } : { name: part.slice(1, at), value: part.slice(at + 1) })
    } else words.push(part)
  }
  return { words, tokens }
}
export const hasToken = (text: string, name: ChipToken): boolean => parseShortcutQuery(text).tokens.some(token => token.name === name)
/** The box's text with a chip's token added, or removed when it is there. */
export function toggleToken(text: string, name: ChipToken): string {
  const parts = text.split(/\s+/).filter(Boolean)
  const kept = parts.filter(part => part.toLowerCase() !== '@' + name)
  return (kept.length === parts.length ? [...parts, '@' + name] : kept).join(' ') + (kept.length === parts.length ? ' ' : '')
}
/** Whether the query asks for something other than keyboard rows (`@kind:mouse`) or other than mouse rows (`@kind:key`). */
export const showsKind = (query: ShortcutQuery, kind: 'key' | 'mouse'): boolean =>
  query.tokens.every(token => token.name !== 'kind' || !token.value || (kind === 'key' ? 'keyboard'.startsWith(token.value) || 'keys'.startsWith(token.value) : 'mouse'.startsWith(token.value)))
/** A query with no words and no tokens (Record Keys aside) filters nothing. */
export const isEmptyQuery = (query: ShortcutQuery): boolean => !query.words.length && !query.tokens.length

const modified = (binding: BindingRow | undefined) => binding?.source === 'user' || binding?.source === 'removed'
function tokenMatches(token: SearchToken, row: CommandRow, binding: BindingRow | undefined): boolean {
  const { value } = token
  switch (token.name) {
    case 'modified': return modified(binding)
    case 'conflicts': return row.problem
    case 'unbound': return !row.bindings.some(item => item.source !== 'removed')
    case 'source': return !!binding && (binding.source.startsWith(value) || sourceTitles[binding.source].toLowerCase().startsWith(value))
    case 'scope': return !!binding && (binding.scope.toLowerCase().includes(value) || binding.scopeTitle.toLowerCase().includes(value))
    case 'command': return row.id.toLowerCase().includes(value)
    case 'kind': return showsKind({ words: [], tokens: [token] }, 'key')
    // A token the box does not know filters nothing, so a half-typed one does not empty the table.
    default: return true
  }
}

/** One table row: a command with one of its shortcuts (the first row of a command carries its title), or none. */
export interface ShortcutRowMatch { readonly row: CommandRow; readonly binding?: BindingRow; readonly first: boolean }
export interface ShortcutGroup { readonly category: string; readonly rows: readonly ShortcutRowMatch[] }

/**
 * The table's rows for `text`, grouped by category in catalogue order. `record` (Record Keys) keeps only shortcuts
 * whose chords are exactly the ones pressed. A command with no shortcut is one row, matched as Unbound.
 */
export function filterShortcutRows(rows: readonly CommandRow[], text: string, record?: readonly string[]): ShortcutGroup[] {
  const query = parseShortcutQuery(text)
  const groups: { category: string; rows: ShortcutRowMatch[] }[] = []
  if (!showsKind(query, 'key')) return groups
  const matches = (row: CommandRow, binding: BindingRow | undefined) => {
    if (record && !(binding && binding.source !== 'removed' && sameChords(binding.rule.chords, record))) return false
    if (!query.tokens.every(token => tokenMatches(token, row, binding))) return false
    if (!query.words.length) return true
    const haystack = [row.title, row.id, row.category, ...binding ? [binding.label.text, binding.label.aria, binding.scopeTitle] : []].join(' ').toLowerCase()
    return query.words.every(word => haystack.includes(word))
  }
  for (const row of rows) {
    const shown = (row.bindings.length ? row.bindings : [undefined]).filter(binding => matches(row, binding))
    if (!shown.length) continue
    let group = groups.find(item => item.category === row.category)
    if (!group) groups.push(group = { category: row.category, rows: [] })
    shown.forEach((binding, index) => group.rows.push({ row, ...binding ? { binding } : {}, first: index === 0 }))
  }
  return groups
}
/** How many commands the groups show (a command with two shortcuts counts once). */
export const commandCount = (groups: readonly ShortcutGroup[]): number => groups.reduce((sum, group) => sum + group.rows.filter(row => row.first).length, 0)
/** The chips' counts over every command: shortcuts the user changed, commands with an entry that does not apply, commands with no shortcut. */
export function chipCounts(rows: readonly CommandRow[]): Readonly<Record<ChipToken, number>> {
  return {
    modified: rows.reduce((sum, row) => sum + row.bindings.filter(modified).length, 0),
    conflicts: rows.filter(row => row.problem).length,
    unbound: rows.filter(row => !row.bindings.some(binding => binding.source !== 'removed')).length
  }
}
