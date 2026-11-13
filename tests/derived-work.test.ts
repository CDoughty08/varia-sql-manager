import { describe, expect, it, vi } from 'vitest'
import { DerivedWork, derivedLimits } from '../src/renderer/src/results/derived-work'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
/** A promise to settle by hand. */
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('derived work places', () => {
  it('runs four at once and starts the rest in the order asked as places free; a free place starts the work at once', async () => {
    const work = new DerivedWork({ timers: manualTimers().timers })
    expect(derivedLimits.parallel).toBe(4)
    const jobs = Array.from({ length: 6 }, () => held<number>())
    const started: number[] = []
    const done = jobs.map((job, at) => work.run(() => { started.push(at); return job.promise }, new AbortController().signal))
    // The first four went out without waiting a turn.
    expect(started).toEqual([0, 1, 2, 3])
    expect([work.running, work.waiting]).toEqual([4, 2])
    jobs[2].resolve(2)
    await settle()
    expect(started).toEqual([0, 1, 2, 3, 4])
    jobs[0].reject(new Error('failed'))
    await settle()
    expect(started).toEqual([0, 1, 2, 3, 4, 5])
    for (const job of jobs) job.resolve(0)
    const outcomes = await Promise.allSettled(done)
    expect(outcomes.map(item => item.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
    expect([work.running, work.waiting]).toEqual([0, 0])
  })

  it('stops a wait when its signal aborts, and the next in line takes the place', async () => {
    const work = new DerivedWork({ parallel: 1, timers: manualTimers().timers })
    const first = held<string>()
    const running = work.run(() => first.promise, new AbortController().signal)
    const given = new AbortController()
    const later = vi.fn(async () => 'later'), last = vi.fn(async () => 'last')
    const waiting = work.run(later, given.signal)
    const after = work.run(last, new AbortController().signal)
    given.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    first.resolve('first')
    await expect(running).resolves.toBe('first')
    await expect(after).resolves.toBe('last')
    expect(later).not.toHaveBeenCalled()
  })

  it('asks again after 1, 4 and 16 s on a busy refusal only, giving the place back meanwhile, then fails with the refusal', async () => {
    const clock = manualTimers()
    const work = new DerivedWork({ parallel: 1, timers: clock.timers })
    const busy = vi.fn(async () => { throw new ResultError('BUSY', 'No result slot freed in time.') })
    const outcome = work.run(busy, new AbortController().signal)
    outcome.catch(() => {})
    await settle()
    expect(busy).toHaveBeenCalledTimes(1)
    // The place is free while the retry waits: other work goes first.
    const other = vi.fn(async () => 'other')
    await expect(work.run(other, new AbortController().signal)).resolves.toBe('other')
    for (const [wait, calls] of [[999, 1], [1, 2], [4_000, 3], [16_000, 4]] as const) {
      clock.advance(wait)
      await settle()
      expect(busy, `after ${wait} ms`).toHaveBeenCalledTimes(calls)
    }
    await expect(outcome).rejects.toMatchObject({ code: 'BUSY' })
    clock.advance(60_000)
    await settle()
    expect(busy).toHaveBeenCalledTimes(4)
    // TOO_MANY_REQUESTS is asked again too; TIMEOUT and other failures never are.
    const crowded = vi.fn().mockRejectedValueOnce(new ResultError('TOO_MANY_REQUESTS', 'Too many requests.')).mockResolvedValueOnce('done')
    const retried = work.run(crowded, new AbortController().signal)
    await settle()
    clock.advance(1_000)
    await expect(retried).resolves.toBe('done')
    const late = vi.fn(async () => { throw new ResultError('TIMEOUT', 'Timed out.') })
    await expect(work.run(late, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('gives up a retry\'s wait when its signal aborts', async () => {
    const clock = manualTimers()
    const work = new DerivedWork({ timers: clock.timers })
    const abort = new AbortController()
    const busy = vi.fn(async () => { throw new ResultError('BUSY', 'Busy.') })
    const outcome = work.run(busy, abort.signal)
    outcome.catch(() => {})
    await settle()
    expect(clock.pending.size).toBe(1)
    abort.abort()
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    expect(clock.pending.size).toBe(0)
    expect(busy).toHaveBeenCalledTimes(1)
  })
})
