import type { Platform } from '../../../shared/commands/keybindings'
import type { ColumnRange, CopyPart, DisplayResultSet, RowRange } from '../../../shared/contracts'
import { gridLimits, openEnd } from './constants'
import type { GridAction, GridMove } from './keyboard'

/** A data cell: its row and column index in the result set. */
export interface Cell { readonly row: number; readonly column: number }
/** What a block selects: a rectangle of cells, whole rows, whole columns, or everything. */
export type BlockKind = 'cells' | 'rows' | 'columns' | 'all'
/**
 * One selected rectangle, as SSMS selects them: `anchor` is where it started and `focus` where it was extended to.
 * Whole rows ignore the columns they span, whole columns the rows; `columns` and `all` blocks are open-ended and grow
 * as rows stream in.
 */
export interface SelectionBlock { readonly kind: BlockKind; readonly anchor: Cell; readonly focus: Cell }
/**
 * A grid's selection: 1 to 64 blocks (Ctrl+click adds one; the last is the one Shift extends) and the active cell, which
 * keyboard moves start from and screen readers follow.
 */
export interface GridSelection { readonly resultIndex: number; readonly blocks: readonly SelectionBlock[]; readonly active: Cell }
/** Inclusive bounds; empty when `bottom < top` or `right < left`. */
export interface CellRange { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number }
/** Where a press in the grid lands: a cell, a row's number, a column's header, or the corner above the row numbers. */
export type GridHit = { readonly kind: 'cell'; readonly row: number; readonly column: number } | { readonly kind: 'row'; readonly row: number } | { readonly kind: 'column'; readonly column: number } | { readonly kind: 'corner' }

export const noColumnName = '(No column name)'
/** The longest text a copy writes; results are capped far below it, so reaching it means something is wrong. */
export const maxCopyLength = 8_388_608
export const tooLargeToCopy = 'The selection is too large to copy.'

const origin: Cell = { row: 0, column: 0 }
const emptyRange: CellRange = { top: 0, left: 0, bottom: -1, right: -1 }
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const span = (a: number, b: number, count: number): [number, number] =>
  count <= 0 ? [0, -1] : [clamp(Math.min(a, b), 0, count - 1), clamp(Math.max(a, b), 0, count - 1)]
/** One block's rectangle in a result of `rows` × `columns`, clamped to it. */
export function blockRange(block: SelectionBlock, rows: number, columns: number): CellRange {
  const [top, bottom] = block.kind === 'columns' || block.kind === 'all' ? span(0, rows - 1, rows) : span(block.anchor.row, block.focus.row, rows)
  const [left, right] = block.kind === 'rows' || block.kind === 'all' ? span(0, columns - 1, columns) : span(block.anchor.column, block.focus.column, columns)
  return { top, left, bottom, right }
}
export const isEmptyRange = (range: CellRange): boolean => range.bottom < range.top || range.right < range.left
export const inRange = (range: CellRange, cell: Cell): boolean => cell.row >= range.top && cell.row <= range.bottom && cell.column >= range.left && cell.column <= range.right
/** Every block's rectangle against the rows available now, in selection order, without the empty ones. */
export function resolveBlocks(selection: GridSelection, rows: number, columns: number): CellRange[] {
  return selection.blocks.map(block => blockRange(block, rows, columns)).filter(range => !isEmptyRange(range))
}
/** The last block's rectangle: the one Shift extends, and the one the PR3 results table copies. */
export function rangeOf(selection: GridSelection, rows: number, columns: number): CellRange {
  const last = selection.blocks.at(-1)
  return last ? blockRange(last, rows, columns) : emptyRange
}
/**
 * The blocks clipped to a window of cells (a frame's rendered rows and columns): at most 64 rectangles, so a frame tests
 * each cell it paints with `covered` in O(blocks), without allocating.
 */
export function windowRanges(selection: GridSelection, rows: number, columns: number, window: CellRange): CellRange[] {
  const clipped: CellRange[] = []
  for (const range of resolveBlocks(selection, rows, columns)) {
    const top = Math.max(range.top, window.top), bottom = Math.min(range.bottom, window.bottom), left = Math.max(range.left, window.left), right = Math.min(range.right, window.right)
    if (top <= bottom && left <= right) clipped.push({ top, left, bottom, right })
  }
  return clipped
}
export function covered(ranges: readonly CellRange[], row: number, column: number): boolean {
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    if (row >= range.top && row <= range.bottom && column >= range.left && column <= range.right) return true
  }
  return false
}
export function contains(selection: GridSelection, row: number, column: number, rows: number, columns: number): boolean {
  if (row < 0 || row >= rows || column < 0 || column >= columns) return false
  return selection.blocks.some(block => inRange(blockRange(block, rows, columns), { row, column }))
}

