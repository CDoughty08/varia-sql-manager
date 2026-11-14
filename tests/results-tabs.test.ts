// @vitest-environment happy-dom
// Results as tabs (queryResults.grid.layout): a row of result and comparison tabs, the selected result's view tabs, and one
// mounted grid. The selection is the service's focused entry, so it follows a group into its last view, survives a
// stream, follows Find Next and moves on after a close. The grid itself is stubbed: this is the layout's part.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ResultGridProps } from '../src/renderer/src/grid/ResultGrid'
import { gridLimits as g } from '../src/renderer/src/grid/constants'
import { scrollbarSize } from '../src/renderer/src/grid/ResultsStack'
import ResultsTabs, { groupView, revealLeft, selectedEntry, tabsNeed, tabWindow, topItems } from '../src/renderer/src/grid/ResultsTabs'
import { minGridHeight } from '../src/renderer/src/grid/stack'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import type { TabSearch } from '../src/renderer/src/results/search'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The grid's stand-in: which entry it shows, and a number of its own, so a grid built again or kept shows. Each one
// mounted is counted until it unmounts, so a grid that is not shown and still mounted shows too.
const mountedGrids = new Set<string>()
vi.mock('../src/renderer/src/grid/ResultGrid', async () => {
  const { createElement, useEffect, useRef } = await import('react')
  let made = 0
  return {
    default: (props: ResultGridProps) => {
      const instance = useRef(0)
      if (instance.current === 0) instance.current = ++made
      useEffect(() => { mountedGrids.add(props.entry.key); return () => { mountedGrids.delete(props.entry.key) } }, [props.entry.key])
      return createElement('div', {
        'data-grid': props.entry.key, 'data-result-grid': '', 'data-instance': instance.current, 'data-focused': String(props.focused), 'data-view': props.view, 'data-group': props.group,
        tabIndex: 0, onClick: () => props.onFocus(props.entry.key)
      })
    }
  }
})

let root: Root | undefined, container: HTMLElement | undefined
beforeEach(() => { mountedGrids.clear() })
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
})

const rows = { rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }
/** Results 1 to 3, a Pivot of Result 3 and a comparison of Results 1 and 2. */
function fixture() {
  const client = fakeResultClient(), events = new EventBus()
  const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
  const results = new ResultsService({ client, api, events, frame: callback => callback() })
  results.begin('t1', 'q1')
  void results.finish('t1', 'q1', { summary: summaryOf([descriptor(1, rows), descriptor(2, { index: 1, ...rows }), descriptor(3, { index: 2, ...rows })]) })
  const pivot = results.addSet('t1', descriptor(803, { index: 2, kind: 'pivot', ...rows }), 'Pivot of Result 3', ['1:3'])!
  const diff = results.addSet('t1', descriptor(901, { index: 0, kind: 'diff', ...rows }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])!
  const [one, two, three] = results.getSnapshot().t1.sets.map(set => set.key)
  const listeners = new Set<() => void>()
  let search: Record<string, Partial<TabSearch>> = {}
  let revealed = 0
  const resultsSearch = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => search,
    pendingReveal: (_tabId: string, key: string) => search.t1?.revealEntry === key && revealed !== search.t1?.reveal
  }
  const reveal = (key: string) => act(() => { search = { t1: { reveal: (search.t1?.reveal ?? 0) + 1, revealEntry: key, marks: new Map() } }; for (const listener of [...listeners]) listener() })
  const commands = { execute: vi.fn(async () => true) }
  const workbench = { results, resultsSearch, commands } as unknown as Workbench
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const host = container
  const draw = () => act(() => {
    root!.render(createElement(WorkbenchProvider, { workbench, children: createElement('div', { className: 'output-panel' }, createElement('button', { role: 'tab', 'data-output-tab': 'results' }), createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 })) }))
  })
  const all = <T extends Element = HTMLElement>(selector: string) => [...host.querySelectorAll<T>(selector)]
  const resultTabs = () => all<HTMLButtonElement>('[data-tab-row="result"] [role="tab"]')
  const viewTabs = () => all<HTMLButtonElement>('[data-tab-row="view"] [role="tab"]')
  const names = (tabs: HTMLElement[]) => tabs.map(tab => tab.textContent)
  const chosen = (tabs: HTMLElement[]) => tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent
  const grids = () => all('[data-grid]').map(element => element.dataset.grid)
  const closer = (name: string) => host.querySelector<HTMLButtonElement>(`[aria-label="Close ${name}"]`)!
  return { results, client, one, two, three, pivot, diff, draw, reveal, resultTabs, viewTabs, names, chosen, grids, closer, all, markRevealed: () => { revealed = search.t1?.reveal ?? 0 } }
}

