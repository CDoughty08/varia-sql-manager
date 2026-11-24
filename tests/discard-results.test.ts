// @vitest-environment happy-dom
// Discard results after execution's lasting signs: the Results view's notice for a run that kept none of its sets (with the
// step that turns the setting off, then the one that runs the query again), and the status bar item while the setting is on.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { EventBus } from '../src/renderer/src/core/events'
import DiscardStatus from '../src/renderer/src/results/DiscardStatus'
import OutputPane, { DiscardNotice, discardNotice, hasResultsView, outputViewOf } from '../src/renderer/src/results/OutputPane'
import { ResultsService, type TabResults } from '../src/renderer/src/results/ResultsService'
import type { DocumentService } from '../src/renderer/src/services/documents'
import { defaultSettings, type SettingsValues } from '../src/shared/settings/catalog'
import type { VariaApi } from '../src/shared/contracts'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const plan = { name: 'Plan', dataType: 'xml', wire: 'text', nullable: true, role: 'plan' } as const

function service() {
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {})
  }
  const documents = { openText: vi.fn<DocumentService['openText']>() }
  const clock = manualTimers()
  const results = new ResultsService({ client: fakeResultClient(), api, events: new EventBus(), documents, frame: callback => callback(), timers: clock.timers, newId: () => 'job' })
  // The live region's sentence, once its short settle delay has passed.
  const heard = () => { clock.advance(1000); return results.getSnapshot().t1.announcement.replace('​', '') }
  return { results, tab: () => results.getSnapshot().t1, heard }
}

/** A settings service as the components read it: values main holds, and `choose`, which saves one as main would answer. */
function settingsStore(values: Partial<SettingsValues>) {
  const listeners = new Set<() => void>()
  let snapshot = { values: { ...defaultSettings, ...values }, revision: 1, loaded: true }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    choose: vi.fn(async (key: string, value: unknown) => { snapshot = { ...snapshot, values: { ...snapshot.values, [key]: value } }; for (const listener of listeners) listener() })
  }
}

function render(element: ReturnType<typeof createElement>, settings: ReturnType<typeof settingsStore>) {
  const commands = { execute: vi.fn(async () => true) }, documents = { focusActive: vi.fn() }
  const workbench = { settings, commands, documents } as unknown as Workbench
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: element })) })
  const button = (name: string) => [...container.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === name)
  const rerender = (next: ReturnType<typeof createElement>) => root.render(createElement(WorkbenchProvider, { workbench, children: next }))
  return { container, commands, documents, button, rerender, unmount: () => act(() => { root.unmount(); container.remove() }) }
}

