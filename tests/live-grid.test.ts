import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import type { LiveTableSpec } from '../src/shared/live/catalog'
import { GridData } from '../src/renderer/src/grid/data'
import { toneColumnOf, type GridViewport } from '../src/renderer/src/grid/GridView'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { remapSelection, remapTop, sameSelection, survivingRow, type RowMap } from '../src/renderer/src/grid/swap'
import { tileColumnOf, tileRowOf } from '../src/renderer/src/grid/tiles'
import { keyOfRow, LiveGrid, liveGridText, prepareMs, readSpans, selectedRows, trackedRowMap, wantedRows, type LiveGridHooks, type LiveGridState, type LiveGridView } from '../src/renderer/src/live/LiveGrid'
import type { AppliedTick, LiveProbeOptions, LiveStatus, LiveTable } from '../src/renderer/src/live/LiveService'
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
    // Both neighbours survived, at different places: below wins.
    expect(survivingRow(5, row => ({ 5: -1, 6: 8, 4: 2 } as Record<number, number>)[row] ?? -1, 20)).toBe(8)
    // Gone, and nothing below survived within reach: the row above.
    expect(survivingRow(5, row => row === 4 ? 3 : -1, 20)).toBe(3)
    // Nothing survived: the old index, within the new rows.
    expect(survivingRow(30, () => -1, 10)).toBe(9)
    expect(survivingRow(3, () => -1, 0)).toBe(0)
    // A row whose place the map does not know is passed over, not taken at its old index: here row 6 left too, row 7 is
    // unknown (kept at 7, where another row now is), and row 4 survived at 2.
    const partly = Object.assign((row: number) => ({ 5: -1, 6: -1, 4: 2 } as Record<number, number>)[row] ?? row, { known: (row: number) => row >= 4 && row <= 6 })
    expect(survivingRow(5, partly, 20)).toBe(2)
    // Nothing known survived: the old index.
    expect(survivingRow(5, Object.assign((row: number) => row === 5 || row === 6 ? -1 : row, { known: (row: number) => row === 5 || row === 6 }), 20)).toBe(5)
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
  it('tells a moved selection from one that stayed, which a swap reports to the grid\'s owner', () => {
    const before = selection({ active: cell(4, 1), blocks: [{ kind: 'cells', anchor: cell(2), focus: cell(4, 1) }] })
    expect(sameSelection(before, remapSelection(before, map({}), 10, 2))).toBe(true)
    expect(sameSelection(before, remapSelection(before, map({ 4: 5 }), 10, 2))).toBe(false)
    expect(sameSelection(before, remapSelection(before, map({ 2: 1 }), 10, 2))).toBe(false)
    expect(sameSelection(before, { ...before, blocks: [...before.blocks, before.blocks[0]] })).toBe(false)
    expect(sameSelection(undefined, undefined)).toBe(true)
    expect(sameSelection(before, undefined)).toBe(false)
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
    // Rows 5 (its key was not answered) and 9 (its key unknown) stay at their index, and the map says it does not know them.
    expect([0, 3, 5, 9].map(row => mapRow.known?.(row))).toEqual([true, true, false, false])
    // Without the keys of the answered list, nothing can be mapped.
    expect(trackedRowMap(known, { seq: 4, rows: [7, -1] })(0)).toBe(0)
    expect(trackedRowMap(known, undefined)(3)).toBe(3)
  })
  it('follows the selected rows first (they linger), then the active row\'s neighbours and the first row shown, each once, within the rows', () => {
    const viewport: GridViewport = { firstRow: 10, lastRow: 40, rows: 100, atEnd: false }
    const chosen: GridSelection = { resultIndex: 0, active: cell(12), blocks: [{ kind: 'cells', anchor: cell(12), focus: cell(15) }, { kind: 'all', anchor: cell(50), focus: cell(60) }, { kind: 'rows', anchor: cell(200), focus: cell(12) }] }
    expect(selectedRows(chosen)).toEqual([12, 15, 200])
    // 200 is past the rows: the active row and one corner are selected, then the neighbours and the first row shown.
    expect(wantedRows(chosen, viewport)).toEqual({ rows: [12, 15, 13, 11, 10], selected: 2 })
    expect(wantedRows(selection({ active: cell(0) }), viewport)).toEqual({ rows: [0, 1, 10], selected: 1 })
    expect(wantedRows(undefined, viewport)).toEqual({ rows: [10], selected: 0 })
    expect(wantedRows(undefined, { ...viewport, rows: 0 })).toEqual({ rows: [], selected: 0 })
    // A view at the top stays at the top whatever moves there: its first row is not followed (nor kept when it leaves).
    expect(wantedRows(selection({ active: cell(5) }), { ...viewport, firstRow: 0 })).toEqual({ rows: [5, 6, 4], selected: 1 })
    expect(wantedRows(undefined, { ...viewport, firstRow: 0 })).toEqual({ rows: [], selected: 0 })
    const many: GridSelection = { resultIndex: 0, active: cell(0), blocks: Array.from({ length: 64 }, (_, index) => ({ kind: 'cells' as const, anchor: cell(index * 2), focus: cell(index * 2 + 1) })) }
    expect(wantedRows(many, { ...viewport, rows: 1000 })).toEqual({ rows: Array.from({ length: 64 }, (_, index) => index), selected: 64 })
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
function table(o: { ids?: string[]; mode?: 'snapshot' | 'append'; rows?: number; resultId?: number; tracked?: LiveTable['tracked']; departed?: number[]; rolledFrom?: number; restarted?: boolean } = {}): LiveTable & { reads: number[]; lose(): void; release(): void; listeners: Set<() => void> } {
  const ids = o.ids ?? [], reads: number[] = [], listeners = new Set<() => void>()
  let state = 'complete'
  const descriptor = { generation: 1, resultId: o.resultId ?? nextId++, columns: o.mode === 'append' ? logSpec.columns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true })) : keySpec.columns.map(column => ({ name: column.name, dataType: column.dataType, wire: 'text', nullable: true, ...column.role ? { role: column.role } : {} })) } as unknown as ResultDescriptor
  const handle = {
    key: { generation: 1, resultId: descriptor.resultId },
    getSnapshot: () => ({ rowsAvailable: o.rows ?? ids.length, state }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getWindow: (first: number, count: number, w: WindowOptions = {}) => {
      reads.push(first)
      expect(w).toMatchObject({ colStart: 0, colEnd: 1, display: false })
      return Promise.resolve(windowOf(first, ids.slice(first, first + count).map(id => [id])))
    }
  } as unknown as ResultHandle
  const lose = () => { state = 'lost'; for (const listener of [...listeners]) listener() }
  const release = () => { state = 'released'; for (const listener of [...listeners]) listener() }
  return { probe: 'debug.synthetic.grid', index: 0, mode: o.mode ?? 'snapshot', descriptor, handle, reads, lose, release, listeners, ...o.tracked ? { tracked: o.tracked } : {}, ...o.departed ? { departed: o.departed } : {}, ...o.rolledFrom !== undefined ? { rolledFrom: o.rolledFrom } : {}, ...o.restarted ? { restarted: true } : {} }
}
function harness(spec: LiveTableSpec = keySpec, o: { index?: number; state?: LiveGridState; options?: LiveProbeOptions; selection?: GridSelection } = {}) {
  let current: LiveTable | undefined
  const timers = manualTimers()
  const ticks = new Set<(tick: AppliedTick) => void>()
  // The view: its status (why a released result is gone) and the probe's settings, which setProbe changes as LiveService does.
  let status: LiveStatus = 'live', options: LiveProbeOptions = { ...o.options }
  const statusListeners = new Set<() => void>()
  const live = {
    table: () => current, onTick: (listener: (tick: AppliedTick) => void) => { ticks.add(listener); return { dispose: () => { ticks.delete(listener) } } }, track: vi.fn(),
    setProbe: vi.fn((_probe: string, patch: LiveProbeOptions) => { options = { ...options, ...patch } }), probeOptions: () => options,
    getSnapshot: () => ({ status, probes: {}, connectionId: 'c' }), subscribe: (listener: () => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener) } }
  }
  const setStatus = (next: LiveStatus) => { status = next; for (const listener of [...statusListeners]) listener() }
  const view = {
    swaps: [] as { handle: ResultHandle; mapRow: RowMap; muted?: readonly number[]; top?: number }[], ends: 0, disposed: false,
    // As GridView restores a kept state's selection, silently.
    selection: o.selection, viewport: undefined as GridViewport | undefined, hooks: undefined as LiveGridHooks | undefined, created: undefined as LiveTable | undefined,
    /** Each prepare's first row and signal; it finishes at once unless the test holds it. */
    prepares: [] as { handle: ResultHandle; firstRow: number; signal?: AbortSignal; finish(): void }[], hold: false
  }
  const fake: LiveGridView = {
    // As GridView does: the selection and the first row shown move through mapRow, and a moved selection is reported.
    swap: (handle, _descriptor, mapRow, o) => {
      view.swaps.push({ handle, mapRow, ...o?.muted ? { muted: o.muted } : {}, ...o?.top !== undefined ? { top: o.top } : {} })
      const rows = handle.getSnapshot().rowsAvailable, before = view.selection
      view.selection = remapSelection(view.selection, mapRow, rows, 2)
      if (view.selection && !sameSelection(before, view.selection)) view.hooks!.onSelection(view.selection)
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
  const grid = new LiveGrid({
    live, probe: 'debug.synthetic.grid', spec, api, newId: () => 'job', timers: timers.timers, ...o.index !== undefined ? { table: o.index } : {}, ...o.state ? { state: o.state } : {},
    createView: (first, hooks) => { view.created = first; view.hooks = hooks; return fake }
  })
  const emit = (next: LiveTable) => { current = next; for (const listener of [...ticks]) listener({ subscriptionId: 's', tick: {} as LiveTick }) }
  /** The user scrolled or selected: the grid reports a frame. */
  const frame = (o: { selection?: GridSelection; viewport?: GridViewport }) => {
    if (o.selection) { view.selection = o.selection; view.hooks!.onSelection(o.selection) }
    if (o.viewport) { view.viewport = o.viewport; view.hooks!.onViewport(o.viewport) }
  }
  return { grid, live, view, emit, frame, api, copies, ticks, timers, setStatus, statusListeners }
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
    // Only the active row lingers when it leaves.
    expect(live.track).toHaveBeenLastCalledWith('debug.synthetic.grid', ['13', '14', '12', '11'], 0, 1)
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
    // The old revision's keys never went; the new revision's rows were read and sent instead (a view at the top does
    // not follow its first row).
    expect(live.track.mock.calls.map(call => call[1])).toEqual([['7', '8']])
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
    // No row arrived since the restart: none is new, before or after the grid's first frame of it.
    expect(grid.getSnapshot().newRows).toBe(0)
    frame({ viewport: { firstRow: 0, lastRow: 3, rows: 4, atEnd: false } })
    expect(grid.getSnapshot().newRows).toBe(0)
    emit(table({ mode: 'append', rows: 2, rolledFrom: 1 }))
    expect(view.ends).toBe(3)
  })

  it('counts only the rows that arrive after a restart while scrolled up, however many the new segment starts with', () => {
    const { grid, emit, frame } = harness(logSpec)
    emit(table({ mode: 'append', rows: 100 }))
    frame({ viewport: { firstRow: 80, lastRow: 99, rows: 100, atEnd: true } })
    frame({ viewport: { firstRow: 20, lastRow: 39, rows: 100, atEnd: false } })
    const restarted = table({ mode: 'append', rows: 1000, restarted: true })
    emit(restarted)
    frame({ viewport: { firstRow: 0, lastRow: 19, rows: 1000, atEnd: false } })
    expect(grid.getSnapshot()).toMatchObject({ following: false, newRows: 0 })
    emit({ ...restarted })
    frame({ viewport: { firstRow: 0, lastRow: 19, rows: 1012, atEnd: false } })
    expect(grid.getSnapshot().newRows).toBe(12)
  })

  it('reports where a swap moved the selection, with the active row\'s key, to the grid\'s owner', async () => {
    const { grid, emit, frame } = harness()
    emit(table({ ids: ['10', '11', '12', '13', '14'] }))
    frame({ selection: selection({ active: cell(3, 1) }), viewport: { firstRow: 0, lastRow: 4, rows: 5, atEnd: true } })
    await settle()
    expect(grid.getSnapshot()).toMatchObject({ selection: { active: cell(3, 1) }, activeKey: '13' })
    // 13 left the source; the row below it (14) is now at row 2, so the selection moves there, and the owner hears of it.
    emit(table({ ids: ['10', '12', '14', '15'], tracked: { seq: 1, rows: [-1, 2, 1, 0], keys: ['13', '14', '12', '10'] } }))
    await settle()
    expect(grid.getSnapshot()).toMatchObject({ selection: { active: cell(2, 1) }, activeKey: '14' })
  })

  it('moves a selection whose row and tracked neighbours all left to its old index, not to a row it only guessed', async () => {
    // As the synthetic grid does: each revision drops the lowest ids and adds new ones at the bottom.
    const { grid, live, emit, frame } = harness()
    emit(table({ ids: ['10', '11', '12', '13', '14'] }))
    frame({ selection: selection({ active: cell(0, 1) }), viewport: { firstRow: 0, lastRow: 4, rows: 5, atEnd: true } })
    await settle()
    expect(live.track).toHaveBeenLastCalledWith('debug.synthetic.grid', ['10', '11'], 0, 1)
    // 10 and its neighbour 11 left; row 2 (12) was never tracked, and its old index now holds 14.
    emit(table({ ids: ['12', '13', '14', '15', '16'], tracked: { seq: 1, rows: [-1, -1], keys: ['10', '11'] } }))
    await settle()
    expect(grid.getSnapshot()).toMatchObject({ selection: { active: cell(0, 1) }, activeKey: '12' })
  })

  it('says when the result it shows is lost, and listens only to the result it shows', async () => {
    const { grid, emit } = harness()
    const shown = table({ ids: ['1'] })
    emit(shown)
    expect(grid.getSnapshot().lost).toBe(false)
    const published = vi.fn()
    grid.subscribe(published)
    shown.lose()
    expect(grid.getSnapshot().lost).toBe(true)
    expect(published).toHaveBeenCalledTimes(1)
    const next = table({ ids: ['1'] })
    emit(next)
    await settle()
    expect(grid.getSnapshot()).toMatchObject({ table: next, lost: false })
    expect([shown.listeners.size, next.listeners.size]).toEqual([0, 1])
    grid.dispose()
    expect(next.listeners.size).toBe(0)
  })

  it('publishes only what changed: scrolling a snapshot table renders nothing', async () => {
    const { grid, emit, frame } = harness()
    emit(table({ ids: Array.from({ length: 100 }, (_, index) => String(index)) }))
    frame({ viewport: { firstRow: 0, lastRow: 10, rows: 100, atEnd: false } })
    await settle()
    const published = vi.fn()
    grid.subscribe(published)
    for (let first = 1; first <= 20; first++) frame({ viewport: { firstRow: first, lastRow: first + 10, rows: 100, atEnd: false } })
    await settle()
    expect(published).not.toHaveBeenCalled()
  })

  it('sorts a snapshot by catalogue column id for its own table, never by the tone, and clears the sort', () => {
    const { grid, live, emit } = harness()
    emit(table({ ids: ['1'] }))
    grid.sortBy(1, true)
    expect(live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: [{ column: 'name', descending: true, table: 0 }] })
    expect(grid.getSnapshot().sort).toEqual([{ column: 'name', descending: true }])
    grid.sortBy('id')
    expect(live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: [{ column: 'id', descending: false, table: 0 }] })
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

  it('sorts only its own table of a probe, keeps the other tables\' keys, and shows a sort the probe already had', () => {
    // Table 1 of a probe whose table 0 is sorted by cpu: its grid sorts by id without touching table 0's key.
    const second = harness(keySpec, { index: 1, options: { sort: [{ column: 'id', descending: true, table: 0 }] } })
    second.emit(table({ ids: ['1'] }))
    expect(second.grid.getSnapshot().sort).toBeUndefined()
    second.grid.sortBy('name', true)
    expect(second.live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: [{ column: 'name', descending: true, table: 1 }, { column: 'id', descending: true, table: 0 }] })
    second.grid.sortBy(undefined)
    expect(second.live.setProbe).toHaveBeenLastCalledWith('debug.synthetic.grid', { sort: [{ column: 'id', descending: true, table: 0 }] })
    // A grid built again over a sorted probe shows its sort from the start, as does a probe-wide key on a column it has.
    const remounted = harness(keySpec, { options: { sort: [{ column: 'id', descending: true, table: 0 }, { column: 'name', descending: false, table: 1 }] } })
    expect(remounted.grid.getSnapshot().sort).toEqual([{ column: 'id', descending: true }])
    expect(harness(keySpec, { index: 1, options: { sort: [{ column: 'name', descending: false }] } }).grid.getSnapshot().sort).toEqual([{ column: 'name', descending: false }])
  })

  it('keeps following the selected row\'s key while the next revision has not answered it, and moves there once one does', async () => {
    const { grid, live, emit, frame } = harness()
    emit(table({ ids: ['10', '11', '12', '13', '14'] }))
    frame({ selection: selection({ active: cell(3, 1) }), viewport: { firstRow: 0, lastRow: 4, rows: 5, atEnd: true } })
    await settle()
    expect(live.track).toHaveBeenLastCalledWith('debug.synthetic.grid', ['13', '14', '12'], 0, 1)
    // Sampled under an older list (10, 11): 13 is now at row 0 and row 3 holds 11, but this revision cannot say so.
    emit(table({ ids: ['13', '12', '14', '11', '10'], tracked: { seq: 1, rows: [4, 3], keys: ['10', '11'] } }))
    await settle()
    // The selection stays at row 3 for now, but the grid still means 13: it says so, and goes on sending 13, not 11.
    expect(grid.getSnapshot()).toMatchObject({ selection: { active: cell(3, 1) }, activeKey: '13' })
    expect(live.track.mock.lastCall![1][0]).toBe('13')
    // The next revision answers 13's list: the selection moves to it.
    emit(table({ ids: ['13', '12', '14', '11', '10'], tracked: { seq: 2, rows: [0, 4, 2], keys: ['13', '10', '14'] } }))
    await settle()
    expect(grid.getSnapshot()).toMatchObject({ selection: { active: cell(0, 1) }, activeKey: '13' })
  })

  it('takes a click on a row whose key it still waits for as the row the user sees', async () => {
    const { grid, live, emit, frame } = harness()
    emit(table({ ids: ['10', '11', '12', '13', '14'] }))
    frame({ selection: selection({ active: cell(3, 1) }), viewport: { firstRow: 0, lastRow: 4, rows: 5, atEnd: true } })
    await settle()
    emit(table({ ids: ['13', '12', '14', '11', '10'], tracked: { seq: 1, rows: [4, 3], keys: ['10', '11'] } }))
    await settle()
    expect(grid.getSnapshot().activeKey).toBe('13')
    // The user clicks row 3 again: they chose 11, which the revision placed there.
    frame({ selection: selection({ active: cell(3, 0) }) })
    await settle()
    expect(grid.getSnapshot().activeKey).toBe('11')
    expect(live.track.mock.lastCall![1][0]).toBe('11')
  })

  it('says when the view stopped and its result was released, dormant or for good, and copies nothing then', async () => {
    const { grid, view, emit, setStatus, api } = harness()
    const shown = table({ ids: ['1', '2'] })
    emit(shown)
    view.selection = selection({ active: cell(0) })
    // Hidden long enough: the view went dormant, and its end released the rows.
    setStatus('dormant')
    shown.release()
    expect(grid.getSnapshot()).toMatchObject({ released: 'dormant', lost: false })
    setStatus('ended')
    expect(grid.getSnapshot().released).toBe('stopped')
    await expect(grid.copy(false)).resolves.toEqual({ ok: false, error: liveGridText.stopped, code: 'RESULT_UNAVAILABLE' })
    await expect(grid.save('Processes.csv')).resolves.toMatchObject({ ok: false, error: liveGridText.stopped })
    expect(api.copyResults).not.toHaveBeenCalled()
    // A copy whose result is released while it runs answers in the same words.
    const next = table({ ids: ['1', '2'] })
    emit(next)
    await settle()
    expect(grid.getSnapshot().released).toBeUndefined()
    api.copyResults.mockImplementationOnce((async () => { next.release(); return { ok: false as const, error: 'These results were closed. Execute the query again to see them.', code: 'NOT_FOUND' as const } }) as never)
    await expect(grid.copy(false)).resolves.toMatchObject({ ok: false, error: liveGridText.stopped })
  })

  it('reports the selection a grid built over kept state shows, and follows its rows by the kept keys', async () => {
    const shown = table({ ids: ['10', '11', '12', '13'] })
    const key = `1:${shown.descriptor.resultId}`
    // The same result: the kept keys are its rows' keys, so nothing is read again.
    const same = harness(keySpec, { selection: selection({ active: cell(2, 1) }), state: { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true, keys: [[2, '12']], keysIn: key } })
    same.emit(shown)
    expect(same.grid.getSnapshot()).toMatchObject({ selection: { active: cell(2, 1) }, activeKey: '12' })
    // A newer revision than the kept keys: they are pinned until a revision places them, and sent as they are.
    const newer = harness(keySpec, { selection: selection({ active: cell(2, 1) }), state: { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true, keys: [[2, '99']], keysIn: '1:12345' } })
    newer.emit(table({ ids: ['10', '11', '12', '13'] }))
    newer.frame({ viewport: { firstRow: 0, lastRow: 3, rows: 4, atEnd: true } })
    await settle()
    expect(newer.grid.getSnapshot().activeKey).toBe('99')
    expect(newer.live.track.mock.lastCall![1][0]).toBe('99')
    // The grid writes where it is into the state it was given.
    const state: LiveGridState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    const fresh = harness(keySpec, { state })
    const first = table({ ids: ['10', '11', '12'] })
    fresh.emit(first)
    fresh.frame({ selection: selection({ active: cell(1) }), viewport: { firstRow: 0, lastRow: 2, rows: 3, atEnd: true } })
    await settle()
    expect(state).toMatchObject({ keys: [[1, '11']], keysIn: `1:${first.descriptor.resultId}` })
  })

  it('opens a kept append grid where it was: not following, counting the rows that came since', () => {
    const segment = table({ mode: 'append', rows: 130 })
    const state: LiveGridState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true, following: false, seenRows: 100, seenIn: `1:${segment.descriptor.resultId}` }
    const { grid, emit, frame } = harness(logSpec, { state })
    emit(segment)
    frame({ viewport: { firstRow: 20, lastRow: 39, rows: 130, atEnd: false } })
    expect(grid.getSnapshot()).toMatchObject({ following: false, newRows: 30 })
    // Another segment than the one counted: every row in it is new.
    const other = harness(logSpec, { state: { ...state, seenIn: '1:1' } })
    other.emit(table({ mode: 'append', rows: 40 }))
    other.frame({ viewport: { firstRow: 0, lastRow: 19, rows: 40, atEnd: false } })
    expect(other.grid.getSnapshot()).toMatchObject({ following: false, newRows: 40 })
  })

  it('stops listening and disposes its grid', () => {
    const { grid, view, emit, ticks, statusListeners } = harness()
    emit(table({ ids: ['1'] }))
    grid.dispose()
    expect(view.disposed).toBe(true)
    expect(ticks.size).toBe(0)
    expect(statusListeners.size).toBe(0)
  })
})
