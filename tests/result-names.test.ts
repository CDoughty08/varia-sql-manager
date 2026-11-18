// Names of derived results (docs/result-comparison-ux-plan.md D8): a comparison or a Pivot is named for itself on every
// surface that names an original result by its title, never by the number it was given ("Column profile Result 3").
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { derivedGridName } from '../src/renderer/src/grid/ResultGrid'
import { entryTitle, resultTitle } from '../src/renderer/src/results/ResultsService'

const root = join(__dirname, '../src/renderer/src')
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(item =>
  item.isDirectory() ? sources(join(dir, item.name)) : /\.tsx?$/.test(item.name) ? [join(dir, item.name)] : [])

describe('result names', () => {
  it('names a comparison and a Pivot by their own names, and an original result by its title', () => {
    const diff = { label: 'Differences: Result 1 → Result 2', number: 3, descriptor: { kind: 'diff' as const } }
    expect(entryTitle(diff)).toBe('Differences: Result 1 → Result 2')
    expect(resultTitle(diff)).toBe('Result 3')
    expect(entryTitle({ label: 'Pivot of Totals', number: 4, descriptor: { kind: 'pivot' as const } })).toBe('Pivot of Totals')
    expect(entryTitle({ label: 'Totals', number: 2, descriptor: { kind: 'rows' as const, name: 'Totals' } })).toBe('Totals, Result 2')
    expect(entryTitle({ number: 1, descriptor: { kind: 'rows' as const } })).toBe('Result 1')
  })

  it('announces the grid of a comparison or a Pivot by its own name, and leaves an original result "Result N of M"', () => {
    const named = (kind: 'diff' | 'pivot' | 'rows', label?: string) => derivedGridName({ number: 3, ...label ? { label } : {}, descriptor: { kind } } as Parameters<typeof derivedGridName>[0])
    expect(named('diff', 'Differences: Result 1 → Result 2')).toBe('Differences: Result 1 → Result 2')
    expect(named('pivot', 'Pivot of Result 2')).toBe('Pivot of Result 2')
    expect(named('rows')).toBeUndefined()
    expect(named('rows', 'Totals')).toBeUndefined()
  })

  // The ways a surface names a result by its number, which would call a comparison "Result N": `resultTitle`, and a grid's
  // `resultNumber` ("Result N of M"). These are the only callers; a new surface uses `entryTitle` or `entryName`. Text
  // built from `entryNumber` or `entry.number` by hand is not caught here.
  const callers = (pattern: RegExp) => sources(root).flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap(line =>
    pattern.test(line) ? [`${relative(root, file).replaceAll('\\', '/')}: ${line.trim().split(/ = | === |, /)[0]}`] : []))
  it('lists every caller of resultTitle', () => {
    // `entryTitle` (for an original result) and a save's or copy's job label, which picks by view.
    expect(callers(/\bresultTitle\(/)).toEqual([
      'results/ResultsService.ts: export const entryTitle',
      'results/ResultsService.ts: return run.slots.get(set.key)?.view'
    ])
  })

  it('lists every grid named by a result number', () => {
    // A results grid, which passes `derivedGridName` as its label for a comparison or Pivot (tests/result-grid-name.test.ts),
    // and a live grid, which always passes its own label.
    expect(callers(/(?<!readonly )\bresultNumber: /)).toEqual([
      'grid/ResultGrid.tsx: entry: key',
      'live/LiveGridPane.tsx: entry: \'live\''
    ])
  })
})
