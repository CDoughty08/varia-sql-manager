import { describe, expect, it } from 'vitest'
import { ColumnLayout } from '../src/renderer/src/grid/layout'
import {
  applyWheel, ensureVisible, normalizeWheel, offsetsDropped, onNativeScroll, rebaseRow, remap, rowsContainerY, rowTop, scrollCap, scrollModel, topRowOf, toNative, toVirtual
} from '../src/renderer/src/grid/scroll'

const viewport = 600
/** Where row `row` appears in the viewport, from the top of the scroller's client box, as the DOM would place it. */
const onScreen = (model: ReturnType<typeof scrollModel>, scrollTop: number, virtualTop: number, row: number) => {
  const base = model.mode === 'native' ? 0 : rebaseRow(topRowOf(virtualTop))
  return rowsContainerY(model, scrollTop, virtualTop, base) + rowTop(row, base) - scrollTop
}

describe('grid scrolling', () => {
  it('caps the spacer below Chromium\'s physical layout limit at any pixel ratio', () => {
    expect([1, 1.25, 2, 2.5, 4].map(scrollCap)).toEqual([15_000_000, 15_000_000, 15_000_000, 12_000_000, 7_500_000])
    expect([0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(scrollCap)).toEqual([15_000_000, 15_000_000, 15_000_000, 15_000_000])
    // 33,554,431 layout units is Chromium's limit; the cap stays below it in physical pixels.
    for (const ratio of [1, 1.5, 2.25, 3, 5]) expect(scrollCap(ratio) * ratio).toBeLessThan(33_554_431)
  })
  it('scrolls natively up to the cap: the virtual offset is the scrollTop', () => {
    const model = scrollModel(100_000, viewport, scrollCap(1))
    expect(model).toMatchObject({ mode: 'native', spacerHeight: 22 + 2_000_000, ratio: 1, maxVirtual: 2_000_022 - viewport, maxNative: 2_000_022 - viewport })
    for (const top of [0, 1, 12_345, model.maxNative]) {
      expect(toVirtual(model, top)).toBe(top)
      expect(toNative(model, top)).toBe(top)
      expect(rowsContainerY(model, top, top, 0)).toBe(0)
    }
    expect(toVirtual(model, -5)).toBe(0)
    expect(toVirtual(model, model.maxNative + 100)).toBe(model.maxVirtual)
    // The last row that fits under the cap: 22 + rows × 20 ≤ cap.
    expect(scrollModel(749_998, viewport, 15_000_000).mode).toBe('native')
    expect(scrollModel(749_999, viewport, 15_000_000).mode).toBe('virtual')
    expect(scrollModel(0, viewport, 15_000_000)).toMatchObject({ mode: 'native', maxVirtual: 0, maxNative: 0 })
  })
  it('maps the scrollbar proportionally past the cap, reaching the first and last rows, for 1M, 10M and 100M rows', () => {
    for (const rows of [1_000_000, 10_000_000, 100_000_000]) for (const ratio of [1, 2.5]) {
      const cap = scrollCap(ratio), model = scrollModel(rows, viewport, cap)
      expect(model).toMatchObject({ mode: 'virtual', spacerHeight: cap, maxNative: cap - viewport })
      expect(toVirtual(model, 0)).toBe(0)
      expect(toVirtual(model, model.maxNative)).toBeCloseTo(model.maxVirtual, 3)
      // The last row's bottom meets the viewport's bottom.
      expect(22 + rows * 20 - toVirtual(model, model.maxNative)).toBeCloseTo(viewport, 3)
      let previous = -1
      for (let step = 0; step <= 1000; step++) {
        const native = Math.round(model.maxNative * step / 1000), virtual = toVirtual(model, native)
        expect(virtual).toBeGreaterThan(previous)
        expect(Math.abs(toNative(model, virtual) - native)).toBeLessThanOrEqual(1)
        previous = virtual
      }
    }
  })
  it('places rows from a base row that is a multiple of 4,096, at the same screen position as the content would', () => {
    expect([0, 4095, 4096, 8191, 12_345_678].map(rebaseRow)).toEqual([0, 0, 4096, 4096, 12_345_344])
    const model = scrollModel(10_000_000, viewport, scrollCap(1))
    for (const virtualTop of [0, 81_920, 81_939, 123_456_789, model.maxVirtual]) {
      const scrollTop = toNative(model, virtualTop), row = topRowOf(virtualTop)
      expect(onScreen(model, scrollTop, virtualTop, row)).toBeCloseTo(22 + row * 20 - virtualTop, 6)
      expect(onScreen(model, scrollTop, virtualTop, row + 25)).toBeCloseTo(22 + (row + 25) * 20 - virtualTop, 6)
      // Row offsets inside the container stay small however far down the result is.
      expect(rowTop(row + 30, rebaseRow(row))).toBeLessThan(22 + (4096 + 30) * 20)
    }
    const native = scrollModel(1000, viewport, scrollCap(1))
    expect(onScreen(native, 400, 400, 25)).toBe(22 + 25 * 20 - 400)
  })
  it('keeps the top row when rows streaming in flip the scroller from native to virtual', () => {
    const cap = 200_000, before = scrollModel(9000, viewport, cap)
    expect(before.mode).toBe('native')
    const scrollTop = 150_000, row = topRowOf(toVirtual(before, scrollTop))
    const after = scrollModel(50_000, viewport, cap)
    expect(after.mode).toBe('virtual')
    const kept = remap(after, toVirtual(before, scrollTop))
    expect(topRowOf(kept.virtualTop)).toBe(row)
    // The write's echo keeps the finer virtual offset; a real drag maps proportionally.
    expect(onNativeScroll(after, kept.scrollTop, kept.virtualTop, kept.scrollTop)).toBe(kept.virtualTop)
    expect(onNativeScroll(after, kept.scrollTop + 1, kept.virtualTop, kept.scrollTop)).toBe(kept.virtualTop)
    expect(onNativeScroll(after, kept.scrollTop + 50, kept.virtualTop, kept.scrollTop)).toBe(toVirtual(after, kept.scrollTop + 50))
    expect(onNativeScroll(before, 500, 123, 500)).toBe(500)
    // Shrinking (a smaller result) clamps to the new end.
    expect(remap(scrollModel(10, viewport, cap), 150_000)).toEqual({ virtualTop: 0, scrollTop: 0 })
    expect(remap(scrollModel(100, viewport, cap), 150_000).virtualTop).toBe(22 + 2000 - viewport)
  })
  it('tells offsets a move in the DOM dropped from a scroll to the top, which comes with a scroll event', () => {
    // A pane closed and opened within one frame: the scroller reads 0, 0 and no scroll event came.
    expect(offsetsDropped({ scrolled: false, scrollTop: 0, scrollLeft: 0, lastTop: 914, lastLeft: 0 })).toBe(true)
    expect(offsetsDropped({ scrolled: false, scrollTop: 0, scrollLeft: 0, lastTop: 0, lastLeft: 300 })).toBe(true)
    // The user's scroll to the top, a scroller already at the top, and a partial change are kept.
    expect(offsetsDropped({ scrolled: true, scrollTop: 0, scrollLeft: 0, lastTop: 914, lastLeft: 300 })).toBe(false)
    expect(offsetsDropped({ scrolled: false, scrollTop: 0, scrollLeft: 0, lastTop: 0, lastLeft: 0 })).toBe(false)
    expect(offsetsDropped({ scrolled: false, scrollTop: 0, scrollLeft: 300, lastTop: 914, lastLeft: 300 })).toBe(false)
    expect(offsetsDropped({ scrolled: false, scrollTop: 914, scrollLeft: 0, lastTop: 914, lastLeft: 300 })).toBe(false)
  })
  it('turns wheel lines and pages into pixels and moves the virtual offset 1:1, leaving the edges to the outer stack', () => {
    expect([normalizeWheel(53, 0, viewport), normalizeWheel(3, 1, viewport), normalizeWheel(-1, 2, viewport)]).toEqual([53, 60, -(viewport - 42)])
    expect(normalizeWheel(1, 2, 30)).toBe(20)
    const model = scrollModel(2_000_000, viewport, scrollCap(1))
    expect(applyWheel(model, 1000, 120)).toEqual({ virtualTop: 1120, handled: true })
    expect(applyWheel(model, 50, -120)).toEqual({ virtualTop: 0, handled: true })
    expect(applyWheel(model, 0, -120)).toEqual({ virtualTop: 0, handled: false })
    expect(applyWheel(model, model.maxVirtual, 120)).toEqual({ virtualTop: model.maxVirtual, handled: false })
    expect(applyWheel(model, model.maxVirtual, -20).handled).toBe(true)
    expect(applyWheel(model, 500, 0).handled).toBe(false)
  })
  it('brings a cell into view with the least movement', () => {
    const layout = new ColumnLayout(Float64Array.from([100, 100, 600, 100]), 15_000_000)
    const o = { virtualTop: 400, scrollLeft: 100, viewportWidth: 440, viewportHeight: 222, rowHeader: 40, layout, rows: 1000 }
    // The body shows rows 20–29 and x 100–500.
    expect(ensureVisible(o, 25, 1)).toEqual({ virtualTop: 400, scrollLeft: 100 })
    expect(ensureVisible(o, 10, -1)).toEqual({ virtualTop: 200, scrollLeft: 100 })
    expect(ensureVisible(o, 30, -1)).toEqual({ virtualTop: 420, scrollLeft: 100 })
    expect(ensureVisible(o, 999, -1)).toEqual({ virtualTop: 22 + 20_000 - 222, scrollLeft: 100 })
    expect(ensureVisible(o, -1, 0)).toEqual({ virtualTop: 400, scrollLeft: 0 })
    expect(ensureVisible(o, -1, 3)).toEqual({ virtualTop: 400, scrollLeft: 900 - 400 })
    // Wider than the body: its left edge.
    expect(ensureVisible(o, -1, 2)).toEqual({ virtualTop: 400, scrollLeft: 200 })
    expect(ensureVisible({ ...o, rows: 3 }, 2, -1)).toEqual({ virtualTop: 0, scrollLeft: 100 })
  })
})
