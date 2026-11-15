// @vitest-environment happy-dom
// The column profile panel: requests of at most 32 columns, each card's NULL share from the rows its own request saw,
// cards kept while the same rows are profiled again, a request cancelled when the grid shows other rows, and no request
// for a sort of the same rows.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ColumnProfile, ResolvedViewFilter, ResultsProfileResult, ViewSortKey } from '../src/shared/contracts'
import type { ResultView } from '../src/renderer/src/results/ResultClient'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ColumnProfilePanel, { profiledEntry, profileTarget } from '../src/renderer/src/results/ColumnProfilePanel'
import type { ResultSetEntry, TabResults } from '../src/renderer/src/results/ResultsService'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Asked { columns: number[]; signal?: AbortSignal; resolve(result: ResultsProfileResult): void; reject(error: unknown): void }

function fixture(columns = 40, shown: string | null = 'e1') {
  const listeners = new Set<() => void>()
  let snapshot = { state: 'open', rowsAvailable: 1000 }
  const asked: Asked[] = []
  const handle = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    profile: vi.fn((cols: number[], signal?: AbortSignal) => new Promise<ResultsProfileResult>((resolve, reject) => { asked.push({ columns: cols, signal, resolve, reject }) }))
  }
  const descriptor = { columns: Array.from({ length: columns }, (_, index) => ({ name: 'c' + index, dataType: 'int' })) }
  // Result 1, and a result numbered 5 that stands second (the ones between have gone) and has two columns of its own.
  const other = { columns: [{ name: 'x0', dataType: 'int' }, { name: 'x1', dataType: 'int' }] }
  const tab = { sets: [{ key: 'e1', number: 1, descriptor, handle }, { key: 'e5', number: 5, descriptor: other, handle }] } as unknown as TabResults
  // The panel is told which grid took the focus; without one it asks the stack, which names the second.
  const results = { subscribe: () => () => {}, getSnapshot: () => 0, sortOf: () => undefined, focusedEntry: () => tab.sets[1] }
  const workbench = { results, commands: { execute: vi.fn(async () => true) } } as unknown as Workbench
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ColumnProfilePanel, { tabId: 't', tab, ...shown === null ? {} : { shown } }) })) })
  const answer = async (at: number, rows: number, nulls: number) => {
    const request = asked[at]
    await act(async () => { request.resolve({ rows, complete: snapshot.state === 'complete', columns: request.columns.map(column => profileOf(column, rows, nulls)) }) })
  }
  const setSnapshot = (next: typeof snapshot) => act(() => { snapshot = next; for (const listener of listeners) listener() })
  const card = (name: string) => container.querySelector(`section[aria-label="${name}"]`)
  const nulls = (name: string) => [...card(name)?.querySelectorAll('dl > div') ?? []].find(item => item.querySelector('dt')?.textContent === 'NULLs')?.querySelector('dd')?.textContent
  const facts = () => container.querySelector('.profile-facts')?.textContent
  return { asked, answer, setSnapshot, card, nulls, facts, unmount: () => act(() => { root.unmount() }) }
}
/** A complete result of two columns and 1000 rows whose grid's view the test changes, as ResultsService would on a sort. */
function sortFixture() {
  // Each request with the handle it went through (the result's own, or a view).
  const asked: (Asked & { by: object })[] = []
  const handleOf = (rows: number) => {
    const snapshot = { state: 'complete', rowsAvailable: rows }
    const made = { subscribe: () => () => {}, getSnapshot: () => snapshot, profile: (cols: number[], signal?: AbortSignal) => new Promise<ResultsProfileResult>((resolve, reject) => { asked.push({ columns: cols, signal, resolve, reject, by: made }) }) }
    return made
  }
  const handle = handleOf(1000)
  const descriptor = { columns: [{ name: 'c0', dataType: 'int' }, { name: 'c1', dataType: 'nvarchar' }] }
  const tab = { sets: [{ key: 'e1', number: 1, descriptor, handle }] } as unknown as TabResults
  const listeners = new Set<() => void>()
  let version = 0, shown: ResultView | undefined
  const holds = new Map<ResultView, number>()
  const results = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => version,
    sortOf: () => shown ? { view: shown } : undefined,
    focusedEntry: () => tab.sets[0],
    holdView: (_tab: string, _key: string, view: ResultView) => {
      holds.set(view, (holds.get(view) ?? 0) + 1)
      let ended = false
      return () => { if (!ended) { ended = true; holds.set(view, holds.get(view)! - 1); if (!holds.get(view)) holds.delete(view) } }
    }
  }
  const workbench = { results, commands: { execute: vi.fn(async () => true) } } as unknown as Workbench
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ColumnProfilePanel, { tabId: 't', tab, shown: 'e1' }) })) })
  const sorted = (keys: ViewSortKey[], filters: ResolvedViewFilter[] = [], built: { complete: boolean; baseRows: number } = { complete: true, baseRows: 1000 }) =>
    Object.assign(handleOf(filters.length ? 400 : built.baseRows), { viewId: ++version * 10, base: handle, keys, filters, rows: 0, approximate: false, ...built }) as unknown as ResultView
  const card = (name: string) => container.querySelector(`section[aria-label="${name}"]`)
  return {
    sorted, card, handle,
    show: (view: ResultView | undefined) => act(() => { shown = view; version++; for (const listener of listeners) listener() }),
    asked: () => asked.length,
    request: (at: number) => asked[at],
    signal: (at: number) => asked[at]?.signal,
    /** The views held open, and how many holds each has. */
    holds: () => [...holds.values()].reduce((sum, count) => sum + count, 0),
    heldViews: () => [...holds.keys()],
    error: () => container.querySelector('.profile-note.error')?.textContent,
    failLast: async (message: string) => { const request = asked[asked.length - 1]; await act(async () => { request.reject(new Error(message)) }) },
    busy: () => container.querySelector('.profile-panel')?.getAttribute('aria-busy') === 'true',
    answerLast: async (rows: number, nulls: number) => {
      const request = asked[asked.length - 1]
      await act(async () => { request.resolve({ rows, complete: true, columns: request.columns.map(column => profileOf(column, rows, nulls)) }) })
    },
    nulls: (name: string) => [...card(name)?.querySelectorAll('dl > div') ?? []].find(item => item.querySelector('dt')?.textContent === 'NULLs')?.querySelector('dd')?.textContent,
    unmount: () => act(() => { root.unmount() })
  }
}
const profileOf = (column: number, rows: number, nulls: number): ColumnProfile => ({ column, values: rows - nulls, nulls, distinct: rows - nulls, distinctExact: true, approximate: false })

