// @vitest-environment happy-dom
// The toolbar's strip for result operations: its live region reads only what a tab says while it is shown (switching
// query tabs repeats nothing), and a Cancel that goes while it has the focus gives it to the tab's grid, not the page.
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import OperationStrip from '../src/renderer/src/results/OperationStrip'
import { ResultOperations } from '../src/renderer/src/results/operations'
import type { EntryKey } from '../src/renderer/src/results/ResultsService'
import { gridLimits as g } from '../src/renderer/src/grid/constants'
import { manualTimers } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fixture() {
  const timers = manualTimers(), clock = { now: 0 }
  const operations = new ResultOperations({ timers: timers.timers, now: () => clock.now })
  const tick = (ms: number) => act(() => { clock.now += ms; timers.advance(ms) })
  const workbench = { results: { operations } } as unknown as Workbench
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (tabId: string) => act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(OperationStrip, { tabId }) })) })
  const live = () => container.querySelector('[aria-live="polite"]')?.textContent
  return { operations, tick, render, live, container, root }
}

describe('operation strip', () => {
  it('reads out only what the shown tab says after it was shown, so switching tabs repeats nothing', () => {
    const { operations, tick, render, live, root } = fixture()
    const a = operations.begin('a', { kind: 'sort', target: 'Result 1', entry: 'e1' as EntryKey, cancel: () => a.end('cancelled') })
    render('a')
    tick(g.operationShowDelayMs)
    expect(live()).toBe('Sorting Result 1')
    act(() => { operations.cancel('a', a.id) })
    expect(live()).toBe('Sort cancelled. The grid kept its previous order.')
    render('b')
    expect(live()).toBe('')
    // Back on the first tab: its last sentence is from before it was shown again, and stays unread.
    render('a')
    expect(live()).toBe('')
    act(() => root.unmount())
  })

  it('gives the focus to the tab grid when its focused Cancel goes', () => {
    const { operations, tick, render, container, root } = fixture()
    const grid = document.createElement('div')
    grid.tabIndex = 0
    grid.setAttribute('data-result-grid', '')
    grid.setAttribute('data-tab-id', 'a')
    document.body.append(grid)
    const op = operations.begin('a', { kind: 'filter', target: 'Result 1', entry: 'e1' as EntryKey, cancel: () => op.end('cancelled') })
    render('a')
    tick(g.operationShowDelayMs)
    const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel filter, Result 1"]')!
    act(() => { cancel.focus() })
    act(() => { cancel.click() })
    expect(cancel.isConnected).toBe(false)
    expect(document.activeElement).toBe(grid)
    act(() => root.unmount())
    grid.remove()
  })
})
