// @vitest-environment happy-dom
// The header funnel's popover over a large snapshot: focus stays in the list when its row scrolls away, OK applies
// nothing once the popover is gone and decides with the snapshot's own ticks after a failed tick, reads of blocks
// scrolled away from are given up, and a read that succeeds clears a read error.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { DistinctValue, ResultsDistinctReadResult, ResultsDistinctTickResult } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { ColumnFilterPopover, resultsFilterSource } from '../src/renderer/src/results/ColumnFilterPopover'
import type { DistinctList } from '../src/renderer/src/results/ResultClient'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const distinct = 10_000
interface Read { o: Parameters<DistinctList['read']>[0]; resolve(): void; reject(error: unknown): void }
interface Tick { resolve(result: ResultsDistinctTickResult): void; reject(error: unknown): void }
/** Each test's popover goes with it, even one that failed before unmounting, so the next finds only its own. */
const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  document.body.replaceChildren()
})

function fixture(o: { hold?: boolean } = {}) {
  const ticks = new Array<boolean>(distinct).fill(true)
  const reads: Read[] = [], tickRequests: Tick[] = []
  let hold = o.hold ?? false
  const answer = (o: Read['o']): ResultsDistinctReadResult => {
    const values: DistinctValue[] = []
    for (let group = o.offset; group < Math.min(distinct, o.offset + o.count); group++) values.push({ group, row: group, text: 'v' + String(group).padStart(5, '0'), count: 1, checked: ticks[group]! })
    return { total: distinct, offset: o.offset, values, checked: ticks.filter(Boolean).length, nullsChecked: true }
  }
  const list: DistinctList = {
    generation: 1, resultId: 3, snapshotId: 7, column: 0,
    summary: { snapshotId: 7, rows: distinct, complete: true, nulls: 0, distinct, approximate: false, checked: distinct, nullsChecked: true },
    read: vi.fn((o: Read['o']) => new Promise<ResultsDistinctReadResult>((resolve, reject) => {
      const read = { o, resolve: () => resolve(answer(o)), reject }
      reads.push(read)
      if (!hold) read.resolve()
    })),
    tick: vi.fn(() => new Promise<ResultsDistinctTickResult>((resolve, reject) => { tickRequests.push({ resolve, reject }) })),
    close: vi.fn(async () => undefined)
  }
  const results = { columnValues: vi.fn(async () => list), applyColumnFilter: vi.fn(() => true), sortOf: () => undefined }
  const workbench = { results } as unknown as Workbench
  const grid = document.createElement('div')
  document.body.appendChild(grid)
  const onClose = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let live = true
  const unmount = () => { if (!live) return; live = false; mounted.delete(unmount); act(() => { root.unmount() }) }
  mounted.add(unmount)
  const anchor = { left: 0, top: 0, right: 300, bottom: 20, width: 300, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  act(() => {
    root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ColumnFilterPopover, { source: resultsFilterSource(workbench.results, 't', 0), columnName: 'name', target: { column: 0, anchor }, filtered: false, grid, onClose }) }))
  })
  const dialog = () => document.querySelector('form[role="dialog"]') as HTMLFormElement
  const valueList = () => dialog().querySelector('[role="group"][aria-label="Values"]') as HTMLElement
  const checkboxes = () => [...valueList().querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
  /** Scrolls the list (happy-dom lays nothing out, so the position is set as the browser would report it). */
  const scrollTo = (top: number) => act(() => {
    Object.defineProperty(valueList(), 'scrollTop', { value: top, configurable: true, writable: true })
    valueList().dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
  const ok = () => act(() => { (dialog().querySelector('button[type="submit"]') as HTMLButtonElement).click() })
  return {
    list, reads, tickRequests, results, onClose, dialog, valueList, checkboxes, scrollTo, settle, ok, ticks,
    hold: (value: boolean) => { hold = value },
    unmount
  }
}

describe('column filter popover', () => {
  it('keeps focus in the list when the focused row scrolls out of the rows drawn', async () => {
    const view = fixture()
    await view.settle()
    const first = view.checkboxes()[0]!
    act(() => first.focus())
    expect(document.activeElement).toBe(first)
    view.scrollTo(22 * 5000)
    await view.settle()
    expect(first.isConnected).toBe(false)
    expect(document.activeElement).toBe(view.valueList())
    view.unmount()
  })

  it('applies nothing when the popover is gone before its last tick is answered, and closes its snapshot', async () => {
    const view = fixture()
    await view.settle()
    act(() => view.checkboxes()[0]!.click())
    await view.settle()
    expect(view.list.tick).toHaveBeenCalledWith({ checked: false, groups: [0] })
    await view.ok()
    view.unmount()
    expect(view.list.close).toHaveBeenCalledTimes(1)
    await act(async () => { view.tickRequests[0]!.resolve({ checked: distinct - 1, nullsChecked: true }); await Promise.resolve() })
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(view.results.applyColumnFilter).not.toHaveBeenCalled()
  })

  it('decides OK with the snapshot\'s own ticks after a tick failed', async () => {
    const view = fixture()
    await view.settle()
    // The untick fails: the list shows it cleared (one value off), but the snapshot still ticks every value.
    act(() => view.checkboxes()[0]!.click())
    await view.settle()
    view.hold(true)
    await act(async () => { view.tickRequests[0]!.reject(new Error('The value could not be ticked.')); await Promise.resolve() })
    await view.settle()
    expect(view.dialog().textContent).toContain('The value could not be ticked.')
    // Block reads stay unanswered, so only OK's own read can tell it the snapshot's ticks.
    view.hold(false)
    await view.ok()
    await view.settle()
    expect(view.list.read).toHaveBeenLastCalledWith({ order: 'value', offset: 0, count: 1 })
    expect(view.results.applyColumnFilter).toHaveBeenCalledWith('t', 0, 0, { kind: 'all' })
    view.unmount()
  })

  it('gives up reads of blocks scrolled away from, and a read that succeeds clears a read error', async () => {
    const view = fixture({ hold: true })
    await view.settle()
    const first = view.reads.find(read => read.o.offset === 0 && read.o.count === 128)!
    expect(first.o.signal?.aborted).toBe(false)
    view.scrollTo(22 * 5000)
    await view.settle()
    expect(first.o.signal?.aborted).toBe(true)
    const far = view.reads.at(-1)!
    expect(far.o.offset).toBe(Math.floor(5000 / 128) * 128)
    await act(async () => { far.reject(new Error('The backend is busy.')); await Promise.resolve() })
    expect(view.valueList().querySelector('[role="alert"]')?.textContent).toBe('The backend is busy.')
    // Scrolled on, the next block's read succeeds and the error goes.
    view.hold(false)
    view.scrollTo(22 * 7000)
    await view.settle()
    expect(view.valueList().querySelector('[role="alert"]')).toBeNull()
    expect(view.checkboxes().length).toBeGreaterThan(0)
    view.unmount()
  })
})
