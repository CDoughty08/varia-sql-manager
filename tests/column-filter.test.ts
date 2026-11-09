import { describe, expect, it } from 'vitest'
import { checklistCondition, columnFilterKind, conditionFilter, sameFilterFamily } from '../src/renderer/src/results/column-filter'

describe('column filter', () => {
  const rows = [10, 11, 12, 13, 14]
  it('keeps the ticked values or drops the cleared ones, whichever names fewer, keeping on a tie', () => {
    expect(checklistCondition({ rows, unchecked: new Set([11, 12, 13, 14]), hasNull: false, nullChecked: true })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set([12]), hasNull: true, nullChecked: true })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [12], nulls: false } })
    // NULL counts as an entry: ticked NULL with two values against three cleared keeps them.
    expect(checklistCondition({ rows, unchecked: new Set([12, 13, 14]), hasNull: true, nullChecked: true })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10, 11], nulls: true } })
    expect(checklistCondition({ rows: [10, 11], unchecked: new Set([11]), hasNull: false, nullChecked: true })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: true, nullChecked: false })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [], nulls: true } })
  })
  it('leaves the values a truncated list did not reach as the grid shows them', () => {
    // Shown now (or some of them): drop only the cleared ones. All hidden now: keep only the ticked ones, even when longer.
    expect(checklistCondition({ rows, unchecked: new Set([11, 12, 13, 14]), hasNull: false, nullChecked: true, unlisted: 'keep' })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [11, 12, 13, 14], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set([14]), hasNull: true, nullChecked: false, unlisted: 'drop' })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10, 11, 12, 13], nulls: false } })
    expect(sameFilterFamily('notNull', 'values') && sameFilterFamily('values', 'values') && !sameFilterFamily('between', 'values') && !sameFilterFamily('notNull', 'between')).toBe(true)
  })
  it('takes the filter off when everything is ticked and refuses an empty or oversized list', () => {
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: true, nullChecked: true })).toEqual({ condition: { kind: 'all' } })
    expect(checklistCondition({ rows, unchecked: new Set(rows), hasNull: true, nullChecked: false })).toEqual({ error: 'Select at least one value.' })
    const many = Array.from({ length: 10_000 }, (_, row) => row)
    expect(checklistCondition({ rows: many, unchecked: new Set(many.slice(0, 5000)), hasNull: false, nullChecked: true })).toMatchObject({ error: expect.stringContaining('4,096') })
  })
  it('maps conditions to view filters and tells the kinds of a column\'s filters apart', () => {
    expect(conditionFilter({ kind: 'equals', row: 3 }, 2)).toEqual({ op: 'in', column: 2, rows: [3], nulls: false })
    expect(conditionFilter({ kind: 'notEquals', row: 3 }, 2)).toEqual({ op: 'notIn', column: 2, rows: [3], nulls: false })
    expect(conditionFilter({ kind: 'between', rows: [3, 9] }, 2)).toEqual({ op: 'between', column: 2, rows: [3, 9] })
    expect(conditionFilter({ kind: 'null' }, 2)).toEqual({ op: 'in', column: 2, rows: [], nulls: true })
    expect(conditionFilter({ kind: 'notNull' }, 2)).toEqual({ op: 'notIn', column: 2, rows: [], nulls: true })
    expect(conditionFilter({ kind: 'clear' }, 2)).toBeUndefined()
    expect(columnFilterKind({ op: 'notIn', column: 2, rows: [], nulls: true }, 2)).toBe('notNull')
    expect(columnFilterKind({ op: 'notIn', column: 2, rows: [1], nulls: true }, 2)).toBe('values')
    expect(columnFilterKind({ op: 'in', column: 2, cells: { ranges: [[0, 1]] } }, 2)).toBe('values')
    expect(columnFilterKind({ op: 'between', column: 2, rows: [1, 2] }, 2)).toBe('between')
    expect(columnFilterKind({ op: 'between', column: 2, rows: [1, 2] }, 1)).toBeUndefined()
    expect(columnFilterKind({ op: 'duplicates', columns: [2] }, 2)).toBeUndefined()
  })
})
