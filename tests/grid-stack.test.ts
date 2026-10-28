import { describe, expect, it } from 'vitest'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { stylesheetRules } from './fixtures/css-rules'
import { contentHeight, dragSplitter, minGridHeight, mountedRange, setFloors, splitterMoves, stackLayout, stackMinimum } from '../src/renderer/src/grid/stack'

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
    // Every set fits: each keeps its rows and what is left stays empty below the last one, rather than stretching one set
    // (the first of equal ones) over empty rows and pushing the next to the bottom.
    const eight = contentHeight(8, 15, false)
    const fits = stackLayout(1000, 3, undefined, min, { content: [small, eight, small] })
    expect(fits.heights).toEqual([small, eight, small])
    expect(fits.offsets).toEqual([0, small + 5, small + eight + 10])
    expect(fits.total).toBe(1000)
    const ones = stackLayout(600, 2, undefined, min, { content: [contentHeight(1, 0, false), contentHeight(1, 0, false)] })
    expect(ones.heights).toEqual([26 + 22 + 20 + 2, 26 + 22 + 20 + 2])
    // A set whose columns fit has no horizontal scroll bar to count.
    expect(contentHeight(3, 0, false)).toBe(contentHeight(3, 15, false) - 15)
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
  it('move a splitter within the pair, keeping their sum and both floors, and turn heights back into weights', () => {
    const { heights } = stackLayout(1000, 3, undefined, min)
    const floors = setFloors(3, min)
    expect(floors).toEqual([min, min, min])
    const dragged = dragSplitter(heights, 0, 100, floors)
    expect(dragged).toEqual([430, 230, 330])
    expect(sum(dragged)).toBe(sum(heights))
    expect(dragSplitter(heights, 0, 1000, floors)).toEqual([660 - min, min, 330])
    expect(dragSplitter(heights, 1, -1000, floors)).toEqual([330, min, 660 - min])
    // Home and End jump to the limits; out-of-range splitters and NaN change nothing.
    expect(dragSplitter(heights, 1, Number.POSITIVE_INFINITY, floors)).toEqual([330, 660 - min, min])
    expect(dragSplitter(heights, 2, 50, floors)).toEqual(heights)
    expect(dragSplitter(heights, -1, 50, floors)).toEqual(heights)
    expect(dragSplitter(heights, 0, Number.NaN, floors)).toEqual(heights)
    expect(dragSplitter([100, 100], 0, 50, [min, min])).toEqual([100, 100])
    // The dragged heights are the new weights: laid out again they come back, and a taller pane keeps their ratio.
    expect(stackLayout(1000, 3, dragged, min).heights).toEqual(dragged)
    const taller = stackLayout(1990, 3, dragged, min).heights
    expect(taller.map(height => Math.round(height / taller[2] * 330))).toEqual(dragged)
  })
  it('leave a splitter beside a collapsed set inert, and move the others by exactly the delta', () => {
    for (const shut of [0, 1, 2]) {
      const sizing = { collapsed: new Set([shut]) }
      const { heights } = stackLayout(1000, 3, undefined, min, sizing)
      const floors = setFloors(3, min, sizing)
      expect(floors[shut]).toBe(26)
      for (const index of [0, 1]) {
        const moves = splitterMoves(3, index, sizing.collapsed)
        expect(moves).toBe(index !== shut && index + 1 !== shut)
        for (const delta of [20, -20, 1, Number.POSITIVE_INFINITY]) {
          const next = dragSplitter(heights, index, delta, floors, sizing.collapsed)
          if (!moves) { expect(next, `splitter ${index}, set ${shut} collapsed`).toEqual(heights); continue }
          // Laid out again, only the pair beside the splitter changes, the upper one by the delta and in its direction.
          const after = stackLayout(1000, 3, next, min, sizing).heights
          const moved = Number.isFinite(delta) ? delta : after[index] - heights[index]
          expect(after[index] - heights[index]).toBe(moved)
          expect(after[index + 1] - heights[index + 1]).toBe(-moved)
          expect(after[shut]).toBe(26)
        }
      }
    }
    // The reviewer's case: set 2 collapsed, dragging splitter 0 down by 10 grows Result 1 and leaves Result 3's caption.
    const sizing = { collapsed: new Set([2]) }
    const before = stackLayout(1000, 3, undefined, min, sizing).heights
    const after = stackLayout(1000, 3, dragSplitter(before, 0, 10, setFloors(3, min, sizing), sizing.collapsed), min, sizing).heights
    expect(after).toEqual([before[0] + 10, before[1] - 10, 26])
  })
  it('let a set sized to its rows shrink only to them, never grow when its splitter moves up, and keep the value within its range', () => {
    const tiny = contentHeight(1, 15, false), sizing = { content: [tiny, undefined] }
    expect(tiny).toBeLessThan(min)
    const { heights } = stackLayout(1000, 2, undefined, min, sizing)
    expect(heights).toEqual([tiny, 1000 - 5 - tiny])
    const floors = setFloors(2, min, sizing)
    expect(floors).toEqual([tiny, min])
    // ArrowUp (one row up) on the splitter below it: it stays at its rows, not jumping up to the minimum.
    const up = dragSplitter(heights, 0, -20, floors)
    expect(up).toEqual(heights)
    expect(stackLayout(1000, 2, up, min, sizing).heights[0]).toBe(tiny)
    // Down makes it taller; back up returns to its rows, laid out with the weights the drag left.
    const down = stackLayout(1000, 2, dragSplitter(heights, 0, 40, floors), min, sizing).heights
    expect(down[0]).toBe(tiny + 40)
    expect(stackLayout(1000, 2, dragSplitter(down, 0, -1000, floors), min, sizing).heights[0]).toBe(tiny)
    // The separator's value, the upper set's height, lies between its floor and the pair less the lower one's floor.
    for (const layout of [heights, down]) {
      expect(layout[0]).toBeGreaterThanOrEqual(floors[0])
      expect(layout[0]).toBeLessThanOrEqual(layout[0] + layout[1] - floors[1])
    }
    // The room a stack needs before it scrolls: each set at its floor, splitters between.
    expect(stackMinimum(2, min, sizing)).toBe(tiny + 5 + min)
    expect(stackMinimum(3, min, { collapsed: new Set([1]) })).toBe(min + 5 + 26 + 5 + min)
    expect(stackMinimum(0, min)).toBe(0)
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
    // ...and one line, however narrow the pane: a long sentence is cut short (its tooltip has it), never wrapped onto a row.
    expect([value('.rg-strip', 'white-space'), value('.rg-strip', 'overflow'), value('.rg-strip', 'text-overflow')]).toEqual(['nowrap', 'hidden', 'ellipsis'])
    // The Messages strip's line, and the least it takes open: three lines of 12 px messages at 1.7 and the log's padding.
    expect([value('.messages-strip-toggle', 'height'), value('.messages-strip-toggle', 'box-sizing')]).toEqual([gridLimits.messagesStripLine + 'px', 'border-box'])
    expect(value('.messages .msg', 'font')).toMatch(/^var\(--varia-size-sm\)\/1\.7 /)
    expect(value('.messages-strip .messages', 'padding')).toBe('2px 20px 8px')
    expect(gridLimits.messagesStripOpen).toBeGreaterThanOrEqual(gridLimits.messagesStripLine + 2 + 8 + Math.ceil(3 * 12 * 1.7) + 1)
  })
  it('isolate a header\'s name and type, so bidi controls in a name cannot reorder its type', () => {
    const value = (selector: string, property: string) => stylesheetRules().find(rule => rule.selector === selector && !rule.at.length && rule.declarations.some(item => item.property === property))
      ?.declarations.find(item => item.property === property)?.value
    expect(value('.rg-cn', 'unicode-bidi')).toBe('isolate')
    expect(value('.rg-ct', 'unicode-bidi')).toBe('isolate')
  })
  it('keep the results\' focus rings visible: inset where controls touch a clipping edge, and apart from the selected view under forced colours', () => {
    const rules = stylesheetRules()
    const declared = (selector: string, property: string, forced = false) => rules.filter(rule => rule.selector.split(',').map(part => part.trim()).includes(selector) && (forced ? rule.at.includes('@media (forced-colors: active)') : !rule.at.length))
      .flatMap(rule => rule.declarations).filter(item => item.property === property).at(-1)?.value
    for (const selector of ['.rs-caption-toggle:focus-visible', '.rs-caption-save:focus-visible', '.messages-strip-toggle:focus-visible']) expect(declared(selector, 'outline-offset'), selector).toBe('-2px')
    // Arrow keys select the view they reach, so the focused view is the selected one: its ring must differ from selection's.
    const selected = [declared('.output-views button.active', 'outline', true), declared('.output-views button.active', 'outline-offset', true)]
    const focused = [declared('.output-views button.active:focus-visible', 'outline', true), declared('.output-views button.active:focus-visible', 'outline-offset', true)]
    expect(selected).toEqual(['2px solid Highlight', '-2px'])
    expect(focused[0]).toBeDefined()
    expect(focused).not.toEqual(selected)
    expect(focused[0]).not.toBe(selected[0])
  })
})
