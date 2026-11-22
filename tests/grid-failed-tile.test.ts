// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ResultDescriptor } from '../src/shared/contracts'
import { GridView, type GridStatus } from '../src/renderer/src/grid/GridView'
import type { ResultHandle, RowWindow, WindowShape } from '../src/renderer/src/results/ResultClient'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import type { GridViewState } from '../src/renderer/src/results/ResultsService'

// A windowed result's tile whose read failed (here REMOTE_EXPIRED; a stalled tile is marked failed the same way, data.ts
// stalledText) leaves the grid offering Retry: its cells say they are not loaded rather than loading.
const column = (name: string) => ({ name, dataType: 'STRING', wire: 'text' as const, nullable: true })
function mountFailing(code: string, message: string) {
  const rows = 500, columns = 4
  const snapshot = { rowsRead: rows, rowsStored: 0, rowsAvailable: rows, bytesStored: 0, truncatedCells: 0, state: 'complete' as const, incomplete: false, residence: 'remote' as const, revision: 1 }
  const handle = {
    key: { generation: 1, resultId: 1 },
    columns: Array.from({ length: columns }, (_, index) => column('c' + index)),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    getWindow: async () => { await Promise.resolve(); throw new ResultError(code as never, message) },
    peekWindow: (_first: number, _count: number, _s: WindowShape = {}) => undefined as RowWindow | undefined,
    prefetch: vi.fn(),
    measure: vi.fn(async (_first: number, _count: number, colStart: number, colEnd: number) => ({ rows: 1, widths: Uint16Array.from({ length: colEnd - colStart }, () => 6) })),
    rowBytes: vi.fn(async (first: number) => ({ first, bytes: [], rowsAvailable: rows, estimated: [] }))
  } as unknown as ResultHandle
  const descriptor = { generation: 1, resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [...handle.columns], rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'complete', incomplete: false } as unknown as ResultDescriptor
  const root = document.createElement('div'), scroller = document.createElement('div')
  root.append(scroller)
  document.body.append(root)
  for (const [name, value] of [['clientWidth', 900], ['offsetWidth', 900], ['clientHeight', 300]] as const) Object.defineProperty(scroller, name, { value })
  const state: GridViewState = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: true }
  let status: GridStatus = {}
  const view = new GridView({
    root, scroller, handle, client: { windowsInFlight: 0 }, descriptor, state, entry: 'e1', resultNumber: 1, resultCount: 1, platform: 'win32',
    onSelection: () => {}, onFirstCell: () => {}, onCopy: () => {}, onEscape: () => false, onStatus: next => { status = next }, onError: error => { throw error }, onOpenValue: () => {}, onSort: () => {}, onFilter: () => {}
  })
  const frame = async () => { await new Promise(done => setTimeout(done, 0)); view.invalidate(); await new Promise(done => requestAnimationFrame(() => done(undefined))); await new Promise(done => setTimeout(done, 0)) }
  const activeLabel = () => { const id = root.getAttribute('aria-activedescendant'); return id ? root.ownerDocument.getElementById(id)?.getAttribute('aria-label') : undefined }
  const activeClass = () => { const id = root.getAttribute('aria-activedescendant'); return id ? root.ownerDocument.getElementById(id)?.className : undefined }
  return { view, root, frame, activeLabel, activeClass, status: () => status }
}

describe('a failed tile under the active cell', () => {
  it('names the active cell not loaded once its tile read failed and the grid offers Retry', async () => {
    const grid = mountFailing('REMOTE_EXPIRED', 'This windowed result expired in BigQuery. Run the query again to read its rows.')
    await grid.frame()
    await grid.frame()
    // The strip says the rows could not be loaded, with Retry.
    expect(grid.status().tileError).toBe('This windowed result expired in BigQuery. Run the query again to read its rows.')
    // ...and the active cell says it is not loaded, pointing at Retry, rather than that it is loading.
    expect(grid.activeLabel()).toBe('Not loaded, use Retry to read these rows again')
    expect(grid.activeClass()).toContain('is-err')
    grid.view.dispose()
  })
  it('marks an expired windowed result so its strip offers Re-run rather than Retry, and only for REMOTE_EXPIRED', async () => {
    const expired = mountFailing('REMOTE_EXPIRED', 'expired')
    await expired.frame()
    await expired.frame()
    expect(expired.status()).toMatchObject({ tileError: 'expired', expired: true })
    expired.view.dispose()
    const refused = mountFailing('ROOM_REFUSED', 'no room')
    await refused.frame()
    await refused.frame()
    expect(refused.status().tileError).toBe('no room')
    expect(refused.status().expired).toBeUndefined()
    refused.view.dispose()
  })
  it('writes no NULL tooltip on a cell whose tile read failed', async () => {
    const grid = mountFailing('REMOTE_EXPIRED', 'expired')
    await grid.frame()
    await grid.frame()
    expect(grid.status().tileError).toBe('expired')
    const cells = [...grid.root.querySelectorAll('.rg-c.is-load.is-err')] as HTMLElement[]
    expect(cells.length).toBeGreaterThan(1)
    cells[1].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    expect(cells[1].getAttribute('title')).toBeNull()
    grid.view.dispose()
  })
})
