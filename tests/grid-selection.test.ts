import { describe, expect, it } from 'vitest'
import { platforms, type Platform } from '../src/shared/commands/keybindings'
import type { DisplayResultSet } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { openEnd } from '../src/renderer/src/grid/constants'
import { gridKeyAction } from '../src/renderer/src/grid/keyboard'
import {
  blockRange, cellText, columnTitle, contains, copyPlan, covered, describeRange, describeSelection, dragSelection, inRange, isEmptyRange, maxCopyLength, navigate, pressButton,
  pressSelection, rangeOf, resolveBlocks, select, selectAll, toTsv, windowRanges, type BlockKind, type GridHit, type GridSelection
} from '../src/renderer/src/grid/selection'
import { ResultSelectionService } from '../src/renderer/src/services/result-selection'

/** One block from `anchor` to `focus`, the active cell at its focus, as a press and a Shift+press make it. */
const block = (kind: BlockKind, anchor: [number, number], focus: [number, number] = anchor, resultIndex = 0): GridSelection =>
  ({ resultIndex, blocks: [{ kind, anchor: { row: anchor[0], column: anchor[1] }, focus: { row: focus[0], column: focus[1] } }], active: { row: focus[0], column: focus[1] } })
const cells = (anchor: [number, number], focus: [number, number], resultIndex = 0): GridSelection => block('cells', anchor, focus, resultIndex)
/** Ctrl+presses on each hit in turn, after a plain press on the first. */
const added = (hits: readonly GridHit[], resultIndex = 0): GridSelection =>
  hits.reduce<GridSelection | undefined>((current, hit, index) => select(current, hit, { resultIndex, extend: false, add: index > 0 }), undefined)!
