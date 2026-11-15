import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backendDescriptorSchema, refusedResultNameChars, resultNameChars } from '../src/shared/ipc/descriptors'

// The descriptor's optional name (docs/named-result-sets-scope.md, Security and limits): bounded here as in the backend's
// ResultNames scanner, so a descriptor whose name breaks the bound fails validation like any other bad field.
describe('a result descriptor name', () => {
  const descriptor = (name?: unknown) => ({
    resultId: 5, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [{ name: 'Column', dataType: 'int', wire: 'text', nullable: true }],
    rowsRead: 1, rowsStored: 1, rowsAvailable: 1, bytesStored: 10, truncatedCells: 0, state: 'complete', incomplete: false, ...name === undefined ? {} : { name }
  })
  const valid = (name?: unknown) => backendDescriptorSchema.safeParse(descriptor(name)).success

  it('is optional, and 1 to 128 characters', () => {
    expect(resultNameChars).toBe(128)
    expect([valid(), valid('Open orders'), valid('a'), valid('x'.repeat(128)), valid('Says "hello"')]).toEqual([true, true, true, true, true])
    expect([valid(''), valid('x'.repeat(129)), valid(null), valid(7)]).toEqual([false, false, false, false])
  })
  it('refuses controls, line separators, bidirectional characters and untrimmed text', () => {
    for (const ch of ['\u0000', '\t', '\n', '\r', '\u007f', '\u0085', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\ufeff']) {
      expect(refusedResultNameChars.test(`a${ch}b`), JSON.stringify(ch)).toBe(true)
      expect(valid(`a${ch}b`), JSON.stringify(ch)).toBe(false)
    }
    expect([valid(' padded'), valid('padded '), valid('Ünïcødé 名前 😀')]).toEqual([false, false, true])
  })
  it('refuses exactly the code units of the shared fixture, as the backend does', () => {
    // tests/fixtures/result-names/refused.json: ResultNameChecks.cs holds ResultNames.IsRefused to the same ranges.
    const { ranges } = JSON.parse(readFileSync(join('tests', 'fixtures', 'result-names', 'refused.json'), 'utf8')) as { ranges: [number, number][] }
    const differ: number[] = []
    for (let code = 0; code <= 0xffff; code++)
      if (refusedResultNameChars.test(String.fromCharCode(code)) !== ranges.some(([from, to]) => code >= from && code <= to)) differ.push(code)
    expect(ranges.length).toBeGreaterThan(0)
    expect(differ).toEqual([])
  })
})
