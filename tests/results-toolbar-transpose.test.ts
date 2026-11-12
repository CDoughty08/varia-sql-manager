// @vitest-environment happy-dom
// The results toolbar's Transposed button and its Headers drop-down follow the grid that last had the focus, and a results
// grid follows its view's orientation: it is built again turned, takes its highlights again, says in its strip when the view
// has more rows than it draws as columns, and tells the toolbar when Find Next lands on a match past them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ResultColumn } from '../src/shared/contracts'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { GridView } from '../src/renderer/src/grid/GridView'
import ResultGrid from '../src/renderer/src/grid/ResultGrid'
import ResultsToolbar from '../src/renderer/src/results/ResultsToolbar'
import { beyondCapText } from '../src/renderer/src/results/ResultsService'
import { descriptor, summaryOf } from './fixtures/results'
import { keyAt } from './fixtures/entries'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const realSetHighlights = GridView.prototype.setHighlights
const mounted = new Set<() => void>()
afterEach(() => {
  for (const unmount of mounted) unmount()
  mounted.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const columns: ResultColumn[] = [
  { name: 'Id', dataType: 'int', wire: 'text', nullable: false }, { name: 'Country', dataType: 'nvarchar(60)', wire: 'text', nullable: true }, { name: 'A name long enough to be cut', dataType: 'int', wire: 'text', nullable: true }
]

/** A query tab whose run returned two results of `rows` rows, and a way to draw something of it. */
async function ran(rows = 10) {
  const f = workbenchFixture()
  mounted.add(f.dispose)
  const tab = f.documents.create('query.sql', 'SELECT 1', 'master')
  const sets = [descriptor(1, { rowsRead: rows, rowsStored: rows, rowsAvailable: rows, columns }), descriptor(2, { index: 1, rowsRead: rows, rowsStored: rows, rowsAvailable: rows, columns })]
  f.results.begin(tab.id, 'q1')
  for (const set of sets) f.resultClient.emit('q1', { type: 'resultSet.opened', descriptor: set })
  await f.results.finish(tab.id, 'q1', { summary: summaryOf(sets) })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  mounted.add(() => act(() => root.unmount()))
  const draw = (child: () => ReturnType<typeof createElement>) => act(async () => root.render(createElement(WorkbenchProvider, { workbench: f as unknown as Workbench, children: child() })))
  const key = (place = 0) => keyAt(f.results, tab.id, place)
  return { ...f, tab, container, draw, key }
}

describe('results toolbar Transposed', () => {
  it('is pressed while the focused grid is transposed, and turns it on a click without asking the backend', async () => {
    const { results, tab, container, draw, key } = await ran()
    await draw(() => createElement(ResultsToolbar, { tabId: tab.id }))
    const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Transposed"]')!
    const headers = () => container.querySelector<HTMLButtonElement>('button.results-headers')
    expect([button().disabled, button().getAttribute('aria-pressed'), headers()]).toEqual([false, 'false', null])
    await act(async () => { button().click() })
    expect(results.orientation(tab.id, key())).toEqual({ transposed: true })
    expect([button().getAttribute('aria-pressed'), headers()?.textContent]).toEqual(['true', 'Headers: Row number'])
    // The other grid takes the focus: it is a table, so the button is not pressed and Headers goes.
    await act(async () => { results.focusEntry(tab.id, key(1)) })
    expect([button().getAttribute('aria-pressed'), headers()]).toEqual(['false', null])
    await act(async () => { results.focusEntry(tab.id, key(0)) })
    await act(async () => { button().click() })
    expect(results.orientation(tab.id, key())).toEqual({ transposed: false })
    expect([button().getAttribute('aria-pressed'), headers()]).toEqual(['false', null])
  })

  it('Headers names the header column and opens the list below itself; a pick renames it', async () => {
    const { results, quickInput, tab, container, draw, key } = await ran()
    results.setOrientation(tab.id, key(), { transposed: true, headerColumn: 1 })
    await draw(() => createElement(ResultsToolbar, { tabId: tab.id }))
    const headers = () => container.querySelector<HTMLButtonElement>('button.results-headers')!
    expect([headers().textContent, headers().getAttribute('aria-haspopup')]).toEqual(['Headers: Country', 'listbox'])
    await act(async () => { headers().click() })
    const view = quickInput.getSnapshot()
    expect([view.visible, view.anchor, view.rows[view.activeIndex].item.label]).toEqual([true, headers(), 'Country'])
    await act(async () => { quickInput.accept(3) })
    expect(results.orientation(tab.id, key())).toEqual({ transposed: true, headerColumn: 2 })
    expect(headers().textContent).toBe('Headers: A name long enough to be cut')
    await act(async () => { headers().click() })
    await act(async () => { quickInput.accept(0) })
    expect(headers().textContent).toBe('Headers: Row number')
  })
})

describe('a results grid and its view\'s orientation', () => {
  /** Draws Result 1's grid, and names the GridView built for it last. */
  async function grid(rows: number) {
    const f = await ran(rows)
    const built: GridView[] = []
    // Every grid built is given its highlights (none, when it has none): that call names the views, in the order built.
    const setHighlights = vi.spyOn(GridView.prototype, 'setHighlights').mockImplementation(function (this: GridView, sets) {
      if (!built.includes(this)) built.push(this)
      return realSetHighlights.call(this, sets)
    })
    const entry = () => f.results.getSnapshot()[f.tab.id].sets[0]
    await f.draw(() => createElement(ResultGrid, { tabId: f.tab.id, entry: entry(), count: 2, focused: true, sort: f.results.getSnapshot()[f.tab.id].sorts.get(entry().key), onFocus: () => {} }))
    const element = () => f.container.querySelector<HTMLElement>('[data-result-grid]')!
    const strip = () => f.container.querySelector('.rg-strip')?.textContent
    return { ...f, built, setHighlights, element, strip, entry }
  }

  it('is built again turned by the command and back, and takes its highlights again each time', async () => {
    const { commands, highlights, resultSelection, tab, key, built, setHighlights, element } = await grid(10)
    resultSelection.set(tab.id, { entry: key(), blocks: [{ kind: 'rows', anchor: { row: 2, column: 0 }, focus: { row: 3, column: 0 } }], active: { row: 2, column: 0 } })
    await act(async () => { await highlights.highlight(tab.id, key(), 1) })
    const marked = highlights.getSnapshot()[tab.id]?.get(key())?.rows
    expect(marked?.length).toBeGreaterThan(0)
    expect(element().dataset.orientation).toBeUndefined()
    expect(built).toHaveLength(1)
    expect(setHighlights.mock.calls.at(-1)).toEqual([marked])
    // Transposed: another GridView over the same element, given the same highlighted rows, in the result's own rows.
    await act(async () => { await commands.execute('output.transpose', { tabId: tab.id }, 'toolbar') })
    expect(element().dataset.orientation).toBe('transposed')
    expect(built).toHaveLength(2)
    expect([setHighlights.mock.contexts.at(-1) === built[1], setHighlights.mock.calls.at(-1)]).toEqual([true, [marked]])
    // And back to a table.
    await act(async () => { await commands.execute('output.transpose', { tabId: tab.id }, 'toolbar') })
    expect(element().dataset.orientation).toBeUndefined()
    expect(built).toHaveLength(3)
    expect([setHighlights.mock.contexts.at(-1) === built[2], setHighlights.mock.calls.at(-1)]).toEqual([true, [marked]])
  })

  it('changes its header column without being built again', async () => {
    const { results, tab, key, built, element } = await grid(10)
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: true }) })
    const update = vi.spyOn(built.at(-1)!, 'update')
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: true, headerColumn: 1 }) })
    expect(element().dataset.orientation).toBe('transposed')
    expect(built).toHaveLength(2)
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({ headerColumn: 1 })
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: true, headerColumn: null }) })
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({ headerColumn: null })
  })

  it('says in its strip that only the first 4,095 rows are drawn as columns, while it is transposed', async () => {
    const { results, tab, key, strip } = await grid(6000)
    expect(strip()).toBeUndefined()
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: true }) })
    expect(strip()).toBe('Showing the first 4,095 of 6,000 rows as columns. Filter the Table to see other rows.')
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: false }) })
    expect(strip()).toBeUndefined()
  })

  it('has no cap strip for a view of at most 4,095 rows', async () => {
    const { results, tab, key, strip } = await grid(4095)
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: true }) })
    expect(strip()).toBeUndefined()
  })

  it('tells the toolbar when Find Next lands on a match in a row it does not draw, and does not move', async () => {
    const { results, tab, key, built, entry } = await grid(6000)
    await act(async () => { results.setOrientation(tab.id, key(), { transposed: true }) })
    const view = built.at(-1)!, before = results.selection(tab.id, key())
    // The match Find Next made current is in row 5,000: past the 4,095 rows drawn as columns.
    await act(async () => { view.setMarks({ handle: entry().handle, current: { row: 4999, column: 1 } }); view.revealMark(true) })
    expect(results.getSnapshot()[tab.id].jobNotice).toBe(beyondCapText(4999))
    expect(results.selection(tab.id, key())).toEqual(before)
    // A match in a row it draws is revealed, and says nothing.
    await act(async () => { results.notify(tab.id, '') ; view.setMarks({ handle: entry().handle, current: { row: 4094, column: 1 } }); view.revealMark(false) })
    expect(results.getSnapshot()[tab.id].jobNotice).toBe('')
  })
})
