// @vitest-environment happy-dom
// The column profile panel: requests of at most 32 columns, each card's NULL share from the rows its own request saw,
// cards kept while the same rows are profiled again, a request cancelled when the grid shows other rows, and no request
// for a sort of the same rows.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ColumnProfile, ResolvedViewFilter, ResultsProfileResult, ViewSortKey } from '../src/shared/contracts'
import { ResultError, type ResultView } from '../src/renderer/src/results/ResultClient'
import type { ErrorCode } from '../src/shared/ipc/wire/protocol'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ColumnProfilePanel, { profiledEntry, profileTarget } from '../src/renderer/src/results/ColumnProfilePanel'
import type { ResultSetEntry, TabResults } from '../src/renderer/src/results/ResultsService'
import { ResultOperations } from '../src/renderer/src/results/operations'
import type { OperationProgressListener } from '../src/renderer/src/results/ResultClient'
import { manualTimers } from './fixtures/workbench'
import { gesturesFor } from '../src/renderer/src/core/gestures'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { ProfilePeekService } from '../src/renderer/src/results/ProfilePeekService'
import { peekLimits } from '../src/shared/explorer/peek'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The panel's other services: settings (Selected Columns Only, which its button and Show all toggle), the grid's selection
 * as ResultsService keeps it (with Select Column), the peek and the gestures. They are added to `results`.
 */
function panelServices(results: object) {
  const timers = manualTimers()
  const listeners = { settings: new Set<() => void>(), selection: new Set<() => void>() }
  let settings = { values: { 'queryResults.grid.columnProfileSelectedOnly': false } }
  let selection: GridSelection | undefined, revision = 0
  const setOnly = (on: boolean) => { settings = { values: { 'queryResults.grid.columnProfileSelectedOnly': on } }; for (const listener of listeners.settings) listener() }
  const selectColumn = vi.fn()
  Object.assign(results, {
    selections: { subscribe: (listener: () => void) => { listeners.selection.add(listener); return () => listeners.selection.delete(listener) }, getSnapshot: () => revision },
    selection: (_tab: string, key: string) => selection?.entry === key ? selection : undefined,
    selectColumn
  })
  const profilePeek = new ProfilePeekService({ gestures: gesturesFor('win32'), timers: timers.timers })
  const commands = { execute: vi.fn(async (id: string) => { if (id === 'output.toggleProfileSelectedColumns') setOnly(!settings.values['queryResults.grid.columnProfileSelectedOnly']); return true }) }
  const services = {
    commands, profilePeek, gestures: gesturesFor('win32'),
    settings: { subscribe: (listener: () => void) => { listeners.settings.add(listener); return () => listeners.settings.delete(listener) }, getSnapshot: () => settings }
  }
  return {
    services, selectColumn, commands,
    select: (next: GridSelection | undefined) => act(() => { selection = next; revision++; for (const listener of listeners.selection) listener() }),
    setOnly: (on: boolean) => act(() => setOnly(on)),
    peek: (held: boolean) => act(() => { if (held) { profilePeek.pointer('t', true); timers.advance(peekLimits.pressMs) } else profilePeek.keyUp('Control') })
  }
}

interface Asked { columns: number[]; signal?: AbortSignal; progress?: OperationProgressListener; resolve(result: ResultsProfileResult): void; reject(error: unknown): void }

