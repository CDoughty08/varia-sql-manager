// @vitest-environment happy-dom
// A rebuilt Pivot (Update, Build Pivot, or one following its Table's filters) keeps its entry key but brings a new result,
// and the layouts key a grid by its result, so the grid the user was in is replaced in one commit. The new grid takes the
// focus the old one held, or the grid's keys would fall to the page; a grid that did not hold it takes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { QueryResult } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ResultGrid from '../src/renderer/src/grid/ResultGrid'
import type { ResultSetEntry } from '../src/renderer/src/results/ResultsService'
import { deferred } from './fixtures/documents'
import { descriptor } from './fixtures/results'
import { connectionInfo, connectionOptions, queryOutput, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  document.body.replaceChildren()
})

/** A finished run's first result drawn as a grid keyed by its result, as both layouts key theirs, beside a button. */
async function drawn() {
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
  const container = document.body.appendChild(document.createElement('div'))
  const other = document.body.appendChild(document.createElement('button'))
  const root = createRoot(container)
  mounted.add(() => act(() => root.unmount()))
  const first = f.results.getSnapshot()[tab.id].sets[0]
  const draw = async (entry: ResultSetEntry) => {
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultGrid, { key: entry.descriptor.resultId, tabId: tab.id, entry, count: 1, focused: true, onFocus: () => {} }) })))
  }
  await draw(first)
  /** The same entry with a new result, as a rebuilt Pivot is published in its slot. */
  const rebuilt = (resultId: number): ResultSetEntry => ({ ...first, descriptor: { ...first.descriptor, resultId } })
  const grid = () => container.querySelector<HTMLElement>('[data-result-grid]')!
  return { draw, rebuilt, grid, other }
}

describe('a grid replaced in its slot', () => {
  it('takes the focus the grid it replaced held', async () => {
    const { draw, rebuilt, grid } = await drawn()
    const old = grid()
    act(() => { old.focus() })
    expect(document.activeElement).toBe(old)
    await draw(rebuilt(2))
    expect(grid()).not.toBe(old)
    expect(grid().dataset.resultId).toBe('2')
    expect(document.activeElement).toBe(grid())
  })

  it('takes nothing when the focus was elsewhere', async () => {
    const { draw, rebuilt, grid, other } = await drawn()
    act(() => { other.focus() })
    await draw(rebuilt(2))
    expect(grid().dataset.resultId).toBe('2')
    expect(document.activeElement).toBe(other)
  })
})
