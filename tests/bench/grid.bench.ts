import { expect, it } from 'vitest'
import { gridLimits } from '../../src/renderer/src/grid/constants'
import { ColumnLayout, rowHeaderWidth, visibleRange } from '../../src/renderer/src/grid/layout'
import { scrollCap, scrollModel, rebaseRow, rowsContainerY, toNative, topRowOf, toVirtual } from '../../src/renderer/src/grid/scroll'
import { copyPlan, covered, select, windowRanges, type GridSelection } from '../../src/renderer/src/grid/selection'
import { planTiles, prefetchTiles } from '../../src/renderer/src/grid/tiles'
import { WindowCache, type RowWindow } from '../../src/renderer/src/results/ResultClient'
import { rate, record, w1Row } from './harness'

// The results grid's per-frame models on their own, in one thread: what GridView computes for every frame of a
// 1600 × 1000 window (about 45 rows by 40 columns of cells in view).

const rows = 1_000_000, columns = 300, view = { rows: 45, columns: 40 }

it('resolves a 64-block selection and tests every visible cell', () => {
  let selection: GridSelection | undefined
  for (let index = 0; index < 64; index++) selection = select(selection, { kind: 'cell', row: (index * 7) % view.rows, column: (index * 13) % view.columns }, { resultIndex: 0, extend: false, add: index > 0 })
  selection = select(selection, { kind: 'cell', row: 30, column: 30 }, { resultIndex: 0, extend: true, add: false })
  const test = () => {
    // As a frame does: clip the blocks to the window, then test each cell against them.
    const ranges = windowRanges(selection!, rows, columns, { top: 0, left: 0, bottom: view.rows - 1, right: view.columns - 1 })
    let selected = 0
    for (let row = 0; row < view.rows; row++) for (let column = 0; column < view.columns; column++) if (covered(ranges, row, column)) selected++
    return selected
  }
  expect(test()).toBeGreaterThan(63)
  expect(copyPlan(selection!, columns).length).toBeGreaterThan(1)
  const ops = rate(() => { test() }, { batch: 100 })
  record({ id: 'node.grid.selection.opsPerSecond', value: ops, unit: 'ops/s', detail: `64 blocks, ${view.rows * view.columns} cells tested` })
})

it('maps scroll offsets for 100 million rows', () => {
  const cap = scrollCap(1.5)
  let top = 0, check = 0
  const step = () => {
    // A frame in Mode B: the model (rows may have grown), the virtual offset, the base row and the container offset.
    const model = scrollModel(100_000_000, 1000, cap)
    top = (top + 4_999) % model.maxNative
    const virtual = toVirtual(model, top), first = topRowOf(virtual), base = rebaseRow(first)
    check += rowsContainerY(model, top, virtual, base) + toNative(model, virtual) - top
  }
  step()
  expect(scrollModel(100_000_000, 1000, cap).mode).toBe('virtual')
  const ops = rate(step, { batch: 1000 })
  expect(Number.isFinite(check)).toBe(true)
  record({ id: 'node.grid.scroll.opsPerSecond', value: ops, unit: 'ops/s', detail: 'Mode B, scroll cap at 1.5 dppx' })
})

it('plans the tiles of a view over 300 columns', () => {
  const layout = new ColumnLayout(Float64Array.from({ length: columns }, (_, index) => 60 + (index * 17) % 120), scrollCap(1))
  const header = rowHeaderWidth(rows, 7.2)
  let top = 0, left = 0, tiles = 0
  const plan = () => {
    top = (top + 3_337) % (rows * gridLimits.rowHeight)
    left = (left + 211) % layout.total
    const range = visibleRange({ top, left, width: 1600, height: 1000 }, rows, layout, header)
    tiles += planTiles(range, rows, columns).length + prefetchTiles(range, rows, columns).length
  }
  plan()
  expect(tiles).toBeGreaterThan(0)
  const ops = rate(plan, { batch: 100 })
  record({ id: 'node.grid.tiles.opsPerSecond', value: ops, unit: 'ops/s', detail: 'visible range, tiles and the prefetch ring at 1600 × 1000' })
})

it('peeks and stores tile windows in a full window cache', () => {
  // A frame over W1 peeks its visible tiles (two row tiles and the active cell's), and a read tile lands as a new window
  // that evicts the least recently used one, with the cache full (256 windows; text units are within their bound).
  const { tileRows, maxCellChars, uiCacheWindows } = gridLimits
  const cells = Array.from({ length: tileRows }, (_, row) => w1Row(row).map(value => value ?? '')).flat()
  const tile = (first: number): RowWindow => ({ first, count: tileRows, colStart: 0, colEnd: 8, text: cells, flags: new Uint8Array(cells.length) })
  const key = (first: number) => WindowCache.key('1:7', first, tileRows, 0, 8, maxCellChars, true)
  const cache = new WindowCache()
  let next = 0, found = 0
  const frame = () => {
    // As GridData.peek does for each visible tile: the key, then the lookup that makes it the most recently used.
    for (const back of [1, 2, 40]) if (cache.get(key((next - back) * tileRows))) found++
    cache.set(key(next * tileRows), '1:7', tile(next * tileRows))
    next++
  }
  for (let index = 0; index < uiCacheWindows * 2; index++) frame()
  expect(cache.size).toBe(uiCacheWindows)
  expect(cache.units).toBeLessThanOrEqual(gridLimits.uiCacheUnits)
  const ops = rate(frame, { batch: 100 })
  expect(found).toBeGreaterThan(0)
  expect(cache.size).toBe(uiCacheWindows)
  record({ id: 'node.grid.cache.opsPerSecond', value: ops, unit: 'ops/s', detail: `3 lookups and 1 insert with eviction, ${uiCacheWindows} windows of ${tileRows} W1 rows` })
})
