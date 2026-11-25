// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../src/renderer/src/core/events'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import MemoryIndicator from '../src/renderer/src/results/MemoryIndicator'
import { memoryLevel, memoryTotalLabel, MemoryUsageService } from '../src/renderer/src/results/memory'
import { resultTargets } from '../src/renderer/src/results/memory-details'
import { formatBytes } from '../src/renderer/src/results/status'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import type { ResultMemoryDetail } from '../src/shared/contracts'
import type { MemoryReport } from '../src/shared/ipc/port-messages'
import { defaultSettings } from '../src/shared/settings/catalog'
import { stylesheetRules } from './fixtures/css-rules'
import { summaryOf } from './fixtures/results'
import { settingsApi } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { CloseWatcher?: unknown }).CloseWatcher = class extends EventTarget { destroy() {} }

const MB = 1048576
describe('result memory', () => {
  it('shows bytes as the status bar does: under 1 MB, whole megabytes to 9,999, then gigabytes', () => {
    expect([0, MB - 1, MB, 1.4 * MB, 9999 * MB, 9999.4 * MB, 10_000 * MB, 1.25 * 1024 * MB * 10].map(formatBytes))
      .toEqual(['<1 MB', '<1 MB', '1 MB', '1 MB', '9,999 MB', '9,999 MB', '9.8 GB', '12.5 GB'])
  })
  it('follows the backend\'s pushes, each summary\'s budget, and closes; it warns from 90 %', () => {
    const listeners = new Set<(memory: MemoryReport) => void>()
    const events = new EventBus()
    const service = new MemoryUsageService({ onMemory: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } } }, 'results', events)
    const changes: unknown[] = []
    service.subscribe(() => changes.push(service.getSnapshot()))
    for (const listener of listeners) listener({ usedBytes: 10 * MB, globalBytes: 100 * MB, generation: 1, seq: 1 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 10 * MB, globalBytes: 100 * MB })
    expect(memoryLevel(service.getSnapshot(), 'results')).toBe('normal')
    events.emit({ type: 'query.finished', tabId: 't', queryId: 'q', summary: summaryOf([], { budget: { usedBytes: 92 * MB, globalBytes: 100 * MB, queryBytes: 50 * MB, generation: 1, seq: 2 } }) })
    expect(memoryLevel(service.getSnapshot(), 'results')).toBe('warning')
    // A close reports only what is used; the budget stays.
    service.update({ usedBytes: 0, globalBytes: 0, generation: 1, seq: 3 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 0, globalBytes: 100 * MB })
    service.update({ usedBytes: 0, globalBytes: 0, generation: 1, seq: 4 })
    expect(changes).toHaveLength(3)
    service.dispose()
    expect(listeners.size).toBe(0)
    expect(memoryLevel({ usedBytes: 1, globalBytes: 0 }, 'results')).toBe('unavailable')
  })
  it('never shows a figure older than the one it shows: a summary overtaken by a close, or a backend that was replaced', () => {
    const listeners = new Set<(memory: MemoryReport) => void>()
    const events = new EventBus()
    const service = new MemoryUsageService({ onMemory: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } } }, 'results', events)
    const push = (memory: MemoryReport) => { for (const listener of listeners) listener(memory) }
    const finish = (usedBytes: number, generation: number, seq: number) =>
      events.emit({ type: 'query.finished', tabId: 't', queryId: 'q', summary: summaryOf([], { budget: { usedBytes, globalBytes: 2048 * MB, queryBytes: 1024 * MB, generation, seq } }) })
    push({ usedBytes: 0, globalBytes: 0, generation: 1, seq: 0 })
    finish(32 * MB, 1, 1)
    // Tab 2's summary took its figure (42 MB, #2), then tab 1's Close Results sent the fall (#3) before the summary went out.
    push({ usedBytes: 10 * MB, globalBytes: 2048 * MB, generation: 1, seq: 3 })
    finish(42 * MB, 1, 2)
    expect(service.getSnapshot()).toEqual({ usedBytes: 10 * MB, globalBytes: 2048 * MB })
    // The same report twice, or an older event, changes nothing; a later summary does.
    push({ usedBytes: 99 * MB, globalBytes: 2048 * MB, generation: 1, seq: 3 })
    push({ usedBytes: 99 * MB, globalBytes: 2048 * MB, generation: 1, seq: 1 })
    expect(service.getSnapshot().usedBytes).toBe(10 * MB)
    finish(11 * MB, 1, 4)
    expect(service.getSnapshot().usedBytes).toBe(11 * MB)
    // A new backend holds nothing, whatever the old one still sends; its own reports count from 1 again.
    push({ usedBytes: 0, globalBytes: 0, generation: 2, seq: 0 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 0, globalBytes: 0 })
    finish(50 * MB, 1, 9)
    push({ usedBytes: 60 * MB, globalBytes: 2048 * MB, generation: 1, seq: 10 })
    expect(service.getSnapshot().usedBytes).toBe(0)
    push({ usedBytes: 3 * MB, globalBytes: 2048 * MB, generation: 2, seq: 1 })
    expect(service.getSnapshot().usedBytes).toBe(3 * MB)
    // With no backend (generation 0) the last one's late reports are dropped too, until the next one reports.
    push({ usedBytes: 0, globalBytes: 0, generation: 0, seq: 0 })
    push({ usedBytes: 7 * MB, globalBytes: 2048 * MB, generation: 2, seq: 2 })
    expect(service.getSnapshot().usedBytes).toBe(0)
    push({ usedBytes: 0, globalBytes: 0, generation: 3, seq: 0 })
    finish(5 * MB, 3, 1)
    expect(service.getSnapshot().usedBytes).toBe(5 * MB)
    service.dispose()
  })

  it('warns at 75% for index memory, at 90% for results, and turns critical at 95% for both', () => {
    const usage = (usedBytes: number) => ({ usedBytes, globalBytes: 1000 })
    expect([0, 749, 750, 949, 950, 1001].map(used => memoryLevel(usage(used), 'index')))
      .toEqual(['normal', 'normal', 'warning', 'warning', 'critical', 'critical'])
    expect([0, 899, 900, 949, 950, 1001].map(used => memoryLevel(usage(used), 'results')))
      .toEqual(['normal', 'normal', 'warning', 'warning', 'critical', 'critical'])
  })

  it('caps the biggest-result tab name instead of crushing it with flex-shrink: 1000', () => {
    const rule = stylesheetRules().find(entry => entry.selector === '.memory-biggest-name > .memory-biggest-tab')
    const declared = Object.fromEntries(rule?.declarations.map(item => [item.property, item.value]) ?? [])
    expect(declared['flex']).toBe('0 1 auto')
    expect(declared['max-width']).toBe('42%')
    expect(declared['flex-shrink']).toBeUndefined()
  })

  it('formats the live memory total for the status trigger, falling back to undefined when 0 MB or unavailable', () => {
    expect(memoryTotalLabel({ usedBytes: 0, globalBytes: 0 }, { usedBytes: 0, globalBytes: 0 })).toBeUndefined()
    expect(memoryTotalLabel({ usedBytes: 0, globalBytes: 512 * MB }, { usedBytes: 0, globalBytes: 256 * MB })).toBeUndefined()
    expect(memoryTotalLabel({ usedBytes: 32 * MB, globalBytes: 512 * MB }, { usedBytes: 115 * MB, globalBytes: 256 * MB })).toBe('147 MB')
    expect(memoryTotalLabel({ usedBytes: 0, globalBytes: 0 }, { usedBytes: 236 * MB, globalBytes: 256 * MB })).toBe('236 MB')
  })

  it('maps Biggest results entries to their owning tab, entry key and running state', () => {
    const tabs = {
      t1: { status: 'completed', sets: [{ key: 'e1', descriptor: { generation: 2, resultId: 10 } }] },
      t2: { status: 'running', sets: [{ key: 'e2', descriptor: { generation: 2, resultId: 11 } }] },
      t3: { status: 'completed', bare: true as const, sets: [{ key: 'e3', descriptor: { generation: 2, resultId: 12 } }] },
      t4: { status: 'closed', sets: [{ key: 'e4', descriptor: { generation: 2, resultId: 13 } }] }
    }
    const targets = resultTargets(tabs, 2, id => id === 't1')
    expect(targets.get(10)).toEqual({ tabId: 't1', entryKey: 'e1', running: true })
    expect(targets.get(11)).toEqual({ tabId: 't2', entryKey: 'e2', running: true })
    expect(targets.has(12)).toBe(false)
    expect(targets.has(13)).toBe(false)
  })
})

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

