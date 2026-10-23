import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import type { LiveTableSpec } from '../src/shared/live/catalog'
import { GridData } from '../src/renderer/src/grid/data'
import { toneColumnOf, type GridViewport } from '../src/renderer/src/grid/GridView'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { remapSelection, remapTop, survivingRow, type RowMap } from '../src/renderer/src/grid/swap'
import { tileColumnOf, tileRowOf } from '../src/renderer/src/grid/tiles'
import { keyOfRow, LiveGrid, prepareMs, readSpans, trackedRowMap, wantedRows, type LiveGridHooks, type LiveGridView } from '../src/renderer/src/live/LiveGrid'
import type { AppliedTick, LiveTable } from '../src/renderer/src/live/LiveService'
import type { LiveTick } from '../src/shared/live/schema'
import type { ResultHandle, RowWindow, WindowOptions } from '../src/renderer/src/results/ResultClient'
import { FLAG_CAPPED, FLAG_NULL } from '../src/renderer/src/results/worker-protocol'
import { manualTimers } from './fixtures/workbench'

// LiveGrid (docs/ipc.md, Live subscriptions): the swap's selection and scroll mapping (grid/swap.ts), the hidden tone
// column (GridView, GridData), and LiveGrid's own work against a stand-in grid and live view: which rows it follows and
// the keys it sends, the row map it swaps with, departed rows, follow tail and the new-rows count, the sort hook and Copy.

const map = (moves: Record<number, number>): RowMap => row => moves[row] ?? row
const cell = (row: number, column = 0) => ({ row, column })
const selection = (o: Partial<GridSelection> & Pick<GridSelection, 'active'>): GridSelection => ({ resultIndex: 0, blocks: [{ kind: 'cells', anchor: o.active, focus: o.active }], ...o })

describe('grid swap', () => {
  it('moves the active row with its key, and to the nearest surviving row when it is gone', () => {
    expect(survivingRow(5, map({ 5: 9 }), 20)).toBe(9)
    // Gone: the next row down went to 4, so the selection lands there, among the rows the user was looking at.
    expect(survivingRow(5, map({ 5: -1, 6: 4 }), 20)).toBe(4)
    // Gone, and nothing below survived within reach: the row above.
    expect(survivingRow(5, row => row === 4 ? 3 : -1, 20)).toBe(3)
    // Nothing survived: the old index, within the new rows.
    expect(survivingRow(30, () => -1, 10)).toBe(9)
    expect(survivingRow(3, () => -1, 0)).toBe(0)
  })
  it('remaps blocks by their rows, collapses a block whose row is gone to the active cell, and keeps whole columns whole', () => {
    const before: GridSelection = {
      resultIndex: 0, active: cell(4, 1),
      blocks: [{ kind: 'cells', anchor: cell(2, 0), focus: cell(4, 1) }, { kind: 'rows', anchor: cell(7, 0), focus: cell(8, 0) }, { kind: 'columns', anchor: cell(0, 2), focus: cell(0, 2) }]
    }
    const after = remapSelection(before, map({ 2: 12, 4: 14, 7: -1 }), 50, 3)!
    expect(after.active).toEqual(cell(14, 1))
    expect(after.blocks).toEqual([
      { kind: 'cells', anchor: cell(12, 0), focus: cell(14, 1) },
      { kind: 'cells', anchor: cell(14, 1), focus: cell(14, 1) },
      { kind: 'columns', anchor: cell(14, 2), focus: cell(14, 2) }
    ])
    // Two blocks that collapse to the same cell are one; columns stay within the grid's.
    const collapsed = remapSelection({ resultIndex: 0, active: cell(1, 9), blocks: [{ kind: 'cells', anchor: cell(1, 0), focus: cell(1, 0) }, { kind: 'cells', anchor: cell(3, 0), focus: cell(3, 0) }] }, () => -1, 5, 2)!
    expect(collapsed.blocks).toEqual([{ kind: 'cells', anchor: cell(1, 1), focus: cell(1, 1) }])
    expect(remapSelection(before, map({}), 0, 3)).toBeUndefined()
    expect(remapSelection(undefined, map({}), 5, 3)).toBeUndefined()
  })
  it('keeps the first row shown first at the same pixel offset, and a view at the top at the top', () => {
    expect(remapTop(20 * 10 + 7, map({ 10: 30 }))).toBe(20 * 30 + 7)
    expect(remapTop(0, map({ 0: 5 }))).toBe(0)
    expect(remapTop(20 * 10, map({ 10: -1 }))).toBe(200)
  })
})

