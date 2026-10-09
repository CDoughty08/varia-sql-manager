import { gridLimits as g } from './constants'

// Stacked result sets, as SSMS shows them: the pane is split between the grids by weight (equal by default), no grid
// is shorter than a header and four rows, and when they do not fit the stack itself scrolls. Rows streaming into one
// grid never move another: heights depend only on the pane, the number of sets and the weights.

/** The shortest grid: the header, four rows, a horizontal scrollbar and the border. */
export const minGridHeight = (scrollbar: number): number => g.headerHeight + g.stackMinRows * g.rowHeight + Math.max(0, scrollbar) + g.stackBorder

export interface StackLayout {
  readonly heights: readonly number[]
  /** Each grid's top, splitters included. */
  readonly offsets: readonly number[]
  /** The stack's height: the pane's, or more when the minimum heights overflow it. */
  readonly total: number
}

/**
 * Whole-pixel heights: h_i = max(minHeight, (pane − splitters) × w_i / Σw), with the rounding remainder handed out one
 * pixel at a time from the top, so equal weights give heights within 1 px of each other. One set fills the pane.
 */
export function stackLayout(paneHeight: number, count: number, weights: readonly number[] | undefined, minHeight: number): StackLayout {
  const pane = Math.max(0, Math.floor(paneHeight))
  if (count <= 0) return { heights: [], offsets: [], total: 0 }
  if (count === 1) return { heights: [pane], offsets: [0], total: pane }
  const usable = Math.max(0, pane - (count - 1) * g.splitter)
  const valid = weights?.length === count && weights.every(weight => Number.isFinite(weight) && weight > 0) ? weights : undefined
  const weightOf = (index: number) => valid ? valid[index] : 1
  let sum = 0
  for (let index = 0; index < count; index++) sum += weightOf(index)
  const heights = new Array<number>(count)
  let assigned = 0
  for (let index = 0; index < count; index++) { heights[index] = Math.floor(usable * weightOf(index) / sum); assigned += heights[index] }
  for (let index = 0, remainder = usable - assigned; index < count && remainder > 0; index++, remainder--) heights[index]++
  const offsets = new Array<number>(count)
  let top = 0
  for (let index = 0; index < count; index++) {
    heights[index] = Math.max(minHeight, heights[index])
    offsets[index] = top
    top += heights[index] + (index < count - 1 ? g.splitter : 0)
  }
  return { heights, offsets, total: Math.max(pane, top) }
}

/**
 * Heights after dragging the splitter below grid `index` by `delta` pixels: the boundary moves, the two grids keep
 * their combined height and at least `minHeight` each. ±Infinity moves it as far as it goes (Home and End). The result
 * is the new weights.
 */
export function dragSplitter(heights: readonly number[], index: number, delta: number, minHeight: number): number[] {
  const next = [...heights]
  if (index < 0 || index >= heights.length - 1 || Number.isNaN(delta)) return next
  const pair = heights[index] + heights[index + 1]
  // When even the pair is shorter than two minimums, the boundary stays where it is.
  if (pair < 2 * minHeight) return next
  next[index] = Math.round(Math.min(Math.max(heights[index] + delta, minHeight), pair - minHeight))
  next[index + 1] = pair - next[index]
  return next
}

/**
 * The grids to mount, as an inclusive [first, last]: those within one viewport above and below the stack's view, at
 * most `max`. The ones in view come first; the rest are added alternately below and above. O(log n) to find the view.
 */
export function mountedRange(layout: Pick<StackLayout, 'heights' | 'offsets'>, scrollTop: number, viewportHeight: number, max: number = g.mountedGrids): readonly [number, number] {
  const { heights, offsets } = layout, count = heights.length
  if (count === 0 || max <= 0) return [0, -1]
  const view = Math.max(0, viewportHeight)
  /** The first grid whose bottom is below `y`. */
  const firstBelow = (y: number) => {
    let low = 0, high = count
    while (low < high) {
      const middle = (low + high) >> 1
      if (offsets[middle] + heights[middle] > y) high = middle
      else low = middle + 1
    }
    return Math.min(low, count - 1)
  }
  /** The last grid whose top is above `y`. */
  const lastAbove = (y: number) => {
    let low = -1, high = count - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (offsets[middle] < y) low = middle
      else high = middle - 1
    }
    return Math.max(low, 0)
  }
  let first = firstBelow(scrollTop), last = Math.max(first, lastAbove(scrollTop + Math.max(1, view)))
  if (last - first + 1 >= max) return [first, first + max - 1]
  const lowest = firstBelow(scrollTop - view), highest = Math.max(lowest, lastAbove(scrollTop + 2 * Math.max(1, view)))
  while (last - first + 1 < max && (last < highest || first > lowest)) {
    if (last < highest) last++
    if (last - first + 1 < max && first > lowest) first--
  }
  return [first, last]
}
