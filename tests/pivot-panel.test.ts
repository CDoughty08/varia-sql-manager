// @vitest-environment happy-dom
// The pivot builder's foot: its waiting notes go into a live region mounted with the builder, outside the part marked
// busy while it builds, so a screen reader announces them.
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { emptyDraft } from '../src/renderer/src/results/pivot'
import PivotPanel from '../src/renderer/src/results/PivotPanel'
import { windowedPivotText, type PivotTab } from '../src/renderer/src/results/PivotService'
import type { TabResults } from '../src/renderer/src/results/ResultsService'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('pivot builder', () => {
  it('announces waiting for a place and for a busy backend from a live region outside the busy controls', () => {
    const listeners = new Set<() => void>()
    let snapshot = { tabs: { t: { open: true, source: 'e1', sourceName: 'Result 1', draft: emptyDraft, running: false } as PivotTab }, info: new Map() }
    const set = (tab: Partial<PivotTab>) => act(() => { snapshot = { ...snapshot, tabs: { t: { ...snapshot.tabs.t, ...tab } as PivotTab } }; for (const listener of listeners) listener() })
    const pivot = { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => snapshot, canPivot: () => true, cancel: vi.fn(), close: vi.fn(), run: vi.fn(), setDraft: vi.fn() }
    const results = { subscribe: () => () => {}, getSnapshot: () => 0, sortOf: () => undefined }
    const handle = { getSnapshot: () => ({ state: 'complete' }) }
    const descriptor = { kind: 'rows', rowsStored: 3, columns: [{ name: 'Region', dataType: 'nvarchar(10)', wire: 'text', nullable: true }] }
    const tab = { sets: [{ key: 'e1', number: 1, descriptor, handle, label: 'Result 1' }] } as unknown as TabResults
    const workbench = { pivot, results } as unknown as Workbench
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(PivotPanel, { tabId: 't', tab }) })) })
    const status = () => [...container.querySelectorAll('[role="status"]')].find(element => !element.classList.contains('error'))!
    const live = status()
    expect(live.textContent).toBe('')
    set({ running: true, queued: 'place' })
    // The same region, now saying why it waits, with no busy ancestor; the draft's controls are the busy part.
    expect(status()).toBe(live)
    expect(live.textContent).toBe('Waiting for other pivots and comparisons to finish: four build at once.')
    expect(live.closest('[aria-busy]')).toBeNull()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    set({ queued: 'busy' })
    expect(live.textContent).toBe('The backend is busy, so the pivot is asked again in a moment.')
    set({ running: false, queued: undefined })
    expect(live.textContent).toBe('')
    expect(container.querySelector('[aria-busy]')).toBeNull()
    // The source is named as the service names it: with its number when another result of the run has its name.
    set({ sourceName: 'Totals (Result 1)', pivot: 'e9' })
    expect(container.querySelector('.pivot-source')!.textContent).toBe('Totals (Result 1)')
    expect(container.textContent).toContain('Building again replaces Pivot of Totals (Result 1) once the new one is built.')
    // The Pivot it replaces is named by its own title, fixed when made, though the source has since lost its number.
    ;(tab.sets as unknown[]).push({ key: 'e9', number: 2, descriptor: { ...descriptor, kind: 'pivot' }, handle, label: 'Pivot of Totals (Result 1)' } as never)
    set({ sourceName: 'Totals' })
    expect(container.querySelector('.pivot-source')!.textContent).toBe('Totals')
    expect(container.textContent).toContain('Building again replaces Pivot of Totals (Result 1) once the new one is built.')
    act(() => { root.unmount() })
  })
  it('says a result windowed in BigQuery cannot be pivoted yet, rather than offering to build it', () => {
    const snapshot = { tabs: { t: { open: true, source: 'e1', sourceName: 'Result 1', draft: emptyDraft, running: false } as PivotTab }, info: new Map() }
    const pivot = { subscribe: () => () => {}, getSnapshot: () => snapshot, canPivot: () => false, cancel: vi.fn(), close: vi.fn(), run: vi.fn(), setDraft: vi.fn() }
    const results = { subscribe: () => () => {}, getSnapshot: () => 0, sortOf: () => undefined }
    const handle = { getSnapshot: () => ({ state: 'complete', residence: 'remote' }) }
    const descriptor = { kind: 'rows', rowsStored: 0, columns: [{ name: 'Region', dataType: 'STRING', wire: 'text', nullable: true }] }
    const tab = { sets: [{ key: 'e1', number: 1, descriptor, handle, label: 'Result 1' }] } as unknown as TabResults
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(createElement(WorkbenchProvider, { workbench: { pivot, results } as unknown as Workbench, children: createElement(PivotPanel, { tabId: 't', tab }) })) })
    expect(container.textContent).toContain(windowedPivotText)
    act(() => { root.unmount() })
  })
})
