import type { ResultHandle } from '../results/ResultClient'
import { browserTimers, type Timers } from '../core/timers'

/** Rows one results.rowBytes asks for, blocks kept at most, blocks asked at once, retry wait, and outlier thresholds. */
export const rowSizeLimits = { blockRows: 256, blocks: 64, inflight: 2, retryMs: 2000, unchangedWakes: 3, outlierBytes: 4096, outlierFactor: 2.5 } as const

/** A row's size as the row-size bar draws it: its share of the largest row (0 – 1), whether it is a large outlier
 *  (over half the largest row and either at least 4 KiB or 2.5× the mean row), and its exact bytes, `estimated` when an
 *  estimated cell took part. */
export interface RowSize { readonly bytes: number; readonly share: number; readonly large: boolean; readonly estimated: boolean }

interface Block { readonly bytes: readonly number[]; readonly estimated: ReadonlySet<number>; readonly sum: number }

/**
 * The row-size bar's data for one handle: each row's bytes (results.rowBytes, by view position through a view), read in
 * blocks of 256 only for the rows in view, at most 64 blocks kept (least recently used go), and the largest row of the
 * whole result (or view) from a profile of no columns (results.profile), asked once the set completes. Until that
 * arrives, and while a row read is larger, the largest row read scales the bars. Nothing here is per row in the DOM:
 * GridView asks for the rows it paints.
 */
export class RowSizes {
  private readonly blocks = new Map<number, Block>()
  private readonly pending = new Map<number, AbortController>()
  /** Blocks whose read failed, by when: not asked again for a while, so a refusal never repeats every frame. */
  private readonly failed = new Map<number, number>()
  private readonly abort = new AbortController()
  private profiled = false
  /** When the last profile failed (BUSY, TOO_LARGE): asked again once it has waited, as a failed block is. */
  private profileFailedAt: number | undefined
  private profileMax = 0
  private profileAverage = 0
  private readMax = 0
  private readSum = 0
  private readCount = 0
  private disposed = false
  /** The result's revision the blocks were read under: a residence switch reads them again. */
  private revision: number | undefined
  /** One repaint once a windowed short block has waited: nothing else paints a grid whose cells have all arrived. */
  private wakeTimer: unknown
  /** When the wake is due: the earliest block wake still to come. */
  private wakeDue = 0
  /** Each windowed short block's most rows answered, how often since it answered no more, and when it is next asked: a block
   *  still fetching waits twice as long each time, a few times, so one that never fits the cache (or whose rows come and go)
   *  stops asking rather than polling. */
  private readonly woken = new Map<number, { rows: number; unchanged: number; due: number }>()

  constructor(private readonly handle: Pick<ResultHandle, 'getSnapshot' | 'rowBytes' | 'profile'>, private readonly changed: () => void, private readonly timers: Timers = browserTimers) {}

  /** The bytes scaling the bars: the largest row known. */
  get max(): number { return Math.max(this.profileMax, this.readMax) }
  /** Mean row bytes: the whole set's from profile once it arrives, else the held blocks' running mean. */
  private get average(): number { return this.profileAverage > 0 ? this.profileAverage : this.readCount > 0 ? this.readSum / this.readCount : 0 }

  /** Asks for the blocks covering rows [first, last] that are not held, and for the result's largest row. */
  ensure(first: number, last: number): void {
    if (this.disposed) return
    const snapshot = this.handle.getSnapshot()
    if (snapshot.state === 'released' || snapshot.state === 'lost' || snapshot.rowsAvailable <= 0) return
    if (snapshot.revision !== this.revision) {
      this.revision = snapshot.revision
      for (const controller of this.pending.values()) controller.abort()
      this.pending.clear()
      this.blocks.clear()
      this.readSum = 0
      this.readCount = 0
      this.failed.clear()
      this.woken.clear()
    }
    // The largest row of the whole set is asked for once it is complete: profiling a set still streaming would scan its
    // rows again for every page, and compete with the reads that paint its first rows.
    const waited = this.profileFailedAt === undefined || performance.now() - this.profileFailedAt >= rowSizeLimits.retryMs
    // A windowed BigQuery result has no profile (REMOTE_RESULT) until it is loaded into memory.
    if (!this.profiled && waited && snapshot.state === 'complete' && snapshot.residence !== 'remote') this.profile()
    const end = Math.min(last, snapshot.rowsAvailable - 1)
    for (let block = Math.floor(Math.max(0, first) / rowSizeLimits.blockRows); block * rowSizeLimits.blockRows <= end; block++) {
      const held = this.blocks.get(block)
      // A block read while rows were still arriving is read again once more of its rows are available.
      const short = held && held.bytes.length < rowSizeLimits.blockRows && block * rowSizeLimits.blockRows + held.bytes.length < snapshot.rowsAvailable
      if (held && !short) { this.blocks.delete(block); this.blocks.set(block, held); continue }
      if (this.pending.has(block) || this.pending.size >= rowSizeLimits.inflight) continue
      const failedAt = this.failed.get(block)
      // A windowed short block waits its own backoff; any other failed block the plain wait.
      const wait = rowSizeLimits.retryMs * 2 ** (this.woken.get(block)?.unchanged ?? 0)
      if (failedAt !== undefined && performance.now() - failedAt < wait) continue
      this.read(block)
    }
  }