describe('results as tabs', () => {
  it('list the groups and comparisons, select the focused view, and fall back to the first', () => {
    const { results, one, three, pivot, diff } = fixture()
    const tab = results.getSnapshot().t1
    expect(topItems(tab).map(item => [item.key, item.name])).toEqual([[one, 'Result 1'], [tab.groups[1].table.key, 'Result 2'], [three, 'Result 3'], [diff, 'Differences: Result 1 → Result 2']])
    expect(selectedEntry(tab)?.key).toBe(one)
    expect(groupView(tab.groups[2])).toBe(three)
    results.focusEntry('t1', pivot)
    expect(groupView(results.getSnapshot().t1.groups[2])).toBe(pivot)
    expect(selectedEntry(results.getSnapshot().t1)?.key).toBe(pivot)
  })

  it('scroll the strip as little as shows the selected tab whole', () => {
    expect(revealLeft(0, 300, 100, 80)).toBe(0)
    expect(revealLeft(0, 300, 400, 80)).toBe(180)
    expect(revealLeft(250, 300, 100, 80)).toBe(100)
    expect(revealLeft(250, 300, 300, 80)).toBe(250)
    expect(revealLeft(0, 50, 100, 80)).toBe(100)
  })

  it('keep the selected tab in view when more tabs are drawn than the strip fits', () => {
    const { results, three, draw, all } = fixture()
    draw()
    const strip = all('.rt-strip')[0]
    let left = 0
    Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => 150 })
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => 400 })
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => left, set: value => { left = value } })
    all('.rt-tab').forEach((tab, place) => {
      Object.defineProperty(tab, 'offsetLeft', { configurable: true, get: () => place * 100 })
      Object.defineProperty(tab, 'offsetWidth', { configurable: true, get: () => 100 })
    })
    act(() => { results.focusEntry('t1', three) })
    draw()
    expect(left).toBe(150)
    expect(strip.parentElement!.hasAttribute('data-clip-start')).toBe(true)
    expect(strip.parentElement!.hasAttribute('data-clip-end')).toBe(true)
    act(() => { results.focusEntry('t1', results.getSnapshot().t1.sets[0].key) })
    draw()
    expect(left).toBe(0)
    expect(strip.parentElement!.hasAttribute('data-clip-start')).toBe(false)
    // The wheel scrolls the strip sideways.
    act(() => { strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })) })
    expect(left).toBe(120)
  })

  it('draw a bounded window of result tabs around the selected one', () => {
    expect(tabWindow(3, 2, 64)).toEqual([0, 2])
    expect(tabWindow(1000, 0, 64)).toEqual([0, 63])
    expect(tabWindow(1000, 500, 64)).toEqual([468, 531])
    expect(tabWindow(1000, 999, 64)).toEqual([936, 999])
  })

  it('need the two tab rows and the selected grid at its floor, or at its rows when it needs less, for the Messages strip', () => {
    const { results, one } = fixture()
    const tab = results.getSnapshot().t1, floor = minGridHeight(scrollbarSize())
    expect(tabsNeed(tab)).toBe(g.resultTabsHeight + g.viewTabsHeight + floor)
    const settled = new Map(tab.settled)
    settled.set(`${tab.sets[0].descriptor.generation}:${tab.sets[0].descriptor.resultId}`, { rows: 1, strip: false })
    const small = tabsNeed({ ...tab, settled })
    expect(small).toBeLessThan(g.resultTabsHeight + g.viewTabsHeight + floor)
    expect(small).toBeGreaterThan(g.resultTabsHeight + g.viewTabsHeight)
    expect(tabsNeed({ ...tab, sets: [], focused: undefined })).toBe(0)
    expect(one).toBeDefined()
  })

  it('mount only the selected grid, keep each group\'s view and switch without building the others again', () => {
    const { results, one, three, pivot, diff, draw, resultTabs, viewTabs, names, chosen, grids, all } = fixture()
    draw()
    expect(names(resultTabs())).toEqual(['Result 1', 'Result 2', 'Result 3', 'Differences: Result 1 → Result 2'])
    expect(chosen(resultTabs())).toBe('Result 1')
    expect(names(viewTabs())).toEqual(['Table'])
    expect(grids()).toEqual([one])
    expect([...mountedGrids]).toEqual([one])
    // Drawn again with the same selection, the grid is the same one, not built again.
    const built = all('[data-grid]')[0].dataset.instance
    draw()
    expect(all('[data-grid]')[0].dataset.instance).toBe(built)
    expect(all('[data-grid]')[0].dataset.focused).toBe('true')
    // The tab panel is named by the view tab that shows it.
    const panel = all('[role="tabpanel"]')[0]
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe('Table')
    // Result 3: its Table first, then its Pivot from the view tabs; the grid shown is the only one mounted.
    act(() => { resultTabs()[2].click() })
    draw()
    expect(results.getSnapshot().t1.focused).toBe(three)
    expect(names(viewTabs())).toEqual(['Table', 'Pivot'])
    act(() => { viewTabs()[1].click() })
    draw()
    expect(grids()).toEqual([pivot])
    expect([...mountedGrids]).toEqual([pivot])
    expect(all('[data-grid]')[0].dataset.view).toBe('pivot')
    // Another group and back: Result 3's tab returns to the Pivot it showed.
    act(() => { resultTabs()[0].click() })
    draw()
    expect(grids()).toEqual([one])
    act(() => { resultTabs()[2].click() })
    draw()
    expect(chosen(viewTabs())).toBe('Pivot')
    expect(grids()).toEqual([pivot])
    // A comparison has no view tabs: a label says what it is.
    act(() => { resultTabs()[3].click() })
    draw()
    expect(viewTabs()).toHaveLength(0)
    expect(all('.rt-view-label')[0].textContent).toBe('Comparison')
    expect(grids()).toEqual([diff])
    expect(all('[data-grid]')[0].dataset.view).toBe('comparison')
    // Clicking into the grid that is shown changes nothing.
    act(() => { all('[data-grid]')[0].click() })
    expect(results.getSnapshot().t1.focused).toBe(diff)
  })

  it('show a Pivot built for the selected result at once, and leave the Pivot of another result behind its tab', () => {
    const { results, one, draw, grids, viewTabs, chosen } = fixture()
    draw()
    const built = results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])!
    draw()
    // The layout selects it through the service, which publishes: the pane draws again.
    expect(results.getSnapshot().t1.focused).toBe(built)
    draw()
    expect(chosen(viewTabs())).toBe('Pivot')
    expect(grids()).toEqual([built])
    results.addSet('t1', descriptor(802, { index: 1, kind: 'pivot', ...rows }), 'Pivot of Result 2', ['1:2'])
    draw()
    expect(grids()).toEqual([built])
    // Closing the Pivot selects nothing new beyond its Table.
    results.removeEntry('t1', built)
    draw()
    expect(grids()).toEqual([one])
  })

  it('move along the tabs with the arrow keys, Home and End, selecting as they go', () => {
    const { results, one, three, diff, draw, resultTabs, viewTabs } = fixture()
    draw()
    const press = (target: HTMLElement, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    resultTabs()[0].focus()
    press(resultTabs()[0], 'ArrowLeft')
    draw()
    expect(results.getSnapshot().t1.focused).toBe(diff)
    expect(document.activeElement?.textContent).toBe('Differences: Result 1 → Result 2')
    press(resultTabs()[3], 'Home')
    draw()
    expect(results.getSnapshot().t1.focused).toBe(one)
    press(resultTabs()[0], 'End')
    draw()
    press(resultTabs()[3], 'ArrowLeft')
    draw()
    expect(results.getSnapshot().t1.focused).toBe(three)
    // Only the selected tab of each row is a Tab stop.
    expect(resultTabs().map(tab => tab.tabIndex)).toEqual([-1, -1, 0, -1])
    press(viewTabs()[0], 'ArrowRight')
    draw()
    expect(document.activeElement?.textContent).toBe('Pivot')
    expect(viewTabs().map(tab => tab.tabIndex)).toEqual([-1, 0])
  })

  it('hand the focus to the grid shown instead when the grid that had it goes, as F3 onto another view does', () => {
    const { results, two, draw, reveal, grids, all } = fixture()
    draw()
    all('[data-grid]')[0].focus()
    expect(document.activeElement).toBe(all('[data-grid]')[0])
    reveal(two)
    draw()
    expect(grids()).toEqual([two])
    expect((document.activeElement as HTMLElement).dataset.grid).toBe(two)
    // From a tab, the focus stays on the tab.
    const tabButton = all<HTMLButtonElement>('[data-tab-row="result"] [role="tab"]')[0]
    tabButton.focus()
    act(() => { tabButton.click() })
    draw()
    expect(document.activeElement).toBe(tabButton)
    expect(results.getSnapshot().t1.focused).not.toBe(two)
  })

  it('return a neighbour to the view it showed last when the selected result closes', () => {
    const { results, three, pivot, draw, viewTabs, chosen, resultTabs, closer } = fixture()
    draw()
    // Result 3 last showed its Pivot; closing Result 2 from its selected tab goes to that Pivot.
    results.focusEntry('t1', pivot)
    results.focusEntry('t1', results.getSnapshot().t1.groups[1].table.key)
    draw()
    closer('Result 2').focus()
    act(() => { closer('Result 2').click() })
    draw()
    expect(chosen(resultTabs())).toBe('Result 3')
    expect(chosen(viewTabs())).toBe('Pivot')
    expect(three).toBeDefined()
  })

  it('select the view that holds the match Find Next goes to, once', () => {
    const { results, two, pivot, draw, reveal, grids, markRevealed, resultTabs } = fixture()
    draw()
    reveal(pivot)
    draw()
    expect(results.getSnapshot().t1.focused).toBe(pivot)
    expect(grids()).toEqual([pivot])
    // The grid revealed it; picking another tab afterwards is not undone by the same reveal.
    markRevealed()
    act(() => { resultTabs()[1].click() })
    draw()
    expect(grids()).toEqual([two])
  })

  it('keep the first result selected while a run streams, and a tab the user picks', () => {
    const { results, client, draw, chosen, resultTabs } = fixture()
    results.begin('t1', 'q2')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(11, { index: 0, state: 'open' }) })
    draw()
    expect(chosen(resultTabs())).toBe('Result 1')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(12, { index: 1, state: 'open' }) })
    draw()
    expect(chosen(resultTabs())).toBe('Result 1')
    act(() => { resultTabs()[1].click() })
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(13, { index: 2, state: 'open' }) })
    draw()
    expect(chosen(resultTabs())).toBe('Result 2')
    // Closing is unavailable while the query runs.
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Result 2"]')!
    expect(close.disabled).toBe(true)
    expect(close.title).toBe('Close Result 2 (unavailable while the query runs)')
  })

  it('close a view from its tab, moving the selection and the focus to the next tab, else the previous, then the Results tab', () => {
    const { results, client, two, three, pivot, diff, draw, resultTabs, viewTabs, names, chosen, grids, closer } = fixture()
    draw()
    // A group's tab says what goes with it.
    expect(closer('Result 3').title).toBe('Close Result 3 and its Pivot')
    // Closing the Pivot that shows selects its Table, and the focus goes to the Table's view tab.
    act(() => { resultTabs()[2].click() })
    draw()
    act(() => { viewTabs()[1].click() })
    draw()
    closer('Pivot of Result 3').focus()
    act(() => { closer('Pivot of Result 3').click() })
    draw()
    expect(names(viewTabs())).toEqual(['Table'])
    expect(grids()).toEqual([three])
    expect(document.activeElement).toBe(viewTabs()[0])
    expect(client.released()).toEqual([803])
    // Closing the selected group selects the next item and focuses its tab.
    closer('Result 3').focus()
    act(() => { closer('Result 3').click() })
    draw()
    expect(names(resultTabs())).toEqual(['Result 1', 'Result 2', 'Differences: Result 1 → Result 2'])
    expect(chosen(resultTabs())).toBe('Differences: Result 1 → Result 2')
    expect(document.activeElement).toBe(resultTabs()[2])
    expect(grids()).toEqual([diff])
    // A close of a tab not selected, from elsewhere, leaves the selection and the focus where they were.
    const kept = resultTabs()[2]
    kept.focus()
    act(() => { closer('Result 1').click() })
    draw()
    expect(chosen(resultTabs())).toBe('Differences: Result 1 → Result 2')
    expect(document.activeElement?.textContent).toBe('Differences: Result 1 → Result 2')
    // The last tab's close moves to the one before.
    closer('Differences: Result 1 → Result 2').focus()
    act(() => { closer('Differences: Result 1 → Result 2').click() })
    draw()
    expect(chosen(resultTabs())).toBe('Result 2')
    expect(results.getSnapshot().t1.focused).toBe(two)
    expect(document.activeElement).toBe(resultTabs()[0])
    expect(pivot).toBeDefined()
    // The last result closed: the run is emptied and the focus is on the Results tab.
    closer('Result 2').focus()
    act(() => { closer('Result 2').click() })
    expect(results.getSnapshot().t1).toMatchObject({ sets: [], emptied: true })
    expect((document.activeElement as HTMLElement).dataset.outputTab).toBe('results')
  })

  it('draw at most a window of result tabs in a run of many', () => {
    const client = fakeResultClient(), events = new EventBus()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const results = new ResultsService({ client, api, events, frame: callback => callback() }), none = {}
    results.begin('t1', 'q1')
    void results.finish('t1', 'q1', { summary: summaryOf(Array.from({ length: 200 }, (_, index) => descriptor(index + 1, { index, ...rows }))) })
    const workbench = { results, resultsSearch: { subscribe: () => () => {}, getSnapshot: () => none, pendingReveal: () => false }, commands: { execute: vi.fn() } } as unknown as Workbench
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 }) })) })
    expect(container.querySelectorAll('[data-tab-row="result"] [role="tab"]')).toHaveLength(g.resultTabsDrawn)
    expect(container.querySelector('.rt-more')?.textContent).toBe(`+${200 - g.resultTabsDrawn}`)
    // End and Home reach the last and the first result, outside the window drawn, and the tab reached takes the focus.
    const press = (key: string) => act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    const redraw = () => act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 }) })) })
    container.querySelector<HTMLElement>('[data-tab-row="result"] [role="tab"][aria-selected="true"]')!.focus()
    press('End')
    redraw()
    expect(document.activeElement?.textContent).toBe('Result 200')
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('200')
    expect(document.activeElement?.getAttribute('aria-setsize')).toBe('200')
    press('ArrowRight')
    redraw()
    expect(document.activeElement?.textContent).toBe('Result 1')
  })
})

