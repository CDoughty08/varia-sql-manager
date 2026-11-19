// Peek's card layout and value formatting, kept apart from the component so the checks can run them without a DOM.
import type { PeekFormat, PeekListColumn, PeekValue } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { LocalTableData } from '../../../shared/results/local-table.ts'

/** The card's room: as wide and tall as this where the window allows, and this far from the pane and the window's edges. */
export const cardWidth = 880, cardHeight = 480, gap = 8

/** An object's name as Peek's header and a promoted tab show it: its schema and name, a child's (an index, a trigger) below its parent's. */
export const peekObjectName = (object: { readonly schema?: string; readonly name?: string; readonly parent?: { readonly schema?: string; readonly name?: string } }): string =>
  displayText([object.parent?.schema, object.parent?.name, object.schema, object.name].filter(part => part !== undefined).join('.'))
const numbers = new Intl.NumberFormat('en-US')
const megabytes = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const words = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ')

/**
 * A fact or list value as SSMS's Properties grid shows it: dates to the minute, True and False, sizes in KB or MB, and catalog
 * codes (`NON_TEMPORAL_TABLE`, `PAGE`) in words.
 */
export function formatPeekValue(fact: { readonly format: PeekFormat }, value: PeekValue): string {
  if (value === null) return '—'
  switch (fact.format) {
    case 'date': return typeof value === 'string' ? value.slice(0, 16).replace('T', ' ') : String(value)
    case 'bool': return value === true ? 'True' : value === false ? 'False' : String(value)
    case 'count': return typeof value === 'number' ? numbers.format(value) : String(value)
    case 'kb': return typeof value !== 'number' ? String(value) : value >= 1024 ? megabytes.format(value / 1024) + ' MB' : numbers.format(value) + ' KB'
    case 'code': return typeof value === 'string' && /^[A-Z]+(_[A-Z]+)*$/.test(value) ? words(value) : displayText(String(value))
    default: return displayText(String(value))
  }
}

/**
 * A Peek list as a local table (`LocalGrid`): its columns by their labels, a count a number column, NULL as NULL (as a results
 * grid shows it), text as the catalog holds it (the grid shows control characters itself), and the other formats as the
 * Properties pane words them (True and False, sizes in KB or MB, codes in words).
 */
export function peekListTable(spec: { readonly columns: readonly PeekListColumn[] }, rows: readonly (readonly PeekValue[])[]): LocalTableData {
  return {
    columns: spec.columns.map(column => column.format === 'count' ? { name: column.label, kind: 'number' as const } : { name: column.label }),
    rows: rows.map(row => spec.columns.map((column, index) => {
      const value = row[index] ?? null
      return value === null ? null : column.format === 'text' ? String(value) : formatPeekValue(column, value)
    }))
  }
}

/**
 * Properties as Copy writes them: a `Name<TAB>Value` line a fact, the platform's line breaks between them (as a grid's copy), a
 * tab or line break inside a value turned to a space so each fact stays one line of two fields.
 */
export function peekPropertiesText(facts: readonly (readonly [name: string, value: string])[], crlf: boolean): string {
  const field = (text: string) => text.replace(/[\t\r\n]+/g, ' ')
  return facts.map(([name, value]) => `${field(name)}\t${field(value)}`).join(crlf ? '\r\n' : '\n')
}

/** Where the card goes: beside the pane on the side with room (right first), level with the row, inside the window. */
export function placePeek(row: { top: number; height: number } | undefined, pane: { left: number; right: number }, view: { width: number; height: number }, last?: { left: number; top: number }) {
  const width = Math.max(0, Math.min(cardWidth, view.width - 2 * gap)), height = Math.max(0, Math.min(cardHeight, view.height - 2 * gap))
  const left = pane.right + gap + width <= view.width - gap ? pane.right + gap
    : pane.left - gap - width >= gap ? pane.left - gap - width
      : Math.max(gap, view.width - gap - width)
  const wanted = row ? row.top + row.height / 2 - 48 : last?.top ?? gap
  const top = Math.min(Math.max(gap, wanted), Math.max(gap, view.height - gap - height))
  return { left, top, width, height }
}

/** The shortest card worth opening below or above a name; with less room either side, it covers the name. */
export const minAnchoredHeight = 200

/**
 * Where a card anchored at a name goes (a query editor's Ctrl+hover): below the name, or above it when there is more room
 * there, starting at its left edge, inside the window; while the name is scrolled out of view it stays where it was.
 */
export function placePeekAt(word: { left: number; top: number; bottom: number } | undefined, view: { width: number; height: number }, last?: { left: number; top: number; width: number; height: number }) {
  if (!word && last) return last
  const width = Math.max(0, Math.min(cardWidth, view.width - 2 * gap))
  if (!word) return { left: gap, top: gap, width, height: Math.max(0, Math.min(cardHeight, view.height - 2 * gap)) }
  const left = Math.min(Math.max(gap, word.left), Math.max(gap, view.width - gap - width))
  const below = view.height - gap - (word.bottom + 2), above = word.top - 2 - gap
  const room = Math.max(below, above)
  if (room < minAnchoredHeight) {
    const height = Math.max(0, Math.min(cardHeight, view.height - 2 * gap))
    return { left, top: Math.min(Math.max(gap, word.bottom + 2), Math.max(gap, view.height - gap - height)), width, height }
  }
  const height = Math.min(cardHeight, room)
  return { left, top: below >= above || below >= cardHeight ? word.bottom + 2 : word.top - 2 - height, width, height }
}

