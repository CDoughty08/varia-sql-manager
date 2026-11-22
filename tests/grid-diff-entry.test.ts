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

function mount(columns: readonly ResultColumn[], cells: readonly (readonly Cell[])[], o: { diffChanged?: readonly boolean[]; diffKeys?: readonly boolean[]; active?: readonly [number, number]; onDiffRow?: (row: number, tone: string | null) => void } = {}) {
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
    diffSides: { old: 'Result 1', new: 'Result 2', rows: cells.length }, ...o.diffChanged ? { diffChanged: o.diffChanged } : {}, ...o.diffKeys ? { diffKeys: o.diffKeys } : {}, ...o.onDiffRow ? { onDiffRow: o.onDiffRow } : {},
    onSelection: () => {}, onFirstCell: () => {}, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }, onOpenValue: () => {}, onSort: () => {}, onFilter: () => {}
  })
  const frame = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
  const cellAt = (row: number, col: number) => root.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${row + 2}"] > [role="gridcell"][aria-colindex="${col + 2}"]`)
  const headerAt = (col: number) => root.querySelector<HTMLElement>(`[role="columnheader"][aria-colindex="${col + 2}"]`)
  const rowAt = (row: number) => root.querySelector<HTMLElement>(`[role="row"][aria-rowindex="${row + 2}"]`)
  return { root, view, frame, cellAt, headerAt, rowAt, state }
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

  it('underlines and dots the columns with changes and marks the key columns, for screen readers too', async () => {
    const { view, frame, headerAt } = mount(entryColumns, entryRows, { diffChanged: [false, true], diffKeys: [true, false] })
    await frame()
    const id = headerAt(0)!, price = headerAt(1)!
    expect([id.classList.contains('key'), id.classList.contains('chg'), id.getAttribute('aria-description')]).toEqual([true, false, 'Key column'])
    expect([price.classList.contains('key'), price.classList.contains('chg'), price.getAttribute('aria-description')]).toEqual([false, true, 'Has changes'])
    // The header's tooltip says it too.
    price.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    expect(price.title).toBe('Price (nvarchar(max), null)\nHas changes')
    view.dispose()
  })

  it('draws a hidden run of unchanged rows as a dashed rule and names it, in Changes only with no sort or filter', async () => {
    const columns = [column('Id'), column('Price'), ...suffix]
    const rows: Cell[][] = [
      ['1', '9.00', '+', null, '4', 'added gap=312'],
      ['5', '7.00', '−', '9', null, 'removed gap=1'],
      ['6', '8.00', '+', null, '11', 'added']
    ]
    const { view, frame, rowAt, root } = mount(columns, rows)
    await frame()
    await frame()
    const name = (row: number) => rowAt(row)!.querySelector('[role="rowheader"]')!.textContent
    const ruled = () => [0, 1, 2].map(row => rowAt(row)!.dataset.gap ?? '')
    // Not shown until the grid says so (its sort and filters are the shell's).
    expect(ruled()).toEqual(['', '', ''])
    expect(name(0)).toBe('Added; row 4 in Result 2')
    view.setDiffGaps({ shown: true, trailing: 12 })
    await frame()
    expect(ruled()).toEqual(['above', 'above', 'below'])
    expect(name(0)).toBe('Added; row 4 in Result 2. 312 unchanged rows hidden')
    expect(name(1)).toBe('Removed; row 9 in Result 1. 1 unchanged row hidden')
    expect(name(2)).toBe('Added; row 11 in Result 2. 12 unchanged rows hidden after it')
    // The row numbers draw the rule too, with the count in their tooltip.
    const marks = [...root.querySelectorAll<HTMLElement>('.rg-rn[data-gap]')]
    expect(marks.map(mark => [mark.dataset.gap, mark.title])).toEqual([
      ['above', 'Added; row 4 in Result 2. 312 unchanged rows hidden'], ['above', 'Removed; row 9 in Result 1. 1 unchanged row hidden'], ['below', 'Added; row 11 in Result 2. 12 unchanged rows hidden after it']])
    // A sort or filter: no rules and no counts.
    view.setDiffGaps({ shown: false, trailing: 12 })
    await frame()
    expect(ruled()).toEqual(['', '', ''])
    expect(root.querySelectorAll('.rg-rn[data-gap]')).toHaveLength(0)
    expect(name(0)).toBe('Added; row 4 in Result 2')
    view.dispose()
  })

  // Go to Next or Previous Difference and Go to Possible Match (CompareService) read the active row's tone and land on a unit.
  describe('moving between differences', () => {
    const columns = [column('Id'), column('Name'), column('Price'), ...suffix]
    const rows: Cell[][] = [
      ['1', 'a', '1', ' ', '1', '1', null],
      ['2', 'b', '2', '−', '2', null, 'removed poss=4'],
      ['3', 'c', '3', '−', '3', '3', 'changedOld 0 2'],
      ['3', 'C', '4', '+', '3', '3', 'changedNew 0 2 …'],
      ['4', 'd', '4', '+', null, '4', 'added poss=2']
    ]

    it('says the active row and its tone once read, and whether the whole row is selected', async () => {
      const told: [number, string | null][] = []
      const { view, frame, state } = mount(columns, rows, { active: [1, 1], onDiffRow: (row, tone) => told.push([row, tone]) })
      await frame()
      await frame()
      expect(view.diffActive()).toEqual({ row: 1, column: 1, whole: false, tone: 'removed poss=4' })
      expect(told.at(-1)).toEqual([1, 'removed poss=4'])
      expect(view.diffTone(0)).toBeNull()
      // A row header press selects the row alone: the whole row.
      state.selection = { entry: 'e1', active: { row: 4, column: 0 }, blocks: [{ kind: 'rows', anchor: { row: 4, column: 0 }, focus: { row: 4, column: 0 } }] }
      view.invalidate()
      await frame()
      expect(view.diffActive()).toMatchObject({ row: 4, whole: true, tone: 'added poss=2' })
      expect(told.at(-1)).toEqual([4, 'added poss=2'])
      view.dispose()
    })

    it('lands on a cell, or on the whole row once its tone says an added, removed or cut row', async () => {
      const { view, frame, state, root } = mount(columns, rows)
      await frame()
      await frame()
      view.landDiff(3, { column: 2, whole: false }, undefined, true)
      await frame()
      expect(state.selection).toMatchObject({ active: { row: 3, column: 2 }, blocks: [{ kind: 'cells' }] })
      expect(root.ownerDocument.activeElement).toBe(root)
      // Read already, the tone decides at once: an added row takes the whole row, its first column active.
      view.landDiff(4, { column: 1, whole: false }, tone => tone?.startsWith('added') ? { column: 0, whole: true } : { column: 1, whole: false }, false)
      expect(state.selection).toMatchObject({ active: { row: 4, column: 0 }, blocks: [{ kind: 'rows' }] })
      view.dispose()
    })

    it("settles a landing once its row's tone is read, unless the selection moved meanwhile", async () => {
      const many: Cell[][] = Array.from({ length: 400 }, (_, row) => [String(row), 'x', '1', row === 390 ? '+' : ' ', String(row + 1), String(row + 1), row === 390 ? 'added' : null])
      const { view, frame, state } = mount(columns, many)
      await frame()
      await frame()
      // Row 390's tile is not read yet: the cell is selected first, then the whole row once the tone says added.
      expect(view.diffTone(390)).toBeUndefined()
      view.landDiff(390, { column: 0, whole: false }, tone => tone === 'added' ? { column: 0, whole: true } : { column: 0, whole: false }, false)
      expect(state.selection).toMatchObject({ blocks: [{ kind: 'cells' }] })
      for (let i = 0; i < 4 && view.diffTone(390) === undefined; i++) await frame()
      await frame()
      expect(state.selection).toMatchObject({ active: { row: 390, column: 0 }, blocks: [{ kind: 'rows' }] })
      // A landing whose selection the user moved before its tone came stays where the user put it.
      expect(view.diffTone(150)).toBeUndefined()
      view.landDiff(150, { column: 1, whole: false }, () => ({ column: 0, whole: true }), false)
      const moved = { entry: 'e1', active: { row: 2, column: 1 }, blocks: [{ kind: 'cells' as const, anchor: { row: 2, column: 1 }, focus: { row: 2, column: 1 } }] }
      state.selection = moved
      for (let i = 0; i < 4 && view.diffTone(150) === undefined; i++) await frame()
      await frame()
      expect(state.selection).toBe(moved)
      view.dispose()
    })

    it("answers a landed row's tone once its tile is read, and nothing once the active cell left it or the move was given up", async () => {
      const many: Cell[][] = Array.from({ length: 400 }, (_, row) => [String(row), 'x', '1', row === 390 ? '~' : ' ', String(row + 1), String(row + 1), row === 390 ? 'changed 0 2' : null])
      const { view, frame, state } = mount(columns, many)
      await frame()
      await frame()
      expect(await view.toneWhenRead(0, new AbortController().signal)).toBeNull()
      view.landDiff(390, { column: 0, whole: false }, () => ({ column: 0, whole: false }), false)
      const read = view.toneWhenRead(390, new AbortController().signal)
      for (let i = 0; i < 6 && view.diffTone(390) === undefined; i++) await frame()
      await frame()
      expect(await read).toBe('changed 0 2')
      // The user moves away before row 150's tile is read: the wait ends with nothing.
      view.landDiff(150, { column: 1, whole: false }, () => ({ column: 1, whole: false }), false)
      const left = view.toneWhenRead(150, new AbortController().signal)
      state.selection = { entry: 'e1', active: { row: 390, column: 1 }, blocks: [{ kind: 'cells', anchor: { row: 390, column: 1 }, focus: { row: 390, column: 1 } }] }
      view.invalidate()
      await frame()
      expect(await left).toBeUndefined()
      view.dispose()
      // Given up, or the grid disposed, it ends at once.
      const fresh = mount(columns, many)
      await fresh.frame()
      await fresh.frame()
      expect(fresh.view.diffTone(390)).toBeUndefined()
      expect(fresh.view.diffTone(300)).toBeUndefined()
      // An active row no landing waits for (scrolled away, its tile not read) is not waited for: nothing would fetch it.
      fresh.state.selection = { entry: 'e1', active: { row: 300, column: 1 }, blocks: [{ kind: 'cells', anchor: { row: 300, column: 1 }, focus: { row: 300, column: 1 } }] }
      expect(await fresh.view.toneWhenRead(300, new AbortController().signal)).toBeUndefined()
      const abort = new AbortController()
      fresh.view.landDiff(390, { column: 1, whole: false }, () => ({ column: 1, whole: false }), false)
      const given = fresh.view.toneWhenRead(390, abort.signal)
      abort.abort()
      expect(await given).toBeUndefined()
      fresh.view.landDiff(300, { column: 1, whole: false }, () => ({ column: 1, whole: false }), false)
      const disposed = fresh.view.toneWhenRead(300, new AbortController().signal)
      fresh.view.dispose()
      expect(await disposed).toBeUndefined()
    })

    it('tells a menu whether the row it opened on has a possible match', async () => {
      const { view, frame, cellAt } = mount(columns, rows)
      await frame()
      await frame()
      const { gridTarget } = await import('../src/renderer/src/grid/anchor')
      expect(gridTarget(view.root, cellAt(1, 0)!).target).toEqual({ row: 1, column: 0, partner: true })
      expect(gridTarget(view.root, cellAt(3, 0)!).target).toEqual({ row: 3, column: 0 })
      view.dispose()
    })

    it("draws the overview strip only over the comparison's own rows, and a press on a mark scrolls there", async () => {
      const many: Cell[][] = Array.from({ length: 400 }, (_, row) => [String(row), 'x', '1', row === 300 ? '+' : ' ', String(row + 1), String(row + 1), row === 300 ? 'added' : null])
      const { view, frame, state, root } = mount(columns, many)
      await frame()
      const buckets = Array.from({ length: 400 }, (_, at) => at === 300 ? 2 : 0)
      view.setOverview({ buckets, shown: true })
      await frame()
      const strip = root.querySelector<HTMLElement>('.rg-overview')!
      expect(strip.getAttribute('aria-hidden')).toBe('true')
      expect(strip.hidden).toBe(false)
      const marks = [...strip.querySelectorAll<HTMLElement>('.rg-overview-mark')]
      expect(marks.map(mark => [mark.className, mark.style.top])).toEqual([['rg-overview-mark is-added', '75%']])
      expect(state.virtualTop).toBe(0)
      marks[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 0 }))
      await frame()
      expect(state.virtualTop).toBeGreaterThan(0)
      // A sort or filter (a chip included) hides it.
      view.setOverview({ buckets, shown: false })
      await frame()
      expect(strip.hidden).toBe(true)
      view.dispose()
      expect(root.querySelector('.rg-overview')).toBeNull()
    })
  })
})
