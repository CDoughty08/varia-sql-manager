// @vitest-environment happy-dom
// The column profile panel: requests of at most 32 columns, each card's NULL share from the rows its own request saw,
// cards kept while the same rows are profiled again, and a request cancelled when the grid shows other rows.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ColumnProfile, ResultsProfileResult } from '../src/shared/contracts'
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
