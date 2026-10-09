import { describe, expect, it, vi } from 'vitest'
import { GridData } from '../src/renderer/src/grid/data'
import { planTiles, tileColumnOf, tileKey, tileRowOf } from '../src/renderer/src/grid/tiles'
import type { RowWindow, WindowOptions, WindowShape } from '../src/renderer/src/results/ResultClient'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { manualTimers } from './fixtures/workbench'

interface Read { first: number; count: number; o: WindowOptions; resolve(rows?: number): void; reject(error: unknown): void; aborted: () => boolean }

/** A handle whose reads the test answers: a window lands in `cache` (as ResultClient's window cache) when answered. */
function fixture(columns = 40, inflight = { value: 0 }) {
  const cache = new Map<string, RowWindow>(), reads: Read[] = []
  const keyOf = (first: number, count: number, o: WindowShape) => `${first}:${count}:${o.colStart}:${o.colEnd}:${o.maxCellChars}:${o.display}`
  const handle = {
    getWindow: (first: number, count: number, o: WindowOptions = {}) => new Promise<RowWindow>((resolve, reject) => {
      const read: Read = {
        first, count, o, aborted: () => !!o.signal?.aborted, reject,
        resolve: (rows = count) => {
          const width = (o.colEnd ?? columns) - (o.colStart ?? 0)
          const window = { first, count: rows, colStart: o.colStart ?? 0, colEnd: o.colEnd ?? columns, text: new Array(rows * width).fill('x'), flags: new Uint8Array(rows * width) }
          cache.set(keyOf(first, count, o), window)
          resolve(window)
        }
      }
      o.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      reads.push(read)
    }),
    peekWindow: (first: number, count: number, o: WindowShape = {}) => cache.get(keyOf(first, count, o)),
    prefetch: vi.fn()
  }
  const timers = manualTimers()
  let now = 0
  const changed = vi.fn()
  const data = new GridData({ handle, columns, clientInflight: () => inflight.value + data.reading, changed, timers: timers.timers, now: () => now })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { data, reads, cache, changed, timers, settle, advance: (ms: number) => { now += ms; timers.advance(ms) }, handle }
}
const range = (firstRow: number, lastRow: number, firstColumn = 0, lastColumn = 9) => ({ firstRow, lastRow, firstColumn, lastColumn })

