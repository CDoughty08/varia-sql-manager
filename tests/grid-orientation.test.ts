// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import { gridTarget } from '../src/renderer/src/grid/anchor'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { GridData } from '../src/renderer/src/grid/data'
import { GridView, transposedLabel } from '../src/renderer/src/grid/GridView'
import { ColumnLayout, frozenColumn, hitTest } from '../src/renderer/src/grid/layout'
import { cellKey } from '../src/renderer/src/grid/marks'
import { rotateSelection, type GridSelection } from '../src/renderer/src/grid/selection'
import { GridStats } from '../src/renderer/src/grid/stats'
import { planTiles, tileRequest, transposedTiles } from '../src/renderer/src/grid/tiles'
import { maxWidthOverrides, UniformLayout } from '../src/renderer/src/grid/uniform-layout'
import { outputTarget } from '../src/renderer/src/menus/targets'
import type { ResultHandle, RowWindow, WindowOptions, WindowShape } from '../src/renderer/src/results/ResultClient'
import type { GridViewState } from '../src/renderer/src/results/ResultsService'

// The transposed orientation (docs/grouped-results-implementation-plan.md, "Transposed orientation"): a result drawn with
// its columns as rows and its rows as columns, with nothing stored. GridView turns what it draws at its seams; its state,
// its marks and everything it reports stay in the result's own rows and columns.

const column = (name: string, role?: 'xml') => ({ name, dataType: 'nvarchar', wire: 'text' as const, nullable: true, ...role ? { role } : {} })
/** A result of `rows` × `columns` whose cell (r, c) reads "r:c" (or `text`'s answer), answered from a cache keyed as ResultClient keys its windows. */
function source(rows: number, columns: number, text: (row: number, column: number) => string | null = (row, col) => `${row}:${col}`) {
  const cache = new Map<string, RowWindow>(), reads: { first: number; count: number; o: WindowShape }[] = []
  const keyOf = (first: number, count: number, s: WindowShape) => `${first}:${count}:${s.colStart}:${s.colEnd}`
  const state = { rows }
  const snapshot = () => ({ rowsRead: state.rows, rowsStored: state.rows, rowsAvailable: state.rows, bytesStored: 0, truncatedCells: 0, state: 'complete' as const, incomplete: false })
  let current = snapshot()
  const listeners = new Set<() => void>()
  const handle = {
    key: { generation: 1, resultId: 1 },
    columns: Array.from({ length: columns }, (_, index) => column(index === 5 ? '' : 'c' + index, index === 2 ? 'xml' : undefined)),
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getWindow: async (first: number, count: number, s: WindowOptions = {}) => {
      reads.push({ first, count, o: s })
      // As the worker answers: never within the frame that asked.
      await Promise.resolve()
      const colStart = s.colStart ?? 0, colEnd = Math.min(columns, s.colEnd ?? columns), width = colEnd - colStart
      const held = Math.max(0, Math.min(count, state.rows - first))
      const values = Array.from({ length: held * width }, (_, index) => text(first + Math.floor(index / width), colStart + index % width))
      const window: RowWindow = { first, count: held, colStart, colEnd, text: values.map(value => value ?? ''), flags: Uint8Array.from(values, value => value === null ? 1 : 0) }
      cache.set(keyOf(first, count, { colStart, colEnd }), window)
      return window
    },
    peekWindow: (first: number, count: number, s: WindowShape = {}) => cache.get(keyOf(first, count, { colStart: s.colStart ?? 0, colEnd: Math.min(columns, s.colEnd ?? columns) })),
    prefetch: vi.fn(),
    // Column c's widest value is 4 + c characters.
    measure: vi.fn(async (_first: number, _count: number, colStart: number, colEnd: number) => ({ rows: 1, widths: Uint16Array.from({ length: colEnd - colStart }, (_, index) => 4 + colStart + index) })),
    // Row r is 10 × (r + 1) bytes.
    profile: vi.fn(async () => ({ rowBytes: { max: 10 * state.rows } })),
    rowBytes: vi.fn(async (first: number, count: number) => ({ first, bytes: Array.from({ length: Math.max(0, Math.min(count, state.rows - first)) }, (_, index) => 10 * (first + index + 1)), rowsAvailable: state.rows, estimated: [] }))
  }
  const grow = (to: number) => { state.rows = to; current = snapshot(); for (const listener of listeners) listener() }
  return { handle: handle as unknown as ResultHandle, reads, grow, measure: handle.measure }
}
const descriptor = (handle: ResultHandle): ResultDescriptor => ({ generation: 1, resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [...handle.columns], rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false } as unknown as ResultDescriptor)
const cells = (a: [number, number], b: [number, number] = a): GridSelection => ({ entry: 'e1', active: { row: b[0], column: b[1] }, blocks: [{ kind: 'cells', anchor: { row: a[0], column: a[1] }, focus: { row: b[0], column: b[1] } }] })
const freshState = (): GridViewState => ({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true })

describe('a selection turned', () => {
  it('swaps rows and columns, whole rows for whole columns, and turns back to itself', () => {
    const selection: GridSelection = { entry: 'e3', active: { row: 7, column: 2 }, blocks: [
      { kind: 'cells', anchor: { row: 1, column: 2 }, focus: { row: 7, column: 4 } }, { kind: 'rows', anchor: { row: 9, column: 0 }, focus: { row: 12, column: 0 } },
      { kind: 'columns', anchor: { row: 0, column: 5 }, focus: { row: 0, column: 6 } }, { kind: 'all', anchor: { row: 7, column: 2 }, focus: { row: 7, column: 2 } }] }
    const turned = rotateSelection(selection)
    expect(turned.entry).toBe('e3')
    expect(turned.active).toEqual({ row: 2, column: 7 })
    expect(turned.blocks.map(block => block.kind)).toEqual(['cells', 'columns', 'rows', 'all'])
    expect(turned.blocks[0]).toEqual({ kind: 'cells', anchor: { row: 2, column: 1 }, focus: { row: 4, column: 7 } })
    expect(rotateSelection(turned)).toEqual(selection)
  })
})