describe('tone column', () => {
  const columns = (...roles: (string | undefined)[]) => ({ columns: roles.map((role, index) => ({ name: 'c' + index, dataType: 'nvarchar', wire: 'text' as const, nullable: true, ...role ? { role: role as 'tone' } : {} })) })
  it('is the last column when its role is tone, and never the only one', () => {
    expect(toneColumnOf(columns(undefined, undefined, 'tone'))).toBe(2)
    expect(toneColumnOf(columns(undefined, 'tone', undefined))).toBe(-1)
    expect(toneColumnOf(columns('tone'))).toBe(-1)
    expect(toneColumnOf(columns(undefined, 'xml'))).toBe(-1)
  })
  it('is read with the rows it colours: each planned row tile also reads the tile column that holds it', () => {
    const reads: { first: number; o: WindowOptions }[] = []
    const handle = { getWindow: (first: number, _count: number, o: WindowOptions = {}) => { reads.push({ first, o }); return new Promise<RowWindow>(() => {}) }, peekWindow: () => undefined, prefetch: () => {} }
    // 40 shown columns and the tone at 40: columns 0-9 in view need tile column 0 for cells and tile column 1 for the tone.
    const data = new GridData({ handle, columns: 40, tone: 40, clientInflight: () => 0, changed: () => {}, timers: manualTimers().timers, now: () => 0 })
    data.ensure({ firstRow: 0, lastRow: 30, firstColumn: 0, lastColumn: 9 }, 1000, 0, 30)
    expect(reads.map(read => [read.first, read.o.colStart, read.o.colEnd])).toEqual([[0, 0, 32], [0, 32, 41]])
    // Row 300's tone is in row tile 2, tile column 1.
    const tone = data.toneTile(300)!
    expect([tileRowOf(tone), tileColumnOf(tone)]).toEqual([2, 1])
    // Without a tone, tiles end at the shown columns.
    const plain: number[] = []
    new GridData({ handle: { ...handle, getWindow: (_first: number, _count: number, o: WindowOptions = {}) => { plain.push(o.colEnd!); return new Promise<RowWindow>(() => {}) } }, columns: 40, clientInflight: () => 0, changed: () => {}, timers: manualTimers().timers, now: () => 0 })
      .ensure({ firstRow: 0, lastRow: 30, firstColumn: 30, lastColumn: 39 }, 1000, 0, 30)
    expect(plain.sort()).toEqual([32, 40])
  })
})

/** A window of key texts for rows [first, first + count) over columns [colStart, colEnd); `null` cells are NULL. */
function windowOf(first: number, rows: (string | null)[][], colStart = 0): RowWindow {
  const width = rows[0]?.length ?? 1
  return { first, count: rows.length, colStart, colEnd: colStart + width, text: rows.flat().map(text => text ?? ''), flags: Uint8Array.from(rows.flat().map(text => text === null ? FLAG_NULL : 0)) }
}

