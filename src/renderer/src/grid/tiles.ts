import { gridLimits as g } from './constants'
import type { VisibleRange } from './layout'

// A grid reads its result in tiles of 128 rows × 32 columns. A tile is named by one number, its row tile times 128
// plus its column tile (a result has at most 4,096 columns, so at most 128 column tiles).

const columnTiles = 4096 / g.tileColumns
export const tileKey = (rowTile: number, columnTile: number): number => rowTile * columnTiles + columnTile
export const tileRowOf = (key: number): number => Math.floor(key / columnTiles)
export const tileColumnOf = (key: number): number => key % columnTiles

/** The worker window a tile asks for: display text capped at 512 characters, so 4,096 cells always fit the budget. */
export interface TileRequest {
  readonly first: number; readonly count: number; readonly colStart: number; readonly colEnd: number
  readonly maxCellChars: number; readonly textBudget: number; readonly display: true
}
export function tileRequest(key: number, rows: number, columns: number): TileRequest {
  const first = tileRowOf(key) * g.tileRows, colStart = tileColumnOf(key) * g.tileColumns
  return {
    first, count: Math.max(0, Math.min(g.tileRows, rows - first)), colStart, colEnd: Math.min(colStart + g.tileColumns, columns),
    maxCellChars: g.maxCellChars, textBudget: g.textBudget, display: true
  }
}

/** The tiles covering a range, the one at its centre first and then outwards, so the middle of the view paints first. */
export function planTiles(range: VisibleRange, rows: number, columns: number): number[] {
  const lastRow = Math.min(range.lastRow, rows - 1), lastColumn = Math.min(range.lastColumn, columns - 1)
  if (lastRow < range.firstRow || lastColumn < range.firstColumn || range.firstRow < 0 || range.firstColumn < 0) return []
  const r0 = Math.floor(range.firstRow / g.tileRows), r1 = Math.floor(lastRow / g.tileRows)
  const c0 = Math.floor(range.firstColumn / g.tileColumns), c1 = Math.floor(lastColumn / g.tileColumns)
  const rc = Math.floor((range.firstRow + lastRow) / 2 / g.tileRows), cc = Math.floor((range.firstColumn + lastColumn) / 2 / g.tileColumns)
  const tiles: { key: number; distance: number; dr: number; dc: number }[] = []
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) tiles.push({ key: tileKey(r, c), distance: Math.abs(r - rc) + Math.abs(c - cc), dr: Math.abs(r - rc), dc: Math.abs(c - cc) })
  tiles.sort((a, b) => a.distance - b.distance || a.dr - b.dr || a.dc - b.dc || a.key - b.key)
  return tiles.map(tile => tile.key)
}
/** The tiles a frame wants: those of the visible range, plus any others it still needs (the prefetch ring). */
export function wantedSet(...plans: readonly (readonly number[])[]): Set<number> {
  const wanted = new Set<number>()
  for (const plan of plans) for (const key of plan) wanted.add(key)
  return wanted
}
/** The tiles one view above and one below the range (the prefetch ring), nearest first, without the range's own. */
export function prefetchTiles(range: VisibleRange, rows: number, columns: number): number[] {
  const height = range.lastRow - range.firstRow + 1
  if (height <= 0 || range.lastColumn < range.firstColumn) return []
  const own = new Set(planTiles(range, rows, columns))
  return planTiles({ ...range, firstRow: Math.max(0, range.firstRow - height), lastRow: Math.min(rows - 1, range.lastRow + height) }, rows, columns).filter(key => !own.has(key))
}

/** A tile read while its rows were still arriving: it has fewer rows than are available now, so it is read again. */
export function isFrontier(window: { readonly first: number; readonly count: number }, rowsAvailable: number): boolean {
  return window.count < Math.min(g.tileRows, rowsAvailable - window.first)
}
/** Scrolling too fast to read: more than three views of rows moved in one frame. */
export function isFastScroll(rowDelta: number, visibleRows: number): boolean {
  return Math.abs(rowDelta) > g.fastScrollViewports * Math.max(1, visibleRows)
}