const cell = (row: number, column: number): GridHit => ({ kind: 'cell', row, column })
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
    expect(rangeOf(block('rows', [2, 1], [0, 2]), 3, 3)).toEqual({ top: 0, left: 0, bottom: 2, right: 2 })
    expect(rangeOf(block('rows', [2, 1]), 3, 3)).toEqual({ top: 2, left: 0, bottom: 2, right: 2 })
    expect(rangeOf(block('columns', [2, 2], [0, 1]), 3, 3)).toEqual({ top: 0, left: 1, bottom: 2, right: 2 })
    expect(rangeOf(selectAll(0), 4, 2)).toEqual({ top: 0, left: 0, bottom: 3, right: 1 })
    // A result without rows selects nothing, even all of it.
    expect(isEmptyRange(rangeOf(selectAll(0), 0, 2))).toBe(true)
    expect(isEmptyRange(rangeOf(cells([0, 0], [0, 0]), 0, 0))).toBe(true)
    expect(isEmptyRange(rangeOf({ resultIndex: 0, blocks: [], active: { row: 0, column: 0 } }, 3, 3))).toBe(true)
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
    expect(toTsv(set, block('columns', [1, 2]), { headers: false, eol: '\n' })).toBe('NULL\nline break\n1')
    expect(toTsv({ columns: set.columns, rows: [] }, selectAll(0), { headers: true, eol: '\n' })).toBe('Id\t(No column name)\tNote')
    expect(toTsv({ columns: [], rows: [] }, selectAll(0), { headers: true, eol: '\n' })).toBe('')
    // The PR3 table copies the last block only.
    expect(toTsv(set, added([cell(0, 0), cell(2, 2)]), { headers: false, eol: '\n' })).toBe('1')
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
    const one = press(undefined, cell(1, 2))
    expect(one).toEqual(cells([1, 2], [1, 2]))
    expect(press(one, cell(0, 0), { shift: true })).toEqual(cells([1, 2], [0, 0]))
    expect(press(one, { kind: 'row', row: 2 })).toEqual(block('rows', [2, 0]))
    expect(rangeOf(press(one, { kind: 'row', row: 0 }, { shift: true }), 3, 3)).toEqual({ top: 0, left: 0, bottom: 1, right: 2 })
    expect(press(one, { kind: 'column', column: 1 })).toEqual(block('columns', [0, 1]))
    expect(rangeOf(press(one, { kind: 'column', column: 0 }, { shift: true }), 3, 3)).toEqual({ top: 0, left: 0, bottom: 2, right: 2 })
    expect(press(one, { kind: 'corner' })).toEqual(selectAll(0, { row: 1, column: 2 }))
    // Shift with nothing selected in this result set, or a selection from another one, selects plainly.
    expect(press(cells([0, 0], [0, 0], 1), cell(2, 2), { shift: true })).toEqual(cells([2, 2], [2, 2]))
    const grown = dragSelection(dragSelection(one, cell(2, 0)), { kind: 'row', row: 0 })
    expect(rangeOf(grown, 3, 3)).toEqual({ top: 0, left: 0, bottom: 1, right: 2 })
    expect(grown.active).toEqual({ row: 0, column: 0 })
    const rows = press(undefined, { kind: 'row', row: 1 })
    expect(rangeOf(dragSelection(rows, cell(2, 2)), 3, 3)).toEqual({ top: 1, left: 0, bottom: 2, right: 2 })
    expect(dragSelection(selectAll(0), cell(1, 1))).toEqual(selectAll(0))
    expect(dragSelection(one, cell(1, 2))).toBe(one)
  })
  it('keeps the selection for a right press inside any block and selects the cell for one outside, as SSMS does', () => {
    const right = (current: GridSelection, hit: GridHit) => pressSelection(current, hit, { resultIndex: 0, shift: false, right: true, rows: 3, columns: 3 })
    const square = cells([0, 0], [1, 1])
    expect(right(square, cell(1, 0))).toBe(square)
    expect(right(square, cell(2, 2))).toEqual(cells([2, 2], [2, 2]))
    // Shift does not extend, and Ctrl does not add, on a right press.
    expect(pressSelection(square, cell(2, 2), { resultIndex: 0, shift: true, right: true, rows: 3, columns: 3 })).toEqual(cells([2, 2], [2, 2]))
    expect(pressSelection(square, cell(2, 2), { resultIndex: 0, shift: false, right: true, add: true, rows: 3, columns: 3 })).toEqual(cells([2, 2], [2, 2]))
    // A row number or header keeps the selection only when its whole row or column is selected.
    expect(right(square, { kind: 'row', row: 0 })).toEqual(block('rows', [0, 0]))
    const fullRows = cells([0, 0], [1, 2])
    expect(right(fullRows, { kind: 'row', row: 1 })).toBe(fullRows)
    expect(right(selectAll(0), { kind: 'column', column: 2 })).toEqual(selectAll(0))
    expect(right(selectAll(0), { kind: 'corner' })).toEqual(selectAll(0))
    expect(right(square, { kind: 'corner' })).toEqual(selectAll(0, { row: 1, column: 1 }))
    // Any block counts, not only the last.
    const two = added([cell(0, 0), cell(2, 2)])
    expect(right(two, cell(0, 0))).toBe(two)
  })
  it('treats Control+click as a right press on macOS, where it opens the context menu, so Copy keeps the selection', () => {
    const press = (button: number, ctrlKey: boolean, platform: Platform) => pressButton({ button, ctrlKey }, platform)
    // Chromium on macOS reports Control+click as a left press with Control, then opens the menu.
    expect([press(0, true, 'darwin'), press(2, false, 'darwin'), press(0, false, 'darwin'), press(1, false, 'darwin')]).toEqual(['secondary', 'secondary', 'primary', undefined])
    // Elsewhere Control+click is a left press.
    for (const platform of ['win32', 'linux'] as const) expect([press(0, true, platform), press(2, true, platform)]).toEqual(['primary', 'secondary'])
    const square = cells([0, 0], [1, 1])
    expect(pressSelection(square, cell(1, 1), { resultIndex: 0, shift: false, right: press(0, true, 'darwin') === 'secondary', rows: 3, columns: 3 })).toBe(square)
  })
  it('describes the selection for screen readers', () => {
    expect(describeRange({ top: 0, left: 0, bottom: 0, right: 0 })).toBe('1 row, 1 column selected')
    expect(describeRange({ top: 1, left: 0, bottom: 3, right: 2 })).toBe('3 rows, 3 columns selected')
    expect(describeRange({ top: 0, left: 0, bottom: -1, right: 2 })).toBe('No cells selected')
    expect(describeSelection(cells([0, 0], [1, 1]), 5, 5)).toBe('2 rows, 2 columns selected')
    expect(describeSelection(selectAll(0), 0, 5)).toBe('No cells selected')
    // Overlapping blocks count their shared cells once: 4 + 4 − 1.
    const overlapping = select(cells([0, 0], [1, 1]), cell(1, 1), { resultIndex: 0, extend: false, add: true })
    expect(describeSelection(select(overlapping, cell(2, 2), { resultIndex: 0, extend: true, add: false }), 5, 5)).toBe('2 ranges selected, 7 cells')
    const crossing = added([{ kind: 'row', row: 1 }, { kind: 'column', column: 3 }, cell(4, 4)])
    expect(describeSelection(crossing, 5, 5)).toBe('3 ranges selected, 10 cells')
  })
})

