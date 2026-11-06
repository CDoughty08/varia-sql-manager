import { browserTimers, type Timers } from '../core/timers'
import type { ResultHandle, RowWindow } from '../results/ResultClient'
import { gridLimits as g } from './constants'
import type { VisibleRange } from './layout'
import { isFastScroll, isFrontier, planTiles, prefetchTiles, tileColumnOf, tileKey, tileRowOf } from './tiles'

/** Tile reads of one grid: counters for test mode's `__variaGrid.stats()`. */
export interface TileCounters { hits: number; misses: number }
interface Inflight { readonly controller: AbortController; missed: number }
const errorMessage = (error: unknown): string => error instanceof Error && error.message ? error.message : 'The rows could not be read.'
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'
const workerStopped = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'RESULT_DECODER_FAILED'
/** Main refused the read because its results port had too many reads open: a moment later it has room. */
export const portBusy = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'TOO_MANY_REQUESTS'

/**
 * What a grid has read of its result: tiles of 128 rows × 32 columns in the client's shared window cache, read centre
 * first, at most 4 at a time per grid and 16 per client. A tile the frame no longer wants for 2 frames is aborted. A
 * single jump reads at once, but while scrolling goes on faster than 3 views a frame nothing is read; reading starts 50 ms
 * after it settles. A tile read while its
 * rows were still arriving is read again (at most 10 a second) while it is in view. After 2 idle frames the tiles a view
 * above and below are read, and the worker prefetches pages 2 views either way. A failed read marks its tile until Retry.
 * A read refused while main's results port is full is tried again shortly, not marked. The active cell's tile is read
 * even when the cell is scrolled out of view, so its label has its text. A live table's row tone (a hidden last column,
 * `tone`) is read with the rows it colours: each row tile of the frame also reads the tile column that holds it.
 * A tile is read again only from where its rows end: when its rows' pages do not fit the worker's cache together (large
 * XML or JSON values), the worker answers with the rows it holds, and the tile's next part starts after them at once.
 */
export class GridData {
  readonly counters: TileCounters = { hits: 0, misses: 0 }
  private readonly handle: Pick<ResultHandle, 'getWindow' | 'peekWindow' | 'prefetch'>
  private readonly columns: number
  /** The hidden tone column (the result's last), or -1; tiles end at it rather than at `columns`. */
  private readonly tone: number
  private readonly clientInflight: () => number
  private readonly changed: () => void
  private readonly timers: Timers
  private readonly now: () => number
  private readonly inflight = new Map<number, Inflight>()
  private readonly errors = new Map<number, string>()
  /** Tiles that failed because the results worker stopped: read once more after it is recreated. */
  private readonly retried = new Set<number>()
  /** Where each tile read in parts has a part (its first row, the tile's own first); a tile read whole has none. */
  private readonly parts = new Map<number, number[]>()
  /** The windows a multi-part tile's `peek` last joined, and the join. */
  private readonly joined = new Map<number, { readonly windows: readonly RowWindow[]; readonly window: RowWindow }>()
  /** Tiles whose last read brought rows but stopped short of rows already available: read on at once, not throttled. */
  private readonly shortened = new Set<number>()
  private rows = 0
  private refetches: number[] = []
  private settleUntil = 0
  /** Frames in a row that moved more than 3 views. */
  private fastFrames = 0
  private timer: unknown
  private idleFrames = 0
  private prefetched = ''
  private disposed = false

  constructor(o: { handle: Pick<ResultHandle, 'getWindow' | 'peekWindow' | 'prefetch'>; columns: number; tone?: number; clientInflight: () => number; changed: () => void; timers?: Timers; now?: () => number }) {
    this.handle = o.handle
    this.columns = o.columns
    this.tone = o.tone ?? -1
    this.clientInflight = o.clientInflight
    this.changed = o.changed
    this.timers = o.timers ?? browserTimers
    this.now = o.now ?? (() => performance.now())
  }

