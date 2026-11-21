// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, ResultDescriptor } from '../src/shared/contracts'
import { GridView } from '../src/renderer/src/grid/GridView'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import type { ResultHandle, RowWindow, WindowOptions, WindowShape } from '../src/renderer/src/results/ResultClient'
import type { GridViewState } from '../src/renderer/src/results/ResultsService'

// A comparison's grid, one row per entry or two rows a change, over a stand-in diff: what a changed cell draws (its
// previous value struck through, an arrow, the new value) and what its accessible name says.

const column = (name: string, role?: ResultColumn['role']): ResultColumn => ({ name, dataType: 'nvarchar', wire: 'text', nullable: true, ...role ? { role } : {} })
const suffix = [column('Change', 'mark'), column('Old row', 'leftRow'), column('New row', 'rightRow'), column('', 'tone')]
/** A cell: its text, null for NULL, or its text with the worker's flags (truncated 2, could not be read 4). */
type Cell = string | null | { readonly text: string; readonly flags: number }

/** A diff of `cells` rows (each row's every column, the suffix included) over `columns`. */
function source(columns: readonly ResultColumn[], cells: readonly (readonly Cell[])[]) {
  const cache = new Map<string, RowWindow>()
  const keyOf = (first: number, count: number, s: WindowShape) => `${first}:${count}:${s.colStart}:${s.colEnd}`
  const rows = cells.length
  const snapshot = { rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, state: 'complete' as const, incomplete: false }
  const handle = {
    key: { generation: 1, resultId: 1 }, columns, getSnapshot: () => snapshot, subscribe: () => () => {},
    getWindow: async (first: number, count: number, s: WindowOptions = {}) => {
      await Promise.resolve()
      const colStart = s.colStart ?? 0, colEnd = Math.min(columns.length, s.colEnd ?? columns.length), width = colEnd - colStart
      const held = Math.max(0, Math.min(count, rows - first))
      const text: string[] = [], flags = new Uint8Array(held * width)
      for (let r = 0; r < held; r++) for (let c = colStart; c < colEnd; c++) {
        const value = cells[first + r][c]
        text.push(typeof value === 'object' && value !== null ? value.text : value ?? '')
        if (value === null) flags[r * width + c - colStart] = 1
        else if (typeof value === 'object') flags[r * width + c - colStart] = value.flags
      }
      const window: RowWindow = { first, count: held, colStart, colEnd, text, flags }
      cache.set(keyOf(first, count, { colStart, colEnd }), window)
      return window
    },
    peekWindow: (first: number, count: number, s: WindowShape = {}) => cache.get(keyOf(first, count, { colStart: s.colStart ?? 0, colEnd: Math.min(columns.length, s.colEnd ?? columns.length) })),
    prefetch: vi.fn(),
    measure: vi.fn(async (_first: number, _count: number, colStart: number, colEnd: number) => ({ rows: 1, widths: Uint16Array.from({ length: colEnd - colStart }, () => 6) })),
    rowBytes: vi.fn(async (first: number) => ({ first, bytes: [], rowsAvailable: rows, estimated: [] }))
  }
  return handle as unknown as ResultHandle
}

function mount(columns: readonly ResultColumn[], cells: readonly (readonly Cell[])[], o: { diffChanged?: readonly boolean[]; active?: readonly [number, number] } = {}) {
  const handle = source(columns, cells)
  const root = document.createElement('div'), scroller = document.createElement('div')
  for (const [name, value] of Object.entries({ 'data-output-view': 'grid', 'data-tab-id': 'query', 'data-result-entry': 'e1', 'data-result-generation': '1', 'data-result-id': '1' })) root.setAttribute(name, value)
  root.append(scroller)
  document.body.append(root)
  for (const [name, value] of [['clientWidth', 900], ['offsetWidth', 900], ['clientHeight', 300]] as const) Object.defineProperty(scroller, name, { value })
  const descriptor = { generation: 1, resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'diff', columns: [...columns], rowsRead: cells.length, rowsStored: cells.length, rowsAvailable: cells.length, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false } as unknown as ResultDescriptor
  const at = o.active, selection: GridSelection | undefined = at && { entry: 'e1', active: { row: at[0], column: at[1] }, blocks: [{ kind: 'cells', anchor: { row: at[0], column: at[1] }, focus: { row: at[0], column: at[1] } }] }
  const state: GridViewState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true, ...selection ? { selection } : {} }
  const view = new GridView({
    root, scroller, handle, client: { windowsInFlight: 0 }, descriptor, state, entry: 'e1', resultNumber: 3, resultCount: 3, platform: 'win32',
    diffSides: { old: 'Result 1', new: 'Result 2', rows: cells.length }, ...o.diffChanged ? { diffChanged: o.diffChanged } : {},
    onSelection: () => {}, onFirstCell: () => {}, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }, onOpenValue: () => {}, onSort: () => {}, onFilter: () => {}
  })
  const frame = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
  const cellAt = (row: number, col: number) => root.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${col + 2}"]`)
  return { root, view, frame, cellAt, state }
}

