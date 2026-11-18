// @vitest-environment happy-dom
// The header funnel's popover over a large snapshot: the checklist is a listbox the keyboard drives (the arrows, Page Up
// and Down, Home and End move its active row, Space ticks it, Enter is OK, Down from the search enters it), OK applies
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
import { scrollCap } from '../src/renderer/src/grid/scroll'
import { rowAtTop } from '../src/renderer/src/results/column-filter'
import { gesturesFor } from '../src/renderer/src/core/gestures'

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

function fixture(o: { hold?: boolean; anchor?: DOMRect; size?: { width: number; height: number }; onResized?(size: { width: number; height: number }): void } = {}) {
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
  const workbench = { results, gestures: gesturesFor('win32') } as unknown as Workbench
  const grid = document.createElement('div')
  document.body.appendChild(grid)
  const onClose = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let live = true
  const unmount = () => { if (!live) return; live = false; mounted.delete(unmount); act(() => { root.unmount() }) }
  mounted.add(unmount)
  const anchor = o.anchor ?? { left: 0, top: 0, right: 300, bottom: 20, width: 300, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  act(() => {
    root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ColumnFilterPopover, { source: resultsFilterSource(workbench.results, 't', 'e1'), columnName: 'name', target: { column: 0, anchor }, filtered: false, grid, onClose, ...o.size ? { size: o.size } : {}, ...o.onResized ? { onResized: o.onResized } : {} }) }))
  })
  const dialog = () => document.querySelector('form[role="dialog"]') as HTMLFormElement
  const valueList = () => dialog().querySelector('[role="listbox"][aria-label="Values"]') as HTMLElement
  const checkboxes = () => [...valueList().querySelectorAll('[role="option"]')] as HTMLElement[]
  const activeRow = () => document.getElementById(valueList().getAttribute('aria-activedescendant') ?? '')
  const key = (target: HTMLElement, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
  /** Scrolls the list (happy-dom lays nothing out, so the position is set as the browser would report it). */
  const scrollTo = (top: number) => act(() => {
    Object.defineProperty(valueList(), 'scrollTop', { value: top, configurable: true, writable: true })
    valueList().dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
  const ok = () => act(() => { (dialog().querySelector('button[type="submit"]') as HTMLButtonElement).click() })
  return {
    list, reads, tickRequests, results, onClose, dialog, valueList, checkboxes, activeRow, key, scrollTo, settle, ok, ticks,
    hold: (value: boolean) => { hold = value },
    unmount
  }
}

const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height)

describe('column filter popover', () => {
  it('opens beside its column, not over it, at its remembered size', async () => {
    // happy-dom's window is 1024 × 768: a column from 100 to 200 has room on its right.
    const right = fixture({ anchor: rect(100, 50, 100, 600), size: { width: 400, height: 0 } })
    await right.settle()
    expect([right.dialog().style.left, right.dialog().style.width, right.dialog().style.top, right.dialog().style.height]).toEqual(['202px', '400px', '50px', ''])
    expect(right.dialog().dataset.side).toBe('right')
    right.unmount()
    // A column at the window's right edge: the popover opens on its left, its right edge 2 px from the column.
    const left = fixture({ anchor: rect(800, 50, 200, 600), size: { width: 400, height: 500 } })
    await left.settle()
    expect([left.dialog().style.left, left.dialog().style.height, left.dialog().dataset.side]).toEqual(['398px', '500px', 'left'])
    expect(left.dialog().classList.contains('sized')).toBe(true)
  })
  it('resizes from its corner grip and hands the new size on when the drag ends', async () => {
    const resized = vi.fn()
    const view = fixture({ anchor: rect(100, 50, 100, 600), size: { width: 400, height: 400 }, onResized: resized })
    await view.settle()
    const grip = view.dialog().querySelector('.column-filter-grip') as HTMLElement
    view.dialog().getBoundingClientRect = () => rect(202, 50, 400, 400)
    const pointer = (type: string, x: number, y: number) => act(() => { grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y })) })
    pointer('pointerdown', 600, 450)
    pointer('pointermove', 660, 500)
    // Shown at once, saved only when the drag ends.
    expect([view.dialog().style.width, view.dialog().style.height]).toEqual(['460px', '450px'])
    expect(resized).not.toHaveBeenCalled()
    // Never smaller than the bounds.
    pointer('pointermove', 0, 0)
    expect([view.dialog().style.width, view.dialog().style.height]).toEqual(['340px', '240px'])
    pointer('pointermove', 700, 520)
    pointer('pointerup', 700, 520)
    expect(resized).toHaveBeenCalledWith({ width: 500, height: 470 })
  })
  it('is a listbox of options the arrow keys move through and Space ticks, one Tab stop', async () => {
    const view = fixture()
    await view.settle()
    const listbox = view.valueList()
    expect(listbox.tabIndex).toBe(0)
    // Several values tick at once: a multi-select listbox, so a screen reader does not take focus for selection.
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true')
    expect(view.checkboxes()[0]!.getAttribute('aria-checked')).toBe('true')
    expect(view.checkboxes()[0]!.getAttribute('aria-setsize')).toBe(String(distinct))
    // The rows' drawn boxes take no Tab stop of their own: the listbox is the one.
    expect([...listbox.querySelectorAll('input')].every(input => input.tabIndex === -1 && input.getAttribute('aria-hidden') === 'true')).toBe(true)
    // Down from the search goes to the list, whose first row is active.
    const search = view.dialog().querySelector('input[type="search"]') as HTMLInputElement
    expect(document.activeElement).toBe(search)
    view.key(search, 'ArrowDown')
    expect(document.activeElement).toBe(listbox)
    expect(view.activeRow()?.getAttribute('aria-label')).toBe('v00000 (1)')
    view.key(listbox, 'ArrowDown')
    view.key(listbox, 'ArrowDown')
    view.key(listbox, 'ArrowUp')
    expect(view.activeRow()?.getAttribute('aria-label')).toBe('v00001 (1)')
    view.key(listbox, ' ')
    await view.settle()
    expect(view.list.tick).toHaveBeenLastCalledWith({ checked: false, groups: [1] })
    expect(view.activeRow()?.getAttribute('aria-checked')).toBe('false')
    // Home and End reach either end; the list scrolls to show the active row, and focus never leaves the listbox.
    view.key(listbox, 'End')
    await view.settle()
    expect(listbox.scrollTop).toBeGreaterThan(0)
    expect(document.activeElement).toBe(listbox)
    expect(view.activeRow()?.getAttribute('aria-posinset')).toBe(String(distinct))
    view.key(listbox, 'Home')
    await view.settle()
    expect(view.activeRow()?.getAttribute('aria-label')).toBe('v00000 (1)')
    view.unmount()
  })

  it('applies OK with Enter in the list, after the ticks before it', async () => {
    const view = fixture()
    await view.settle()
    const listbox = view.valueList()
    act(() => listbox.focus())
    view.key(listbox, ' ')
    // Enter held down repeats: OK waits on the tick, and the repeats apply nothing more.
    view.key(listbox, 'Enter')
    view.key(listbox, 'Enter')
    await view.settle()
    await act(async () => { view.tickRequests[0]!.resolve({ checked: distinct - 1, nullsChecked: true }); await Promise.resolve() })
    await view.settle()
    expect(view.results.applyColumnFilter).toHaveBeenCalledTimes(1)
    expect(view.results.applyColumnFilter).toHaveBeenCalledWith('t', 'e1', 0, { kind: 'list', list: view.list })
    expect(view.onClose).toHaveBeenCalled()
    view.unmount()
  })

  it('keeps focus on the list when the active row scrolls out of the rows drawn', async () => {
    const view = fixture()
    await view.settle()
    const first = view.checkboxes()[0]!
    act(() => { first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(view.valueList())
    view.scrollTo(22 * 5000)
    await view.settle()
    expect(first.isConnected).toBe(false)
    expect(document.activeElement).toBe(view.valueList())
    // The active row is not drawn, so the listbox names no active descendant until it is scrolled back.
    expect(view.valueList().getAttribute('aria-activedescendant')).toBeNull()
    // Space ticks it all the same, scrolling it back into view first.
    view.key(view.valueList(), ' ')
    await view.settle()
    expect(view.valueList().scrollTop).toBe(0)
    expect(view.list.tick).toHaveBeenLastCalledWith({ checked: false, groups: [0] })
    expect(view.activeRow()?.getAttribute('aria-label')).toBe('v00000 (1)')
    // Focus coming back to the list (Tab, Down from the search) with its active row scrolled away takes the first row in
    // view as the active one, so a screen reader has one to announce.
    view.scrollTo(22 * 5000)
    await view.settle()
    act(() => { (view.dialog().querySelector('input[type="search"]') as HTMLInputElement).focus() })
    act(() => view.valueList().focus())
    expect(view.activeRow()?.getAttribute('aria-label')).toBe('v05000 (1)')
    // The tick is aria-checked and the highlight aria-selected, which mean different things here; the row focus arrived
    // on is the one selected, so Space ticks it.
    expect(view.activeRow()?.getAttribute('aria-selected')).toBe('true')
    expect(view.valueList().querySelectorAll('[aria-selected="true"]')).toHaveLength(1)
    view.unmount()
  })

  it('lays out no more scroll space than Chromium allows at the pixel ratio of the window, mapping the rows past it', async () => {
    // At a pixel ratio of 1000 the grid's cap is 30,000 px, less than the 220,000 px the 10,000 values would take.
    const ratio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1000 })
    try {
      const view = fixture()
      await view.settle()
      const space = view.valueList().querySelector('.column-filter-space') as HTMLElement
      expect(space.style.height).toBe(scrollCap(1000) + 'px')
      // End still reaches the last value: it is the active row, drawn, so a screen reader announces it.
      act(() => view.valueList().focus())
      view.key(view.valueList(), 'End')
      await view.settle()
      expect(view.activeRow()?.getAttribute('aria-label')).toBe('v09999 (1)')
      expect(view.valueList().getAttribute('aria-activedescendant')).toBe(view.activeRow()?.id)
      view.unmount()
    } finally {
      if (ratio) Object.defineProperty(window, 'devicePixelRatio', ratio)
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio
    }
  })

  it('follows a change of pixel ratio, keeping the row at the top of the list there, and stops watching when closed', async () => {
    const ratio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio'), match = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const queries: { media: string; listeners: Set<() => void> }[] = []
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, writable: true, value: 1 })
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => {
      const query = { media, listeners: new Set<() => void>() }
      queries.push(query)
      return { media, matches: true, addEventListener: (_: string, listener: () => void) => query.listeners.add(listener), removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener) }
    } })
    try {
      const view = fixture()
      await view.settle()
      const space = () => (view.valueList().querySelector('.column-filter-space') as HTMLElement).style.height
      expect(space()).toBe(distinct * 22 + 'px')
      // Halfway through row 5000.
      view.scrollTo(22 * 5000 + 11)
      await view.settle()
      // Zoom takes the ratio to 1000: the cap falls to 30,000 px, the list maps its rows, and row 5000 stays at the top, as
      // far through it as before.
      ;(window as { devicePixelRatio: number }).devicePixelRatio = 1000
      const armed = queries.at(-1)!
      expect(armed.media).toBe('(resolution: 1dppx)')
      act(() => { for (const listener of [...armed.listeners]) { armed.listeners.delete(listener); listener() } })
      await view.settle()
      expect(space()).toBe(scrollCap(1000) + 'px')
      expect(rowAtTop({ rows: distinct, rowHeight: 22, viewHeight: 0, scrollTop: view.valueList().scrollTop, maxSpace: scrollCap(1000) })).toBeCloseTo(5000.5, 6)
      expect(view.checkboxes().some(option => option.getAttribute('aria-label') === 'v05000 (1)')).toBe(true)
      // The watch moves on to the new ratio, and closing the popover drops it.
      const next = queries.at(-1)!
      expect([next.media, next.listeners.size]).toEqual(['(resolution: 1000dppx)', 1])
      view.unmount()
      expect(next.listeners.size).toBe(0)
    } finally {
      if (ratio) Object.defineProperty(window, 'devicePixelRatio', ratio)
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio
      if (match) Object.defineProperty(window, 'matchMedia', match)
      else delete (window as { matchMedia?: unknown }).matchMedia
    }
  })

  it('makes a clicked row the active one when the click brings focus to the list', async () => {
    const view = fixture()
    await view.settle()
    // Focus is in the search and row 0 is active; the wheel scrolls it away, then a row in view is clicked.
    act(() => { (view.dialog().querySelector('input[type="search"]') as HTMLInputElement).focus() })
    view.scrollTo(22 * 5000)
    await view.settle()
    const row = view.checkboxes().find(option => option.getAttribute('aria-label') === 'v05003 (1)')!
    act(() => { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    act(() => row.click())
    await view.settle()
    expect(document.activeElement).toBe(view.valueList())
    expect(view.activeRow()?.getAttribute('aria-label')).toBe('v05003 (1)')
    expect(view.list.tick).toHaveBeenLastCalledWith({ checked: false, groups: [5003] })
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
    expect(view.results.applyColumnFilter).toHaveBeenCalledWith('t', 'e1', 0, { kind: 'all' })
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
    expect(view.dialog().querySelector('[role="alert"]')?.textContent).toBe('The backend is busy.')
    // Scrolled on, the next block's read succeeds and the error goes.
    view.hold(false)
    view.scrollTo(22 * 7000)
    await view.settle()
    expect(view.dialog().querySelector('[role="alert"]')).toBeNull()
    expect(view.checkboxes().length).toBeGreaterThan(0)
    view.unmount()
  })

  /** A key with modifiers, as `key` presses one without. */
  const press = (target: Element, name: string, init: KeyboardEventInit = {}) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
  const actionsOf = (view: ReturnType<typeof fixture>) => view.dialog().querySelector('[role="listbox"][aria-label="Actions"]') as HTMLElement
  const actionNames = (view: ReturnType<typeof fixture>) => [...actionsOf(view).querySelectorAll('[role="option"]')].map(option => option.getAttribute('aria-label'))
  const click = (target: Element, init: MouseEventInit = {}) => act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
  const runAction = (view: ReturnType<typeof fixture>, name: string) => click([...actionsOf(view).querySelectorAll('[role="option"]')].find(option => option.getAttribute('aria-label') === name)!)
  /** Answers every tick sent so far, and those each answer lets go (ticks go one at a time). */
  const answerTicks = async (view: ReturnType<typeof fixture>) => {
    for (let round = 0; round < 6; round++) {
      await view.settle()
      for (const tick of view.tickRequests.splice(0)) await act(async () => { tick.resolve({ checked: 1, nullsChecked: true }) })
    }
  }
  const selectedRows = (view: ReturnType<typeof fixture>) => view.checkboxes().filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.getAttribute('aria-posinset'))
  const tickCalls = (view: ReturnType<typeof fixture>) => vi.mocked(view.list.tick).mock.calls.map(call => call[0])

  it('lists actions beside the values by context, each saying how many values it touches, and runs them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const view = fixture()
      await view.settle()
      // No search: every value's actions, and Invert.
      expect(actionNames(view)).toEqual(['Tick all (10,000)', 'Untick all (10,000)', 'Invert ticks'])
      runAction(view, 'Untick all (10,000)')
      expect(view.checkboxes()[0]!.getAttribute('aria-checked')).toBe('false')
      runAction(view, 'Invert ticks')
      expect(view.checkboxes()[0]!.getAttribute('aria-checked')).toBe('true')
      await answerTicks(view)
      expect(tickCalls(view)).toEqual([{ checked: false, all: true }, { checked: true, invert: true }])
      // Typing in the values goes on in the search; once it applies, the matches' actions come first and every value's
      // apart, so unticking never quietly means only the matches.
      act(() => view.valueList().focus())
      view.key(view.valueList(), 'v')
      const search = view.dialog().querySelector('input[type="search"]') as HTMLInputElement
      expect([document.activeElement === search, search.value]).toEqual([true, 'v'])
      await act(async () => { vi.advanceTimersByTime(250) })
      await view.settle()
      expect(actionNames(view)).toEqual(['Tick the matches (10,000)', 'Tick only the matches (10,000)', 'Untick the matches (10,000)', 'Tick all (10,000)', 'Untick all (10,000)'])
      runAction(view, 'Untick the matches (10,000)')
      runAction(view, 'Tick only the matches (10,000)')
      // Only the matches are ticked now, before any answer.
      expect(view.dialog().textContent).toContain('10,000 ticked.')
      await answerTicks(view)
      expect(tickCalls(view).slice(2)).toEqual([{ checked: false, all: true, search: 'v' }, { checked: false, all: true }, { checked: true, all: true, search: 'v' }])
      view.unmount()
    } finally { vi.useRealTimers() }
  })

  it('moves between the search, the action list and the values with the arrows alone', async () => {
    const view = fixture()
    await view.settle()
    const search = view.dialog().querySelector('input[type="search"]') as HTMLInputElement, values = view.valueList(), actions = actionsOf(view)
    view.key(search, 'ArrowDown')
    expect(document.activeElement).toBe(values)
    // Arriving selects the active row.
    expect(selectedRows(view)).toEqual(['1'])
    view.key(values, 'ArrowLeft')
    expect(document.activeElement).toBe(actions)
    const current = () => document.getElementById(actions.getAttribute('aria-activedescendant') ?? '')?.getAttribute('aria-label')
    expect(current()).toBe('Tick all (10,000)')
    view.key(actions, 'ArrowDown')
    view.key(actions, 'Enter')
    await answerTicks(view)
    // The action ran and the focus stayed for the next.
    expect(tickCalls(view)).toEqual([{ checked: false, all: true }])
    expect([document.activeElement === actions, current()]).toEqual([true, 'Untick all (10,000)'])
    view.key(actions, 'ArrowRight')
    expect(document.activeElement).toBe(values)
    // Up from the first row, or from the first action, returns to the search.
    view.key(values, 'ArrowUp')
    expect(document.activeElement).toBe(search)
    view.key(search, 'ArrowDown')
    view.key(values, 'ArrowLeft')
    view.key(actions, 'Home')
    view.key(actions, 'ArrowUp')
    expect(document.activeElement).toBe(search)
    view.unmount()
  })

  it('selects rows apart from their ticks, and Space ticks the selection as one request', async () => {
    const view = fixture()
    await view.settle()
    const values = view.valueList()
    act(() => values.focus())
    press(values, 'ArrowDown', { shiftKey: true })
    press(values, 'ArrowDown', { shiftKey: true })
    expect(selectedRows(view)).toEqual(['1', '2', '3'])
    expect(actionNames(view).slice(0, 3)).toEqual(['Tick the selected (3)', 'Untick the selected (3)', 'Tick only the selected (3)'])
    expect(view.dialog().textContent).toContain('3 selected.')
    // Every selected row is ticked: Space unticks them all.
    press(values, ' ')
    await answerTicks(view)
    expect(tickCalls(view).at(-1)).toEqual({ checked: false, order: 'count', ranges: [[0, 3]] })
    expect(view.checkboxes().slice(0, 4).map(option => option.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true'])
    // Ctrl moves without selecting; Ctrl+Space adds the active row.
    press(values, 'ArrowDown', { ctrlKey: true })
    press(values, 'ArrowDown', { ctrlKey: true })
    press(values, ' ', { ctrlKey: true })
    expect(selectedRows(view)).toEqual(['1', '2', '3', '5'])
    // Ctrl+A selects every row; some are unticked, so Space ticks them all, rows not read included.
    press(values, 'a', { ctrlKey: true })
    expect(actionNames(view)[0]).toBe('Tick the selected (10,000)')
    press(values, ' ')
    await answerTicks(view)
    expect(tickCalls(view).at(-1)).toEqual({ checked: true, order: 'count', ranges: [[0, distinct]] })
    view.unmount()
  })

  it('leaves Space to the backend when the rows it has read are all ticked but others are not read', async () => {
    const view = fixture()
    await view.settle()
    act(() => view.valueList().focus())
    press(view.valueList(), 'a', { ctrlKey: true })
    const reads = view.reads.length
    press(view.valueList(), ' ')
    await answerTicks(view)
    expect(tickCalls(view)).toEqual([{ checked: true, order: 'count', ranges: [[0, distinct]], toggle: true }])
    // The rows shown are read again with the ticks the backend chose.
    expect(view.reads.length).toBeGreaterThan(reads)
    view.unmount()
  })

  it('ticks with a plain click only: Ctrl and Shift clicks select, and Tick only the selected unticks the rest', async () => {
    const view = fixture()
    await view.settle()
    const row = (n: number) => view.checkboxes().find(option => option.getAttribute('aria-posinset') === String(n))!
    click(row(2), { ctrlKey: true })
    click(row(5), { shiftKey: true })
    expect(selectedRows(view)).toEqual(['2', '3', '4', '5'])
    click(row(8), { ctrlKey: true })
    expect(selectedRows(view)).toEqual(['2', '3', '4', '5', '8'])
    expect(view.list.tick).not.toHaveBeenCalled()
    runAction(view, 'Tick only the selected (5)')
    await answerTicks(view)
    expect(tickCalls(view)).toEqual([{ checked: false, all: true }, { checked: true, order: 'count', ranges: [[1, 4], [7, 1]] }])
    expect(view.checkboxes().slice(0, 9).map(option => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'true', 'true', 'true', 'false', 'false', 'true', 'false'])
    // A plain click ticks its row and selects it alone.
    click(row(1))
    await answerTicks(view)
    expect(selectedRows(view)).toEqual(['1'])
    expect(tickCalls(view).at(-1)).toEqual({ checked: true, groups: [0] })
    view.unmount()
  })

  it('keeps the side its grip drag started on, holding the width to the room there', async () => {
    // happy-dom's window is 1024 × 768: a column from 500 to 600 leaves 414 px on its right and 490 on its left.
    const resized = vi.fn()
    const view = fixture({ anchor: rect(500, 50, 100, 600), size: { width: 400, height: 400 }, onResized: resized })
    await view.settle()
    expect(view.dialog().dataset.side).toBe('right')
    const grip = view.dialog().querySelector('.column-filter-grip') as HTMLElement
    view.dialog().getBoundingClientRect = () => rect(602, 50, 400, 400)
    const pointer = (type: string, x: number, y: number) => act(() => { grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y })) })
    pointer('pointerdown', 1000, 450)
    // Wider than the room on the right: it stays there at the room's width, never flipping to the left and back.
    for (const x of [1060, 1061, 1062]) {
      pointer('pointermove', x, 450)
      expect([view.dialog().dataset.side, view.dialog().style.width]).toEqual(['right', '414px'])
    }
    pointer('pointerup', 1062, 450)
    expect(resized).toHaveBeenCalledWith({ width: 414, height: 400 })
    view.unmount()
  })

  it('keeps no side when it opened over its column, and saves no size below the settings\' least', async () => {
    // A column from 100 to 950: too little room on either side, so it opens over the column at its right end.
    const resized = vi.fn()
    const view = fixture({ anchor: rect(100, 100, 850, 660), size: { width: 600, height: 400 }, onResized: resized })
    await view.settle()
    expect([view.dialog().style.left, view.dialog().style.width]).toEqual(['350px', '600px'])
    const grip = view.dialog().querySelector('.column-filter-grip') as HTMLElement
    view.dialog().getBoundingClientRect = () => rect(350, 100, 600, 400)
    const pointer = (type: string, x: number, y: number) => act(() => { grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y })) })
    pointer('pointerdown', 950, 500)
    pointer('pointermove', 960, 500)
    // It grows where it is, its right end at the column's, rather than jumping beside the column.
    expect([view.dialog().style.left, view.dialog().style.width, view.dialog().dataset.side]).toEqual(['340px', '610px', 'right'])
    pointer('pointermove', -2000, -2000)
    pointer('pointerup', -2000, -2000)
    expect(resized).toHaveBeenLastCalledWith({ width: 340, height: 240 })
    view.unmount()
  })

  it('opens narrower beside its column when its remembered width fits neither side, and scrolls the action list to its highlight', async () => {
    const view = fixture({ anchor: rect(400, 100, 100, 660), size: { width: 600, height: 0 } })
    await view.settle()
    expect([view.dialog().dataset.side, view.dialog().style.left, view.dialog().style.width]).toEqual(['right', '502px', '514px'])
    const shown: string[] = [], own = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) { shown.push(this.getAttribute('aria-label') ?? '') }
    try {
      act(() => view.valueList().focus())
      view.key(view.valueList(), 'ArrowLeft')
      view.key(actionsOf(view), 'End')
      expect(shown.at(-1)).toBe('Invert ticks')
    } finally { Element.prototype.scrollIntoView = own }
    view.unmount()
  })

  it('ticks a single selected row not read yet through the backend, and moves the count at once when it can', async () => {
    const view = fixture()
    await view.settle()
    act(() => view.valueList().focus())
    view.hold(true)
    view.key(view.valueList(), 'End')
    view.key(view.valueList(), ' ')
    await answerTicks(view)
    expect(tickCalls(view)).toEqual([{ checked: true, order: 'count', ranges: [[distinct - 1, 1]], toggle: true }])
    view.hold(false)
    view.unmount()
    // Every selected value read: Space unticks them and the note says so before the backend answers.
    const counted = fixture()
    await counted.settle()
    act(() => counted.valueList().focus())
    press(counted.valueList(), 'ArrowDown', { shiftKey: true })
    press(counted.valueList(), ' ')
    expect(counted.dialog().textContent).toContain('9,998 ticked, 2 selected.')
    counted.unmount()
  })

  it('applies OK with Ctrl+Enter from the search', async () => {
    const view = fixture()
    await view.settle()
    press(view.dialog().querySelector('input[type="search"]')!, 'Enter', { ctrlKey: true })
    await view.settle()
    expect(view.results.applyColumnFilter).toHaveBeenCalledWith('t', 'e1', 0, { kind: 'all' })
    view.unmount()
  })
})
