// @vitest-environment happy-dom
// A grid that mounts in the frame between a sort being built while no grid drew it and that sort being published: the view
// the published sort names was closed when the new one was built (nothing drew it), so the grid mounts on the results' own
// sort, never on the closed view, and does not swap back to it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { QueryResult } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ResultGrid from '../src/renderer/src/grid/ResultGrid'
import type { ResultView } from '../src/renderer/src/results/ResultClient'
import { deferred } from './fixtures/documents'
import { descriptor, type FakeHandle } from './fixtures/results'
import { connectionInfo, connectionOptions, queryOutput, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  document.body.replaceChildren()
})

const viewOf = (base: FakeHandle, viewId: number) =>
  ({ ...base, viewId, base, keys: [{ column: 0, descending: viewId % 2 === 0, mode: 'value' }], filters: [], rows: 3, baseRows: 3, complete: true, approximate: false, close: vi.fn(async () => {}) }) as unknown as ResultView & { close: ReturnType<typeof vi.fn> }

describe('a results grid mounting just after a sort no grid drew', () => {
  it('mounts on the results\' current view, not the closed one the published sort still names', async () => {
    const f = workbenchFixture()
    mounted.add(f.dispose)
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    const tab = f.documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'server-a')
    const run = deferred<{ ok: true; value: QueryResult }>()
    f.api.execute.mockReturnValueOnce(run.promise)
    const executed = f.queries.execute()
    const queryId = f.queries.getSnapshot()[tab.id].running!.queryId
    const set = descriptor(1, { rowsRead: 3, rowsStored: 3, rowsAvailable: 3, state: 'complete' })
    f.resultClient.emit(queryId, { type: 'resultSet.opened', descriptor: set })
    await act(async () => { run.resolve({ ok: true, value: { ...queryOutput, resultSets: [set] } }); await executed })
    const entry = f.results.getSnapshot()[tab.id].sets[0], handle = f.resultClient.handle(1)!
    // Sorted while no grid drew it, then sorted again: the first view closed when the second was built.
    const first = viewOf(handle, 1), second = viewOf(handle, 2)
    vi.mocked(handle.sort).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await act(async () => { f.results.sortBy(tab.id, entry.key, 0, 'descending') })
    const stale = f.results.sortOf(tab.id, entry.key)!
    expect(stale.view).toBe(first)
    await act(async () => { f.results.sortBy(tab.id, entry.key, 0, 'ascending') })
    expect(f.results.sortOf(tab.id, entry.key)?.view).toBe(second)
    expect(first.close).toHaveBeenCalled()
    // The grid mounts with the sort a frame old: the closed view's.
    const shown = vi.spyOn(f.results, 'viewShown')
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    mounted.add(() => act(() => root.unmount()))
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultGrid, { tabId: tab.id, entry, count: 1, focused: true, sort: stale, onFocus: () => {} }) })))
    await act(async () => { await new Promise(done => setImmediate(done)) })
    expect(shown).toHaveBeenCalledWith(tab.id, entry.key, second)
    expect(shown).not.toHaveBeenCalledWith(tab.id, entry.key, first)
    expect(second.close).not.toHaveBeenCalled()
  })
})
