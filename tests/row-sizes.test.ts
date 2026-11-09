import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultsProfileResult, ResultsRowBytesResult } from '../src/shared/contracts'
import { RowSizes, rowSizeLimits } from '../src/renderer/src/grid/row-sizes'
import type { ResultHandle } from '../src/renderer/src/results/ResultClient'

interface Pending<T> { resolve(value: T): void; reject(error: unknown): void; signal?: AbortSignal }

/** A handle whose rowBytes and profile requests the test answers. */
function fixture(rowsAvailable = 1000, state = 'complete') {
  const snapshot = { state, rowsAvailable }
  const reads: (Pending<ResultsRowBytesResult> & { first: number; count: number })[] = []
  const profiles: Pending<ResultsProfileResult>[] = []
  const handle = {
    getSnapshot: () => snapshot,
    rowBytes: (first: number, count: number, signal?: AbortSignal) => new Promise<ResultsRowBytesResult>((resolve, reject) => { reads.push({ first, count, resolve, reject, signal }) }),
    profile: (_columns: number[], signal?: AbortSignal) => new Promise<ResultsProfileResult>((resolve, reject) => { profiles.push({ resolve, reject, signal }) })
  } as unknown as ResultHandle
  const changed = vi.fn()
  const sizes = new RowSizes(handle, changed)
  const answer = (index: number, bytes: (row: number) => number, estimated: number[] = []) => {
    const read = reads[index], count = Math.min(read.count, snapshot.rowsAvailable - read.first)
    read.resolve({ firstRow: read.first, bytes: Array.from({ length: count }, (_, k) => bytes(read.first + k)), rowsAvailable: snapshot.rowsAvailable, estimated })
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { sizes, reads, profiles, changed, answer, settle, snapshot }
}

afterEach(() => { vi.useRealTimers() })

describe('row sizes', () => {
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
