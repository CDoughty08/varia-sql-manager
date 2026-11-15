// @vitest-environment happy-dom
// The stacked results keep what they know of a result by its entry key: when a middle entry goes, the entries after it
// move up a place and keep their names, their grids, the focus, what was collapsed, their shares of the pane, their sorts
// and the search's reveal. The grid itself is stubbed: this is the stack's part.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ResultColumn, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ResultGridProps } from '../src/renderer/src/grid/ResultGrid'
import ResultsStack, { collapsedPlaces, settledContent, stackNeed, turnedEntries, weightsOf } from '../src/renderer/src/grid/ResultsStack'
import { stackReveals } from '../src/renderer/src/grid/result-picker'
import { ResultsService, setKey, type GridSort, type GridViewState, type ResultSetEntry } from '../src/renderer/src/results/ResultsService'
import type { ResultView } from '../src/renderer/src/results/ResultClient'
import { PivotService } from '../src/renderer/src/results/PivotService'
import type { TabSearch } from '../src/renderer/src/results/search'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The grid's stand-in says which entry it was given and what the stack told it; a click is the grid taking the focus.
// Each mounted one has a number of its own, so a grid React handed to another entry, or built again, shows.
vi.mock('../src/renderer/src/grid/ResultGrid', async () => {
  const { createElement, useRef } = await import('react')
  let made = 0
  return {
    default: (props: ResultGridProps) => {
      const instance = useRef(0)
      if (instance.current === 0) instance.current = ++made
      return createElement('div', {
        'data-grid': props.entry.key, 'data-result-entry': props.entry.key, 'data-instance': instance.current, 'data-focused': String(props.focused), 'data-count': props.count, 'data-sorted': String(!!props.sort),
        'data-view': props.view, 'data-group': props.group, 'data-bare': String(!!props.bare), 'data-pane-focus': 'grid', tabIndex: 0,
        onClick: () => props.onFocus(props.entry.key)
      })
    }
  }
})

let paneHeight = 2000
let root: Root | undefined, container: HTMLElement | undefined
let clientHeight: PropertyDescriptor | undefined

beforeEach(() => {
  paneHeight = 2000
  // The stack lays out only in a pane with a height, which no layout engine gives it here.
  clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('rs-stack') ? paneHeight : 0 } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
})
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
  vi.useRealTimers()
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
  else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

/** Results 1 to 3, each with more rows than its share of the pane shows, and a pivot of Result 3 after them. `names`: the
 *  query's names for Results 1 to 3 (a `#Name` marker), none by default. */