const emptyCodec = { pagesPacked: 0, pagesUnpacked: 0, packInputBytes: 0, packMicroseconds: 0, unpackOutputBytes: 0, unpackMicroseconds: 0, cacheHits: 0, cacheLookups: 0, lastUnpackMicroseconds: 0 }

interface TabEntryStub { readonly key: string; readonly number: number; readonly descriptor: { readonly generation: number; readonly resultId: number; readonly name?: string }; readonly label?: string }
interface TabStub { readonly status: string; readonly bare?: true; readonly sets: readonly TabEntryStub[]; readonly planSets?: readonly TabEntryStub[] }

class FakeResultsStore extends SnapshotStore<Readonly<Record<string, TabStub>>> {
  readonly removeEntry = vi.fn((tabId: string, key: string): boolean => {
    const snapshot = this.getSnapshot()
    const tab = snapshot[tabId]
    if (!tab || tab.bare || tab.status === 'running' || tab.status === 'closed') return false
    const sets = tab.sets.filter(entry => entry.key !== key)
    if (sets.length === tab.sets.length) return false
    this.publish({ ...snapshot, [tabId]: { ...tab, sets } })
    return true
  })
  readonly closeAllResults = vi.fn((isRunning?: (tabId: string) => boolean): number => {
    const snapshot = this.getSnapshot()
    const next: Record<string, TabStub> = { ...snapshot }
    let closed = 0
    for (const [tabId, tab] of Object.entries(snapshot)) {
      if (tab.bare || tab.status === 'running' || tab.status === 'closed' || isRunning?.(tabId)) continue
      if (tab.sets.length === 0 && (tab.planSets?.length ?? 0) === 0) continue
      next[tabId] = { ...tab, status: 'closed', sets: [], planSets: [] }
      closed++
    }
    if (closed > 0) this.publish(next)
    return closed
  })
  closing(tabId: string, key: string): readonly TabEntryStub[] {
    const found = this.getSnapshot()[tabId]?.sets.find(entry => entry.key === key)
    return found ? [found] : []
  }
}