describe('selection blocks', () => {
  it('adds a block per Ctrl+press, of the kind pressed, keeping at most 64', () => {
    const three = added([cell(0, 0), { kind: 'row', row: 3 }, { kind: 'column', column: 2 }])
    expect(three.blocks.map(item => item.kind)).toEqual(['cells', 'rows', 'columns'])
    expect(three.active).toEqual({ row: 0, column: 2 })
    expect(resolveBlocks(three, 5, 4)).toEqual([{ top: 0, left: 0, bottom: 0, right: 0 }, { top: 3, left: 0, bottom: 3, right: 3 }, { top: 0, left: 2, bottom: 4, right: 2 }])
    expect([contains(three, 0, 0, 5, 4), contains(three, 3, 1, 5, 4), contains(three, 4, 2, 5, 4), contains(three, 1, 1, 5, 4), contains(three, 9, 2, 5, 4)]).toEqual([true, true, true, false, false])
    // Shift extends only the last block.
    const extended = select(three, cell(4, 3), { resultIndex: 0, extend: true, add: false })
    expect(extended.blocks.slice(0, 2)).toEqual(three.blocks.slice(0, 2))
    expect(extended.blocks[2]).toEqual({ kind: 'cells', anchor: { row: 0, column: 2 }, focus: { row: 4, column: 3 } })
    // A plain press, or a Ctrl+press in another result set, starts over.
    expect(select(three, cell(1, 1), { resultIndex: 0, extend: false, add: false })).toEqual(cells([1, 1], [1, 1]))
    expect(select(three, cell(1, 1), { resultIndex: 1, extend: false, add: true })).toEqual(cells([1, 1], [1, 1], 1))
    const many = added(Array.from({ length: 70 }, (_, index) => cell(index, 0)))
    expect(many.blocks).toHaveLength(64)
    expect(many.blocks[0].anchor).toEqual({ row: 6, column: 0 })
    expect(many.active).toEqual({ row: 69, column: 0 })
    // Dragging moves the last block's far corner only.
    const dragged = dragSelection(three, cell(4, 3))
    expect(dragged.blocks[2]).toEqual({ kind: 'columns', anchor: { row: 0, column: 2 }, focus: { row: 0, column: 3 } })
    expect(dragged.blocks.slice(0, 2)).toEqual(three.blocks.slice(0, 2))
  })
  it('grows whole-column and select-all blocks as rows stream in, and keeps cells and rows where they are', () => {
    const selection = added([{ kind: 'column', column: 1 }, cell(2, 0), { kind: 'row', row: 1 }])
    expect(resolveBlocks(selection, 3, 2)).toEqual([{ top: 0, left: 1, bottom: 2, right: 1 }, { top: 2, left: 0, bottom: 2, right: 0 }, { top: 1, left: 0, bottom: 1, right: 1 }])
    expect(resolveBlocks(selection, 100, 2)).toEqual([{ top: 0, left: 1, bottom: 99, right: 1 }, { top: 2, left: 0, bottom: 2, right: 0 }, { top: 1, left: 0, bottom: 1, right: 1 }])
    expect(resolveBlocks(selection, 0, 2)).toEqual([])
    expect(blockRange(selectAll(0).blocks[0], 1_000_000, 4)).toEqual({ top: 0, left: 0, bottom: 999_999, right: 3 })
    expect(contains(selectAll(0), 999_999, 3, 1_000_000, 4)).toBe(true)
    expect(contains(selectAll(0), 1_000_000, 3, 1_000_000, 4)).toBe(false)
  })
  it('clip the blocks to a frame\'s window, so each painted cell is tested against at most 64 rectangles', () => {
    const selection = added([{ kind: 'column', column: 1 }, cell(500, 0), { kind: 'row', row: 40 }])
    const window = { top: 30, left: 0, bottom: 70, right: 5 }
    const ranges = windowRanges(selection, 1000, 10, window)
    expect(ranges).toEqual([{ top: 30, left: 1, bottom: 70, right: 1 }, { top: 40, left: 0, bottom: 40, right: 5 }])
    for (let row = 30; row <= 70; row++) for (let column = 0; column <= 5; column++) expect(covered(ranges, row, column)).toBe(contains(selection, row, column, 1000, 10))
    expect(covered([], 0, 0)).toBe(false)
    expect(windowRanges(selection, 1000, 10, { top: 0, left: 0, bottom: -1, right: 5 })).toEqual([])
  })
})

