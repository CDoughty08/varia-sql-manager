// @vitest-environment happy-dom
// Results as tabs (queryResults.grid.layout): a row of result and comparison tabs, the selected result's view tabs, and one
// mounted grid. The selection is the service's focused entry, so it follows a group into its last view, survives a
// stream, follows Find Next and moves on after a close. The grid itself is stubbed: this is the layout's part.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { gesturesFor } from '../src/renderer/src/core/gestures'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ResultGridProps } from '../src/renderer/src/grid/ResultGrid'
import { gridLimits as g } from '../src/renderer/src/grid/constants'
import { scrollbarSize } from '../src/renderer/src/grid/ResultsStack'
import ResultsTabs, { groupView, revealLeft, selectedEntry, tabsFold, tabsNeed, tabWindow, topItems } from '../src/renderer/src/grid/ResultsTabs'
import { filterRows, jumpResult, pickerRequests, pickerRows, pickerScroll, pickerSummary, pickerWindow, stackReveals, stepResult, stepView } from '../src/renderer/src/grid/result-picker'
import { pickerRowHeight, pickerRowsShown } from '../src/renderer/src/grid/ResultsPicker'
import { minGridHeight } from '../src/renderer/src/grid/stack'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import type { TabSearch } from '../src/renderer/src/results/search'
import { PivotService } from '../src/renderer/src/results/PivotService'
import { formatCount } from '../src/renderer/src/results/status'
import { windows } from '../src/renderer/src/core/windows'
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
  const workbench = { results, resultsSearch, commands, gestures: gesturesFor('win32'), pivot: new PivotService(results) } as unknown as Workbench
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
    // Result 3 (200 to 300) shows whole and clear of the 16 px fade at the edge that still hides the comparison's tab.
    expect(left).toBe(166)
    expect(strip.parentElement!.hasAttribute('data-clip-start')).toBe(true)
    expect(strip.parentElement!.hasAttribute('data-clip-end')).toBe(true)
    act(() => { results.focusEntry('t1', results.getSnapshot().t1.sets[0].key) })
    draw()
    expect(left).toBe(0)
    expect(strip.parentElement!.hasAttribute('data-clip-start')).toBe(false)
    // The wheel scrolls the strip sideways.
    act(() => { strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })) })
    expect(left).toBe(120)
    // Drawn again with the same selection (OutputPane draws often), the strip stays where the user scrolled it.
    draw()
    expect(left).toBe(120)
    // A wheel that scrolls by pages moves a strip's width; by lines, a fade's width a line.
    act(() => { strip.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 2, bubbles: true })) })
    expect(left).toBe(-30)
    left = 0
    act(() => { strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true })) })
    expect(left).toBe(48)
    // Control+wheel zooms the window, so the strip stays. (happy-dom's WheelEvent drops ctrlKey from its init.)
    const zoom = new WheelEvent('wheel', { deltaY: 120, bubbles: true })
    Object.defineProperty(zoom, 'ctrlKey', { value: true })
    act(() => { strip.dispatchEvent(zoom) })
    expect(left).toBe(48)
  })

  it('select a comparison made while the layout is drawn, but not one there at mount', () => {
    const { results, diff, draw, chosen, resultTabs } = fixture()
    draw()
    expect(chosen(resultTabs())).toBe('Result 1')
    expect(diff).toBeDefined()
    const rows = { rowsRead: 10, rowsStored: 10, rowsAvailable: 10 }
    const made = results.addSet('t1', descriptor(902, { index: 0, kind: 'diff', ...rows }), 'Differences: Result 2 → Result 3', ['1:2', '1:3'])!
    draw()
    draw()
    expect(results.getSnapshot().t1.focused).toBe(made)
    expect(chosen(resultTabs())).toBe('Differences: Result 2 → Result 3')
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
    const { results, one, draw, grids, viewTabs, chosen, all } = fixture()
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
    // One that arrives while the user works in a grid (they went back to it during the build) leaves them there.
    all('[data-grid]')[0].focus()
    const later = results.addSet('t1', descriptor(804, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])!
    draw()
    draw()
    expect(grids()).toEqual([one])
    expect((document.activeElement as HTMLElement).dataset.grid).toBe(one)
    expect(later).toBeDefined()
  })

  it('show a rebuilt Pivot, which keeps its key, at once, and draw its grid again over the new result', () => {
    const { results, three, pivot, draw, grids, viewTabs, chosen, all } = fixture()
    results.focusEntry('t1', three)
    draw()
    expect(grids()).toEqual([three])
    // Built again from its Table: the new result takes the old one's slot and key.
    expect(results.addSet('t1', descriptor(805, { index: 2, kind: 'pivot', ...rows }), 'Pivot of Result 3', ['1:3'])).toBe(pivot)
    draw()
    expect(results.getSnapshot().t1.focused).toBe(pivot)
    draw()
    expect(chosen(viewTabs())).toBe('Pivot')
    expect(grids()).toEqual([pivot])
    const first = all('[data-grid]')[0].dataset.instance
    // Built again while it is shown: the same tab, a grid over the new result.
    expect(results.addSet('t1', descriptor(806, { index: 2, kind: 'pivot', ...rows }), 'Pivot of Result 3', ['1:3'])).toBe(pivot)
    draw()
    draw()
    expect(grids()).toEqual([pivot])
    expect(all('[data-grid]')[0].dataset.instance).not.toBe(first)
  })

  it('show a Pivot built from the builder after the focus went from a grid through the Results tab and out', () => {
    const { results, one, draw, grids, all } = fixture()
    draw()
    all('[data-grid]')[0].focus()
    document.querySelector<HTMLElement>('[data-output-tab="results"]')!.focus()
    const builder = document.createElement('button')
    document.body.append(builder)
    builder.focus()
    const built = results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])!
    draw()
    draw()
    expect(grids()).toEqual([built])
    expect(one).toBeDefined()
    builder.remove()
  })

  it('show a Pivot built while a comparison is selected: the builder worked on a result it can pivot', () => {
    const { results, diff, draw, grids, chosen, resultTabs } = fixture()
    results.focusEntry('t1', diff)
    draw()
    expect(grids()).toEqual([diff])
    const built = results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])!
    draw()
    draw()
    expect(grids()).toEqual([built])
    expect(chosen(resultTabs())).toBe('Result 1')
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
    // Close Just This Result from a grid: the command focuses the Results tab (the next grid is not drawn yet) and closes
    // the view; the grid drawn instead takes the focus back.
    act(() => { all<HTMLElement>('[data-grid]')[0].click() })
    draw()
    const shown = all('[data-grid]')[0]
    shown.focus()
    const closing = shown.dataset.grid!
    act(() => { document.querySelector<HTMLElement>('[data-output-tab="results"]')!.focus() })
    act(() => { results.removeEntry('t1', closing) })
    draw()
    expect(grids()).not.toContain(closing)
    expect((document.activeElement as HTMLElement).dataset.grid).toBe(grids()[0])
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

  it("dot an out-of-date Pivot's view tab, and show its mark with Update on the view row while it is shown", () => {
    const { results, one, pivot, draw, viewTabs, all } = fixture()
    // Result 1's Pivot was built over a filter its Table no longer shows; Result 3's has no provenance, so never a mark.
    results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'], {
      pivot: { recipe: { rows: [0], values: [{ aggregate: 'count' }] }, filters: [{ op: 'keepRows', rows: [1] }], inputRows: 1, truncated: false, incomplete: false, approximate: false }
    })
    const update = () => all<HTMLButtonElement>('button[aria-label="Update Pivot of Result 1"]')
    // Result 1's Table shown: its Pivot's view tab has the dot and says so; the row has no Update (the Pivot is not shown).
    results.focusEntry('t1', one)
    draw()
    const pivotTab = () => viewTabs().find(tab => tab.getAttribute('aria-label') === 'Pivot of Result 1')!
    expect(pivotTab().querySelector('.rt-dot')).not.toBeNull()
    expect(pivotTab().getAttribute('aria-description')).toBe('Out of date')
    expect(update()).toEqual([])
    // The Pivot shown: the view row shows the chip and Update, as a Stacked caption does.
    act(() => { pivotTab().click() })
    draw()
    expect(all('.rt-views .rs-caption-stale').map(element => element.textContent)).toEqual(['Out of date'])
    expect(update()).toHaveLength(1)
    expect(update()[0].disabled).toBe(false)
    expect(all('.rt-facts')).toHaveLength(1)
    // Back to the Table: the mark goes, and the row keeps one set of facts (the mark never shares the facts' key).
    act(() => { viewTabs().find(tab => tab.getAttribute('aria-label') === 'Table')!.click() })
    draw()
    expect(update()).toEqual([])
    expect(all('.rt-facts')).toHaveLength(1)
    // Another result's Pivot, with nothing recorded: no dot, no mark.
    results.focusEntry('t1', pivot)
    draw()
    expect(viewTabs().find(tab => tab.getAttribute('aria-label') === 'Pivot of Result 3')!.querySelector('.rt-dot')).toBeNull()
    expect(all('.rt-views .rs-caption-stale')).toEqual([])
  })

  it('draw at most a window of result tabs in a run of many', () => {
    const client = fakeResultClient(), events = new EventBus()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const results = new ResultsService({ client, api, events, frame: callback => callback() }), none = {}
    results.begin('t1', 'q1')
    void results.finish('t1', 'q1', { summary: summaryOf(Array.from({ length: 200 }, (_, index) => descriptor(index + 1, { index, ...rows }))) })
    const workbench = { results, resultsSearch: { subscribe: () => () => {}, getSnapshot: () => none, pendingReveal: () => false }, commands: { execute: vi.fn() }, pivot: new PivotService(results) } as unknown as Workbench
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 }) })) })
    expect(container.querySelectorAll('[data-tab-row="result"] [role="tab"]')).toHaveLength(g.resultTabsDrawn)
    // The overflow button counts the results without a tab in view (happy-dom lays nothing out, so those not drawn).
    expect(container.querySelector('.rt-overflow')?.textContent).toBe(`+${200 - g.resultTabsDrawn}`)
    expect(container.querySelector('.rt-more')).toBeNull()
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
    // A command that moves the drawn window (Previous Result from Result 1 wraps to the last) takes the focus along.
    act(() => { results.focusEntry('t1', results.getSnapshot().t1.sets[199].key) })
    redraw()
    expect(document.activeElement?.textContent).toBe('Result 200')
  })
})