  /** The tile's window, if the cache has it (and now as its most recently used): from the tile's first row, its parts
   *  joined up to the first one missing. */
  peek(key: number): RowWindow | undefined {
    const first = tileRowOf(key) * g.tileRows, colStart = tileColumnOf(key) * g.tileColumns
    const shape = { colStart, colEnd: this.colEnd(colStart), maxCellChars: g.maxCellChars, display: false }
    const head = this.handle.peekWindow(first, g.tileRows, shape)
    const starts = this.parts.get(key)
    if (!starts) return head
    const windows: RowWindow[] = []
    let end = first
    for (const start of starts) {
      if (start > end) break
      const window = start === first ? head : this.handle.peekWindow(start, first + g.tileRows - start, shape)
      if (!window || window.first + window.count <= end) continue
      windows.push(window)
      end = window.first + window.count
    }
    if (windows.length === 0) {
      // Every part left the cache: the tile is read from its start again.
      this.parts.delete(key)
      this.joined.delete(key)
      return undefined
    }
    if (windows.length === 1) return windows[0]
    const last = this.joined.get(key)
    if (last && last.windows.length === windows.length && last.windows.every((window, index) => window === windows[index])) return last.window
    const window = join(first, windows)
    this.joined.set(key, { windows, window })
    return window
  }
  /** The tile holding a row's tone, or undefined when the result has no tone column. */
  toneTile(row: number): number | undefined { return this.tone < 0 ? undefined : tileKey(Math.floor(row / g.tileRows), Math.floor(this.tone / g.tileColumns)) }
  /** The first failed read's message, while any tile has failed. */
  get error(): string | undefined { return this.errors.values().next().value }
  get reading(): number { return this.inflight.size }
  failed(key: number): boolean { return this.errors.has(key) }
  /** Retry: failed tiles are read again. */
  retry(): void {
    this.errors.clear()
    this.retried.clear()
    this.changed()
  }

  /**
   * Called once per frame with the rows and columns the frame renders, the rows available, how many rows the view
   * moved since the last frame, how many rows it shows, and the active cell. Returns whether the frame should be
   * followed by another one (idle frames before prefetching).
   */
  ensure(range: VisibleRange, rows: number, rowDelta: number, visibleRows: number, active?: { readonly row: number; readonly column: number }): boolean {
    if (this.disposed) return false
    this.rows = rows
    const plan = this.plan(range, rows)
    if (active && active.row >= 0 && active.row < rows && active.column >= 0 && active.column < this.columns) {
      const key = tileKey(Math.floor(active.row / g.tileRows), Math.floor(active.column / g.tileColumns))
      if (!plan.includes(key)) plan.push(key)
    }
    const ring = prefetchTiles(range, rows, this.columns)
    const wanted = new Set([...plan, ...ring])
    for (const [key, tile] of this.inflight) {
      if (wanted.has(key)) tile.missed = 0
      else if (++tile.missed >= g.abortAfterFrames) { tile.controller.abort(); this.inflight.delete(key) }
    }
    // One jump (a key, a click in the scroll bar's track) reads its tiles at once; a thumb dragged fast moves that far
    // frame after frame, and reads only once it settles.
    this.fastFrames = isFastScroll(rowDelta, visibleRows) ? this.fastFrames + 1 : 0
    if (plan.length === 0) return false
    const now = this.now()
    if (this.fastFrames >= 2) {
      this.settleUntil = now + g.settleMs
      this.wake(g.settleMs)
      return false
    }
    // A timer can fire before a settle that a later fast frame extended: wake again when it ends.
    if (now < this.settleUntil) { this.wake(this.settleUntil - now); return false }
    let missing = 0, issued = 0
    for (const key of plan) {
      if (this.errors.has(key)) continue
      const window = this.peek(key)
      if (this.inflight.has(key)) { if (!window) missing++; continue }
      if (window) {
        this.counters.hits++
        if (isFrontier(window, rows)) {
          // Rows that arrived since are read at most 10 times a second; rows the worker could not hold with the rest at once.
          const shortened = this.shortened.has(key)
          if (!shortened && !this.refetchAllowed(now)) { this.wake(1000 / g.frontierPerSecond); continue }
          if (!this.capacity()) continue
          if (!shortened) this.refetches.push(now)
          this.read(key, window.first + window.count)
          issued++
        }
        continue
      }
      this.counters.misses++
      missing++
      if (!this.capacity()) continue
      this.read(key)
      issued++
    }
    if (missing > 0 || issued > 0 || this.inflight.size > 0) {
      this.idleFrames = 0
      // Other grids hold the client's reads, and their answers wake only them: look again shortly.
      if (missing > 0 && this.inflight.size === 0) this.wake(g.settleMs)
      return false
    }
    if (++this.idleFrames < g.prefetchIdleFrames) return true
    this.prefetch(range, rows, ring)
    return false
  }