describe('the shared-width column layout', () => {
  const layout = (count: number, width = 100, max = 15_000_000) => { const state = { width, overrides: new Map<number, number>() }, made = new UniformLayout(state, max); made.setCount(count); return { made, state } }
  it('places columns by the shared width and the overrides before them', () => {
    const { made } = layout(4095)
    expect([made.count, made.total, made.xOf(10), made.columnAt(1050), made.columnAt(-1), made.columnAt(made.total)]).toEqual([4095, 409_500, 1000, 10, -1, 4095])
    expect(made.setWidth(3, 250)).toBe(250)
    made.setWidth(2000, 40)
    expect([made.width(3), made.xOf(3), made.xOf(4), made.xOf(2001), made.total]).toEqual([250, 300, 550, 200_100 + 150 - 60, 409_500 + 150 - 60])
    expect([made.columnAt(549), made.columnAt(550), made.columnAt(299)]).toEqual([3, 4, 2])
    // Back at the shared width, a column is no longer one sized apart.
    made.setWidth(3, 100)
    expect(made.xOf(4)).toBe(400)
  })
  it('agrees with a width per column wherever a frame, a hit test and a reveal read it', () => {
    const { made } = layout(40, 80)
    made.setWidth(5, 200)
    made.setWidth(17, 32)
    const widths = Float64Array.from({ length: 40 }, (_, index) => index === 5 ? 200 : index === 17 ? 32 : 80), table = new ColumnLayout(widths, 15_000_000)
    expect(made.total).toBe(table.total)
    for (let column = 0; column <= 40; column++) expect(made.xOf(column), `xOf ${column}`).toBe(table.xOf(column))
    for (let x = -5; x < table.total + 10; x += 7) expect(made.columnAt(x), `columnAt ${x}`).toBe(table.columnAt(x))
  })
  it('grows with the rows without touching a width, and takes a new shared width at once', () => {
    const { made, state } = layout(64)
    made.setWidth(1, 300)
    made.setCount(4095)
    expect(made.total).toBe(4095 * 100 + 200)
    made.setShared(60)
    expect([state.width, made.width(0), made.width(1), made.xOf(2)]).toEqual([60, 60, 300, 360])
  })
  it('keeps at most 256 widths of its own, the newest, and drops them all when positions name other rows', () => {
    const { made, state } = layout(4095)
    for (let index = 0; index < maxWidthOverrides + 10; index++) made.setWidth(index, 120)
    expect(state.overrides.size).toBe(maxWidthOverrides)
    expect([made.width(0), made.width(9), made.width(10)]).toEqual([100, 100, 120])
    made.clearOverrides()
    expect([state.overrides.size, made.total]).toEqual([0, 409_500])
  })
  it('never grows past the scroll range, and holds every width within its bounds', () => {
    const { made } = layout(4095, 100, 500_000)
    expect(made.setWidth(0, 3000)).toBe(3000)
    made.setShared(3000)
    expect(made.total).toBeLessThanOrEqual(500_000)
    expect(made.setWidth(1, 5)).toBe(gridLimits.columnMinWidth)
    // A saved state from elsewhere is brought inside them as the layout is built.
    const kept = { width: Number.NaN, overrides: new Map([[2, 9000], [-1, 50], [3, Number.NaN]]) }, built = new UniformLayout(kept, 15_000_000)
    expect([built.shared, [...kept.overrides]]).toEqual([gridLimits.initialMinWidth, [[2, gridLimits.columnMaxWidth]]])
  })
})

describe('tiles of a transposed grid', () => {
  it('are 32 rows by 128 columns: the same cells as a table\'s tile, turned', () => {
    expect(transposedTiles).toEqual({ rows: 32, columns: 128 })
    // Drawn columns 40–70 are rows 40–70; drawn rows 200–260 are columns 200–260.
    const plan = planTiles({ firstRow: 40, lastRow: 70, firstColumn: 200, lastColumn: 260 }, 5000, 4096, transposedTiles)
    expect(plan.map(key => { const tile = tileRequest(key, 5000, 4096, transposedTiles); return [tile.first, tile.count, tile.colStart, tile.colEnd] }).sort()).toEqual([[32, 32, 128, 256], [32, 32, 256, 384], [64, 32, 128, 256], [64, 32, 256, 384]].sort())
  })
  it('are read in that shape, with the header column\'s tile beside each row tile', () => {
    const { handle, reads } = source(5000, 4096)
    const data = new GridData({ handle, columns: 4096, shape: transposedTiles, also: 300, clientInflight: () => 0, changed: () => {} })
    // Drawn columns 40–50 are rows 40–50, in one row tile; drawn rows 600–640 are columns in two column tiles; column 300 is in a third.
    data.ensure({ firstRow: 40, lastRow: 50, firstColumn: 600, lastColumn: 640 }, 5000, 0, 30)
    expect(reads.map(read => [read.first, read.count, read.o.colStart, read.o.colEnd]).sort()).toEqual([[32, 32, 512, 640], [32, 32, 640, 768], [32, 32, 256, 384]].sort())
  })
})

describe('the name column\'s border', () => {
  it('is a resize zone of the frozen column only where asked, over whatever has scrolled under it', () => {
    const layout = new UniformLayout({ width: 100, overrides: new Map() }, 15_000_000)
    layout.setCount(50)
    const o = { viewport: { top: 0, left: 250, width: 900, height: 300 }, rows: 8, layout, rowHeader: 120 }
    expect(hitTest(118, 10, { ...o, frozenResize: true })).toEqual({ kind: 'resize', column: frozenColumn })
    expect(hitTest(121, 10, { ...o, frozenResize: true })).toEqual({ kind: 'resize', column: frozenColumn })
    expect(hitTest(100, 10, { ...o, frozenResize: true })).toEqual({ kind: 'corner' })
    expect(hitTest(140, 10, { ...o, frozenResize: true })).toEqual({ kind: 'column', column: 2 })
    // Below the header row the border resizes nothing, and a table's corner has none.
    expect(hitTest(118, 40, { ...o, frozenResize: true })).toEqual({ kind: 'row', row: 0 })
    expect(hitTest(118, 10, o)).toEqual({ kind: 'corner' })
  })
})

