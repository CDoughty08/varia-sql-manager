import { describe, expect, it } from 'vitest'
import { rowsFact } from '../src/renderer/src/results/status'
import { entryName, entryNumber, entrySecondary, queryName, resultTitle } from '../src/renderer/src/results/ResultsService'

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

describe("a result's name and its number", () => {
  // As ResultsService makes them: an original result the query named carries the name as its label too.
  const named = { number: 2, label: 'Open orders', descriptor: { name: 'Open orders' } }
  const unnamed = { number: 2, descriptor: {} }
  const pivot = { number: 4, label: 'Pivot of Open orders', descriptor: {} }
  it('names a named result by its name and keeps its number apart', () => {
    expect([entryName(named), entryNumber(named), entrySecondary(named), resultTitle(named), queryName(named)]).toEqual(['Open orders', 'Result 2', 'Result 2', 'Open orders', 'Open orders'])
  })
  it('names an unnamed result by its number, exactly as before names', () => {
    expect([entryName(unnamed), entryNumber(unnamed), entrySecondary(unnamed), resultTitle(unnamed), queryName(unnamed)]).toEqual(['Result 2', 'Result 2', undefined, 'Result 2', undefined])
  })
  it('names a Pivot by its frozen title, with no number beside it, and titles it by its own number where results are numbered', () => {
    expect([entryName(pivot), entrySecondary(pivot), resultTitle(pivot)]).toEqual(['Pivot of Open orders', undefined, 'Result 4'])
  })
})
