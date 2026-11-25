// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import { gridTarget } from '../src/renderer/src/grid/anchor'
import { GridView } from '../src/renderer/src/grid/GridView'
import { gridLimits } from '../src/renderer/src/grid/constants'
import { GridStats } from '../src/renderer/src/grid/stats'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { MenuTargetService, outputTarget } from '../src/renderer/src/menus/targets'
import type { ResultHandle, RowWindow, WindowOptions, WindowShape } from '../src/renderer/src/results/ResultClient'
import type { GridViewState } from '../src/renderer/src/results/ResultsService'

// GridView itself over a stand-in result, in a scroller that reports a size (happy-dom lays nothing out): the seams
// between what it draws and the result's rows and columns. Each is the identity in a table; these checks hold them in
// place there, and tests/grid-orientation.test.ts where the transposed orientation turns them (docs/architecture.md, the
// grid bullet).

const column = (name: string, role?: 'xml') => ({ name, dataType: 'nvarchar', wire: 'text' as const, nullable: true, ...role ? { role } : {} })
/** A result of `rows` × `columns` whose cell (r, c) reads "r:c", answered from a cache keyed as ResultClient keys its windows. */
function source(rows: number, columns: number) {
  const cache = new Map<string, RowWindow>(), reads: { first: number; count: number; o: WindowShape }[] = []
  const keyOf = (first: number, count: number, s: WindowShape) => `${first}:${count}:${s.colStart}:${s.colEnd}`
  const snapshot = { rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, state: 'complete' as const, incomplete: false }
  const handle = {
    key: { generation: 1, resultId: 1 },
    columns: Array.from({ length: columns }, (_, index) => column('c' + index, index === 2 ? 'xml' : undefined)),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    getWindow: async (first: number, count: number, s: WindowOptions = {}) => {
      reads.push({ first, count, o: s })
      // As the worker answers: never within the frame that asked.
      await Promise.resolve()
      const colStart = s.colStart ?? 0, colEnd = Math.min(columns, s.colEnd ?? columns), width = colEnd - colStart
      const held = Math.max(0, Math.min(count, rows - first))
      const window: RowWindow = { first, count: held, colStart, colEnd, text: Array.from({ length: held * width }, (_, index) => `${first + Math.floor(index / width)}:${colStart + index % width}`), flags: new Uint8Array(held * width) }
      cache.set(keyOf(first, count, { colStart, colEnd }), window)
      return window
    },
    peekWindow: (first: number, count: number, s: WindowShape = {}) => cache.get(keyOf(first, count, { colStart: s.colStart ?? 0, colEnd: Math.min(columns, s.colEnd ?? columns) })),
    prefetch: vi.fn(),
    measure: vi.fn(async (_first: number, _count: number, colStart: number, colEnd: number) => ({ rows: 1, widths: Uint16Array.from({ length: colEnd - colStart }, () => 6) })),
    rowBytes: vi.fn(async (first: number) => ({ first, bytes: [], rowsAvailable: rows, estimated: [] }))
  }
  return { handle: handle as unknown as ResultHandle, reads }
}
const descriptor = (handle: ResultHandle): ResultDescriptor => ({ generation: 1, resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [...handle.columns], rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false } as unknown as ResultDescriptor)
const cells = (a: [number, number], b: [number, number] = a): GridSelection => ({ entry: 'e1', active: { row: b[0], column: b[1] }, blocks: [{ kind: 'cells', anchor: { row: a[0], column: a[1] }, focus: { row: b[0], column: b[1] } }] })

