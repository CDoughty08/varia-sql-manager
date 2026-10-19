import { describe, expect, it } from 'vitest'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { ColumnLayout, hitTest, rowHeaderWidth, visibleRange, type Viewport } from '../src/renderer/src/grid/layout'

const layoutOf = (widths: readonly number[], maxTotal = 15_000_000) => new ColumnLayout(Float64Array.from(widths), maxTotal)

describe('column layout', () => {
  it('keeps running offsets and finds the column at a position at every boundary of 4,096 columns', () => {
    const widths = Array.from({ length: 4096 }, (_, index) => 32 + (index * 37) % 300)
    const layout = layoutOf(widths)
    let x = 0
    for (let column = 0; column < 4096; column++) {
      expect(layout.xOf(column)).toBe(x)
      expect(layout.columnAt(x)).toBe(column)
      expect(layout.columnAt(x + widths[column] - 1)).toBe(column)
      x += widths[column]
    }
    expect(layout.total).toBe(x)
    expect(layout.xOf(4096)).toBe(x)
    expect([layout.columnAt(-1), layout.columnAt(x), layout.columnAt(x + 1000)]).toEqual([-1, 4096, 4096])
    expect(layoutOf([]).columnAt(0)).toBe(-1)
  })
  it('clamps widths to [32, 3,000] and resizes one column, moving the offsets after it', () => {
    const layout = layoutOf([10, Number.NaN, 5000, 100.4])
    expect(Array.from(layout.widths)).toEqual([32, 32, 3000, 100])
    expect(layout.setWidth(1, 82)).toBe(82)
    expect([layout.xOf(2), layout.xOf(3), layout.total]).toEqual([114, 3114, 3214])
    expect(layout.setWidth(0, 1)).toBe(32)
    expect(layout.setWidth(3, 9999)).toBe(3000)
    expect(layout.total).toBe(32 + 82 + 3000 + 3000)
    // The widths array is the grid's saved state: the layout writes through to it.
    const saved = Float64Array.from([50, 60])
    new ColumnLayout(saved, 1000).setWidth(0, 70)
    expect(Array.from(saved)).toEqual([70, 60])
  })
  it('caps the sum of widths: growth stops at the cap, shrinking always works', () => {
    const layout = layoutOf([100, 100, 100], 400)
    expect(layout.setWidth(0, 500)).toBe(200)
    expect(layout.total).toBe(400)
    expect(layout.setWidth(1, 300)).toBe(100)
    expect(layout.setWidth(1, 40)).toBe(40)
    expect(layout.setWidth(2, 3000)).toBe(160)
    // Initial widths over the cap leave every later column its minimum.
    expect(Array.from(layoutOf([3000, 3000, 3000], 3100).widths)).toEqual([3000, 68, 32])
    // A lower cap (a higher pixel ratio) keeps the widths but stops growth.
    const wide = layoutOf([1000, 1000], 10_000)
    wide.setMaxTotal(1500)
    expect(wide.total).toBe(2000)
    expect(wide.setWidth(0, 1200)).toBe(1000)
    expect(wide.setWidth(0, 400)).toBe(400)
  })
  it('sizes the row header for the widest row number, at least 9,999, widening only at powers of 10', () => {
    expect(rowHeaderWidth(0, 7.2)).toBe(Math.ceil(4 * 7.2) + 13)
    expect(rowHeaderWidth(9999, 7.2)).toBe(rowHeaderWidth(5, 7.2))
    expect(rowHeaderWidth(10_000, 7.2)).toBe(Math.ceil(5 * 7.2) + 13)
    expect(rowHeaderWidth(99_999, 7.2)).toBe(rowHeaderWidth(10_000, 7.2))
    expect(rowHeaderWidth(1_000_000, 7.2)).toBe(Math.ceil(7 * 7.2) + 13)
    expect(rowHeaderWidth(5, 5)).toBe(40)
  })
})