describe('test mode\'s orientation switch', () => {
  it('tells every listening grid, until it stops listening', () => {
    const stats = new GridStats(), heard: unknown[] = []
    const stop = stats.onOrientation(request => heard.push(request))
    stats.setOrientation({ transposed: true, headerColumn: 2, entry: 'e1' })
    stop()
    stats.setOrientation({ transposed: false })
    expect(heard).toEqual([{ transposed: true, headerColumn: 2, entry: 'e1' }])
  })
})

/** A GridView over a stand-in result, in a scroller that reports a size (happy-dom lays nothing out). */
function mount(o: { rows: number; columns: number; transposed?: boolean; headerColumn?: number; state?: GridViewState; rowSize?: boolean; text?: (row: number, column: number) => string | null }) {
  const made = source(o.rows, o.columns, o.text)
  const root = document.createElement('div'), scroller = document.createElement('div')
  for (const [name, value] of Object.entries({ 'data-output-view': 'grid', 'data-tab-id': 'query', 'data-result-entry': 'e1', 'data-result-generation': '1', 'data-result-id': '1' })) root.setAttribute(name, value)
  root.append(scroller)
  document.body.append(root)
  for (const [name, value] of [['clientWidth', 900], ['offsetWidth', 900], ['clientHeight', 300]] as const) Object.defineProperty(scroller, name, { value })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 900, 300)
  const state = o.state ?? freshState()
  const onSelection = vi.fn(), onOpenValue = vi.fn(), onSort = vi.fn(), onFilter = vi.fn(), onBeyondCap = vi.fn()
  const view = new GridView({
    root, scroller, handle: made.handle, client: { windowsInFlight: 0 }, descriptor: descriptor(made.handle), state, entry: 'e1', resultNumber: 1, resultCount: 1, platform: 'win32',
    transposed: o.transposed ?? true, ...o.headerColumn === undefined ? {} : { headerColumn: o.headerColumn }, ...o.rowSize ? { rowSize: true } : {},
    onSelection, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }, onOpenValue, onSort, onFilter, onBeyondCap
  })
  /** The reads answered and the frame after them painted, twice: a tile read by the first frame shows in the second. */
  const once = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
  const frame = async () => { await once(); await once() }
  const key = (name: string, init: KeyboardEventInit = {}) => view.key(new KeyboardEvent('keydown', { key: name, ...init }))
  const shown = <T extends Element = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)].filter(element => (element as unknown as HTMLElement).style.display !== 'none')
  /** The cell that shows the result's (row, column): transposed, the drawn row is the column. */
  const cellAt = (row: number, col: number) => root.querySelector<HTMLElement>(o.transposed === false
    ? `[role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${col + 2}"]` : `[role="row"][aria-rowindex="${col + 2}"] > [role="gridcell"][aria-colindex="${row + 2}"]`)
  const pointer = (type: string, target: Element, x: number, y: number, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    target.dispatchEvent(event)
  }
  const nameWidth = () => Number.parseFloat(root.style.getPropertyValue('--rg-rhw'))
  const names = () => shown('.rg-rn')
  const headers = () => shown('.rg-ch')
  const corner = () => root.querySelector<HTMLElement>('.rg-corner')!
  return { ...made, root, scroller, state, view, frame, key, shown, cellAt, pointer, nameWidth, names, headers, corner, onSelection, onOpenValue, onSort, onFilter, onBeyondCap }
}

