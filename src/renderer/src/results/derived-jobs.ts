import { browserTimers, type Timers } from '../core/timers'
import { ResultError } from './ResultClient'

/**
 * Pivot builds (and, from PR 16, comparisons) that run at once in a window, and the waits before asking again when the backend or the
 * results port is busy: 1 s, 4 s, then 16 s, as HighlightsService waits.
 */
export const derivedLimits = { parallel: 4, retryMs: [1_000, 4_000, 16_000] } as const
/** Refusals that come before anything runs, so asking again is a new request, never a re-send. Never `TIMEOUT`: that one
 *  ran. */
const refusedBeforeRunning: ReadonlySet<string> = new Set(['BUSY', 'TOO_MANY_REQUESTS'])

const abortError = () => new DOMException('The work was cancelled.', 'AbortError')

/**
 * The window's places for derived results (a pivot build, a comparison): at most `derivedLimits.parallel` run at once and
 * the rest wait here, in the order asked, before the backend hears of them. Each holds one of the backend's result slots
 * for up to its deadline, so this keeps a window from taking them all. A task refused before it ran (`BUSY`,
 * `TOO_MANY_REQUESTS`) is asked again after each wait in turn, giving its place up while it waits, then fails with the
 * refusal's own sentence. A signal that aborts takes a waiting task out of the line.
 */
export class DerivedJobs {
  private readonly timers: Timers
  private readonly limit: number
  private running = 0
  private readonly waiting: { readonly start: () => void; readonly signal?: AbortSignal }[] = []

  constructor(o: { timers?: Timers; limit?: number } = {}) {
    this.timers = o.timers ?? browserTimers
    this.limit = o.limit ?? derivedLimits.parallel
  }

  /** How many run now, and how many wait for a place. */
  get load(): { readonly running: number; readonly waiting: number } { return { running: this.running, waiting: this.waiting.length } }

  /** Runs `task` once it has a place, asking again on a refusal that came before it ran. `onWait` says why it waits (for a
   *  place, or to ask a busy backend again) and `onStart` says each time it has its place, for a builder that shows it. */
  async run<T>(task: (signal?: AbortSignal) => Promise<T>, o: { signal?: AbortSignal; onWait?: (why: 'place' | 'busy') => void; onStart?: () => void } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // A free place is taken at once, so the backend is asked in the same task as the click.
      if (o.signal?.aborted) throw abortError()
      if (this.running < this.limit) this.running++
      else {
        o.onWait?.('place')
        await this.place(o.signal)
      }
      try {
        // Given up while it waited for its place.
        if (o.signal?.aborted) throw abortError()
        o.onStart?.()
        return await task(o.signal)
      } catch (error) {
        if (!(error instanceof ResultError) || !refusedBeforeRunning.has(error.code) || attempt >= derivedLimits.retryMs.length || o.signal?.aborted) throw error
      } finally {
        this.free()
      }
      o.onWait?.('busy')
      await this.wait(derivedLimits.retryMs[attempt], o.signal)
    }
  }

  /** Waits in line for a place. */
  private place(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const item = {
        signal,
        start: () => { signal?.removeEventListener('abort', leave); this.running++; resolve() }
      }
      const leave = () => {
        const at = this.waiting.indexOf(item)
        if (at >= 0) this.waiting.splice(at, 1)
        reject(abortError())
      }
      signal?.addEventListener('abort', leave, { once: true })
      this.waiting.push(item)
    })
  }

  private free(): void {
    this.running--
    this.waiting.shift()?.start()
  }

  private wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', stop); resolve() }
      const handle = this.timers.setTimeout(done, ms)
      const stop = () => { this.timers.clearTimeout(handle); reject(abortError()) }
      signal?.addEventListener('abort', stop, { once: true })
    })
  }
}
