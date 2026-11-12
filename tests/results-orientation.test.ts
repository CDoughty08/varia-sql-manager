// @vitest-environment happy-dom
// The transpose commands set how a grid is drawn (ResultsService.setOrientation): nothing is stored, no backend request is
// made, and the view's selection, sort and filters stay. Covered here: each command, the header column, the
// `resultsGridTransposed` key and the toggle a menu reads, what can be turned, Fit Column and the column commands on a
// transposed grid's menu targets, a Peek card's grid, and the sentences for the cap.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultColumn } from '../src/shared/contracts'
import { limits as wire } from '../src/shared/ipc/wire/protocol'
import type { CommandArgs } from '../src/renderer/src/core/types'
import { selectAll, type GridSelection } from '../src/renderer/src/grid/selection'
import { argsFor, type OutputTarget } from '../src/renderer/src/menus/targets'
import type { ResultView } from '../src/renderer/src/results/ResultClient'
import { beyondCapText, capStripText, type GridController } from '../src/renderer/src/results/ResultsService'
import { resolveMenu } from '../src/renderer/src/menus/resolve'
import { descriptor, summaryOf, type FakeHandle } from './fixtures/results'
import { keyAt } from './fixtures/entries'
import { workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
/** The view a handle's next `sort` builds, answered when the test says: with the filters asked for, or a failure. */
function nextView(handle: FakeHandle) {
  let answer!: () => void, fail!: (error: Error) => void
  vi.mocked(handle.sort).mockImplementationOnce((keys, o) => new Promise<ResultView>((resolve, reject) => {
    answer = () => resolve({ ...handle, viewId: 1, base: handle, keys, filters: (o?.filters ?? []).map(filter => filter.op === 'keepRows' ? { op: 'keepRows', rows: [2, 3, 4] } : filter), rows: 3, baseRows: 20, complete: true, approximate: false, close: vi.fn(async () => {}) } as unknown as ResultView)
    fail = reject
  }))
  return { answer: async () => { answer(); await settle() }, fail: async (text: string) => { fail(new Error(text)); await settle() } }
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const columns: ResultColumn[] = [
  { name: 'Id', dataType: 'int', wire: 'text', nullable: false }, { name: 'Country', dataType: 'nvarchar(60)', wire: 'text', nullable: true }, { name: '', dataType: 'xml', wire: 'text', role: 'xml', nullable: true }
]
const tone: ResultColumn = { name: 'tone', dataType: 'tinyint', wire: 'text', role: 'tone', nullable: false }

/** A query tab whose run returned two results of three columns and 20 rows, a pivot of the first and a comparison. */
async function ran(o: { running?: boolean } = {}) {
  const f = workbenchFixture()
  cleanups.push(f.dispose)
  const tab = f.documents.create('SQLQuery1.sql', 'SELECT 1', 'master')
  const rows = { rowsRead: 20, rowsStored: 20, rowsAvailable: 20, columns }
  const sets = [descriptor(1, rows), descriptor(2, { index: 1, ...rows })]
  f.results.begin(tab.id, 'q1')
  for (const set of sets) f.resultClient.emit('q1', { type: 'resultSet.opened', descriptor: { ...set, state: 'open' } })
  if (!o.running) {
    await f.results.finish(tab.id, 'q1', { summary: summaryOf(sets) })
    f.results.addSet(tab.id, descriptor(803, { index: 0, kind: 'pivot', ...rows }), 'Pivot of Result 1', ['1:1'])
    f.results.addSet(tab.id, descriptor(901, { index: 1, kind: 'diff', ...rows, columns: [...columns, tone] }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])
  }
  const key = (place = 0) => keyAt(f.results, tab.id, place)
  /** A menu opened on the grid at `place`: on a cell (row and column), a name or header (one of them), or the grid. */
  const on = (place = 0, at: { row?: number; column?: number; transposed?: boolean } = {}): CommandArgs => {
    const entry = f.results.getSnapshot()[tab.id].sets[place]
    const target: OutputTarget = {
      kind: 'output', tabId: tab.id, view: 'grid', entry: entry.key, selectedText: '', element: document.createElement('div'), resultKind: entry.descriptor.kind,
      result: { generation: entry.descriptor.generation, resultId: entry.descriptor.resultId }, ...at
    }
    return argsFor(target)
  }
  const cells = (place: number, top: number, bottom: number, column = 0): GridSelection => ({
    entry: key(place), blocks: [{ kind: 'cells', anchor: { row: top, column }, focus: { row: bottom, column } }], active: { row: bottom, column }
  })
  const orientation = (place = 0) => f.results.orientation(tab.id, key(place))
  const handle = (place = 0) => f.results.getSnapshot()[tab.id].sets[place].handle as FakeHandle
  return { ...f, tab, key, on, cells, orientation, handle }
}

describe('Transpose Results', () => {
  it('turns the grid that last had the focus and turns it back, storing nothing and asking the backend nothing', async () => {
    const { commands, results, tab, key, orientation, handle } = await ran()
    const added = vi.spyOn(results, 'addSet')
    const before = results.getSnapshot()[tab.id].sets.length
    expect(orientation()).toEqual({ transposed: false })
    expect(await commands.execute('output.transpose', { tabId: tab.id }, 'toolbar')).toBe(true)
    expect(orientation()).toEqual({ transposed: true })
    // It is the view's grid state, with its selection, scroll and widths: a tab switch or an unmounted grid keeps it.
    expect(results.viewState(tab.id).grids.get(key())).toMatchObject({ orientation: 'transposed' })
    expect([orientation(1), orientation(2)]).toEqual([{ transposed: false }, { transposed: false }])
    expect(await commands.execute('output.transpose', undefined, 'palette')).toBe(true)
    expect(orientation()).toEqual({ transposed: false })
    expect(results.viewState(tab.id).grids.get(key())).not.toHaveProperty('orientation')
    // No request of the result's handle makes a transposed result: there is none to make (results.transpose is gone).
    expect(handle()).not.toHaveProperty('transpose')
    expect(added).not.toHaveBeenCalled()
    expect(results.getSnapshot()[tab.id].sets).toHaveLength(before)
  })

  it('acts on the menu\'s grid, a table or a pivot, and never on a comparison or a result its menu no longer shows', async () => {
    const { commands, results, tab, key, on, orientation } = await ran()
    const ids = ['output.transpose', 'output.transposeWithHeaders', 'output.transposeChooseHeaders'] as const
    const enabled = (args: CommandArgs) => ids.filter(id => commands.isEnabled(id, args))
    expect(enabled(on(1, { column: 1 }))).toEqual(ids)
    expect(enabled(on(2, { column: 1 }))).toEqual(ids)
    // A comparison marks rows through its tone column: it is never turned, by a menu or by the service.
    expect(enabled(on(3, { column: 1 }))).toEqual([])
    expect(results.canTranspose(tab.id, key(3))).toBe(false)
    expect(results.setOrientation(tab.id, key(3), { transposed: true })).toBe(false)
    expect(orientation(3)).toEqual({ transposed: false })
    await commands.execute('output.transpose', on(2), 'menu')
    expect([orientation(0), orientation(1), orientation(2)]).toEqual([{ transposed: false }, { transposed: false }, { transposed: true }])
    // A menu left open on Result 2 does nothing once that result is closed, and nothing to the entry now in its place.
    const stale = on(1)
    expect(results.removeEntry(tab.id, key(1))).toBe(true)
    expect(enabled(stale)).toEqual([])
    await commands.execute('output.transpose', stale, 'menu')
    expect(orientation(1)).toEqual({ transposed: true })
    // Messages and closed results have nothing to turn.
    expect(commands.isEnabled('output.transpose', { tabId: tab.id, target: { kind: 'output', tabId: tab.id, view: 'messages', selectedText: '', element: document.createElement('div') } })).toBe(false)
    results.closeResults(tab.id)
    expect(commands.isEnabled('output.transpose', { tabId: tab.id })).toBe(false)
  })

  it('turns a grid whose rows are still arriving', async () => {
    const { commands, tab, orientation } = await ran({ running: true })
    expect(commands.isEnabled('output.transpose', { tabId: tab.id })).toBe(true)
    await commands.execute('output.transpose', { tabId: tab.id }, 'toolbar')
    expect(orientation()).toEqual({ transposed: true })
  })

  it('keeps the selection, the sort and the filters as they were', async () => {
    const { commands, results, resultSelection, tab, key, cells } = await ran()
    resultSelection.set(tab.id, cells(0, 3, 5, 1))
    const sort = results.sortOf(tab.id, key())
    await commands.execute('output.transpose', { tabId: tab.id }, 'toolbar')
    expect(results.selection(tab.id, key())).toEqual(cells(0, 3, 5, 1))
    expect(results.sortOf(tab.id, key())).toBe(sort)
  })

  it('publishes once for a change and not at all for none', async () => {
    const { results, tab, key } = await ran()
    const heard = vi.fn()
    cleanups.push(results.subscribe(heard))
    expect(results.setOrientation(tab.id, key(), { transposed: true })).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(results.setOrientation(tab.id, key(), { transposed: true })).toBe(false)
    expect(results.setOrientation(tab.id, 'no-such-entry', { transposed: true })).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('the resultsGridTransposed key', () => {
  it('follows the focused grid of the active query, so Transpose Results reads as a toggle', async () => {
    const { commands, context, documents, results, tab, key } = await ran()
    const state = () => [context.getState().resultsGridTransposed, commands.isToggled('output.transpose')]
    expect(state()).toEqual([false, false])
    await commands.execute('output.transpose', { tabId: tab.id }, 'toolbar')
    expect(state()).toEqual([true, true])
    expect(results.turned.getSnapshot()).toEqual({ [tab.id]: { entry: key() } })
    // Another grid takes the focus: the key is that grid's.
    results.focusEntry(tab.id, key(1))
    expect(state()).toEqual([false, false])
    results.focusEntry(tab.id, key(0))
    expect(state()).toEqual([true, true])
    // Another query is active: its grids are not this one's.
    const other = documents.create('SQLQuery2.sql', 'SELECT 2', 'master')
    expect(state()).toEqual([false, false])
    documents.activate(tab.id)
    expect(state()).toEqual([true, true])
    void other
    // Closing the transposed result leaves nothing transposed.
    results.removeEntry(tab.id, key(0))
    expect(state()).toEqual([false, false])
    expect(results.turned.getSnapshot()).toEqual({})
  })

  it('is off for results lost with the backend, which can no longer be turned back', async () => {
    const { commands, context, resultClient, results, tab, key } = await ran()
    results.setOrientation(tab.id, key(), { transposed: true, headerColumn: 1 })
    expect(context.getState().resultsGridTransposed).toBe(true)
    resultClient.lose()
    await settle()
    // The grid stays as it was drawn, under its overlay; nothing reads as pressed, and no command acts on it.
    expect(commands.isEnabled('output.transpose', { tabId: tab.id })).toBe(false)
    expect(results.turned.getSnapshot()).toEqual({})
    expect([context.getState().resultsGridTransposed, commands.isToggled('output.transpose')]).toEqual([false, false])
  })

  it('is the menu\'s own grid in that grid\'s menu, whichever grid has the focus', async () => {
    const { commands, keybindings, results, tab, key, on } = await ran()
    results.setOrientation(tab.id, key(1), { transposed: true })
    // The focused grid (Result 1) is a table; the menu is Result 2's, which is transposed.
    expect(commands.isToggled('output.transpose')).toBe(false)
    expect(commands.isToggled('output.transpose', on(1, { transposed: true }))).toBe(true)
    expect(commands.isToggled('output.transpose', on(0))).toBe(false)
    const items = (args: CommandArgs) => resolveMenu('output.transposeMenu', { platform: 'win32', commands, keybindings, args, state: {}, target: { outputView: 'grid', outputGridTransposable: true } })
      .flatMap(item => item.kind === 'command' ? [[item.title, item.checked, item.enabled]] : [])
    expect(items(on(1, { transposed: true, column: 1 }))).toEqual([['Transposed', true, true], ['Selected Rows', undefined, false], ['Using Column as Headers', undefined, true], ['Choose Headers…', undefined, true]])
    expect(items(on(0, { column: 1 }))[0]).toEqual(['Transposed', false, true])
  })
})

describe('Transpose Selected Rows', () => {
  it('keeps the selected rows as a filter and turns the grid once the filtered rows show', async () => {
    const { commands, results, resultSelection, tab, key, on, cells, orientation, handle } = await ran()
    const view = nextView(handle())
    expect(commands.isEnabled('output.transposeSelectedRows', on())).toBe(false)
    resultSelection.set(tab.id, cells(0, 2, 4))
    expect(commands.isEnabled('output.transposeSelectedRows', on())).toBe(true)
    // Each grid has its own selection.
    expect(commands.isEnabled('output.transposeSelectedRows', on(1))).toBe(false)
    const keep = vi.spyOn(results, 'keepSelectedRows')
    expect(await commands.execute('output.transposeSelectedRows', on(), 'menu')).toBe(true)
    // The filter is Keep Selected Rows' own (its checks are tests/results-service.test.ts's). While the backend builds its
    // view the grid stays a table: turned now, it would draw every row of the result as a column first.
    expect(keep.mock.calls.map(call => call.slice(0, 2))).toEqual([[tab.id, key()]])
    expect(keep.mock.results[0].value).toBe(true)
    expect(results.sortOf(tab.id, key())).toMatchObject({ sorting: true })
    expect(orientation()).toEqual({ transposed: false })
    await view.answer()
    expect(results.sortOf(tab.id, key())?.applied.map(item => item.filter.op)).toEqual(['keepRows'])
    expect(orientation()).toEqual({ transposed: true })
    // It turned once: turning it back is the user's, and a later publish does not turn it again.
    results.setOrientation(tab.id, key(), { transposed: false })
    results.notify(tab.id, 'something else')
    expect(orientation()).toEqual({ transposed: false })
  })

  it('turns the grid only for its own view: not when it fails over an older filter, nor when another filter replaced it', async () => {
    const { commands, results, resultSelection, tab, key, on, cells, orientation, handle } = await ran()
    // A Keep Selected Rows filter is already applied, and the grid is a table.
    const first = nextView(handle())
    resultSelection.set(tab.id, cells(0, 2, 4))
    await commands.execute('output.keepSelectedRows', on(), 'menu')
    await first.answer()
    expect(results.sortOf(tab.id, key())?.applied.map(item => item.filter.op)).toEqual(['keepRows'])
    // Transpose Selected Rows of other rows fails: the old filter stays applied, and the grid stays a table.
    const failing = nextView(handle())
    resultSelection.set(tab.id, cells(0, 0, 1))
    await commands.execute('output.transposeSelectedRows', on(), 'menu')
    await failing.fail('The view could not be built.')
    expect(results.sortOf(tab.id, key())?.applied.map(item => item.filter.op)).toEqual(['keepRows'])
    expect(orientation()).toEqual({ transposed: false })
    // Transpose Selected Rows, then a plain Keep Selected Rows before its view answers: the second is not the command's.
    const replaced = nextView(handle()), plain = nextView(handle())
    await commands.execute('output.transposeSelectedRows', on(), 'menu')
    await commands.execute('output.keepSelectedRows', on(), 'menu')
    await replaced.answer()
    await plain.answer()
    expect(results.sortOf(tab.id, key())).toMatchObject({ sorting: false })
    expect(orientation()).toEqual({ transposed: false })
  })

  it('leaves a grid already transposed as the user turns it while the kept rows are built', async () => {
    const { commands, results, resultSelection, tab, key, on, cells, orientation, handle } = await ran()
    results.setOrientation(tab.id, key(), { transposed: true })
    const view = nextView(handle())
    resultSelection.set(tab.id, cells(0, 2, 4))
    await commands.execute('output.transposeSelectedRows', on(0, { transposed: true }), 'menu')
    expect(orientation()).toEqual({ transposed: true })
    await commands.execute('output.transpose', on(0, { transposed: true }), 'menu')
    await view.answer()
    expect(orientation()).toEqual({ transposed: false })
  })

  it('leaves the grid a table when the filter fails, or its result is closed before it shows', async () => {
    const { commands, results, resultSelection, tab, key, on, cells, orientation, handle } = await ran()
    const failing = nextView(handle())
    resultSelection.set(tab.id, cells(0, 2, 4))
    await commands.execute('output.transposeSelectedRows', on(), 'menu')
    await failing.fail('The view could not be built.')
    expect(results.getSnapshot()[tab.id].jobNotice).toContain('Could not filter the results')
    expect(orientation()).toEqual({ transposed: false })
    // Result 2: closed while its view is built.
    const closing = nextView(handle(1)), closed = key(1)
    resultSelection.set(tab.id, cells(1, 0, 1))
    await commands.execute('output.transposeSelectedRows', on(1), 'menu')
    results.removeEntry(tab.id, closed)
    await closing.answer()
    expect(results.orientation(tab.id, closed)).toEqual({ transposed: false })
    expect(results.turned.getSnapshot()).toEqual({})
  })

  it('leaves the grid as it is drawn when Keep Selected Rows refuses the selection', async () => {
    const { commands, results, resultSelection, tab, key, on, orientation, handle } = await ran()
    const many = wire.transpose.maxRows + 1
    handle().snapshot = { ...handle().snapshot, rowsRead: many, rowsStored: many, rowsAvailable: many }
    resultSelection.set(tab.id, selectAll(key()))
    await commands.execute('output.transposeSelectedRows', on(), 'menu')
    expect(orientation()).toEqual({ transposed: false })
    expect(results.getSnapshot()[tab.id].jobNotice).toContain('Keep Selected Rows takes at most 4,095 rows')
  })
})

describe('Using Column as Headers', () => {
  it('takes the menu\'s column, else the active cell\'s, and turns the grid', async () => {
    const { commands, results, resultSelection, tab, key, on, cells, orientation } = await ran()
    // From the palette or the toolbar there is no menu column: the active cell's, and none without one.
    expect(commands.isEnabled('output.transposeWithHeaders', { tabId: tab.id })).toBe(false)
    resultSelection.set(tab.id, cells(0, 0, 0, 1))
    await commands.execute('output.transposeWithHeaders', { tabId: tab.id }, 'palette')
    expect(orientation()).toEqual({ transposed: true, headerColumn: 1 })
    // A menu on a column's name in the transposed grid names that column of the result, whatever cell is active.
    await commands.execute('output.transposeWithHeaders', on(0, { column: 2, transposed: true }), 'menu')
    expect(orientation()).toEqual({ transposed: true, headerColumn: 2 })
    expect(results.turned.getSnapshot()[tab.id]).toEqual({ entry: key(), headerColumn: 2 })
    // A column the result does not have heads nothing and changes nothing.
    expect(commands.isEnabled('output.transposeWithHeaders', on(0, { column: 9 }))).toBe(false)
    expect(results.setOrientation(tab.id, key(), { transposed: true, headerColumn: 9 })).toBe(false)
    expect(results.setOrientation(tab.id, key(), { transposed: true, headerColumn: 1.5 })).toBe(false)
    expect(orientation()).toEqual({ transposed: true, headerColumn: 2 })
  })

  it('is kept while the grid is a table, and comes back with Transposed', async () => {
    const { commands, results, tab, key, on, orientation } = await ran()
    await commands.execute('output.transposeWithHeaders', on(0, { column: 1 }), 'menu')
    await commands.execute('output.transpose', on(0, { transposed: true }), 'menu')
    expect(orientation()).toEqual({ transposed: false })
    await commands.execute('output.transpose', on(0), 'menu')
    expect(orientation()).toEqual({ transposed: true, headerColumn: 1 })
    // null goes back to "Row N".
    expect(results.setOrientation(tab.id, key(), { transposed: true, headerColumn: null })).toBe(true)
    expect(orientation()).toEqual({ transposed: true })
  })

  it('Choose Headers lists Row number and each column, starts on the current one, and sets the one picked', async () => {
    const { commands, quickInput, results, tab, key, orientation } = await ran()
    results.setOrientation(tab.id, key(), { transposed: true, headerColumn: 1 })
    const anchor = document.createElement('button')
    expect(await commands.execute('output.transposeChooseHeaders', { tabId: tab.id, anchor }, 'toolbar')).toBe(true)
    const view = quickInput.getSnapshot()
    expect([view.visible, view.ariaLabel, view.anchor]).toEqual([true, 'Using Column as Headers', anchor])
    expect(view.rows.map(row => [row.item.label, row.item.description])).toEqual([['Row number', 'Row 1, Row 2, …'], ['Id', 'int'], ['Country', 'nvarchar(60)'], ['(No column name)', 'xml']])
    expect(view.rows[view.activeIndex].item.label).toBe('Country')
    quickInput.accept(3)
    expect(orientation()).toEqual({ transposed: true, headerColumn: 2 })
    // Row number, from a table: the grid turns, headed "Row N".
    results.setOrientation(tab.id, key(), { transposed: false })
    await commands.execute('output.transposeChooseHeaders', { tabId: tab.id }, 'palette')
    expect(quickInput.getSnapshot().rows[quickInput.getSnapshot().activeIndex].item.label).toBe('Row number')
    quickInput.accept(0)
    expect(orientation()).toEqual({ transposed: true })
    // A result closed while the list is open is not turned by the pick.
    await commands.execute('output.transposeChooseHeaders', { tabId: tab.id }, 'palette')
    const closed = key()
    results.removeEntry(tab.id, closed)
    quickInput.accept(1)
    expect(results.orientation(tab.id, closed)).toEqual({ transposed: false })
    expect(orientation()).toEqual({ transposed: false })
  })
})

describe('a transposed grid\'s menu targets', () => {
  it('Fit Column fits the drawn column of the target\'s row, or the name column on a name; a table fits its column', async () => {
    const { commands, results, tab, key, on } = await ran()
    const fitColumn = vi.fn(), fitDrawn = vi.fn()
    const controller: GridController = { selectAll: () => {}, repaint: () => {}, fitColumn, fitDrawn }
    cleanups.push(results.registerGrid(tab.id, key(), controller).dispose)
    await commands.execute('output.fitColumn', on(0, { row: 7, column: 1 }), 'menu')
    expect([fitColumn.mock.calls, fitDrawn.mock.calls]).toEqual([[[1]], []])
    results.setOrientation(tab.id, key(), { transposed: true })
    // A cell of the transposed grid: the drawn column is the result's row 7. A drawn header carries only its row.
    await commands.execute('output.fitColumn', on(0, { row: 7, column: 1, transposed: true }), 'menu')
    await commands.execute('output.fitColumn', on(0, { row: 3, transposed: true }), 'menu')
    // A name cell carries only its column: the name column is fitted to its names.
    await commands.execute('output.fitColumn', on(0, { column: 2, transposed: true }), 'menu')
    expect([fitColumn.mock.calls, fitDrawn.mock.calls]).toEqual([[[1]], [[7], [3], [undefined]]])
    // A row the transposed grid does not draw has no column to fit.
    expect(commands.isEnabled('output.fitColumn', on(0, { row: wire.transpose.maxRows, column: 0, transposed: true }))).toBe(false)
    expect(commands.isEnabled('output.fitColumn', on(0, { row: wire.transpose.maxRows - 1, column: 0, transposed: true }))).toBe(true)
    // A grid that is not mounted fits nothing.
    results.setOrientation(tab.id, key(1), { transposed: true })
    expect(commands.isEnabled('output.fitColumn', on(1, { row: 0, column: 0, transposed: true }))).toBe(false)
  })

  it('sort, filter, Copy Column Name and Open Value act on the result\'s column and row the target carries', async () => {
    const { commands, api, results, tab, key, on } = await ran()
    const filterColumn = vi.fn()
    cleanups.push(results.registerGrid(tab.id, key(), { selectAll: () => {}, repaint: () => {}, fitColumn: () => {}, fitDrawn: () => {}, filterColumn }).dispose)
    results.setOrientation(tab.id, key(), { transposed: true })
    // The cell drawn at the third row and the eighth column of a transposed grid is the result's row 7, column 2: its
    // target says so (GridView's targetOf), and the commands read only the target.
    const cell = on(0, { row: 7, column: 2, transposed: true }), name = on(0, { column: 1, transposed: true })
    const sortBy = vi.spyOn(results, 'sortBy'), openValue = vi.spyOn(results, 'openValue').mockResolvedValue({ opened: false })
    await commands.execute('output.sortDescending', name, 'menu')
    await commands.execute('output.thenSortAscending', cell, 'menu')
    expect(sortBy.mock.calls).toEqual([[tab.id, key(), 1, 'descending', false], [tab.id, key(), 2, 'ascending', true]])
    await commands.execute('output.filterColumnValues', name, 'menu')
    expect(filterColumn.mock.calls).toEqual([[1]])
    await commands.execute('output.copyColumnName', name, 'menu')
    expect(api.writeClipboardText.mock.calls).toEqual([['Country']])
    // Open Value takes the cell a click or Enter names: the grid reports it in the result's rows and columns.
    await commands.execute('output.openValue', { tabId: tab.id, cell: { entry: key(), row: 7, column: 2 } }, 'keybinding')
    expect(openValue.mock.calls).toEqual([[tab.id, key(), 7, 2, undefined]])
  })
})

describe('a Peek card\'s grid', () => {
  it('turns by its menu, with its own toggle state, though it belongs to no query tab', async () => {
    const { commands, context, results, resultSelection } = await ran()
    // Peek's top rows are a run under the card's own key, not a document's.
    const peek = 'peek:rows:1', set = descriptor(50, { index: 0, generation: 1, rowsRead: 10, rowsStored: 10, rowsAvailable: 10, columns })
    results.begin(peek, 'pq')
    await results.finish(peek, 'pq', { summary: summaryOf([set]) })
    const entry = results.getSnapshot()[peek].sets[0]
    const on = (at: { row?: number; column?: number; transposed?: boolean } = {}) => argsFor({ kind: 'output', tabId: peek, view: 'grid', entry: entry.key, selectedText: '', element: document.createElement('div'), resultKind: 'rows', ...at })
    expect(commands.isEnabled('output.transpose', on())).toBe(true)
    await commands.execute('output.transpose', on(), 'menu')
    expect(results.orientation(peek, entry.key)).toEqual({ transposed: true })
    // The active query's key is not the card's; the card's menu reads its own grid.
    expect(context.getState().resultsGridTransposed).toBe(false)
    expect(commands.isToggled('output.transpose', on({ transposed: true }))).toBe(true)
    await commands.execute('output.transposeWithHeaders', on({ column: 1, transposed: true }), 'menu')
    expect(results.orientation(peek, entry.key)).toEqual({ transposed: true, headerColumn: 1 })
    resultSelection.set(peek, { entry: entry.key, blocks: [{ kind: 'cells', anchor: { row: 1, column: 0 }, focus: { row: 2, column: 0 } }], active: { row: 2, column: 0 } })
    await commands.execute('output.transpose', on({ transposed: true }), 'menu')
    expect(results.orientation(peek, entry.key)).toEqual({ transposed: false })
    const view = nextView(entry.handle as FakeHandle)
    await commands.execute('output.transposeSelectedRows', on(), 'menu')
    await view.answer()
    expect(results.orientation(peek, entry.key)).toEqual({ transposed: true, headerColumn: 1 })
  })
})

describe('the cap\'s sentences', () => {
  it('say how many rows are drawn as columns and what to filter', () => {
    expect(capStripText(20_463, false)).toBe('Showing the first 4,095 of 20,463 rows as columns. Filter the Table to see other rows.')
    expect(capStripText(5000, true)).toBe('Showing the first 4,095 of 5,000 rows as columns. Filter the Pivot to see other rows.')
  })

  it('Find Next onto a match past the cap says so in the toolbar', async () => {
    const { results, tab } = await ran()
    results.beyondCap(tab.id, 4999)
    expect(beyondCapText(4999)).toBe('The match is in row 5,000, and a transposed grid draws only the first 4,095 rows. Filter the rows, or turn Transposed off, to see it.')
    expect(results.getSnapshot()[tab.id].jobNotice).toBe(beyondCapText(4999))
  })
})