describe('column profile panel', () => {
  it('asks 32 columns at a time and gives each card the rows its own request saw', async () => {
    const view = fixture()
    expect(view.asked.map(request => request.columns.length)).toEqual([32])
    await view.answer(0, 1000, 100)
    expect(view.asked.map(request => request.columns)).toEqual([Array.from({ length: 32 }, (_, i) => i), Array.from({ length: 8 }, (_, i) => 32 + i)])
    expect(view.card('c39')?.textContent).toContain('Profiling…')
    // The second request saw more rows of the loading set: each card's share is of its own request's rows.
    await view.answer(1, 2000, 100)
    expect(view.nulls('c0')).toBe('100 (10%)')
    expect(view.nulls('c39')).toBe('100 (5%)')
    view.unmount()
  })

  it('keeps the cards while the completed set is profiled again, and cancels a request when it is no longer wanted', async () => {
    const view = fixture()
    await view.answer(0, 1000, 100)
    await view.answer(1, 1000, 100)
    view.setSnapshot({ state: 'complete', rowsAvailable: 1500 })
    expect(view.asked).toHaveLength(3)
    expect(view.nulls('c39')).toBe('100 (10%)')
    await view.answer(2, 1500, 300)
    expect(view.nulls('c0')).toBe('300 (20%)')
    expect(view.nulls('c39')).toBe('100 (10%)')
    view.setSnapshot({ state: 'released', rowsAvailable: 1500 })
    expect(view.asked[3]?.signal?.aborted ?? view.asked[2].signal?.aborted).toBe(true)
    expect(view.card('c0')).toBeNull()
    view.unmount()
  })

  it('profiles the entry it is given, else the one the stack says had the focus, and names it by its number', () => {
    const given = fixture(40, 'e1')
    expect(given.asked.map(request => request.columns.length)).toEqual([32])
    expect(given.facts()).toContain('Result 1')
    given.unmount()
    // No grid has taken the focus in this pane, or the one that had is gone: the stack's choice, which stands second
    // and is Result 5.
    for (const shown of [null, 'gone']) {
      const fallback = fixture(40, shown)
      expect(fallback.asked.map(request => request.columns)).toEqual([[0, 1]])
      expect(fallback.card('x1')).not.toBeNull()
      expect(fallback.facts()).toContain('Result 5')
      fallback.unmount()
    }
  })

  it('keeps the profile through a sort (column, direction, more keys, Sort Text By) and asks again for other rows', async () => {
    const view = sortFixture()
    expect(view.asked()).toBe(1)
    await view.answerLast(1000, 100)
    expect(view.nulls('c0')).toBe('100 (10%)')
    // From SQL Server's order to a sort, then another column, the other direction, a second key and Sort Text By: each a
    // new view of the same rows. No request, no "Profiling…", the same figures.
    view.show(view.sorted([{ column: 0, descending: false, mode: 'value' }]))
    view.show(view.sorted([{ column: 1, descending: false, mode: 'value' }]))
    view.show(view.sorted([{ column: 1, descending: true, mode: 'value' }]))
    view.show(view.sorted([{ column: 1, descending: true, mode: 'value' }, { column: 0, descending: false, mode: 'value' }]))
    view.show(view.sorted([{ column: 1, descending: true, mode: 'chars' }, { column: 0, descending: false, mode: 'chars' }]))
    // A filter of the same rows by other words (re-applied, so in another order) is the same rows too.
    const values: ResolvedViewFilter = { op: 'in', column: 0, rows: [3, 1], nulls: false }, others: ResolvedViewFilter = { op: 'notIn', column: 1, rows: [9], nulls: false }
    const both = [values, others]
    view.show(view.sorted([{ column: 0, descending: false, mode: 'value' }], [...both]))
    expect(view.asked()).toBe(2)
    await view.answerLast(400, 40)
    view.show(view.sorted([{ column: 1, descending: false, mode: 'value' }], [others, { op: 'in', column: 0, rows: [1, 3], nulls: false }]))
    expect(view.asked()).toBe(2)
    expect(view.nulls('c0')).toBe('40 (10%)')
    expect(view.busy()).toBe(false)
    // Back to SQL Server's order with no filter: other rows than the filter's, so asked again (only the last is kept).
    view.show(undefined)
    expect(view.asked()).toBe(3)
    // Another filter's rows: asked again, and its cards wait for their own figures.
    view.show(view.sorted([], [{ op: 'between', column: 0, rows: [1, 5], nulls: false }]))
    expect(view.asked()).toBe(4)
    expect(view.signal(2)?.aborted).toBe(true)
    expect(view.card('c0')?.textContent).toContain('Profiling…')
    // A view built while the rows still arrived is built again once they are all in: the same filter over more rows.
    view.show(view.sorted([], [{ op: 'between', column: 0, rows: [1, 5], nulls: false }], { complete: false, baseRows: 600 }))
    view.show(view.sorted([], [{ op: 'between', column: 0, rows: [1, 5], nulls: false }], { complete: true, baseRows: 1000 }))
    expect(view.asked()).toBe(6)
    // The view being read stays open while the profile reads it, and is let go when it is done.
    expect(view.holds()).toBe(1)
    await view.answerLast(200, 20)
    expect(view.holds()).toBe(0)
    view.unmount()
  })

  it('lets a profile reading one view finish through a sort, reads on through the newer view, and asks again after a failure on a sort', async () => {
    const view = sortFixture()
    await view.answerLast(1000, 100)
    const filter: ResolvedViewFilter[] = [{ op: 'in', column: 0, rows: [1], nulls: false }]
    const first = view.sorted([{ column: 0, descending: false, mode: 'value' }], filter)
    view.show(first)
    expect(view.request(1).by).toBe(first)
    // Sorted again while the profile reads the first view: no request, the first view stays held, and its answer shows.
    const second = view.sorted([{ column: 1, descending: true, mode: 'value' }], filter)
    view.show(second)
    expect(view.asked()).toBe(2)
    expect(view.signal(1)?.aborted).toBe(false)
    expect(view.heldViews()).toEqual([first])
    await view.answerLast(400, 40)
    expect(view.nulls('c0')).toBe('40 (10%)')
    expect(view.busy()).toBe(false)
    expect(view.holds()).toBe(0)
    // Another filter, read through a view the backend then drops (its views per result are bounded): the grid has sorted
    // since, so the request is made again through its newer view of the same rows.
    const other: ResolvedViewFilter[] = [{ op: 'in', column: 0, rows: [2], nulls: false }]
    const dropped = view.sorted([], other)
    view.show(dropped)
    const newer = view.sorted([{ column: 0, descending: true, mode: 'value' }], other)
    view.show(newer)
    expect(view.asked()).toBe(3)
    await view.failLast('The view is no longer available.')
    expect(view.request(3).by).toBe(newer)
    expect(view.heldViews()).toEqual([newer])
    await view.answerLast(300, 30)
    expect(view.error()).toBeUndefined()
    expect(view.nulls('c0')).toBe('30 (10%)')
    expect(view.holds()).toBe(0)
    // A failure through the view the grid shows stays until the grid shows another view of the rows (a sort): then it is
    // asked again, once.
    const filtered: ResolvedViewFilter[] = [{ op: 'notIn', column: 0, rows: [2], nulls: false }]
    view.show(view.sorted([], filtered))
    expect(view.asked()).toBe(5)
    await view.failLast('There is not enough result memory to profile these rows.')
    expect(view.error()).toContain('not enough result memory')
    expect(view.asked()).toBe(5)
    const sortedAgain = view.sorted([{ column: 1, descending: false, mode: 'value' }], filtered)
    view.show(sortedAgain)
    expect(view.asked()).toBe(6)
    expect(view.request(5).by).toBe(sortedAgain)
    await view.answerLast(600, 60)
    expect(view.error()).toBeUndefined()
    expect(view.nulls('c0')).toBe('60 (10%)')
    view.show(view.sorted([{ column: 1, descending: true, mode: 'value' }], filtered))
    expect(view.asked()).toBe(6)
    view.unmount()
  })

  it('follows a query\'s own result by its number into the next run, and a derived result only as itself', () => {
    const entry = (key: string, ordinal?: number) => ({ key, ...ordinal === undefined ? {} : { ordinal } }) as ResultSetEntry
    const first = [entry('e1', 1), entry('e2', 2), entry('e3')]
    expect(profileTarget(first, 'e2')).toEqual({ entry: 'e2', ordinal: 2 })
    expect(profileTarget(first, 'e3')).toEqual({ entry: 'e3' })
    expect(profiledEntry(first, profileTarget(first, 'e2'))).toBe(first[1])
    // The entry before it went: still the same entry, though it stands first now.
    expect(profiledEntry([first[1], first[2]], profileTarget(first, 'e2'))).toBe(first[1])
    // The query ran again: other keys. Result 2 is profiled again once it arrives, and not whatever stands second.
    const next = [entry('e7', 1), entry('e9', 3), entry('e8', 2)]
    expect(profiledEntry(next.slice(0, 2), profileTarget(first, 'e2'))).toBeUndefined()
    expect(profiledEntry(next, profileTarget(first, 'e2'))).toBe(next[2])
    expect(profiledEntry(next, profileTarget(first, 'e3'))).toBeUndefined()
    expect(profiledEntry(next, undefined)).toBeUndefined()
  })
})