function mount(o: { rows: number; columns: number; widths?: readonly number[]; resultName?: string; resultNumber?: number; resultCount?: number; stats?: GridStats; on?: { root: HTMLElement; scroller: HTMLElement }; unsized?: boolean; before?: (handle: ResultHandle) => void }) {
  const made = source(o.rows, o.columns)
  o.before?.(made.handle)
  // `on` builds this view on an earlier view's root and scroller, as a shell rebuilds its view (GridShell's mountKey).
  const root = o.on?.root ?? document.createElement('div'), scroller = o.on?.scroller ?? document.createElement('div')
  for (const [name, value] of Object.entries({ 'data-output-view': 'grid', 'data-tab-id': 'query', 'data-result-entry': 'e1', 'data-result-generation': '1', 'data-result-id': '1' })) root.setAttribute(name, value)
  root.append(scroller)
  document.body.append(root)
  if (!o.on) for (const [name, value] of [['clientWidth', 900], ['offsetWidth', 900], ['clientHeight', 300]] as const) Object.defineProperty(scroller, name, { value })
  const state: GridViewState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: !o.unsized, ...o.widths ? { widths: Float64Array.from(o.widths) } : {} }
  const onSelection = vi.fn(), onOpenValue = vi.fn(), onSort = vi.fn(), onFirstCell = vi.fn()
  const view = new GridView({
    root, scroller, handle: made.handle, client: { windowsInFlight: 0 }, descriptor: descriptor(made.handle), state, entry: 'e1', ...o.stats ? { stats: o.stats } : {}, resultNumber: o.resultNumber ?? 1, resultCount: o.resultCount ?? 1, ...o.resultName ? { resultName: o.resultName } : {}, platform: 'win32',
    onSelection, onFirstCell, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }, onOpenValue, onSort, onFilter: () => {}
  })
  /** The reads answered and the frame after them painted. */
  const frame = async () => { await new Promise(done => setImmediate(done)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setImmediate(done)) }
  const key = (name: string, init: KeyboardEventInit = {}) => view.key(new KeyboardEvent('keydown', { key: name, ...init }))
  const shown = <T extends Element = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)].filter(element => (element as unknown as HTMLElement).style.display !== 'none')
  const cellAt = (row: number, col: number) => root.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${col + 2}"]`)
  return { ...made, root, scroller, state, view, frame, key, shown, cellAt, onSelection, onFirstCell, onOpenValue, onSort }
}