describe('keyboard navigation', () => {
  /** A key event as Chromium reports it; `mod` is Ctrl, or ⌘ on macOS. */
  const press = (platform: Platform, key: string, code: string, m: { shift?: boolean; mod?: boolean; ctrl?: boolean } = {}) => ({
    key, code, shiftKey: !!m.shift, altKey: false, ctrlKey: !!m.ctrl || (!!m.mod && platform !== 'darwin'), metaKey: !!m.mod && platform === 'darwin'
  })
  const options = { rows: 10, columns: 5, pageRows: 3 }
  const start = cells([4, 2], [4, 2])
  /** [key, code, modifiers, expected anchor, expected focus (and active), block kind]. */
  const table: readonly [string, string, { shift?: boolean; mod?: boolean; ctrl?: boolean }, [number, number], [number, number], BlockKind][] = [
    ['ArrowUp', 'ArrowUp', {}, [3, 2], [3, 2], 'cells'], ['ArrowDown', 'ArrowDown', {}, [5, 2], [5, 2], 'cells'],
    ['ArrowLeft', 'ArrowLeft', {}, [4, 1], [4, 1], 'cells'], ['ArrowRight', 'ArrowRight', {}, [4, 3], [4, 3], 'cells'],
    ['ArrowUp', 'ArrowUp', { shift: true }, [4, 2], [3, 2], 'cells'], ['ArrowRight', 'ArrowRight', { shift: true }, [4, 2], [4, 3], 'cells'],
    ['ArrowUp', 'ArrowUp', { mod: true }, [0, 2], [0, 2], 'cells'], ['ArrowDown', 'ArrowDown', { mod: true }, [9, 2], [9, 2], 'cells'],
    ['ArrowLeft', 'ArrowLeft', { mod: true }, [4, 0], [4, 0], 'cells'], ['ArrowRight', 'ArrowRight', { mod: true }, [4, 4], [4, 4], 'cells'],
    ['ArrowDown', 'ArrowDown', { mod: true, shift: true }, [4, 2], [9, 2], 'cells'], ['ArrowLeft', 'ArrowLeft', { mod: true, shift: true }, [4, 2], [4, 0], 'cells'],
    ['Home', 'Home', {}, [4, 0], [4, 0], 'cells'], ['End', 'End', {}, [4, 4], [4, 4], 'cells'], ['End', 'End', { shift: true }, [4, 2], [4, 4], 'cells'],
    ['Home', 'Home', { mod: true }, [0, 0], [0, 0], 'cells'], ['End', 'End', { mod: true }, [9, 4], [9, 4], 'cells'],
    ['Home', 'Home', { mod: true, shift: true }, [4, 2], [0, 0], 'cells'], ['End', 'End', { mod: true, shift: true }, [4, 2], [9, 4], 'cells'],
    ['PageUp', 'PageUp', {}, [1, 2], [1, 2], 'cells'], ['PageDown', 'PageDown', {}, [7, 2], [7, 2], 'cells'], ['PageDown', 'PageDown', { shift: true }, [4, 2], [7, 2], 'cells'],
    [' ', 'Space', { shift: true }, [4, 2], [4, 2], 'rows'], [' ', 'Space', { ctrl: true }, [4, 2], [4, 2], 'columns'], ['a', 'KeyA', { mod: true }, [4, 2], [4, 2], 'all']
  ]
  it('moves, extends, and selects rows, columns, or everything with each grid key on every platform', () => {
    for (const platform of platforms) for (const [key, code, modifiers, anchor, focus, kind] of table) {
      const name = `${platform} ${JSON.stringify(modifiers)} ${key}`
      const action = gridKeyAction(press(platform, key, code, modifiers), platform)
      expect(action, name).toBeDefined()
      const next = navigate(start, action!, options)
      expect(next.blocks, name).toEqual([{ kind, anchor: { row: anchor[0], column: anchor[1] }, focus: { row: focus[0], column: focus[1] } }])
      // Selecting rows, columns, or everything keeps the active cell; moves take it along.
      expect(next.active, name).toEqual({ row: focus[0], column: focus[1] })
    }
  })
  it('stops at the edges and returns the same selection when nothing moves', () => {
    const corner = cells([0, 0], [0, 0])
    for (const move of ['up', 'left', 'firstRow', 'firstColumn', 'firstCell', 'pageUp'] as const) expect(navigate(corner, { type: 'move', move, extend: false }, options), move).toBe(corner)
    const end = cells([9, 4], [9, 4])
    for (const move of ['down', 'right', 'lastRow', 'lastColumn', 'lastCell', 'pageDown'] as const) expect(navigate(end, { type: 'move', move, extend: false }, options), move).toBe(end)
    expect(navigate(cells([5, 4], [9, 4]), { type: 'move', move: 'down', extend: true }, options)).toEqual(cells([5, 4], [9, 4]))
    expect(navigate(cells([8, 2], [8, 2]), { type: 'move', move: 'pageDown', extend: false }, options)).toEqual(cells([9, 2], [9, 2]))
    // A page is at least one row.
    expect(navigate(start, { type: 'move', move: 'pageDown', extend: false }, { ...options, pageRows: 0 })).toEqual(cells([5, 2], [5, 2]))
    // Nothing to move over, and keys that are not moves, change nothing.
    expect(navigate(start, { type: 'move', move: 'down', extend: false }, { ...options, rows: 0 })).toBe(start)
    for (const type of ['open', 'escape', 'copy'] as const) expect(navigate(start, { type }, options)).toBe(start)
  })
  it('extends from the last block\'s far corner, and from the active cell after Select All', () => {
    const twice = navigate(navigate(start, { type: 'move', move: 'down', extend: true }, options), { type: 'move', move: 'right', extend: true }, options)
    expect(twice).toEqual(cells([4, 2], [5, 3]))
    const all = navigate(start, { type: 'selectAll' }, options)
    expect(navigate(all, { type: 'move', move: 'right', extend: true }, options)).toEqual(cells([4, 2], [4, 3]))
    // An active cell past the rows available (the result shrank to what was stored) is clamped first.
    expect(navigate(cells([40, 9], [40, 9]), { type: 'move', move: 'up', extend: false }, options)).toEqual(cells([8, 4], [8, 4]))
    // Rows and columns span the last block in its direction; over everything they span everything.
    expect(navigate(cells([6, 1], [2, 3]), { type: 'selectRows' }, options).blocks).toEqual([{ kind: 'rows', anchor: { row: 6, column: 3 }, focus: { row: 2, column: 3 } }])
    expect(navigate(cells([6, 3], [2, 1]), { type: 'selectColumns' }, options).blocks).toEqual([{ kind: 'columns', anchor: { row: 2, column: 3 }, focus: { row: 2, column: 1 } }])
    expect(rangeOf(navigate(all, { type: 'selectRows' }, options), 10, 5)).toEqual({ top: 0, left: 0, bottom: 9, right: 4 })
    expect(navigate(all, { type: 'selectColumns' }, options).blocks[0].kind).toBe('columns')
    // Only the last of several blocks is replaced.
    const two = added([cell(0, 0), cell(3, 3)])
    expect(navigate(two, { type: 'selectRows' }, options).blocks.map(item => item.kind)).toEqual(['cells', 'rows'])
  })
})

