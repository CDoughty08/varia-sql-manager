// @vitest-environment happy-dom
// Progressive-disclosure popovers on ResultsToolbar (White space & Sort text by): compact icon-only triggers at default,
// tinted state chips when non-default, full keyboard navigation and Escape focus return, and command ID parity.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ResultsToolbar from '../src/renderer/src/results/ResultsToolbar'
import { descriptor, summaryOf } from './fixtures/results'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function setupToolbar() {
  const f = workbenchFixture()
  mounted.add(f.dispose)
  const tab = f.documents.create('query.sql', 'SELECT 1', 'master')
  const set = descriptor(1, { rowsRead: 5, rowsStored: 5, rowsAvailable: 5 })
  f.results.begin(tab.id, 'q1')
  f.resultClient.emit('q1', { type: 'resultSet.opened', descriptor: set })
  await f.results.finish(tab.id, 'q1', { summary: summaryOf([set]) })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  mounted.add(() => act(() => root.unmount()))
  await act(async () => {
    root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultsToolbar, { tabId: tab.id }) }))
  })
  const trigger = (prefix: string) => container.querySelector<HTMLButtonElement>(`button[aria-label^="${prefix}:"]`)!
  const menu = (name: string) => document.querySelector<HTMLElement>(`[role="menu"][aria-label="${name}"]`)
  const items = (name: string) => [...(menu(name)?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
  return { ...f, tab, container, trigger, menu, items }
}

describe('ResultsToolbar progressive disclosure chips', () => {
  it('stay compact at default and expand into tinted state chips when White space or Sort text by is non-default', async () => {
    const { commands, settings, trigger, menu, items } = await setupToolbar()
    const execute = vi.spyOn(commands, 'execute')

    // At default: compact icon-only triggers (no label text, no data-active), White space holds the toolbar Tab stop.
    expect(trigger('White space').getAttribute('aria-label')).toBe('White space: Off')
    expect(trigger('White space').textContent).toBe('')
    expect(trigger('White space').hasAttribute('data-active')).toBe(false)
    expect(trigger('White space').getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger('White space').getAttribute('aria-expanded')).toBe('false')
    expect(trigger('White space').tabIndex).toBe(0)
    expect(trigger('Sort text by').getAttribute('aria-label')).toBe('Sort text by: Value')
    expect(trigger('Sort text by').textContent).toBe('')
    expect(trigger('Sort text by').hasAttribute('data-active')).toBe(false)
    expect(trigger('Sort text by').tabIndex).toBe(-1)

    // Choose Spaces via the popover: executes output.showSpaces and expands into a tinted chip showing "Spaces".
    await act(async () => { trigger('White space').click() })
    expect(trigger('White space').getAttribute('aria-expanded')).toBe('true')
    expect(items('White space').map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    await act(async () => { items('White space')[1].click() })
    expect(execute).toHaveBeenCalledWith('output.showSpaces', expect.objectContaining({ tabId: expect.any(String) }), 'toolbar')
    expect(settings.getSnapshot().values['queryResults.grid.whitespace']).toBe('spaces')
    expect(menu('White space')).toBeNull()
    expect(trigger('White space').getAttribute('aria-label')).toBe('White space: Spaces')
    expect(trigger('White space').textContent).toBe('Spaces')
    expect(trigger('White space').hasAttribute('data-active')).toBe(true)
    expect(document.activeElement).toBe(trigger('White space'))

    // Choose All -> executes output.showAllWhitespace; choose Off -> turns off via output.showAllWhitespace and collapses back.
    await act(async () => { trigger('White space').click() })
    await act(async () => { items('White space')[2].click() })
    expect(execute).toHaveBeenLastCalledWith('output.showAllWhitespace', expect.objectContaining({ tabId: expect.any(String) }), 'toolbar')
    expect(trigger('White space').textContent).toBe('All')
    await act(async () => { trigger('White space').click() })
    await act(async () => { items('White space')[0].click() })
    expect(settings.getSnapshot().values['queryResults.grid.whitespace']).toBe('none')
    expect(trigger('White space').textContent).toBe('')
    expect(trigger('White space').hasAttribute('data-active')).toBe(false)

    // Sort text by: Chars -> output.sortTextByChars, Bytes -> output.sortTextByBytes, Value -> collapses back.
    await act(async () => { trigger('Sort text by').click() })
    await act(async () => { items('Sort text by')[1].click() })
    expect(execute).toHaveBeenLastCalledWith('output.sortTextByChars', expect.objectContaining({ tabId: expect.any(String) }), 'toolbar')
    expect(trigger('Sort text by').textContent).toBe('Chars')
    expect(trigger('Sort text by').hasAttribute('data-active')).toBe(true)

    await act(async () => { trigger('Sort text by').click() })
    await act(async () => { items('Sort text by')[2].click() })
    expect(execute).toHaveBeenLastCalledWith('output.sortTextByBytes', expect.objectContaining({ tabId: expect.any(String) }), 'toolbar')
    expect(trigger('Sort text by').textContent).toBe('Bytes')

    await act(async () => { trigger('Sort text by').click() })
    await act(async () => { items('Sort text by')[0].click() })
    expect(settings.getSnapshot().values['queryResults.grid.sortText']).toBe('value')
    expect(trigger('Sort text by').textContent).toBe('')
    expect(trigger('Sort text by').hasAttribute('data-active')).toBe(false)
  })

  it('supports keyboard navigation inside popovers and returns focus to the trigger on Escape', async () => {
    const { trigger, menu, items } = await setupToolbar()
    const ws = trigger('White space')
    ws.focus()
    // ArrowDown on trigger opens the menu on the first item.
    await act(async () => { ws.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(menu('White space')).not.toBeNull()
    expect(document.activeElement).toBe(items('White space')[0])
    // ArrowDown moves to Spaces, End moves to All, Home moves back to Off.
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(items('White space')[1])
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(document.activeElement).toBe(items('White space')[2])
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(document.activeElement).toBe(items('White space')[0])
    // Escape closes the popover and returns focus to the trigger.
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu('White space')).toBeNull()
    expect(ws.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(ws)
  })

  it('R5-D4-3: consumes Find in Results focus requests while Summary is active so switching to a grid never steals focus later', async () => {
    const f = workbenchFixture()
    mounted.add(f.dispose)
    f.settings.choose('queryResults.grid.layout', 'tabs')
    const tab = f.documents.create('multi.sql', 'SELECT 1', 'master')
    const targets = [
      { targetKey: 's1', connectionId: 'c1', provider: 'sqlserver' as const, label: 'srv-1' },
      { targetKey: 's2', connectionId: 'c2', provider: 'sqlserver' as const, label: 'srv-2' }
    ]
    const set1 = descriptor(1, { index: 0, targetKey: 's1', statementSlot: 0 })
    const set2 = descriptor(2, { index: 1, targetKey: 's2', statementSlot: 0 })
    f.results.begin(tab.id, 'q1', undefined, { multi: { mode: 'fireAndForget', targets } })
    await f.results.finish(tab.id, 'q1', {
      multiSummary: {
        status: 'completed',
        mode: 'fireAndForget',
        targets: targets.map((t, i) => ({ targetKey: t.targetKey, provider: t.provider, label: t.label, status: 'succeeded', batchesCompleted: 1, batchesTotal: 1, rowsAffected: 1, elapsedMs: 10, resultSetIds: [i + 1] })),
        resultSets: [set1, set2],
        discardedResultSets: 0,
        messages: [],
        messagesTruncated: false,
        elapsedMs: 10,
        budget: { usedBytes: 0, globalBytes: 1024, queryBytes: 1024, generation: 1, seq: 1 },
        completedAt: '2026-11-26T18:30:00.0000000+00:00'
      }
    })
    // Summary is active by default in Tabs layout for multi-server runs, so the search box is disabled.
    const container = document.body.appendChild(document.createElement('div'))
    const outside = document.body.appendChild(document.createElement('button'))
    outside.focus()
    const root = createRoot(container)
    mounted.add(() => act(() => root.unmount()))
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: createElement(ResultsToolbar, { tabId: tab.id }) }))
    })
    const input = container.querySelector<HTMLInputElement>('.results-search input')!
    expect(input.disabled).toBe(true)

    // Press Find in Results while Summary is active: focus request is consumed without focusing the disabled input.
    await act(async () => { f.resultsSearch.focus(tab.id) })
    expect(document.activeElement).toBe(outside)

    // Switch to a result grid tab: search box enables, and focus MUST stay on `outside` (never stolen!).
    const gridKey = f.results.getSnapshot()[tab.id].sets[0].key
    await act(async () => { f.results.focusEntry(tab.id, gridKey) })
    expect(input.disabled).toBe(false)
    expect(document.activeElement).toBe(outside)

    // Pressing Find in Results now that a grid is active DOES focus the search input.
    await act(async () => { f.resultsSearch.focus(tab.id) })
    expect(document.activeElement).toBe(input)
  })
})