function fixture(columns = 40, shown: string | null = 'e1', name?: string, derived?: { readonly kind: 'diff' | 'pivot'; readonly label: string; readonly number: number }) {
  const listeners = new Set<() => void>()
  let snapshot = { state: 'open', rowsAvailable: 1000 }
  const asked: Asked[] = []
  const handle = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    profile: vi.fn((cols: number[], signal?: AbortSignal, progress?: OperationProgressListener) => new Promise<ResultsProfileResult>((resolve, reject) => { asked.push({ columns: cols, signal, progress, resolve, reject }) }))
  }
  const descriptor = { columns: Array.from({ length: columns }, (_, index) => ({ name: 'c' + index, dataType: 'int' })), ...name ? { name } : {}, ...derived ? { kind: derived.kind } : {} }
  // Result 1, and a result numbered 5 that stands second (the ones between have gone) and has two columns of its own.
  const other = { columns: [{ name: 'x0', dataType: 'int' }, { name: 'x1', dataType: 'int' }] }
  const tab = { sets: [{ key: 'e1', number: derived?.number ?? 1, descriptor, handle, ...derived ? { label: derived.label } : {} }, { key: 'e5', number: 5, descriptor: other, handle }] } as unknown as TabResults
  // The panel is told which grid took the focus; without one it asks the stack, which names the second.
  const timers = manualTimers()
  const results = { subscribe: () => () => {}, getSnapshot: () => 0, sortOf: () => undefined, focusedEntry: () => tab.sets[1], operations: new ResultOperations({ timers: timers.timers }) }
  const panel = panelServices(results)
  const workbench = { results, ...panel.services } as unknown as Workbench
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
  const subject = () => container.querySelector('.profile-subject')?.textContent
  const cards = () => [...container.querySelectorAll<HTMLElement>('.profile-cards > section')]
  const strip = () => container.querySelector('.profile-strip')?.textContent
  return { asked, answer, setSnapshot, card, cards, strip, nulls, facts, subject, results, timers, panel, container, unmount: () => act(() => { root.unmount() }) }
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
    operations: new ResultOperations({ timers: manualTimers().timers }),
    holdView: (_tab: string, _key: string, view: ResultView) => {
      holds.set(view, (holds.get(view) ?? 0) + 1)
      let ended = false
      return () => { if (!ended) { ended = true; holds.set(view, holds.get(view)! - 1); if (!holds.get(view)) holds.delete(view) } }
    }
  }
  const workbench = { results, ...panelServices(results).services } as unknown as Workbench
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
    failLast: async (code: ErrorCode, message: string) => { const request = asked[asked.length - 1]; await act(async () => { request.reject(new ResultError(code, message)) }) },
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
    await view.failLast('VIEW_NOT_FOUND', 'This sorted view was closed. Sort the results again.')
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
    await view.failLast('TOO_LARGE', 'There is not enough result memory to profile these rows.')
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

  it('reports a failure other than a dropped view without sending it again, and asks once for other rows after a failure', async () => {
    const view = sortFixture()
    await view.answerLast(1000, 100)
    const filter: ResolvedViewFilter[] = [{ op: 'in', column: 0, rows: [1], nulls: false }]
    view.show(view.sorted([], filter))
    // Sorted while the profile runs; the profile then times out: reported as it is, not sent through the newer view.
    view.show(view.sorted([{ column: 0, descending: false, mode: 'value' }], filter))
    expect(view.asked()).toBe(2)
    await view.failLast('TIMEOUT', 'The profile took too long.')
    expect(view.asked()).toBe(2)
    expect(view.error()).toContain('took too long')
    expect(view.holds()).toBe(0)
    // Another filter after the failure: one request, not one for the rows and another for the retry.
    view.show(view.sorted([], [{ op: 'notIn', column: 0, rows: [1], nulls: false }]))
    expect(view.asked()).toBe(3)
    expect(view.signal(2)?.aborted).toBe(false)
    await view.answerLast(900, 90)
    expect(view.error()).toBeUndefined()
    expect(view.nulls('c0')).toBe('90 (10%)')
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

  it('names a named result by its name with its number, in its facts and in the toolbar', async () => {
    const view = fixture(2, 'e1', 'Totals')
    act(() => { view.timers.advance(300) })
    expect(view.facts()).toBe('Totals, Result 1')
    expect(view.results.operations.getSnapshot().t?.items).toMatchObject([{ kind: 'profile', target: 'Totals, Result 1' }])
    await view.answer(0, 10, 0)
    view.unmount()
  })

  it('names a comparison by its own name under the title and in the toolbar, never by the number it was given', async () => {
    const view = fixture(2, 'e1', undefined, { kind: 'diff', label: 'Differences: Result 1 → Result 2', number: 3 })
    act(() => { view.timers.advance(300) })
    const panel = view.container.querySelector('.profile-panel')!
    expect(panel.querySelector('.profile-title')?.textContent).toBe('Column profile')
    expect(view.subject()).toBe('Differences: Result 1 → Result 2')
    expect(panel.getAttribute('aria-description')).toBe('Differences: Result 1 → Result 2')
    expect(view.facts()).toBe('')
    expect(view.results.operations.getSnapshot().t?.items).toMatchObject([{ kind: 'profile', target: 'Differences: Result 1 → Result 2' }])
    await view.answer(0, 10, 0)
    expect(view.facts()).toBe('10 rows so far')
    expect(panel.textContent).not.toContain('Result 3')
    view.unmount()
  })

  it('names a Pivot by its own name, and an original result has no line under the title', async () => {
    const pivot = fixture(2, 'e1', undefined, { kind: 'pivot', label: 'Pivot of Result 1', number: 4 })
    act(() => { pivot.timers.advance(300) })
    expect(pivot.facts()).toBe('Pivot of Result 1')
    expect(pivot.subject()).toBeUndefined()
    expect(pivot.results.operations.getSnapshot().t?.items).toMatchObject([{ kind: 'profile', target: 'Pivot of Result 1' }])
    pivot.unmount()
    const original = fixture(2, 'e1')
    expect(original.subject()).toBeUndefined()
    expect(original.container.querySelector('.profile-panel')?.hasAttribute('aria-description')).toBe(false)
    original.unmount()
  })

  it('shows its progress across every request in the toolbar, and a cancel keeps the cards it has', async () => {
    const view = fixture()
    const ops = () => view.results.operations.getSnapshot().t
    act(() => { view.asked[0].progress?.('profile', 50); view.timers.advance(300) })
    expect(ops()?.items).toMatchObject([{ kind: 'profile', target: 'Result 1', entry: 'e1', shown: true, phase: 'profile', percent: 25 }])
    await view.answer(0, 1000, 100)
    act(() => { view.asked[1].progress?.('histogram', 40) })
    expect(ops()?.items[0]?.percent).toBe(70)
    act(() => { view.results.operations.cancel('t') })
    expect(view.asked[1].signal?.aborted).toBe(true)
    // The client rejects a request its signal stopped.
    await act(async () => { view.asked[1].reject(new Error('Cancelled')) })
    expect(ops()).toMatchObject({ items: [], notice: 'Profile cancelled.' })
    expect(view.nulls('c0')).toBe('100 (10%)')
    view.unmount()
  })
})

