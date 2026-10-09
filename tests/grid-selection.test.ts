import { describe, expect, it } from 'vitest'
import type { Platform } from '../src/shared/commands/keybindings'
import type { DisplayResultSet } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { cellText, columnTitle, describeRange, dragSelection, inRange, isEmptyRange, maxCopyLength, pressButton, pressSelection, rangeOf, selectAll, toTsv, type GridHit, type GridSelection } from '../src/renderer/src/grid/selection'
import { ResultSelectionService } from '../src/renderer/src/services/result-selection'

const cells = (anchor: [number, number], focus: [number, number], resultIndex = 0): GridSelection =>
  ({ resultIndex, anchor: { row: anchor[0], column: anchor[1] }, focus: { row: focus[0], column: focus[1] }, mode: 'cells' })
/** Three rows by three columns, the second column unnamed, with a NULL and values that need cleaning. */
const set: Pick<DisplayResultSet, 'columns' | 'rows'> = {
  columns: [{ name: 'Id', dataType: 'int' }, { name: '', dataType: 'nvarchar' }, { name: 'Note', dataType: 'nvarchar' }],
  rows: [['1', 'a', null], ['2', 'b\tx', 'line\r\nbreak'], ['3', 'c', '1']]
}

describe('grid selection', () => {
  it('spans a rectangle from its anchor in either direction, clamped to the result', () => {
    expect(rangeOf(cells([0, 0], [1, 2]), 3, 3)).toEqual({ top: 0, left: 0, bottom: 1, right: 2 })
    expect(rangeOf(cells([2, 2], [0, 1]), 3, 3)).toEqual({ top: 0, left: 1, bottom: 2, right: 2 })
    expect(rangeOf(cells([5, -1], [7, 9]), 3, 3)).toEqual({ top: 2, left: 0, bottom: 2, right: 2 })
    expect(rangeOf({ ...cells([2, 1], [0, 2]), mode: 'rows' }, 3, 3)).toEqual({ top: 0, left: 0, bottom: 2, right: 2 })
    expect(rangeOf({ ...cells([2, 1], [2, 1]), mode: 'rows' }, 3, 3)).toEqual({ top: 2, left: 0, bottom: 2, right: 2 })
    expect(rangeOf({ ...cells([2, 2], [0, 1]), mode: 'columns' }, 3, 3)).toEqual({ top: 0, left: 1, bottom: 2, right: 2 })
    expect(rangeOf(selectAll(0), 4, 2)).toEqual({ top: 0, left: 0, bottom: 3, right: 1 })
    // A result without rows selects nothing, even all of it.
    expect(isEmptyRange(rangeOf(selectAll(0), 0, 2))).toBe(true)
    expect(isEmptyRange(rangeOf(cells([0, 0], [0, 0]), 0, 0))).toBe(true)
    expect(inRange({ top: 0, left: 1, bottom: 2, right: 2 }, { row: 1, column: 1 })).toBe(true)
    expect(inRange({ top: 0, left: 1, bottom: 2, right: 2 }, { row: 1, column: 0 })).toBe(false)
  })
  it('copies cells as one field each: NULL, and line breaks and tabs as spaces', () => {
    expect([null, undefined, 0, false, 'a\tb', 'a\r\nb', 'a\rb\nc', '', 1.5].map(cellText)).toEqual(['NULL', 'NULL', '0', 'false', 'a b', 'a b', 'a b c', '', '1.5'])
    expect(columnTitle('')).toBe('(No column name)')
    expect(columnTitle('Order\tId')).toBe('Order Id')
  })
  it('writes tab-separated text with optional headers and the platform\'s line breaks, without a final one', () => {
    expect(toTsv(set, cells([0, 0], [0, 0]), { headers: false, eol: '\n' })).toBe('1')
    expect(toTsv(set, cells([2, 2], [0, 1]), { headers: false, eol: '\n' })).toBe('a\tNULL\nb x\tline break\nc\t1')
    expect(toTsv(set, cells([0, 0], [1, 1]), { headers: true, eol: '\r\n' })).toBe('Id\t(No column name)\r\n1\ta\r\n2\tb x')
    expect(toTsv(set, selectAll(0), { headers: true, eol: '\n' })).toBe('Id\t(No column name)\tNote\n1\ta\tNULL\n2\tb x\tline break\n3\tc\t1')
    expect(toTsv(set, { ...cells([1, 2], [1, 2]), mode: 'columns' }, { headers: false, eol: '\n' })).toBe('NULL\nline break\n1')
    expect(toTsv({ columns: set.columns, rows: [] }, selectAll(0), { headers: true, eol: '\n' })).toBe('Id\t(No column name)\tNote')
    expect(toTsv({ columns: [], rows: [] }, selectAll(0), { headers: true, eol: '\n' })).toBe('')
  })
  it('refuses to build text longer than the copy limit', () => {
    const big = 'x'.repeat(3_000_000), wide = { columns: [{ name: 'a', dataType: 'nvarchar' }], rows: [[big], [big], [big]] }
    expect(() => toTsv(wide, selectAll(0), { headers: false, eol: '\n' })).toThrow(new RangeError('The selection is too large to copy.'))
    // Two rows fit: 6,000,001 characters.
    expect(toTsv(wide, cells([0, 0], [1, 0]), { headers: false, eol: '\n' })).toHaveLength(6_000_001)
    const edge = { columns: [{ name: 'a', dataType: 'nvarchar' }], rows: [['y'.repeat(maxCopyLength)]] }
    expect(toTsv(edge, selectAll(0), { headers: false, eol: '\n' })).toHaveLength(maxCopyLength)
    expect(() => toTsv(edge, selectAll(0), { headers: true, eol: '\n' })).toThrow(RangeError)
  })
  it('selects what a press lands on, extends with Shift, and drags the far corner', () => {
    const press = (current: GridSelection | undefined, hit: GridHit, options: { shift?: boolean; right?: boolean; resultIndex?: number } = {}) =>
      pressSelection(current, hit, { resultIndex: options.resultIndex ?? 0, shift: !!options.shift, right: !!options.right, rows: 3, columns: 3 })
    const one = press(undefined, { kind: 'cell', row: 1, column: 2 })
    expect(one).toEqual(cells([1, 2], [1, 2]))
    expect(press(one, { kind: 'cell', row: 0, column: 0 }, { shift: true })).toEqual(cells([1, 2], [0, 0]))
    expect(press(one, { kind: 'row', row: 2 })).toEqual({ resultIndex: 0, anchor: { row: 2, column: 0 }, focus: { row: 2, column: 0 }, mode: 'rows' })
    expect(rangeOf(press(one, { kind: 'row', row: 0 }, { shift: true }), 3, 3)).toEqual({ top: 0, left: 0, bottom: 1, right: 2 })
    expect(press(one, { kind: 'column', column: 1 })).toMatchObject({ mode: 'columns', anchor: { row: 0, column: 1 } })
    expect(rangeOf(press(one, { kind: 'column', column: 0 }, { shift: true }), 3, 3)).toEqual({ top: 0, left: 0, bottom: 2, right: 2 })
    expect(press(one, { kind: 'corner' })).toEqual(selectAll(0))
    // Shift with nothing selected in this result set, or a selection from another one, selects plainly.
    expect(press(cells([0, 0], [0, 0], 1), { kind: 'cell', row: 2, column: 2 }, { shift: true })).toEqual(cells([2, 2], [2, 2]))
    const grown = dragSelection(dragSelection(one, { kind: 'cell', row: 2, column: 0 }), { kind: 'row', row: 0 })
    expect(rangeOf(grown, 3, 3)).toEqual({ top: 0, left: 0, bottom: 1, right: 2 })
    const rows = press(undefined, { kind: 'row', row: 1 })
    expect(rangeOf(dragSelection(rows, { kind: 'cell', row: 2, column: 2 }), 3, 3)).toEqual({ top: 1, left: 0, bottom: 2, right: 2 })
    expect(dragSelection(selectAll(0), { kind: 'cell', row: 1, column: 1 })).toEqual(selectAll(0))
    expect(dragSelection(one, { kind: 'cell', row: 1, column: 2 })).toBe(one)
  })
  it('keeps the selection for a right press inside it and selects the cell for one outside, as SSMS does', () => {
    const right = (current: GridSelection, hit: GridHit) => pressSelection(current, hit, { resultIndex: 0, shift: false, right: true, rows: 3, columns: 3 })
    const block = cells([0, 0], [1, 1])
    expect(right(block, { kind: 'cell', row: 1, column: 0 })).toBe(block)
    expect(right(block, { kind: 'cell', row: 2, column: 2 })).toEqual(cells([2, 2], [2, 2]))
    // Shift does not extend on a right press.
    expect(pressSelection(block, { kind: 'cell', row: 2, column: 2 }, { resultIndex: 0, shift: true, right: true, rows: 3, columns: 3 })).toEqual(cells([2, 2], [2, 2]))
    // A row number or header keeps the selection only when its whole row or column is selected.
    expect(right(block, { kind: 'row', row: 0 })).toMatchObject({ mode: 'rows' })
    const fullRows = cells([0, 0], [1, 2])
    expect(right(fullRows, { kind: 'row', row: 1 })).toBe(fullRows)
    expect(right(selectAll(0), { kind: 'column', column: 2 })).toEqual(selectAll(0))
    expect(right(selectAll(0), { kind: 'corner' })).toEqual(selectAll(0))
    expect(right(block, { kind: 'corner' })).toEqual(selectAll(0))
  })
  it('treats Control+click as a right press on macOS, where it opens the context menu, so Copy keeps the selection', () => {
    const press = (button: number, ctrlKey: boolean, platform: Platform) => pressButton({ button, ctrlKey }, platform)
    // Chromium on macOS reports Control+click as a left press with Control, then opens the menu.
    expect([press(0, true, 'darwin'), press(2, false, 'darwin'), press(0, false, 'darwin'), press(1, false, 'darwin')]).toEqual(['secondary', 'secondary', 'primary', undefined])
    // Elsewhere Control+click is a left press.
    for (const platform of ['win32', 'linux'] as const) expect([press(0, true, platform), press(2, true, platform)]).toEqual(['primary', 'secondary'])
    const block = cells([0, 0], [1, 1])
    expect(pressSelection(block, { kind: 'cell', row: 1, column: 1 }, { resultIndex: 0, shift: false, right: press(0, true, 'darwin') === 'secondary', rows: 3, columns: 3 })).toBe(block)
  })
  it('describes the selection for screen readers', () => {
    expect(describeRange({ top: 0, left: 0, bottom: 0, right: 0 })).toBe('1 row, 1 column selected')
    expect(describeRange({ top: 1, left: 0, bottom: 3, right: 2 })).toBe('3 rows, 3 columns selected')
    expect(describeRange({ top: 0, left: 0, bottom: -1, right: 2 })).toBe('No cells selected')
  })
})