  /** The tiles a range shows, centre first, with the tile that holds each row tile's tone. */
  plan(range: VisibleRange, rows: number): number[] {
    const plan = planTiles(range, rows, this.columns)
    if (this.tone >= 0) for (const key of [...plan]) { const tone = this.toneTile(tileRowOf(key) * g.tileRows)!; if (!plan.includes(tone)) plan.push(tone) }
    return plan
  }
  /** Reads a tile into the client's window cache as a frame would, outside this grid's own reads (a live swap's prepare). */
  fetch(key: number, signal?: AbortSignal): Promise<RowWindow> {
    const colStart = tileColumnOf(key) * g.tileColumns
    return this.handle.getWindow(tileRowOf(key) * g.tileRows, g.tileRows, { colStart, colEnd: this.colEnd(colStart), maxCellChars: g.maxCellChars, textBudget: g.textBudget, display: false, signal })
  }

  dispose(): void {
    this.disposed = true
    for (const tile of this.inflight.values()) tile.controller.abort()
    this.inflight.clear()
    this.parts.clear()
    this.joined.clear()
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** A tile's end: its 32 columns, the shown ones, and the tone column when it is in the tile. */
  private colEnd(colStart: number): number { return Math.min(colStart + g.tileColumns, this.tone >= 0 ? this.tone + 1 : this.columns) }

  private capacity(): boolean { return this.inflight.size < g.fetchesPerGrid && this.clientInflight() < g.fetchesPerClient }

  private refetchAllowed(now: number): boolean {
    this.refetches = this.refetches.filter(at => now - at < 1000)
    return this.refetches.length < g.frontierPerSecond
  }

  /** Another frame after `ms`: reading resumes once scrolling settles or a refetch is allowed again. */
  private wake(ms: number): void {
    if (this.timer !== undefined) return
    this.timer = this.timers.setTimeout(() => { this.timer = undefined; if (!this.disposed) this.changed() }, ms)
  }

  /** Reads a tile from `from` (its first row, or where its rows end) to its end. */
  private read(key: number, from = tileRowOf(key) * g.tileRows): void {
    const controller = new AbortController(), tile: Inflight = { controller, missed: 0 }
    const first = tileRowOf(key) * g.tileRows, end = first + g.tileRows, colStart = tileColumnOf(key) * g.tileColumns
    this.inflight.set(key, tile)
    this.shortened.delete(key)
    if (from > first) {
      const starts = this.parts.get(key) ?? [first]
      if (!starts.includes(from)) { starts.push(from); starts.sort((a, b) => a - b) }
      this.parts.set(key, starts)
    }
    this.handle.getWindow(from, end - from, {
      colStart, colEnd: this.colEnd(colStart), maxCellChars: g.maxCellChars, textBudget: g.textBudget, display: false, signal: controller.signal
    }).then(window => {
      if (this.inflight.get(key) === tile) this.inflight.delete(key)
      this.retried.delete(key)
      // Fewer rows than were there: the worker could not hold them all (a still arriving tile ends at the rows available).
      if (window.count > 0 && window.first + window.count < Math.min(end, this.rows)) this.shortened.add(key)
      if (!this.disposed) this.changed()
    }, error => {
      if (this.inflight.get(key) === tile) this.inflight.delete(key)
      if (this.disposed || isAbort(error)) return
      if (portBusy(error)) { this.wake(g.busyRetryMs); return }
      if (workerStopped(error) && !this.retried.has(key)) this.retried.add(key)
      else this.errors.set(key, errorMessage(error))
      this.changed()
    })
  }

  /** The tiles a view above and below (read into the cache), then the worker's pages two views either way. */
  private prefetch(range: VisibleRange, rows: number, ring: readonly number[]): void {
    for (const key of ring) {
      if (!this.capacity()) return
      if (this.errors.has(key) || this.inflight.has(key) || this.peek(key)) continue
      this.read(key)
    }
    const height = range.lastRow - range.firstRow + 1
    const first = Math.max(0, range.firstRow - g.prefetchViewports * height), last = Math.min(rows, range.lastRow + 1 + g.prefetchViewports * height)
    const at = `${first}:${last}`
    if (at === this.prefetched || last <= first) return
    this.prefetched = at
    this.handle.prefetch(first, last - first)
  }
}

/** A tile's parts as one window from `first`: each part's rows from where the ones before it end. */
function join(first: number, windows: readonly RowWindow[]): RowWindow {
  const { colStart, colEnd } = windows[0], width = colEnd - colStart
  const last = windows.at(-1)!, count = last.first + last.count - first
  const text = new Array<string>(count * width), flags = new Uint8Array(count * width)
  let end = first
  for (const window of windows) {
    const skip = end - window.first, rows = window.count - skip
    for (let index = 0; index < rows * width; index++) text[(end - first) * width + index] = window.text[skip * width + index]
    flags.set(window.flags.subarray(skip * width, (skip + rows) * width), (end - first) * width)
    end += rows
  }
  return { first, count, colStart, colEnd, text, flags }
}