describe('the results layout toggle', () => {
  it('switch between Stacked and Tabs through the setting, and check Show Results as Tabs while Tabs is on', async () => {
    const fixture = workbenchFixture()
    try {
      const { commands, api, context, settings } = fixture
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('stacked')
      expect(commands.isToggled('output.toggleResultsTabs')).toBe(false)
      await commands.execute('output.toggleResultsTabs', undefined, 'toolbar')
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('tabs')
      expect(context.getState().resultsTabs).toBe(true)
      expect(commands.isToggled('output.toggleResultsTabs')).toBe(true)
      await commands.execute('output.toggleResultsTabs', undefined, 'palette')
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('stacked')
      expect(api.updateSettings.mock.calls).toEqual([[{ 'queryResults.grid.layout': 'tabs' }], [{ 'queryResults.grid.layout': 'stacked' }]])
      // Two quick presses, the second before the first is saved, cancel out.
      await Promise.all([commands.execute('output.toggleResultsTabs', undefined, 'toolbar'), commands.execute('output.toggleResultsTabs', undefined, 'toolbar')])
      expect(api.updateSettings.mock.calls.slice(2)).toEqual([[{ 'queryResults.grid.layout': 'tabs' }], [{ 'queryResults.grid.layout': 'stacked' }]])
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('stacked')
    } finally { fixture.dispose() }
  })
})
