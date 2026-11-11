// A grid's sort keys, as the results grid's header and Sort menu change them: one function for every source (a query's
// view, ResultsService; a live table's probe sort, LiveGrid), so their headers cycle and their Then Sort adds alike.

export type SortDirection = 'ascending' | 'descending' | 'none'
export interface SortKeyLike<C> { readonly column: C; readonly descending: boolean }

/**
 * Sort (`add` false): the column alone, or no key for `none`. Then Sort (`add`): the column becomes the last key, or leaves
 * the keys for `none`. At most `max` keys: the oldest go first, so the key just chosen always counts.
 */
export function sortKeysBy<C, K extends SortKeyLike<C>>(keys: readonly K[], column: C, direction: SortDirection, add: boolean, max: number, make: (descending: boolean) => K): K[] {
  const next = add ? keys.filter(key => key.column !== column) : []
  if (direction !== 'none') next.push(make(direction === 'descending'))
  return next.slice(-max)
}

/**
 * A header's sort button: ascending, then descending, then out of the sort. Without `add` only the sole key cycles and any
 * other click sorts by the column alone, ascending; with `add` the column changes in place among the keys (a new one goes
 * last, as Then Sort Ascending).
 */
export function cycleSortKeys<C, K extends SortKeyLike<C>>(keys: readonly K[], column: C, add: boolean, max: number, make: (descending: boolean) => K): K[] {
  const current = keys.find(key => key.column === column)
  const cycles = add || keys.length === 1
  const next: SortDirection = !current || !cycles ? 'ascending' : current.descending ? 'none' : 'descending'
  if (!add || !current) return sortKeysBy(keys, column, next, add, max, make)
  return next === 'none' ? keys.filter(key => key.column !== column) : keys.map(key => key.column === column ? { ...key, descending: true } : key)
}