describe('the grid\'s seams', () => {
  it('sizes as new only the widths a rebuilt Pivot could not carry (NaN), keeping the rest', () => {
    const fresh = mount({ rows: 5, columns: 3 })
    const initial = [...fresh.state.widths!]
    fresh.view.dispose()
    const rebuilt = mount({ rows: 5, columns: 3, widths: [Number.NaN, 250, Number.NaN] })
    expect([...rebuilt.state.widths!]).toEqual([initial[0], 250, initial[2]])
    expect(rebuilt.state.sized).toBe(true)
    rebuilt.view.dispose()
  })

  it('reads tiles of 128 rows by 32 columns and shows each cell from its own row and column', async () => {
    const grid = mount({ rows: 500, columns: 40 })
    expect(grid.reads.every(read => read.count === 128 && read.o.colStart! % 32 === 0)).toBe(true)
    expect(grid.reads[0]).toMatchObject({ first: 0, o: { colStart: 0, colEnd: 32 } })
    expect(grid.cellAt(3, 1)!.className).toContain('is-load')
    await grid.frame()
    expect([grid.cellAt(3, 1)!.textContent, grid.cellAt(0, 0)!.textContent, grid.cellAt(7, 4)!.textContent]).toEqual(['3:1', '0:0', '7:4'])
    // A link column's cells are links; its neighbours' are not.
    expect([grid.cellAt(3, 2)!.className.includes('is-link'), grid.cellAt(3, 3)!.className.includes('is-link')]).toEqual([true, false])
    expect(grid.shown('.rg-ch').slice(0, 2).map(header => header.querySelector('.rg-cn')!.textContent)).toEqual(['c0', 'c1'])
    expect(grid.shown('.rg-rn').slice(0, 2).map(mark => mark.textContent)).toEqual(['1', '2'])
    grid.view.dispose()
  })
  it('keeps the selection in the state as the keys and Select All write it, and reports each change once', async () => {
    const grid = mount({ rows: 500, columns: 40 })
    await grid.frame()
    // The first cell is current without being announced, though what follows the selection (the column profile) hears of it.
    expect(grid.state.selection).toEqual(cells([0, 0]))
    expect(grid.onSelection).not.toHaveBeenCalled()
    expect(grid.onFirstCell).toHaveBeenCalledTimes(1)
    grid.key('ArrowRight')
    grid.key('ArrowDown')
    grid.key('ArrowDown')
    expect(grid.state.selection).toEqual(cells([2, 1]))
    expect(grid.onSelection).toHaveBeenLastCalledWith(cells([2, 1]))
    expect(grid.onSelection).toHaveBeenCalledTimes(3)
    expect(grid.view.currentSelection()).toBe(grid.state.selection)
    grid.key('ArrowRight', { shiftKey: true })
    expect(grid.state.selection).toEqual(cells([2, 1], [2, 2]))
    await grid.frame()
    expect([grid.cellAt(2, 1)!.className.includes('is-sel'), grid.cellAt(2, 2)!.className.includes('is-act'), grid.cellAt(2, 3)!.className.includes('is-sel')]).toEqual([true, true, false])
    // Enter on a link opens the value of the active cell.
    grid.key('Enter')
    expect(grid.onOpenValue).toHaveBeenCalledWith(2, 2)
    grid.view.selectAll()
    expect(grid.state.selection).toMatchObject({ active: { row: 2, column: 2 }, blocks: [{ kind: 'all' }] })
    // A selection that names another result is none of this grid's.
    grid.state.selection = { ...cells([4, 4]), entry: 'e2' }
    expect(grid.view.currentSelection()).toBeUndefined()
    grid.view.dispose()
  })
  it('answers what an element is for in the result\'s rows and columns', async () => {
    const grid = mount({ rows: 500, columns: 40 })
    await grid.frame()
    expect(gridTarget(grid.root, grid.cellAt(4, 1)!)).toEqual({ registered: true, target: { row: 4, column: 1 } })
    const header = grid.shown('.rg-ch')[3]
    expect(gridTarget(grid.root, header).target).toEqual({ column: 3 })
    // A header's name and its buttons are the header's.
    expect(gridTarget(grid.root, header.querySelector('.rg-cn')!).target).toEqual({ column: 3 })
    expect(gridTarget(grid.root, header.querySelector('.rg-cs')!).target).toEqual({ column: 3 })
    // A row's number, in the sticky column and in the row itself, is its row.
    expect(gridTarget(grid.root, grid.shown('.rg-rn')[5]).target).toEqual({ row: 5 })
    expect(gridTarget(grid.root, grid.root.querySelector('[role="row"][aria-rowindex="7"] > [role="rowheader"]')!).target).toEqual({ row: 5 })
    // The corner, the scroller and the root are no cell's.
    for (const element of [grid.root.querySelector('.rg-corner')!, grid.scroller, grid.root]) expect(gridTarget(grid.root, element)).toEqual({ registered: true, target: undefined })
    // The active cell keeps a slot when its row is out of view (Ctrl+End, then back to the top): it still names its row.
    grid.key('End', { ctrlKey: true })
    await grid.frame()
    expect(grid.state.selection!.active).toEqual({ row: 499, column: 39 })
    grid.key('Home', { ctrlKey: true })
    grid.state.selection = cells([499, 39])
    await grid.frame()
    const active = grid.root.querySelector<HTMLElement>('.is-act')!
    expect(grid.cellAt(0, 0)).not.toBeNull()
    expect(gridTarget(grid.root, active).target).toEqual({ row: 499, column: 39 })
    grid.view.dispose()
    expect(gridTarget(grid.root, grid.root)).toEqual({ registered: false })
  })
  it('gives menu targets the row and column from the grid, and a keyboard menu the active cell\'s', async () => {
    const grid = mount({ rows: 500, columns: 40 })
    await grid.frame()
    expect(outputTarget(grid.cellAt(4, 1)!)).toMatchObject({ view: 'grid', tabId: 'query', row: 4, column: 1, result: { generation: 1, resultId: 1 } })
    const header = outputTarget(grid.shown('.rg-ch')[3])!
    expect(header.column).toBe(3)
    expect(header).not.toHaveProperty('row')
    const number = outputTarget(grid.shown('.rg-rn')[5])!
    expect(number.row).toBe(5)
    expect(number).not.toHaveProperty('column')
    // The ARIA index no longer decides: the grid's own answer does.
    grid.cellAt(4, 1)!.setAttribute('aria-colindex', '9')
    expect(outputTarget(grid.root.querySelector('[role="row"][aria-rowindex="6"] > [aria-colindex="9"]')!)).toMatchObject({ row: 4, column: 1 })
    const service = new MenuTargetService()
    grid.key('ArrowDown')
    grid.key('ArrowRight')
    // Shift+F10 on the grid: the active cell, painted first.
    expect(service.targetFor(grid.root)).toMatchObject({ target: { row: 1, column: 1 }, anchor: grid.cellAt(1, 1) })
    // A menu on a header is for its column alone; one on a row number takes the active cell's column, as before.
    expect(service.targetFor(grid.shown('.rg-ch')[3])!.target).not.toHaveProperty('row')
    expect(service.targetFor(grid.shown('.rg-rn')[5])!.target).toMatchObject({ row: 5, column: 1 })
    grid.view.dispose()
  })
  it('marks the first sort key on its column\'s header, and sorts by the header a button is in', async () => {
    const grid = mount({ rows: 500, columns: 40 })
    await grid.frame()
    const headers = () => grid.shown('.rg-ch')
    expect(headers().some(header => header.hasAttribute('aria-sort'))).toBe(false)
    grid.view.update({ resultCount: 1, sort: [{ column: 2, descending: true }, { column: 0, descending: false }] })
    await grid.frame()
    expect(headers().slice(0, 3).map(header => header.getAttribute('aria-sort'))).toEqual([null, null, 'descending'])
    expect(headers().slice(0, 3).map(header => [header.querySelector('.rg-cs')!.classList.contains('on'), header.querySelector('.rg-co')!.textContent])).toEqual([[true, '2'], [false, ''], [true, '1']])
    grid.view.update({ resultCount: 1, sort: [] })
    await grid.frame()
    expect(headers().some(header => header.hasAttribute('aria-sort'))).toBe(false)
    grid.view.dispose()
  })
  it('answers for a header an update has marked to be written again, before the frame that writes it', async () => {
    const grid = mount({ rows: 500, columns: 40 })
    await grid.frame()
    grid.key('ArrowDown')
    await grid.frame()
    const header = grid.shown('.rg-ch')[3], service = new MenuTargetService()
    // Each of these resets every header slot and schedules a frame; a menu opened before it runs is still for column 3,
    // not for the active cell's column.
    for (const update of [{ filterable: new Set([1, 2]) }, { showTypes: false }]) {
      grid.view.update({ resultCount: 1, ...update })
      expect(gridTarget(grid.root, header).target, Object.keys(update)[0]).toEqual({ column: 3 })
      grid.view.update({ resultCount: 1, filterable: new Set([1, 2, 3]), showTypes: true })
      expect(service.targetFor(header)!.target, Object.keys(update)[0]).toMatchObject({ column: 3 })
    }
    grid.view.dispose()
  })
})

