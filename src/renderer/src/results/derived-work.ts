import { browserTimers, type Timers } from '../core/timers'

/** At most four derived results (comparisons; Pivot builds can share it) build at once per window, each holding one of the
 *  backend's 16 result slots for up to its deadline; a refusal before anything ran is asked again after 1, 4 and 16 s. */
export const derivedLimits = { parallel: 4, retryMs: [1_000, 4_000, 16_000] } as const
/** The refusals that come before anything ran (the results port's 64 outstanding requests, no result slot free in the
 *  backend), so asking again is a new request, not a re-send. Never TIMEOUT. */
const refusedBeforeRunning: ReadonlySet<string> = new Set(['TOO_MANY_REQUESTS', 'BUSY'])

const aborted = () => new DOMException('The work was given up.', 'AbortError')

/**
 * The window's places for derived results built in the backend (plan: Concurrency and limits). `run` starts the work at
 * once while one of `derivedLimits.parallel` places is free, else waits for one in the order asked. A TOO_MANY_REQUESTS or
 * BUSY refusal gives the place back and asks again after each of `derivedLimits.retryMs` in turn, then fails with the
 * refusal. Aborting the signal stops a wait (rejecting with an AbortError) or reaches the work, which is passed it.
 */
export class DerivedWork {
  private readonly timers: Timers
  private readonly parallel: number
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(o: { timers?: Timers; parallel?: number } = {}) {
    this.timers = o.timers ?? browserTimers
    this.parallel = o.parallel ?? derivedLimits.parallel
  }

  /** Work running now, and work waiting for a place. */
  get running(): number { return this.active }
  get waiting(): number { return this.queue.length }

  run<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> { return this.attempt(work, signal, 0) }

  private attempt<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, attempt: number): Promise<T> {
    if (signal.aborted) return Promise.reject(aborted())
    const start = (): Promise<T> => {
      let started: Promise<T>
      try { started = work(signal) } catch (error) { started = Promise.reject(error) }
      return started.then(value => { this.releasePlace(); return value }, (error: unknown) => {
        this.releasePlace()
        const code = (error as { code?: unknown } | undefined)?.code
        if (signal.aborted || typeof code !== 'string' || !refusedBeforeRunning.has(code) || attempt >= derivedLimits.retryMs.length) throw error
        return this.delay(derivedLimits.retryMs[attempt], signal).then(() => this.attempt(work, signal, attempt + 1))
      })
    }
    // A free place: the request goes out now, not a turn later.
    if (this.active < this.parallel) { this.active++; return start() }
    return this.wait(signal).then(start)
  }

  /** Waits for a place, which is taken for the caller when given. */
  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const go = () => { signal.removeEventListener('abort', stop); this.active++; resolve() }
      const stop = () => {
        const at = this.queue.indexOf(go)
        if (at >= 0) this.queue.splice(at, 1)
        reject(aborted())
      }
      this.queue.push(go)
      signal.addEventListener('abort', stop, { once: true })
    })
  }

  private releasePlace(): void {
    this.active--
    if (this.active < this.parallel) this.queue.shift()?.()
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(aborted())
    return new Promise((resolve, reject) => {
      const stop = () => { this.timers.clearTimeout(handle); reject(aborted()) }
      const handle = this.timers.setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
      signal.addEventListener('abort', stop, { once: true })
    })
  }
}