/** A cell as copied: NULL for null, and line breaks and tabs as spaces, so each cell stays one TSV field. */
export function cellText(value: unknown): string {
  return value === null || value === undefined ? 'NULL' : String(value).replace(/\r\n|[\r\n\t]/g, ' ')
}
/** A column header as shown and copied; SQL Server names computed columns with nothing. */
export const columnTitle = (name: string): string => name ? cellText(name) : noColumnName

/**
 * The last block's cells as tab-separated text, one line per row with no line break after the last, optionally after
 * a line of column headers. Throws a RangeError rather than build text over `maxCopyLength`.
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

const single = (resultIndex: number, kind: BlockKind, cell: Cell): GridSelection => ({ resultIndex, blocks: [{ kind, anchor: cell, focus: cell }], active: cell })
/** Everything, as one open-ended block; the active cell stays where it was. */
export const selectAll = (resultIndex: number, active: Cell = origin): GridSelection => ({ resultIndex, blocks: [{ kind: 'all', anchor: active, focus: active }], active })
const kindOf = (hit: GridHit): BlockKind => hit.kind === 'cell' ? 'cells' : hit.kind === 'row' ? 'rows' : hit.kind === 'column' ? 'columns' : 'all'
// A row number makes its first cell active and a column header its top cell, as in SSMS.
const cellOf = (hit: GridHit, from: Cell): Cell => ({ row: 'row' in hit ? hit.row : hit.kind === 'column' ? 0 : from.row, column: 'column' in hit ? hit.column : hit.kind === 'row' ? 0 : from.column })
const validFor = (selection: GridSelection | undefined, resultIndex: number) => selection?.resultIndex === resultIndex && selection.blocks.length > 0 ? selection : undefined

/**
 * The selection after a left press on `hit`: the press selects that cell, row, column, or (the corner) everything;
 * `extend` (Shift) moves the last block's far corner there, taking the kind of what was pressed; `add` (Ctrl, ⌘)
 * adds a block, dropping the oldest past 64. A selection in another result set counts as none.
 */
export function select(current: GridSelection | undefined, hit: GridHit, options: { readonly resultIndex: number; readonly extend: boolean; readonly add: boolean }): GridSelection {
  const { resultIndex } = options
  const valid = validFor(current, resultIndex)
  if (hit.kind === 'corner') return selectAll(resultIndex, valid?.active)
  if (options.extend && valid) {
    const last = valid.blocks[valid.blocks.length - 1], focus = cellOf(hit, last.focus)
    return { resultIndex, blocks: [...valid.blocks.slice(0, -1), { kind: kindOf(hit), anchor: last.anchor, focus }], active: focus }
  }
  const cell = cellOf(hit, origin)
  if (options.add && valid) return { resultIndex, blocks: [...valid.blocks, { kind: kindOf(hit), anchor: cell, focus: cell }].slice(-gridLimits.selectionBlocks), active: cell }
  return single(resultIndex, kindOf(hit), cell)
}

/** Whether `hit` is already selected by some block: the cell, or the whole row, column, or grid. */
function covers(selection: GridSelection, hit: GridHit, rows: number, columns: number): boolean {
  return resolveBlocks(selection, rows, columns).some(range => {
    const allRows = range.top === 0 && range.bottom === rows - 1, allColumns = range.left === 0 && range.right === columns - 1
    switch (hit.kind) {
      case 'cell': return inRange(range, hit)
      case 'row': return allColumns && hit.row >= range.top && hit.row <= range.bottom
      case 'column': return allRows && hit.column >= range.left && hit.column <= range.right
      case 'corner': return allRows && allColumns
    }
  })
}

/**
 * What a pointer press is to the grid. On macOS Control+click opens the context menu (Chromium does so on that press,
 * which reports the left button), so it is a right press there, as Monaco treats it; other buttons do nothing.
 */
export function pressButton(event: { readonly button: number; readonly ctrlKey: boolean }, platform: Platform): 'primary' | 'secondary' | undefined {
  if (event.button === 2 || (event.button === 0 && event.ctrlKey && platform === 'darwin')) return 'secondary'
  return event.button === 0 ? 'primary' : undefined
}
/**
 * The selection after a press on `hit`, as in SSMS: a left press selects as `select` does (Shift extends, `add` adds a
 * block); a right press on something already selected keeps the selection (its menu acts on it), and elsewhere selects
 * like a plain left press.
 */
