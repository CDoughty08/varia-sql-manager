import { describe, expect, it } from 'vitest'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { stylesheetRules } from './fixtures/css-rules'
import { contentHeight, dragSplitter, minGridHeight, mountedRange, stackLayout } from '../src/renderer/src/grid/stack'

const min = minGridHeight(15)
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

describe('stacked result sets', () => {
  it('give one set the whole pane and split it equally between several, within 1 px', () => {
    // The caption, the header, four rows, the scroll bar and the border.
    expect(min).toBe(26 + 22 + 80 + 15 + 2)
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
  it('size a set that has all its rows to them when they fit its share, and give the rest to the others', () => {
    // The caption, the header, three rows, the scroll bar and the border; and a set with a strip.
    expect(contentHeight(3, 15, false)).toBe(26 + 22 + 60 + 15 + 2)
    expect(contentHeight(3, 15, true)).toBe(26 + 22 + 60 + 15 + 2 + 25)
    expect(contentHeight(0, 0, false)).toBe(26 + 22 + 2)
    const small = contentHeight(3, 15, false), large = contentHeight(10_000, 15, false)
    // A 3-row set beside a large one: the small one fits its rows, the large one takes the rest of the pane.
    const pair = stackLayout(1000, 2, undefined, min, { content: [small, large] })
    expect(pair.heights).toEqual([small, 1000 - 5 - small])
    expect(pair.total).toBe(1000)
    // One still streaming (no content yet) is flexible: it takes the rest whatever its rows so far.
    expect(stackLayout(1000, 2, undefined, min, { content: [small, undefined] }).heights).toEqual([small, 1000 - 5 - small])
    // Three: two small fit, the large and the streaming one share the rest equally.
    const four = stackLayout(1000, 4, undefined, min, { content: [small, large, small, undefined] })
    expect(four.heights[0]).toBe(small)
    expect(four.heights[2]).toBe(small)
    expect(Math.abs(four.heights[1] - four.heights[3])).toBeLessThanOrEqual(1)
    expect(sum(four.heights) + 3 * 5).toBe(1000)
    // Every set fits: the largest takes what is left, so the stack still fills the pane without a scroll bar.
    const fits = stackLayout(1000, 3, undefined, min, { content: [small, contentHeight(8, 15, false), small] })
    expect(fits.heights).toEqual([small, 1000 - 10 - 2 * small, small])
    expect(fits.total).toBe(1000)
    // A set with fewer rows than the minimum is not stretched to it; many small sets scroll at their own heights.
    const tiny = contentHeight(1, 15, false)
    expect(tiny).toBeLessThan(min)
    const many = stackLayout(600, 20, undefined, min, { content: Array.from({ length: 20 }, () => tiny) })
    expect(many.heights.every(height => height === tiny)).toBe(true)
    expect(many.total).toBe(20 * tiny + 19 * 5)
    // A set larger than its share is not capped by its content.
    expect(stackLayout(400, 2, undefined, min, { content: [large, large] }).heights).toEqual([198, 197])
    // Weights from a splitter drag win over the content, so a small set can be made taller.
    expect(stackLayout(1000, 2, [600, 395], min, { content: [small, large] }).heights).toEqual([600, 395])
  })
  it('show a collapsed set as its caption alone and share its room between the others', () => {
    const collapsed = stackLayout(1000, 3, undefined, min, { collapsed: new Set([1]) })
    expect(collapsed.heights[1]).toBe(26)
    expect(collapsed.heights[0] + collapsed.heights[2]).toBe(1000 - 10 - 26)
    expect(collapsed.offsets).toEqual([0, collapsed.heights[0] + 5, collapsed.heights[0] + 5 + 26 + 5])
    // With weights too, and when every set is collapsed the stack is the pane with the captions at the top.
    expect(stackLayout(1000, 3, [1, 1, 1], min, { collapsed: new Set([0]) }).heights[0]).toBe(26)
    const all = stackLayout(1000, 2, undefined, min, { collapsed: new Set([0, 1]) })
    expect(all.heights).toEqual([26, 26])
    expect(all.total).toBe(1000)
    expect(stackLayout(500, 1, undefined, min, { collapsed: new Set([0]) }).heights).toEqual([26])
    // A collapsed set with content keeps only its caption; the content of the others still applies.
    const small = contentHeight(2, 15, false)
    expect(stackLayout(1000, 3, undefined, min, { content: [small, small, undefined], collapsed: new Set([0]) }).heights).toEqual([26, small, 1000 - 10 - 26 - small])
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
    // At the top: the 4 grids in view and the 4 that start within one view below.
    expect(mountedRange(layout, 0, 600)).toEqual([0, 7])
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
  it('size captions, strips and the type gap in styles.css as the layout counts them', () => {
    const value = (selector: string, property: string) => stylesheetRules().find(rule => rule.selector === selector && !rule.at.length && rule.declarations.some(item => item.property === property))
      ?.declarations.find(item => item.property === property)?.value
    expect(value('.rs-caption', 'height')).toBe(gridLimits.captionHeight + 'px')
    expect(value('.rs-caption', 'box-sizing')).toBe('border-box')
    expect(value('.rg-ct', 'margin-left')).toBe(gridLimits.typeGap + 'px')
    // The strip: 4 px padding above and below its 16 px line, and its 1 px top border.
    expect(value('.rg-strip', 'padding')).toBe('4px 8px')
    expect(value('.rg-strip', 'font')).toMatch(/\/16px /)
    expect(value('.rg-strip', 'border-top')).toMatch(/^1px solid/)
    expect(gridLimits.stripHeight).toBe(4 + 16 + 4 + 1)
  })
})
