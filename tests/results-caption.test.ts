import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rowsFact } from '../src/renderer/src/results/status'
import { planSourceLabel } from '../src/renderer/src/plans/ResultPlans'
import type { ResultSetEntry } from '../src/renderer/src/results/ResultsService'
import { comparedNames, comparisonName, distinctName, entryName, entryNumber, entrySecondary, numberedName, pivotName, queryName, resultTitle } from '../src/renderer/src/results/ResultsService'

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
    expect([entryName(named), entryNumber(named), entrySecondary(named), resultTitle(named), queryName(named)]).toEqual(['Open orders', 'Result 2', 'Result 2', 'Open orders, Result 2', 'Open orders'])
  })
  it('names an unnamed result by its number, exactly as before names', () => {
    expect([entryName(unnamed), entryNumber(unnamed), entrySecondary(unnamed), resultTitle(unnamed), queryName(unnamed)]).toEqual(['Result 2', 'Result 2', undefined, 'Result 2', undefined])
  })
  it('names a Pivot by its frozen title, with no number beside it, and titles it by its own number where results are numbered', () => {
    expect([entryName(pivot), entrySecondary(pivot), resultTitle(pivot)]).toEqual(['Pivot of Open orders', undefined, 'Result 4'])
  })
  it('lists a named result with its number and anything else by its name alone', () => {
    expect([numberedName(named), numberedName(unnamed), numberedName(pivot)]).toEqual(['Open orders · Result 2', 'Result 2', 'Pivot of Open orders'])
  })
  it('titles a comparison of two results of one name with their numbers, so it says which way round it is', () => {
    const other = { number: 5, label: 'Open orders', descriptor: { name: 'Open orders' } }
    expect(comparedNames(named, other)).toEqual(['Open orders (Result 2)', 'Open orders (Result 5)'])
    expect(comparedNames(named, pivot)).toEqual(['Open orders', 'Pivot of Open orders'])
    expect(comparedNames(unnamed, { number: 3, descriptor: {} })).toEqual(['Result 2', 'Result 3'])
    // A marker that names another result like a number numbers that one; the unnamed result keeps its words.
    const like = { number: 1, label: 'Result 2', descriptor: { name: 'Result 2' } }
    expect([distinctName(unnamed, [like, unnamed]), distinctName(like, [like, unnamed])]).toEqual(['Result 2', 'Result 2 (Result 1)'])
  })
})

describe("a SQL-returned plan's name in the plan viewer", () => {
  it('names a named plan set by its name with its number, an unnamed one and a captured plan as before', () => {
    const descriptor = (name?: string) => ({ ...name ? { name } : {} }) as ResultSetEntry['descriptor']
    expect(planSourceLabel({ number: 2, descriptor: descriptor('Plans') }, 0)).toBe('Plans, Result 2, plan 1')
    expect(planSourceLabel({ number: 2, descriptor: descriptor() }, 1)).toBe('Result 2, plan 2')
    expect(planSourceLabel({ number: 3, capturedPlan: true, descriptor: descriptor('Plans') }, 0, 'Batch 2')).toBe('Plan 3 · Batch 2')
  })
})

// A results surface names an entry only through ResultsService's naming helpers, so a name change (named results) reaches
// every surface. GridView sits under the results layer and builds its accessible "Result N of M" itself.
describe('result names come from the naming helpers', () => {
  it('builds "Result N", "Pivot of" and "Differences:" only in ResultsService', () => {
    const roots = ['src/renderer/src/results', 'src/renderer/src/grid', 'src/renderer/src/plans', 'src/renderer/src/contributions', 'src/renderer/src/menus']
    const built = /`(?:Result \$\{|Pivot of \$\{|Differences: \$\{)/
    const offenders = roots.flatMap(root => readdirSync(root).filter(name => /\.tsx?$/.test(name)).map(name => `${root}/${name}`))
      .filter(file => !file.endsWith('/ResultsService.ts'))
      .flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, index) => [file, index + 1, line] as const))
      .filter(([file, , line]) => built.test(line) && !(file.endsWith('/GridView.ts') && line.includes('of ${this.resultCount}')))
    expect(offenders.map(([file, line]) => `${file}:${line}`)).toEqual([])
  })
  it('names a Pivot and a comparison', () => {
    expect(pivotName('Result 3')).toBe('Pivot of Result 3')
    expect(comparisonName('Result 1', 'Totals (Result 3)')).toBe('Differences: Result 1 → Totals (Result 3)')
  })
})