describe('discard results after execution', () => {
  it('gives a discarding run a Results view that says its sets were not kept, from its start to its end', () => {
    const { results, tab, heard } = service()
    results.begin('t1', 'q1', undefined, { discard: true })
    expect(tab().discard).toBe(true)
    expect(hasResultsView(tab())).toBe(true)
    expect(discardNotice(tab(), true)).toMatchObject({ title: 'Results are not being kept', action: 'turnOff' })
    void results.finish('t1', 'q1', { summary: summaryOf([], { discardedResultSets: 3 }) })
    // The output moves to Results, which says what happened and offers to turn the setting off.
    expect(outputViewOf(tab())).toBe('results')
    // A screen reader hears why there are none: focus does not move to the notice.
    expect(heard()).toBe('Query executed successfully. 0 result sets, 0 rows. 3 result sets were read and not kept: Discard results after execution is on.')
    expect(discardNotice(tab(), true)).toEqual({ title: 'Results were not kept', action: 'turnOff',
      detail: '3 result sets were read and not kept. Discard results after execution is on, so queries in every tab keep no rows.' })
    // Once the setting is off, the step that follows is executing again.
    expect(discardNotice(tab(), false)).toMatchObject({ action: 'execute', detail: expect.stringContaining('Execute the query again to see its results.') })
  })

  it('keeps a discarding run that kept a plan on its plan, with the Results view and its notice still there', () => {
    const { results, tab } = service()
    results.begin('t1', 'q1', undefined, { discard: true })
    void results.finish('t1', 'q1', { summary: summaryOf([], { discardedResultSets: 1, planSets: [descriptor(7, { index: 0, columns: [plan] })] }) })
    expect(outputViewOf(tab())).toBe('plan')
    expect(hasResultsView(tab())).toBe(true)
    expect(discardNotice(tab(), true)?.title).toBe('Results were not kept')
  })

  it('shows nothing of it for a run made with the setting off, even one whose sets past a limit were not kept', () => {
    const { results, tab, heard } = service()
    results.begin('t1', 'q1')
    void results.finish('t1', 'q1', { summary: summaryOf([], { discardedResultSets: 4 }) })
    expect(tab().discard).toBeUndefined()
    expect(hasResultsView(tab())).toBe(false)
    expect(outputViewOf(tab())).toBe('messages')
    expect(discardNotice(tab(), true)).toBeUndefined()
    expect(heard()).not.toContain('not kept')
    // A discarding run that returned no sets at all has nothing to explain once it ends.
    results.begin('t1', 'q2', undefined, { discard: true })
    void results.finish('t1', 'q2', { summary: summaryOf([]) })
    expect(hasResultsView(tab())).toBe(false)
    expect(discardNotice(tab(), true)).toBeUndefined()
    expect(outputViewOf(tab())).toBe('messages')
    // The next run that keeps rows draws its grids, and the notice is gone.
    results.begin('t1', 'q3')
    void results.finish('t1', 'q3', { summary: summaryOf([descriptor(1)]) })
    expect(tab().sets).toHaveLength(1)
    expect(discardNotice(tab(), false)).toBeUndefined()
  })

  it('turns the setting off from the notice, keeps the keyboard on it, then executes again', async () => {
    const { results, tab } = service()
    results.begin('t1', 'q1', undefined, { discard: true })
    void results.finish('t1', 'q1', { summary: summaryOf([], { discardedResultSets: 2 }) })
    const settings = settingsStore({ 'queryResults.grid.discardResults': true })
    const view = render(createElement(DiscardNotice, { tab: tab() as TabResults }), settings)
    expect(view.container.textContent).toContain('Results were not kept')
    const turnOff = view.button('Turn off Discard results')!
    turnOff.focus()
    await act(async () => { turnOff.click() })
    expect(settings.choose).toHaveBeenCalledWith('queryResults.grid.discardResults', false)
    const again = view.button('Execute again')!
    expect(document.activeElement).toBe(again)
    expect(view.container.textContent).toContain('is now off')
    await act(async () => { again.click() })
    expect(view.commands.execute).toHaveBeenCalledWith('query.execute', undefined, 'toolbar')
    view.unmount()
  })

  it('keeps the keyboard in the notice when the setting is turned off while the run still runs', async () => {
    const { results, tab } = service()
    results.begin('t1', 'q1', undefined, { discard: true })
    const settings = settingsStore({ 'queryResults.grid.discardResults': true })
    const notice = (current: TabResults) => createElement(DiscardNotice, { tab: current })
    const view = render(notice(tab()), settings)
    view.button('Turn off Discard results')!.focus()
    // Turned off from elsewhere (Options, the palette) while the button has focus: a running run offers no step yet.
    await act(async () => { await settings.choose('queryResults.grid.discardResults', false) })
    expect(view.button('Execute again')).toBeUndefined()
    expect(view.container.textContent).toContain('is now off')
    // The run ends: Execute again appears and takes the focus that nothing else took.
    void results.finish('t1', 'q1', { summary: summaryOf([], { discardedResultSets: 1 }) })
    act(() => { view.rerender(notice(tab())) })
    expect(document.activeElement).toBe(view.button('Execute again'))
    view.unmount()
  })

  it('shows the status bar item only while the setting is on, and opens Options on the setting', async () => {
    const settings = settingsStore({ 'queryResults.grid.discardResults': true })
    const view = render(createElement(DiscardStatus), settings)
    const item = view.button('Results discarded')!
    expect(item.getAttribute('aria-description')).toBe('Discard results after execution is on. Opens it in Options.')
    await act(async () => { item.click() })
    expect(view.commands.execute).toHaveBeenCalledWith('preferences.options', { setting: 'queryResults.grid.discardResults' }, 'toolbar')
    await act(async () => { await settings.choose('queryResults.grid.discardResults', false) })
    expect(view.container.textContent).toBe('')
    view.unmount()
  })
  it('says results that were closed were closed, not that they were not kept', () => {
    const { results, tab } = service()
    // The backend keeps a plan-shaped set even while discarding: closing it from its caption empties the run.
    results.begin('t1', 'q1', undefined, { discard: true })
    void results.finish('t1', 'q1', { summary: summaryOf([descriptor(1)], { discardedResultSets: 1 }) })
    expect(results.removeEntry('t1', tab().sets[0].key)).toBe(true)
    expect(tab().emptied).toBe(true)
    expect(hasResultsView(tab())).toBe(true)
    expect(discardNotice(tab(), true)).toBeUndefined()
  })

  it('gives the keyboard to the editor when the status bar item it was on goes, and leaves focus elsewhere alone', async () => {
    const settings = settingsStore({ 'queryResults.grid.discardResults': true })
    const view = render(createElement(DiscardStatus), settings)
    view.button('Results discarded')!.focus()
    await act(async () => { await settings.choose('queryResults.grid.discardResults', false) })
    expect(view.documents.focusActive).toHaveBeenCalledTimes(1)
    await act(async () => { await settings.choose('queryResults.grid.discardResults', true) })
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    elsewhere.focus()
    await act(async () => { await settings.choose('queryResults.grid.discardResults', false) })
    expect(view.documents.focusActive).toHaveBeenCalledTimes(1)
    elsewhere.remove()
    view.unmount()
  })

  it('omits the .output-views tablist box before a query has any output views', () => {
    const store = <T>(value: T) => ({ subscribe: () => () => {}, getSnapshot: () => value })
    const settings = settingsStore({})
    const panes = Object.assign(store({ results: true, messages: false, plan: false, statistics: false }), {
      peers: store({ results: ['results', 'messages'], messages: ['results', 'messages'], plan: ['plan'], statistics: ['statistics'] }),
      select: vi.fn(),
      dock: vi.fn()
    })
    const queries = Object.assign(store({}), { statistics: store({}) })
    const workbench = {
      settings, panes, queries,
      results: Object.assign(store({}), { operations: store({}) }),
      queryPlans: store({}),
      retainedPlans: store({ entries: [] }),
      pivot: store({ tabs: {} }),
      compare: Object.assign(store({ pickers: {}, actionable: {} }), { actionableReason: () => undefined }),
      menus: { openContext: vi.fn(), menuFor: store(null) },
      menuTargets: { register: () => {} },
      commands: { execute: vi.fn(async () => true), canExecute: () => true, subscribe: () => () => {} },
      documents: { focusActive: vi.fn() }
    } as unknown as Workbench
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(OutputPane, { pane: 'results', tabId: 't1', query: true, connected: true }) })) })
    expect(container.querySelector('.output-views')).toBeNull()
    act(() => { root.unmount(); container.remove() })
  })
})