  /** A row's size, when its block is held. */
  get(row: number): RowSize | undefined {
    const block = this.blocks.get(Math.floor(row / rowSizeLimits.blockRows))
    const at = row % rowSizeLimits.blockRows
    if (!block || at >= block.bytes.length) return undefined
    const bytes = block.bytes[at], max = this.max
    const share = max > 0 ? Math.min(1, bytes / max) : 0
    const average = this.average
    const large = share > 0.5 && (bytes >= rowSizeLimits.outlierBytes || (average > 0 && bytes >= average * rowSizeLimits.outlierFactor))
    return { bytes, share, large, estimated: block.estimated.has(row) }
  }

  dispose(): void {
    this.disposed = true
    if (this.wakeTimer !== undefined) this.timers.clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    this.abort.abort()
    this.pending.clear()
    this.blocks.clear()
    this.readSum = 0
    this.readCount = 0
  }

  private read(block: number): void {
    const controller = new AbortController()
    const stop = () => controller.abort()
    this.abort.signal.addEventListener('abort', stop)
    this.pending.set(block, controller)
    const first = block * rowSizeLimits.blockRows
    const revision = this.revision
    this.handle.rowBytes(first, rowSizeLimits.blockRows, controller.signal).then(result => {
      if (this.disposed || revision !== this.revision) return
      const estimated = new Set(result.estimated)
      let sum = 0
      for (const bytes of result.bytes) { sum += bytes; if (bytes > this.readMax) this.readMax = bytes }
      const previous = this.blocks.get(block)
      if (previous) { this.readSum -= previous.sum; this.readCount -= previous.bytes.length }
      this.blocks.set(block, { bytes: result.bytes, estimated, sum })
      this.readSum += sum
      this.readCount += result.bytes.length
      while (this.blocks.size > rowSizeLimits.blocks) {
        const oldestKey = this.blocks.keys().next().value!
        const oldest = this.blocks.get(oldestKey)!
        this.readSum -= oldest.sum
        this.readCount -= oldest.bytes.length
        this.blocks.delete(oldestKey)
      }
      // A windowed result answers only the rows its block cache holds: a short block is asked again once it has waited, as a
      // failed one is, not on every paint (its rows may be fetching, or never fit the cache).
      const short = result.bytes.length < rowSizeLimits.blockRows && first + result.bytes.length < this.handle.getSnapshot().rowsAvailable
      if (short && this.handle.getSnapshot().residence === 'remote') {
        this.failed.set(block, performance.now())
        // Its rows likely land meanwhile and the grid stops painting: one wake makes the next paint ask again. A block
        // that grew waits the wait; one that did not (still fetching, or never fits) waits twice as long each time, a few
        // times only.
        const last = this.woken.get(block)
        const unchanged = last === undefined || result.bytes.length > last.rows ? 0 : last.unchanged + 1
        const rows = Math.max(last?.rows ?? 0, result.bytes.length)
        if (unchanged <= rowSizeLimits.unchangedWakes) {
          this.woken.set(block, { rows, unchanged, due: performance.now() + rowSizeLimits.retryMs * 2 ** unchanged + 1 })
          this.wake()
        } else this.woken.set(block, { rows, unchanged: rowSizeLimits.unchangedWakes, due: 0 })
      } else {
        this.failed.delete(block)
        this.woken.delete(block)
      }
      if (result.bytes.length > 0) this.changed()
    }, () => {
      // A failed read leaves the block's bars empty; the grid asks again as it scrolls, once the block has waited.
      if (!this.disposed && !controller.signal.aborted) this.failed.set(block, performance.now())
    }).finally(() => {
      this.abort.signal.removeEventListener('abort', stop)
      if (this.pending.get(block) === controller) this.pending.delete(block)
    })
  }

  /** Arms the one wake for the earliest block wake still to come; when it fires it paints, then arms for the next. */
  private wake(): void {
    const now = performance.now()
    let due = Infinity
    for (const entry of this.woken.values()) if (entry.due > now && entry.due < due) due = entry.due
    if (this.wakeTimer !== undefined && this.wakeDue === due) return
    if (this.wakeTimer !== undefined) this.timers.clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    if (due === Infinity) return
    this.wakeDue = due
    this.wakeTimer = this.timers.setTimeout(() => {
      this.wakeTimer = undefined
      if (this.disposed) return
      this.changed()
      this.wake()
    }, due - now)
  }

  private profile(): void {
    this.profiled = true
    this.handle.profile([], this.abort.signal).then(result => {
      if (this.disposed) return
      this.profileMax = result.rowBytes?.max ?? 0
      this.profileAverage = result.rowBytes?.average ?? 0
      this.profileFailedAt = undefined
      this.changed()
    }, () => {
      // The rows read scale the bars meanwhile; a paint after the wait asks again.
      if (this.disposed) return
      this.profiled = false
      this.profileFailedAt = performance.now()
    })
  }
}
