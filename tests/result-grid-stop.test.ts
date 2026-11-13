// @vitest-environment happy-dom
// A results grid whose result stopped keeping rows (the result budget is full, or the computer is low on memory) while its
// query still runs offers Stop query in its strip: the catalogue's Cancel Executing Query for the grid's tab. The button goes
// when the query ends, and the row limit's strip, the user's own cap, never has one.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { QueryResult } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ResultGrid, { stopsQuery } from '../src/renderer/src/grid/ResultGrid'
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

/** A query tab whose run is still going, with a first result that stopped keeping rows for `truncated`, drawn as a grid. */
async function running(truncated: 'queryBudget' | 'globalBudget' | 'systemMemory' | 'rowLimit') {
  const f = workbenchFixture()
  mounted.add(f.dispose)
  f.connections.add(connectionInfo('server-a'), connectionOptions)
  const tab = f.documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'server-a')
  const run = deferred<{ ok: true; value: QueryResult }>()
  f.api.execute.mockReturnValueOnce(run.promise)
  const executed = f.queries.execute()
  const queryId = f.queries.getSnapshot()[tab.id].running!.queryId
  const set = descriptor(1, { rowsRead: 900, rowsStored: 500, rowsAvailable: 500, state: 'open', truncated })
  f.resultClient.emit(queryId, { type: 'resultSet.opened', descriptor: set })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  mounted.add(() => act(() => root.unmount()))
  const entry = () => f.results.getSnapshot()[tab.id].sets[0]
  await act(async () => root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultGrid, { tabId: tab.id, entry: entry(), count: 1, focused: true, onFocus: () => {} }) })))
  const stop = () => container.querySelector<HTMLButtonElement>('.rg-strip button')
  const strip = () => container.querySelector('.rg-strip')
  /** Ends the run as the backend would after a cancel (an incomplete result) or the last row. */
  const finish = async (incomplete = true) => { await act(async () => { run.resolve({ ok: true, value: { ...queryOutput, resultSets: [{ ...set, state: 'complete', incomplete }] } }); await executed }) }
  return { ...f, tab, queryId, stop, strip, finish }
}

describe('the results strip\'s Stop query', () => {
  it('shows while the query runs, names itself, and cancels this tab\'s query through Cancel Executing Query', async () => {
    const { api, commands, queryId, stop, strip, finish } = await running('queryBudget')
    expect(strip()?.textContent).toContain('the result memory budget')
    const button = stop()!
    expect(button).not.toBeNull()
    expect([button.textContent, button.type, button.title]).toEqual(['Stop query', 'button', expect.stringContaining('Cancel Executing Query')])
    // Reached by Tab: a button is in the tab order unless told otherwise.
    expect(button.tabIndex).toBe(0)
    const ran: string[] = []
    const off = commands.onDidExecute(event => ran.push(event.id))
    await act(async () => { button.click() })
    off.dispose()
    expect(ran).toEqual(['query.cancel'])
    expect(api.cancel).toHaveBeenCalledWith(queryId)
    // A cancel acknowledgement is not completion: the button stays until the run ends, then goes with the query.
    expect(stop()).not.toBeNull()
    await finish()
    expect(stop()).toBeNull()
  })

  it('cancels the grid\'s own tab when another tab is active', async () => {
    const { api, documents, queryId, stop } = await running('globalBudget')
    act(() => { documents.create('SQLQuery2.sql', 'SELECT 2', 'master') })
    await act(async () => { stop()!.click() })
    expect(api.cancel).toHaveBeenCalledWith(queryId)
  })

  it('does not come back on a finished result while an estimated plan runs in its tab', async () => {
    const { api, queries, tab, stop, strip, finish } = await running('queryBudget')
    await finish(false)
    // The run read every row: its strip still says what the budget left out, with nothing to stop.
    expect(strip()?.textContent).toContain('the result memory budget')
    expect(stop()).toBeNull()
    // The estimate keeps the tab running but begins no results: the finished run's grid stays drawn.
    const plan = deferred<Awaited<ReturnType<typeof api.estimatePlan>>>()
    api.estimatePlan.mockReturnValueOnce(plan.promise)
    let estimating: Promise<void> | undefined
    act(() => { estimating = queries.estimate(tab.id) })
    expect(queries.getSnapshot()[tab.id].running?.kind).toBe('estimate')
    expect(stop()).toBeNull()
    await act(async () => { plan.resolve({ ok: true, value: { plans: [], database: 'master' } }); await estimating })
  })

  it('shows for low memory but not for the row limit', async () => {
    expect((await running('systemMemory')).stop()).not.toBeNull()
    const limited = await running('rowLimit')
    expect(limited.strip()?.textContent).toContain('the limit on rows kept per execution')
    expect(limited.stop()).toBeNull()
    expect([stopsQuery('queryBudget'), stopsQuery('globalBudget'), stopsQuery('systemMemory'), stopsQuery('rowLimit'), stopsQuery(undefined)]).toEqual([true, true, true, false, false])
  })
})