describe('the grid on a scroller it shares with the views built after it', () => {
  it('stops handling wheel events once disposed, so a native view built on the same scroller scrolls by wheel', async () => {
    // A low cap puts 50,000 rows in Mode B (virtual), whose wheel listener sits on the shell's scroller.
    const stats = new GridStats()
    stats.setScrollCap(4000)
    const wheel = (scroller: HTMLElement) => {
      const event = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, cancelable: true, bubbles: true })
      scroller.dispatchEvent(event)
      return event.defaultPrevented
    }
    const big = mount({ rows: 50_000, columns: 4, stats })
    await big.frame()
    expect(wheel(big.scroller), 'the virtual view handles the wheel itself').toBe(true)
    big.view.dispose()
    expect(wheel(big.scroller), 'a disposed view leaves the wheel alone').toBe(false)
    // Toggling Transpose (or, only at extreme zoom, a live table's rebuild): a native view on the same scroller.
    const small = mount({ rows: 5, columns: 4, stats, on: { root: big.root, scroller: big.scroller } })
    await small.frame()
    expect(wheel(small.scroller), "the native view's wheel scrolls natively").toBe(false)
    small.view.dispose()
    // Built and disposed again on the same scroller, a virtual view leaves no listener behind either.
    const again = mount({ rows: 50_000, columns: 4, stats, on: { root: big.root, scroller: big.scroller } })
    await again.frame()
    expect(wheel(again.scroller)).toBe(true)
    again.view.dispose()
    expect(wheel(again.scroller)).toBe(false)
    big.root.remove()
  })
})

describe("the grid's accessible name", () => {
  it("starts with a named result's name, then its number, and with the number alone when it has none", async () => {
    const named = mount({ rows: 5, columns: 3, resultName: 'Open orders', resultNumber: 2, resultCount: 5 })
    await named.frame()
    expect(named.root.getAttribute('aria-label')).toMatch(/^Open orders, Result 2 of 5, /)
    named.view.dispose()
    named.root.remove()
    const unnamed = mount({ rows: 5, columns: 3, resultNumber: 2, resultCount: 5 })
    await unnamed.frame()
    expect(unnamed.root.getAttribute('aria-label')).toMatch(/^Result 2 of 5, /)
    unnamed.view.dispose()
    unnamed.root.remove()
  })
})

