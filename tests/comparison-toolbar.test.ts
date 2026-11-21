// @vitest-environment happy-dom
// A comparison's toolbar: its sides link to the inputs and ⇄ swaps them, Layout and Exact text change the comparison in
// place, each control that runs it again is unavailable with the reason while an input is closed (D10), and a polite live
// region reads what each new or changed comparison found, the same sentence twice included.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ComparisonToolbar from '../src/renderer/src/results/ComparisonToolbar'
import { CompareService, compareSources, fallbackText, type CompareInfo } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const drawn = new Set<() => void>()
afterEach(() => { for (const unmount of drawn) unmount(); drawn.clear() })

async function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results, { jobs: new DerivedJobs({ timers: timers.timers }) })
  results.begin('t1', 'q1')
  const values = [0, 1, 2].map(index => descriptor(index + 1, { index }))
  for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
  void results.finish('t1', 'q1', { summary: summaryOf(values) })
  const keys = results.getSnapshot().t1.sets.map(set => set.key)
  await act(async () => { await compare.comparePair('t1', keys[0], keys[1], { exact: false }) })
  const replace = vi.spyOn(compare, 'replace').mockResolvedValue(undefined)
  const goTo = vi.fn()
  const workbench = { results, compare } as unknown as Workbench
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const slot = () => results.getSnapshot().t1.comparisons[0]
  const draw = (info?: Partial<CompareInfo>) => act(() => {
    const tab = results.getSnapshot().t1, shown = compare.getSnapshot().info.get(setKey(slot().entry.descriptor))!
    root.render(createElement(StrictMode, null, createElement(WorkbenchProvider, { workbench, children: createElement(ComparisonToolbar, { tabId: 't1', entry: slot().entry, info: { ...shown, ...info }, sources: compareSources(tab, slot().sources), goTo }) })))
  })
  draw()
  const toolbar = () => container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Comparison tools"]')!
  const button = (name: string) => [...toolbar().querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === name)
  const unmount = () => { if (!drawn.delete(unmount)) return; act(() => { root.unmount(); container.remove() }) }
  drawn.add(unmount)
  return { results, compare, keys, replace, goTo, draw, toolbar, button, slot, container }
}

describe('a comparison\'s toolbar', () => {
  it('links its sides, swaps them, and changes the layout and Exact text in place', async () => {
    const view = await fixture()
    expect(view.toolbar().textContent).toContain('Differences')
    expect(view.toolbar().querySelector('[aria-label="Sides"]')?.textContent).toBe('− Result 1+ Result 2')
    act(() => { view.button('− Result 1')!.click() })
    expect(view.goTo).toHaveBeenCalledWith(view.keys[0])
    act(() => { view.button('Swap sides')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { swap: true })
    // One row per entry is pressed (the setting's default; the fake backend answers two rows, so it is drawn so); Two rows switches it.
    view.draw({ layout: 'entry' })
    expect(view.button('One row')!.getAttribute('aria-pressed')).toBe('true')
    expect(view.button('Two rows')!.getAttribute('aria-pressed')).toBe('false')
    act(() => { view.button('One row')!.click() })
    expect(view.replace).toHaveBeenCalledTimes(1)
    act(() => { view.button('Two rows')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { layout: 'unified' })
    expect(view.button('Exact text')!.getAttribute('aria-pressed')).toBe('false')
    act(() => { view.button('Exact text')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { exact: true })
    // The first side is the toolbar's one Tab stop; arrows move between its buttons.
    expect([...view.toolbar().querySelectorAll('button')].filter(item => item.tabIndex === 0)).toEqual([view.button('− Result 1')])
    view.button('− Result 1')!.focus()
    act(() => { view.button('− Result 1')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(view.button('Swap sides'))
  })

  it('makes every control that runs the comparison again unavailable while an input is closed, saying which (D10)', async () => {
    const view = await fixture()
    act(() => { view.results.removeEntry('t1', view.keys[0]) })
    view.draw()
    expect(view.toolbar().querySelector('[aria-label="Sides"]')?.textContent).toContain('Result 1 (closed)')
    for (const name of ['Swap sides', 'One row', 'Two rows', 'Exact text']) {
      const control = view.button(name)!
      expect(control.getAttribute('aria-disabled'), name).toBe('true')
      expect(control.title, name).toMatch(/unavailable because Result 1 is closed$/)
      act(() => { control.click() })
    }
    expect(view.replace).not.toHaveBeenCalled()
    // The open side still links to its input.
    act(() => { view.button('+ Result 2')!.click() })
    expect(view.goTo).toHaveBeenCalledWith(view.keys[1])
  })

  it('offers no one-row layout past the pairs it can show, saying why (D12)', async () => {
    const view = await fixture()
    view.draw({ layout: 'unified', fallback: true })
    expect(view.button('Two rows')!.getAttribute('aria-pressed')).toBe('true')
    expect(view.button('One row')!.getAttribute('aria-disabled')).toBe('true')
    expect(view.button('One row')!.title).toBe(fallbackText)
    act(() => { view.button('One row')!.click() })
    expect(view.replace).not.toHaveBeenCalled()
  })

  it('reads each announcement in its live region, the same sentence again too', async () => {
    const view = await fixture()
    const region = () => view.toolbar().querySelector('[role="status"]')!
    expect(region().getAttribute('aria-live')).toBe('polite')
    const first = region().textContent
    expect(first?.trim()).toBe('Comparison ready: matched by Id, 1 changed, 1 added, 0 removed.')
    // Cancel twice: the same sentence, said each time (the region's text changes).
    view.replace.mockRestore()
    vi.mocked(view.results.getSnapshot().t1.sets[0].handle.diff).mockImplementation((_right, o) => new Promise((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    const said: string[] = []
    for (let i = 0; i < 2; i++) {
      let change!: Promise<unknown>
      act(() => { change = view.compare.replace('t1', view.slot().key, { layout: 'unified' }) })
      await act(async () => { view.compare.cancelChange('t1', view.slot().key); await change })
      said.push(region().textContent ?? '')
    }
    expect(said.map(text => text.trim())).toEqual(['The change was cancelled.', 'The change was cancelled.'])
    expect(said[0]).not.toBe(said[1])
  })
})
