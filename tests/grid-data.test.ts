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
          const window = { first, count: rows, colStart: o.colStart ?? 0, colEnd: o.colEnd ?? columns, text: Array.from({ length: rows * width }, (_, index) => String(first + Math.floor(index / width))), flags: new Uint8Array(rows * width).fill(1) }
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
  it('reads a single jump at once, nothing while scrolling goes on faster than 3 views a frame, and resumes 50 ms after it settles', () => {
    const { data, reads, changed, advance } = fixture()
    // Ctrl+End, a click in the scroll bar's track: one frame moves far, and its tiles are read in that frame.
    data.ensure(range(50_000, 50_040), 1_000_000, 50_000, 30)
    expect(reads.map(read => read.first)).toEqual([49_920])
    // A thumb dragged fast moves that far frame after frame: nothing more is read until it settles.
    advance(16)
    data.ensure(range(60_000, 60_040), 1_000_000, 10_000, 30)
    advance(16)
    data.ensure(range(70_000, 70_040), 1_000_000, 10_000, 30)
    expect(reads).toHaveLength(1)
    advance(50)
    expect(changed).toHaveBeenCalled()
    data.ensure(range(70_000, 70_040), 1_000_000, 0, 30)
    expect(reads.slice(1).map(read => read.first)).toEqual([70_016, 69_888])
  })
  it('waits for a settle that a later fast frame extended, however early its timer fires', () => {
    const { data, reads, changed, advance } = fixture()
    data.ensure(range(10_000, 10_040), 1_000_000, 10_000, 30)
    data.ensure(range(50_000, 50_040), 1_000_000, 40_000, 30)
    advance(40)
    data.ensure(range(90_000, 90_040), 1_000_000, 40_000, 30)
    advance(10)
    expect(changed).toHaveBeenCalledOnce()
    // The first timer's frame comes 40 ms early: nothing is read, and another frame is due when the settle ends.
    const before = reads.length
    data.ensure(range(90_000, 90_040), 1_000_000, 0, 30)
    expect(reads).toHaveLength(before)
    advance(40)
    expect(changed).toHaveBeenCalledTimes(2)
    data.ensure(range(90_000, 90_040), 1_000_000, 0, 30)
    expect(reads.length).toBeGreaterThan(before)
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
  it('reads a tile on from where its rows end while its rows were still arriving, at most 10 times a second', async () => {
    const { data, reads, settle, advance, changed } = fixture(8)
    data.ensure(range(0, 40, 0, 7), 50, 0, 30)
    reads[0].resolve(50)
    await settle()
    // Complete: no frontier.
    data.ensure(range(0, 40, 0, 7), 50, 0, 30)
    expect(reads).toHaveLength(1)
    // More rows arrived: the rest of the tile is read, keeping the rows it has until the new ones land.
    for (let index = 0; index < 12; index++) {
      const before = reads.length, rows = 60 + index
      data.ensure(range(0, 40, 0, 7), rows, 0, 30)
      expect(data.peek(tileKey(0, 0))?.count).toBe(before === 1 ? 50 : Math.min(69, rows - 1))
      if (reads.length > before) reads.at(-1)!.resolve(rows - reads.at(-1)!.first)
      await settle()
    }
    expect(reads.map(read => [read.first, read.count])).toEqual([[0, 128], [50, 78], ...Array.from({ length: 9 }, (_, index) => [60 + index, 68 - index])])
    changed.mockClear()
    advance(100)
    expect(changed).toHaveBeenCalled()
    advance(1000)
    data.ensure(range(0, 40, 0, 7), 80, 0, 30)
    expect(reads.map(read => read.first)).toHaveLength(12)
    expect(reads[11].first).toBe(69)
  })
  it('reads on at once from where a tile\'s rows end when the worker could not hold them all, never from its start again', async () => {
    // Large XML or JSON values: the worker's 64 MiB cache holds only a few rows' pages at a time and answers with those.
    const { data, reads, cache, settle } = fixture(8)
    const key = tileKey(0, 0)
    for (let part = 0; part < 26; part++) {
      data.ensure(range(0, 127, 0, 7), 128, 0, 30)
      expect(reads).toHaveLength(part + 1)
      reads[part].resolve(Math.min(5, 128 - reads[part].first))
      await settle()
    }
    data.ensure(range(0, 127, 0, 7), 128, 0, 30)
    expect(reads.map(read => read.first)).toEqual(Array.from({ length: 26 }, (_, index) => index * 5))
    const joined = data.peek(key)!
    expect([joined.first, joined.count, joined.text.length, joined.flags.length]).toEqual([0, 128, 128 * 8, 128 * 8])
    expect([joined.text[0], joined.text[5 * 8], joined.text[127 * 8 + 7]]).toEqual(['0', '5', '127'])
    expect(joined.flags.every(flag => flag === 1)).toBe(true)
    expect(data.peek(key)).toBe(joined)
    // A part that left the cache ends the tile's rows there; with the tile's first part gone, it is read from its start.
    cache.delete('60:68:0:8:512:true')
    expect(data.peek(key)!.count).toBe(60)
    cache.delete('0:128:0:8:512:true')
    expect(data.peek(key)).toBeUndefined()
    data.ensure(range(0, 127, 0, 7), 128, 0, 30)
    expect(reads.at(-1)).toMatchObject({ first: 0, count: 128 })
    reads.at(-1)!.resolve()
    await settle()
    expect(data.peek(key)).toBe(cache.get('0:128:0:8:512:true'))
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
