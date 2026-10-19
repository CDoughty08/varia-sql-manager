import { describe, expect, it } from 'vitest'
import { dragSplitter, minGridHeight, mountedRange, stackLayout } from '../src/renderer/src/grid/stack'

const min = minGridHeight(15)
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

describe('stacked result sets', () => {
  it('give one set the whole pane and split it equally between several, within 1 px', () => {
    expect(min).toBe(22 + 80 + 15 + 2)
    expect(stackLayout(500, 1, undefined, min)).toEqual({ heights: [500], offsets: [0], total: 500 })
    expect(stackLayout(500, 0, undefined, min)).toEqual({ heights: [], offsets: [], total: 0 })
    const three = stackLayout(1000, 3, undefined, min)
    expect(three.heights).toEqual([330, 330, 330])
    expect(three.offsets).toEqual([0, 335, 670])
    expect(three.total).toBe(1000)
    const uneven = stackLayout(1001, 4, undefined, min)
    expect(Math.max(...uneven.heights) - Math.min(...uneven.heights)).toBeLessThanOrEqual(1)
    expect(sum(uneven.heights) + 3 * 5).toBe(1001)
    // Weights that do not fit the count (a set was added) fall back to equal heights.
    expect(stackLayout(1000, 3, [1, 2], min).heights).toEqual([330, 330, 330])
    expect(stackLayout(1000, 3, [1, 0, 1], min).heights).toEqual([330, 330, 330])
  })
  it('keep each grid at least its minimum and let the stack scroll when they do not fit', () => {
    const many = stackLayout(600, 10, undefined, min)
    expect(many.heights.every(height => height === min)).toBe(true)
    expect(many.total).toBe(10 * min + 9 * 5)
    expect(many.offsets[9]).toBe(9 * (min + 5))
    const weighted = stackLayout(600, 3, [10, 1, 1], min)
    expect(weighted.heights[1]).toBe(min)
    expect(weighted.heights[0]).toBeGreaterThan(400)
  })
  it('move a splitter within the pair, keeping their sum and both minimums, and turn heights back into weights', () => {
    const { heights } = stackLayout(1000, 3, undefined, min)
    const dragged = dragSplitter(heights, 0, 100, min)
    expect(dragged).toEqual([430, 230, 330])
    expect(sum(dragged)).toBe(sum(heights))
    expect(dragSplitter(heights, 0, 1000, min)).toEqual([660 - min, min, 330])
    expect(dragSplitter(heights, 1, -1000, min)).toEqual([330, min, 660 - min])
    // Home and End jump to the limits; out-of-range splitters and NaN change nothing.
    expect(dragSplitter(heights, 1, Number.POSITIVE_INFINITY, min)).toEqual([330, 660 - min, min])
    expect(dragSplitter(heights, 2, 50, min)).toEqual(heights)
    expect(dragSplitter(heights, -1, 50, min)).toEqual(heights)
    expect(dragSplitter(heights, 0, Number.NaN, min)).toEqual(heights)
    expect(dragSplitter([100, 100], 0, 50, min)).toEqual([100, 100])
    // The dragged heights are the new weights: laid out again they come back, and a taller pane keeps their ratio.
    expect(stackLayout(1000, 3, dragged, min).heights).toEqual(dragged)
    const taller = stackLayout(1990, 3, dragged, min).heights
    expect(taller.map(height => Math.round(height / taller[2] * 330))).toEqual(dragged)
  })
  it('mount the grids in view first, then those within a view above and below, at most 12', () => {
    const layout = stackLayout(600, 1000, undefined, min)
    const step = min + 5
    // At the top: the 5 grids in view and the 5 that start within one view below.
    expect(mountedRange(layout, 0, 600)).toEqual([0, 9])
    expect(mountedRange(layout, 0, 600, 3)).toEqual([0, 2])
    // In view: grids 100–104 (the view is 600 px tall); then alternately below and above.
    const [first, last] = mountedRange(layout, 100 * step, 600)
    expect(first).toBeLessThanOrEqual(100)
    expect(last).toBeGreaterThanOrEqual(104)
    expect(last - first + 1).toBe(12)
    expect(mountedRange(layout, 999 * step, 600)[1]).toBe(999)
    expect(mountedRange(layout, layout.total, 600)[1]).toBe(999)
    // A few grids: all of them.
    expect(mountedRange(stackLayout(600, 3, undefined, min), 0, 600)).toEqual([0, 2])
    expect(mountedRange(stackLayout(600, 0, undefined, min), 0, 600)).toEqual([0, -1])
    // Tall grids: those within one view either side only.
    const tall = stackLayout(600, 50, Array.from({ length: 50 }, () => 1), 400)
    expect(mountedRange(tall, 4050, 600)).toEqual([8, 12])
    const started = performance.now()
    for (let index = 0; index < 1000; index++) mountedRange(layout, index * step, 600)
    expect((performance.now() - started) / 1000).toBeLessThan(2)
  })
})