describe('LiveGrid helpers', () => {
  it('maps rows whose keys it knew to where the backend tracked them, and leaves the others', () => {
    const known = new Map([[0, 'a'], [3, 'b'], [5, 'c']])
    const mapRow = trackedRowMap(known, { seq: 4, rows: [7, -1], keys: ['a', 'b'] })
    expect([0, 3, 5, 9].map(mapRow)).toEqual([7, -1, 5, 9])
    // Without the keys of the answered list, nothing can be mapped.
    expect(trackedRowMap(known, { seq: 4, rows: [7, -1] })(0)).toBe(0)
    expect(trackedRowMap(known, undefined)(3)).toBe(3)
  })
  it('follows the active row and its neighbours, the first row shown and the blocks\' corners, each once, within the rows', () => {
    const viewport: GridViewport = { firstRow: 10, lastRow: 40, rows: 100, atEnd: false }
    const chosen: GridSelection = { resultIndex: 0, active: cell(12), blocks: [{ kind: 'cells', anchor: cell(12), focus: cell(15) }, { kind: 'all', anchor: cell(50), focus: cell(60) }, { kind: 'rows', anchor: cell(200), focus: cell(12) }] }
    expect(wantedRows(chosen, viewport)).toEqual([12, 13, 11, 10, 15])
    expect(wantedRows(selection({ active: cell(0) }), viewport)).toEqual([0, 1, 10])
    expect(wantedRows(undefined, viewport)).toEqual([10])
    expect(wantedRows(undefined, { ...viewport, rows: 0 })).toEqual([])
    const many: GridSelection = { resultIndex: 0, active: cell(0), blocks: Array.from({ length: 64 }, (_, index) => ({ kind: 'cells' as const, anchor: cell(index * 2), focus: cell(index * 2 + 1) })) }
    expect(wantedRows(many, { ...viewport, rows: 1000 })).toHaveLength(64)
  })
  it('builds a key from the key columns\' stored text as the backend does: NULL as empty, joined with U+001F, never a cut cell', () => {
    const window = windowOf(10, [['1', 'x', '2020'], ['2', null, null]], 3)
    expect(keyOfRow(window, 10, [3, 5])).toBe('1\u001f2020')
    expect(keyOfRow(window, 11, [3, 5])).toBe('2\u001f')
    expect(keyOfRow(window, 12, [3])).toBeUndefined()
    window.flags[0] = FLAG_CAPPED
    expect(keyOfRow(window, 10, [3])).toBeUndefined()
  })
  it('reads the rows it needs in as few windows as fit', () => {
    expect(readSpans([9000, 3, 7, 3, 4100], 4096)).toEqual([{ first: 3, count: 5 }, { first: 4100, count: 1 }, { first: 9000, count: 1 }])
    expect(readSpans([], 4096)).toEqual([])
  })
})

