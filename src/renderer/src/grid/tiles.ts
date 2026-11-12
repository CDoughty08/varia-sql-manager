import { gridLimits as g } from './constants'
import type { VisibleRange } from './layout'

// A grid reads its result in tiles of 128 rows × 32 columns. A tile is named by one number, its row tile times 128
// plus its column tile (a result has at most 4,096 columns, so at most 128 column tiles).

const columnTiles = 4096 / g.tileColumns
/** A tile's size. A grid reads tiles of 128 rows × 32 columns (`tableTiles`); a view that spans few rows and many columns
 *  (a transposed grid's) can read the same 4,096 cells as 32 rows × 128 columns. Keys stay unique for any shape at least
 *  `tileColumns` wide: a wider tile only has fewer column tiles. */
export interface TileShape { readonly rows: number; readonly columns: number }
export const tableTiles: TileShape = { rows: g.tileRows, columns: g.tileColumns }
export const tileKey = (rowTile: number, columnTile: number): number => rowTile * columnTiles + columnTile
export const tileRowOf = (key: number): number => Math.floor(key / columnTiles)
export const tileColumnOf = (key: number): number => key % columnTiles

/** The worker window a tile asks for: text capped at 512 characters, so 4,096 cells always fit the budget. The text is
 *  the value's own (`display: false`): GridView makes it one line, marking its white space when asked (whitespace.ts). */
export interface TileRequest {
  readonly first: number; readonly count: number; readonly colStart: number; readonly colEnd: number
  readonly maxCellChars: number; readonly textBudget: number; readonly display: false
}
export function tileRequest(key: number, rows: number, columns: number, shape: TileShape = tableTiles): TileRequest {
  const first = tileRowOf(key) * shape.rows, colStart = tileColumnOf(key) * shape.columns
  return {
    first, count: Math.max(0, Math.min(shape.rows, rows - first)), colStart, colEnd: Math.min(colStart + shape.columns, columns),
    maxCellChars: g.maxCellChars, textBudget: g.textBudget, display: false
  }
}

/** The tiles covering a range, the one at its centre first and then outwards, so the middle of the view paints first. */
export function planTiles(range: VisibleRange, rows: number, columns: number, shape: TileShape = tableTiles): number[] {
  const lastRow = Math.min(range.lastRow, rows - 1), lastColumn = Math.min(range.lastColumn, columns - 1)
  if (lastRow < range.firstRow || lastColumn < range.firstColumn || range.firstRow < 0 || range.firstColumn < 0) return []
  const r0 = Math.floor(range.firstRow / shape.rows), r1 = Math.floor(lastRow / shape.rows)
  const c0 = Math.floor(range.firstColumn / shape.columns), c1 = Math.floor(lastColumn / shape.columns)
  const rc = Math.floor((range.firstRow + lastRow) / 2 / shape.rows), cc = Math.floor((range.firstColumn + lastColumn) / 2 / shape.columns)
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
export function prefetchTiles(range: VisibleRange, rows: number, columns: number, shape: TileShape = tableTiles): number[] {
  const height = range.lastRow - range.firstRow + 1
  if (height <= 0 || range.lastColumn < range.firstColumn) return []
  const own = new Set(planTiles(range, rows, columns, shape))
  return planTiles({ ...range, firstRow: Math.max(0, range.firstRow - height), lastRow: Math.min(rows - 1, range.lastRow + height) }, rows, columns, shape).filter(key => !own.has(key))
}

/** A tile read while its rows were still arriving: it has fewer rows than are available now, so it is read again. */
export function isFrontier(window: { readonly first: number; readonly count: number }, rowsAvailable: number, shape: TileShape = tableTiles): boolean {
  return window.count < Math.min(shape.rows, rowsAvailable - window.first)
}
/** Scrolling too fast to read: more than three views of rows moved in one frame. */
export function isFastScroll(rowDelta: number, visibleRows: number): boolean {
  return Math.abs(rowDelta) > g.fastScrollViewports * Math.max(1, visibleRows)
}