describe('the results layout toggle', () => {
  it('switch between Stacked and Tabs through the setting, and check Show Results as Tabs while Tabs is on', async () => {
    const fixture = workbenchFixture()
    try {
      const { commands, api, context, settings } = fixture
      // Tabs is the default (PR 14).
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('tabs')
      expect(context.getState().resultsTabs).toBe(true)
      expect(commands.isToggled('output.toggleResultsTabs')).toBe(true)
      await commands.execute('output.toggleResultsTabs', undefined, 'toolbar')
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('stacked')
      expect(context.getState().resultsTabs).toBe(false)
      expect(commands.isToggled('output.toggleResultsTabs')).toBe(false)
      await commands.execute('output.toggleResultsTabs', undefined, 'palette')
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('tabs')
      expect(api.updateSettings.mock.calls).toEqual([[{ 'queryResults.grid.layout': 'stacked' }], [{ 'queryResults.grid.layout': 'tabs' }]])
      // Two quick presses, the second before the first is saved, cancel out.
      await Promise.all([commands.execute('output.toggleResultsTabs', undefined, 'toolbar'), commands.execute('output.toggleResultsTabs', undefined, 'toolbar')])
      expect(api.updateSettings.mock.calls.slice(2)).toEqual([[{ 'queryResults.grid.layout': 'stacked' }], [{ 'queryResults.grid.layout': 'tabs' }]])
      expect(settings.getSnapshot().values['queryResults.grid.layout']).toBe('tabs')
    } finally { fixture.dispose() }
  })
})

