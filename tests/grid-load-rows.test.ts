// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import { GridView } from '../src/renderer/src/grid/GridView'
import type { ResultHandle, ResultSnapshot, RowWindow, WindowShape } from '../src/renderer/src/results/ResultClient'
import type { GridViewState } from '../src/renderer/src/results/ResultsService'

// A windowed result loading into memory starts its counters again (ResultClient.update): the grid keeps drawing the rows
// it showed, so it neither empties nor jumps back to the top, and reads only the rows loaded so far.
const column = (name: string) => ({ name, dataType: 'STRING', wire: 'text' as const, nullable: true })
function mount() {
  const rows = 5000, columns = 3
  let snapshot: ResultSnapshot = { rowsRead: rows, rowsStored: 0, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false, residence: 'remote', revision: 1 }
  const listeners = new Set<() => void>()
  const reads: number[] = []
  const handle = {
    key: { generation: 1, resultId: 1 },
    columns: Array.from({ length: columns }, (_, index) => column('c' + index)),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getWindow: vi.fn(async (first: number) => { reads.push(first); await new Promise(() => {}) }),
    peekWindow: (_first: number, _count: number, _s: WindowShape = {}) => undefined as RowWindow | undefined,
    prefetch: vi.fn(),
    measure: vi.fn(async (_first: number, _count: number, colStart: number, colEnd: number) => ({ rows: 1, widths: Uint16Array.from({ length: colEnd - colStart }, () => 6) })),
    rowBytes: vi.fn(async (first: number) => ({ first, bytes: [], rowsAvailable: snapshot.rowsAvailable, estimated: [] }))
  } as unknown as ResultHandle
  const descriptor = { generation: 1, resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [...handle.columns], rowsRead: rows, rowsStored: 0, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false } as unknown as ResultDescriptor
  const root = document.createElement('div'), scroller = document.createElement('div')
  root.append(scroller)
  document.body.append(root)
  for (const [name, value] of [['clientWidth', 900], ['offsetWidth', 900], ['clientHeight', 300]] as const) Object.defineProperty(scroller, name, { value })
  const state: GridViewState = { topRow: 4000, virtualTop: 4000 * 20, scrollLeft: 0, sized: true }
  const view = new GridView({
    root, scroller, handle, client: { windowsInFlight: 0 }, descriptor, state, entry: 'e1', resultNumber: 1, resultCount: 1, platform: 'win32',
    onSelection: () => {}, onFirstCell: () => {}, onCopy: () => {}, onEscape: () => false, onStatus: () => {}, onError: error => { throw error }, onOpenValue: () => {}, onSort: () => {}, onFilter: () => {}
  })
  const frame = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
  const change = (next: Partial<ResultSnapshot>) => { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener() }
  return { view, root, state, frame, change, reads }
}

describe('a windowed result loading into memory', () => {
  it('keeps its rows and scroll position, and reads only the rows loaded so far', async () => {
    const grid = mount()
    await grid.frame()
    await grid.frame()
    expect(grid.state.topRow).toBe(4000)
    expect(grid.root.getAttribute('aria-rowcount')).toBe('5001')
    grid.reads.splice(0)
    grid.change({ residence: 'memory', revision: 2, rowsRead: 0, rowsAvailable: 0, state: 'open', rowsExpected: 5000 })
    await grid.frame()
    await grid.frame()
    expect(grid.state.topRow).toBe(4000)
    expect(grid.root.getAttribute('aria-rowcount')).toBe('5001')
    // None of the rows in view has loaded: none is read.
    expect(grid.reads).toEqual([])
    grid.view.dispose()
  })
})
