import type { ResolvedViewFilter, ResultsDistinctResult, ViewFilter } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'

/**
 * What the header funnel's popover applies to a column (results.view filters by base rows, each row standing for its value
 * as the column's collation compares it): the checklist's values (`in` or `notIn`, whichever names fewer), one value or
 * not it, between two values, NULL or not NULL; `all` takes the checklist's filter off, `clear` every filter of the column.
 */
export type ColumnCondition =
  | { readonly kind: 'values'; readonly op: 'in' | 'notIn'; readonly rows: readonly number[]; readonly nulls: boolean }
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
    case 'values': return { op: condition.op, column, rows: [...condition.rows], nulls: condition.nulls }
    case 'equals': return { op: 'in', column, rows: [condition.row], nulls: false }
    case 'notEquals': return { op: 'notIn', column, rows: [condition.row], nulls: false }
    case 'between': return { op: 'between', column, rows: [...condition.rows] }
    case 'null': return { op: 'in', column, rows: [], nulls: true }
    case 'notNull': return { op: 'notIn', column, rows: [], nulls: true }
    default: return undefined
  }
}

/**
 * What a truncated list's OK does with the values it never listed: keeps `rows` with the ticked ones (`in`) or drops them
 * with the cleared ones (`notIn`), so each stays as the grid shows it now. `exact` is false when the grid's view holds and
 * drops too many of them for one filter either way, and they will all be shown.
 */
export interface Unlisted { readonly op: 'in' | 'notIn'; readonly rows: readonly number[]; readonly exact: boolean }

/** A list's unlisted values from its answer's kept marks (undefined when it listed every value); rows the checklist knows
 *  (a search found them) are its own, so they are left out. */
export function unlistedValues(result: ResultsDistinctResult, known: { has(row: number): boolean }): Unlisted | undefined {
  if (!result.truncated) return undefined
  // No kept marks: the column has no value filter, so the grid shows them all.
  if (result.unlistedKept === undefined) return { op: 'notIn', rows: [], exact: true }
  if (!result.unlistedKept) return { op: 'in', rows: [], exact: true }
  if (result.unlistedHeld) return { op: 'in', rows: result.unlistedHeld.filter(row => !known.has(row)), exact: true }
  if (result.unlistedDropped) return { op: 'notIn', rows: result.unlistedDropped.filter(row => !known.has(row)), exact: true }
  return { op: 'notIn', rows: [], exact: false }
}

/** What the checklist's OK does, or why it cannot: nothing ticked, or more values than one filter holds. */
export type ChecklistOutcome = { readonly condition: ColumnCondition } | { readonly error: string }

/**
 * The checklist as a condition. `rows` are the values listed (each its representative row), `unchecked` those cleared;
 * NULL is an entry of its own when the column has NULLs. Every value ticked takes the filter off; otherwise the shorter
 * of keeping the ticked values (`in`) or dropping the cleared ones (`notIn`), keeping on a tie. A truncated list's
 * `unlisted` decides instead, and adds the rows it names, so the values it did not reach stay as the grid shows them.
 */
export function checklistCondition(o: { rows: readonly number[]; unchecked: ReadonlySet<number>; hasNull: boolean; nullChecked: boolean; unlisted?: Unlisted }): ChecklistOutcome {
  const checked = o.rows.filter(row => !o.unchecked.has(row)), cleared = o.rows.filter(row => o.unchecked.has(row))
  const nullIn = o.hasNull && o.nullChecked, nullOut = o.hasNull && !o.nullChecked
  const keeping = checked.length + (nullIn ? 1 : 0), dropping = cleared.length + (nullOut ? 1 : 0)
  if (keeping === 0) return { error: 'Select at least one value.' }
  // Every value ticked shows every row only when the values not listed are all shown too.
  if (dropping === 0 && (!o.unlisted || (o.unlisted.op === 'notIn' && !o.unlisted.rows.length))) return { condition: { kind: 'all' } }
  const keep = o.unlisted ? o.unlisted.op === 'in' : keeping <= dropping, extra = o.unlisted?.rows ?? []
  const condition: ColumnCondition = keep ? { kind: 'values', op: 'in', rows: [...checked, ...extra], nulls: nullIn } : { kind: 'values', op: 'notIn', rows: [...cleared, ...extra], nulls: nullOut }
  return condition.rows.length > wire.views.maxFilterValues ? { error: `A filter holds at most ${wire.views.maxFilterValues.toLocaleString('en-US')} values. Select fewer, or clear fewer.` } : { condition }
}