describe('result selection service', () => {
  it('keeps one selection per query, only for the result set it was made in', () => {
    const events = new EventBus(), service = new ResultSelectionService(events)
    const listener = { calls: 0 }
    service.subscribe(() => { listener.calls++ })
    const selection = cells([0, 0], [1, 1], 1)
    service.set('t1', selection)
    service.set('t1', selection)
    expect(listener.calls).toBe(1)
    expect(service.get('t1')).toBe(selection)
    expect(service.get('t1', 1)).toBe(selection)
    expect(service.get('t1', 0)).toBeUndefined()
    expect(service.get('t2')).toBeUndefined()
    expect(service.get('__proto__')).toBeUndefined()
    service.selectAll('t2', 0)
    expect(service.get('t2', 0)).toEqual(selectAll(0))
    service.dispose()
    expect(service.getSnapshot()).toEqual({})
  })
  it('forgets a query\'s selection when it runs, finishes, or closes', () => {
    const events = new EventBus(), service = new ResultSelectionService(events)
    for (const event of [{ type: 'query.started', tabId: 't1', queryId: 'q' }, { type: 'query.finished', tabId: 't1', queryId: 'q' }, { type: 'documents.closed', tabId: 't1' }] as const) {
      service.set('t1', cells([0, 0], [0, 0]))
      service.set('t2', cells([1, 1], [1, 1]))
      events.emit(event)
      expect(service.get('t1'), event.type).toBeUndefined()
      expect(service.get('t2'), event.type).toBeDefined()
    }
    events.emit({ type: 'documents.activated', tabId: 't2' })
    expect(service.get('t2')).toBeDefined()
    service.clear('missing')
    service.dispose()
    service.set('t3', selectAll(0))
    events.emit({ type: 'documents.closed', tabId: 't3' })
    expect(service.get('t3')).toBeDefined()
  })
})
