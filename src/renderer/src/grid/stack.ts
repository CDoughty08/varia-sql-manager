import { gridLimits as g } from './constants'

// Stacked result sets: each has a caption above its grid. A set that has all its rows and needs less than its share of the
// pane is sized to them, and the rest is split between the others by weight (equal by default); when every set fits, what
// is left stays empty below the last one. No grid is shorter than a header and four rows (or its rows, when fewer), a
// collapsed set is its caption alone, and when they do not fit the stack itself scrolls. Rows streaming into one set never move
// another: a set is sized to its rows only once it has them all, and heights otherwise depend only on the pane, the
// number of sets, the weights and what was collapsed.

/** The shortest set: its caption, the header, four rows, a horizontal scrollbar and the border. */
export const minGridHeight = (scrollbar: number): number => g.captionHeight + g.headerHeight + g.stackMinRows * g.rowHeight + Math.max(0, scrollbar) + g.stackBorder
/** A set sized to its rows: its caption, the header, every row, a horizontal scrollbar (0 when its columns fit), the border, and
 *  its strip when it shows one. */
export const contentHeight = (rows: number, scrollbar: number, strip: boolean): number =>
  g.captionHeight + g.headerHeight + Math.max(0, rows) * g.rowHeight + Math.max(0, scrollbar) + g.stackBorder + (strip ? g.stripHeight : 0)

export interface StackLayout {
  readonly heights: readonly number[]
  /** Each grid's top, splitters included. */
  readonly offsets: readonly number[]
  /** The stack's height: the pane's, or more when the minimum heights overflow it. */
  readonly total: number
}
export interface StackSizing {
  /** Each set's `contentHeight` once it has all its rows; undefined while it streams. Weights from a splitter drag replace it as
   *  the set's height, but a set with fewer rows than the minimum may still shrink only to them. */
  readonly content?: readonly (number | undefined)[]
  /** The sets shown as their caption alone. */
  readonly collapsed?: ReadonlySet<number>
}

/**
 * Whole-pixel heights. Without weights, a set whose content fits in its share takes its content, repeatedly, and the
 * others share the rest: h_i = max(minHeight, rest × w_i / Σw), with the rounding remainder handed out one pixel at a time
 * from the top, so equal weights give heights within 1 px of each other. One set fills the pane.
 */
export function stackLayout(paneHeight: number, count: number, weights: readonly number[] | undefined, minHeight: number, sizing: StackSizing = {}): StackLayout {
  const pane = Math.max(0, Math.floor(paneHeight))
  if (count <= 0) return { heights: [], offsets: [], total: 0 }
  const collapsed = sizing.collapsed
  if (count === 1) { const height = collapsed?.has(0) ? g.captionHeight : pane; return { heights: [height], offsets: [0], total: pane } }
  const valid = weights?.length === count && weights.every(weight => Number.isFinite(weight) && weight > 0) ? weights : undefined
  const weightOf = (index: number) => valid ? valid[index] : 1
  const content = valid ? undefined : sizing.content
  const heights = new Array<number>(count).fill(0)
  let rest = Math.max(0, pane - (count - 1) * g.splitter)
  const open: number[] = []
  for (let index = 0; index < count; index++) {
    if (collapsed?.has(index)) { heights[index] = g.captionHeight; rest -= g.captionHeight } else open.push(index)
  }
  rest = Math.max(0, rest)
  // Sets whose content fits in their share keep it; their room goes to the others, whose shares only grow.
  let flexible = open
  for (let changed = true; changed && flexible.length > 0;) {
    changed = false
    let sum = 0
    for (const index of flexible) sum += weightOf(index)
    const next: number[] = []
    const room = rest
    for (const index of flexible) {
      const fit = content?.[index]
      if (fit !== undefined && fit <= room * weightOf(index) / sum) { heights[index] = fit; rest -= fit; changed = true } else next.push(index)
    }
    flexible = next
  }
  // When every open set fits, what is left stays below the last one: stretching one would show it with empty rows.
  if (flexible.length > 0) {
    let sum = 0, assigned = 0
    for (const index of flexible) sum += weightOf(index)
    for (const index of flexible) { heights[index] = Math.floor(rest * weightOf(index) / sum); assigned += heights[index] }
    for (let at = 0, remainder = rest - assigned; at < flexible.length && remainder > 0; at++, remainder--) heights[flexible[at]]++
  }
  const offsets = new Array<number>(count)
  let top = 0
  const floors = setFloors(count, minHeight, sizing)
  for (let index = 0; index < count; index++) {
    heights[index] = Math.max(floors[index], heights[index])
    offsets[index] = top
    top += heights[index] + (index < count - 1 ? g.splitter : 0)
  }
  return { heights, offsets, total: Math.max(pane, top) }
}

/**
 * The shortest each set may be: a collapsed set its caption, one sized to its rows those rows (when fewer than the minimum),
 * any other the minimum. The layout and the splitters keep to the same floors, so a splitter never moves a set the other way.
 */
export function setFloors(count: number, minHeight: number, sizing: StackSizing = {}): number[] {
  const floors = new Array<number>(Math.max(0, count))
  for (let index = 0; index < floors.length; index++) floors[index] = sizing.collapsed?.has(index) ? g.captionHeight : Math.min(minHeight, sizing.content?.[index] ?? minHeight)
  return floors
}

/** The stack's height when every set is at its floor, splitters included: the room it needs before it scrolls. */
export function stackMinimum(count: number, minHeight: number, sizing: StackSizing = {}): number {
  if (count <= 0) return 0
  let total = (count - 1) * g.splitter
  for (const floor of setFloors(count, minHeight, sizing)) total += floor
  return total
}

/** Whether the splitter below set `index` moves anything: not when either set beside it is collapsed (a caption has no height to give). */
export const splitterMoves = (count: number, index: number, collapsed?: ReadonlySet<number>): boolean => index >= 0 && index < count - 1 && !collapsed?.has(index) && !collapsed?.has(index + 1)

/**
 * Heights after dragging the splitter below grid `index` by `delta` pixels: the boundary moves, the two grids keep
 * their combined height and at least their floors (`setFloors`). ±Infinity moves it as far as it goes (Home and End). The
 * result is the new weights; a splitter beside a collapsed set changes nothing.
 */
export function dragSplitter(heights: readonly number[], index: number, delta: number, floors: readonly number[], collapsed?: ReadonlySet<number>): number[] {
  const next = [...heights]
  if (!splitterMoves(heights.length, index, collapsed) || Number.isNaN(delta)) return next
  const pair = heights[index] + heights[index + 1], low = floors[index] ?? 0, high = pair - (floors[index + 1] ?? 0)
  // When the pair is shorter than both floors, the boundary stays where it is.
  if (high < low) return next
  next[index] = Math.round(Math.min(Math.max(heights[index] + delta, low), high))
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