describe('the first measure', () => {
  it('measures again when it answered no rows (a windowed result not read yet), rather than sizing from headers for good', async () => {
    let calls = 0
    const grid = mount({ rows: 500, columns: 3, unsized: true, before: handle => {
      vi.mocked(handle.measure).mockImplementation(async (_first: number, _count: number, colStart: number, colEnd: number) =>
        ({ rows: calls++ === 0 ? 0 : 128, widths: Uint16Array.from({ length: colEnd - colStart }, () => calls === 1 ? 0 : 30) }))
    } })
    await grid.frame()
    expect(grid.state.sized).toBe(false)
    await vi.waitFor(async () => { await grid.frame(); expect(grid.state.sized).toBe(true) }, { timeout: 5000 })
    expect(calls).toBe(2)
    grid.view.dispose()
    grid.root.remove()
  })
})

describe('a first measure that never reads rows', () => {
  it('is tried again a bounded number of times, then sizes the columns from their headers and stops', async () => {
    let calls = 0
    const grid = mount({ rows: 500, columns: 3, unsized: true, before: handle => {
      vi.mocked(handle.measure).mockImplementation(async (_first: number, _count: number, colStart: number, colEnd: number) => { calls++; return { rows: 0, widths: new Uint16Array(colEnd - colStart) } })
    } })
    await vi.waitFor(async () => { await grid.frame(); expect(grid.state.sized).toBe(true) }, { timeout: 10_000, interval: 50 })
    expect(calls).toBe(gridLimits.measureRetries + 1)
    expect((grid.view as unknown as { retries: Set<unknown> }).retries.size).toBe(0)
    grid.view.dispose()
    grid.root.remove()
  })
})

describe('a disposed grid', () => {
  it('leaves no retry pending after a busy results port refused its measure', async () => {
    const busy = Object.assign(new Error('Busy.'), { code: 'TOO_MANY_REQUESTS' })
    const grid = mount({ rows: 5, columns: 3, unsized: true, before: handle => { vi.mocked(handle.measure).mockImplementation(() => Promise.reject(busy)) } })
    await grid.frame()
    const retries = (grid.view as unknown as { retries: Set<unknown> }).retries
    expect(grid.handle.measure).toHaveBeenCalled()
    expect(retries.size).toBeGreaterThan(0)
    // Dispose cancels each pending retry, rather than leaving it to fire into a disposed grid.
    const pending = [...retries], clear = vi.spyOn(globalThis, 'clearTimeout')
    grid.view.dispose()
    for (const timer of pending) expect(clear).toHaveBeenCalledWith(timer)
    clear.mockRestore()
    expect(retries.size).toBe(0)
    grid.root.remove()
  })
})

