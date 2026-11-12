// @vitest-environment happy-dom
// The stacked results keep what they know of a result by its entry key: when a middle entry goes, the entries after it
// move up a place and keep their names, their grids, the focus, what was collapsed, their shares of the pane, their sorts
// and the search's reveal. The grid itself is stubbed: this is the stack's part.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ResultGridProps } from '../src/renderer/src/grid/ResultGrid'
import ResultsStack, { collapsedPlaces, weightsOf } from '../src/renderer/src/grid/ResultsStack'
import { ResultsService, type ResultSetEntry } from '../src/renderer/src/results/ResultsService'
import type { ResultView } from '../src/renderer/src/results/ResultClient'
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
        'data-grid': props.entry.key, 'data-instance': instance.current, 'data-focused': String(props.focused), 'data-count': props.count, 'data-sorted': String(!!props.sort),
        onClick: () => props.onFocus(props.entry.key)
      })
    }
  }
})

const paneHeight = 2000
let root: Root | undefined, container: HTMLElement | undefined
let clientHeight: PropertyDescriptor | undefined

beforeEach(() => {
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

/** Results 1 to 3, each with more rows than its share of the pane shows, and a pivot of Result 3 after them. */
function fixture() {
  const client = fakeResultClient(), events = new EventBus()
  const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
  const results = new ResultsService({ client, api, events, frame: callback => callback() })
  const rows = { rowsRead: 10_000, rowsStored: 10_000, rowsAvailable: 10_000 }
  results.begin('t1', 'q1')
  void results.finish('t1', 'q1', { summary: summaryOf([descriptor(1, rows), descriptor(2, { index: 1, ...rows }), descriptor(3, { index: 2, ...rows })]) })
  results.addSet('t1', descriptor(803, { index: 2, kind: 'pivot', ...rows }), 'Pivot of Result 3', ['1:3'])
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
  const workbench = { results, resultsSearch, commands } as unknown as Workbench
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const host = container
  /** Draws the stack over the results as published now, and lets it mount its grids (two a frame). */
  const draw = () => {
    act(() => { root!.render(createElement(WorkbenchProvider, { workbench, children: createElement(ResultsStack, { tabId: 't1', tab: results.getSnapshot().t1 }) })) })
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
  return { results, client, keys, commands, draw, reveal, names, grids, grid, focused, collapsed, heights, splitters, toggle, key }
}

describe('the stacked results', () => {
  it('turn what the stack keeps by entry into places only to lay the entries out', () => {
    const sets = ['a', 'b', 'c'].map(key => ({ key })) as ResultSetEntry[]
    expect([...collapsedPlaces(sets, new Set(['c', 'gone']))]).toEqual([2])
    expect(collapsedPlaces(sets, new Set()).size).toBe(0)
    expect(weightsOf(sets, new Map([['c', 3], ['a', 1], ['b', 2], ['gone', 9]]))).toEqual([1, 2, 3])
    // An entry without a share (a result added since the drag) puts every entry back on equal shares.
    expect(weightsOf(sets, new Map([['a', 1], ['c', 3]]))).toBeUndefined()
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
    expect(grid(one)!.dataset.count).toBe('3')
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
    // Collapsing the entry now second collapses Result 3.
    toggle(1)
    expect([...results.viewState('t1').collapsed]).toEqual([three])
    // The focused entry going leaves the first to take the focus.
    results.removeEntry('t1', three)
    draw()
    expect(names()).toEqual(['Result 1', 'Pivot of Result 3'])
    expect(focused()).toEqual([one])
    expect(collapsed()).toEqual([false, false])
  })
})
