import { describe, expect, it } from 'vitest'
import { rowsFact } from '../src/renderer/src/results/status'

const view = (rows: number, baseRows: number, complete = true) => ({ rows, baseRows, complete })
const filter = { filter: { op: 'notNull', column: 0 }, label: 'id is not NULL' }

describe('a result caption\'s row count', () => {
  it('counts the set\'s rows when no filter applies, a sorted view included', () => {
    expect(rowsFact({ rowsAvailable: 1, state: 'complete' })).toBe('1 row')
    expect(rowsFact({ rowsAvailable: 12_345, state: 'open' })).toBe('12,345 rows')
    expect(rowsFact({ rowsAvailable: 100, state: 'complete' }, { applied: [], view: view(100, 100) })).toBe('100 rows')
  })

  it('counts a filtered view\'s rows of the base rows it was built from', () => {
    expect(rowsFact({ rowsAvailable: 100, state: 'complete' }, { applied: [filter], view: view(20, 100) })).toBe('20 of 100 rows')
    expect(rowsFact({ rowsAvailable: 1, state: 'complete' }, { applied: [filter], view: view(0, 1) })).toBe('0 of 1 row')
  })

  it('counts a view built while rows streamed against the rows sealed then, not the set\'s current count', () => {
    // Filtered with 60 of 100 rows sealed: the view looked at 60 until the set completes and it is built again.
    expect(rowsFact({ rowsAvailable: 100, state: 'open' }, { applied: [filter], view: view(20, 60, false) })).toBe('20 of 60 rows so far')
  })

  it('drops "so far" once nothing more arrives: a rebuild that failed, or a set lost or released mid-stream', () => {
    for (const state of ['complete', 'lost', 'released']) expect(rowsFact({ rowsAvailable: 100, state }, { applied: [filter], view: view(20, 60, false) })).toBe('20 of 60 rows')
  })
})
