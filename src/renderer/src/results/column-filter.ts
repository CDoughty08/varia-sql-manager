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
 * The values a list never showed (past its cap, or in rows still arriving) and how OK can leave each as the grid shows it:
 * `held` the rows of those the grid shows, which an `in` keeps with the ticked values, and `dropped` the rows of those it
 * hides, which a `notIn` drops with the cleared ones. Undefined when that side cannot be named: more than one filter holds,
 * or (for `held`) values still to arrive, which an `in` would hide. Neither named: a `notIn` shows them all.
 */
export interface Unlisted { readonly held?: readonly number[]; readonly dropped?: readonly number[]; readonly truncated: boolean; readonly complete: boolean }

/** A list's unlisted values from its answer's kept marks (undefined when it listed every value of every row); rows the
 *  checklist knows (a search or another order found them) are its own, so they are left out. */
export function unlistedValues(result: ResultsDistinctResult, known: { has(row: number): boolean }): Unlisted | undefined {
  if (!result.truncated && result.complete) return undefined
  const own = (rows: readonly number[] | undefined) => rows?.filter(row => !known.has(row))
  // Not truncated: nothing past the list. No kept marks: the column has no value filter, so the grid shows them all.
  const held = !result.truncated ? [] : result.unlistedKept === undefined ? undefined : own(result.unlistedHeld)
  const dropped = !result.truncated || result.unlistedKept === undefined ? [] : own(result.unlistedDropped)
  return { ...result.complete && held ? { held } : {}, ...dropped ? { dropped } : {}, truncated: result.truncated, complete: result.complete }
}

/** What the checklist's OK does, or why it cannot: nothing ticked, or more values than one filter holds. */
export type ChecklistOutcome = { readonly condition: ColumnCondition } | { readonly error: string }

/**
 * The checklist as a condition. `rows` are the values listed (each its representative row), `unchecked` those cleared;
 * NULL is an entry of its own when the column has NULLs. Every value ticked takes the filter off; otherwise the shorter
 * of keeping the ticked values (`in`) or dropping the cleared ones (`notIn`) that fits one filter, keeping on a tie. With
 * `unlisted` each side also names its unlisted rows, and only a side it can name is a choice, so the values the list did
 * not show stay as the grid shows them.
 */
export function checklistCondition(o: { rows: readonly number[]; unchecked: ReadonlySet<number>; hasNull: boolean; nullChecked: boolean; unlisted?: Unlisted }): ChecklistOutcome {
  const checked = o.rows.filter(row => !o.unchecked.has(row)), cleared = o.rows.filter(row => o.unchecked.has(row))
  const nullIn = o.hasNull && o.nullChecked, nullOut = o.hasNull && !o.nullChecked
  const keeping = checked.length + (nullIn ? 1 : 0), dropping = cleared.length + (nullOut ? 1 : 0)
  if (keeping === 0) return { error: 'Select at least one value.' }
  const held = o.unlisted ? o.unlisted.held : [], dropped = o.unlisted ? o.unlisted.dropped : []
  // Every value ticked shows every row only when the values not listed are all shown too (or none can be named).
  if (dropping === 0 && (dropped?.length === 0 || (!held && !dropped))) return { condition: { kind: 'all' } }
  const choices: { condition: ColumnCondition & { kind: 'values' }; size: number }[] = []
  if (held) choices.push({ condition: { kind: 'values', op: 'in', rows: [...checked, ...held], nulls: nullIn }, size: keeping + held.length })
  if (dropped || !held) choices.push({ condition: { kind: 'values', op: 'notIn', rows: [...cleared, ...dropped ?? []], nulls: nullOut }, size: dropping + (dropped?.length ?? 0) })
  const fits = choices.filter(choice => choice.condition.rows.length <= wire.views.maxFilterValues)
  if (!fits.length) return { error: `A filter holds at most ${wire.views.maxFilterValues.toLocaleString('en-US')} values. ${o.unlisted?.truncated ? 'With the values not listed kept as the grid shows them, this names more.' : 'Select fewer, or clear fewer.'}` }
  return { condition: fits.reduce((best, choice) => choice.size < best.size ? choice : best).condition }
}