export function pressSelection(current: GridSelection | undefined, hit: GridHit, options: { readonly resultIndex: number; readonly shift: boolean; readonly right: boolean; readonly add?: boolean; readonly rows: number; readonly columns: number }): GridSelection {
  const valid = validFor(current, options.resultIndex)
  if (options.right && valid && covers(valid, hit, options.rows, options.columns)) return valid
  return select(current, hit, { resultIndex: options.resultIndex, extend: options.shift && !options.right, add: !!options.add && !options.right })
}
/** Dragging over `hit` moves the last block's far corner there, keeping what it selects (cells, rows, or columns). */
export function dragSelection(selection: GridSelection, hit: GridHit): GridSelection {
  const last = selection.blocks.at(-1)
  if (!last || last.kind === 'all' || hit.kind === 'corner') return selection
  const focus = { row: last.kind === 'columns' || !('row' in hit) ? last.focus.row : hit.row, column: last.kind === 'rows' || !('column' in hit) ? last.focus.column : hit.column }
  if (focus.row === last.focus.row && focus.column === last.focus.column) return selection
  return { ...selection, blocks: [...selection.blocks.slice(0, -1), { ...last, focus }], active: focus }
}

function moved(from: Cell, move: GridMove, o: { readonly rows: number; readonly columns: number; readonly pageRows: number }): Cell {
  const lastRow = o.rows - 1, lastColumn = o.columns - 1
  const at = (row: number, column: number): Cell => ({ row: clamp(row, 0, lastRow), column: clamp(column, 0, lastColumn) })
  switch (move) {
    case 'up': return at(from.row - 1, from.column)
    case 'down': return at(from.row + 1, from.column)
    case 'left': return at(from.row, from.column - 1)
    case 'right': return at(from.row, from.column + 1)
    case 'pageUp': return at(from.row - Math.max(1, o.pageRows), from.column)
    case 'pageDown': return at(from.row + Math.max(1, o.pageRows), from.column)
    case 'firstRow': return at(0, from.column)
    case 'lastRow': return at(lastRow, from.column)
    case 'firstColumn': return at(from.row, 0)
    case 'lastColumn': return at(from.row, lastColumn)
    case 'firstCell': return at(0, 0)
    case 'lastCell': return at(lastRow, lastColumn)
  }
}
const sameCell = (a: Cell, b: Cell) => a.row === b.row && a.column === b.column

/**
 * The selection after a grid key (keyboard.ts). Moves start from the active cell and collapse the selection to it;
 * extending moves the last block's far corner (from the active cell when everything is selected). Moves stop at the
 * edges of the rows available now. `pageRows` is the PageUp/PageDown step. Returns `selection` itself when nothing changes.
 */
export function navigate(selection: GridSelection, action: GridAction, o: { readonly rows: number; readonly columns: number; readonly pageRows: number }): GridSelection {
  const { rows, columns } = o
  if (rows <= 0 || columns <= 0) return selection
  const { resultIndex } = selection
  const active: Cell = { row: clamp(selection.active.row, 0, rows - 1), column: clamp(selection.active.column, 0, columns - 1) }
  const last = selection.blocks.at(-1)
  switch (action.type) {
    case 'selectAll': return selectAll(resultIndex, active)
    case 'selectRows': case 'selectColumns': {
      const block = last ?? { kind: 'cells', anchor: active, focus: active }
      const range = blockRange(block, rows, columns)
      if (isEmptyRange(range)) return selection
      const rowsOnly = action.type === 'selectRows'
      // Over the block's span, keeping its direction; a block that already spans every row (or column) spans them all.
      const allRows = block.kind === 'columns' || block.kind === 'all', allColumns = block.kind === 'rows' || block.kind === 'all'
      const anchor = rowsOnly ? { row: allRows ? range.top : clamp(block.anchor.row, 0, rows - 1), column: active.column } : { row: active.row, column: allColumns ? range.left : clamp(block.anchor.column, 0, columns - 1) }
      const focus = rowsOnly ? { row: allRows ? range.bottom : clamp(block.focus.row, 0, rows - 1), column: active.column } : { row: active.row, column: allColumns ? range.right : clamp(block.focus.column, 0, columns - 1) }
      return { resultIndex, blocks: [...selection.blocks.slice(0, -1), { kind: rowsOnly ? 'rows' : 'columns', anchor, focus }], active }
    }
    case 'move': {
      if (!action.extend || !last) {
        const to = moved(active, action.move, o)
        const already = selection.blocks.length === 1 && last?.kind === 'cells' && sameCell(last.anchor, to) && sameCell(last.focus, to) && sameCell(selection.active, to)
        return already ? selection : single(resultIndex, 'cells', to)
      }
      const block = last.kind === 'all' ? { kind: 'cells' as const, anchor: active, focus: active } : last
      const from = { row: clamp(block.focus.row, 0, rows - 1), column: clamp(block.focus.column, 0, columns - 1) }
      const to = moved(from, action.move, o)
      if (last.kind !== 'all' && sameCell(to, last.focus) && sameCell(selection.active, to)) return selection
      return { resultIndex, blocks: [...selection.blocks.slice(0, -1), { ...block, focus: to }], active: to }
    }
    default: return selection
  }
}

