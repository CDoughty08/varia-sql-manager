// A local table's column filters (LocalGrid's `filterable`): the header funnel's popover over the table's own values, and
// value filters kept by column and applied in memory, as an Activity Monitor pane's are in the backend (ActivityFilter.cs's
// Matches, mirrored here). The rows are the renderer's already (docs/architecture.md, Grid): nothing is read again.
import type { LiveFacet } from '../../../shared/live/schema'
import type { LocalCell, LocalTableData } from '../../../shared/results/local-table'
import type { ColumnFilterSource } from '../results/ColumnFilterPopover'
import { liveFilterSource, type LiveValueFilter } from '../live/live-filter'

/** A table's value filters by column index. */
export type LocalFilters = ReadonlyMap<number, LiveValueFilter>
export const noFilters: LocalFilters = new Map()

/** Whether a cell passes a column's value filter: a blank (NULL or empty) cell passes only with (Blanks), another value when
 *  it is named (or, with `exclude`, when it is not), or with (Non-blanks). */
export function cellPasses(cell: LocalCell, filter: LiveValueFilter): boolean {
  if (cell === null || cell === '') return !!filter.blanks
  return filter.exclude ? !filter.values?.includes(cell) : !!filter.nonBlanks || !!filter.values?.includes(cell)
}
const rowPasses = (row: readonly LocalCell[], filters: LocalFilters, except?: number): boolean => {
  for (const [column, filter] of filters) if (column !== except && !cellPasses(row[column] ?? null, filter)) return false
  return true
}

/** The indexes of the table's rows every filter keeps, in table order, or undefined when nothing filters. */
export function keptRows(table: LocalTableData, filters: LocalFilters): number[] | undefined {
  if (filters.size === 0) return undefined
  const kept: number[] = []
  table.rows.forEach((row, index) => { if (rowPasses(row, filters)) kept.push(index) })
  return kept
}

/** A column's values and counts over the rows the other columns' filters keep (blank text is (Blanks)), so the popover lists
 *  what the grid can show and a column's own filter never empties its list. */
export function localFacet(table: LocalTableData, column: number, filters: LocalFilters): LiveFacet {
  const counts = new Map<string, number>()
  for (const row of table.rows) {
    if (!rowPasses(row, filters, column)) continue
    const text = row[column] ?? ''
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return { column: String(column), values: [...counts].map(([text, count]) => ({ text, count })) }
}

/** The most values one column's filter names; a local table holds at most localTableLimits.rows distinct ones. */
const maxValues = 10_000

/** The funnel source for a local table: its values from `table()` and `filters()` as they are when the popover opens, and OK
 *  hands `apply` the column's new filter (undefined: none). */
export function localFilterSource(o: { table(): LocalTableData; filters(): LocalFilters; apply(column: number, filter: LiveValueFilter | undefined): void }): ColumnFilterSource {
  const live = liveFilterSource({
    columnId: column => column >= 0 && column < o.table().columns.length ? String(column) : undefined,
    facet: id => localFacet(o.table(), Number(id), o.filters()),
    filterOf: id => o.filters().get(Number(id)),
    apply: (id, filter) => o.apply(Number(id), filter),
    maxValues
  })
  return { ...live, note: () => undefined }
}

/** The filters with one column's set or taken off. */
export function withFilter(filters: LocalFilters, column: number, filter: LiveValueFilter | undefined): LocalFilters {
  const next = new Map(filters)
  if (filter) next.set(column, filter)
  else next.delete(column)
  return next
}
