import { gridLimits as g } from './constants'
import type { ColumnAxis } from './layout'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** The widths a transposed grid keeps in its saved state: one shared width, and the columns sized apart from it (in the
 *  order they were sized, the oldest first). */
export interface UniformWidths { width: number; overrides: Map<number, number> }
/** How many columns may have a width of their own; the one sized longest ago gives way to a new one. */
export const maxWidthOverrides = 256

/**
 * Column offsets of a transposed grid (a ColumnAxis). Its columns are the result's rows, so there can be 4,095 of them,
 * their number grows while rows stream, and none has a header of its own to size it by. They share one width; at most 256
 * have their own. A column's offset is its index times the shared width plus what the overrides before it add: O(log
 * overrides), with nothing to rebuild when the count or the shared width changes (ColumnLayout's prefix sums cost
 * O(columns) for either). The total never exceeds `maxTotal` through a width set here; a count that grows is the caller's
 * to bound (4,095 columns of the widest shared width are far inside the scroll range).
 */
export class UniformLayout implements ColumnAxis {
  private columns = 0
  private maxTotal: number
  /** Overridden columns ascending, and the running sum of (override − shared width) through each. */
  private at: number[] = []
  private extra: number[] = []

  constructor(private readonly state: UniformWidths, maxTotal: number) {
    this.maxTotal = Math.max(0, maxTotal)
    state.width = clamp(Math.round(Number.isFinite(state.width) ? state.width : g.initialMinWidth), g.columnMinWidth, g.columnMaxWidth)
    for (const [column, width] of [...state.overrides]) {
      if (!Number.isInteger(column) || column < 0 || !Number.isFinite(width)) state.overrides.delete(column)
      else state.overrides.set(column, clamp(Math.round(width), g.columnMinWidth, g.columnMaxWidth))
    }
    this.rebuild()
  }
  get count(): number { return this.columns }
  /** The width columns have unless sized on their own. */
  get shared(): number { return this.state.width }
  get total(): number { return this.xOf(this.columns) }
  width(column: number): number { return this.state.overrides.get(column) ?? this.state.width }
  xOf(column: number): number {
    const index = clamp(column, 0, this.columns)
    return index * this.state.width + this.extraBefore(index)
  }
  columnAt(x: number): number {
    if (x < 0 || this.columns === 0) return -1
    if (x >= this.total) return this.columns
    let low = 0, high = this.columns - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.xOf(middle) <= x) low = middle
      else high = middle - 1
    }
    return low
  }
  /** The columns drawn: the result's rows so far, up to the cap. Overrides past the count are kept for when rows return. */
  setCount(count: number): void { this.columns = Math.max(0, Math.floor(count)) }
  /** One column's own width (a border drag, Fit Column), within [32, 3,000] and the total's cap; returns the width set. */
  setWidth(column: number, width: number): number {
    const old = this.width(column)
    let next = clamp(Math.round(width), g.columnMinWidth, g.columnMaxWidth)
    if (next > old) next = Math.max(old, Math.min(next, old + this.maxTotal - this.total))
    if (next === old) return old
    const overrides = this.state.overrides
    overrides.delete(column)
    if (next !== this.state.width) {
      overrides.set(column, next)
      if (overrides.size > maxWidthOverrides) overrides.delete(overrides.keys().next().value!)
    }
    this.rebuild()
    return next
  }
  /** The shared width (the first rows' measure): every column without a width of its own takes it. */
  setShared(width: number): void {
    const room = this.columns > 0 ? Math.floor((this.maxTotal - this.extraBefore(this.columns)) / this.columns) : g.columnMaxWidth
    const next = clamp(Math.round(width), g.columnMinWidth, Math.max(g.columnMinWidth, Math.min(g.columnMaxWidth, room)))
    if (next === this.state.width) return
    this.state.width = next
    // An override equal to the new shared width is no longer one.
    for (const [column, own] of [...this.state.overrides]) if (own === next) this.state.overrides.delete(column)
    this.rebuild()
  }
  /** Positions name other rows after a new sort or filter: the widths the user gave them go. */
  clearOverrides(): void {
    if (this.state.overrides.size === 0) return
    this.state.overrides.clear()
    this.rebuild()
  }
  setMaxTotal(maxTotal: number): void { this.maxTotal = Math.max(0, maxTotal) }

  private extraBefore(column: number): number {
    let low = 0, high = this.at.length
    while (low < high) { const middle = (low + high) >> 1; if (this.at[middle] < column) low = middle + 1; else high = middle }
    return low === 0 ? 0 : this.extra[low - 1]
  }
  private rebuild(): void {
    this.at = [...this.state.overrides.keys()].sort((a, b) => a - b)
    let sum = 0
    this.extra = this.at.map(column => sum += this.state.overrides.get(column)! - this.state.width)
  }
}
