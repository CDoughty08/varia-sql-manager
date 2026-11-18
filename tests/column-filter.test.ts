import { describe, expect, it } from 'vitest'
import { addRange, keepsSide, blocksToDrop, checklistActions, checklistCondition, clampPopoverSize, columnFilterKind, conditionFilter, isNotNullFilter, isSelected, listWindow, maxListSpace, maxSelectionRanges, popoverPlace, popoverRoom, rowAtTop, rowsInView, sameFilterFamily, scrollForRowAtTop, scrollToShow, selectedCount, selectionTicks, selectRange, toggleRow } from '../src/renderer/src/results/column-filter'
import type { DistinctList } from '../src/renderer/src/results/ResultClient'

describe('column filter', () => {
  const summary = { snapshotId: 7, rows: 20, complete: true, nulls: 2, distinct: 5, approximate: false, checked: 5, nullsChecked: true }
  const list: DistinctList = { generation: 1, resultId: 3, snapshotId: 7, column: 2, summary, read: async () => { throw new Error('unused') }, tick: async () => { throw new Error('unused') }, close: async () => undefined }
  it('filters by the snapshot whenever some values are ticked and some are not, however many', () => {
    expect(checklistCondition({ list, checked: 1, distinct: 5, hasNull: false, nullChecked: true })).toEqual({ condition: { kind: 'list', list } })
    expect(checklistCondition({ list, checked: 999_999, distinct: 1_000_000, hasNull: false, nullChecked: true })).toEqual({ condition: { kind: 'list', list } })
    // NULL is an entry: every value ticked without NULL still filters, and NULL alone is enough to filter by.
    expect(checklistCondition({ list, checked: 5, distinct: 5, hasNull: true, nullChecked: false })).toEqual({ condition: { kind: 'list', list } })
    expect(checklistCondition({ list, checked: 0, distinct: 5, hasNull: true, nullChecked: true })).toEqual({ condition: { kind: 'list', list } })
    expect(sameFilterFamily('notNull', 'values') && sameFilterFamily('values', 'values') && !sameFilterFamily('between', 'values') && !sameFilterFamily('notNull', 'between')).toBe(true)
  })
  it('takes the filter off when everything is ticked and refuses an empty list', () => {
    expect(checklistCondition({ list, checked: 5, distinct: 5, hasNull: true, nullChecked: true })).toEqual({ condition: { kind: 'all' } })
    expect(checklistCondition({ list, checked: 1_000_000, distinct: 1_000_000, hasNull: false, nullChecked: false })).toEqual({ condition: { kind: 'all' } })
    expect(checklistCondition({ list, checked: 0, distinct: 5, hasNull: true, nullChecked: false })).toEqual({ error: 'Select at least one value.' })
    expect(checklistCondition({ list, checked: 0, distinct: 5, hasNull: false, nullChecked: true })).toEqual({ error: 'Select at least one value.' })
  })
  it('maps conditions to view filters and tells the kinds of a column\'s filters apart', () => {
    expect(conditionFilter({ kind: 'equals', row: 3 }, 2)).toEqual({ op: 'in', column: 2, rows: [3], nulls: false })
    expect(conditionFilter({ kind: 'notEquals', row: 3 }, 2)).toEqual({ op: 'notIn', column: 2, rows: [3], nulls: false })
    expect(conditionFilter({ kind: 'between', rows: [3, 9] }, 2)).toEqual({ op: 'between', column: 2, rows: [3, 9] })
    expect(conditionFilter({ kind: 'null' }, 2)).toEqual({ op: 'in', column: 2, rows: [], nulls: true })
    expect(conditionFilter({ kind: 'notNull' }, 2)).toEqual({ op: 'notIn', column: 2, rows: [], nulls: true })
    expect(conditionFilter({ kind: 'clear' }, 2)).toBeUndefined()
    expect(conditionFilter({ kind: 'list', list }, 2)).toEqual({ op: 'groups', column: 2, snapshotId: 7 })
    expect(columnFilterKind({ op: 'groups', column: 2, snapshotId: 7 }, 2)).toBe('values')
    expect(columnFilterKind({ op: 'notIn', column: 2, rows: [], nulls: true }, 2)).toBe('notNull')
    expect(columnFilterKind({ op: 'notIn', column: 2, rows: [1], nulls: true }, 2)).toBe('values')
    expect(columnFilterKind({ op: 'in', column: 2, cells: { ranges: [[0, 1]] } }, 2)).toBe('values')
    expect(columnFilterKind({ op: 'between', column: 2, rows: [1, 2] }, 2)).toBe('between')
    expect(columnFilterKind({ op: 'between', column: 2, rows: [1, 2] }, 1)).toBeUndefined()
    expect(columnFilterKind({ op: 'duplicates', columns: [2] }, 2)).toBeUndefined()
    // Keep Selected Rows names no column: it is no column's filter, and never the not-NULL one.
    for (const kept of [{ op: 'keepRows' as const, rows: [2] }, { op: 'keepRows' as const, cells: { ranges: [[2, 1]] as [number, number][] } }]) {
      expect([0, 2].map(column => columnFilterKind(kept, column))).toEqual([undefined, undefined])
      expect(isNotNullFilter(kept)).toBe(false)
    }
  })
  it('scrolls a row into view by the least move, below the top padding of the list, within the space and past it', () => {
    const base = { rowHeight: 22, viewHeight: 220, pad: 2 }
    // Within the space: a row in view needs no move; one below ends at the view's bottom, padding included; one above starts at the top.
    expect(scrollToShow({ ...base, rows: 1000, row: 5, scrollTop: 0 })).toBeUndefined()
    expect(scrollToShow({ ...base, rows: 1000, row: 9, scrollTop: 0 })).toBe(10 * 22 + 2 - 220)
    expect(scrollToShow({ ...base, rows: 1000, row: 50, scrollTop: 22 * 60 })).toBe(50 * 22 + 2)
    expect(scrollToShow({ ...base, rows: 1000, row: 0, scrollTop: 500 })).toBe(0)
    // Past the space (mapped): the row lands wholly inside the view, the last row too, which at the scroll range's end (the
    // space and both paddings, less the view) ends at the bottom padding, inside the space that clips the rows.
    const rows = 2_000_000, maxSpace = 1_000_000, end = maxSpace + 4 - 220
    for (const row of [10, 777_777, 1_234_567, rows - 1]) {
      for (const from of [0, end]) {
        const scrollTop = scrollToShow({ ...base, rows, row, scrollTop: from, maxSpace }) ?? from
        const at = listWindow({ scrollTop, viewHeight: 220, rowHeight: 22, rows, overscan: 0, maxSpace, pad: 2 })
        const position = at.offset(row) + 2 - scrollTop
        expect(position).toBeGreaterThanOrEqual(-1e-6)
        expect(position + 22).toBeLessThanOrEqual(220 + 1e-6)
        expect(at.offset(row) + 22).toBeLessThanOrEqual(maxSpace + 1e-6)
      }
    }
    const last = listWindow({ scrollTop: end, viewHeight: 220, rowHeight: 22, rows, overscan: 0, maxSpace, pad: 2 })
    expect(last.offset(rows - 1) + 2 - end + 22).toBeCloseTo(220 - 2, 6)
  })

  it('finds the fractional row at the top of the view and the scroll position that puts it back, within the space and past it', () => {
    for (const maxSpace of [100_000_000, 1_000_000]) {
      const geometry = { rows: 2_000_000, rowHeight: 22, viewHeight: 237, pad: 2, maxSpace }
      for (const scrollTop of [0, 11, 22 * 5000 + 13, 777_777, 999_000]) {
        const row = rowAtTop({ ...geometry, scrollTop })
        expect(scrollForRowAtTop({ ...geometry, row })).toBeCloseTo(scrollTop, 6)
      }
    }
    // The same row keeps its place across a change of cap: halfway through row 5000 stays halfway through it.
    const unmapped = { rows: 10_000, rowHeight: 22, viewHeight: 200, pad: 2, maxSpace: 1_000_000 }, mapped = { ...unmapped, maxSpace: 30_000 }
    const row = rowAtTop({ ...unmapped, scrollTop: 22 * 5000 + 2 + 11 })
    expect(row).toBeCloseTo(5000.5, 9)
    expect(rowAtTop({ ...mapped, scrollTop: scrollForRowAtTop({ ...mapped, row }) })).toBeCloseTo(5000.5, 9)
  })

  it('names the rows wholly in view, below the top padding', () => {
    expect(rowsInView({ rows: 1000, rowHeight: 22, viewHeight: 220, scrollTop: 0, pad: 2 })).toEqual({ first: 0, last: 8 })
    expect(rowsInView({ rows: 1000, rowHeight: 22, viewHeight: 220, scrollTop: 30, pad: 2 })).toEqual({ first: 2, last: 10 })
    expect(rowsInView({ rows: 3, rowHeight: 22, viewHeight: 220, scrollTop: 0 })).toEqual({ first: 0, last: 2 })
    // At the mapped scroll range's end the last row is in view.
    const rows = 2_000_000, maxSpace = 1_000_000
    expect(rowsInView({ rows, rowHeight: 22, viewHeight: 220, scrollTop: maxSpace + 4 - 220, pad: 2, maxSpace }).last).toBe(rows - 1)
    // Chromium snaps scrollTop to device pixels: at 125% scaling the 222 asked to put row 10 at the top reads back 222.4,
    // and row 10 still counts as in view (focus coming back to the list keeps it active).
    expect(scrollToShow({ row: 10, rows: 100, rowHeight: 22, viewHeight: 260, scrollTop: 300, pad: 2 })).toBe(222)
    expect(rowsInView({ rows: 100, rowHeight: 22, viewHeight: 260, scrollTop: 222.4, pad: 2 }).first).toBe(10)
    expect(scrollToShow({ row: 10, rows: 100, rowHeight: 22, viewHeight: 260, scrollTop: 222.4, pad: 2 })).toBeUndefined()
    // A view height that isn't a whole number of rows over the real space's scroll positions: rounding near 3e7 px keeps the
    // last row in view, and every row scrollToShow lands is counted in view.
    for (const [count, viewHeight] of [[1_500_000, 256], [1_500_007, 237], [2_000_003, 56]] as const) {
      const end = maxListSpace + 4 - viewHeight
      expect(rowsInView({ rows: count, rowHeight: 22, viewHeight, scrollTop: end, pad: 2 }).last).toBe(count - 1)
      for (const row of [3, 777_777, count - 2, count - 1]) {
        const at = scrollToShow({ row, rows: count, rowHeight: 22, viewHeight, scrollTop: row < 10 ? end : 0, pad: 2 }) ?? (row < 10 ? end : 0)
        const seen = rowsInView({ rows: count, rowHeight: 22, viewHeight, scrollTop: at, pad: 2 })
        expect(row >= seen.first && row <= seen.last).toBe(true)
      }
    }
  })

  it('gives each row its own pixels within the space a browser lays out, and maps the scroll bar past it so every row stays reachable', () => {
    const near = listWindow({ scrollTop: 2200, viewHeight: 220, rowHeight: 22, rows: 1_000_000, overscan: 8 })
    expect(near.space).toBe(22_000_000)
    expect([near.first, near.last, near.offset(100), near.offset(5)]).toEqual([92, 118, 2200, 110])
    // Two million rows of 22 px would need 44 million px: the space stops at the cap, and its ends show the first and last rows.
    const rows = 2_000_000, base = { viewHeight: 220, rowHeight: 22, rows, overscan: 8 }
    const top = listWindow({ ...base, scrollTop: 0 }), bottom = listWindow({ ...base, scrollTop: maxListSpace - 220 })
    expect(top.space).toBe(maxListSpace)
    expect([top.first, top.offset(0)]).toEqual([0, 0])
    expect(bottom.last).toBe(rows)
    expect(bottom.offset(rows - 1)).toBeCloseTo(maxListSpace - 22, 3)
    expect(bottom.offset(rows - 10)).toBeCloseTo(maxListSpace - 220, 3)
    // Halfway down the bar is halfway through the rows, drawn in view.
    const middle = listWindow({ ...base, scrollTop: (maxListSpace - 220) / 2 })
    const row = Math.floor((rows - 10) / 2)
    expect(middle.first).toBeLessThanOrEqual(row)
    expect(middle.last).toBeGreaterThan(row + 10)
    expect(middle.offset(row)).toBeGreaterThanOrEqual((maxListSpace - 220) / 2 - 22)
    expect(listWindow({ ...base, rows: 0, scrollTop: 0 })).toMatchObject({ space: 0, first: 0, last: 0 })
    // Every row drawn starts inside the space at any scroll position (near the end above all, where overscan rows would
    // not), so at most part of one hangs past it, which the space clips; the rows still cover the view.
    for (const scrollTop of [0, 1_000_000, maxListSpace - 2000, maxListSpace - 400, maxListSpace - 221, maxListSpace - 220]) {
      const at = listWindow({ ...base, scrollTop })
      for (let row = at.first; row < at.last; row++) expect(at.offset(row)).toBeLessThan(maxListSpace)
      expect(at.offset(at.last - 1) + 22).toBeLessThan(maxListSpace + 22)
      expect(at.offset(at.last - 1) + 22).toBeGreaterThanOrEqual(scrollTop + 220 - 1e-3)
    }
  })

  it('drops the cached blocks farthest from view, never one in view', () => {
    expect(blocksToDrop([0, 1, 2], 1, 1, 4)).toEqual([])
    expect(blocksToDrop([0, 1, 2, 3, 10, 50], 2, 3, 3)).toEqual([50, 10, 0])
    expect(blocksToDrop([4, 5, 6], 4, 6, 1)).toEqual([])
  })
  it('places the funnel popover beside its column: right, else left, else below or above, never over it while there is room', () => {
    const view = { width: 1200, height: 800 }
    // Right of the column, level with its header.
    expect(popoverPlace({ band: { left: 100, right: 250, top: 300, bottom: 780 }, width: 400, height: 420, view })).toEqual({ side: 'right', left: 252, top: 300, width: 400, maxHeight: 492 })
    // No room on the right: on the left. Too tall to start level with the header: it moves up only as far as it needs.
    expect(popoverPlace({ band: { left: 900, right: 1150, top: 500, bottom: 780 }, width: 400, height: 420, view })).toEqual({ side: 'left', left: 498, top: 372, width: 400, maxHeight: 420 })
    // A rotated grid's row across the window: below it, else above it.
    expect(popoverPlace({ band: { left: 0, right: 1200, top: 100, bottom: 120 }, width: 400, height: 420, view })).toEqual({ side: 'below', left: 8, top: 122, width: 400, maxHeight: 670 })
    expect(popoverPlace({ band: { left: 0, right: 1200, top: 700, bottom: 720 }, width: 400, height: 420, view })).toEqual({ side: 'above', left: 8, bottom: 102, width: 400, maxHeight: 690 })
    // Nowhere clear of the column (it fills the window): over it, at its right end.
    expect(popoverPlace({ band: { left: 0, right: 1200, top: 0, bottom: 800 }, width: 400, height: 420, view }).left).toBe(792)
    // A window narrower than the popover: it shrinks to fit.
    expect(popoverPlace({ band: { left: 0, right: 100, top: 0, bottom: 300 }, width: 600, height: 420, view: { width: 400, height: 300 } }).width).toBe(384)
  })
  it('keeps the side a resize started on, holding the popover to the room there instead of jumping across the column', () => {
    const view = { width: 1600, height: 800 }, band = { left: 900, right: 1100, top: 100, bottom: 780 }
    // 490 px on the right: 500 wide would move it left, unless the side is kept.
    expect(popoverPlace({ band, width: 500, height: 420, view }).side).toBe('left')
    expect(popoverRoom(band, view, 'right')).toEqual({ width: 490, height: 784 })
    expect(popoverPlace({ band, width: 500, height: 420, view, side: 'right' })).toMatchObject({ side: 'right', left: 1102, width: 490 })
    // Kept on the left, a narrow popover that would fit on the right stays left, its right edge by the column.
    expect(popoverPlace({ band, width: 400, height: 420, view, side: 'left' })).toMatchObject({ side: 'left', left: 498, width: 400 })
    // Below a band, the height is held to the room below.
    const row = { left: 0, right: 1600, top: 300, bottom: 320 }
    expect(popoverPlace({ band: row, width: 400, height: 700, view, side: 'below' })).toMatchObject({ side: 'below', top: 322, maxHeight: 470 })
    // A side with no room for the smallest popover is not kept (the last resort over the column).
    expect(keepsSide({ left: 0, right: 1600, top: 0, bottom: 800 }, view, 'right')).toBe(false)
    // Over the column for want of room beside it, even with room for a smaller popover on its right: marked, so a resize
    // keeps no side (it would jump beside the column at the first move).
    const tall = { left: 400, right: 500, top: 100, bottom: 760 }, small = { width: 1024, height: 768 }
    expect(popoverPlace({ band: tall, width: 600, height: 420, view: small })).toMatchObject({ side: 'right', left: 8, width: 600, over: true })
    expect(keepsSide(tall, small, 'right')).toBe(true)
    expect(popoverPlace({ band, width: 400, height: 420, view }).over).toBeUndefined()
    expect(popoverPlace({ band: { left: 0, right: 1600, top: 0, bottom: 800 }, width: 400, height: 420, view, side: 'right' }).left).toBe(1192)
  })
  it('keeps a remembered popover size within its bounds and the window', () => {
    expect(clampPopoverSize({ width: 100, height: 100 }, { width: 1200, height: 800 })).toEqual({ width: 340, height: 240 })
    expect(clampPopoverSize({ width: 2000, height: 2000 }, { width: 1200, height: 800 })).toEqual({ width: 900, height: 784 })
    expect(clampPopoverSize({ width: 420.4, height: 0 }, { width: 1200, height: 800 })).toEqual({ width: 420, height: 0 })
  })
  it('keeps a selection as sorted, disjoint ranges and names it to the backend as ranges of the list, NULL apart', () => {
    let selection = selectRange(5, 2)
    expect(selection).toEqual([[2, 5]])
    selection = addRange(selection, 9, 7)
    selection = addRange(selection, 6, 6)
    expect(selection).toEqual([[2, 9]])
    selection = toggleRow(selection, 4)
    expect(selection).toEqual([[2, 3], [5, 9]])
    expect([isSelected(selection, 4), isSelected(selection, 5), isSelected(selection, 10), selectedCount(selection)]).toEqual([false, true, false, 7])
    expect(toggleRow(selection, 0)).toEqual([[0, 0], [2, 3], [5, 9]])
    // With NULL listed first, row 0 is NULL's and the values' ranges start one row on.
    expect(selectionTicks([[0, 3], [6, 6]], 1)).toEqual({ nulls: true, ranges: [[0, 3], [5, 1]] })
    expect(selectionTicks([[0, 0]], 1)).toEqual({ nulls: true, ranges: [] })
    expect(selectionTicks([[0, 3]], 0)).toEqual({ nulls: false, ranges: [[0, 4]] })
    // No more ranges than one tick names: a click past that adds nothing.
    let many: ReturnType<typeof selectRange> = []
    for (let row = 0; row < maxSelectionRanges; row++) many = addRange(many, row * 2, row * 2)
    expect(addRange(many, maxSelectionRanges * 2 + 5, maxSelectionRanges * 2 + 5)).toBe(many)
    expect(toggleRow([[0, 10]], 5)).toEqual([[0, 4], [6, 10]])
  })
  it('lists the checklist actions by context, each with how many values it touches', () => {
    const labels = (o: Parameters<typeof checklistActions>[0]) => checklistActions(o).map(group => [group.label, group.actions.map(item => item.count === undefined ? item.label : `${item.label} ${item.count}`)])
    expect(labels({ selected: 1, matches: undefined, total: 36 })).toEqual([[undefined, ['Tick all 36', 'Untick all 36', 'Invert ticks']]])
    expect(labels({ selected: 1, matches: 1, total: 36 })).toEqual([
      ['1 match', ['Tick the matches 1', 'Tick only the matches 1', 'Untick the matches 1']],
      ['Every value', ['Tick all 36', 'Untick all 36']]
    ])
    expect(labels({ selected: 1200, matches: undefined, total: 5000 })[0]).toEqual(['1,200 selected', ['Tick the selected 1200', 'Untick the selected 1200', 'Tick only the selected 1200']])
    expect(checklistActions({ selected: 2, matches: 4, total: 9 }).flatMap(group => group.actions.map(item => item.action))).toEqual([
      { kind: 'selected', checked: true }, { kind: 'selected', checked: false }, { kind: 'selected', checked: true, only: true },
      { kind: 'matches', checked: true }, { kind: 'matches', checked: true, only: true }, { kind: 'matches', checked: false },
      { kind: 'all', checked: true }, { kind: 'all', checked: false }
    ])
  })
})
