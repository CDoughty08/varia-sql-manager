// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import { gridTarget } from '../src/renderer/src/grid/anchor'
import { GridView } from '../src/renderer/src/grid/GridView'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { MenuTargetService, outputTarget } from '../src/renderer/src/menus/targets'
import type { ResultHandle, RowWindow, WindowOptions, WindowShape } from '../src/renderer/src/results/ResultClient'
import type { GridViewState } from '../src/renderer/src/results/ResultsService'

// GridView itself over a stand-in result, in a scroller that reports a size (happy-dom lays nothing out): the seams
// between what it draws and the result's rows and columns. Each is the identity today; these checks hold them in place
// for the transposed orientation that will turn them (docs/architecture.md, the grid bullet).

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
const cells = (a: [number, number], b: [number, number] = a): GridSelection => ({ resultIndex: 0, active: { row: b[0], column: b[1] }, blocks: [{ kind: 'cells', anchor: { row: a[0], column: a[1] }, focus: { row: b[0], column: b[1] } }] })

function mount(o: { rows: number; columns: number }) {
  const made = source(o.rows, o.columns)
  const root = document.createElement('div'), scroller = document.createElement('div')
  for (const [name, value] of Object.entries({ 'data-output-view': 'grid', 'data-tab-id': 'query', 'data-result-index': '0', 'data-result-generation': '1', 'data-result-id': '1' })) root.setAttribute(name, value)
  root.append(scroller)
  document.body.append(root)
  for (const [name, value] of [['clientWidth', 900], ['offsetWidth', 900], ['clientHeight', 300]] as const) Object.defineProperty(scroller, name, { value })
  const state: GridViewState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true }
  const onSelection = vi.fn(), onOpenValue = vi.fn(), onSort = vi.fn()
  const view = new GridView({
    root, scroller, handle: made.handle, client: { windowsInFlight: 0 }, descriptor: descriptor(made.handle), state, resultIndex: 0, resultCount: 1, platform: 'win32',
    onSelection, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }, onOpenValue, onSort, onFilter: () => {}
  })
  /** The reads answered and the frame after them painted. */
  const frame = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
  const key = (name: string, init: KeyboardEventInit = {}) => view.key(new KeyboardEvent('keydown', { key: name, ...init }))
  const shown = <T extends Element = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)].filter(element => (element as unknown as HTMLElement).style.display !== 'none')
  const cellAt = (row: number, col: number) => root.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${col + 2}"]`)
  return { ...made, root, scroller, state, view, frame, key, shown, cellAt, onSelection, onOpenValue, onSort }
}

describe('the grid\'s seams', () => {
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
    // The first cell is current without being announced.
    expect(grid.state.selection).toEqual(cells([0, 0]))
    expect(grid.onSelection).not.toHaveBeenCalled()
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
    grid.state.selection = { ...cells([4, 4]), resultIndex: 3 }
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