async function mountIndicator(opts: {
  indexBytes?: number
  indexBudget?: number
  resultBytes?: number
  resultBudget?: number
  tabs?: Record<string, TabStub>
  docs?: { readonly id: string; readonly name: string }[]
  runningTabs?: Record<string, { readonly running?: { readonly queryId: string } }>
  largest?: ResultMemoryDetail['largest']
  nerdOpen?: boolean
  pin?: boolean
}) {
  const host = document.createElement('div')
  document.body.append(host)
  const client = { onMemory: () => ({ dispose: () => {} }) }
  const indexMemory = new MemoryUsageService(client, 'index')
  const resultMemory = new MemoryUsageService(client, 'results')
  if (opts.indexBudget !== undefined) indexMemory.update({ usedBytes: opts.indexBytes ?? 0, globalBytes: opts.indexBudget, generation: 1, seq: 1 })
  if (opts.resultBudget !== undefined) {
    const detail: ResultMemoryDetail | undefined = opts.largest ? {
      logicalBytes: opts.resultBytes ?? 0, storedBytes: opts.resultBytes ?? 0, compressedBytes: 0, packedLogicalBytes: 0, cacheBytes: 0,
      largest: opts.largest, codec: emptyCodec, heap: { committedBytes: 256 * MB, freeBytes: 32 * MB }
    } : undefined
    resultMemory.update({ usedBytes: opts.resultBytes ?? 0, globalBytes: opts.resultBudget, generation: 1, seq: 1, ...detail ? { detail } : {} })
  }
  const seed = { 'environment.statusBar.memoryNerdMetrics': opts.nerdOpen ?? true }
  const settings = new SettingsService(settingsApi(seed) as never, { ...defaultSettings, ...seed })
  const results = new FakeResultsStore(opts.tabs ?? {})
  const documents = new SnapshotStore({ documents: opts.docs ?? [] })
  const queries = new SnapshotStore(opts.runningTabs ?? {})
  const menus = { ownsKeyboard: () => false, controller: { subscribe: () => () => {} } }
  const theme = { getSnapshot: () => ({ active: { colors: {} } }), subscribe: () => () => {} }
  const live = { page: { hidden: () => false, subscribe: () => () => {} } }
  const workbench = { resultMemory, indexMemory, menus, settings, results, documents, queries, theme, live } as unknown as Workbench
  const root = createRoot(host)
  await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(MemoryIndicator) })) })
  cleanups.push(() => { act(() => { root.unmount() }); host.remove(); settings.dispose() })
  const trigger = () => host.querySelector<HTMLButtonElement>('.memory-indicator')!
  const panel = () => document.body.querySelector<HTMLElement>('.memory-details')!
  if (opts.pin !== false) await act(async () => { trigger().click() })
  return { host, trigger, panel, results, documents, queries, resultMemory, indexMemory }
}

