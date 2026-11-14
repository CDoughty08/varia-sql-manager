// @vitest-environment happy-dom
// The Compare picker panel: while its comparison runs the Compare button stays focusable (aria-disabled, not disabled) and
// ignores presses, a failure and a cancel are said in the status region that is always in the accessibility tree, and
// the keyboard focus is left where it was.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ComparePanel from '../src/renderer/src/results/ComparePanel'
import { CompareService } from '../src/renderer/src/results/CompareService'
import { DerivedWork } from '../src/renderer/src/results/derived-work'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type DiffAnswer = Awaited<ReturnType<FakeHandle['diff']>>

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results, { work: new DerivedWork({ timers: timers.timers }) })
  results.begin('t1', 'q1')
  const values = [0, 1].map(index => descriptor(index + 1, { index }))
  for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
  void results.finish('t1', 'q1', { summary: summaryOf(values) })
  const keys = results.getSnapshot().t1.sets.map(set => set.key)
  const handle = (key: string) => results.getSnapshot().t1.sets.find(set => set.key === key)!.handle as FakeHandle
  compare.open('t1', keys[1])
  const workbench = { results, compare } as unknown as Workbench
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const draw = () => act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ComparePanel, { tabId: 't1', tab: results.getSnapshot().t1 }) })) })
  draw()
  const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name)
  const status = () => container.querySelector('[role="status"]')
  return { compare, keys, handle, container, draw, button, status, unmount: () => act(() => { root.unmount(); container.remove() }) }
}

describe('Compare panel', () => {
  it('keeps the focus on Compare while its comparison runs, ignores presses then, and says a failure where the focus is', async () => {
    const view = fixture()
    let fail!: (error: unknown) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>((_yes, no) => { fail = no }))
    const compareButton = view.button('Compare')!
    compareButton.focus()
    await act(async () => { compareButton.click() })
    view.draw()
    expect(compareButton.disabled).toBe(false)
    expect(compareButton.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(compareButton)
    // A second press while it runs is ignored by the button itself.
    const run = vi.spyOn(view.compare, 'run')
    await act(async () => { compareButton.click() })
    expect(run).not.toHaveBeenCalled()
    expect(view.handle(view.keys[0]).diff).toHaveBeenCalledTimes(1)
    // The status region is in the tree (never hidden) before it has anything to say.
    expect(view.status()?.hasAttribute('hidden')).toBe(false)
    await act(async () => { fail(new ResultError('TOO_LARGE', 'There is not enough result memory to compare these results.')) })
    view.draw()
    expect(view.status()?.textContent).toBe('There is not enough result memory to compare these results.')
    expect(compareButton.hasAttribute('aria-disabled')).toBe(false)
    expect(document.activeElement).toBe(compareButton)
    view.unmount()
  })

  it('says a cancel in the status region', async () => {
    const view = fixture()
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce((_right, o) => new Promise<DiffAnswer>((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    await act(async () => { view.button('Compare')!.click() })
    view.draw()
    await act(async () => { view.button('Cancel')!.click() })
    view.draw()
    expect(view.status()?.textContent).toBe('Comparison cancelled.')
    expect(view.button('Close')).toBeDefined()
    expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
    view.unmount()
  })
})
