// Peek's card layout and value formatting, kept apart from the component so the checks can run them without a DOM.
import type { PeekFormat, PeekValue } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'

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

