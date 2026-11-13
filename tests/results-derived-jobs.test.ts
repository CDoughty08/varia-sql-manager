import { describe, expect, it } from 'vitest'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { deferred } from './fixtures/documents'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('DerivedJobs', () => {
  it('starts a task at once while a place is free, queues the rest in order, and lets an aborted one leave the line', async () => {
    const jobs = new DerivedJobs({ limit: 2 })
    const started: string[] = []
    const gates = ['a', 'b', 'c', 'd'].map(() => deferred<void>())
    const task = (name: string, at: number) => () => { started.push(name); return gates[at].promise }
    const a = jobs.run(task('a', 0)), b = jobs.run(task('b', 1))
    // Asked in the same task as the call, with no wait.
    expect(started).toEqual(['a', 'b'])
    const leaving = new AbortController()
    const c = jobs.run(task('c', 2), { signal: leaving.signal }), d = jobs.run(task('d', 3))
    expect(jobs.load).toEqual({ running: 2, waiting: 2 })
    leaving.abort()
    await expect(c).rejects.toMatchObject({ name: 'AbortError' })
    expect(jobs.load).toEqual({ running: 2, waiting: 1 })
    gates[0].resolve()
    await a
    await settle()
    expect(started).toEqual(['a', 'b', 'd'])
    gates[1].resolve(); gates[3].resolve()
    await Promise.all([b, d])
    expect(jobs.load).toEqual({ running: 0, waiting: 0 })
    // A task already aborted is never asked.
    const gone = new AbortController()
    gone.abort()
    await expect(jobs.run(task('e', 0), { signal: gone.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toEqual(['a', 'b', 'd'])
  })

  it('asks again only on BUSY and TOO_MANY_REQUESTS, giving its place up while it waits, and stops when aborted', async () => {
    const timers = manualTimers()
    const jobs = new DerivedJobs({ timers: timers.timers, limit: 1 })
    let calls = 0
    const refused = jobs.run(async () => { calls++; if (calls < 3) throw new ResultError(calls === 1 ? 'TOO_MANY_REQUESTS' : 'BUSY', 'Busy.'); return 'built' })
    await settle()
    expect(calls).toBe(1)
    // While it waits, its place is free for another.
    const other = deferred<string>()
    const beside = jobs.run(() => other.promise)
    expect(jobs.load).toEqual({ running: 1, waiting: 0 })
    other.resolve('other')
    await beside
    timers.advance(1_000)
    await settle()
    expect(calls).toBe(2)
    timers.advance(4_000)
    await expect(refused).resolves.toBe('built')
    // Anything else fails at once.
    await expect(jobs.run(async () => { throw new ResultError('TIMEOUT', 'Too long.') })).rejects.toMatchObject({ code: 'TIMEOUT' })
    // Aborted during a wait: no more asking.
    const stop = new AbortController()
    let tries = 0
    const stopped = jobs.run(async () => { tries++; throw new ResultError('BUSY', 'Busy.') }, { signal: stop.signal })
    await settle()
    stop.abort()
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' })
    timers.advance(60_000)
    await settle()
    expect(tries).toBe(1)
    expect(jobs.load).toEqual({ running: 0, waiting: 0 })
  })
})