function fixture(queryNames: readonly (string | undefined)[] = []) {
  const client = fakeResultClient(), events = new EventBus()
  const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
  const results = new ResultsService({ client, api, events, frame: callback => callback() })
  const rows = { rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }
  results.begin('t1', 'q1')
  void results.finish('t1', 'q1', { summary: summaryOf([1, 2, 3].map(id => descriptor(id, { index: id - 1, ...rows, ...queryNames[id - 1] ? { name: queryNames[id - 1] } : {} }))) })
  results.addSet('t1', descriptor(803, { index: 2, kind: 'pivot', ...rows }), `Pivot of ${queryNames[2] ?? 'Result 3'}`, ['1:3'])
  const keys = results.getSnapshot().t1.sets.map(set => set.key)
  // Search in results, as far as the stack reads it: where the active match is, and whether a grid has shown it yet.
  const listeners = new Set<() => void>()
  let search: Record<string, Partial<TabSearch>> = {}
  const resultsSearch = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => search,
    pendingReveal: (_tabId: string, key: string) => search.t1?.revealEntry === key
  }
  const reveal = (key: string) => act(() => { search = { t1: { reveal: (search.t1?.reveal ?? 0) + 1, revealEntry: key, marks: new Map() } }; for (const listener of [...listeners]) listener() })
  const commands = { execute: vi.fn(async () => true) }
  const pivot = new PivotService(results)
  const workbench = { results, resultsSearch, commands, pivot } as unknown as Workbench
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const host = container
  /** Draws the stack over the results as published now, and lets it mount its grids (two a frame). Without `closable` the
   *  run is drawn bare, as Peek's is: no close buttons. */
  const draw = (closable = true, revealFocused = false) => {
    act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement('div', { className: 'output-panel' }, createElement('button', { role: 'tab', 'data-output-tab': 'results' }), createElement(ResultsStack, { tabId: 't1', tab: closable ? results.getSnapshot().t1 : { ...results.getSnapshot().t1, bare: true }, revealFocused })) })) })
    for (let frame = 0; frame < 4; frame++) act(() => { vi.advanceTimersByTime(50) })
  }
  const all = <T extends Element = HTMLElement>(selector: string) => [...host.querySelectorAll<T>(selector)]
  const items = () => all('.rs-item')
  const names = () => all('.rs-caption-name').map(element => element.textContent)
  const grids = () => all('[data-grid]').map(element => element.dataset.grid)
  const grid = (key: string) => host.querySelector<HTMLElement>(`[data-grid="${key}"]`)
  const focused = () => all('[data-grid][data-focused="true"]').map(element => element.dataset.grid)
  const collapsed = () => items().map(item => item.dataset.collapsed !== undefined)
  const heights = () => items().map(item => parseFloat(item.style.height))
  const splitters = () => all('.rs-splitter').map(element => element.getAttribute('aria-label') ?? 'inert')
  /** The caption's Collapse button of the entry drawn at a place. */
  const toggle = (place: number) => act(() => { all<HTMLButtonElement>('.rs-caption-toggle')[place].click() })
  const key = (name: string, place: number) => act(() => { all('.rs-splitter')[place].dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
  return { results, client, keys, commands, pivot, draw, reveal, names, grids, grid, focused, collapsed, heights, splitters, toggle, key, all }
}

describe('the stacked results', () => {
  it('turn what the stack keeps by entry into places only to lay the entries out', () => {
    const sets = ['a', 'b', 'c'].map(key => ({ key })) as ResultSetEntry[]
    expect([...collapsedPlaces(sets, new Set(['c', 'gone']))]).toEqual([2])
    expect(collapsedPlaces(sets, new Set()).size).toBe(0)
    expect(weightsOf(sets, new Map([['c', 3], ['a', 1], ['b', 2], ['gone', 9]]))).toEqual([1, 2, 3])
    // An entry without a share (a result added since the drag) takes the mean of the others', which keep theirs.
    expect(weightsOf(sets, new Map([['a', 1], ['c', 5]]))).toEqual([1, 3, 5])
    expect(weightsOf(sets, new Map([['b', 4]]))).toEqual([4, 4, 4])
    // Equal shares when no entry drawn has one.
    expect(weightsOf(sets, new Map([['gone', 9]]))).toBeUndefined()
    expect(weightsOf(sets, undefined)).toBeUndefined()
  })

  it('name each caption, grid and splitter by its entry, and give the first grid the focus until another takes it', () => {
    const { results, keys, draw, names, grids, grid, focused, splitters } = fixture()
    draw()
    expect(names()).toEqual(['Result 1', 'Result 2', 'Result 3', 'Pivot of Result 3'])
    expect(grids()).toEqual(keys)
    expect(grid(keys[0])!.dataset.count).toBe('4')
    expect(splitters()).toEqual(['Resize Result 1', 'Resize Result 2', 'Resize Result 3'])
    expect(focused()).toEqual([keys[0]])
    expect(results.focusedEntry('t1')?.key).toBe(keys[0])
    act(() => { grid(keys[2])!.click() })
    expect(focused()).toEqual([keys[2]])
    expect(results.viewState('t1').focused).toBe(keys[2])
  })

  it('leave every other entry its name, grid, focus, collapse, share, sort and reveal when a middle entry goes', async () => {
    const { results, client, keys, commands, draw, reveal, names, grids, grid, focused, collapsed, heights, splitters, toggle, key } = fixture()
    const [one, two, three, pivot] = keys
    draw()
    // Result 3 has the focus and a sort, the pivot is collapsed, and a splitter drag left Result 1 taller than Result 3.
    act(() => { grid(three)!.click() })
    const view = { viewId: 9, keys: [{ column: 0, descending: false, mode: 'value' }], filters: [], complete: true, approximate: false, close: vi.fn(async () => {}) } as unknown as ResultView
    client.handle(3)!.sort.mockResolvedValueOnce(view)
    results.sortBy('t1', three, 0, 'ascending')
    await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() })
    toggle(3)
    for (let press = 0; press < 5; press++) key('ArrowDown', 0)
    draw()
    expect(collapsed()).toEqual([false, false, false, true])
    expect(grids()).toEqual([one, two, three])
    const before = heights()
    expect(before[0]).toBeGreaterThan(before[2])
    expect(before[0] - before[1]).toBeCloseTo(200)
    expect([...results.viewState('t1').weights!.keys()]).toEqual(keys)
    expect(grid(three)!.dataset.sorted).toBe('true')
    expect([one, two].map(entry => grid(entry)!.dataset.sorted)).toEqual(['false', 'false'])
    const instances = [one, three].map(entry => grid(entry)!.dataset.instance)
    expect(new Set([...instances, grid(two)!.dataset.instance]).size).toBe(3)

    expect(results.removeEntry('t1', two)).toBe(true)
    draw()
    // The entries after it moved up a place and kept their names; Result 3's grid is the one it had, still focused and sorted.
    expect(names()).toEqual(['Result 1', 'Result 3', 'Pivot of Result 3'])
    expect(grids()).toEqual([one, three])
    // Not Result 2's grid given Result 3's entry, nor a grid built again: the very ones that were mounted.
    expect([one, three].map(entry => grid(entry)!.dataset.instance)).toEqual(instances)
    expect(focused()).toEqual([three])
    expect(grid(three)!.dataset.sorted).toBe('true')
    expect(grid(one)!.dataset.sorted).toBe('false')
    // "Result 3 of 4" still: closing a result renames and renumbers nothing, and no grid reads "Result 3 of 2".
    expect(grid(one)!.dataset.count).toBe('4')
    // The pivot is still the collapsed one, not Result 3, which now stands where Result 2 was, nor whatever is third.
    expect(collapsed()).toEqual([false, false, true])
    // Each kept the share the drag left it: Result 1 is still the taller, by the proportion it had over Result 3.
    const after = heights()
    expect(after[0]).toBeGreaterThan(after[1])
    expect(after[0] / after[1]).toBeCloseTo(before[0] / before[2], 1)
    expect(splitters()).toEqual(['Resize Result 1', 'inert'])
    // A caption's button names its own entry to the command.
    const save = [...container!.querySelectorAll<HTMLButtonElement>('.rs-caption-save')]
    expect(save.map(button => button.getAttribute('aria-label'))).toEqual(['Save Result 1 As…', 'Save Result 3 As…', 'Save Pivot of Result 3 As…'])
    for (const [place, entry] of [one, three, pivot].entries()) {
      act(() => { save[place].click() })
      expect(commands.execute).toHaveBeenLastCalledWith('output.saveResultsAs', { target: expect.objectContaining({ kind: 'output', tabId: 't1', view: 'grid', entry }) }, 'toolbar')
    }
    // A splitter moved now moves the two entries beside it and writes each share to its own entry.
    key('ArrowDown', 0)
    draw()
    const moved = heights()
    expect([moved[0] - after[0], moved[1] - after[1]]).toEqual([20, -20])
    expect([...results.viewState('t1').weights!.keys()]).toEqual([one, three, pivot])
    expect(results.viewState('t1').weights!.get(one)! - results.viewState('t1').weights!.get(three)!).toBeCloseTo(moved[0] - moved[1])
    // Search's active match in the pivot opens the pivot, by its entry, and no other.
    reveal(pivot)
    draw()
    expect(collapsed()).toEqual([false, false, false])
    expect(grids()).toEqual([one, three, pivot])
    expect(splitters()).toEqual(['Resize Result 1', 'Resize Result 3'])
    expect([...results.viewState('t1').collapsed]).toEqual([])
    // Collapsing the entry now second collapses Result 3, and the results publish it (a Pivot expanded again is shown,
    // and follows its Table's filters).
    const published = results.getSnapshot().t1
    toggle(1)
    expect([...results.viewState('t1').collapsed]).toEqual([three])
    expect(results.getSnapshot().t1).not.toBe(published)
    // The focused entry going takes its group with it (the Pivot too) and leaves the entry before to take the focus.
    results.removeEntry('t1', three)
    draw()
    expect(names()).toEqual(['Result 1'])
    expect(focused()).toEqual([one])
    expect(collapsed()).toEqual([false])
  })

  it('give a result made after a splitter drag the mean share, so the others keep their proportions', () => {
    const { results, keys, draw, heights, key } = fixture()
    const [one, two, three] = keys
    draw()
    for (let press = 0; press < 5; press++) key('ArrowDown', 0)
    draw()
    const before = heights()
    expect(before[0]).toBeGreaterThan(before[1])
    const added = results.addSet('t1', descriptor(804, { index: 0, kind: 'pivot', rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }), 'Pivot of Result 1', ['1:1'])!
    draw()
    const after = heights()
    expect(after).toHaveLength(5)
    // The Pivot stands directly under Result 1. Not back to equal shares: Result 1 is still taller than Result 2 by the
    // proportion the drag left.
    expect(results.getSnapshot().t1.sets[1].key).toBe(added)
    expect(after[0] / after[2]).toBeCloseTo(before[0] / before[1], 1)
    expect(after[2] / after[3]).toBeCloseTo(before[1] / before[2], 1)
    expect(results.viewState('t1').weights!.has(added)).toBe(false)
    expect([one, two, three].every(entry => results.viewState('t1').weights!.has(entry))).toBe(true)
  })

  it('close a view by its caption\'s button, a Table\'s closing its group, moving the focus to the next caption, then the Results tab', () => {
    const { results, client, keys, draw, names, grids } = fixture()
    const [one, two, three, pivot] = keys
    const rows = { rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }
    const diff = results.addSet('t1', descriptor(901, { index: 0, kind: 'diff', ...rows }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])!
    const closers = () => [...container!.querySelectorAll<HTMLButtonElement>('.rs-caption-close')]
    // A bare stack (Peek's) has no close buttons.
    draw(false)
    expect(closers()).toHaveLength(0)
    draw()
    // One item per view: Result 3's Pivot directly under it, the comparison after the groups. Each grid says what it shows.
    expect(names()).toEqual(['Result 1', 'Result 2', 'Result 3', 'Pivot of Result 3', 'Differences: Result 1 → Result 2'])
    expect([...container!.querySelectorAll<HTMLElement>('[data-grid]')].map(element => [element.dataset.view, element.dataset.group])).toEqual([['table', '1'], ['table', '2'], ['table', '3'], ['pivot', '3'], ['comparison', undefined]])
    expect(closers().map(button => button.getAttribute('aria-label'))).toEqual(['Close Result 1', 'Close Result 2', 'Close Result 3', 'Close Pivot of Result 3', 'Close Differences: Result 1 → Result 2'])
    // A Table's button says what goes with it.
    expect(closers().map(button => button.title)).toEqual(['Close Result 1', 'Close Result 2', 'Close Result 3 and its Pivot', 'Close Pivot of Result 3', 'Close Differences: Result 1 → Result 2'])
    expect(closers().every(button => !button.disabled)).toBe(true)
    // A Pivot's close closes it alone and leaves the focus in its group: on the Table's caption, where the service
    // leaves the grid focus, not on whatever is drawn next.
    const other = results.addSet('t1', descriptor(802, { index: 1, kind: 'pivot', ...rows }), 'Pivot of Result 2', ['1:2'])!
    draw()
    expect(names()).toEqual(['Result 1', 'Result 2', 'Pivot of Result 2', 'Result 3', 'Pivot of Result 3', 'Differences: Result 1 → Result 2'])
    results.focusEntry('t1', other)
    closers()[2].focus()
    act(() => { closers()[2].click() })
    draw()
    expect(names()).toEqual(['Result 1', 'Result 2', 'Result 3', 'Pivot of Result 3', 'Differences: Result 1 → Result 2'])
    expect((document.activeElement as HTMLElement).dataset.captionEntry).toBe(two)
    expect(results.getSnapshot().t1.focused).toBe(two)
    client.release.mockClear()
    // Closing Result 3 closes its group: its Pivot goes with it, in one release.
    closers()[2].focus()
    act(() => { closers()[2].click() })
    draw()
    expect(names()).toEqual(['Result 1', 'Result 2', 'Differences: Result 1 → Result 2'])
    expect(client.released()).toEqual([3, 803])
    expect(client.release).toHaveBeenCalledOnce()
    expect(grids()).toEqual([one, two, diff])
    // The focus went to the caption after the group.
    expect((document.activeElement as HTMLElement).dataset.captionEntry).toBe(diff)
    // A close from elsewhere leaves the focus alone; closing an input of the comparison leaves the comparison.
    const kept = container!.querySelector<HTMLElement>(`[data-caption-entry="${diff}"]`)!
    kept.focus()
    act(() => { closers()[0].click() })
    draw()
    expect(document.activeElement).toBe(kept)
    expect(names()).toEqual(['Result 2', 'Differences: Result 1 → Result 2'])
    // The last one's close moves the focus to the one before, and releases the comparison alone.
    closers()[1].focus()
    act(() => { closers()[1].click() })
    draw()
    expect((document.activeElement as HTMLElement).dataset.captionEntry).toBe(two)
    expect(names()).toEqual(['Result 2'])
    // The last result closed: the run is emptied, not closed, and the focus is on the Results tab, which stays.
    closers()[0].focus()
    act(() => { closers()[0].click() })
    expect(results.getSnapshot().t1).toMatchObject({ status: 'completed', sets: [], groups: [], comparisons: [], emptied: true })
    expect((document.activeElement as HTMLElement).dataset.outputTab).toBe('results')
    expect(client.released()).toEqual([3, 803, 1, 901, 2])
    expect([three, pivot].every(entry => !results.getSnapshot().t1.sets.some(set => set.key === entry))).toBe(true)
  })

  it('put the caption focus after a close where the service puts the grid focus: the view its neighbour last showed', () => {
    const { results, keys, draw } = fixture()
    const [one, two, three] = keys
    const rows = { rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }
    results.removeEntry('t1', three)
    const pivot = results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])!
    // Result 1 last showed its Table; Result 2, the last result, has the focus. The caption before Result 2's is the Pivot's,
    // but the service gives the grid focus to Result 1's Table, and the caption focus goes with it.
    results.focusEntry('t1', one)
    results.focusEntry('t1', two)
    draw()
    const close = (name: string) => { const button = container!.querySelector<HTMLButtonElement>(`[aria-label="Close ${name}"]`)!; button.focus(); act(() => { button.click() }); draw() }
    close('Result 2')
    expect(results.getSnapshot().t1.focused).toBe(one)
    expect((document.activeElement as HTMLElement).dataset.captionEntry).toBe(one)
    expect(pivot).toBeDefined()
  })

  it('open and scroll to the focused view when drawn in place of the Tabs layout, and only then', () => {
    // A pane that scrolls: scrollTop is kept per element, as no layout engine keeps it here.
    const scrolled = new WeakMap<Element, number>()
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get(this: HTMLElement) { return scrolled.get(this) ?? 0 }, set(this: HTMLElement, value: number) { scrolled.set(this, value) } })
    try {
      paneHeight = 150
      for (const revealFocused of [false, true]) {
        const { results, keys, draw } = fixture()
        const pivot = keys[3]
        const view = results.viewState('t1')
        results.focusEntry('t1', pivot)
        view.collapsed = new Set([pivot])
        view.stackScrollTop = 0
        draw(true, revealFocused)
        // Drawn by a switch from Tabs, the Pivot of Result 3 (last, collapsed) opens and the stack scrolls down to it;
        // drawn any other way, the stack keeps what was collapsed and where it was.
        expect(view.collapsed.has(pivot)).toBe(!revealFocused)
        if (revealFocused) expect(view.stackScrollTop).toBeGreaterThan(0)
        else expect(view.stackScrollTop).toBe(0)
        act(() => { root?.unmount() })
        root = undefined
        container?.remove()
      }
    } finally {
      if (scrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', scrollTop)
      else delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
    }
  })

  it('scroll to and open the view Next Result or Go to Result N selects, taking the focus along from a grid only', () => {
    const scrolled = new WeakMap<Element, number>()
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get(this: HTMLElement) { return scrolled.get(this) ?? 0 }, set(this: HTMLElement, value: number) { scrolled.set(this, value) } })
    try {
      paneHeight = 150
      const { results, keys, draw } = fixture()
      const [one, , three, pivot] = keys
      const view = results.viewState('t1')
      view.collapsed = new Set([pivot])
      draw()
      const stack = container!.querySelector<HTMLElement>('.rs-stack')!
      act(() => { container!.querySelector<HTMLElement>(`[data-grid="${one}"]`)!.focus() })
      // From Result 1's grid to the Pivot of Result 3: it opens, the stack scrolls down to it, and its grid takes the focus.
      act(() => { results.focusEntry('t1', pivot); stackReveals.request('t1', pivot) })
      act(() => { stack.dispatchEvent(new Event('scroll')) })
      for (let frame = 0; frame < 4; frame++) act(() => { vi.runOnlyPendingTimers() })
      expect(view.collapsed.has(pivot)).toBe(false)
      expect(view.stackScrollTop).toBeGreaterThan(0)
      expect((document.activeElement as HTMLElement).dataset.grid).toBe(pivot)
      // From outside the stack (the editor): it scrolls, and the focus stays where it was.
      const editor = document.createElement('textarea')
      document.body.append(editor)
      editor.focus()
      act(() => { results.focusEntry('t1', one); stackReveals.request('t1', one) })
      act(() => { stack.dispatchEvent(new Event('scroll')) })
      for (let frame = 0; frame < 4; frame++) act(() => { vi.runOnlyPendingTimers() })
      expect(view.stackScrollTop).toBe(0)
      expect(document.activeElement).toBe(editor)
      // Another query's request is not this stack's.
      act(() => { stackReveals.request('t2', three) })
      expect(view.stackScrollTop).toBe(0)
      expect(stackReveals.take('t2')).toBe(three)
      editor.remove()
      // A stack drawn after the request (its pane closed and opened again for the command) takes it when it mounts.
      act(() => { root?.unmount() })
      container?.remove()
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      act(() => { results.focusEntry('t1', pivot); stackReveals.request('t1', pivot) })
      view.collapsed = new Set([pivot])
      draw()
      act(() => { container!.querySelector('.rs-stack')!.dispatchEvent(new Event('scroll')) })
      expect(view.collapsed.has(pivot)).toBe(false)
      expect(view.stackScrollTop).toBeGreaterThan(0)
      // A request no stack took in time lapses.
      stackReveals.request('t3', one, 0)
      expect(stackReveals.take('t3', 2001)).toBeUndefined()
    } finally {
      if (scrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', scrollTop)
      else delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
    }
  })

  it('draw a bare run as its grid alone, with a caption only to hold its filters, and size a transposed item by the rows it draws', () => {
    const client = fakeResultClient(), events = new EventBus()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const results = new ResultsService({ client, api, events, frame: callback => callback() })
    results.begin('peek', 'q1', undefined, { bare: true })
    void results.finish('peek', 'q1', { summary: summaryOf([descriptor(1)]) })
    const none = {}, resultsSearch = { subscribe: () => () => {}, getSnapshot: () => none, pendingReveal: () => false }
    const workbench = { results, resultsSearch, commands: { execute: vi.fn(async () => true) }, pivot: new PivotService(results) } as unknown as Workbench
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const draw = (tab = results.getSnapshot().peek) => {
      act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsStack, { tabId: 'peek', tab }) })) })
      for (let frame = 0; frame < 4; frame++) act(() => { vi.advanceTimersByTime(50) })
    }
    draw()
    expect(results.getSnapshot().peek.bare).toBe(true)
    // The grid alone: no caption, no close button, and the grid says it is bare for the menus.
    expect(container.querySelectorAll('.rs-caption')).toHaveLength(0)
    expect(container.querySelectorAll('[data-grid]')).toHaveLength(1)
    expect(container.querySelector<HTMLElement>('[data-grid]')!.dataset.bare).toBe('true')
    // With a filter the caption returns to hold its chip, still without a close button.
    const key = results.getSnapshot().peek.sets[0].key
    const sort = { keys: [], filters: [{ filter: { op: 'keepRows', rows: [0] }, label: '1 selected row' }], applied: [], sorting: false, approximate: false, stale: false } as unknown as GridSort
    draw({ ...results.getSnapshot().peek, sorts: new Map([[key, sort]]) })
    expect([...container.querySelectorAll('.rs-filter-text')].map(element => element.textContent)).toEqual(['1 selected row'])
    expect(container.querySelectorAll('.rs-caption-close')).toHaveLength(0)
    // The last filter is removed from its chip, which first hands the focus to the caption: the caption goes, and the
    // focus goes to the grid, not to the page (Peek's card keeps its keys only while the focus is inside it).
    container.querySelector<HTMLElement>('.rs-caption-toggle')!.focus()
    expect(document.activeElement).toBe(container.querySelector('.rs-caption-toggle'))
    draw()
    expect(container.querySelectorAll('.rs-caption')).toHaveLength(0)
    expect(document.activeElement).toBe(container.querySelector('[data-grid]'))
    // A focus that is elsewhere when the caption goes is left alone.
    draw({ ...results.getSnapshot().peek, sorts: new Map([[key, sort]]) })
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    draw()
    expect(document.activeElement).toBe(outside)
    outside.remove()

    // settledContent: a table of 2 rows and 2 columns is sized by its rows; drawn transposed, by its 2 columns, however
    // many rows it has.
    const wide = descriptor(1, { rowsRead: 500, rowsStored: 500, rowsAvailable: 500 })
    const entry = { key: 'e', number: 1, ordinal: 1, descriptor: wide } as unknown as ResultSetEntry
    const tab = { sets: [entry], settled: new Map([[setKey(wide), { rows: 500, strip: false }]]) }
    const [table] = settledContent(tab, new Set(['e']))
    const [turned] = settledContent(tab, new Set(['e']), new Set(['e']))
    expect(table! - turned!).toBe((500 - wide.columns.length) * 20)
    // Past 4,095 rows the turned grid shows a strip saying which rows it draws, which its height includes; a table of
    // as many rows has none.
    const long = { sets: [entry], settled: new Map([[setKey(wide), { rows: 5000, strip: false }]]) }
    expect(settledContent(long, new Set(['e']), new Set(['e']))[0]! - turned!).toBe(25)
    expect(settledContent({ sets: [entry], settled: new Map([[setKey(wide), { rows: 4095, strip: false }]]) }, new Set(['e']), new Set(['e']))[0]).toBe(turned)
    // The strip is the view's: a filter that leaves fewer rows than the cap (Transpose Selected Rows) leaves none.
    const filtered = { keys: [], filters: [], applied: [], view: { rows: 2 }, sorting: false, approximate: false, stale: false } as unknown as GridSort
    expect(settledContent({ ...long, sorts: new Map([['e', filtered]]) }, new Set(['e']), new Set(['e']))[0]).toBe(turned)
    // Which entries are turned is read from each grid's state by the rule the grid follows: never a comparison (its tone
    // column marks rows), whatever its state says.
    const toned = { key: 'd', number: 2, descriptor: descriptor(2, { kind: 'diff', columns: [...wide.columns, { name: '', dataType: 'tinyint', wire: 'text', nullable: true, role: 'tone' }] as ResultColumn[] }) } as unknown as ResultSetEntry
    const state = (orientation?: 'transposed'): GridViewState => ({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false, ...orientation ? { orientation } : {} })
    expect([...turnedEntries([entry, toned], new Map([['e', state('transposed')], ['d', state('transposed')]]))]).toEqual(['e'])
    expect(turnedEntries([entry, toned], new Map([['e', state()]])).size).toBe(0)
    // The room the Messages strip leaves the stack counts the rows drawn too: two results of 500 rows need their floors,
    // and less when one is drawn transposed as 2 rows.
    const other = { key: 'f', number: 2, ordinal: 2, descriptor: descriptor(2, { index: 1, rowsRead: 500, rowsStored: 500, rowsAvailable: 500 }) } as unknown as ResultSetEntry
    const two = { sets: [entry, other], settled: new Map([[setKey(wide), { rows: 500, strip: false }], [setKey(other.descriptor), { rows: 500, strip: false }]]) }
    const plain = stackNeed(two, new Set()), withTurned = stackNeed(two, new Set(), new Map([['e', state('transposed')]]))
    expect(plain - withTurned).toBe(2 * 20)
    expect(stackNeed(two, new Set(), new Map())).toBe(plain)

    // In the stack: the service's setOrientation publishes, and the item is sized again though nothing else changed.
    act(() => { root!.unmount() })
    root = createRoot(container)
    results.begin('t2', 'q2')
    const many = { rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }
    void results.finish('t2', 'q2', { summary: summaryOf([descriptor(11, { index: 0, ...many }), descriptor(12, { index: 1, ...many })]) })
    const drawTwo = () => {
      act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsStack, { tabId: 't2', tab: results.getSnapshot().t2 }) })) })
      for (let frame = 0; frame < 4; frame++) act(() => { vi.advanceTimersByTime(50) })
    }
    const heights = () => [...container!.querySelectorAll<HTMLElement>('.rs-item')].map(item => parseFloat(item.style.height))
    drawTwo()
    const before = heights()
    expect(Math.abs(before[0] - before[1])).toBeLessThanOrEqual(1)
    expect(results.setOrientation('t2', results.getSnapshot().t2.sets[0].key, { transposed: true })).toBe(true)
    drawTwo()
    const after = heights()
    // Result 1 draws its 2 columns as rows and takes only their height; Result 2 takes the rest.
    expect(after[0]).toBeLessThan(200)
    expect(after[1]).toBeGreaterThan(before[1])
  })

  it('move the focus once after a close, to the Results tab when the next caption is not drawn, and never steal it later', () => {
    // A pane too short for a caption, a header and four rows: one result left shows its grid without its caption.
    paneHeight = 60
    const { results, keys, draw, names } = fixture()
    const [one, two, three, pivot] = keys
    results.removeEntry('t1', three)
    results.removeEntry('t1', pivot)
    draw(true)
    const closers = () => [...container!.querySelectorAll<HTMLButtonElement>('.rs-caption-close')]
    // Only the first of the two is in view, so the caption after it is not drawn.
    expect(names()).toEqual(['Result 1'])
    closers()[0].focus()
    act(() => { closers()[0].click() })
    draw(true)
    expect(container!.querySelectorAll('.rs-caption')).toHaveLength(0)
    expect((document.activeElement as HTMLElement).dataset.outputTab).toBe('results')
    // The user moves on; a result added later draws captions again, and the focus stays where they put it.
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    elsewhere.focus()
    results.addSet('t1', descriptor(802, { index: 1, kind: 'pivot' }), 'Pivot of Result 2', ['1:2'])
    draw(true)
    expect(names()).toContain('Result 2')
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
    expect([one, two]).toHaveLength(2)
  })

  it("mark an out-of-date Pivot on its caption with Update, and offer Cancel while it is built again", async () => {
    const { results, client, commands, pivot, draw } = fixture()
    // Result 1's Pivot was built over a Keep Selected Rows filter its Table no longer shows; Result 3's has no provenance.
    const made = results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot' }), 'Pivot of Result 1', ['1:1'], {
      pivot: { recipe: { rows: [0], values: [{ aggregate: 'count' }] }, filters: [{ op: 'keepRows', rows: [1] }], inputRows: 1, truncated: false, incomplete: false, approximate: false }
    })!
    draw()
    const update = () => container!.querySelector<HTMLButtonElement>('button[aria-label="Update Pivot of Result 1"]')
    expect([...container!.querySelectorAll('.rs-caption-stale')].map(element => element.textContent)).toEqual(['Out of date'])
    expect(update()!.disabled).toBe(false)
    expect(container!.querySelector('button[aria-label="Update Pivot of Result 3"]')).toBeNull()
    act(() => { update()!.click() })
    expect(commands.execute).toHaveBeenCalledWith('output.updatePivot', { target: expect.objectContaining({ kind: 'output', tabId: 't1', view: 'grid', entry: made }) }, 'toolbar')
    // Update waits while the Table's sort is being built, and the caption follows by itself, with no redraw from here.
    const table = client.handle(1)!
    let sorted: ((view: ResultView) => void) | undefined
    vi.mocked(table.sort).mockImplementationOnce(() => new Promise(resolve => { sorted = resolve }))
    act(() => { results.sortBy('t1', results.getSnapshot().t1.sets[0].key, 1, 'ascending') })
    expect(update()!.disabled).toBe(true)
    await act(async () => { sorted!({ ...table, viewId: 1, base: table, keys: [], filters: [], rows: 10_000, baseRows: 10_000, complete: true, approximate: false, close: vi.fn(async () => {}), pivot: vi.fn() } as unknown as ResultView) })
    expect(update()!.disabled).toBe(false)
    // Built again (here straight through the service): the same button turns into Cancel, named for its Pivot, and keeps
    // the focus; the status line, mounted all along, says what happens.
    const view = results.sortOf('t1', results.getSnapshot().t1.sets[0].key)!.view!
    let signal: AbortSignal | undefined
    vi.mocked(view.pivot as ReturnType<typeof vi.fn>).mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => { signal = o?.signal; o?.signal?.addEventListener('abort', () => reject(new Error('Cancelled.'))) }))
    const status = container!.querySelector('.rs-caption-state')!
    expect(status.textContent).toBe('')
    const button = update()!
    button.focus()
    let updating: Promise<void> | undefined
    act(() => { updating = pivot.update('t1', made) })
    expect(update()).toBeNull()
    expect(container!.querySelector('.rs-caption-state')).toBe(status)
    expect(status.textContent).toBe('Building again…')
    const cancel = container!.querySelector<HTMLButtonElement>('button[aria-label="Cancel building Pivot of Result 1 again"]')!
    expect(cancel).toBe(button)
    expect(document.activeElement).toBe(cancel)
    await act(async () => { cancel.click(); await updating })
    expect(signal?.aborted).toBe(true)
    // Still out of date: Update again, on the same button, with the focus.
    expect(status.textContent).toBe('')
    expect(update()).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(results.getSnapshot().t1.groups[0].pivot!.key).toBe(made)
    // Built and up to date (drawn again with the new run state): the button goes and the focus goes to the caption.
    vi.mocked(view.pivot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ descriptor: descriptor(811, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await act(async () => { await pivot.update('t1', made) })
    draw()
    expect(results.getSnapshot().t1.groups[0].pivot!.entry.descriptor.resultId).toBe(811)
    expect(update()).toBeNull()
    expect((document.activeElement as HTMLElement).dataset.captionEntry).toBe(made)
  })

  it('disable the close buttons while the query runs', () => {
    const { results, client, draw } = fixture()
    results.begin('t1', 'q2')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(11, { index: 0, state: 'open' }) })
    draw(true)
    const [button] = [...container!.querySelectorAll<HTMLButtonElement>('.rs-caption-close')]
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Close Result 1 (unavailable while the query runs)')
    act(() => { button.click() })
    expect(results.getSnapshot().t1.sets).toHaveLength(1)
    void results.finish('t1', 'q2', { summary: summaryOf([descriptor(11, { index: 0 })]) })
    draw(true)
    expect(container!.querySelector<HTMLButtonElement>('.rs-caption-close')!.disabled).toBe(false)
  })
})

