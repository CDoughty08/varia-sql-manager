import type { ResultColumn, ResultDescriptor } from '../../../shared/contracts'

/**
 * The column roles that are not data: a row's tone (a live table's or a diff's) and a diff's hidden suffix: previous
 * values (`old`), the change marker (`mark`) and each input's row number (`leftRow`, `rightRow`); and a live table's
 * identity columns (`hidden`), which its owner's row actions read but nothing shows. They always come last,
 * so a result's visible columns are a prefix and visible indexes equal descriptor indexes. The backend's
 * ResultTextWriter.Hidden tests the same set; `xml`, `json`, `plan`, `udt` and `vector` columns are data.
 */
export const hiddenRoles: ReadonlySet<string> = new Set(['old', 'mark', 'leftRow', 'rightRow', 'tone', 'hidden'])

/** Whether a column is hidden: never drawn, copied, searched, sorted, filtered or profiled. */
export const isHiddenColumn = (column: Pick<ResultColumn, 'role'> | undefined): boolean => !!column?.role && hiddenRoles.has(column.role)

/** The visible columns' count: the index of the first column of the hidden suffix (the columns' length when there is
 *  none, or when every column would be hidden). */
export function visibleColumnCount(descriptor: Pick<ResultDescriptor, 'columns'>): number {
  const columns = descriptor.columns
  let first = columns.length
  while (first > 0 && isHiddenColumn(columns[first - 1])) first--
  return first === 0 ? columns.length : first
}

/** A comparison's (kind `diff`) hidden suffix columns by role, -1 for a role it lacks. `old` is the first previous-value
 *  column (one row per entry: pair c's old value is at `old + c`), -1 in two rows. */
export interface DiffSuffix { readonly old: number; readonly mark: number; readonly leftRow: number; readonly rightRow: number; readonly tone: number }

/** The diff suffix of a result of kind `diff`, or undefined for any other result. */
export function diffSuffixOf(descriptor: Pick<ResultDescriptor, 'columns' | 'kind'>): DiffSuffix | undefined {
  if (descriptor.kind !== 'diff') return undefined
  const at = (role: ResultColumn['role']): number => descriptor.columns.findIndex(column => column.role === role)
  const suffix = { old: at('old'), mark: at('mark'), leftRow: at('leftRow'), rightRow: at('rightRow'), tone: at('tone') }
  return suffix.mark >= 0 && suffix.leftRow >= 0 && suffix.rightRow >= 0 ? suffix : undefined
}
