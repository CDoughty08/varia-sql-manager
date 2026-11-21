// @vitest-environment happy-dom
// The Compare popover: it says only what applies (the list when there is a choice, the columns left out when any are, the
// sorted or filtered warning while it holds), takes the focus when it opens, compares on Enter, closes on Escape, Close, a
// press outside and once its comparison is shown, and while its comparison runs keeps the Compare button focusable
// (aria-disabled) and says a failure or a cancel in the status region that is always in the accessibility tree.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ComparePopover, { pairingRule, placePopover } from '../src/renderer/src/results/ComparePopover'
import { windows } from '../src/renderer/src/core/windows'
import { CompareService } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type DiffAnswer = Awaited<ReturnType<FakeHandle['diff']>>
const column = (name: string): ResultColumn => ({ name, dataType: 'int', wire: 'text', nullable: false })
const made = (index: number): DiffAnswer => ({ descriptor: descriptor(900 + index, { index, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' })

// Fixtures still drawn when a test ends (a failed expectation skips its unmount): unmounted so they do not leak into the next.
const drawnFixtures = new Set<() => void>()
afterEach(() => { for (const unmount of drawnFixtures) unmount(); drawnFixtures.clear() })

function fixture(o: { count?: number; columns?: Record<number, ResultColumn[]>; open?: number; names?: Record<number, string> } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results, { jobs: new DerivedJobs({ timers: timers.timers }) })
  results.begin('t1', 'q1')
  const values = Array.from({ length: o.count ?? 2 }, (_, index) => descriptor(index + 1, { index, ...o.columns?.[index] ? { columns: o.columns[index] } : {}, ...o.names?.[index] ? { name: o.names[index] } : {} }))
  for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
  void results.finish('t1', 'q1', { summary: summaryOf(values) })
  const keys = results.getSnapshot().t1.sets.map(set => set.key)
  const handle = (key: string) => results.getSnapshot().t1.sets.find(set => set.key === key)!.handle as FakeHandle
  compare.open('t1', keys[o.open ?? 1])
  const workbench = { results, compare } as unknown as Workbench
  const container = document.createElement('div')
  container.setAttribute('data-pane', 'results')
  document.body.append(container)
  const root = createRoot(container)
  const draw = () => act(() => { root.render(createElement(StrictMode, null, createElement(WorkbenchProvider, { workbench, children: createElement(ComparePopover, { tabId: 't1', tab: results.getSnapshot().t1 }) }))) })
  draw()
  const popover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Compare"]')
  const button = (name: string) => [...popover()?.querySelectorAll('button') ?? []].find(item => item.textContent === name)
  const status = () => popover()?.querySelector('[role="status"]')
  const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
  const unmount = () => { if (!drawnFixtures.delete(unmount)) return; act(() => { root.unmount(); container.remove() }) }
  drawnFixtures.add(unmount)
  return { compare, results, keys, handle, container, draw, popover, button, status, key, unmount }
}

describe('Compare popover', () => {
  it('with one target shows no list, only the two sides, and takes the focus on Compare', () => {
    const view = fixture()
    expect(view.popover()?.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(view.popover()?.querySelector('[aria-label="Old side"]')?.textContent).toContain('Result 1')
    expect(view.popover()?.querySelector('[aria-label="New side"]')?.textContent).toContain('Result 2')
    expect(view.popover()?.querySelector('h2')?.textContent).toBe('Compare Result 2 with')
    // Nothing is said that does not apply: no columns left out, nothing sorted or filtered, nothing failed.
    expect(view.popover()?.textContent).not.toMatch(/Not compared|sorted or filtered|Every column pairs|Pivots, comparisons/)
    expect(document.activeElement).toBe(view.button('Compare'))
    view.unmount()
  })

  it('with a choice lists the targets, focuses the picked one, and names the columns left out with the pairing rule', () => {
    const view = fixture({ count: 3, open: 2, columns: { 0: [column('Id'), column('Name')], 1: [column('Id'), column('Price')], 2: [column('Id'), column('Name')] } })
    const radios = [...view.popover()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios).toHaveLength(2)
    // Result 2 is the previous Table; of the three columns between them (Id, Name, Price) one pairs, which its row says.
    expect(document.activeElement).toBe(radios[1])
    expect(radios[1].closest('label')?.textContent).toContain('1 of 3 columns')
    expect(radios[0].closest('label')?.textContent).not.toContain('columns')
    const unpaired = view.popover()!.querySelector('section')!
    expect(unpaired.textContent).toContain('Price')
    expect(unpaired.textContent).toContain('only in Result 2')
    expect(unpaired.querySelector(`[aria-label="${pairingRule}"]`)).not.toBeNull()
    // Picking the target that pairs every column drops the section.
    act(() => { radios[0].click() })
    view.draw()
    expect(view.popover()!.querySelector('section')).toBeNull()
    view.unmount()
  })

  it('names each result when a column is not compared, and counts one row as one', () => {
    const wide = (name: string, dataType: string, wire: ResultColumn['wire']): ResultColumn => ({ name, dataType, wire, nullable: false })
    // The second Id is left out because its name repeats, though the other result's Id is a bigint: no type is blamed.
    const view = fixture({ columns: { 0: [column('Id'), column('Id'), wide('Data', 'nvarchar', 'text')], 1: [wide('Id', 'bigint', 'text'), wide('Data', 'varbinary', 'binary')] } })
    const items = [...view.popover()!.querySelectorAll('section li')].map(item => item.textContent)
    expect(items).toEqual(expect.arrayContaining([
      expect.stringContaining('a second column of this name in Result 1'),
      expect.stringContaining('nvarchar in Result 1, varbinary in Result 2'),
      expect.stringContaining('varbinary in Result 2, nvarchar in Result 1')
    ]))
    expect(view.popover()!.textContent).not.toContain(' here')
    expect(view.popover()!.textContent).not.toContain('int in Result 1, bigint')
    view.handle(view.keys[0]).snapshot = { ...view.handle(view.keys[0]).snapshot, rowsStored: 1 }
    view.draw()
    expect(view.popover()!.querySelector('[aria-label="Old side"]')?.textContent).toContain('1 row')
    expect(view.popover()!.querySelector('[aria-label="Old side"]')?.textContent).not.toContain('1 rows')
    view.unmount()
  })

  it('leaves its controls usable when Exact text lands on a pair already comparing, offering Cancel', async () => {
    const view = fixture()
    // Compare with Previous Result (Exact Text) is running on the same pair.
    let finish!: (answer: DiffAnswer) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>(yes => { finish = yes }))
    const running = view.compare.compare('t1', view.keys[1], { exact: true })
    view.draw()
    const exact = view.popover()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(exact.disabled).toBe(false)
    exact.focus()
    act(() => { exact.click() })
    view.draw()
    expect(exact.disabled).toBe(false)
    expect(document.activeElement).toBe(exact)
    expect(view.button('Cancel')).toBeDefined()
    expect(view.popover()!.querySelector('button[type="submit"]')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { finish({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 2, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' }); await running })
    view.unmount()
  })

  it('warns only while an input is sorted or filtered', () => {
    const view = fixture()
    expect(view.popover()?.textContent).not.toContain('sorted or filtered')
    act(() => { view.results.sortBy('t1', view.keys[1], 0, 'ascending') })
    view.draw()
    expect(view.popover()?.textContent).toContain('Result 2 is sorted or filtered here.')
    view.unmount()
  })

  it('compares on Enter, then closes as the comparison takes the focus', async () => {
    const view = fixture()
    vi.mocked(view.handle(view.keys[0]).diff).mockResolvedValueOnce(made(2))
    const exact = view.popover()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    exact.focus()
    await act(async () => { exact.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    view.draw()
    expect(view.handle(view.keys[1]).diff).not.toHaveBeenCalled()
    expect(view.handle(view.keys[0]).diff).toHaveBeenCalledTimes(1)
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    expect(view.popover()).toBeNull()
    expect(view.results.getSnapshot().t1.focused).toBe(view.results.getSnapshot().t1.comparisons[0].key)
    view.unmount()
  })

  it('closes on Escape, on Close, and on a press outside, but not on a press inside', () => {
    const view = fixture()
    view.key(view.button('Compare')!, 'Escape')
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    view.compare.open('t1', view.keys[1])
    view.draw()
    act(() => { view.button('Close')!.click() })
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    view.compare.open('t1', view.keys[1])
    view.draw()
    act(() => { view.popover()!.querySelector('h2')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    view.unmount()
  })

  it('keeps the focus on Compare while its comparison runs, ignores presses then, and says a failure where the focus is', async () => {
    const view = fixture()
    let fail!: (error: unknown) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>((_yes, no) => { fail = no }))
    const compareButton = view.button('Compare')!
    compareButton.focus()
    await act(async () => { compareButton.click() })
    view.draw()
    expect(compareButton.disabled).toBe(false)
    expect(compareButton.getAttribute('aria-disabled')).toBe('true')
    expect(compareButton.textContent).toContain('Comparing…')
    expect(document.activeElement).toBe(compareButton)
    // A second press while it runs is ignored.
    const run = vi.spyOn(view.compare, 'run')
    await act(async () => { compareButton.click() })
    expect(run).not.toHaveBeenCalled()
    expect(view.handle(view.keys[0]).diff).toHaveBeenCalledTimes(1)
    // The status region is in the tree (never hidden) before it has anything to say.
    expect(view.status()?.hasAttribute('hidden')).toBe(false)
    await act(async () => { fail(new ResultError('TOO_LARGE', 'There is not enough result memory to compare these results.')) })
    view.draw()
    expect(view.status()?.textContent).toBe('There is not enough result memory to compare these results.')
    expect(compareButton.hasAttribute('aria-disabled')).toBe(false)
    expect(document.activeElement).toBe(compareButton)
    view.unmount()
  })

  it('says a cancel in the status region and stays open', async () => {
    const view = fixture()
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce((_right, o) => new Promise<DiffAnswer>((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    await act(async () => { view.button('Compare')!.click() })
    view.draw()
    await act(async () => { view.button('Cancel')!.click() })
    view.draw()
    expect(view.status()?.textContent).toBe('Comparison cancelled.')
    expect(view.button('Close')).toBeDefined()
    expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
    view.unmount()
  })

  it('stays open, offering Show It, when its comparison lands while the focus is in another dialog', async () => {
    const view = fixture()
    let finish!: (answer: DiffAnswer) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>(yes => { finish = yes }))
    await act(async () => { view.button('Compare')!.click() })
    // F1: the palette takes the focus, and the popover stays for it to give the focus back.
    const palette = document.body.appendChild(document.createElement('div'))
    palette.setAttribute('role', 'dialog')
    const input = palette.appendChild(document.createElement('input'))
    try {
      act(() => { input.focus() })
      await act(async () => { finish({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 2, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' }) })
      view.draw()
      expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
      expect(view.button('Show It')).toBeDefined()
      expect(document.activeElement).toBe(input)
      expect(view.results.getSnapshot().t1.focused).not.toBe(view.results.getSnapshot().t1.sets.find(set => set.descriptor.kind === 'diff')?.key)
    } finally {
      palette.remove()
    }
  })

  it('closes and focuses its comparison when the focus fell to the page (a press on its text) while it ran', async () => {
    const view = fixture()
    let finish!: (answer: DiffAnswer) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>(yes => { finish = yes }))
    await act(async () => { view.button('Compare')!.click() })
    act(() => { (document.activeElement as HTMLElement | null)?.blur() })
    expect(document.activeElement).toBe(document.body)
    await act(async () => { finish({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 2, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' }) })
    view.draw()
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    expect(view.results.getSnapshot().t1.focused).toBe(view.results.getSnapshot().t1.sets.find(set => set.descriptor.kind === 'diff')?.key)
  })

  it('clears what it said of a Compare with Previous Result when that is asked for again', async () => {
    const view = fixture()
    vi.mocked(view.handle(view.keys[0]).diff).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'Too large to compare.'))
    await act(async () => { await view.compare.compare('t1', view.keys[1]) })
    view.draw()
    expect(view.status()?.textContent).toBe('Too large to compare.')
    let finish!: (answer: DiffAnswer) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>(yes => { finish = yes }))
    const again = view.compare.compare('t1', view.keys[1])
    view.draw()
    expect(view.status()?.textContent).toBe('')
    await act(async () => { finish({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 2, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' }); await again })
    view.draw()
    expect(view.status()?.textContent).toBe('')
    expect(view.button('Show It')).toBeDefined()
  })

  it('says a failure of Compare with Previous Result on the pair it shows, where it offered its Cancel', async () => {
    const view = fixture()
    let fail!: (error: unknown) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>((_yes, no) => { fail = no }))
    const notify = vi.spyOn(view.results, 'notify')
    const running = view.compare.compare('t1', view.keys[1])
    view.draw()
    expect(view.button('Cancel')).toBeDefined()
    await act(async () => { fail(new ResultError('TOO_LARGE', 'Too large to compare.')); await running })
    view.draw()
    expect(view.status()?.textContent).toBe('Too large to compare.')
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps the focus inside when Enter on a target starts a comparison that fails', async () => {
    const view = fixture({ count: 3, open: 2 })
    let fail!: (error: unknown) => void
    vi.mocked(view.handle(view.keys[1]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>((_yes, no) => { fail = no }))
    const radio = view.popover()!.querySelector<HTMLInputElement>('input[type="radio"]:checked')!
    expect(document.activeElement).toBe(radio)
    await act(async () => { radio.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    view.draw()
    expect(radio.disabled).toBe(false)
    const compareButton = view.popover()!.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(document.activeElement).toBe(compareButton)
    await act(async () => { fail(new ResultError('TOO_LARGE', 'Too large.')) })
    view.draw()
    expect(document.activeElement).toBe(compareButton)
    view.key(compareButton, 'Escape')
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    view.unmount()
  })

  it('brings its window forward when opened from another, so the keys reach it', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const view = fixture()
    try {
      expect(focus).toHaveBeenCalled()
      expect(document.activeElement).toBe(view.button('Compare'))
    } finally {
      view.unmount()
      hasFocus.mockRestore()
      focus.mockRestore()
    }
  })

  it('places itself by all of its content, so content that grows moves a capped card above its anchor', () => {
    // The results sit low in a 768px window; the card, once capped, shows only part of a body that scrolls.
    let content = 80
    const sizes: Record<string, () => Partial<Record<'offsetHeight' | 'clientHeight' | 'scrollHeight', number>>> = {
      'compare-popover': () => ({ offsetHeight: Math.min(content + 60, 156), scrollHeight: Math.min(content + 60, 156) }),
      'compare-body': () => ({ clientHeight: Math.min(content, 96), scrollHeight: content })
    }
    const restore = (['offsetHeight', 'clientHeight', 'scrollHeight'] as const).map(name => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { for (const [cls, size] of Object.entries(sizes)) if (this.classList.contains(cls)) return size()[name] ?? 0; return 0 } })
      return () => { if (original) Object.defineProperty(HTMLElement.prototype, name, original); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name] }
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-pane]') ? { left: 0, top: 600, right: 1000, bottom: 700, width: 1000, height: 100, x: 0, y: 600, toJSON: () => ({}) } as DOMRect : new DOMRect()
    })
    let cleanup = () => {}
    try {
      const view = fixture()
      cleanup = view.unmount
      expect(view.popover()!.style.top).toBe('604px')
      // More content (a section appears): the card is capped at 156px, but all of it wants 360px, so it goes above.
      content = 300
      view.draw()
      expect(view.popover()!.style.top).toBe('')
      expect(view.popover()!.style.bottom).toBe('72px')
    } finally {
      cleanup()
      rect.mockRestore()
      for (const undo of restore) undo()
    }
  })

  it('closes when its pane moves to another window, but not when another pane moves', () => {
    const view = fixture()
    act(() => { windows.adopted() })
    expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
    const other = document.implementation.createHTMLDocument('popout')
    act(() => { other.body.append(view.container); windows.adopted() })
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    view.unmount()
  })

  it('closes its picker when it is no longer drawn, but not when it is drawn again at once', async () => {
    const view = fixture()
    // StrictMode (the fixture's, as the app's) unmounts and mounts it again at once: it stays open.
    await act(async () => { await Promise.resolve() })
    expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
    view.unmount()
    await Promise.resolve()
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it('marks a target that has a column the result lacks, and one that pairs every column not at all', () => {
    const view = fixture({ count: 3, open: 2, columns: { 0: [column('Id'), column('Name')], 1: [column('Id'), column('Name'), column('Price')], 2: [column('Id'), column('Name')] } })
    const radios = [...view.popover()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios[1].closest('label')?.textContent).toContain('2 of 3 columns')
    expect(radios[0].closest('label')?.querySelector('.compare-chip')).toBeNull()
    view.unmount()
  })

  it('stays open, with the focus on Swap, when a comparison finishes after the pair was swapped', async () => {
    // An earlier test's comparison may still be looking for its grid (focusResultGrid tries for 10 frames), under the same
    // entry key as this one's: let those tries run out first, so only this test's comparison could focus the grid below.
    for (let frame = 0; frame < 11; frame++) await new Promise(resolve => requestAnimationFrame(resolve))
    const view = fixture()
    let finish!: (answer: DiffAnswer) => void
    vi.mocked(view.handle(view.keys[0]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>(yes => { finish = yes }))
    await act(async () => { view.button('Compare')!.click() })
    view.draw()
    const swap = view.popover()!.querySelector<HTMLButtonElement>('button[aria-label="Swap old and new"]')!
    swap.focus()
    act(() => { swap.click() })
    view.draw()
    expect(view.button('Close')).toBeDefined()
    // The finished comparison's grid is there to take the focus, but it does not: the popover shows another pair.
    const grid = view.container.appendChild(document.createElement('div'))
    grid.tabIndex = 0
    grid.setAttribute('data-result-grid', '')
    grid.setAttribute('data-tab-id', 't1')
    const off = view.results.subscribe(() => { const made = view.results.getSnapshot().t1?.sets.find(set => set.descriptor.kind === 'diff'); if (made) grid.setAttribute('data-result-entry', made.key) })
    await act(async () => { finish({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 2, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' }) })
    view.draw()
    off()
    expect(grid.hasAttribute('data-result-entry')).toBe(true)
    expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
    expect(document.activeElement).toBe(swap)
  })

  it('opened again on a pair still comparing, still offers the other targets, which compare beside it', async () => {
    const view = fixture({ count: 3, open: 2 })
    vi.mocked(view.handle(view.keys[1]).diff).mockImplementationOnce(() => new Promise<DiffAnswer>(() => {}))
    await act(async () => { view.button('Compare')!.click() })
    act(() => { view.compare.close('t1') })
    act(() => { view.compare.open('t1', view.keys[2]) })
    view.draw()
    const radios = [...view.popover()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.every(radio => !radio.disabled)).toBe(true)
    expect(document.activeElement).toBe(radios[1])
    // Picking Result 1 shows a pair that is not running: Compare is offered again.
    act(() => { radios[0].click() })
    view.draw()
    expect(view.popover()!.querySelector('button[type="submit"]')?.hasAttribute('aria-disabled')).toBe(false)
    expect(view.button('Close')).toBeDefined()
    view.unmount()
  })

  it("closes when the focus moves out by key, but not into another dialog or to the toolbar's Compare", () => {
    const view = fixture()
    const palette = document.createElement('div')
    palette.setAttribute('role', 'dialog')
    const input = palette.appendChild(document.createElement('input'))
    const toolbar = view.container.appendChild(document.createElement('button'))
    toolbar.className = 'results-compare'
    const editor = document.body.appendChild(document.createElement('textarea'))
    document.body.append(palette)
    try {
      act(() => { input.focus() })
      expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
      act(() => { view.button('Compare')!.focus() })
      act(() => { toolbar.focus() })
      expect(view.compare.getSnapshot().pickers.t1).toBeDefined()
      act(() => { view.button('Compare')!.focus() })
      act(() => { editor.focus() })
      expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    } finally {
      palette.remove()
      editor.remove()
    }
  })

  it('closes when its window loses the focus (a press in another window)', () => {
    const view = fixture()
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(view.compare.getSnapshot().pickers.t1).toBeUndefined()
    view.unmount()
  })
})

describe('Compare popover placement', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })
  const base = { width: 1200, height: 800, cardWidth: 300, wanted: 200 }
  it('sits under the toolbar button, right-aligned to it', () => {
    expect(placePopover({ ...base, anchor: box(900, 100, 924, 124), trigger: true })).toEqual({ left: 624, top: 128, maxHeight: 664 })
  })
  it('flips above the button when the card does not fit below and there is more room above', () => {
    expect(placePopover({ ...base, anchor: box(900, 700, 924, 724), trigger: true })).toEqual({ left: 624, bottom: 104, maxHeight: 688 })
  })
  it('slides up rather than run off the bottom when neither side has room for all of it', () => {
    expect(placePopover({ ...base, height: 300, wanted: 260, anchor: box(900, 120, 924, 144), trigger: true })).toEqual({ left: 624, top: 32, maxHeight: 260 })
  })
  it('sits at the top right of the grid part in view, never above the results', () => {
    // The grid's top is scrolled out of the results (area from 300): the popover starts at the results' top.
    expect(placePopover({ ...base, anchor: box(0, -400, 1000, 900), area: box(0, 300, 1000, 800), trigger: false })).toEqual({ left: 688, top: 304, maxHeight: 488 })
    // A grid wholly out of view: the results area itself.
    expect(placePopover({ ...base, anchor: box(0, 900, 1000, 1200), area: box(0, 300, 1000, 800), trigger: false })).toEqual({ left: 688, top: 304, maxHeight: 488 })
  })
  it('stays inside a window narrower than the card', () => {
    expect(placePopover({ ...base, width: 250, cardWidth: 234, anchor: box(200, 10, 224, 34), trigger: true }).left).toBe(8)
  })
})

describe('Compare popover with named results', () => {
  it('numbers a result in the columns not compared when another result of the run has its name', () => {
    const view = fixture({ count: 3, open: 2, names: { 0: 'Totals', 1: 'Totals', 2: 'Orders' }, columns: { 0: [column('Id'), column('Name')], 1: [column('Id'), column('Price')], 2: [column('Id'), column('Name')] } })
    expect(view.popover()!.querySelector('section')!.textContent).toContain('only in Totals (Result 2)')
    view.unmount()
  })
  it("adds no tooltip to an unnamed result's heading or sides", () => {
    const view = fixture()
    expect(view.popover()!.querySelector('h2')!.hasAttribute('title')).toBe(false)
    expect([...view.popover()!.querySelectorAll('.compare-side b')].map(side => side.hasAttribute('title'))).toEqual([false, false])
    view.unmount()
  })
  it('lists each target by its name with its number as secondary text, so two of one name are told apart', () => {
    const view = fixture({ count: 4, open: 3, names: { 0: 'Totals', 2: 'Totals' } })
    expect(view.popover()?.querySelector('h2')?.textContent).toBe('Compare Result 4 with')
    const targets = [...view.popover()!.querySelectorAll<HTMLLabelElement>('.compare-target')]
    expect(targets.map(target => target.querySelector('.compare-target-name')?.textContent)).toEqual(['Totals', 'Result 2', 'Totals'])
    expect(targets.map(target => target.querySelector('.compare-target-number')?.textContent ?? null)).toEqual(['Result 1', null, 'Result 3'])
    expect(targets[0].querySelector('.compare-target-name')?.getAttribute('title')).toBe('Totals · Result 1')
    expect(targets[1].querySelector('.compare-target-name')?.getAttribute('title')).toBeNull()
    view.unmount()
  })
  it('titles a comparison of a named result by its name, frozen when made', async () => {
    const view = fixture({ names: { 0: 'Open orders' } })
    expect(view.popover()?.querySelector('[aria-label="Old side"] b')?.textContent).toBe('Open orders · Result 1')
    vi.mocked(view.handle(view.keys[0]).diff).mockResolvedValueOnce(made(2))
    await act(async () => { view.button('Compare')!.click() })
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    const diff = view.results.getSnapshot().t1.sets.at(-1)!
    expect(diff.label).toBe('Differences: Open orders → Result 2')
    const info = view.compare.getSnapshot().info.get(`${diff.descriptor.generation}:${diff.descriptor.resultId}`)
    expect(info && [info.leftName, info.rightName]).toEqual(['Open orders', 'Result 2'])
    view.unmount()
  })
  it("says in the Compare button the title the comparison will have, numbered when another result shares a side's name", () => {
    const view = fixture({ count: 3, open: 1, names: { 0: 'Totals', 1: 'Orders', 2: 'Totals' } })
    expect(view.button('Compare')!.title).toBe('Opens “Differences: Totals (Result 1) → Orders”, a copy that stays when its inputs close')
    view.unmount()
  })
  it('titles a comparison of two results of one name with their numbers, so it says which way round it is', async () => {
    const view = fixture({ names: { 0: 'Totals', 1: 'Totals' } })
    // The sides carry their numbers in full in their tooltips, as a long name cuts the text short.
    expect([...view.popover()!.querySelectorAll('.compare-side b')].map(side => side.getAttribute('title'))).toEqual(['Totals · Result 1', 'Totals · Result 2'])
    // The heading says which of the two is compared.
    expect(view.popover()?.querySelector('h2')?.textContent).toMatch(/^Compare Totals \(Result [12]\)/)
    vi.mocked(view.handle(view.keys[0]).diff).mockResolvedValueOnce(made(2))
    await act(async () => { view.button('Compare')!.click() })
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    const diff = view.results.getSnapshot().t1.sets.at(-1)!
    expect(diff.label).toBe('Differences: Totals (Result 1) → Totals (Result 2)')
    const info = view.compare.getSnapshot().info.get(`${diff.descriptor.generation}:${diff.descriptor.resultId}`)
    expect(info && [info.leftName, info.rightName]).toEqual(['Totals (Result 1)', 'Totals (Result 2)'])
    // Its sources' names, which its strip's links and "(closed)" read, carry the numbers too.
    expect(view.results.getSnapshot().t1.comparisons.at(-1)!.sources.map(source => source.name)).toEqual(['Totals (Result 1)', 'Totals (Result 2)'])
    view.unmount()
  })

  it('says All rows did not fit in the popover, offers Show changes only there, and says what rows match by', async () => {
    const view = fixture()
    expect(view.popover()?.querySelector('.compare-matching')?.textContent).toBe('Match rows by: Automatic')
    const diff = vi.mocked(view.handle(view.keys[0]).diff)
    diff.mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await act(async () => { view.button('Compare')!.click(); for (let i = 0; i < 12; i++) await Promise.resolve() })
    view.draw()
    expect(view.status()?.textContent).toBe('Not enough result memory for all rows.')
    expect(diff.mock.calls[0][1]).toMatchObject({ context: -1 })
    diff.mockResolvedValueOnce(made(0))
    await act(async () => { view.button('Show changes only')!.click(); for (let i = 0; i < 12; i++) await Promise.resolve() })
    expect(diff.mock.calls[1][1]).toMatchObject({ context: 0 })
    expect(view.results.getSnapshot().t1.comparisons).toHaveLength(1)
    expect(view.compare.getSnapshot().actionable.t1).toBeUndefined()
    view.unmount()
  })
})