describe('a grid transposed', () => {
  it('draws columns as rows named in the frozen first column, and rows as columns headed Row N', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    expect(grid.root.dataset.orientation).toBe('transposed')
    await grid.frame()
    expect(grid.names().map(mark => mark.querySelector('.rg-cn')!.textContent)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', '(No column name)'])
    expect(grid.names()[0].querySelector('.rg-ct')!.textContent).toBe('nvarchar(max)')
    expect([grid.names()[4].classList.contains('unnamed'), grid.names()[5].classList.contains('unnamed')]).toEqual([false, true])
    expect(grid.headers().slice(0, 2).map(header => header.textContent)).toEqual(['Row 1', 'Row 2'])
    // The drawn row for column 4, at the drawn column for row 1, shows row 1's value of column 4.
    expect(grid.root.querySelector('[role="row"][aria-rowindex="6"] > [role="gridcell"][aria-colindex="3"]')!.textContent).toBe('1:4')
    expect([grid.cellAt(1, 4)!.textContent, grid.cellAt(0, 0)!.textContent, grid.cellAt(7, 5)!.textContent]).toEqual(['1:4', '0:0', '7:5'])
    // Column 2 is a link column, so its whole drawn row links.
    expect([grid.cellAt(3, 2)!.className.includes('is-link'), grid.cellAt(3, 4)!.className.includes('is-link')]).toEqual([true, false])
    expect(grid.root.getAttribute('aria-label')).toBe(transposedLabel('Result 1 of 1', 50, 6, 50, false))
    expect(grid.root.getAttribute('aria-label')).toBe('Result 1 of 1, transposed, 6 columns as rows, 50 rows as columns')
    expect([grid.root.getAttribute('aria-rowcount'), grid.root.getAttribute('aria-colcount')]).toEqual(['7', '51'])
    // A screen reader's row header is the column's name.
    expect(grid.root.querySelector('[role="row"][aria-rowindex="5"] > [role="rowheader"]')!.textContent).toBe('c3')
    grid.view.dispose()
    expect(grid.root.dataset.orientation).toBeUndefined()
  })
  it('reads tiles of 32 rows by 128 columns of the result', async () => {
    const grid = mount({ rows: 500, columns: 300 })
    await grid.frame()
    expect(grid.reads.length).toBeGreaterThan(0)
    expect(grid.reads.every(read => read.count === 32 && read.first % 32 === 0 && read.o.colStart! % 128 === 0)).toBe(true)
    expect(grid.reads[0]).toMatchObject({ first: 0, o: { colStart: 0, colEnd: 128 } })
    grid.view.dispose()
  })
  it('keeps the selection in the result\'s rows and columns while keys move over what is drawn', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    expect(grid.state.selection).toEqual(cells([0, 0]))
    expect(grid.onSelection).not.toHaveBeenCalled()
    grid.key('ArrowRight')
    grid.key('ArrowRight')
    grid.key('ArrowDown')
    // Two drawn columns right is row 2; one drawn row down is column 1.
    expect(grid.state.selection).toEqual(cells([2, 1]))
    expect(grid.onSelection).toHaveBeenLastCalledWith(cells([2, 1]))
    expect(grid.onSelection).toHaveBeenCalledTimes(3)
    expect(grid.view.currentSelection()).toBe(grid.state.selection)
    grid.key('ArrowRight', { shiftKey: true })
    expect(grid.state.selection).toEqual(cells([2, 1], [3, 1]))
    await grid.frame()
    expect([grid.cellAt(2, 1)!.className.includes('is-sel'), grid.cellAt(3, 1)!.className.includes('is-act'), grid.cellAt(4, 1)!.className.includes('is-sel'), grid.cellAt(2, 2)!.className.includes('is-sel')]).toEqual([true, true, false, false])
    // The name cell of a column with selected cells shows it, as a row's number does.
    expect(grid.names().map(mark => mark.classList.contains('sel'))).toEqual([false, true, false, false, false, false])
    grid.key('End', { ctrlKey: true })
    expect(grid.state.selection!.active).toEqual({ row: 49, column: 5 })
    // Shift+Space selects the drawn row, a whole column of the result; Ctrl+Space the drawn column, a whole row.
    grid.key(' ', { shiftKey: true })
    expect(grid.state.selection!.blocks.at(-1)!.kind).toBe('columns')
    grid.key(' ', { ctrlKey: true })
    expect(grid.state.selection!.blocks.at(-1)!.kind).toBe('rows')
    grid.view.selectAll()
    expect(grid.state.selection).toMatchObject({ active: { row: 49, column: 5 }, blocks: [{ kind: 'all' }] })
    // A selection the state was given from outside (a command) is drawn turned.
    grid.state.selection = cells([7, 3])
    await grid.frame()
    expect(grid.cellAt(7, 3)!.className).toContain('is-act')
    grid.view.dispose()
  })
  it('selects by a press where it lands: a cell, a name for its whole column, a header for its whole row', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    const width = grid.nameWidth(), shared = grid.state.transposed!.width
    // The drawn row of column 3 (rows are 20 px under the 22 px header), in the second drawn column: row 1.
    grid.pointer('pointerdown', grid.scroller, width + shared + 5, 22 + 3 * 20 + 5)
    grid.pointer('pointerup', grid.scroller, width + shared + 5, 22 + 3 * 20 + 5)
    expect(grid.state.selection).toEqual(cells([1, 3]))
    grid.pointer('pointerdown', grid.scroller, 10, 22 + 4 * 20 + 5)
    grid.pointer('pointerup', grid.scroller, 10, 22 + 4 * 20 + 5)
    expect(grid.state.selection).toMatchObject({ blocks: [{ kind: 'columns', anchor: { column: 4 } }] })
    grid.pointer('pointerdown', grid.scroller, width + 2 * shared + 5, 10)
    grid.pointer('pointerup', grid.scroller, width + 2 * shared + 5, 10)
    expect(grid.state.selection).toMatchObject({ blocks: [{ kind: 'rows', anchor: { row: 2 } }] })
    grid.view.dispose()
  })
  it('opens a link\'s value with the result\'s row and column, by Enter and by a click', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    grid.state.selection = cells([9, 2])
    grid.key('Enter')
    expect(grid.onOpenValue).toHaveBeenLastCalledWith(9, 2)
    grid.state.selection = cells([9, 3])
    expect(grid.key('Enter')).toBe(false)
    const x = grid.nameWidth() + 4 * grid.state.transposed!.width + 5, y = 22 + 2 * 20 + 5
    grid.pointer('pointerdown', grid.scroller, x, y)
    grid.pointer('pointerup', grid.scroller, x, y)
    expect(grid.onOpenValue).toHaveBeenLastCalledWith(4, 2)
    expect(grid.onOpenValue).toHaveBeenCalledTimes(2)
    grid.view.dispose()
  })
  it('stops at the cap: 4,095 rows are drawn, Ctrl+End goes to the last of them, and a match past it is reported', async () => {
    const grid = mount({ rows: 6000, columns: 6 })
    await grid.frame()
    expect(grid.root.getAttribute('aria-colcount')).toBe('4096')
    expect(grid.root.getAttribute('aria-label')).toBe('Result 1 of 1, transposed, 6 columns as rows, the first 4,095 of 6,000 rows as columns')
    grid.key('End', { ctrlKey: true })
    expect(grid.state.selection!.active).toEqual({ row: 4094, column: 5 })
    grid.key('ArrowRight')
    expect(grid.state.selection!.active).toEqual({ row: 4094, column: 5 })
    await grid.frame()
    expect(grid.cellAt(4094, 5)!.textContent).toBe('4094:5')
    // A match past the cap is reported, not revealed: nothing scrolls and the selection stays.
    const before = { ...grid.state.transposed!, overrides: undefined }, selection = grid.state.selection
    grid.view.setMarks({ handle: grid.handle, cells: new Set([cellKey(5000, 1)]), current: { row: 5000, column: 1 } })
    expect(grid.view.revealMark(true)).toBe(true)
    await grid.frame()
    expect(grid.onBeyondCap).toHaveBeenCalledWith(5000)
    expect([{ ...grid.state.transposed!, overrides: undefined }, grid.state.selection]).toEqual([before, selection])
    // The last row drawn is not past it.
    grid.view.setMarks({ handle: grid.handle, cells: new Set([cellKey(4094, 1)]), current: { row: 4094, column: 1 } })
    grid.view.revealMark()
    expect(grid.onBeyondCap).toHaveBeenCalledTimes(1)
    grid.view.dispose()
  })
  it('moves an active cell past the cap to the last row drawn, tells the owner, and keeps the blocks', async () => {
    const state = freshState()
    state.selection = { entry: 'e1', active: { row: 5200, column: 3 }, blocks: [{ kind: 'rows', anchor: { row: 5200, column: 0 }, focus: { row: 5210, column: 0 } }] }
    const grid = mount({ rows: 6000, columns: 6, state })
    await grid.frame()
    expect(grid.state.selection).toEqual({ entry: 'e1', active: { row: 4094, column: 3 }, blocks: [{ kind: 'rows', anchor: { row: 5200, column: 0 }, focus: { row: 5210, column: 0 } }] })
    expect(grid.onSelection).toHaveBeenCalledTimes(1)
    expect(grid.onSelection).toHaveBeenLastCalledWith(grid.state.selection)
    // Blocks beyond the cap draw nothing.
    expect(grid.shown('[role="gridcell"][aria-selected="true"]')).toEqual([])
    grid.view.dispose()
  })
  it('grows its columns as rows arrive without being built again', async () => {
    const grid = mount({ rows: 2, columns: 6 })
    await grid.frame()
    expect(grid.headers().length).toBe(2)
    const first = grid.headers()[0]
    grid.grow(40)
    await grid.frame()
    expect(grid.root.getAttribute('aria-colcount')).toBe('41')
    expect(grid.headers().length).toBeGreaterThan(2)
    expect(grid.headers()[0]).toBe(first)
    grid.view.dispose()
  })
  it('names the columns of a result with no rows', async () => {
    const grid = mount({ rows: 0, columns: 6 })
    await grid.frame()
    expect(grid.names().map(mark => mark.querySelector('.rg-cn')!.textContent)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', '(No column name)'])
    expect([grid.headers().length, grid.shown('[role="gridcell"]').length, grid.reads.length]).toEqual([0, 0, 0])
    expect(grid.root.getAttribute('aria-label')).toBe('Result 1 of 1, transposed, 6 columns as rows, 0 rows as columns')
    expect(grid.state.selection).toBeUndefined()
    // Its names still answer for their columns.
    expect(gridTarget(grid.root, grid.names()[3]).target).toEqual({ column: 3 })
    grid.grow(3)
    await grid.frame()
    expect(grid.headers().map(header => header.textContent)).toEqual(['Row 1', 'Row 2', 'Row 3'])
    grid.view.dispose()
  })
  it('heads a column with the header column\'s value once its tile is read, as a pivot names a group, and Row N until then', async () => {
    const long = 'x'.repeat(200)
    const grid = mount({ rows: 50, columns: 6, headerColumn: 3, text: (row, col) => col !== 3 ? `${row}:${col}` : row === 1 ? null : row === 2 ? '' : row === 3 ? long : row === 4 ? 'a\tb' : `name ${row}` })
    expect(grid.headers()[0].textContent).toBe('Row 1')
    await grid.frame()
    expect(grid.headers().slice(0, 6).map(header => header.textContent)).toEqual(['name 0', 'NULL', '(blank)', 'x'.repeat(128), 'a b', 'name 5'])
    // The header column is still drawn as a row.
    expect(grid.cellAt(0, 3)!.textContent).toBe('name 0')
    grid.view.update({ resultCount: 1, headerColumn: null })
    await grid.frame()
    expect(grid.headers().slice(0, 2).map(header => header.textContent)).toEqual(['Row 1', 'Row 2'])
    grid.view.update({ resultCount: 1, headerColumn: 0 })
    await grid.frame()
    expect(grid.headers().slice(0, 2).map(header => header.textContent)).toEqual(['0:0', '1:0'])
    grid.view.dispose()
  })
  it('answers a menu target in the result\'s rows and columns', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    expect(gridTarget(grid.root, grid.cellAt(1, 4)!).target).toEqual({ row: 1, column: 4 })
    expect(gridTarget(grid.root, grid.headers()[2]).target).toEqual({ row: 2 })
    const name = grid.names()[3]
    expect(gridTarget(grid.root, name).target).toEqual({ column: 3 })
    expect(gridTarget(grid.root, name.querySelector('.rg-cn')!).target).toEqual({ column: 3 })
    expect(gridTarget(grid.root, grid.root.querySelector('[role="row"][aria-rowindex="5"] > [role="rowheader"]')!).target).toEqual({ column: 3 })
    expect(gridTarget(grid.root, grid.corner()).target).toBeUndefined()
    // What the menus read: a cell both, a name its column alone, a header its row alone.
    expect(outputTarget(grid.cellAt(1, 4)!)).toMatchObject({ view: 'grid', row: 1, column: 4 })
    expect(outputTarget(name)).toMatchObject({ column: 3 })
    expect(outputTarget(name)).not.toHaveProperty('row')
    expect(outputTarget(grid.headers()[2])).toMatchObject({ row: 2 })
    expect(outputTarget(grid.headers()[2])).not.toHaveProperty('column')
    // The active cell keeps a slot when its drawn row is out of view, and still names its place in the result.
    const tall = mount({ rows: 50, columns: 80 })
    await tall.frame()
    tall.state.selection = cells([2, 70])
    await tall.frame()
    expect(gridTarget(tall.root, tall.root.querySelector('.is-act')!).target).toEqual({ row: 2, column: 70 })
    grid.view.dispose()
    tall.view.dispose()
  })
  it('sorts and filters from a column\'s name cell, and says how it is sorted on that row\'s header', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    // A drawn column is a row, and there is nothing to sort a row by.
    expect(grid.headers()[0].querySelector('.rg-cs, .rg-cf')).toBeNull()
    const name = grid.names()[3], sort = name.querySelector<HTMLElement>('.rg-cs')!, funnel = name.querySelector<HTMLElement>('.rg-cf')!
    expect([sort.getAttribute('aria-hidden'), funnel.getAttribute('aria-hidden'), name.classList.contains('fb')]).toEqual(['true', 'true', true])
    grid.pointer('pointerdown', sort, 60, 22 + 3 * 20 + 5)
    expect(grid.onSort).toHaveBeenLastCalledWith(3, false)
    grid.pointer('pointerdown', sort, 60, 22 + 3 * 20 + 5, { shiftKey: true })
    expect(grid.onSort).toHaveBeenLastCalledWith(3, true)
    grid.pointer('pointerdown', funnel, 60, 22 + 3 * 20 + 5)
    expect(grid.onFilter).toHaveBeenCalledTimes(1)
    expect(grid.onFilter.mock.calls[0][0]).toBe(3)
    // None of them selected anything.
    expect(grid.state.selection).toEqual(cells([0, 0]))
    grid.view.update({ resultCount: 1, sort: [{ column: 3, descending: true }, { column: 0, descending: false }], filtered: new Set([1]) })
    await grid.frame()
    const rowHeaders = [...grid.root.querySelectorAll('[role="rowgroup"] > [role="row"][aria-rowindex] > [role="rowheader"]')].slice(0, 6)
    expect(rowHeaders.map(header => header.getAttribute('aria-sort'))).toEqual([null, null, null, 'descending', null, null])
    expect(grid.names().map(mark => [mark.querySelector('.rg-cs')!.classList.contains('on'), mark.querySelector('.rg-co')!.textContent, mark.querySelector('.rg-cf')!.classList.contains('on')]))
      .toEqual([[true, '2', false], [false, '', true], [false, '', false], [true, '1', false], [false, '', false], [false, '', false]])
    // Only some columns filter: the others' names have no funnel.
    grid.view.update({ resultCount: 1, filterable: new Set([0, 2]) })
    await grid.frame()
    expect(grid.names().map(mark => mark.classList.contains('fb'))).toEqual([true, false, true, false, false, false])
    // Alt+Down's popover opens beside the name, in the column's drawn row.
    const anchor = grid.view.filterAnchor(2)
    expect([anchor.right, anchor.top, anchor.height]).toEqual([grid.nameWidth(), 22 + 2 * 20, 20])
    grid.view.dispose()
  })
  it('says what a name is on hover, and which row a header stands for', async () => {
    const grid = mount({ rows: 50, columns: 6, headerColumn: 1 })
    await grid.frame()
    const name = grid.names()[3]
    grid.pointer('pointerover', name.querySelector('.rg-cn')!, 10, 90)
    expect(name.title).toBe('c3 (nvarchar(max), null)')
    grid.pointer('pointerover', grid.names()[5], 10, 130)
    expect([name.hasAttribute('title'), grid.names()[5].title]).toEqual([false, '(No column name) (nvarchar(max), null)'])
    grid.pointer('pointerover', grid.headers()[2], 400, 10)
    expect(grid.headers()[2].title).toBe('Row 3: 2:1')
    grid.view.update({ resultCount: 1, headerColumn: null })
    await grid.frame()
    grid.pointer('pointerover', grid.headers()[1], 300, 10)
    expect(grid.headers()[1].title).toBe('Row 2')
    grid.view.dispose()
  })
  it('sizes the name column by a drag of the corner\'s border, fits it on a double-click, and keeps the width in the state', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    const fitted = grid.nameWidth()
    expect(fitted).toBeGreaterThanOrEqual(gridLimits.nameColumnMinWidth)
    expect(fitted).toBeLessThanOrEqual(gridLimits.nameColumnMaxWidth)
    expect(grid.state.transposed!.nameWidth).toBeUndefined()
    const first = () => Number.parseFloat(grid.cellAt(0, 0)!.style.left)
    expect(first()).toBe(fitted)
    // A press that moves nothing sizes nothing.
    grid.pointer('pointerdown', grid.corner(), fitted - 1, 10)
    grid.pointer('pointerup', grid.corner(), fitted - 1, 10)
    expect(grid.state.transposed!.nameWidth).toBeUndefined()
    expect(grid.state.selection).toEqual(cells([0, 0]))
    grid.pointer('pointerdown', grid.corner(), fitted - 1, 10)
    grid.pointer('pointermove', grid.corner(), fitted + 59, 10)
    await grid.frame()
    expect([grid.nameWidth(), first()]).toEqual([fitted + 60, fitted + 60])
    // Escape puts it back, fitting its names again.
    grid.key('Escape')
    await grid.frame()
    expect([grid.nameWidth(), grid.state.transposed!.nameWidth]).toEqual([fitted, undefined])
    grid.pointer('pointerdown', grid.corner(), fitted - 1, 10)
    grid.pointer('pointermove', grid.corner(), fitted - 1 - 500, 10)
    await grid.frame()
    grid.pointer('pointerup', grid.corner(), fitted - 1 - 500, 10)
    expect([grid.nameWidth(), grid.state.transposed!.nameWidth]).toEqual([gridLimits.nameColumnMinWidth, gridLimits.nameColumnMinWidth])
    // It never takes the whole grid: a drawn column always shows beside it.
    grid.pointer('pointerdown', grid.corner(), gridLimits.nameColumnMinWidth, 10)
    grid.pointer('pointermove', grid.corner(), 5000, 10)
    await grid.frame()
    grid.pointer('pointerup', grid.corner(), 5000, 10)
    expect(grid.nameWidth()).toBe(900 - gridLimits.columnMinWidth)
    // The saved width is the next view's.
    grid.view.dispose()
    const again = mount({ rows: 50, columns: 6, state: grid.state })
    await again.frame()
    expect(again.nameWidth()).toBe(900 - gridLimits.columnMinWidth)
    again.pointer('dblclick', again.corner(), again.nameWidth() - 1, 10)
    await again.frame()
    expect([again.nameWidth(), again.state.transposed!.nameWidth]).toEqual([fitted, fitted])
    again.view.dispose()
  })
  it('widens the name column for the types when they show, unless the user sized it', async () => {
    const grid = mount({ rows: 50, columns: 6 })
    await grid.frame()
    const withTypes = grid.nameWidth()
    grid.view.update({ resultCount: 1, showTypes: false })
    await grid.frame()
    expect(grid.nameWidth()).toBeLessThan(withTypes)
    expect(grid.names()[0].querySelector('.rg-ct')!.textContent).toBe('')
    grid.view.update({ resultCount: 1, showTypes: true })
    await grid.frame()
    expect([grid.nameWidth(), grid.names()[0].querySelector('.rg-ct')!.textContent]).toEqual([withTypes, 'nvarchar(max)'])
    grid.view.dispose()
  })
  it('gives the drawn columns one width, at most 240 px, and a dragged or fitted one a width of its own', async () => {
    const state: GridViewState = { ...freshState(), sized: false }
    const grid = mount({ rows: 50, columns: 60, state })
    await grid.frame()
    // The widest value of the first rows is 63 characters, wider than the cap allows.
    expect(grid.measure).toHaveBeenCalledWith(0, 50, 0, 60)
    expect([grid.state.transposed!.width, grid.state.transposed!.sized]).toEqual([gridLimits.transposedMaxWidth, true])
    expect(grid.headers().slice(0, 3).map(header => header.style.width)).toEqual(['240px', '240px', '240px'])
    // The table's own widths are another matter, and untouched.
    expect(grid.state.widths).toBeUndefined()
    const border = grid.nameWidth() + 2 * 240
    grid.pointer('pointerdown', grid.headers()[1], border - 1, 10)
    grid.pointer('pointermove', grid.headers()[1], border - 101, 10)
    await grid.frame()
    grid.pointer('pointerup', grid.headers()[1], border - 101, 10)
    expect([...grid.state.transposed!.overrides]).toEqual([[1, 140]])
    expect(grid.headers().slice(0, 3).map(header => [header.style.left, header.style.width])).toEqual([[grid.nameWidth() + 'px', '240px'], [grid.nameWidth() + 240 + 'px', '140px'], [grid.nameWidth() + 380 + 'px', '240px']])
    // Fit Column, of a drawn column, is one row measured across the columns; a double-click on its border does it.
    grid.measure.mockClear()
    grid.pointer('dblclick', grid.headers()[0], grid.nameWidth() + 239, 10)
    await grid.frame()
    expect(grid.measure).toHaveBeenCalledTimes(1)
    expect(grid.measure.mock.calls[0].slice(0, 4)).toEqual([0, 1, 0, 60])
    expect(grid.state.transposed!.overrides.get(0)).toBeGreaterThan(240)
    grid.view.fitRow(7)
    expect(grid.measure.mock.calls[1].slice(0, 4)).toEqual([7, 1, 0, 60])
    // Fit of a column of the result means nothing here: it is a drawn row, and rows have one height.
    grid.view.fitColumn(3)
    grid.view.fitRow(50)
    expect(grid.measure).toHaveBeenCalledTimes(2)
    grid.view.dispose()
  })
  it('after a new order or other rows goes to its first drawn column, keeps its vertical place, and drops the widths given to positions', async () => {
    const grid = mount({ rows: 500, columns: 80 })
    await grid.frame()
    grid.view.fitRow(3)
    grid.state.selection = cells([300, 60])
    grid.view.revealMark()
    grid.key('ArrowDown')
    await grid.frame()
    const kept = grid.state.transposed!
    expect(kept.scrollLeft).toBeGreaterThan(0)
    expect(kept.virtualTop).toBeGreaterThan(0)
    expect(kept.overrides.size).toBe(1)
    const top = kept.virtualTop, other = source(400, 80)
    // The same view built again keeps everything.
    grid.view.swap(other.handle, descriptor(other.handle), row => row)
    await grid.frame()
    expect([kept.scrollLeft > 0, kept.virtualTop, kept.overrides.size]).toEqual([true, top, 1])
    grid.view.swap(grid.handle, descriptor(grid.handle), row => row, { top: 0 })
    await grid.frame()
    expect([kept.scrollLeft, kept.virtualTop, kept.overrides.size]).toEqual([0, top, 0])
    grid.view.dispose()
  })
  it('puts a highlighted row\'s colour and a row\'s size on its drawn column\'s header, and tints the column', async () => {
    const grid = mount({ rows: 50, columns: 6, rowSize: true })
    grid.view.setHighlights([{ handle: grid.handle, positions: Float64Array.of(1, 3), colors: Uint8Array.of(1, 3) }])
    await grid.frame()
    const headers = grid.headers()
    expect(headers.slice(0, 4).map(header => [header.classList.contains('hl-yellow'), header.classList.contains('hl-blue'), header.getAttribute('aria-description')]))
      .toEqual([[false, false, null], [true, false, 'Highlighted yellow'], [false, false, null], [false, true, 'Highlighted blue']])
    // One band a highlighted column, over that column.
    const bands = grid.shown('.rg-band')
    expect(bands.map(band => [band.className, band.style.left, band.style.width, band.style.height])).toEqual([
      ['rg-band hl-yellow', headers[1].style.left, headers[1].style.width, '120px'], ['rg-band hl-blue', headers[3].style.left, headers[3].style.width, '120px']])
    expect(grid.root.querySelector('.rg-bands')!.getAttribute('aria-hidden')).toBe('true')
    // No drawn row is highlighted: a drawn row is a column.
    expect(grid.shown('[role="row"].hl, .rg-rn.hl')).toEqual([])
    // The size bar: row 49 is the largest read, so row 0 is a fiftieth of it and row 49 all of it.
    expect(headers[0].style.getPropertyValue('--rg-rs')).toBe('0.02')
    expect(headers[0].title).toBe('Row 1: 10 bytes (the sum of DATALENGTH over its columns)')
    expect(grid.names().every(mark => mark.style.getPropertyValue('--rg-rs') === '' && !mark.hasAttribute('title'))).toBe(true)
    // A hover leaves the bar's tooltip in place.
    grid.pointer('pointerover', headers[0], 200, 10)
    grid.pointer('pointerover', grid.cellAt(0, 0)!, 200, 30)
    expect(headers[0].title).toBe('Row 1: 10 bytes (the sum of DATALENGTH over its columns)')
    grid.view.setHighlights([])
    grid.view.update({ resultCount: 1, rowSize: false })
    await grid.frame()
    expect([grid.shown('.rg-band').length, headers[1].classList.contains('hl'), headers[1].hasAttribute('aria-description'), headers[0].style.getPropertyValue('--rg-rs'), headers[0].hasAttribute('title')]).toEqual([0, false, false, '', false])
    grid.view.dispose()
  })
  it('marks a search\'s matches where they are drawn: a value in its turned cell, a name in its name cell', async () => {
    const grid = mount({ rows: 50, columns: 40 })
    await grid.frame()
    grid.view.setMarks({ handle: grid.handle, cells: new Set([cellKey(4, 1), cellKey(30, 35)]), current: { row: 30, column: 35 } })
    await grid.frame()
    expect([grid.cellAt(4, 1)!.className.includes('is-hit'), grid.cellAt(1, 4)!.className.includes('is-hit')]).toEqual([true, false])
    // The active match comes into view, down to its column's drawn row and across to its row's drawn column.
    expect(grid.cellAt(30, 35)).toBeNull()
    expect(grid.view.revealMark()).toBe(true)
    await grid.frame()
    expect(grid.cellAt(30, 35)!.className).toContain('is-cur')
    expect(grid.state.transposed!.virtualTop).toBeGreaterThan(0)
    expect(grid.state.transposed!.scrollLeft).toBeGreaterThan(0)
    // Column names: matched names are marked, the active one scrolls into view vertically only, and the columns left out dim.
    const columns = new Uint8Array(40)
    columns[1] = columns[38] = 1
    grid.state.transposed!.virtualTop = grid.state.transposed!.topRow = 0
    grid.view.setMarks({ columns, currentColumn: 1 })
    grid.view.revealMark()
    await grid.frame()
    const left = grid.state.transposed!.scrollLeft
    expect(grid.names().slice(0, 3).map(mark => ['hit', 'cur', 'dim'].filter(name => mark.classList.contains(name)))).toEqual([['dim'], ['cur'], ['dim']])
    expect(grid.headers().some(header => ['hit', 'cur', 'dim'].some(name => header.classList.contains(name)))).toBe(false)
    expect([grid.shown('[role="row"][aria-rowindex="3"] > .is-dim').length, grid.shown('[role="row"][aria-rowindex="2"] > .is-dim').length > 0]).toEqual([0, true])
    grid.view.setMarks({ columns, currentColumn: 38 })
    grid.view.revealMark()
    await grid.frame()
    expect(grid.names().some(mark => mark.classList.contains('cur') && mark.querySelector('.rg-cn')!.textContent === 'c38')).toBe(true)
    expect(grid.state.transposed!.scrollLeft).toBe(left)
    grid.view.dispose()
  })
  it('keeps each orientation\'s place and widths in the state, with one selection for both', async () => {
    const state: GridViewState = { ...freshState(), sized: false }
    const table = mount({ rows: 500, columns: 80, state, transposed: false })
    await table.frame()
    table.key('End', { ctrlKey: true })
    await table.frame()
    const tableOffsets = { topRow: state.topRow, virtualTop: state.virtualTop, scrollLeft: state.scrollLeft }, widths = Float64Array.from(state.widths!)
    expect(tableOffsets.virtualTop).toBeGreaterThan(0)
    expect(state.transposed).toBeUndefined()
    expect(table.root.dataset.orientation).toBeUndefined()
    table.view.dispose()
    // Turned over the same state: the selection is the table's, drawn turned, and the view starts at its own origin.
    const turned = mount({ rows: 500, columns: 80, state })
    await turned.frame()
    expect(state.selection).toEqual(cells([499, 79]))
    expect(state.transposed).toMatchObject({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true })
    turned.key('ArrowLeft')
    turned.key('ArrowUp')
    await turned.frame()
    expect(state.selection).toEqual(cells([498, 78]))
    const kept = { ...state.transposed!, overrides: new Map(state.transposed!.overrides) }
    expect(kept.virtualTop).toBeGreaterThan(0)
    expect(kept.scrollLeft).toBeGreaterThan(0)
    turned.view.fitRow(498)
    await turned.frame()
    expect(state.transposed!.overrides.size).toBe(1)
    // The table's part of the state did not move.
    expect([{ topRow: state.topRow, virtualTop: state.virtualTop, scrollLeft: state.scrollLeft }, state.widths, state.userSized]).toEqual([tableOffsets, widths, undefined])
    turned.view.dispose()
    // Turned again: where it was, with the width that was fitted.
    const again = mount({ rows: 500, columns: 80, state })
    await again.frame()
    expect(again.cellAt(498, 78)!.className).toContain('is-act')
    expect([state.transposed!.virtualTop, state.transposed!.scrollLeft, state.transposed!.overrides.size]).toEqual([kept.virtualTop, kept.scrollLeft, 1])
    again.view.dispose()
    // And the table again: where it was, with the selection made while turned.
    const back = mount({ rows: 500, columns: 80, state, transposed: false })
    await back.frame()
    expect({ topRow: state.topRow, virtualTop: state.virtualTop, scrollLeft: state.scrollLeft }).toEqual(tableOffsets)
    expect(back.cellAt(498, 78)!.className).toContain('is-act')
    // A table has no row to fit.
    back.measure.mockClear()
    back.view.fitRow(3)
    expect(back.measure).not.toHaveBeenCalled()
    back.view.dispose()
  })
})
