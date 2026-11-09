import { describe, expect, it } from 'vitest'
import { rowsFact } from '../src/renderer/src/results/status'

describe('a result caption\'s row count', () => {
  it('counts the set\'s rows when no filter applies', () => {
    expect(rowsFact(1)).toBe('1 row')
    expect(rowsFact(12_345)).toBe('12,345 rows')
  })

  it('counts a filtered view\'s rows of the base rows it was built from', () => {
    expect(rowsFact(100, { rows: 20, baseRows: 100, complete: true })).toBe('20 of 100 rows')
    expect(rowsFact(1, { rows: 0, baseRows: 1, complete: true })).toBe('0 of 1 row')
  })

  it('counts a view built while rows streamed against the rows sealed then, not the set\'s current count', () => {
    // Filtered with 60 of 100 rows sealed: the view looked at 60 until the set completes and it is built again.
    expect(rowsFact(100, { rows: 20, baseRows: 60, complete: false })).toBe('20 of 60 rows so far')
  })
})
