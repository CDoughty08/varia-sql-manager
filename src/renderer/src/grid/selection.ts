import type { DisplayResultSet } from '../../../shared/contracts'

/** A data cell: its row and column index in the result set. */
export interface Cell { readonly row: number; readonly column: number }
/**
 * A rectangle of cells, as SSMS selects them: `anchor` is where the selection started and `focus` where it ends (the
 * active cell). Whole rows, whole columns, and everything ignore the coordinates they span.
 */
export interface GridSelection { readonly resultIndex: number; readonly anchor: Cell; readonly focus: Cell; readonly mode: 'cells' | 'rows' | 'columns' | 'all' }
/** Inclusive bounds; empty when `bottom < top` or `right < left`. */
export interface CellRange { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number }
/** Where a press in the grid lands: a cell, a row's number, a column's header, or the corner above the row numbers. */
export type GridHit = { readonly kind: 'cell'; readonly row: number; readonly column: number } | { readonly kind: 'row'; readonly row: number } | { readonly kind: 'column'; readonly column: number } | { readonly kind: 'corner' }

export const noColumnName = '(No column name)'
/** The longest text a copy writes; results are capped far below it, so reaching it means something is wrong. */
export const maxCopyLength = 8_388_608
export const tooLargeToCopy = 'The selection is too large to copy.'

const span = (a: number, b: number, count: number): [number, number] =>
  count <= 0 ? [0, -1] : [Math.min(Math.max(Math.min(a, b), 0), count - 1), Math.min(Math.max(Math.max(a, b), 0), count - 1)]
/** The selected rectangle in a result of `rows` × `columns`, clamped to it. */
export function rangeOf(selection: GridSelection, rows: number, columns: number): CellRange {
  const [top, bottom] = selection.mode === 'columns' || selection.mode === 'all' ? span(0, rows - 1, rows) : span(selection.anchor.row, selection.focus.row, rows)
  const [left, right] = selection.mode === 'rows' || selection.mode === 'all' ? span(0, columns - 1, columns) : span(selection.anchor.column, selection.focus.column, columns)
  return { top, left, bottom, right }
}
export const isEmptyRange = (range: CellRange): boolean => range.bottom < range.top || range.right < range.left
export const inRange = (range: CellRange, cell: Cell): boolean => cell.row >= range.top && cell.row <= range.bottom && cell.column >= range.left && cell.column <= range.right

/** A cell as copied: NULL for null, and line breaks and tabs as spaces, so each cell stays one TSV field. */
export function cellText(value: unknown): string {
  return value === null || value === undefined ? 'NULL' : String(value).replace(/\r\n|[\r\n\t]/g, ' ')
}
/** A column header as shown and copied; SQL Server names computed columns with nothing. */
export const columnTitle = (name: string): string => name ? cellText(name) : noColumnName

/**
 * The selected cells as tab-separated text, one line per row with no line break after the last, optionally after a
 * line of column headers. Throws a RangeError rather than build text over `maxCopyLength`.
 */
export function toTsv(set: Pick<DisplayResultSet, 'columns' | 'rows'>, selection: GridSelection, options: { readonly headers: boolean; readonly eol: '\r\n' | '\n' }): string {
  const range = rangeOf(selection, set.rows.length, set.columns.length)
  if (range.right < range.left) return ''
  const columns = Array.from({ length: range.right - range.left + 1 }, (_, index) => range.left + index)
  const lines: string[] = []
  let length = 0
  const add = (line: string) => {
    length += line.length + (lines.length ? options.eol.length : 0)
    if (length > maxCopyLength) throw new RangeError(tooLargeToCopy)
    lines.push(line)
  }
  if (options.headers) add(columns.map(column => columnTitle(set.columns[column].name)).join('\t'))
  for (let row = range.top; row <= range.bottom; row++) { const values = set.rows[row]; add(columns.map(column => cellText(values[column])).join('\t')) }
  return lines.join(options.eol)
}

export const selectAll = (resultIndex: number): GridSelection => ({ resultIndex, anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 }, mode: 'all' })
const modeOf = (hit: GridHit): GridSelection['mode'] => hit.kind === 'cell' ? 'cells' : hit.kind === 'row' ? 'rows' : hit.kind === 'column' ? 'columns' : 'all'
const cellOf = (hit: GridHit, from: Cell): Cell => ({ row: 'row' in hit ? hit.row : hit.kind === 'column' ? 0 : from.row, column: 'column' in hit ? hit.column : hit.kind === 'row' ? 0 : from.column })
/** Whether `hit` is already selected: the cell, or the whole row, column, or grid. */
function covers(selection: GridSelection, hit: GridHit, rows: number, columns: number): boolean {
  const range = rangeOf(selection, rows, columns)
  if (isEmptyRange(range)) return false
  const allRows = range.top === 0 && range.bottom === rows - 1, allColumns = range.left === 0 && range.right === columns - 1
  switch (hit.kind) {
    case 'cell': return inRange(range, hit)
    case 'row': return allColumns && hit.row >= range.top && hit.row <= range.bottom
    case 'column': return allRows && hit.column >= range.left && hit.column <= range.right
    case 'corner': return allRows && allColumns
  }
}

/**
 * The selection after a press on `hit`, as in SSMS: a press selects that cell, row, column, or everything; Shift extends
 * the current selection from its anchor; a right press on something already selected keeps the selection (its menu
 * acts on it), and elsewhere selects like a left press.
 */
export function pressSelection(current: GridSelection | undefined, hit: GridHit, options: { readonly resultIndex: number; readonly shift: boolean; readonly right: boolean; readonly rows: number; readonly columns: number }): GridSelection {
  const { resultIndex } = options
  const valid = current?.resultIndex === resultIndex ? current : undefined
  if (options.right && valid && covers(valid, hit, options.rows, options.columns)) return valid
  if (hit.kind === 'corner') return selectAll(resultIndex)
  if (options.shift && !options.right && valid) return { resultIndex, anchor: valid.anchor, focus: cellOf(hit, valid.focus), mode: modeOf(hit) }
  const cell = cellOf(hit, { row: 0, column: 0 })
  return { resultIndex, anchor: cell, focus: cell, mode: modeOf(hit) }
}
/** Dragging over `hit` moves the selection's far corner there, keeping what it selects (cells, rows, or columns). */
export function dragSelection(selection: GridSelection, hit: GridHit): GridSelection {
  if (selection.mode === 'all' || hit.kind === 'corner') return selection
  const focus = { row: selection.mode === 'columns' || !('row' in hit) ? selection.focus.row : hit.row, column: selection.mode === 'rows' || !('column' in hit) ? selection.focus.column : hit.column }
  return focus.row === selection.focus.row && focus.column === selection.focus.column ? selection : { ...selection, focus }
}

/** What a screen reader hears after the selection changes. */
export function describeRange(range: CellRange): string {
  if (isEmptyRange(range)) return 'No cells selected'
  const rows = range.bottom - range.top + 1, columns = range.right - range.left + 1
  return `${rows} ${rows === 1 ? 'row' : 'rows'}, ${columns} ${columns === 1 ? 'column' : 'columns'} selected`
}