describe('named results in the stack', () => {
  it('caption a named result by its name with its number first among the facts, and an unnamed one as before', () => {
    const long = 'Open orders awaiting approval by the regional finance team before the end of the quarter'
    const { draw, names, splitters, all } = fixture([long, undefined, 'Totals'])
    draw()
    expect(names()).toEqual([long, 'Result 2', 'Totals', 'Pivot of Totals'])
    const facts = all('.rs-caption-facts').map(element => element.textContent)
    expect(facts[0]).toMatch(/^Result 1 · /)
    expect(facts[1]).not.toMatch(/Result/)
    expect(facts[2]).toMatch(/^Result 3 · /)
    expect(facts[3]).not.toMatch(/Result/)
    // The whole name and the number are in the toggle's tooltip, as the name may end in an ellipsis; a named result's Pivot
    // has its name there, and an unnamed result none.
    const toggles = all<HTMLButtonElement>('.rs-caption-toggle')
    expect(toggles.map(toggle => toggle.getAttribute('title'))).toEqual([`${long} · Result 1`, null, 'Totals · Result 3', 'Pivot of Totals'])
    expect(toggles[0].textContent).toBe(long)
    // The splitters are named by the result above them, by its name when it has one.
    expect(splitters()).toEqual([`Resize ${long}`, 'Resize Result 2', 'Resize Totals'])
    // The caption's buttons name it in full.
    expect(all('.rs-caption-close').map(button => button.getAttribute('aria-label'))[0]).toBe(`Close ${long}`)
    // The name reaches the DOM as text, never as markup.
    expect(all('.rs-caption-name')[0].children).toHaveLength(0)
  })
  it('read a markup-like name as text', () => {
    const { draw, names, all } = fixture(['<b>bold</b> & "quoted"'])
    draw()
    expect(names()[0]).toBe('<b>bold</b> & "quoted"')
    expect(all('.rs-caption-name b')).toHaveLength(0)
  })
})

describe('named captions in the stack', () => {
  it('let only a caption that shows a name the query gave shrink, its Pivot\'s too', () => {
    const { results, draw, all } = fixture(['Open orders'])
    results.addSet('t1', descriptor(801, { index: 0, kind: 'pivot', rowsRead: 10, rowsStored: 10, rowsAvailable: 10 }), 'Pivot of Open orders', ['1:1'])
    draw()
    const toggles = all<HTMLButtonElement>('.rs-caption-toggle')
    expect(toggles.map(toggle => [toggle.textContent, toggle.dataset.named ?? null])).toEqual([
      ['Open orders', 'true'], ['Pivot of Open orders', 'true'], ['Result 2', null], ['Result 3', null], ['Pivot of Result 3', null]
    ])
  })
})