describe('the Tabs layout in a short pane', () => {
  it('keep both rows of tabs while the grid has room for its header and two rows, then one row, then none', () => {
    const need = g.headerHeight + 2 * g.rowHeight + 10 + g.stackBorder
    expect(tabsFold(0, 10)).toBeUndefined()
    expect(tabsFold(g.resultTabsHeight + g.viewTabsHeight + need, 10)).toBeUndefined()
    expect(tabsFold(g.resultTabsHeight + g.viewTabsHeight + need - 1, 10)).toBe('one')
    expect(tabsFold(g.resultTabsHeight + need, 10)).toBe('one')
    expect(tabsFold(g.resultTabsHeight + need - 1, 10)).toBe('none')
    // The results pane at its 100 px minimum, under its toolbar: the grid alone.
    expect(tabsFold(64, 10)).toBe('none')
  })

  it('fold when first drawn, and in the shortest pane give the grid the focus from the picker, picked or closed', () => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('rt-root') ? 64 : 0 } })
    try {
      const { results, two, draw, all } = fixture()
      draw()
      // Folded already when first drawn (measured at mount, in a layout effect, so no frame shows both rows).
      expect(all('.rt-root')[0].getAttribute('data-fold')).toBe('none')
      const picker = () => document.querySelector<HTMLElement>('.rt-picker')
      const input = () => document.querySelector<HTMLInputElement>('.rt-picker input')!
      const press = (key: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
      // Opened from the shown grid; Enter on another result: its grid, drawn in the old one's place, takes the focus.
      act(() => { all('[data-grid]')[0].focus() })
      act(() => { pickerRequests.request('t1') })
      press('ArrowDown')
      press('Enter')
      draw()
      expect(picker()).toBeNull()
      expect(results.getSnapshot().t1.focused).toBe(two)
      expect((document.activeElement as HTMLElement).dataset.grid).toBe(two)
      // Enter on the view shown: its grid takes the focus at once.
      act(() => { pickerRequests.request('t1') })
      press('Enter')
      expect((document.activeElement as HTMLElement).dataset.grid).toBe(two)
      // Asked for again while open, Escape still gives the focus back to where it was first opened from.
      const editor = document.createElement('textarea')
      document.body.append(editor)
      editor.focus()
      act(() => { pickerRequests.request('t1') })
      act(() => { pickerRequests.request('t1') })
      press('Escape')
      expect(document.activeElement).toBe(editor)
      // Escape with nowhere to go back to: the grid, not a hidden tab.
      act(() => { pickerRequests.request('t1') })
      editor.remove()
      press('Escape')
      expect((document.activeElement as HTMLElement).dataset.grid).toBe(two)
      // Or where it was opened from cannot take the focus back (hidden by the fold, here disabled): the grid too.
      const button = document.createElement('button')
      document.body.append(button)
      button.focus()
      act(() => { pickerRequests.request('t1') })
      button.disabled = true
      press('Escape')
      expect((document.activeElement as HTMLElement).dataset.grid).toBe(two)
      button.remove()
      // A press on the picker outside its filter box (its footer, say) leaves the focus in the box, so its keys still work.
      act(() => { pickerRequests.request('t1') })
      const down = (target: Element) => { const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); act(() => { target.dispatchEvent(event) }); return event.defaultPrevented }
      expect(down(document.querySelector('.rt-picker-foot')!)).toBe(true)
      expect(down(input())).toBe(false)
      // Its filter box's context menu (Paste) takes the focus and a press without closing it.
      const menu = document.createElement('div')
      menu.className = 'menu-layer'
      menu.innerHTML = '<div role="menu" tabindex="-1"></div>'
      document.body.append(menu)
      act(() => { menu.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
      act(() => { menu.querySelector<HTMLElement>('[role="menu"]')!.focus() })
      expect(picker()).not.toBeNull()
      menu.remove()
      act(() => { input().focus() })
      press('Escape')
      expect(picker()).toBeNull()
    } finally {
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
  })
})

