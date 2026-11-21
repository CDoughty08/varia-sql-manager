import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultsProfileResult, ResultsRowBytesResult } from '../src/shared/contracts'
import { RowSizes, rowSizeLimits } from '../src/renderer/src/grid/row-sizes'
import type { ResultHandle } from '../src/renderer/src/results/ResultClient'

interface Pending<T> { resolve(value: T): void; reject(error: unknown): void; signal?: AbortSignal }

/** A handle whose rowBytes and profile requests the test answers. */
function fixture(rowsAvailable = 1000, state = 'complete', timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }) {
  const snapshot: { state: string; rowsAvailable: number; residence?: string; revision?: number } = { state, rowsAvailable }
  const reads: (Pending<ResultsRowBytesResult> & { first: number; count: number })[] = []
  const profiles: Pending<ResultsProfileResult>[] = []
  const handle = {
    getSnapshot: () => snapshot,
    rowBytes: (first: number, count: number, signal?: AbortSignal) => new Promise<ResultsRowBytesResult>((resolve, reject) => { reads.push({ first, count, resolve, reject, signal }) }),
    profile: (_columns: number[], signal?: AbortSignal) => new Promise<ResultsProfileResult>((resolve, reject) => { profiles.push({ resolve, reject, signal }) })
  } as unknown as ResultHandle
  const changed = vi.fn()
  const sizes = new RowSizes(handle, changed, timers)
  const answer = (index: number, bytes: (row: number) => number, estimated: number[] = []) => {
    const read = reads[index], count = Math.min(read.count, snapshot.rowsAvailable - read.first)
    read.resolve({ firstRow: read.first, bytes: Array.from({ length: count }, (_, k) => bytes(read.first + k)), rowsAvailable: snapshot.rowsAvailable, estimated })
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { sizes, reads, profiles, changed, answer, settle, snapshot }
}

afterEach(() => { vi.useRealTimers() })

describe('row sizes', () => {
  it('wakes for each of several windowed short blocks once it has waited, so none is left unread', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const live = new Map<number, { callback: () => void; due: number }>()
    let id = 0
    const timers = { setTimeout: (callback: () => void, ms: number) => { live.set(++id, { callback, due: performance.now() + ms }); return id }, clearTimeout: (handle: unknown) => { live.delete(handle as number) } }
    const { sizes, reads, settle, snapshot } = fixture(100_000, 'complete', timers)
    snapshot.residence = 'remote'
    sizes.ensure(0, 400)
    expect(reads.map(read => read.first)).toEqual([0, 256])
    reads[0].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
    await settle()
    vi.advanceTimersByTime(50)
    reads[1].resolve({ firstRow: 256, bytes: [], rowsAvailable: 100_000, estimated: [] })
    await settle()
    // One wake at a time, due when the earliest block has waited: it asks that block again, then wakes for the next.
    for (const expected of [[0], [0, 256]]) {
      expect(live.size).toBe(1)
      const [[key, wake]] = live.entries()
      live.delete(key)
      vi.advanceTimersByTime(wake.due - performance.now())
      wake.callback()
      sizes.ensure(0, 400)
      expect(reads.slice(2).map(read => read.first)).toEqual(expected)
    }
    expect(live.size).toBe(0)
    sizes.dispose()
  })

  it('wakes a windowed block that grew at the plain wait while another backs off, and stops one whose rows come and go', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const live = new Map<number, { callback: () => void; due: number }>()
    let id = 0
    const timers = { setTimeout: (callback: () => void, ms: number) => { live.set(++id, { callback, due: performance.now() + ms }); return id }, clearTimeout: (handle: unknown) => { live.delete(handle as number) } }
    const { sizes, reads, settle, snapshot } = fixture(100_000, 'complete', timers)
    snapshot.residence = 'remote'
    const answer = async (index: number, rows: number) => { reads[index].resolve({ firstRow: reads[index].first, bytes: Array.from({ length: rows }, () => 10), rowsAvailable: 100_000, estimated: [] }); await settle() }
    const next = () => Math.min(...[...live.values()].map(wake => wake.due)) - performance.now()
    // Block 256 backs off (no rows, three times); block 0 grows each time: its wake stays at the plain wait.
    sizes.ensure(0, 400)
    await answer(0, 0)
    await answer(1, 0)
    for (let round = 1; round <= 3; round++) {
      vi.advanceTimersByTime(rowSizeLimits.retryMs * 2 ** (round - 1) + 1)
      sizes.ensure(0, 400)
      const zero = reads.findLastIndex(read => read.first === 0), other = reads.findLastIndex(read => read.first === 256)
      await answer(zero, round)
      if (other > 1 && reads.length - 1 === Math.max(zero, other)) await answer(other, 0)
      expect(next()).toBeLessThanOrEqual(rowSizeLimits.retryMs + 1)
    }
    sizes.dispose()
    // A block whose rows go 100, 50, 100, ... answers no more than it once did: it backs off and stops.
    const second = fixture(100_000, 'complete', timers)
    second.snapshot.residence = 'remote'
    live.clear()
    let wakes = 0
    for (let cycle = 0; cycle < 40; cycle++) {
      vi.advanceTimersByTime(rowSizeLimits.retryMs * 2 ** rowSizeLimits.unchangedWakes + 1)
      second.sizes.ensure(0, 40)
      const before = live.size
      second.reads.at(-1)!.resolve({ firstRow: 0, bytes: Array.from({ length: cycle % 2 ? 50 : 100 }, () => 10), rowsAvailable: 100_000, estimated: [] })
      await second.settle()
      if (live.size > before) wakes++
      live.clear()
    }
    expect(wakes).toBeLessThanOrEqual(rowSizeLimits.unchangedWakes + 1)
    second.sizes.dispose()
  })

  it('wakes the grid once a windowed short block has waited, so its bars fill without a scroll', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const scheduled: { callback: () => void; ms: number }[] = []
    const timers = { setTimeout: (callback: () => void, ms: number) => scheduled.push({ callback, ms }), clearTimeout: vi.fn() }
    const { sizes, reads, settle, snapshot, changed } = fixture(100_000, 'complete', timers)
    snapshot.residence = 'remote'
    sizes.ensure(0, 40)
    reads[0].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
    await settle()
    expect(changed).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].ms).toBeGreaterThanOrEqual(rowSizeLimits.retryMs)
    vi.advanceTimersByTime(scheduled[0].ms)
    scheduled[0].callback()
    expect(changed).toHaveBeenCalledTimes(1)
    // The paint it wakes asks again.
    sizes.ensure(0, 40)
    expect(reads).toHaveLength(2)
    // A block that does not grow (still fetching, or its rows never fit the cache) wakes after twice the wait each time,
    // a few times, then stops: no polling.
    for (let attempt = 1; attempt <= rowSizeLimits.unchangedWakes + 1; attempt++) {
      reads[attempt].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
      await settle()
      if (attempt > rowSizeLimits.unchangedWakes) break
      expect(scheduled).toHaveLength(attempt + 1)
      expect(scheduled[attempt].ms).toBe(rowSizeLimits.retryMs * 2 ** attempt + 1)
      vi.advanceTimersByTime(scheduled[attempt].ms)
      scheduled[attempt].callback()
      sizes.ensure(0, 40)
      expect(reads).toHaveLength(attempt + 2)
    }
    expect(scheduled).toHaveLength(rowSizeLimits.unchangedWakes + 1)
    // Asked again after its longest wait, one that grew wakes once more, at the plain wait.
    vi.advanceTimersByTime(rowSizeLimits.retryMs * 2 ** rowSizeLimits.unchangedWakes + 1)
    sizes.ensure(0, 40)
    reads.at(-1)!.resolve({ firstRow: 0, bytes: [10, 20], rowsAvailable: 100_000, estimated: [] })
    await settle()
    expect(scheduled).toHaveLength(rowSizeLimits.unchangedWakes + 2)
    expect(scheduled.at(-1)!.ms).toBe(rowSizeLimits.retryMs + 1)
    sizes.dispose()
  })

  it('reads a windowed block again whose rows land after its first wait, so its bars do not stay empty', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const live = new Map<number, { callback: () => void; due: number }>()
    let id = 0
    const timers = { setTimeout: (callback: () => void, ms: number) => { live.set(++id, { callback, due: performance.now() + ms }); return id }, clearTimeout: (handle: unknown) => { live.delete(handle as number) } }
    const { sizes, reads, settle, snapshot } = fixture(100_000, 'complete', timers)
    snapshot.residence = 'remote'
    const fire = () => {
      const [[key, wake]] = live.entries()
      live.delete(key)
      vi.advanceTimersByTime(Math.max(0, wake.due - performance.now()))
      wake.callback()
    }
    sizes.ensure(0, 40)
    reads[0].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
    await settle()
    // The first wake asks again while the block is still fetching: still short.
    fire()
    sizes.ensure(0, 40)
    reads[1].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
    await settle()
    // Its rows land a second later; the paints then fall inside the wait. A later wake still asks again.
    vi.advanceTimersByTime(1000)
    for (let frame = 0; frame < 5; frame++) sizes.ensure(0, 40)
    expect(live.size).toBe(1)
    fire()
    sizes.ensure(0, 40)
    expect(reads).toHaveLength(3)
    reads[2].resolve({ firstRow: 0, bytes: Array.from({ length: 256 }, () => 10), rowsAvailable: 100_000, estimated: [] })
    await settle()
    expect(sizes.get(5)?.bytes).toBe(10)
    expect(live.size).toBe(0)
    sizes.dispose()
  })

  it('asks a windowed result for a block its cache does not hold yet once per wait, not on every paint', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const { sizes, reads, settle, snapshot, changed } = fixture(100_000, 'complete', { setTimeout: () => 0, clearTimeout: () => {} })
    snapshot.residence = 'remote'
    for (let paint = 0; paint < 10; paint++) {
      sizes.ensure(0, 40)
      if (reads.length > paint) reads[paint].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
      await settle()
    }
    expect(reads).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(rowSizeLimits.retryMs)
    sizes.ensure(0, 40)
    expect(reads).toHaveLength(2)
    // A residence switch (a new revision) reads the block again at once.
    reads[1].resolve({ firstRow: 0, bytes: [], rowsAvailable: 100_000, estimated: [] })
    await settle()
    snapshot.revision = 1
    sizes.ensure(0, 40)
    expect(reads).toHaveLength(3)
  })

  it('asks no profile of a windowed BigQuery result (it would be refused), and asks once the result is loaded into memory', () => {
    const { sizes, reads, profiles, snapshot } = fixture()
    snapshot.residence = 'remote'
    sizes.ensure(0, 100)
    sizes.ensure(0, 100)
    expect(profiles).toHaveLength(0)
    // Its row sizes are still read, from the block cache (results.rowBytes).
    expect(reads).toHaveLength(1)
    snapshot.residence = 'memory'
    sizes.ensure(0, 100)
    expect(profiles).toHaveLength(1)
  })

  it('reads only the blocks in view, at most 2 at once, and scales each row by the largest the profile reports', async () => {
    const { sizes, reads, profiles, changed, answer, settle } = fixture()
    sizes.ensure(300, 800)
    expect(profiles).toHaveLength(1)
    expect(reads.map(read => [read.first, read.count])).toEqual([[256, rowSizeLimits.blockRows], [512, rowSizeLimits.blockRows]])
    expect(sizes.get(300)).toBeUndefined()
    answer(0, row => row, [300])
    await settle()
    expect(changed).toHaveBeenCalled()
    // Until the profile answers, the largest row read scales the bars.
    expect(sizes.max).toBe(511)
    expect(sizes.get(300)).toEqual({ bytes: 300, share: 300 / 511, large: true, estimated: true })
    profiles[0].resolve({ rows: 1000, complete: true, rowBytes: { min: 0, max: 2000, average: 500, exact: true }, columns: [] })
    await settle()
    expect(sizes.get(300)).toEqual({ bytes: 300, share: 0.15, large: false, estimated: true })
    expect(sizes.get(301)?.estimated).toBe(false)
    // The held block is not read again; the next one is, now a slot is free.
    sizes.ensure(300, 800)
    expect(reads.map(read => read.first)).toEqual([256, 512, 768])
    expect(profiles).toHaveLength(1)
  })

  it('profiles a loading set only once it completes, and rereads a block read short', async () => {
    const { sizes, reads, profiles, answer, settle, snapshot } = fixture(100, 'open')
    sizes.ensure(0, 50)
    answer(0, () => 10)
    await settle()
    expect(sizes.get(99)?.bytes).toBe(10)
    snapshot.rowsAvailable = 300
    sizes.ensure(0, 50)
    expect(reads.map(read => read.first)).toEqual([0, 0])
    expect(profiles).toHaveLength(0)
    snapshot.state = 'complete'
    sizes.ensure(0, 50)
    sizes.ensure(0, 50)
    expect(profiles).toHaveLength(1)
  })

  it('waits before asking again for a block whose read failed, and keeps at most 64 blocks', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const { sizes, reads, answer, settle } = fixture(rowSizeLimits.blockRows * 70)
    sizes.ensure(0, 0)
    reads[0].reject(new Error('refused'))
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    await settle()
    sizes.ensure(0, 0)
    expect(reads).toHaveLength(1)
    vi.advanceTimersByTime(rowSizeLimits.retryMs)
    sizes.ensure(0, 0)
    expect(reads).toHaveLength(2)
    answer(1, () => 1)
    await settle()
    for (let block = 1; block < 70; block++) {
      const row = block * rowSizeLimits.blockRows
      sizes.ensure(row, row)
      answer(reads.length - 1, () => 1)
      await settle()
    }
    expect(sizes.get(0)).toBeUndefined()
    expect(sizes.get(69 * rowSizeLimits.blockRows)?.bytes).toBe(1)
  })

  it('asks for the largest row again, after the wait, when the profile fails', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const { sizes, profiles, settle } = fixture()
    sizes.ensure(0, 0)
    profiles[0].reject(new Error('busy'))
    await settle()
    sizes.ensure(0, 0)
    expect(profiles).toHaveLength(1)
    vi.advanceTimersByTime(rowSizeLimits.retryMs)
    sizes.ensure(0, 0)
    expect(profiles).toHaveLength(2)
    profiles[1].resolve({ rows: 1000, complete: true, rowBytes: { min: 0, max: 900, average: 1, exact: true }, columns: [] })
    await settle()
    expect(sizes.max).toBe(900)
    sizes.ensure(0, 0)
    expect(profiles).toHaveLength(2)
  })

  it('stops its requests and keeps nothing once disposed', async () => {
    const { sizes, reads, profiles, answer, settle, changed } = fixture()
    sizes.ensure(0, 10)
    sizes.dispose()
    expect(reads[0].signal?.aborted).toBe(true)
    expect(profiles[0].signal?.aborted).toBe(true)
    answer(0, () => 5)
    await settle()
    expect(sizes.get(0)).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    sizes.ensure(0, 10)
    expect(reads).toHaveLength(1)
  })
})
