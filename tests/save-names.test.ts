import { describe, expect, it } from 'vitest'
import { fileNamePart, sameFileName, saveName, saveNameLimits } from '../src/renderer/src/results/save-names'
import { sanitizeFileName } from '../src/main/file-names'

const bytes = (text: string) => new TextEncoder().encode(text).length
/** What main makes of a suggestion: the stem and its kept suffix, with the extension. */
const file = (tab: string, subject: Parameters<typeof saveName>[1], extension = 'json') => {
  const { name, suffix } = saveName(tab, subject)
  return sanitizeFileName(name.slice(0, name.length - suffix.length) + '.' + extension, suffix)
}

describe('Save Results As names', () => {
  it('names an unnamed result, its Pivot, a comparison and a transposed grid as the plan does', () => {
    expect(saveName('SQLQuery1', { view: 'table', number: 2 })).toEqual({ name: 'SQLQuery1-Result2', suffix: '-Result2' })
    expect(saveName('SQLQuery1', { view: 'pivot', number: 2 })).toEqual({ name: 'SQLQuery1-Result2-Pivot', suffix: '-Result2-Pivot' })
    expect(saveName('SQLQuery1', { view: 'comparison', number: 1 })).toEqual({ name: 'SQLQuery1-Differences1', suffix: '-Differences1' })
    expect(saveName('SQLQuery1', { view: 'table', number: 2, transposed: true })).toEqual({ name: 'SQLQuery1-Result2-Transposed', suffix: '-Result2-Transposed' })
    expect(saveName('SQLQuery1', { view: 'pivot', number: 2, transposed: true }).name).toBe('SQLQuery1-Result2-Pivot-Transposed')
  })
  it("puts a named result's name where its number would be, and its number back when the name alone could not tell it apart", () => {
    expect(saveName('SQLQuery1', { view: 'table', number: 2, name: 'Open orders' })).toEqual({ name: 'SQLQuery1-Open orders', suffix: '' })
    expect(saveName('SQLQuery1', { view: 'pivot', number: 2, name: 'Open orders' })).toEqual({ name: 'SQLQuery1-Open orders-Pivot', suffix: '-Pivot' })
    expect(saveName('SQLQuery1', { view: 'table', number: 2, name: 'Open orders', transposed: true }).name).toBe('SQLQuery1-Open orders-Transposed')
    // Two results of one name: each keeps its number, so the two files differ.
    expect(saveName('SQLQuery1', { view: 'table', number: 3, name: 'Totals', collides: true })).toEqual({ name: 'SQLQuery1-Totals-Result3', suffix: '-Result3' })
    expect(saveName('SQLQuery1', { view: 'pivot', number: 5, name: 'Totals', collides: true }).name).toBe('SQLQuery1-Totals-Result5-Pivot')
    // A comparison is named by its place, whatever its sources are called.
    expect(saveName('SQLQuery1', { view: 'comparison', number: 2 }).name).toBe('SQLQuery1-Differences2')
  })
  it('makes a name safe for every file system and falls back to the number when nothing of it is left', () => {
    expect(file('SQLQuery1', { view: 'table', number: 1, name: 'a/b: c?' }, 'csv')).toBe('SQLQuery1-a_b_ c_.csv')
    // All refused characters, dots or spaces: named by its number, as an unnamed result.
    for (const name of ['???', '<>|', '...', ' / ', '\\'])
      expect(saveName('SQLQuery1', { view: 'table', number: 4, name })).toEqual({ name: 'SQLQuery1-Result4', suffix: '-Result4' })
    expect(fileNamePart('***')).toBeUndefined()
    expect(fileNamePart(' x? ')).toBe('x_')
    // A Windows device name as the result's name is safe after the tab's name; only a file that starts with one is not.
    expect(file('SQLQuery1', { view: 'table', number: 1, name: 'CON' }, 'csv')).toBe('SQLQuery1-CON.csv')
  })
  it('tells file names apart as file systems do: case aside, and after refused characters become _', () => {
    expect(sameFileName('Totals', 'totals')).toBe(true)
    expect(sameFileName('a/b', 'a:b')).toBe(true)
    expect(sameFileName('Totals', 'Totals 2')).toBe(false)
    expect(sameFileName('???', '***')).toBe(false)
    expect(sameFileName(undefined, 'Totals')).toBe(false)
  })
  it('bounds a 128-character name: cut to its limit and numbered, the tab giving way first', () => {
    const long = 'Open orders awaiting approval by the regional finance team before the end of the quarter, by region and by month'.padEnd(128, '!')
    const named = saveName('SQLQuery1', { view: 'pivot', number: 7, name: long })
    expect(named.suffix).toBe('-Result7-Pivot')
    expect(named.name).toBe(`SQLQuery1-${long.slice(0, saveNameLimits.nameChars).trimEnd()}-Result7-Pivot`)
    expect(named.name.length).toBeLessThanOrEqual(saveNameLimits.chars)
    // Two long names that differ only past the cut still make two files.
    const other = saveName('SQLQuery1', { view: 'pivot', number: 8, name: long.slice(0, 100) + 'x' })
    expect(other.name).not.toBe(named.name)
    // A long tab name gives way to the result's, and never to the suffix.
    const tab = 't'.repeat(128)
    const cut = saveName(tab, { view: 'table', number: 2, name: 'Open orders', transposed: true })
    expect(cut.name).toMatch(/^t+-Open orders-Transposed$/)
    expect(cut.name).toHaveLength(saveNameLimits.chars)
    expect(saveName('n'.repeat(200), { view: 'table', number: 3 }).name).toBe('n'.repeat(120) + '-Result3')
  })
  it('keeps within the bytes a file system allows, so main never cuts it, and never cuts a surrogate pair', () => {
    const wide = '報告'.repeat(64)
    for (const subject of [{ view: 'table', number: 12, name: wide }, { view: 'pivot', number: 12, name: wide, transposed: true }, { view: 'table', number: 1, name: '😀'.repeat(64) }] as const) {
      const { name, suffix } = saveName('データ'.repeat(40), subject)
      expect(bytes(name)).toBeLessThanOrEqual(saveNameLimits.bytes)
      expect(name.endsWith(suffix)).toBe(true)
      expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
      // What main suggests is the same name: nothing more is cut.
      expect(file('データ'.repeat(40), subject)).toBe(name + '.json')
    }
    const astral = saveName('a'.repeat(119) + '😀'.repeat(10), { view: 'table', number: 3 })
    expect(astral.name).toBe('a'.repeat(119) + '-Result3')
  })
})
