// @vitest-environment happy-dom
// The results toolbar's Transpose button follows a running transpose: busy, disabled and saying so while it runs, and
// ready again once it answers.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ResultsToolbar from '../src/renderer/src/results/ResultsToolbar'
import { descriptor, summaryOf, type FakeHandle } from './fixtures/results'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  document.body.replaceChildren()
})

describe('results toolbar Transpose', () => {
  it('shows a running transpose on its button, and is ready again once it answers', async () => {
    const f = workbenchFixture()
    const tab = f.documents.create('query.sql', 'SELECT 1', 'master')
    f.results.begin(tab.id, 'q1')
    const source = descriptor(1, { rowsRead: 10, rowsStored: 10, rowsAvailable: 10 })
    f.resultClient.emit('q1', { type: 'resultSet.opened', descriptor: source })
    await f.results.finish(tab.id, 'q1', { summary: summaryOf([source]) })
    const handle = f.results.getSnapshot()[tab.id].sets[0].handle as FakeHandle
    let answer!: (value: Awaited<ReturnType<FakeHandle['transpose']>>) => void
    vi.mocked(handle.transpose).mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    mounted.add(() => act(() => root.unmount()))
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultsToolbar, { tabId: tab.id }) })))
    const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Transpose"]')!
    expect([button().disabled, button().getAttribute('aria-busy'), button().title.startsWith('Transpose:')]).toEqual([false, 'false', true])
    await act(async () => { button().click() })
    expect(handle.transpose).toHaveBeenCalledTimes(1)
    expect([button().disabled, button().getAttribute('aria-busy'), button().title]).toEqual([true, 'true', 'Transposing…'])
    await act(async () => { answer({ descriptor: descriptor(9, { index: 1, kind: 'transpose' }), rows: 10, transposed: 10, columns: 2 }) })
    expect([button().disabled, button().getAttribute('aria-busy'), button().title.startsWith('Transpose:')]).toEqual([false, 'false', true])
  })
})