describe('moving through the results as tabs', () => {
  it('count a query as steppable (multipleResults) from its second result or comparison, never its Pivot', () => {
    const client = fakeResultClient(), events = new EventBus()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const results = new ResultsService({ client, api, events, frame: callback => callback() })
    results.begin('t1', 'q1')
    void results.finish('t1', 'q1', { summary: summaryOf([descriptor(1, rows), descriptor(2, { index: 1, ...rows })]) })
    expect(results.steppable.getSnapshot().t1).toBe(true)
    results.begin('t2', 'q2')
    void results.finish('t2', 'q2', { summary: summaryOf([descriptor(3, rows)]) })
    results.addSet('t2', descriptor(804, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])
    expect(results.steppable.getSnapshot().t2).toBeUndefined()
  })

  it('step through the results and comparisons, and through a result\'s views, wrapping round', () => {
    const { results, one, two, three, pivot, diff } = fixture()
    const tab = () => results.getSnapshot().t1
    expect(stepResult(tab(), 1)).toBe(two)
    expect(stepResult(tab(), -1)).toBe(diff)
    // A result with one view has no other to step to, nor has a comparison.
    expect(stepView(tab(), 1)).toBeUndefined()
    results.focusEntry('t1', three)
    expect(stepView(tab(), 1)).toBe(pivot)
    expect(stepView(tab(), -1)).toBe(pivot)
    results.focusEntry('t1', pivot)
    expect(stepView(tab(), 1)).toBe(three)
    expect(stepResult(tab(), 1)).toBe(diff)
    results.focusEntry('t1', diff)
    expect(stepView(tab(), 1)).toBeUndefined()
    // A result's tab returns to the view it showed last: Result 3's Pivot.
    expect(stepResult(tab(), -1)).toBe(pivot)
    expect(stepResult(tab(), 1)).toBe(one)
     // Go to Result N picks the item at that place, a group's view being the one it showed last; the last is the last item.
    expect(jumpResult(tab(), 1)).toBe(one)
    expect(jumpResult(tab(), 3)).toBe(pivot)
    expect(jumpResult(tab(), 4)).toBe(diff)
    expect(jumpResult(tab(), 5)).toBeUndefined()
    expect(jumpResult(tab(), 'last')).toBe(diff)
  })

  it('list every view for the picker, filter it by words and draw only a window of its rows', () => {
    const { results } = fixture()
    const rows = pickerRows(results.getSnapshot().t1)
    expect(rows.map(row => row.label)).toEqual(['Result 1, Table', 'Result 2, Table', 'Result 3, Table', 'Pivot of Result 3', 'Differences: Result 1 → Result 2, Comparison'])
    expect(rows.map(row => [row.name, row.detail])).toEqual([['Result 1', 'Table'], ['Result 2', 'Table'], ['Result 3', 'Table'], ['Pivot', ''], ['Differences: Result 1 → Result 2', 'Comparison']])
    expect(filterRows(rows, ' 3  PIV ').map(row => row.label)).toEqual(['Pivot of Result 3'])
    expect(filterRows(rows, 'result 2').map(row => row.label)).toEqual(['Result 2, Table', 'Differences: Result 1 → Result 2, Comparison'])
    expect(filterRows(rows, '')).toBe(rows)
    expect(pickerSummary(rows, rows.length)).toBe('5 views: 3 results, 1 Pivot, 1 comparison')
    expect(pickerSummary(rows, 1)).toBe('1 of 5 views: 3 results, 1 Pivot, 1 comparison')
    // The rows in view and two either side, never more.
    expect(pickerWindow(0, 220, 1000, 22)).toEqual([0, 12])
    expect(pickerWindow(500 * 22, 220, 1000, 22)).toEqual([498, 512])
    expect(pickerWindow(0, 220, 3, 22)).toEqual([0, 3])
    expect(pickerWindow(0, 220, 0, 22)).toEqual([0, 0])
    // The active row is scrolled into view, moving as little as it can.
    expect(pickerScroll(0, 220, 3, 22)).toBe(0)
    expect(pickerScroll(0, 220, 15, 22)).toBe(15 * 22 + 22 - 220)
    expect(pickerScroll(500, 220, 2, 22)).toBe(44)
  })

  it('open the overflow picker over 1,000 results, draw a screenful of its rows, and go to the one picked', () => {
    const client = fakeResultClient(), events = new EventBus()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const results = new ResultsService({ client, api, events, frame: callback => callback() }), none = {}
    results.begin('t1', 'q1')
    void results.finish('t1', 'q1', { summary: summaryOf(Array.from({ length: 1000 }, (_, index) => descriptor(index + 1, { index, ...rows }))) })
    const workbench = { results, resultsSearch: { subscribe: () => () => {}, getSnapshot: () => none, pendingReveal: () => false }, commands: { execute: vi.fn() }, gestures: gesturesFor('win32'), pivot: new PivotService(results) } as unknown as Workbench
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const draw = () => act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsTabs, { tabId: 't1', tab: results.getSnapshot().t1 }) })) })
    draw()
    const button = () => container!.querySelector<HTMLButtonElement>('.rt-overflow')
    const picker = () => document.querySelector<HTMLElement>('.rt-picker')
    const options = () => [...document.querySelectorAll<HTMLElement>('.rt-picker [role="option"]')]
    const input = () => picker()!.querySelector<HTMLInputElement>('input')!
    const press = (key: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    const type = (text: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button()!.textContent).toBe(`+${formatCount(1000 - g.resultTabsDrawn)}`)
    expect(button()!.getAttribute('aria-expanded')).toBe('false')
    expect(picker()).toBeNull()
    act(() => { button()!.click() })
    expect(button()!.getAttribute('aria-expanded')).toBe('true')
    // Drawn in the window's body, with the focus in its filter box; a screenful of the 1,000 rows, the first selected.
    expect(picker()!.parentElement).toBe(document.body)
    expect(document.activeElement).toBe(input())
    expect(options().length).toBeGreaterThan(0)
    expect(options().length).toBeLessThanOrEqual(pickerRowsShown + 4)
    expect(options()[0].getAttribute('aria-label')).toBe('Result 1, Table')
    // The active row is the selected option; the view shown is the current one.
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    expect(options()[0].getAttribute('aria-current')).toBe('true')
    expect(options()[0].getAttribute('aria-setsize')).toBe('1000')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id)
    expect((picker()!.querySelector('.rt-picker-space') as HTMLElement).style.height).toBe(`${1000 * pickerRowHeight}px`)
    expect(picker()!.querySelector('.rt-picker-foot')!.textContent).toBe('1,000 views: 1,000 results')
    // Scrolled halfway, it draws the rows there instead, as few.
    const list = picker()!.querySelector<HTMLElement>('[role="listbox"]')!
    act(() => { list.scrollTop = 500 * pickerRowHeight; list.dispatchEvent(new Event('scroll')) })
    expect(options().map(option => option.getAttribute('aria-label'))).toContain('Result 501, Table')
    expect(options().length).toBeLessThanOrEqual(pickerRowsShown + 4)
    // The keys move the active row; Page Down a page at a time.
    // A wheel scrolled the active row out of the drawn rows: no active descendant names a row that is not there.
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    press('ArrowDown')
    expect(document.getElementById(input().getAttribute('aria-activedescendant')!)?.getAttribute('aria-label')).toBe('Result 2, Table')
    expect(options().find(option => option.getAttribute('aria-label') === 'Result 2, Table')?.getAttribute('aria-selected')).toBe('true')
    expect(options().find(option => option.getAttribute('aria-label') === 'Result 2, Table')?.hasAttribute('aria-current')).toBe(false)
    press('PageDown')
    expect(document.getElementById(input().getAttribute('aria-activedescendant')!)?.getAttribute('aria-label')).toBe(`Result ${2 + pickerRowsShown - 1}, Table`)
    // A filter keeps the rows that match; Enter shows the active one and puts the focus on its tab, drawn once the window moves.
    type('result 999')
    expect(options().map(option => option.getAttribute('aria-label'))).toEqual(['Result 999, Table'])
    expect(picker()!.querySelector('.rt-picker-foot')!.textContent).toBe('1 of 1,000 views: 1,000 results')
    type('nothing like it')
    expect(options()).toEqual([])
    expect(picker()!.querySelector('.rt-picker-none')!.textContent).toBe('Nothing matches.')
    type('999')
    press('Enter')
    draw()
    expect(picker()).toBeNull()
    expect(selectedEntry(results.getSnapshot().t1)?.number).toBe(999)
    expect(document.activeElement?.textContent).toBe('Result 999')
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    // Escape closes it and gives the focus back to the overflow button.
    act(() => { button()!.click() })
    expect(options().find(option => option.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label')).toBe('Result 999, Table')
    press('Escape')
    expect(picker()).toBeNull()
    expect(document.activeElement).toBe(button())
    // A press outside closes it, leaving the focus where the press put it.
    act(() => { button()!.click() })
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(picker()).toBeNull()
    // Go to Result… asks for it, from the editor say; Escape gives the focus back there.
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()
    act(() => { pickerRequests.request('t1') })
    expect(picker()).not.toBeNull()
    expect(pickerRequests.take('t1')).toBe(false)
    press('Escape')
    expect(document.activeElement).toBe(editor)
    editor.remove()
    act(() => { pickerRequests.request('t1') })
    // It opens at the selected result again; a click on a row shows it.
    expect(options().find(option => option.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label')).toBe('Result 999, Table')
    act(() => { options().find(option => option.getAttribute('aria-label') === 'Result 997, Table')!.click() })
    expect(selectedEntry(results.getSnapshot().t1)?.number).toBe(997)
    expect(picker()).toBeNull()
    // A request no layout takes in time lapses.
    pickerRequests.request('t9', 0)
    expect(pickerRequests.take('t9', 2001)).toBe(false)
    pickerRequests.request('t9', 0)
    expect(pickerRequests.take('t9', 1000)).toBe(true)
  })

  it('give the focus back, on Escape, to where Go to Result… ran in another window (the pane popped out)', () => {
    const { draw } = fixture()
    draw()
    const other = document.implementation.createHTMLDocument('main')
    const editor = other.createElement('textarea')
    other.body.append(editor)
    const focus = vi.spyOn(editor, 'focus')
    const active = vi.spyOn(windows, 'activeElement').mockReturnValue(editor)
    try {
      act(() => { pickerRequests.request('t1') })
      active.mockReturnValue(document.querySelector('.rt-picker input'))
      act(() => { document.querySelector('.rt-picker input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(document.querySelector('.rt-picker')).toBeNull()
      expect(focus).toHaveBeenCalled()
    } finally { active.mockRestore() }
  })

  it('close the picker when its anchor goes (its pane hidden), giving the focus back to where it was opened from', () => {
    const observers: (() => void)[] = []
    const original = window.ResizeObserver
    window.ResizeObserver = class { constructor(callback: () => void) { observers.push(callback) } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
    try {
      const { draw } = fixture()
      draw()
      const editor = document.createElement('textarea')
      document.body.append(editor)
      editor.focus()
      act(() => { pickerRequests.request('t1') })
      expect(document.activeElement?.closest('.rt-picker')).not.toBeNull()
      // Ctrl+R hides the pane: the anchor has no size left (jsdom gives every element none), so the picker closes.
      act(() => { for (const callback of [...observers]) callback() })
      expect(document.querySelector('.rt-picker')).toBeNull()
      expect(document.activeElement).toBe(editor)
      editor.remove()
    } finally { window.ResizeObserver = original }
  })

  it('keep the picker\'s active row while the run changes under it, and start again at the view shown on a new filter', () => {
    const { results, two, draw } = fixture()
    draw()
    act(() => { pickerRequests.request('t1') })
    const input = () => document.querySelector<HTMLInputElement>('.rt-picker input')!
    const active = () => document.getElementById(input().getAttribute('aria-activedescendant')!)?.getAttribute('aria-label')
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(active()).toBe('Result 3, Table')
    // Result 2 closes: Result 3's row moves up and stays active.
    act(() => { results.removeEntry('t1', two) })
    draw()
    expect(active()).toBe('Result 3, Table')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'result')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(active()).toBe('Result 1, Table')
  })

  it('move the focus with the selection a command moves while a tab has it', () => {
    const { results, two, three, pivot, draw, resultTabs, viewTabs } = fixture()
    draw()
    resultTabs()[0].focus()
    act(() => { results.focusEntry('t1', two) })
    draw()
    expect(document.activeElement).toBe(resultTabs()[1])
    act(() => { results.focusEntry('t1', three) })
    draw()
    viewTabs()[0].focus()
    act(() => { results.focusEntry('t1', pivot) })
    draw()
    expect(document.activeElement).toBe(viewTabs()[1])
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    // From a view tab to another result: its view tabs replace the old ones, and the focus goes to its selected view tab.
    act(() => { results.focusEntry('t1', results.getSnapshot().t1.sets[0].key) })
    draw()
    expect(document.activeElement).toBe(viewTabs()[0])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Table')
    // To a comparison, which has no view tabs: the focus goes to its tab in the result row.
    act(() => { results.focusEntry('t1', results.getSnapshot().t1.comparisons[0].key) })
    draw()
    expect(document.activeElement?.textContent).toBe('Differences: Result 1 → Result 2')
  })
})

describe('the results tabs commands', () => {
  async function ran() {
    const f = workbenchFixture()
    const tab = f.documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
    const sets = [descriptor(1, rows), descriptor(2, { index: 1, ...rows })]
    f.results.begin(tab.id, 'q1')
    for (const set of sets) f.resultClient.emit('q1', { type: 'resultSet.opened', descriptor: { ...set, state: 'open' } })
    await f.results.finish(tab.id, 'q1', { summary: summaryOf(sets) })
    const pivot = f.results.addSet(tab.id, descriptor(803, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])!
    const diff = f.results.addSet(tab.id, descriptor(901, { index: 1, kind: 'diff', ...rows }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])!
    const [one, , two] = f.results.getSnapshot()[tab.id].sets.map(set => set.key)
    const shown = () => selectedEntry(f.results.getSnapshot()[tab.id])?.key
    return { ...f, tab, one, two, pivot, diff, shown }
  }

  it('step through the results, comparisons and views, and open the picker, while results show as tabs', async () => {
    const f = await ran()
    try {
      const { commands, settings, tab, one, two, pivot, diff, shown } = f
      expect(shown()).toBe(one)
      // Two results and a comparison: the browser tab keys in the results pane are the results'.
      expect(f.results.steppable.getSnapshot()[tab.id]).toBe(true)
      // Every output panel closed (the fixture's panels all start closed, as after Ctrl+R): a step brings back what Ctrl+R
      // hid, with Results' tab selected, without moving the focus.
      const select = vi.spyOn(f.panes, 'select')
      const locations = (results: 'grid' | 'closed' | 'window') => ({ ...Object.fromEntries(['explorer', 'editor', 'results', 'messages', 'plan', 'statistics'].map(id => [id, 'closed'])), results }) as never
      const visible = (results: boolean) => ({ ...f.panes.getSnapshot(), results })
      await commands.execute('output.nextResult', undefined, 'keybinding')
      expect(f.host.toggleOutput).toHaveBeenCalledTimes(1)
      expect(select).toHaveBeenLastCalledWith('results')
      expect(f.host.reveal).not.toHaveBeenCalled()
      // Open but not showing (behind a maximized group, its group hidden, tabbed with the editor): the dock's reveal.
      f.panes.set(visible(false), locations('grid'))
      select.mockClear()
      await commands.execute('output.previousResult', undefined, 'keybinding')
      expect(f.host.reveal).toHaveBeenLastCalledWith('results', { raise: true })
      expect(select).not.toHaveBeenCalled()
      // In a popout: its tab there. Showing already: nothing to do.
      f.panes.set(visible(false), locations('window'))
      vi.mocked(f.host.reveal).mockClear()
      await commands.execute('output.nextResult', undefined, 'keybinding')
      expect(select).toHaveBeenLastCalledWith('results')
      f.panes.set(visible(true), locations('grid'))
      select.mockClear()
      await commands.execute('output.previousResult', undefined, 'keybinding')
      expect(select).not.toHaveBeenCalled()
      expect(f.host.reveal).not.toHaveBeenCalled()
      expect(f.host.toggleOutput).toHaveBeenCalledTimes(1)
      expect(commands.isEnabled('output.nextResultView')).toBe(true)
      await commands.execute('output.nextResult', undefined, 'keybinding')
      expect(shown()).toBe(two)
      // Result 2 has one view.
      expect(commands.isEnabled('output.nextResultView')).toBe(false)
      await commands.execute('output.previousResult', undefined, 'keybinding')
      expect(shown()).toBe(one)
      await commands.execute('output.nextResultView', undefined, 'keybinding')
      expect(shown()).toBe(pivot)
      await commands.execute('output.previousResultView', undefined, 'palette')
      expect(shown()).toBe(one)
      await commands.execute('output.nextResultView', undefined, 'palette')
      await commands.execute('output.previousResult', undefined, 'keybinding')
      expect(shown()).toBe(diff)
      expect(commands.isEnabled('output.previousResultView')).toBe(false)
      // Round to Result 1, which shows its Pivot again, the view it showed last.
      await commands.execute('output.nextResult', undefined, 'keybinding')
      expect(shown()).toBe(pivot)
      // Go to Result… asks the layout for its picker, which takes the request when it is drawn.
      expect(await commands.execute('output.goToResult', undefined, 'palette')).toBe(true)
      expect(pickerRequests.take(tab.id)).toBe(true)
      // Go to Result N, as a browser's Ctrl+N: the item at that place (Result 2, the comparison third), the last for Ctrl+9;
      // none past the end.
      await commands.execute('output.goToResult2', undefined, 'keybinding')
      expect(shown()).toBe(two)
      await commands.execute('output.goToLastResult', undefined, 'keybinding')
      expect(shown()).toBe(diff)
      await commands.execute('output.goToResult1', undefined, 'keybinding')
      expect(shown()).toBe(pivot)
      expect(commands.isEnabled('output.goToResult3')).toBe(true)
      expect(commands.isEnabled('output.goToResult4')).toBe(false)
      // Stacked: Next and Previous Result and Go to Result N select the view and ask the stack to scroll it into view; the
      // view commands (a Table and its Pivot show together) and the picker are Tabs' only.
      await settings.choose('queryResults.grid.layout', 'stacked')
      for (const id of ['output.nextResultView', 'output.previousResultView', 'output.goToResult'] as const) expect(commands.isEnabled(id), id).toBe(false)
      const reveals: string[] = []
      const listening = stackReveals.subscribe(requested => { const key = stackReveals.take(requested); if (key) reveals.push(key) })
      try {
        expect(await commands.execute('output.nextResult', undefined, 'palette')).toBe(true)
        expect(shown()).toBe(two)
        expect(await commands.execute('output.goToLastResult', undefined, 'keybinding')).toBe(true)
        expect(shown()).toBe(diff)
        expect(reveals).toEqual([two, diff])
      } finally { listening.dispose() }
    } finally { f.dispose() }
  })
})