// A live view and a grid that LiveGrid drives: the test plays the backend (tables) and the user (selection, scroll).
const keySpec: LiveTableSpec = { id: 'items', mode: 'snapshot', key: ['id'], columns: [{ id: 'id', name: 'id', dataType: 'int' }, { id: 'name', name: 'name', dataType: 'nvarchar' }, { id: 'tone', name: 'tone', dataType: 'nvarchar', role: 'tone' }] }
const logSpec: LiveTableSpec = { id: 'log', mode: 'append', key: ['id'], columns: [{ id: 'id', name: 'id', dataType: 'bigint' }, { id: 'text', name: 'text', dataType: 'nvarchar' }] }
let nextId = 1
function table(o: { ids?: string[]; mode?: 'snapshot' | 'append'; rows?: number; resultId?: number; tracked?: LiveTable['tracked']; departed?: number[]; rolledFrom?: number; restarted?: boolean } = {}): LiveTable & { reads: number[] } {
  const ids = o.ids ?? [], reads: number[] = []
  const descriptor = { generation: 1, resultId: o.resultId ?? nextId++, columns: o.mode === 'append' ? logSpec.columns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true })) : keySpec.columns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true, ...column.role ? { role: column.role } : {} })) } as unknown as ResultDescriptor
  const handle = {
    key: { generation: 1, resultId: descriptor.resultId },
    getSnapshot: () => ({ rowsAvailable: o.rows ?? ids.length, state: 'complete' }),
    getWindow: (first: number, count: number, w: WindowOptions = {}) => {
      reads.push(first)
      expect(w).toMatchObject({ colStart: 0, colEnd: 1, display: false })
      return Promise.resolve(windowOf(first, ids.slice(first, first + count).map(id => [id])))
    }
  } as unknown as ResultHandle
  return { probe: 'debug.synthetic.grid', index: 0, mode: o.mode ?? 'snapshot', descriptor, handle, reads, ...o.tracked ? { tracked: o.tracked } : {}, ...o.departed ? { departed: o.departed } : {}, ...o.rolledFrom !== undefined ? { rolledFrom: o.rolledFrom } : {}, ...o.restarted ? { restarted: true } : {} }
}
function harness(spec: LiveTableSpec = keySpec) {
  let current: LiveTable | undefined
  const timers = manualTimers()
  const ticks = new Set<(tick: AppliedTick) => void>()
  const live = { table: () => current, onTick: (listener: (tick: AppliedTick) => void) => { ticks.add(listener); return { dispose: () => { ticks.delete(listener) } } }, track: vi.fn(), setProbe: vi.fn() }
  const view = {
    swaps: [] as { handle: ResultHandle; mapRow: RowMap; muted?: readonly number[]; top?: number }[], ends: 0, disposed: false,
    selection: undefined as GridSelection | undefined, viewport: undefined as GridViewport | undefined, hooks: undefined as LiveGridHooks | undefined, created: undefined as LiveTable | undefined,
    /** Each prepare's first row and signal; it finishes at once unless the test holds it. */
    prepares: [] as { handle: ResultHandle; firstRow: number; signal?: AbortSignal; finish(): void }[], hold: false
  }
  const fake: LiveGridView = {
    // As GridView does: the selection and the first row shown move through mapRow.
    swap: (handle, _descriptor, mapRow, o) => {
      view.swaps.push({ handle, mapRow, ...o?.muted ? { muted: o.muted } : {}, ...o?.top !== undefined ? { top: o.top } : {} })
      const rows = handle.getSnapshot().rowsAvailable
      view.selection = remapSelection(view.selection, mapRow, rows, 2)
      if (view.viewport) view.viewport = { ...view.viewport, rows, firstRow: Math.max(0, Math.min(rows - 1, mapRow(view.viewport.firstRow))) }
    },
    revealEnd: () => { view.ends++ },
    prepare: (handle, firstRow, signal) => new Promise<void>(finish => { view.prepares.push({ handle, firstRow, signal, finish }); if (!view.hold) finish() }),
    currentSelection: () => view.selection,
    lastViewport: () => view.viewport,
    dispose: () => { view.disposed = true }
  }
  const copies: unknown[] = []
  const api = { copyResults: vi.fn(async (request: unknown) => { copies.push(request); return { ok: true as const, value: { rows: 1, bytes: 1, truncatedCells: 0, partial: false } } }), saveResults: vi.fn(async () => ({ ok: true as const, value: null })) }
  const grid = new LiveGrid({ live, probe: 'debug.synthetic.grid', spec, api, newId: () => 'job', timers: timers.timers, createView: (first, hooks) => { view.created = first; view.hooks = hooks; return fake } })
  const emit = (next: LiveTable) => { current = next; for (const listener of [...ticks]) listener({ subscriptionId: 's', tick: {} as LiveTick }) }
  /** The user scrolled or selected: the grid reports a frame. */
  const frame = (o: { selection?: GridSelection; viewport?: GridViewport }) => {
    if (o.selection) { view.selection = o.selection; view.hooks!.onSelection(o.selection) }
    if (o.viewport) { view.viewport = o.viewport; view.hooks!.onViewport(o.viewport) }
  }
  return { grid, live, view, emit, frame, api, copies, ticks, timers }
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('LiveGrid', () => {
  it('builds the grid on the table\'s first result, and follows the selected and first rows by key', async () => {
    const { grid, live, view, emit, frame } = harness()
    expect(view.created).toBeUndefined()
    const first = table({ ids: ['10', '11', '12', '13', '14'] })
    emit(first)
    expect(view.created).toBe(first)
    expect(grid.getSnapshot().table).toBe(first)
    frame({ selection: selection({ active: cell(3, 1) }), viewport: { firstRow: 1, lastRow: 4, rows: 5, atEnd: true } })
    await settle()
    // One read covers the rows; the keys go once, in order: the active row, its neighbours, then the first row shown.
    expect(first.reads).toEqual([1])
    expect(live.track).toHaveBeenLastCalledWith('debug.synthetic.grid', ['13', '14', '12', '11'], 0)
    // The same rows again: nothing new is read or sent.
    frame({ viewport: { firstRow: 1, lastRow: 4, rows: 5, atEnd: false } })
    await settle()
    expect(live.track).toHaveBeenCalledTimes(1)
    expect(first.reads).toEqual([1])
  })

  it('swaps each revision with the rows the backend tracked, mutes departed rows, and knows the tracked rows without reading', async () => {
    const { live, view, emit, frame } = harness()
    emit(table({ ids: ['10', '11', '12', '13', '14'] }))
    frame({ selection: selection({ active: cell(3, 1) }), viewport: { firstRow: 1, lastRow: 4, rows: 5, atEnd: true } })
    await settle()
    // The backend moved 13 to row 0 and 11 left (still shown one revision, departed, at row 4).
    const second = table({ ids: ['13', '12', '14', '15', '11'], tracked: { seq: 1, rows: [0, 2, 1, 4], keys: ['13', '14', '12', '11'] }, departed: [4] })
    emit(second)
    // Its first rows are read first, from where the first row shown went (11, departed, now at row 4).
    expect(view.prepares.map(prepare => [prepare.handle, prepare.firstRow])).toEqual([[second.handle, 4]])
    await settle()
    expect(view.swaps).toHaveLength(1)
    const swap = view.swaps[0]
    expect(swap.handle).toBe(second.handle)
    expect(swap.muted).toEqual([4])
    expect([3, 1, 2, 4, 0].map(swap.mapRow)).toEqual([0, 4, 1, 2, 0])
    // The grid moved its selection and top through mapRow; the keys of their rows (0, 1 and 4) are known from the tracking.
    await settle()
    expect(view.selection?.active).toEqual(cell(0, 1))
    expect(second.reads).toEqual([])
    // Then 11 is gone for good, and an untracked list (no keys) leaves rows where they are.
    const third = table({ ids: ['13', '12'], tracked: { seq: 9, rows: [0, -1] } })
    emit(third)
    await settle()
    expect([0, 4].map(view.swaps[1].mapRow)).toEqual([0, 4])
    expect(view.swaps[1].muted).toBeUndefined()
    // The same result again (a tick without this table) swaps nothing.
    emit({ ...third })
    await settle()
    expect(view.swaps).toHaveLength(2)
    await settle()
    expect(live.track).toHaveBeenCalled()
  })

  it('drops keys read from a revision that was swapped out while they were read', async () => {
    const { live, emit, frame } = harness()
    let release!: () => void
    const slow = table({ ids: ['1', '2', '3'] })
    const read = slow.handle.getWindow.bind(slow.handle)
    ;(slow.handle as { getWindow: ResultHandle['getWindow'] }).getWindow = (...args) => new Promise(resolve => { release = () => resolve(read(...args)) })
    emit(slow)
    frame({ selection: selection({ active: cell(2) }), viewport: { firstRow: 0, lastRow: 2, rows: 3, atEnd: true } })
    await settle()
    const next = table({ ids: ['9', '8', '7'] })
    emit(next)
    await settle()
    release()
    await settle()
    // The old revision's keys never went; the new revision's rows were read and sent instead.
    expect(live.track.mock.calls.map(call => call[1])).toEqual([['7', '8', '9']])
  })

  it('reads a revision\'s first rows before it swaps in, at most a moment, and swaps a newer one in at once', async () => {
    const { grid, view, emit, frame, timers } = harness()
    const first = table({ ids: ['1', '2', '3'] })
    emit(first)
    frame({ viewport: { firstRow: 0, lastRow: 2, rows: 3, atEnd: true } })
    view.hold = true
    // While its rows are read, the grid shows the revision it had: nothing swaps, and Copy reads that one.
    const second = table({ ids: ['2', '3', '4'] })
    emit(second)
    await settle()
    expect(view.swaps).toHaveLength(0)
    expect(grid.getSnapshot().table).toBe(first)
    // A view at the top prepares the top.
    expect(view.prepares.at(-1)?.firstRow).toBe(0)
    view.prepares.at(-1)!.finish()
    await settle()
    expect(view.swaps.map(swap => swap.handle)).toEqual([second.handle])
    expect(grid.getSnapshot().table).toBe(second)
    // A prepare that takes too long: the revision swaps in after prepareMs anyway.
    const third = table({ ids: ['3', '4', '5'] })
    emit(third)
    timers.advance(prepareMs - 1)
    expect(view.swaps).toHaveLength(1)
    timers.advance(1)
    expect(view.swaps.map(swap => swap.handle)).toEqual([second.handle, third.handle])
    expect(view.prepares.at(-1)?.signal?.aborted).toBe(true)
    // A newer revision while one is prepared retired the one shown: it swaps in at once, and the prepared one never does.
    const fourth = table({ ids: ['4', '5', '6'] }), fifth = table({ ids: ['5', '6', '7'] })
    emit(fourth)
    emit(fifth)
    expect(view.swaps.map(swap => swap.handle)).toEqual([second.handle, third.handle, fifth.handle])
    view.prepares.at(-1)!.finish()
    timers.advance(prepareMs)
    await settle()
    expect(view.swaps).toHaveLength(3)
    grid.dispose()
  })

  it('follows an append table\'s tail, counts the rows that arrive while scrolled up, and keeps following through a roll', () => {
    const { grid, view, emit, frame } = harness(logSpec)
    const segment = table({ mode: 'append', rows: 100 })
    emit(segment)
    frame({ viewport: { firstRow: 80, lastRow: 99, rows: 100, atEnd: true } })
    expect(grid.getSnapshot()).toMatchObject({ following: true, newRows: 0 })
    // The user scrolled up; 30 rows arrive in the same segment (no swap), then the grid's next frame reports them.
    frame({ viewport: { firstRow: 20, lastRow: 39, rows: 100, atEnd: false } })
    emit({ ...segment, descriptor: { ...segment.descriptor, rowsAvailable: 130 } })
    frame({ viewport: { firstRow: 20, lastRow: 39, rows: 130, atEnd: false } })
    expect(view.swaps).toHaveLength(0)
    expect(grid.getSnapshot()).toMatchObject({ following: false, newRows: 30 })
    // Jump to latest scrolls to the end, which follows again.
    grid.jumpToEnd()
    expect(view.ends).toBe(1)
    frame({ viewport: { firstRow: 110, lastRow: 129, rows: 130, atEnd: true } })
    expect(grid.getSnapshot()).toMatchObject({ following: true, newRows: 0 })
    // A roll swaps to the new segment, maps no rows, and stays at the tail.
    emit(table({ mode: 'append', rows: 5, rolledFrom: segment.descriptor.resultId }))
    expect(view.swaps).toHaveLength(1)
    expect(view.swaps[0].mapRow(3)).toBe(-1)
    expect(view.ends).toBe(2)
    // Scrolled up, a restart (a new filter) keeps the view where it is; a roll still goes to the tail.
    frame({ viewport: { firstRow: 0, lastRow: 2, rows: 5, atEnd: false } })
    emit(table({ mode: 'append', rows: 4, restarted: true }))
    expect(view.ends).toBe(2)
    expect(view.swaps.at(-1)?.top).toBe(0)
    expect(view.swaps[0].top).toBeUndefined()
    emit(table({ mode: 'append', rows: 2, rolledFrom: 1 }))
    expect(view.ends).toBe(3)
  })

  it('sorts a snapshot by catalogue column id, never by the tone, and clears the sort', () => {
    const { grid, live, emit } = harness()
    emit(table({ ids: ['1'] }))
    grid.sortBy(1, true)
    expect(live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: [{ column: 'name', descending: true }] })
    expect(grid.getSnapshot().sort).toEqual([{ column: 'name', descending: true }])
    grid.sortBy('id')
    expect(live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: [{ column: 'id', descending: false }] })
    grid.sortBy(2)
    grid.sortBy('nope')
    expect(live.setProbe).toHaveBeenCalledTimes(2)
    grid.sortBy(undefined)
    expect(live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: undefined })
    expect(grid.getSnapshot().sort).toBeUndefined()
    // An append table is in id order: no sort.
    const log = harness(logSpec)
    log.grid.sortBy(0)
    expect(log.live.setProbe).not.toHaveBeenCalled()
  })

  it('copies the selection of the revision it shows, over the shown columns only, and saves that revision', async () => {
    const { grid, view, emit, copies, api } = harness()
    const shown = table({ ids: ['1', '2', '3'] })
    emit(shown)
    view.selection = { resultIndex: 0, active: cell(0), blocks: [{ kind: 'rows', anchor: cell(0), focus: cell(1) }] }
    await grid.copy(true)
    expect(copies).toEqual([{ jobId: 'job', generation: 1, resultId: shown.descriptor.resultId, headers: true, parts: [{ rows: [[0, 1]], columns: [[0, 1]] }] }])
    await grid.save('Processes.csv', 'csv')
    expect(api.saveResults).toHaveBeenCalledWith({ jobId: 'job', generation: 1, resultId: shown.descriptor.resultId, suggestedName: 'Processes.csv', format: 'csv' })
  })

  it('stops listening and disposes its grid', () => {
    const { grid, view, emit, ticks } = harness()
    emit(table({ ids: ['1'] }))
    grid.dispose()
    expect(view.disposed).toBe(true)
    expect(ticks.size).toBe(0)
  })
})