/** Sorted, with overlapping and adjacent ranges merged. */
function union<T extends readonly [number, number]>(ranges: readonly T[]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [first, last] of sorted) {
    const tail = merged.at(-1)
    if (tail && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last)
    else merged.push([first, last])
  }
  return merged
}
/**
 * What a copy of the selection asks the backend for. Blocks that share their columns become one part with the union
 * of their rows; blocks that share their rows, one part with the union of their columns (Ctrl+click on columns A and
 * C copies them side by side); otherwise each block is a part, in selection order. Whole columns and everything run to
 * the end of the result (`openEnd`), which the backend clamps to the rows available when the copy starts.
 */
export function copyPlan(selection: GridSelection, columns: number): CopyPart[] {
  if (columns <= 0) return []
  const spans = selection.blocks.map(block => {
    const allRows = block.kind === 'columns' || block.kind === 'all', allColumns = block.kind === 'rows' || block.kind === 'all'
    const rows: RowRange = allRows ? [0, openEnd] : [Math.max(0, Math.min(block.anchor.row, block.focus.row)), Math.max(0, block.anchor.row, block.focus.row)]
    const cols: ColumnRange = allColumns ? [0, columns - 1] : [clamp(Math.min(block.anchor.column, block.focus.column), 0, columns - 1), clamp(Math.max(block.anchor.column, block.focus.column), 0, columns - 1)]
    return { rows, columns: cols }
  })
  if (spans.length === 0) return []
  const sameAs = (pick: (span: typeof spans[number]) => readonly [number, number]) => spans.every(span => pick(span)[0] === pick(spans[0])[0] && pick(span)[1] === pick(spans[0])[1])
  if (sameAs(span => span.columns)) return [{ rows: union(spans.map(span => span.rows)), columns: [spans[0].columns] }]
  if (sameAs(span => span.rows)) return [{ rows: [spans[0].rows], columns: union(spans.map(span => span.columns)) }]
  return spans.map(span => ({ rows: [span.rows], columns: [span.columns] }))
}

/** What a screen reader hears after the selection changes. */
export function describeRange(range: CellRange): string {
  if (isEmptyRange(range)) return 'No cells selected'
  const rows = range.bottom - range.top + 1, columns = range.right - range.left + 1
  return `${rows} ${rows === 1 ? 'row' : 'rows'}, ${columns} ${columns === 1 ? 'column' : 'columns'} selected`
}
/** The cells the rectangles cover together, each counted once: a sweep over column slabs, O(k² log k) for k ≤ 64. */
function unionCells(ranges: readonly CellRange[]): number {
  const edges = [...new Set(ranges.flatMap(range => [range.left, range.right + 1]))].sort((a, b) => a - b)
  let total = 0
  for (let index = 0; index < edges.length - 1; index++) {
    const from = edges[index], to = edges[index + 1]
    const covered = union(ranges.filter(range => range.left <= from && range.right + 1 >= to).map(range => [range.top, range.bottom] as const))
    for (const [top, bottom] of covered) total += (bottom - top + 1) * (to - from)
  }
  return total
}
/** The live region's sentence: one block as `describeRange` says it, several as "{k} ranges selected, {c} cells". */
export function describeSelection(selection: GridSelection, rows: number, columns: number): string {
  const ranges = resolveBlocks(selection, rows, columns)
  if (ranges.length <= 1) return describeRange(ranges[0] ?? emptyRange)
  return `${ranges.length} ranges selected, ${unionCells(ranges)} cells`
}