describe('natural-height outer-scroll virtualization', () => {
  function mountOuter(o: { rows: number; columns: number; outerHeight?: number; scrollerTop?: (outer: HTMLElement) => number; withOuter?: boolean }) {
    const made = source(o.rows, o.columns)
    const naturalHeight = gridLimits.headerHeight + o.rows * gridLimits.rowHeight
    const outer = document.createElement('div')
    if (o.withOuter !== false) outer.style.overflowY = 'auto'
    const root = document.createElement('div'), scroller = document.createElement('div')
    root.append(scroller)
    outer.append(root)
    document.body.append(outer)
    const outerHeight = o.outerHeight ?? 300
    Object.defineProperty(outer, 'clientHeight', { configurable: true, get: () => outerHeight })
    Object.defineProperty(outer, 'clientTop', { configurable: true, value: 2 })
    outer.getBoundingClientRect = () => ({ top: 100, bottom: 100 + outerHeight + 4, left: 0, right: 900, width: 900, height: outerHeight + 4, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
    Object.defineProperty(scroller, 'clientWidth', { value: 900 })
    Object.defineProperty(scroller, 'offsetWidth', { value: 900 })
    Object.defineProperty(scroller, 'clientHeight', { value: naturalHeight })
    const topOf = o.scrollerTop ?? ((host: HTMLElement) => 102 - host.scrollTop)
    scroller.getBoundingClientRect = () => {
      const top = topOf(outer)
      return { top, bottom: top + naturalHeight, left: 0, right: 900, width: 900, height: naturalHeight, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
    const state: GridViewState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true }
    let lastViewport: { firstRow: number; lastRow: number; rows: number } | undefined
    const view = new GridView({
      root, scroller, handle: made.handle, client: { windowsInFlight: 0 }, descriptor: descriptor(made.handle), state, entry: 'e1',
      resultNumber: 1, resultCount: 1, platform: 'win32', outerScroll: true,
      onViewport: vp => { lastViewport = vp },
      onSelection: () => {}, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }
    })
    const frame = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
    const key = (name: string, init: KeyboardEventInit = {}) => view.key(new KeyboardEvent('keydown', { key: name, ...init }))
    const rowCount = () => root.querySelectorAll('[role="rowgroup"] > [role="row"]').length
    const cellAt = (row: number, col: number) => root.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${col + 2}"]`)
    return { outer, root, scroller, state, view, frame, key, rowCount, cellAt, viewport: () => lastViewport }
  }

  it('bounds the DOM row pool against the outer scroller, anchors row 0 offscreen, and scrolls the outer container on Ctrl+End, Ctrl+Home and PageDown', async () => {
    let offset = 102
    const grid = mountOuter({ rows: 2048, columns: 4, outerHeight: 300, scrollerTop: host => offset - host.scrollTop })
    await grid.frame()
    // 2,048 rows at natural height draws only a bounded pool near the 300px outer client box.
    expect(grid.rowCount()).toBeLessThan(60)
    expect(grid.cellAt(0, 0)?.textContent).toBe('0:0')
    expect(grid.viewport()).toMatchObject({ firstRow: 0, rows: 2048 })
    expect(grid.viewport()!.lastRow).toBeLessThan(30)

    // PageDown steps by the outer client height (~13 rows), not the full 40,982px natural height.
    grid.key('PageDown')
    expect(grid.state.selection!.active.row).toBeGreaterThan(5)
    expect(grid.state.selection!.active.row).toBeLessThan(30)

    // Ctrl+End scrolls the outer container so row 2,047 is in view and paints it.
    grid.key('End', { ctrlKey: true })
    expect(grid.state.selection!.active.row).toBe(2047)
    expect(grid.outer.scrollTop).toBeGreaterThan(40_000)
    await grid.frame()
    expect(grid.cellAt(2047, 0)?.textContent).toBe('2047:0')
    expect(grid.rowCount()).toBeLessThan(60)
    expect(grid.viewport()!.firstRow).toBeGreaterThan(2000)

    // Ctrl+Home aligns row 0 with the top of the grid header (not clipped under the top edge).
    grid.key('Home', { ctrlKey: true })
    expect(grid.outer.scrollTop).toBe(0)

    // When the grid sits completely below the outer viewport, it keeps row 0 anchored with a minimal pool.
    offset = 2000
    grid.outer.dispatchEvent(new Event('scroll'))
    await grid.frame()
    expect(grid.cellAt(0, 0)?.textContent).toBe('0:0')
    expect(grid.rowCount()).toBeLessThan(60)

    // Dispose detaches outer scroll listener cleanly.
    const removeSpy = vi.spyOn(grid.outer, 'removeEventListener')
    grid.view.dispose()
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function))
    removeSpy.mockRestore()
    grid.outer.remove()
  })

  it('caps the row pool safely when no scrolling ancestor exists or the outer container has zero height', async () => {
    const noOuter = mountOuter({ rows: 2048, columns: 3, withOuter: false })
    await noOuter.frame()
    expect(noOuter.rowCount()).toBeLessThan(100)
    noOuter.view.dispose()
    noOuter.outer.remove()

    const collapsed = mountOuter({ rows: 2048, columns: 3, outerHeight: 0 })
    await collapsed.frame()
    expect(collapsed.rowCount()).toBeLessThan(20)
    expect(collapsed.cellAt(0, 0)?.textContent).toBe('0:0')
    collapsed.view.dispose()
    collapsed.outer.remove()

    // Small natural-height lists (<= 20 rows) paint all rows directly even while offscreen.
    const smallOffscreen = mountOuter({ rows: 5, columns: 3, outerHeight: 300, scrollerTop: () => 2000 })
    await smallOffscreen.frame()
    expect(smallOffscreen.cellAt(4, 0)?.textContent).toBe('4:0')
    smallOffscreen.view.dispose()
    smallOffscreen.outer.remove()
  })
})
