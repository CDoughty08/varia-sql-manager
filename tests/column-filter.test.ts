import { describe, expect, it } from 'vitest'
import { checklistCondition, columnFilterKind, conditionFilter, sameFilterFamily, unlistedValues } from '../src/renderer/src/results/column-filter'

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
    const base = { truncated: true, complete: true }, shown = { ...base, dropped: [] }, hidden = { ...base, held: [] }
    // All shown now: drop only the cleared ones. All hidden now: keep only the ticked ones, even when longer.
    expect(checklistCondition({ rows, unchecked: new Set([11, 12, 13, 14]), hasNull: false, nullChecked: true, unlisted: shown })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [11, 12, 13, 14], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set([14]), hasNull: true, nullChecked: false, unlisted: hidden })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10, 11, 12, 13], nulls: false } })
    // Some shown: the ones the grid's view holds stay with the ticked values, the ones it drops with the cleared ones,
    // whichever names fewer and fits.
    const some = { ...base, held: [99], dropped: [97, 98] }
    expect(checklistCondition({ rows, unchecked: new Set([11, 12, 13, 14]), hasNull: false, nullChecked: true, unlisted: some })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10, 99], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set([14]), hasNull: false, nullChecked: true, unlisted: some })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [14, 97, 98], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set([14]), hasNull: false, nullChecked: true, unlisted: { ...base, held: [99] } })).toEqual({ condition: { kind: 'values', op: 'in', rows: [10, 11, 12, 13, 99], nulls: false } })
    // Every listed value ticked with many held past the list: the in would not fit, the notIn of the dropped ones does.
    const many = Array.from({ length: 4095 }, (_, at) => 1000 + at)
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: false, nullChecked: true, unlisted: { ...base, held: many, dropped: [99] } })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [99], nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: false, nullChecked: true, unlisted: { ...base, held: many } })).toMatchObject({ error: expect.stringContaining('values not listed') })
    // Every listed value ticked takes the filter off only when nothing unlisted stays hidden.
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: false, nullChecked: true, unlisted: shown })).toEqual({ condition: { kind: 'all' } })
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: false, nullChecked: true, unlisted: hidden })).toEqual({ condition: { kind: 'values', op: 'in', rows, nulls: false } })
    expect(checklistCondition({ rows, unchecked: new Set(), hasNull: false, nullChecked: true, unlisted: { ...base, dropped: [99] } })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [99], nulls: false } })
    // Neither side named: a notIn shows every value not listed.
    expect(checklistCondition({ rows, unchecked: new Set([11, 12, 13, 14]), hasNull: false, nullChecked: true, unlisted: base })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [11, 12, 13, 14], nulls: false } })
    // From an answer: no marks (no value filter) shows them all; marked, the named sides less the rows a search found;
    // rows still arriving leave no in, which would hide their values.
    const answer = { rows: 9, complete: true, nulls: 0, distinct: 9, truncated: true, approximate: false, values: [] }
    const known = new Set([7])
    expect(unlistedValues({ ...answer, truncated: false }, known)).toBeUndefined()
    expect(unlistedValues(answer, known)).toEqual(shown)
    expect(unlistedValues({ ...answer, unlistedKept: false, unlistedHeld: [] }, known)).toEqual(hidden)
    expect(unlistedValues({ ...answer, unlistedKept: true, unlistedHeld: [7, 8], unlistedDropped: [6, 7] }, known)).toEqual({ ...base, held: [8], dropped: [6] })
    expect(unlistedValues({ ...answer, unlistedKept: true }, known)).toEqual(base)
    expect(unlistedValues({ ...answer, truncated: false, complete: false }, known)).toEqual({ truncated: false, complete: false, dropped: [] })
    expect(unlistedValues({ ...answer, complete: false, unlistedKept: true, unlistedHeld: [8], unlistedDropped: [6] }, known)).toEqual({ truncated: true, complete: false, dropped: [6] })
    expect(checklistCondition({ rows, unchecked: new Set([11, 12, 13, 14]), hasNull: false, nullChecked: true, unlisted: { truncated: false, complete: false, dropped: [] } })).toEqual({ condition: { kind: 'values', op: 'notIn', rows: [11, 12, 13, 14], nulls: false } })
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