describe('MemoryIndicator live label and quick-free actions', () => {
  it('shows the live combined MB figure beside the rings and falls back to Memory when 0 MB or unavailable', async () => {
    const unavailable = await mountIndicator({ pin: false })
    expect(unavailable.trigger().textContent).toBe('Memory')
    expect(unavailable.trigger().getAttribute('aria-label')).toBe('Memory usage. Search Indexer unavailable, Results unavailable.')

    const live = await mountIndicator({ indexBytes: 32 * MB, indexBudget: 512 * MB, resultBytes: 115 * MB, resultBudget: 256 * MB, pin: false })
    expect(live.trigger().textContent).toBe('147 MB')
    expect(live.trigger().getAttribute('aria-label')).toContain('Memory usage, 147 MB.')
    expect(live.trigger().getAttribute('aria-label')).toContain('Search Indexer 6%, Results 44%')

    await act(async () => {
      live.indexMemory.update({ usedBytes: 0, globalBytes: 512 * MB, generation: 1, seq: 2 })
      live.resultMemory.update({ usedBytes: 0, globalBytes: 256 * MB, generation: 1, seq: 2 })
    })
    expect(live.trigger().textContent).toBe('Memory')
  })

  it('releases a single result via the row × button without closing its query tab and preserves keyboard focus', async () => {
    const view = await mountIndicator({
      indexBytes: 32 * MB, indexBudget: 512 * MB, resultBytes: 180 * MB, resultBudget: 256 * MB,
      docs: [{ id: 'tab1', name: 'Orders.sql' }, { id: 'tab2', name: 'Inventory.sql' }],
      tabs: {
        tab1: { status: 'completed', sets: [{ key: 'e1', number: 1, descriptor: { generation: 1, resultId: 1 } }, { key: 'e2', number: 2, descriptor: { generation: 1, resultId: 2 } }] },
        tab2: { status: 'completed', sets: [{ key: 'e3', number: 1, descriptor: { generation: 1, resultId: 3 } }] }
      },
      largest: [
        { resultId: 1, logicalBytes: 90 * MB, storedBytes: 90 * MB, state: 'raw' },
        { resultId: 2, logicalBytes: 60 * MB, storedBytes: 60 * MB, state: 'raw' },
        { resultId: 3, logicalBytes: 30 * MB, storedBytes: 30 * MB, state: 'raw' }
      ]
    })
    const buttons = () => [...view.panel().querySelectorAll<HTMLButtonElement>('.memory-biggest-close')]
    expect(buttons().map(button => button.getAttribute('aria-label'))).toEqual([
      'Close Orders.sql · Result 1 to free memory',
      'Close Orders.sql · Result 2 to free memory',
      'Close Inventory.sql · Result 1 to free memory'
    ])
    // Remove middle row via keyboard focus: focus moves to the next row (Inventory.sql · Result 1).
    buttons()[1].focus()
    expect(document.activeElement).toBe(buttons()[1])
    await act(async () => { buttons()[1].click() })
    expect(view.results.removeEntry).toHaveBeenCalledWith('tab1', 'e2')
    expect(view.documents.getSnapshot().documents).toHaveLength(2)
    expect(buttons().map(button => button.getAttribute('aria-label'))).toEqual([
      'Close Orders.sql · Result 1 to free memory',
      'Close Inventory.sql · Result 1 to free memory'
    ])
    expect(document.activeElement).toBe(buttons()[1])

    // Remove last row: focus moves to the previous remaining row (Orders.sql · Result 1).
    await act(async () => { buttons()[1].click() })
    expect(view.results.removeEntry).toHaveBeenCalledWith('tab2', 'e3')
    expect(buttons()).toHaveLength(1)
    expect(document.activeElement).toBe(buttons()[0])

    // Remove final row: focus lands cleanly on the Nerd metrics toggle, never document.body.
    await act(async () => { buttons()[0].click() })
    expect(view.results.removeEntry).toHaveBeenCalledWith('tab1', 'e1')
    expect(buttons()).toHaveLength(0)
    expect(document.activeElement).toBe(view.panel().querySelector('.memory-nerd-toggle'))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('disables × while a query is running and lets Close all release only non-running results across tabs', async () => {
    const view = await mountIndicator({
      indexBytes: 16 * MB, indexBudget: 512 * MB, resultBytes: 150 * MB, resultBudget: 256 * MB,
      docs: [{ id: 'tab-run', name: 'Running.sql' }, { id: 'tab-idle', name: 'Idle.sql' }],
      tabs: {
        'tab-run': { status: 'running', sets: [{ key: 'e-run', number: 1, descriptor: { generation: 1, resultId: 10 } }] },
        'tab-idle': { status: 'completed', sets: [{ key: 'e-idle', number: 1, descriptor: { generation: 1, resultId: 11 } }] }
      },
      runningTabs: { 'tab-run': { running: { queryId: 'q1' } } },
      largest: [
        { resultId: 10, logicalBytes: 100 * MB, storedBytes: 100 * MB, state: 'raw' },
        { resultId: 11, logicalBytes: 50 * MB, storedBytes: 50 * MB, state: 'raw' }
      ]
    })
    const runningBtn = view.panel().querySelector<HTMLButtonElement>('button[aria-label="Close Running.sql · Result 1 to free memory"]')!
    const idleBtn = view.panel().querySelector<HTMLButtonElement>('button[aria-label="Close Idle.sql · Result 1 to free memory"]')!
    expect(runningBtn.disabled).toBe(true)
    expect(idleBtn.disabled).toBe(false)
    await act(async () => { runningBtn.click() })
    expect(view.results.removeEntry).not.toHaveBeenCalled()

    const closeAll = view.panel().querySelector<HTMLButtonElement>('.memory-close-all')!
    expect(closeAll.textContent).toBe('Close all')
    closeAll.focus()
    await act(async () => { closeAll.click() })
    expect(view.results.closeAllResults).toHaveBeenCalledTimes(1)
    // Idle tab's result was released; running tab's result stays; query tabs stay open.
    expect(view.results.getSnapshot()['tab-idle'].status).toBe('closed')
    expect(view.results.getSnapshot()['tab-run'].sets).toHaveLength(1)
    expect(view.documents.getSnapshot().documents).toHaveLength(2)
    // Close all disappears because only the running tab remains, and focus moves cleanly to the Nerd metrics heading.
    expect(view.panel().querySelector('.memory-close-all')).toBeNull()
    expect(document.activeElement).toBe(view.panel().querySelector('.memory-nerd-toggle'))
  })

  it('keeps Close all and row × buttons out of the tab order during hover preview', async () => {
    const view = await mountIndicator({
      indexBytes: 16 * MB, indexBudget: 512 * MB, resultBytes: 80 * MB, resultBudget: 256 * MB,
      docs: [{ id: 'tab1', name: 'Query 1' }],
      tabs: { tab1: { status: 'completed', sets: [{ key: 'e1', number: 1, descriptor: { generation: 1, resultId: 1 } }] } },
      largest: [{ resultId: 1, logicalBytes: 80 * MB, storedBytes: 80 * MB, state: 'raw' }],
      pin: false
    })
    // Trigger hover preview (not pinned).
    await act(async () => { view.host.querySelector('.memory-status')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })) })
    expect(view.panel().hidden).toBe(false)
    expect(view.panel().querySelector<HTMLButtonElement>('.memory-close-all')!.tabIndex).toBe(-1)
    expect(view.panel().querySelector<HTMLButtonElement>('.memory-biggest-close')!.tabIndex).toBe(-1)
  })
})
