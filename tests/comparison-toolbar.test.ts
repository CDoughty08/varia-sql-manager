// @vitest-environment happy-dom
// A comparison's toolbar: its sides link to the inputs and ⇄ swaps them, Layout and Exact text change the comparison in
// place, each control that runs it again is unavailable with the reason while an input is closed (D10), and a polite live
// region reads what each new or changed comparison found, the same sentence twice included.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ComparisonToolbar, { useLiveText } from '../src/renderer/src/results/ComparisonToolbar'
import CompareNotice from '../src/renderer/src/results/CompareNotice'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { CompareService, compareSources, fallbackText, type CompareInfo } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const drawn = new Set<() => void>()
afterEach(() => { for (const unmount of drawn) unmount(); drawn.clear() })

async function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results, { jobs: new DerivedJobs({ timers: timers.timers }) })
  results.begin('t1', 'q1')
  const values = [0, 1, 2].map(index => descriptor(index + 1, { index }))
  for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
  void results.finish('t1', 'q1', { summary: summaryOf(values) })
  const keys = results.getSnapshot().t1.sets.map(set => set.key)
  await act(async () => { await compare.comparePair('t1', keys[0], keys[1], { exact: false }) })
  const replace = vi.spyOn(compare, 'replace').mockResolvedValue(undefined)
  const goTo = vi.fn()
  const settingsSnapshot = { values: {} }, settings = { subscribe: () => () => {}, getSnapshot: () => settingsSnapshot }
  const commands = { execute: vi.fn() }
  const keybindings = { subscribe: () => () => {}, getRevision: () => 0, lookup: (id: string) => id === 'output.compareNextDifference' ? { text: 'Alt+F5', aria: 'Alt+F5' } : undefined }
  const workbench = { results, compare, settings, commands, keybindings } as unknown as Workbench
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const slot = () => results.getSnapshot().t1.comparisons[0]
  const draw = (info?: Partial<CompareInfo>) => act(() => {
    const tab = results.getSnapshot().t1, shown = compare.getSnapshot().info.get(setKey(slot().entry.descriptor))!
    root.render(createElement(StrictMode, null, createElement(WorkbenchProvider, { workbench, children: createElement(ComparisonToolbar, { tabId: 't1', entry: slot().entry, info: { ...shown, ...info }, sources: compareSources(tab, slot().sources), goTo }) })))
  })
  draw()
  const toolbar = () => container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Comparison tools"]')!
  const button = (name: string) => [...toolbar().querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === name)
  const unmount = () => { if (!drawn.delete(unmount)) return; act(() => { root.unmount(); container.remove() }) }
  drawn.add(unmount)
  return { results, compare, keys, replace, goTo, draw, toolbar, button, slot, container, workbench, unmount }
}

