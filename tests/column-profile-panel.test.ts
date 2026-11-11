// @vitest-environment happy-dom
// The column profile panel: requests of at most 32 columns, each card's NULL share from the rows its own request saw,
// cards kept while the same rows are profiled again, and a request cancelled when the grid shows other rows.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ColumnProfile, ResultsProfileResult } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ColumnProfilePanel from '../src/renderer/src/results/ColumnProfilePanel'
import type { TabResults } from '../src/renderer/src/results/ResultsService'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Asked { columns: number[]; signal?: AbortSignal; resolve(result: ResultsProfileResult): void; reject(error: unknown): void }

function fixture(columns = 40) {
  const listeners = new Set<() => void>()
  let snapshot = { state: 'open', rowsAvailable: 1000 }
  const asked: Asked[] = []
  const handle = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    profile: vi.fn((cols: number[], signal?: AbortSignal) => new Promise<ResultsProfileResult>((resolve, reject) => { asked.push({ columns: cols, signal, resolve, reject }) }))
  }
  const descriptor = { columns: Array.from({ length: columns }, (_, index) => ({ name: 'c' + index, dataType: 'int' })) }
  const tab = { sets: [{ key: 'e1', number: 1, descriptor, handle }, { key: 'e2', number: 2, descriptor: { columns: [] }, handle }] } as unknown as TabResults
  // The panel is told which grid took the focus; the one the stack names (the second) is not asked for.
  const results = { subscribe: () => () => {}, getSnapshot: () => 0, sortOf: () => undefined, focusedEntry: () => tab.sets[1] }
  const workbench = { results, commands: { execute: vi.fn(async () => true) } } as unknown as Workbench
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ColumnProfilePanel, { tabId: 't', tab, shown: 'e1' }) })) })
  const answer = async (at: number, rows: number, nulls: number) => {
    const request = asked[at]
    await act(async () => { request.resolve({ rows, complete: snapshot.state === 'complete', columns: request.columns.map(column => profileOf(column, rows, nulls)) }) })
  }
  const setSnapshot = (next: typeof snapshot) => act(() => { snapshot = next; for (const listener of listeners) listener() })
  const card = (name: string) => container.querySelector(`section[aria-label="${name}"]`)
  const nulls = (name: string) => [...card(name)?.querySelectorAll('dl > div') ?? []].find(item => item.querySelector('dt')?.textContent === 'NULLs')?.querySelector('dd')?.textContent
  return { asked, answer, setSnapshot, card, nulls, unmount: () => act(() => { root.unmount() }) }
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
})
