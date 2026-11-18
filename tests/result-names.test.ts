// Names of derived results (docs/result-comparison-ux-plan.md D8): a comparison or a Pivot is named for itself on every
// surface that names an original result by its title, never by the number it was given ("Column profile Result 3").
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
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

  // Every surface that names a result by `resultTitle` would call a comparison "Result N". These are the only callers:
  // `entryTitle` (for an original result) and a save's or copy's job label, which picks by view. A new surface uses `entryTitle` or `entryName`.
  it('lists every caller of resultTitle', () => {
    const callers = sources(root).flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap(line =>
      /\bresultTitle\(/.test(line) ? [`${relative(root, file).replaceAll('\\', '/')}: ${line.trim().split(/ = | === /)[0]}`] : []))
    expect(callers).toEqual([
      'results/ResultsService.ts: export const entryTitle',
      'results/ResultsService.ts: return run.slots.get(set.key)?.view'
    ])
  })
})