describe('column profile selection peek', () => {
  const columns = (entry: string, from: number, to: number, active = to): GridSelection =>
    ({ entry, blocks: [{ kind: 'columns', anchor: { row: 0, column: from }, focus: { row: 0, column: to } }], active: { row: 0, column: active } })
  const names = (cards: HTMLElement[]) => cards.map(card => card.getAttribute('aria-label'))

  it('highlights the selected columns\' cards and marks the active cell\'s column, following the selection', () => {
    const view = fixture(6)
    expect(view.cards().filter(card => card.classList.contains('selected'))).toEqual([])
    view.panel.select(columns('e1', 2, 3))
    expect(names(view.cards().filter(card => card.classList.contains('selected')))).toEqual(['c2', 'c3'])
    expect(names(view.cards().filter(card => card.getAttribute('aria-current') === 'true'))).toEqual(['c3'])
    expect(view.card('c3')?.textContent).toContain('Selected')
    // The active column's card is the cards' one Tab stop.
    expect(names(view.cards().filter(card => card.tabIndex === 0))).toEqual(['c3'])
    // Another result's selection marks nothing here.
    view.panel.select(columns('e5', 0, 1))
    expect(view.cards().filter(card => card.classList.contains('selected'))).toEqual([])
    expect(names(view.cards().filter(card => card.tabIndex === 0))).toEqual(['c0'])
    view.unmount()
  })

  it('lists only the selected columns with Selected Columns Only, follows the selection there, and Show all turns it off', async () => {
    const view = fixture(6)
    view.panel.select(columns('e1', 1, 2))
    const toggle = view.container.querySelector<HTMLButtonElement>('button[aria-label="Selected Columns Only"]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.title).toBe('Selected Columns Only (Ctrl-hover the panel to peek)')
    await act(async () => { toggle.click() })
    expect(view.panel.commands.execute).toHaveBeenCalledWith('output.toggleProfileSelectedColumns', undefined, 'toolbar')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(names(view.cards())).toEqual(['c1', 'c2'])
    expect(view.strip()).toBe('2 of 6 columnsShow all')
    view.panel.select(columns('e1', 4, 4))
    expect(names(view.cards())).toEqual(['c4'])
    // Profiles were asked for every column, so the list changes without a request.
    expect(view.asked.length).toBe(1)
    view.panel.select(undefined)
    expect(view.cards()).toEqual([])
    expect(view.container.textContent).toContain('Select cells or columns in the grid to see their profiles here.')
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.profile-strip-action')!.click() })
    expect(view.cards()).toHaveLength(6)
    expect(view.strip()).toBeUndefined()
    view.unmount()
  })

  it('shows the other list while Ctrl is held over the panel, and says so once', () => {
    const view = fixture(6)
    const said = () => view.container.querySelector('.visually-hidden[role="status"]')?.textContent
    view.panel.select(columns('e1', 0, 1))
    expect(said()).toBe('')
    view.panel.peek(true)
    expect(names(view.cards())).toEqual(['c0', 'c1'])
    expect(view.strip()).toBe('Peeking at 2 selected columns · release to show all')
    expect(said()).toBe('Showing 2 of 6 columns')
    view.panel.peek(false)
    expect(view.cards()).toHaveLength(6)
    expect(said()).toBe('Showing all columns')
    view.panel.setOnly(true)
    view.panel.peek(true)
    expect(view.cards()).toHaveLength(6)
    expect(view.strip()).toBe('Peeking at all 6 columns · release to go back')
    view.panel.peek(false)
    expect(view.cards()).toHaveLength(2)
    view.unmount()
  })

  it('selects a card\'s column in the grid on a click, Enter or Space, and moves between cards with the arrows, Home and End', () => {
    const view = fixture(4)
    document.body.append(view.container)
    // Each card says what Enter does, through a description the cards share.
    const hint = view.card('c2')!.getAttribute('aria-describedby')!
    expect(view.cards().every(card => card.getAttribute('aria-describedby') === hint)).toBe(true)
    expect(document.getElementById(hint)?.textContent).toBe('Enter selects this column in the grid.')
    act(() => { view.card('c2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(view.panel.selectColumn).toHaveBeenLastCalledWith('t', 'e1', 2)
    const press = (key: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    act(() => { (view.card('c1') as HTMLElement).focus() })
    press('ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('c2')
    press('End')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('c3')
    press('ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('c3')
    press('Home')
    press('ArrowUp')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('c0')
    press('Enter')
    expect(view.panel.selectColumn).toHaveBeenLastCalledWith('t', 'e1', 0)
    press('ArrowDown')
    press(' ')
    expect(view.panel.selectColumn).toHaveBeenLastCalledWith('t', 'e1', 1)
    // A focused card that leaves the list (Selected Columns Only) hands the focus to the active column's card, not the page.
    act(() => { (view.card('c3') as HTMLElement).focus() })
    view.panel.select(columns('e1', 1, 2))
    view.panel.setOnly(true)
    expect(view.card('c3')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('c2')
    view.unmount()
    view.container.remove()
  })
})