describe('a comparison\'s toolbar', () => {
  it('links its sides, swaps them, and changes the layout and Exact text in place', async () => {
    const view = await fixture()
    expect(view.toolbar().textContent).toContain('Differences')
    expect(view.toolbar().querySelector('[aria-label="Sides"]')?.textContent).toBe('− Result 1+ Result 2')
    act(() => { view.button('− Result 1')!.click() })
    expect(view.goTo).toHaveBeenCalledWith(view.keys[0])
    act(() => { view.button('Swap sides')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { swap: true })
    // One row per entry is pressed (the setting's default; the fake backend answers two rows, so it is drawn so); Two rows switches it.
    view.draw({ layout: 'entry' })
    expect(view.button('One row')!.getAttribute('aria-pressed')).toBe('true')
    expect(view.button('Two rows')!.getAttribute('aria-pressed')).toBe('false')
    act(() => { view.button('One row')!.click() })
    expect(view.replace).toHaveBeenCalledTimes(1)
    act(() => { view.button('Two rows')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { layout: 'unified' })
    expect(view.button('Exact text')!.getAttribute('aria-pressed')).toBe('false')
    act(() => { view.button('Exact text')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { exact: true })
    // The first side is the toolbar's one Tab stop; arrows move between its buttons.
    expect([...view.toolbar().querySelectorAll('button')].filter(item => item.tabIndex === 0)).toEqual([view.button('− Result 1')])
    view.button('− Result 1')!.focus()
    act(() => { view.button('− Result 1')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(view.button('Swap sides'))
  })

  it('makes every control that runs the comparison again unavailable while an input is closed, saying which (D10)', async () => {
    const view = await fixture()
    act(() => { view.results.removeEntry('t1', view.keys[0]) })
    view.draw()
    expect(view.toolbar().querySelector('[aria-label="Sides"]')?.textContent).toContain('Result 1 (closed)')
    for (const name of ['Swap sides', 'One row', 'Two rows', 'Exact text', 'All rows', 'Changes only', 'Match rows: Automatic: Id']) {
      const control = view.button(name)!
      expect(control, name).toBeDefined()
      expect(control.getAttribute('aria-disabled'), name).toBe('true')
      expect(control.title, name).toMatch(/unavailable because Result 1 is closed$/)
      act(() => { control.click() })
    }
    expect(view.replace).not.toHaveBeenCalled()
    expect(view.compare.getSnapshot().matchMenu).toBeUndefined()
    // So are the notices' buttons; Dismiss is not, since it changes nothing.
    view.draw({ same: 0, changed: 0, added: 1, removed: 1, nothingPaired: true, leftRows: 1, rightRows: 1 })
    const notices = view.container.querySelector('[role="group"][aria-label="Comparison notices"]')!
    const actions = [...notices.querySelectorAll<HTMLButtonElement>('button[data-action]')]
    expect(actions.map(button => button.textContent)).toEqual(['Choose key columns…', 'Match by row position'])
    // A notice's line is clipped in a narrow pane; its tooltip holds the whole of it.
    for (const text of notices.querySelectorAll<HTMLElement>('.rg-compare-notice-text')) expect(text.title).toBe(text.textContent)
    for (const action of actions) {
      expect(action.getAttribute('aria-disabled')).toBe('true')
      expect(action.title).toMatch(/unavailable because Result 1 is closed$/)
      act(() => { action.click() })
    }
    expect(view.replace).not.toHaveBeenCalled()
    expect(notices.querySelector('button[aria-label="Dismiss notice"]')?.getAttribute('aria-disabled')).toBeNull()
    // The chips only filter what the comparison holds, so they stay available.
    expect(view.button('1 added')!.getAttribute('aria-disabled')).toBeNull()
    // The open side still links to its input.
    act(() => { view.button('+ Result 2')!.click() })
    expect(view.goTo).toHaveBeenCalledWith(view.keys[1])
  })

  it('offers no one-row layout past the pairs it can show, saying why (D12)', async () => {
    const view = await fixture()
    view.draw({ layout: 'unified', fallback: true })
    expect(view.button('Two rows')!.getAttribute('aria-pressed')).toBe('true')
    expect(view.button('One row')!.getAttribute('aria-disabled')).toBe('true')
    expect(view.button('One row')!.title).toBe(fallbackText)
    act(() => { view.button('One row')!.click() })
    expect(view.replace).not.toHaveBeenCalled()
  })

  it('mounts its live region empty, says each new sentence once, and says nothing again when mounted again', () => {
    let seen: string[] = []
    let last = 0
    const speak = (at: number) => { if (at <= last) return false; last = at; return true }
    const Probe = ({ said }: { said: { text: string; at: number } }) => { seen.push(useLiveText(said, speak)); return null }
    const mountProbe = (said: { text: string; at: number }) => {
      seen = []
      const root = createRoot(document.createElement('div'))
      act(() => { root.render(createElement(Probe, { said })) })
      act(() => { root.unmount() })
      return seen
    }
    // A toolbar remounted by a change: empty first, then the sentence (a change of the region's text).
    const ready = { text: 'Comparison updated: matched by Id.', at: 2 }
    expect(mountProbe(ready)).toEqual(['', ready.text])
    // Mounted again (another tab shown and back) with nothing new: it stays empty.
    expect(mountProbe(ready)).toEqual([''])
    // A new announcement is said.
    expect(mountProbe({ text: 'The change was cancelled.', at: 3 }).at(-1)).toBe('The change was cancelled.\u00a0')
  })

  it('reads each announcement in its live region, the same sentence again too', async () => {
    const view = await fixture()
    const region = () => view.toolbar().querySelector('[role="status"]')!
    expect(region().getAttribute('aria-live')).toBe('polite')
    const first = region().textContent
    expect(first?.trim()).toBe('Comparison ready: matched by Id, 1 changed, 1 added, 0 removed.')
    // Cancel twice: the same sentence, said each time (the region's text changes).
    view.replace.mockRestore()
    vi.mocked(view.results.getSnapshot().t1.sets[0].handle.diff).mockImplementation((_right, o) => new Promise((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    const said: string[] = []
    for (let i = 0; i < 2; i++) {
      let change!: Promise<unknown>
      act(() => { change = view.compare.replace('t1', view.slot().key, { layout: 'unified' }) })
      await act(async () => { view.compare.cancelChange('t1', view.slot().key); await change })
      said.push(region().textContent ?? '')
    }
    expect(said.map(text => text.trim())).toEqual(['The change was cancelled.', 'The change was cancelled.'])
    expect(said[0]).not.toBe(said[1])
  })

  it('sets Rows in place, and filters by kind with its chips', async () => {
    const view = await fixture()
    expect(view.button('All rows')!.getAttribute('aria-pressed')).toBe('true')
    act(() => { view.button('All rows')!.click() })
    expect(view.replace).not.toHaveBeenCalled()
    act(() => { view.button('Changes only')!.click() })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { context: 0 })
    // A chip filters by its kind; one with no rows says so and does nothing.
    const toggleKind = vi.spyOn(view.compare, 'toggleKind').mockImplementation(() => {})
    expect(view.button('1 changed')!.getAttribute('aria-pressed')).toBe('false')
    act(() => { view.button('1 changed')!.click() })
    expect(toggleKind).toHaveBeenLastCalledWith('t1', view.slot().key, 'changed')
    const none = view.button('0 removed')!
    expect(none.getAttribute('aria-disabled')).toBe('true')
    expect(none.title).toBe('No removed rows')
    act(() => { none.click() })
    expect(toggleKind).toHaveBeenCalledTimes(1)
    expect(view.toolbar().textContent).toContain('1 unchanged')
  })

  it('picks key columns in its match menu, by keyboard too, and changes the comparison in place', async () => {
    const view = await fixture()
    const match = view.toolbar().querySelector<HTMLButtonElement>('[data-control="match"]')!
    expect(match.getAttribute('aria-haspopup')).toBe('dialog')
    // Its name holds what it shows (label in name).
    expect(match.getAttribute('aria-label')).toBe('Match rows: Automatic: Id')
    expect(match.textContent).toBe('Automatic: Id')
    act(() => { match.click() })
    expect(view.compare.getSnapshot().matchMenu).toEqual({ tabId: 't1', key: view.slot().key, from: 'toolbar' })
    view.draw()
    const dialog = () => document.querySelector<HTMLFormElement>('[role="dialog"][aria-label="Match rows by"]')
    expect(dialog()).not.toBeNull()
    expect(match.getAttribute('aria-expanded')).toBe('true')
    const list = dialog()!.querySelector<HTMLElement>('[role="listbox"]')!
    // The checklist is unavailable until Key columns is chosen; Apply is unavailable while none is ticked.
    expect(list.getAttribute('aria-disabled')).toBe('true')
    const radio = (label: string) => [...dialog()!.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!.querySelector('input')!
    act(() => { radio('Key columns').click() })
    expect(list.getAttribute('aria-disabled')).toBeNull()
    // Automatic's column starts ticked.
    const options = () => [...list.querySelectorAll('[role="option"]')]
    expect(options().map(option => option.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    act(() => { list.focus(); list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    act(() => { list.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    expect(options().map(option => option.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    expect(dialog()!.textContent).toContain('A row matches when all 2 columns are equal.')
    // Enter in the checklist applies, as Apply does.
    act(() => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(view.replace).toHaveBeenLastCalledWith('t1', view.slot().key, { match: { mode: 'columns', columns: [0, 1] } })
    expect(view.compare.getSnapshot().matchMenu).toBeUndefined()
    view.draw()
    expect(dialog()).toBeNull()
  })

  it('names key columns on Match without reading out the key mark it draws', async () => {
    const view = await fixture()
    view.draw({ asked: { mode: 'columns', columns: [0, 1] }, match: { mode: 'columns', columns: ['Id', 'Name'] } })
    const match = view.toolbar().querySelector<HTMLButtonElement>('[data-control="match"]')!
    expect(match.getAttribute('aria-label')).toBe('Match rows by key columns: Id + Name')
    expect(match.textContent).toBe('Id + Name')
    expect(match.querySelector('.rg-compare-key')).not.toBeNull()
  })

  it('gives the focus back to a notice\'s Choose key columns… when its match menu closes', async () => {
    const view = await fixture()
    view.draw({ same: 0, changed: 0, added: 1, removed: 1, nothingPaired: true, leftRows: 1, rightRows: 1 })
    const choose = view.container.querySelector<HTMLButtonElement>('button[data-action="chooseKeys"]')!
    act(() => { choose.focus(); choose.click() })
    expect(view.compare.getSnapshot().matchMenu).toEqual({ tabId: 't1', key: view.slot().key, from: 'notice' })
    view.draw({ same: 0, changed: 0, added: 1, removed: 1, nothingPaired: true, leftRows: 1, rightRows: 1 })
    const dialog = document.querySelector<HTMLFormElement>('[role="dialog"][aria-label="Match rows by"]')!
    act(() => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.compare.getSnapshot().matchMenu).toBeUndefined()
    expect(document.activeElement).toBe(choose)
  })

  it('closes its match menu from its Match button, a press there not counting as one outside', async () => {
    const view = await fixture()
    const match = () => view.toolbar().querySelector<HTMLButtonElement>('[data-control="match"]')!
    act(() => { match().click() })
    view.draw()
    expect(view.compare.getSnapshot().matchMenu).toBeDefined()
    act(() => { match().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); match().click() })
    expect(view.compare.getSnapshot().matchMenu).toBeUndefined()
    // Unmounted while open (its pane hidden), it closes rather than showing again later.
    act(() => { view.compare.openMatchMenu('t1', view.slot().key, 'toolbar') })
    view.draw()
    view.unmount()
    await act(async () => { await Promise.resolve() })
    expect(view.compare.getSnapshot().matchMenu).toBeUndefined()
  })

  it('gives the focus back to Match when the comparison closes its match menu while it holds the focus', async () => {
    const view = await fixture()
    const match = view.toolbar().querySelector<HTMLButtonElement>('[data-control="match"]')!
    act(() => { match.click() })
    view.draw()
    const radio = document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Match rows by"] input[type="radio"]')!
    act(() => { radio.focus() })
    expect(document.activeElement).toBe(radio)
    // A change refused or cancelled while it was open closes it from the service.
    act(() => { view.compare.closeMatchMenu() })
    view.draw()
    expect(document.querySelector('[role="dialog"][aria-label="Match rows by"]')).toBeNull()
    expect(document.activeElement).toBe(match)
  })

  it('closes its match menu with Escape, changing nothing', async () => {
    const view = await fixture()
    act(() => { view.compare.openMatchMenu('t1', view.slot().key, 'toolbar') })
    view.draw()
    const dialog = document.querySelector<HTMLFormElement>('[role="dialog"][aria-label="Match rows by"]')!
    act(() => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.compare.getSnapshot().matchMenu).toBeUndefined()
    expect(view.replace).not.toHaveBeenCalled()
  })

  it('says a first run All rows could not fit in the results toolbar, past a later notice, until acted on or dismissed', async () => {
    const view = await fixture()
    const diff = vi.mocked(view.results.getSnapshot().t1.sets[1].handle.diff)
    diff.mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await act(async () => { await view.compare.comparePair('t1', view.keys[1], view.keys[2], { exact: false }) })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const draw = () => act(() => { root.render(createElement(WorkbenchProvider, { workbench: view.workbench, children: createElement(CompareNotice, { tabId: 't1' }) })) })
    draw()
    const notice = () => host.querySelector<HTMLElement>('[role="group"][aria-label="Comparison notice"]')
    expect(notice()?.textContent).toContain('Compare Result 2 with Result 3: Not enough result memory for all rows.')
    act(() => { view.results.notify('t1', 'Copied 3 rows.') })
    draw()
    expect(notice()).not.toBeNull()
    act(() => { notice()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss comparison notice"]')!.click() })
    expect(notice()).toBeNull()
    // Again, and Show changes only compares them with Changes only.
    diff.mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await act(async () => { await view.compare.comparePair('t1', view.keys[1], view.keys[2], { exact: false }) })
    const show = [...notice()!.querySelectorAll('button')].find(button => button.textContent === 'Show changes only')!
    expect(show.getAttribute('aria-disabled')).toBeNull()
    await act(async () => { show.click(); for (let i = 0; i < 12; i++) await Promise.resolve() })
    expect(diff).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ context: 0 }))
    expect(notice()).toBeNull()
    act(() => { root.unmount(); host.remove() })
  })

  it('keeps the focus in the results toolbar when its Show changes only goes with its notice and the run fails', async () => {
    const view = await fixture()
    const diff = vi.mocked(view.results.getSnapshot().t1.sets[1].handle.diff)
    diff.mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await act(async () => { await view.compare.comparePair('t1', view.keys[1], view.keys[2], { exact: false }) })
    const bar = document.createElement('div'), tab = document.createElement('button'), host = document.createElement('div')
    bar.className = 'output-toolbar'
    tab.setAttribute('role', 'tab')
    tab.tabIndex = 0
    bar.append(tab, host)
    document.body.append(bar)
    const root = createRoot(host)
    act(() => { root.render(createElement(WorkbenchProvider, { workbench: view.workbench, children: createElement(CompareNotice, { tabId: 't1' }) })) })
    const show = [...host.querySelectorAll('button')].find(button => button.textContent === 'Show changes only')!
    diff.mockRejectedValueOnce(new ResultError('BACKEND_ERROR', 'Failed.'))
    show.focus()
    await act(async () => { show.click(); for (let i = 0; i < 12; i++) await Promise.resolve() })
    expect(host.querySelector('[role="group"][aria-label="Comparison notice"]')).toBeNull()
    expect(document.activeElement).toBe(tab)
    act(() => { root.unmount(); bar.remove() })
  })

  it('moves the focus on when a refused change\'s Show changes only takes its notice away', async () => {
    const view = await fixture()
    view.replace.mockRestore()
    const key = view.slot().key
    const diff = vi.mocked(view.results.getSnapshot().t1.sets[0].handle.diff)
    diff.mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await act(async () => { await view.compare.replace('t1', key, { exact: true }) })
    view.draw()
    const show = view.container.querySelector<HTMLButtonElement>('button[data-action="changesOnly"]')!
    act(() => { show.focus(); show.click() })
    view.draw()
    expect(view.container.querySelector('button[data-action="changesOnly"]')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(view.container.contains(document.activeElement)).toBe(true)
    await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
  })

  it('leaves the focus on Show changes only when its change does not start and the notice stays', async () => {
    const view = await fixture()
    view.replace.mockRestore()
    const key = view.slot().key
    const diff = vi.mocked(view.results.getSnapshot().t1.sets[0].handle.diff)
    diff.mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await act(async () => { await view.compare.replace('t1', key, { exact: true }) })
    // A change that does not start (the pair shown elsewhere, or being compared already) leaves the notice.
    vi.spyOn(view.compare, 'replace').mockResolvedValue(undefined)
    view.draw()
    const show = view.container.querySelector<HTMLButtonElement>('button[data-action="changesOnly"]')!
    act(() => { show.focus(); show.click() })
    view.draw()
    view.draw()
    expect(view.container.querySelector('button[data-action="changesOnly"]')).toBe(show)
    expect(document.activeElement).toBe(show)
  })

  it('steps to the previous and next difference, saying where it is, and has nowhere to go without a change', async () => {
    const view = await fixture()
    const navigate = vi.spyOn(view.compare, 'navigate').mockResolvedValue(undefined)
    const nav = view.toolbar().querySelector('[role="group"][aria-label="Differences"]')!
    // Before any move it says the comparison's change units (the fake backend's answer has 2).
    expect(nav.textContent).toBe('2 changes')
    expect(view.button('Next difference')!.title).toBe('Next difference (Alt+F5)')
    expect(view.button('Next difference')!.getAttribute('aria-keyshortcuts')).toBe('Alt+F5')
    act(() => { view.button('Next difference')!.click() })
    expect(navigate).toHaveBeenLastCalledWith('t1', view.slot().key, 'next')
    act(() => { view.button('Previous difference')!.click() })
    expect(navigate).toHaveBeenLastCalledWith('t1', view.slot().key, 'previous')
    // Where the last move landed, in what the grid shows now.
    navigate.mockRestore()
    const entry = view.slot().entry
    vi.mocked(entry.handle.diffSeek).mockResolvedValueOnce({ row: 1, column: 0, index: 2, total: 2, rows: 3 })
    view.results.registerGrid('t1', entry.key, { selectAll: () => {}, repaint: () => {}, fitColumn: () => {}, diff: { active: () => undefined, handle: () => entry.handle, land: () => {}, tone: () => undefined } })
    await act(async () => { await view.compare.navigate('t1', entry.key, 'next') })
    expect(nav.textContent).toBe('Change 2 of 2')
    // No change: both are unavailable and say why; the controls stay in the toolbar.
    view.draw({ units: 0 })
    expect(view.button('Next difference')!.getAttribute('aria-disabled')).toBe('true')
    expect(view.button('Previous difference')!.title).toBe('Previous difference: no differences')
  })
})