describe('copy plan', () => {
  const plan = (selection: GridSelection, columns = 5) => copyPlan(selection, columns)
  it('copies one block as one part, with whole columns and everything open-ended', () => {
    expect(plan(cells([2, 3], [0, 1]))).toEqual([{ rows: [[0, 2]], columns: [[1, 3]] }])
    expect(plan(block('rows', [4, 0], [2, 3]))).toEqual([{ rows: [[2, 4]], columns: [[0, 4]] }])
    expect(plan(block('columns', [0, 3], [7, 1]))).toEqual([{ rows: [[0, openEnd]], columns: [[1, 3]] }])
    expect(plan(selectAll(0, { row: 5, column: 2 }))).toEqual([{ rows: [[0, openEnd]], columns: [[0, 4]] }])
    expect(openEnd).toBe(2 ** 53 - 1)
    expect(plan(selectAll(0), 0)).toEqual([])
    expect(plan({ resultIndex: 0, blocks: [], active: { row: 0, column: 0 } })).toEqual([])
  })
  it('merges blocks that share columns into their row union, and blocks that share rows into their column union', () => {
    // Ctrl+click on the headers of columns A and C copies them side by side.
    expect(plan(added([{ kind: 'column', column: 2 }, { kind: 'column', column: 0 }]))).toEqual([{ rows: [[0, openEnd]], columns: [[0, 0], [2, 2]] }])
    // Row numbers 6, 2 and 3: one part, rows sorted and adjacent ones merged.
    expect(plan(added([{ kind: 'row', row: 6 }, { kind: 'row', row: 2 }, { kind: 'row', row: 3 }]))).toEqual([{ rows: [[2, 3], [6, 6]], columns: [[0, 4]] }])
    const sameColumns = select(select(cells([5, 1], [6, 2]), cell(0, 1), { resultIndex: 0, extend: false, add: true }), cell(3, 2), { resultIndex: 0, extend: true, add: false })
    expect(plan(sameColumns)).toEqual([{ rows: [[0, 3], [5, 6]], columns: [[1, 2]] }])
    const sameRows = select(select(cells([1, 4], [2, 4]), cell(1, 0), { resultIndex: 0, extend: false, add: true }), cell(2, 1), { resultIndex: 0, extend: true, add: false })
    expect(plan(sameRows)).toEqual([{ rows: [[1, 2]], columns: [[0, 1], [4, 4]] }])
  })
  it('copies unaligned blocks as one part each, in the order they were selected', () => {
    const first = cells([3, 2], [4, 4])
    const two = select(select(first, cell(0, 0), { resultIndex: 0, extend: false, add: true }), cell(1, 1), { resultIndex: 0, extend: true, add: false })
    expect(plan(two)).toEqual([{ rows: [[3, 4]], columns: [[2, 4]] }, { rows: [[0, 1]], columns: [[0, 1]] }])
    const many = added(Array.from({ length: 64 }, (_, index) => cell(index * 2, index % 5)))
    const parts = plan(many)
    expect(parts.length).toBeLessThanOrEqual(64)
    for (const part of parts) {
      expect(part.rows.length).toBeGreaterThanOrEqual(1)
      expect(part.rows.length).toBeLessThanOrEqual(64)
      expect(part.columns.length).toBeLessThanOrEqual(64)
      // Ascending and disjoint, every pair first ≤ last.
      for (const ranges of [part.rows, part.columns]) ranges.forEach(([from, to], index) => { expect(from).toBeLessThanOrEqual(to); if (index) expect(from).toBeGreaterThan(ranges[index - 1][1]) })
    }
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
