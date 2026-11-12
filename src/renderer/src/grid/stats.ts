import type { TileCounters } from './data'

/** What test mode reads from a mounted grid. */
export interface StatsSource { counters(): TileCounters; nodes(): number; setScrollCap(px: number | undefined): void }
export interface GridStatsSnapshot { frames: number[]; hits: number; misses: number; nodes: number; grids: number }

/**
 * Test mode's grid counters (`window.__variaGrid`, smoke tests and the grid benchmark): the last 1,024 frame times, tile
 * hits and misses, and the DOM elements of the mounted grids. `setScrollCap` lowers the scroll cap of every grid, so a
 * smoke test reaches Mode B without a million-pixel spacer.
 */
export class GridStats {
  private readonly times = new Float64Array(1024)
  private count = 0
  private readonly sources = new Set<StatsSource>()
  private retired: TileCounters = { hits: 0, misses: 0 }
  private cap: number | undefined
  get scrollCap(): number | undefined { return this.cap }
  frame(ms: number): void { this.times[this.count++ % this.times.length] = ms }
  add(source: StatsSource): () => void {
    this.sources.add(source)
    return () => {
      if (!this.sources.delete(source)) return
      const counters = source.counters()
      this.retired = { hits: this.retired.hits + counters.hits, misses: this.retired.misses + counters.misses }
    }
  }
  snapshot(): GridStatsSnapshot {
    const length = Math.min(this.count, this.times.length), frames: number[] = []
    for (let index = this.count - length; index < this.count; index++) frames.push(this.times[index % this.times.length])
    let hits = this.retired.hits, misses = this.retired.misses, nodes = 0
    for (const source of this.sources) { const counters = source.counters(); hits += counters.hits; misses += counters.misses; nodes += source.nodes() }
    return { frames, hits, misses, nodes, grids: this.sources.size }
  }
  reset(): void {
    this.count = 0
    this.retired = { hits: 0, misses: 0 }
    for (const source of this.sources) { const counters = source.counters(); counters.hits = 0; counters.misses = 0 }
  }
  setScrollCap(px: number | undefined): void {
    this.cap = px === undefined || !Number.isFinite(px) || px <= 0 ? undefined : Math.floor(px)
    for (const source of this.sources) source.setScrollCap(this.cap)
  }
}
