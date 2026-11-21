import type { ResultHandle } from '../results/ResultClient'
import { browserTimers, type Timers } from '../core/timers'

/** Rows one results.rowBytes asks for, blocks kept at most, blocks asked at once, and how long a failed block waits. */
export const rowSizeLimits = { blockRows: 256, blocks: 64, inflight: 2, retryMs: 2000 } as const

/** A row's size as the row-size bar draws it: its share of the largest row (0 – 1), whether it is over half of it, and
 *  its exact bytes, `estimated` when an estimated cell took part. */
export interface RowSize { readonly bytes: number; readonly share: number; readonly large: boolean; readonly estimated: boolean }

interface Block { readonly bytes: readonly number[]; readonly estimated: ReadonlySet<number> }

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
  private readMax = 0
  private disposed = false
  /** The result's revision the blocks were read under: a residence switch reads them again. */
  private revision: number | undefined
  /** One repaint once a windowed short block has waited: nothing else paints a grid whose cells have all arrived. */
  private wakeTimer: unknown
  /** The rows each windowed short block answered when it last armed the wake: it arms again only once it has grown, so a
   *  block that never fits the cache stops asking rather than polling. */
  private readonly woken = new Map<number, number>()

  constructor(private readonly handle: Pick<ResultHandle, 'getSnapshot' | 'rowBytes' | 'profile'>, private readonly changed: () => void, private readonly timers: Timers = browserTimers) {}

  /** The bytes scaling the bars: the largest row known. */
  get max(): number { return Math.max(this.profileMax, this.readMax) }

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
      if (failedAt !== undefined && performance.now() - failedAt < rowSizeLimits.retryMs) continue
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
    return { bytes, share, large: share > 0.5, estimated: block.estimated.has(row) }
  }

  dispose(): void {
    this.disposed = true
    if (this.wakeTimer !== undefined) this.timers.clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    this.abort.abort()
    this.pending.clear()
    this.blocks.clear()
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
      this.blocks.set(block, { bytes: result.bytes, estimated })
      while (this.blocks.size > rowSizeLimits.blocks) this.blocks.delete(this.blocks.keys().next().value!)
      for (const bytes of result.bytes) if (bytes > this.readMax) this.readMax = bytes
      // A windowed result answers only the rows its block cache holds: a short block is asked again once it has waited, as a
      // failed one is, not on every paint (its rows may be fetching, or never fit the cache).
      const short = result.bytes.length < rowSizeLimits.blockRows && first + result.bytes.length < this.handle.getSnapshot().rowsAvailable
      if (short && this.handle.getSnapshot().residence === 'remote') {
        this.failed.set(block, performance.now())
        // Its rows likely land meanwhile and the grid stops painting: one wake makes the next paint ask again, while the
        // block keeps growing.
        const last = this.woken.get(block)
        if (last === undefined || result.bytes.length > last) {
          this.woken.set(block, result.bytes.length)
          this.wakeTimer ??= this.timers.setTimeout(() => {
            this.wakeTimer = undefined
            if (!this.disposed) this.changed()
          }, rowSizeLimits.retryMs + 1)
        }
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

  private profile(): void {
    this.profiled = true
    this.handle.profile([], this.abort.signal).then(result => {
      if (this.disposed) return
      this.profileMax = result.rowBytes?.max ?? 0
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
