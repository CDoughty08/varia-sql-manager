import { describe, expect, it } from 'vitest'
import { limits } from '../src/shared/ipc/wire/protocol'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { isFastScroll, isFrontier, planTiles, prefetchTiles, tileColumnOf, tileKey, tileRequest, tileRowOf, wantedSet } from '../src/renderer/src/grid/tiles'

const range = (firstRow: number, lastRow: number, firstColumn: number, lastColumn: number) => ({ firstRow, lastRow, firstColumn, lastColumn })
const name = (key: number) => `${tileRowOf(key)}:${tileColumnOf(key)}`

describe('grid tiles', () => {
  it('name each tile by one number and ask for 128 rows × 32 columns of capped display text', () => {
    expect([tileKey(0, 0), tileKey(0, 127), tileKey(1, 0), tileKey(16_777_215, 127)]).toEqual([0, 127, 128, 16_777_215 * 128 + 127])
    for (const key of [0, 1, 127, 128, 999_999, tileKey(16_777_215, 127)]) expect(tileKey(tileRowOf(key), tileColumnOf(key))).toBe(key)
    expect(tileRequest(tileKey(2, 1), 1_000_000, 300)).toEqual({ first: 256, count: 128, colStart: 32, colEnd: 64, maxCellChars: 512, textBudget: 2_100_000, display: true })
    // The last tiles are short: rows up to what is available, columns up to the result's.
    expect(tileRequest(tileKey(7, 9), 1000, 300)).toMatchObject({ first: 896, count: 104, colStart: 288, colEnd: 300 })
    expect(tileRequest(tileKey(8, 0), 1000, 3).count).toBe(0)
  })
  it('never ask for a window over the worker\'s limits, so no tile is cut short by its text budget', () => {
    let seed = 7
    const random = (max: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % max }
    for (let trial = 0; trial < 2000; trial++) {
      const rows = 1 + random(5_000_000), columns = 1 + random(4096)
      const key = tileKey(random(Math.ceil(rows / 128)), random(Math.ceil(columns / 32)))
      const request = tileRequest(key, rows, columns), cells = request.count * (request.colEnd - request.colStart)
      expect(request.count).toBeLessThanOrEqual(limits.worker.windowRows)
      expect(cells).toBeLessThanOrEqual(limits.worker.windowCells)
      expect(cells * request.maxCellChars).toBeLessThanOrEqual(request.textBudget)
      expect(request.textBudget).toBeLessThanOrEqual(limits.worker.windowCharacters)
      expect(request.colEnd).toBeLessThanOrEqual(columns)
    }
    expect(gridLimits.tileRows * gridLimits.tileColumns * gridLimits.maxCellChars).toBeLessThanOrEqual(gridLimits.textBudget)
  })
  it('plan the tiles of a view centre first, then outwards', () => {
    // Rows 100–400 and columns 20–80 touch row tiles 0–3 and column tiles 0–2; the centre is tile 1:1.
    const plan = planTiles(range(100, 400, 20, 80), 1_000_000, 300).map(name)
    expect(plan).toHaveLength(12)
    expect(new Set(plan).size).toBe(12)
    expect(plan.slice(0, 5)).toEqual(['1:1', '1:0', '1:2', '0:1', '2:1'])
    expect(plan.at(-1)).toBe('3:2')
    expect(planTiles(range(0, 30, 0, 10), 1_000_000, 300).map(name)).toEqual(['0:0'])
    // Clamped to the result, and empty for an empty range.
    expect(planTiles(range(100, 400, 20, 80), 200, 40).map(name)).toEqual(['1:0', '1:1', '0:0', '0:1'])
    expect(planTiles(range(0, -1, 0, 5), 100, 10)).toEqual([])
    expect(planTiles(range(0, 5, 0, 5), 0, 10)).toEqual([])
  })
  it('want the view\'s tiles and the prefetch ring one view above and below', () => {
    // Rows 1100–1200 touch row tiles 8 and 9; a view above and below reaches tiles 7 and 10.
    const view = range(1100, 1200, 0, 40)
    const own = planTiles(view, 100_000, 300), ring = prefetchTiles(view, 100_000, 300)
    expect(own.map(name)).toEqual(['8:0', '8:1', '9:0', '9:1'])
    expect(ring.map(name).sort()).toEqual(['10:0', '10:1', '7:0', '7:1'])
    expect(ring.some(key => own.includes(key))).toBe(false)
    expect([...wantedSet(own, ring)].sort((a, b) => a - b)).toEqual([...own, ...ring].sort((a, b) => a - b))
    expect(wantedSet().size).toBe(0)
    expect(prefetchTiles(range(0, 20, 0, 5), 21, 10)).toEqual([])
    expect(prefetchTiles(range(0, -1, 0, 5), 100, 10)).toEqual([])
  })
  it('read a tile again when it was read before its rows arrived, and not while scrolling fast', () => {
    expect(isFrontier({ first: 0, count: 64 }, 64)).toBe(false)
    expect(isFrontier({ first: 0, count: 64 }, 65)).toBe(true)
    expect(isFrontier({ first: 128, count: 128 }, 10_000)).toBe(false)
    expect(isFrontier({ first: 128, count: 100 }, 228)).toBe(false)
    expect(isFrontier({ first: 128, count: 100 }, 229)).toBe(true)
    expect([isFastScroll(90, 30), isFastScroll(91, 30), isFastScroll(-91, 30), isFastScroll(4, 0)]).toEqual([false, true, true, true])
  })
})