describe('grid data', () => {
  it('reads the tiles a frame shows, centre first, at most 4 per grid, as display windows of 128 rows', async () => {
    const { data, reads, settle, changed } = fixture()
    // Rows 100–400 over columns 0–39: row tiles 0–3, column tiles 0–1; the centre is row tile 1 or 2, column tile 0 or 1.
    expect(data.ensure(range(100, 400, 0, 39), 10_000, 0, 30)).toBe(false)
    expect(reads).toHaveLength(4)
    expect(reads.map(read => [read.first, read.o.colStart])).toEqual(planTiles(range(100, 400, 0, 39), 10_000, 40).slice(0, 4).map(key => [tileRowOf(key) * 128, tileColumnOf(key) * 32]))
    expect(reads[0].first).toBe(128)
    expect(reads[0]).toMatchObject({ count: 128, o: { colEnd: 32, maxCellChars: 512, textBudget: 2_100_000, display: true } })
    expect(reads[1].o.colEnd).toBe(40)
    reads[0].resolve()
    await settle()
    expect(changed).toHaveBeenCalled()
    data.ensure(range(100, 400, 0, 39), 10_000, 0, 30)
    expect(reads).toHaveLength(5)
    expect(data.counters.hits).toBeGreaterThan(0)
    expect(data.counters.misses).toBeGreaterThan(0)
  })
  it('shares 16 reads between a client\'s grids', () => {
    const { data, reads } = fixture(40, { value: 14 })
    data.ensure(range(0, 1000), 10_000, 0, 30)
    expect(reads).toHaveLength(2)
  })
  it('aborts a tile the frames have not wanted for 2 frames', async () => {
    const { data, reads, settle } = fixture()
    data.ensure(range(0, 10), 10_000, 0, 30)
    expect(reads).toHaveLength(1)
    data.ensure(range(5000, 5010), 10_000, 0, 30)
    expect(reads[0].aborted()).toBe(false)
    data.ensure(range(5000, 5010), 10_000, 0, 30)
    expect(reads[0].aborted()).toBe(true)
    await settle()
    expect(data.error).toBeUndefined()
  })
  it('reads nothing while scrolling faster than 3 views a frame, and resumes 50 ms after it settles', () => {
    const { data, reads, changed, advance } = fixture()
    data.ensure(range(50_000, 50_040), 1_000_000, 50_000, 30)
    expect(reads).toHaveLength(0)
    advance(20)
    data.ensure(range(60_000, 60_040), 1_000_000, 10, 30)
    expect(reads).toHaveLength(0)
    advance(30)
    expect(changed).toHaveBeenCalledOnce()
    data.ensure(range(60_000, 60_040), 1_000_000, 0, 30)
    expect(reads.map(read => read.first)).toEqual([59_904, 60_032])
  })
  it('waits for a settle that a later fast frame extended, however early its timer fires', () => {
    const { data, reads, changed, advance } = fixture()
    data.ensure(range(50_000, 50_040), 1_000_000, 50_000, 30)
    advance(40)
    data.ensure(range(90_000, 90_040), 1_000_000, 40_000, 30)
    advance(10)
    expect(changed).toHaveBeenCalledOnce()
    // The first timer's frame comes 40 ms early: nothing is read, and another frame is due when the settle ends.
    data.ensure(range(90_000, 90_040), 1_000_000, 0, 30)
    expect(reads).toHaveLength(0)
    advance(40)
    expect(changed).toHaveBeenCalledTimes(2)
    data.ensure(range(90_000, 90_040), 1_000_000, 0, 30)
    expect(reads.length).toBeGreaterThan(0)
  })
  it('looks again shortly when other grids hold all the client\'s reads', () => {
    const inflight = { value: 16 }
    const { data, reads, changed, advance } = fixture(40, inflight)
    data.ensure(range(0, 30), 10_000, 0, 30)
    expect(reads).toHaveLength(0)
    inflight.value = 0
    advance(50)
    expect(changed).toHaveBeenCalledOnce()
    data.ensure(range(0, 30), 10_000, 0, 30)
    expect(reads).toHaveLength(1)
  })
  it('tries a read again shortly when main\'s results port is full, without marking the tile', async () => {
    const { data, reads, settle, advance, changed } = fixture()
    data.ensure(range(0, 30), 10_000, 0, 30)
    reads[0].reject(new ResultError('TOO_MANY_REQUESTS', 'Too many pending backend requests.'))
    await settle()
    expect([data.error, data.failed(0), data.reading]).toEqual([undefined, false, 0])
    expect(changed).not.toHaveBeenCalled()
    advance(250)
    expect(changed).toHaveBeenCalledOnce()
    data.ensure(range(0, 30), 10_000, 0, 30)
    expect(reads).toHaveLength(2)
  })
  it('reads the active cell\'s tile when the cell is out of view, after the view\'s own', () => {
    const { data, reads } = fixture()
    data.ensure(range(0, 30), 10_000, 0, 30, { row: 5000, column: 35 })
    expect(reads.map(read => [read.first, read.o.colStart])).toEqual([[0, 0], [4992, 32]])
    // An active cell in view adds nothing.
    const second = fixture()
    second.data.ensure(range(0, 30), 10_000, 0, 30, { row: 3, column: 2 })
    expect(second.reads).toHaveLength(1)
  })
  it('reads a tile again while its rows were still arriving, at most 10 times a second', async () => {
    const { data, reads, settle, advance, changed } = fixture(8)
    data.ensure(range(0, 40, 0, 7), 50, 0, 30)
    reads[0].resolve(50)
    await settle()
    // Complete: no frontier.
    data.ensure(range(0, 40, 0, 7), 50, 0, 30)
    expect(reads).toHaveLength(1)
    // More rows arrived: the 50-row tile is read again, keeping its window until the new one lands.
    for (let index = 0; index < 12; index++) {
      data.ensure(range(0, 40, 0, 7), 60 + index, 0, 30)
      reads.at(-1)!.resolve(50)
      await settle()
    }
    expect(reads).toHaveLength(11)
    changed.mockClear()
    advance(100)
    expect(changed).toHaveBeenCalled()
    advance(1000)
    data.ensure(range(0, 40, 0, 7), 80, 0, 30)
    expect(reads).toHaveLength(12)
  })
  it('marks a tile whose read failed until Retry, and reads a tile once more after the worker restarts', async () => {
    const { data, reads, settle } = fixture(8)
    data.ensure(range(0, 40, 0, 7), 100, 0, 30)
    reads[0].reject(new ResultError('RESULT_DECODER_FAILED', 'The results worker stopped. Try again.'))
    await settle()
    expect(data.error).toBeUndefined()
    data.ensure(range(0, 40, 0, 7), 100, 0, 30)
    expect(reads).toHaveLength(2)
    reads[1].reject(new ResultError('RESULT_DECODER_FAILED', 'The results worker stopped. Try again.'))
    await settle()
    expect(data.error).toBe('The results worker stopped. Try again.')
    expect(data.failed(tileKey(0, 0))).toBe(true)
    data.ensure(range(0, 40, 0, 7), 100, 0, 30)
    expect(reads).toHaveLength(2)
    data.retry()
    expect(data.error).toBeUndefined()
    data.ensure(range(0, 40, 0, 7), 100, 0, 30)
    expect(reads).toHaveLength(3)
  })
  it('after 2 idle frames reads the tiles a view above and below, and prefetches pages 2 views either way once', async () => {
    const { data, reads, settle, handle } = fixture(8)
    data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)
    for (const read of reads) read.resolve()
    await settle()
    const visible = reads.length
    expect(data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)).toBe(true)
    expect(data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)).toBe(false)
    expect(reads.slice(visible).map(read => read.first)).toEqual([896, 1152])
    for (const read of reads) read.resolve()
    await settle()
    data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)
    data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)
    expect(handle.prefetch.mock.calls).toEqual([[798, 580]])
    data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)
    data.ensure(range(1030, 1145, 0, 7), 10_000, 0, 30)
    expect(handle.prefetch).toHaveBeenCalledOnce()
  })
  it('aborts its reads and timers when disposed', () => {
    const { data, reads, timers } = fixture()
    data.ensure(range(0, 10), 10_000, 0, 30)
    data.ensure(range(50_000, 50_040), 1_000_000, 50_000, 30)
    data.dispose()
    expect(reads[0].aborted()).toBe(true)
    expect(timers.pending.size).toBe(0)
    expect(data.ensure(range(0, 10), 10_000, 0, 30)).toBe(false)
  })
})
