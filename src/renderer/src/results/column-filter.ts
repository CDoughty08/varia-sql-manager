import type { ResolvedViewFilter, ViewFilter } from '../../../shared/contracts'
import type { DistinctList } from './ResultClient'

/**
 * What the header funnel's popover applies to a column: the values its checklist ticks (a `groups` filter by its distinct
 * snapshot, `list`, which the grid then keeps), and by base rows, each row standing for its value as the column's
 * collation compares it, one value or not it, between two values, NULL or not NULL; `all` takes the checklist's filter
 * off, `clear` every filter of the column.
 */
export type ColumnCondition =
  | { readonly kind: 'list'; readonly list: DistinctList }
  | { readonly kind: 'equals' | 'notEquals'; readonly row: number }
  | { readonly kind: 'between'; readonly rows: readonly [number, number] }
  | { readonly kind: 'null' | 'notNull' }
  | { readonly kind: 'all' | 'clear' }

/** Which of a column's filters a condition replaces: its value list (in, notIn, equals, NULL), its range, or its not-NULL.
 *  The checklist lists NULL as a value, so a value list and a not-NULL replace each other (`sameFilterFamily`). */
export type ColumnFilterKind = 'values' | 'between' | 'notNull'

/** A notIn of no rows with NULL: Exclude NULLs. */
export const isNotNullFilter = (filter: ViewFilter | ResolvedViewFilter) => filter.op === 'notIn' && 'rows' in filter && filter.rows.length === 0 && !!filter.nulls

/** The kind of a grid filter on `column`, or undefined when it is not one of that column's (duplicates span columns). */
export function columnFilterKind(filter: ViewFilter | ResolvedViewFilter, column: number): ColumnFilterKind | undefined {
  if (filter.op === 'duplicates' || filter.column !== column) return undefined
  if (filter.op === 'between') return 'between'
  return isNotNullFilter(filter) ? 'notNull' : 'values'
}

/** Whether a filter of kind `own` is the one a condition of kind `kind` replaces: the same kind, or a value list and a
 *  not-NULL, which the checklist shows as one list. */
export const sameFilterFamily = (own: ColumnFilterKind, kind: ColumnFilterKind) => own === kind || (own !== 'between' && kind !== 'between')

export function conditionKind(condition: ColumnCondition): ColumnFilterKind | undefined {
  switch (condition.kind) {
    case 'between': return 'between'
    case 'notNull': return 'notNull'
    case 'clear': return undefined
    default: return 'values'
  }
}

/** The view filter a condition asks for (undefined for `all` and `clear`, which only take filters off). */
export function conditionFilter(condition: ColumnCondition, column: number): ViewFilter | undefined {
  switch (condition.kind) {
    case 'list': return { op: 'groups', column, snapshotId: condition.list.snapshotId }
    case 'equals': return { op: 'in', column, rows: [condition.row], nulls: false }
    case 'notEquals': return { op: 'notIn', column, rows: [condition.row], nulls: false }
    case 'between': return { op: 'between', column, rows: [...condition.rows] }
    case 'null': return { op: 'in', column, rows: [], nulls: true }
    case 'notNull': return { op: 'notIn', column, rows: [], nulls: true }
    default: return undefined
  }
}

/** What the checklist's OK does, or why it cannot: nothing ticked. */
export type ChecklistOutcome = { readonly condition: ColumnCondition } | { readonly error: string }

/**
 * The checklist as a condition, from its snapshot's ticks: `checked` of its `distinct` values, and NULL's tick when the
 * column has NULLs. Nothing ticked cannot filter; everything ticked takes the filter off; anything else filters by the
 * snapshot, whose rows the backend names as it likes (it keeps or drops whichever are fewer, and drops while rows still
 * arrive, so their values stay shown).
 */
export function checklistCondition(o: { list: DistinctList; checked: number; distinct: number; hasNull: boolean; nullChecked: boolean }): ChecklistOutcome {
  const nullIn = o.hasNull && o.nullChecked
  if (o.checked === 0 && !nullIn) return { error: 'Select at least one value.' }
  if (o.checked === o.distinct && (!o.hasNull || nullIn)) return { condition: { kind: 'all' } }
  return { condition: { kind: 'list', list: o.list } }
}

/** The checklist's tallest scroll space in px: Chromium clamps layout sizes near 33.5 million px, so a longer list maps its
 *  scroll bar onto its rows instead of giving each row its own pixels. */
export const maxListSpace = 30_000_000

/** The rows of a virtual list of fixed-height rows drawn for a scroll position (with `overscan` rows past each edge), its
 *  scroll space, and each row's place in it. Within `maxListSpace` a row sits at `row × rowHeight`; past it the scroll bar's
 *  range spans the rows, and the rows in view are placed around the scroll position, so every row stays reachable. */
export function listWindow(o: { scrollTop: number; viewHeight: number; rowHeight: number; rows: number; overscan: number; maxSpace?: number }): { space: number; first: number; last: number; offset(row: number): number } {
  const { scrollTop, viewHeight, rowHeight, rows, overscan } = o, maxSpace = o.maxSpace ?? maxListSpace
  const full = rows * rowHeight, space = Math.min(full, maxSpace), visible = Math.max(viewHeight, rowHeight) / rowHeight
  const top = full <= maxSpace ? scrollTop / rowHeight
    : Math.min(1, Math.max(0, scrollTop / Math.max(1, space - viewHeight))) * Math.max(0, rows - viewHeight / rowHeight)
  // Mapped, the rows past the view's bottom stop at the space's end: each starts inside it, and the space clips the part of
  // the last that would hang past it (overflow: hidden), so no row grows the scroll range.
  const fits = full <= maxSpace ? rows : Math.ceil(top + (space - scrollTop) / rowHeight - 1e-6)
  return {
    space,
    first: Math.max(0, Math.floor(top) - overscan),
    last: Math.max(0, Math.min(rows, fits, Math.ceil(top + visible) + overscan)),
    offset: row => full <= maxSpace ? row * rowHeight : scrollTop + (row - top) * rowHeight
  }
}

/** The cached blocks to drop so at most `max` stay: the farthest from those in view (`first` to `last`), never one in view. */
export function blocksToDrop(blocks: Iterable<number>, first: number, last: number, max: number): number[] {
  const held = [...blocks]
  if (held.length <= max) return []
  const distance = (block: number) => block < first ? first - block : block > last ? block - last : 0
  return held.filter(block => distance(block) > 0).sort((a, b) => distance(b) - distance(a)).slice(0, held.length - max)
}
