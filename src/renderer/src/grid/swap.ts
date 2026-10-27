import { gridLimits as g } from './constants'
import { topRowOf } from './scroll'
import type { Cell, GridSelection, SelectionBlock } from './selection'

// A live grid (LiveGrid) swaps the result it shows for each new revision of its table, and the user keeps their place on
// the same rows: the selection stays index-based (selection.ts), and only a swap moves it, through where each old row
// went in the new revision.

/** Where a row of the old revision is in the new one: its index, or -1 when it is gone. `known`, when the map has it, tells
 *  a row whose place it knows from one it only keeps at its index, not knowing where it went. */
export type RowMap = ((oldRow: number) => number) & { readonly known?: (oldRow: number) => boolean }

const clampRow = (row: number, rows: number) => Math.max(0, Math.min(row, rows - 1))

/**
 * The active row's place after a swap: where it went; when it is gone, where the nearest old row that survived went
 * (below first, then above, at most 64 rows away), so the selection stays among the rows the user was looking at; else
 * its old index, within the new rows. Rows whose place the map does not know (`known`) are passed over: kept at their old
 * index, they would land the selection on whatever row now sits there.
 */
export function survivingRow(oldRow: number, mapRow: RowMap, rows: number): number {
  if (rows <= 0) return 0
  const direct = mapRow(oldRow)
  if (direct >= 0) return clampRow(direct, rows)
  const place = (row: number) => mapRow.known && !mapRow.known(row) ? -1 : mapRow(row)
  for (let step = 1; step <= g.swapSearchRows; step++) {
    const below = place(oldRow + step)
    if (below >= 0) return clampRow(below, rows)
    if (oldRow - step < 0) continue
    const above = place(oldRow - step)
    if (above >= 0) return clampRow(above, rows)
  }
  return clampRow(oldRow, rows)
}

const sameBlock = (a: SelectionBlock, b: SelectionBlock) => a.kind === b.kind && a.anchor.row === b.anchor.row && a.anchor.column === b.anchor.column && a.focus.row === b.focus.row && a.focus.column === b.focus.column
/** Whether two selections select the same cells with the same active cell (a swap tells the grid's owner only of a change). */
export function sameSelection(a: GridSelection | undefined, b: GridSelection | undefined): boolean {
  if (!a || !b) return a === b
  return a.resultIndex === b.resultIndex && a.active.row === b.active.row && a.active.column === b.active.column && a.blocks.length === b.blocks.length && a.blocks.every((block, index) => sameBlock(block, b.blocks[index]))
}

/**
 * The selection over the new revision: the active cell moves with its row (survivingRow); a block of cells or rows moves
 * its anchor and focus with theirs, and collapses to the active cell when either row is gone; whole columns and
 * everything stay whole. Undefined when the new revision has no rows (the grid selects its first cell once rows come).
 */
export function remapSelection(selection: GridSelection | undefined, mapRow: RowMap, rows: number, columns: number): GridSelection | undefined {
  if (!selection || rows <= 0 || columns <= 0) return undefined
  const column = (cell: Cell) => Math.max(0, Math.min(cell.column, columns - 1))
  const active: Cell = { row: survivingRow(selection.active.row, mapRow, rows), column: column(selection.active) }
  const blocks: SelectionBlock[] = []
  for (const block of selection.blocks) {
    let next: SelectionBlock
    if (block.kind === 'columns' || block.kind === 'all') {
      // Every row stays selected; the corners only say where a later Shift move starts, so they follow the active row.
      next = { kind: block.kind, anchor: { row: active.row, column: column(block.anchor) }, focus: { row: active.row, column: column(block.focus) } }
    } else {
      const anchor = mapRow(block.anchor.row), focus = mapRow(block.focus.row)
      next = anchor < 0 || focus < 0
        ? { kind: 'cells', anchor: active, focus: active }
        : { kind: block.kind, anchor: { row: clampRow(anchor, rows), column: column(block.anchor) }, focus: { row: clampRow(focus, rows), column: column(block.focus) } }
    }
    if (!blocks.some(kept => sameBlock(kept, next))) blocks.push(next)
  }
  return { resultIndex: selection.resultIndex, blocks: blocks.length > 0 ? blocks : [{ kind: 'cells', anchor: active, focus: active }], active }
}

/**
 * The scroll offset over the new revision: the first row shown stays first, at the same pixel offset, wherever it went.
 * A view at the very top stays at the top (rows that arrive above are seen, as at the end of a log), and a first row
 * that is gone keeps the offset.
 */
export function remapTop(virtualTop: number, mapRow: RowMap): number {
  if (virtualTop <= 0) return 0
  const top = topRowOf(virtualTop), mapped = mapRow(top)
  return mapped >= 0 ? mapped * g.rowHeight + (virtualTop - top * g.rowHeight) : virtualTop
}