describe('a comparison\'s grid', () => {
  // Id and Price, then their previous values, then the suffix.
  const entryColumns = [column('Id'), column('Price'), column('Id', 'old'), column('Price', 'old'), ...suffix]
  const entryRows: Cell[][] = [
    ['1', '10.00', '1', '10.00', '', '1', '1', 'same'],
    ['2', '4980.00', '2', '5120.00', '~', '2', '2', 'changed 1'],
    ['3', '7.00', '3', null, '~', '3', '3', 'changed 1'],
    ['4', '9.00', null, null, '+', '', '4', 'added']
  ]

  it('draws a changed value one row per entry as its previous value struck through, an arrow and the new value', async () => {
    const { view, frame, cellAt } = mount(entryColumns, entryRows, { diffChanged: [false, true] })
    await frame()
    await frame()
    const changed = cellAt(1, 1)!
    expect(changed.classList.contains('is-chg')).toBe(true)
    expect(changed.querySelector('.rg-old')?.textContent).toBe('5120.00')
    expect(changed.querySelector('.rg-arrow')?.getAttribute('aria-hidden')).toBe('true')
    expect(changed.querySelector('.rg-arrow')?.textContent).toBe('→')
    expect(changed.querySelector('.rg-new')?.textContent).toBe('4980.00')
    // A NULL previous value reads NULL, drawn as a NULL is.
    const fromNull = cellAt(2, 1)!
    expect(fromNull.querySelector('.rg-old')?.textContent).toBe('NULL')
    expect(fromNull.querySelector('.rg-old')?.classList.contains('is-null')).toBe(true)
    // Unchanged cells, and the cells of an added row, draw their own text alone.
    for (const [row, col] of [[0, 1], [1, 0], [3, 1]] as const) expect(cellAt(row, col)!.querySelector('.rg-old')).toBeNull()
    expect(cellAt(3, 1)!.textContent).toBe('9.00')
    // The previous values are hidden columns: two columns show.
    expect(view.root.querySelectorAll('[role="columnheader"][aria-colindex]').length).toBeGreaterThanOrEqual(2)
    expect([...view.root.querySelectorAll('[role="columnheader"]')].some(header => header.textContent?.includes('Change'))).toBe(false)
    view.dispose()
  })

  it('names a changed cell by its column and both values, one row per entry', async () => {
    for (const [row, label] of [[1, 'Price, changed from 5120.00 to 4980.00'], [2, 'Price, changed from NULL to 7.00']] as const) {
      const { view, frame, cellAt } = mount(entryColumns, entryRows, { diffChanged: [false, true], active: [row, 1] })
      await frame()
      await frame()
      expect(cellAt(row, 1)!.getAttribute('aria-label')).toBe(label)
      view.dispose()
    }
  })

  it('says a previous or new value could not be read, and marks a cut-off previous value', async () => {
    const rows: Cell[][] = [
      ['1', '10.00', '1', { text: '', flags: 4 }, '~', '1', '1', 'changed 1'],
      ['2', { text: '', flags: 4 }, '2', '5.00', '~', '2', '2', 'changed 1'],
      ['3', '7.00', '3', { text: '6.0', flags: 2 }, '~', '3', '3', 'changed 1']
    ]
    for (const [row, label] of [[0, 'Price, changed from a value that could not be read to 10.00'], [1, 'Price, changed from 5.00 to a value that could not be read'], [2, 'Price, changed from 6.0 (truncated) to 7.00']] as const) {
      const { view, frame, cellAt } = mount(entryColumns, rows, { diffChanged: [false, true], active: [row, 1] })
      await frame()
      await frame()
      expect(cellAt(row, 1)!.getAttribute('aria-label')).toBe(label)
      if (row === 0) expect(cellAt(row, 1)!.querySelector('.rg-old')?.className).toBe('rg-old is-err')
      view.dispose()
    }
  })

  it('names a changed cell by its column and the value of its half in two rows', async () => {
    const columns = [column('Id'), column('Price'), ...suffix]
    const rows: Cell[][] = [
      ['2', '5120.00', '~', '2', '', 'changedOld 1'],
      ['2', '4980.00', '~', '', '2', 'changedNew 1']
    ]
    for (const [row, label] of [[0, 'Price, old value 5120.00'], [1, 'Price, new value 4980.00']] as const) {
      const { view, frame, cellAt } = mount(columns, rows, { active: [row, 1] })
      await frame()
      await frame()
      expect(cellAt(row, 1)!.getAttribute('aria-label')).toBe(label)
      expect(cellAt(row, 1)!.querySelector('.rg-old')).toBeNull()
      view.dispose()
    }
  })
})