describe('visible range', () => {
  const layout = layoutOf(Array.from({ length: 100 }, () => 100))
  const viewport = (top: number, left: number, width = 1000, height = 422): Viewport => ({ top, left, width, height })
  it('covers the body below the header row and right of the row header, with overscan', () => {
    // 400 px of body show rows 0–19 and 950 px columns 0–9; overscan adds 8 rows and 2 columns.
    expect(visibleRange(viewport(0, 0), 1000, layout, 50)).toEqual({ firstRow: 0, lastRow: 27, firstColumn: 0, lastColumn: 11 })
    expect(visibleRange(viewport(0, 0), 1000, layout, 50, { rows: 0, columns: 0 })).toEqual({ firstRow: 0, lastRow: 19, firstColumn: 0, lastColumn: 9 })
    // Half a row scrolled: row 0 is partly hidden and row 20 partly shown.
    expect(visibleRange(viewport(10, 50), 1000, layout, 50, { rows: 0, columns: 0 })).toEqual({ firstRow: 0, lastRow: 20, firstColumn: 0, lastColumn: 9 })
    expect(visibleRange(viewport(20, 100), 1000, layout, 50, { rows: 0, columns: 0 })).toEqual({ firstRow: 1, lastRow: 20, firstColumn: 1, lastColumn: 10 })
  })
  it('clamps to the result at its edges and is empty with nothing to show', () => {
    expect(visibleRange(viewport(19_600, 9000), 1000, layout, 50)).toEqual({ firstRow: 972, lastRow: 999, firstColumn: 88, lastColumn: 99 })
    expect(visibleRange(viewport(0, 0), 5, layout, 50)).toEqual({ firstRow: 0, lastRow: 4, firstColumn: 0, lastColumn: 11 })
    const empty = (range: ReturnType<typeof visibleRange>) => range.lastRow < range.firstRow || range.lastColumn < range.firstColumn
    expect(empty(visibleRange(viewport(0, 0), 0, layout, 50))).toBe(true)
    expect(empty(visibleRange(viewport(0, 0), 10, layoutOf([]), 50))).toBe(true)
    // A hidden pane (0 × 0) or one shorter than the header shows nothing.
    expect(empty(visibleRange(viewport(0, 0, 0, 0), 10, layout, 50))).toBe(true)
    expect(empty(visibleRange(viewport(0, 0, 1000, 22), 10, layout, 50))).toBe(true)
  })
})

describe('hit testing', () => {
  const layout = layoutOf([100, 50, 200])
  const o = (top = 0, left = 0, extra: { clamp?: boolean } = {}) => ({ viewport: { top, left, width: 500, height: 300 }, rows: 30, layout, rowHeader: 40, ...extra })
  it('finds the corner, column headers, row headers and cells', () => {
    expect(hitTest(10, 10, o())).toEqual({ kind: 'corner' })
    expect(hitTest(60, 10, o())).toEqual({ kind: 'column', column: 0 })
    expect(hitTest(160, 10, o())).toEqual({ kind: 'column', column: 1 })
    expect(hitTest(10, 22, o())).toEqual({ kind: 'row', row: 0 })
    expect(hitTest(10, 41, o())).toEqual({ kind: 'row', row: 0 })
    expect(hitTest(10, 42, o())).toEqual({ kind: 'row', row: 1 })
    expect(hitTest(40, 22, o())).toEqual({ kind: 'cell', row: 0, column: 0 })
    expect(hitTest(190, 299, o())).toEqual({ kind: 'cell', row: 13, column: 2 })
    // Scrolled: the header and row header stay put, the cells under them move.
    expect(hitTest(40, 22, o(200, 120))).toEqual({ kind: 'cell', row: 10, column: 1 })
    expect(hitTest(10, 22, o(200, 120))).toEqual({ kind: 'row', row: 10 })
    expect(hitTest(10, 5, o(200, 120))).toEqual({ kind: 'corner' })
  })
  it('gives the resize zone, 4 px left and 3 px right of a header border, precedence over the header', () => {
    // Column 0's right border is at 40 + 100 = 140.
    expect([135, 136, 139, 140, 142, 143].map(x => hitTest(x, 10, o()))).toEqual([
      { kind: 'column', column: 0 }, { kind: 'resize', column: 0 }, { kind: 'resize', column: 0 }, { kind: 'resize', column: 0 }, { kind: 'resize', column: 0 }, { kind: 'column', column: 1 }
    ])
    // The last column's border, past which the header is empty.
    expect([386, 392, 393].map(x => hitTest(x, 10, o()))).toEqual([{ kind: 'resize', column: 2 }, { kind: 'resize', column: 2 }, undefined])
    expect(hitTest(140, 30, o())).toEqual({ kind: 'cell', row: 0, column: 1 })
    expect(gridLimits.resizeZoneLeft + gridLimits.resizeZoneRight).toBe(7)
  })
  it('finds nothing past the data, and the nearest cell for a drag that leaves the body', () => {
    expect(hitTest(450, 100, o())).toBeUndefined()
    expect(hitTest(100, 299, o(500))).toBeUndefined()
    expect(hitTest(100, 299, { ...o(), rows: 0 })).toBeUndefined()
    expect(hitTest(450, 100, o(0, 0, { clamp: true }))).toEqual({ kind: 'cell', row: 3, column: 2 })
    expect(hitTest(-20, -50, o(0, 0, { clamp: true }))).toEqual({ kind: 'cell', row: 0, column: 0 })
    expect(hitTest(100, 299, o(500, 0, { clamp: true }))).toEqual({ kind: 'cell', row: 29, column: 0 })
    expect(hitTest(100, 100, { ...o(0, 0, { clamp: true }), rows: 0 })).toBeUndefined()
  })
})
