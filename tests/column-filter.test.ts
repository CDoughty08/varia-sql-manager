import { describe, expect, it } from 'vitest'
import { blocksToDrop, checklistCondition, columnFilterKind, conditionFilter, listWindow, maxListSpace, sameFilterFamily } from '../src/renderer/src/results/column-filter'
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
  })

  it('drops the cached blocks farthest from view, never one in view', () => {
    expect(blocksToDrop([0, 1, 2], 1, 1, 4)).toEqual([])
    expect(blocksToDrop([0, 1, 2, 3, 10, 50], 2, 3, 3)).toEqual([50, 10, 0])
    expect(blocksToDrop([4, 5, 6], 4, 6, 1)).toEqual([])
  })
})
