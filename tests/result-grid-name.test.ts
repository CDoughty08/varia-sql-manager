// @vitest-environment happy-dom
// A results grid's name (docs/result-comparison-ux-plan.md D8): an original result's grid is "Result N of M", and a
// comparison's or a Pivot's is its own name, never the number Varia gave it ("Result 3 of 4"). The real ResultGrid is
// mounted; GridView records the options it is built with, which name the grid's accessible label.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { QueryResult } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { GridViewOptions } from '../src/renderer/src/grid/GridView'
import ResultGrid from '../src/renderer/src/grid/ResultGrid'
import { deferred } from './fixtures/documents'
import { descriptor } from './fixtures/results'
import { connectionInfo, connectionOptions, queryOutput, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const built = vi.hoisted(() => [] as GridViewOptions[])
vi.mock('../src/renderer/src/grid/GridView', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/grid/GridView')>()
  class RecordedGridView extends actual.GridView {
    constructor(o: GridViewOptions) { super(o); built.push(o) }
  }
  return { ...actual, GridView: RecordedGridView }
})

const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  built.length = 0
  document.body.replaceChildren()
})

describe('a results grid\'s name', () => {
  it('is a comparison\'s or a Pivot\'s own name, and an original result\'s number', async () => {
    const f = workbenchFixture()
    mounted.add(f.dispose)
    f.connections.add(connectionInfo('server-a'), connectionOptions)
    const tab = f.documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'server-a')
    const run = deferred<{ ok: true; value: QueryResult }>()
    f.api.execute.mockReturnValueOnce(run.promise)
    const executed = f.queries.execute()
    const queryId = f.queries.getSnapshot()[tab.id].running!.queryId
    const rows = { rowsRead: 3, rowsStored: 3, rowsAvailable: 3, state: 'complete' as const }
    const sets = [descriptor(1, { index: 0, ...rows }), descriptor(2, { index: 1, ...rows })]
    for (const set of sets) f.resultClient.emit(queryId, { type: 'resultSet.opened', descriptor: set })
    await act(async () => { run.resolve({ ok: true, value: { ...queryOutput, resultSets: sets } }); await executed })
    const diff = f.results.addSet(tab.id, descriptor(901, { index: 0, kind: 'diff', ...rows }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])!
    const pivot = f.results.addSet(tab.id, descriptor(902, { index: 1, kind: 'pivot', ...rows }), 'Pivot of Result 2', ['1:2'])!
    const all = f.results.getSnapshot()[tab.id].sets
    const spec = async (key: string) => {
      const entry = all.find(set => set.key === key)!
      const container = document.body.appendChild(document.createElement('div'))
      const root = createRoot(container)
      mounted.add(() => act(() => root.unmount()))
      await act(async () => root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultGrid, { tabId: tab.id, entry, count: all.length, focused: false, onFocus: () => {} }) })))
      const options = built.find(o => o.entry === key)!
      return { label: options.label, number: options.resultNumber, attribute: container.querySelector('[data-result-grid]')?.getAttribute('data-result-number') }
    }
    // An original result has no label of its own: GridView names it "Result 1 of 4".
    expect(await spec(all[0].key)).toEqual({ label: undefined, number: 1, attribute: null })
    // A comparison and a Pivot are named for themselves; their numbers stay only as an attribute the smoke fixtures find.
    const compared = all.find(set => set.key === diff)!, made = all.find(set => set.key === pivot)!
    expect(await spec(diff)).toEqual({ label: 'Differences: Result 1 → Result 2', number: compared.number, attribute: String(compared.number) })
    expect(await spec(pivot)).toEqual({ label: 'Pivot of Result 2', number: made.number, attribute: String(made.number) })
  })
})
