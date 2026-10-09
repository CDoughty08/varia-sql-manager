import { gridLimits as g } from './constants'
import type { GridHit } from './selection'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * Column widths and their running offsets. The widths array belongs to the grid's saved state (it outlives the view);
 * offsets are kept as prefix sums, so finding a column's position is O(1) and the column at a position O(log columns).
 * The sum of all widths never exceeds `maxTotal` (the scroll cap less the row header), so the spacer stays under
 * Chromium's layout limit; a resize can always shrink a column but cannot grow one past that sum.
 */
export class ColumnLayout {
  readonly count: number
  private readonly starts: Float64Array
  private maxTotal: number

  constructor(readonly widths: Float64Array, maxTotal: number) {
    this.count = widths.length
    this.starts = new Float64Array(widths.length + 1)
    this.maxTotal = Math.max(0, maxTotal)
    let total = 0
    for (let column = 0; column < widths.length; column++) {
      const remaining = widths.length - column - 1
      // Leave every later column at least its minimum, whatever the earlier ones asked for.
      const room = this.maxTotal - total - remaining * g.columnMinWidth
      widths[column] = clamp(Math.round(Number.isFinite(widths[column]) ? widths[column] : g.columnMinWidth), g.columnMinWidth, Math.max(g.columnMinWidth, Math.min(g.columnMaxWidth, room)))
      total += widths[column]
      this.starts[column + 1] = total
    }
  }
  /** The width of every column together. */
  get total(): number { return this.starts[this.count] }
  width(column: number): number { return this.widths[column] }
  /** The left edge of `column` from the first column's left edge; `xOf(count)` is the total width. */
  xOf(column: number): number { return this.starts[clamp(column, 0, this.count)] }
  /** The column under `x` (from the first column's left edge): −1 left of it and `count` past the last one. */
  columnAt(x: number): number {
    if (x < 0 || this.count === 0) return -1
    if (x >= this.total) return this.count
    let low = 0, high = this.count - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.starts[middle] <= x) low = middle
      else high = middle - 1
    }
    return low
  }
  /** Sets one column's width within [32, 3,000] and the width-sum cap, updating the offsets after it; returns the width set. */
  setWidth(column: number, width: number): number {
    const old = this.widths[column]
    let next = clamp(Math.round(width), g.columnMinWidth, g.columnMaxWidth)
    if (next > old) next = Math.max(old, Math.min(next, old + this.maxTotal - this.total))
    if (next === old) return old
    this.widths[column] = next
    for (let index = column + 1; index <= this.count; index++) this.starts[index] = this.starts[index - 1] + this.widths[index - 1]
    return next
  }
  /** A new cap (the scroll cap changed with the display's pixel ratio). Widths already set are kept; growth stops at it. */
  setMaxTotal(maxTotal: number): void { this.maxTotal = Math.max(0, maxTotal) }
}

/** The row header fits the widest row number, at least 9,999, so it widens only when the row count reaches a power of 10. */
export function rowHeaderWidth(rows: number, charWidth: number): number {
  const digits = String(Math.max(Math.floor(rows), g.rowHeaderMinRows)).length
  return Math.max(g.rowHeaderMinWidth, Math.ceil(digits * charWidth) + g.cellChrome)
}

/** The scroller's viewport: its scroll offsets (`top` is the virtual offset in Mode B) and client size, headers included. */
export interface Viewport { readonly top: number; readonly left: number; readonly width: number; readonly height: number }
/** Inclusive cell bounds; empty when `lastRow < firstRow` or `lastColumn < firstColumn`. */
export interface VisibleRange { readonly firstRow: number; readonly lastRow: number; readonly firstColumn: number; readonly lastColumn: number }

/**
 * The rows and columns a frame renders: those under the body (below the sticky header row and right of the sticky row
 * header), widened by the overscan and clamped to the result.
 */
export function visibleRange(viewport: Viewport, rows: number, layout: ColumnLayout, rowHeader: number, overscan: { readonly rows: number; readonly columns: number } = { rows: g.overscanRows, columns: g.overscanColumns }): VisibleRange {
  const bodyHeight = viewport.height - g.headerHeight, bodyWidth = viewport.width - rowHeader
  if (rows <= 0 || layout.count === 0 || bodyHeight <= 0 || bodyWidth <= 0) return { firstRow: 0, lastRow: -1, firstColumn: 0, lastColumn: -1 }
  const top = Math.max(0, viewport.top), left = Math.max(0, viewport.left)
  const firstRow = Math.min(rows - 1, Math.floor(top / g.rowHeight)), lastRow = Math.min(rows - 1, Math.floor((top + bodyHeight - 1) / g.rowHeight))
  const firstColumn = clamp(layout.columnAt(left), 0, layout.count - 1), lastColumn = clamp(layout.columnAt(left + bodyWidth - 1), 0, layout.count - 1)
  return {
    firstRow: Math.max(0, firstRow - overscan.rows), lastRow: Math.min(rows - 1, lastRow + overscan.rows),
    firstColumn: Math.max(0, firstColumn - overscan.columns), lastColumn: Math.min(layout.count - 1, lastColumn + overscan.columns)
  }
}

/** A press on a column header's right border: dragging it resizes that column. */
export interface ResizeHit { readonly kind: 'resize'; readonly column: number }
export type LayoutHit = GridHit | ResizeHit

/**
 * What lies under (x, y), relative to the scroller's client box: the corner, a column header (or the resize zone at
 * its right border, which wins), a row header, or a cell; undefined past the data. With `clamp` a point outside the
 * data lands on the nearest cell, row, or column, as a drag that leaves the body needs.
 */
export function hitTest(x: number, y: number, o: { readonly viewport: Viewport; readonly rows: number; readonly layout: ColumnLayout; readonly rowHeader: number; readonly clamp?: boolean }): LayoutHit | undefined {
  const { viewport, rows, layout, rowHeader } = o
  const inHeader = y < g.headerHeight && !o.clamp, inRowHeader = x < rowHeader && !o.clamp
  const dataX = x - rowHeader + Math.max(0, viewport.left), dataY = y - g.headerHeight + Math.max(0, viewport.top)
  let column = layout.columnAt(dataX)
  if (inHeader) {
    if (inRowHeader) return { kind: 'corner' }
    if (layout.count === 0) return undefined
    const edge = (c: number) => layout.xOf(c + 1)
    if (column > 0 && dataX < layout.xOf(column) + g.resizeZoneRight) return { kind: 'resize', column: column - 1 }
    if (column >= layout.count) return dataX < layout.total + g.resizeZoneRight ? { kind: 'resize', column: layout.count - 1 } : undefined
    if (column >= 0 && dataX >= edge(column) - g.resizeZoneLeft) return { kind: 'resize', column }
    return column >= 0 ? { kind: 'column', column } : undefined
  }
  let row = Math.floor(dataY / g.rowHeight)
  if (o.clamp) {
    if (rows <= 0 || layout.count === 0) return undefined
    row = clamp(row, 0, rows - 1)
    column = clamp(column, 0, layout.count - 1)
  }
  if (row < 0 || row >= rows) return undefined
  if (inRowHeader) return { kind: 'row', row }
  return column >= 0 && column < layout.count ? { kind: 'cell', row, column } : undefined
}
