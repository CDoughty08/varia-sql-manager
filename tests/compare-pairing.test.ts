import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ResultColumn } from '../src/shared/contracts'
import { pairColumns, sameName } from '../src/renderer/src/results/compare-pairing'

interface Case { readonly name: string; readonly left: readonly ResultColumn[]; readonly right: readonly ResultColumn[]; readonly pairs: readonly [number, number][] }
const cases = (JSON.parse(readFileSync(new URL('./fixtures/compare-pairing/cases.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases

describe('Compare picker column pairing', () => {
  // DiffChecks.cs (SharedPairing) reads the same cases against ResultDiffer.Pairs, so the picker never promises a pairing
  // the backend would not make.
  it.each(cases.map(item => [item.name, item] as const))('pairs as the backend does: %s', (_name, item) => {
    expect(pairColumns(item.left, item.right).pairs).toEqual(item.pairs)
  })

  it('has the cases both suites need', () => expect(cases.length).toBeGreaterThanOrEqual(9))

  // The fake backend (tests/fixtures/backend.mjs) pairs for the smoke suites with the same rule, not a copy of it.
  it('the fake backend compares names with the shared rule', () => {
    const source = readFileSync(new URL('./fixtures/backend.mjs', import.meta.url), 'utf8')
    expect(source).toContain("import { sameName } from '../../src/shared/ordinal-casing.ts'")
    expect(source).not.toMatch(/(const|function) sameName/)
  })

  it('lists each side\'s columns left out, with the other side\'s type when a column of the same name did not pair', () => {
    const column = (name: string, dataType: string, wire: 'text' | 'binary' = 'text', role?: 'tone') => ({ name, dataType, wire, nullable: true, ...role ? { role } : {} })
    const old = [column('Id', 'int'), column('Hash', 'varbinary', 'binary'), column('Note', 'nvarchar'), column('', 'nvarchar(400)', 'text', 'tone')]
    const neu = [column('id', 'bigint'), column('Hash', 'char(64)'), column('Added', 'date')]
    const pairing = pairColumns(old, neu)
    expect(pairing.pairs).toEqual([[0, 0]])
    // A tone column is hidden, so never listed.
    expect(pairing.oldOnly).toEqual([{ index: 1, name: 'Hash', dataType: 'varbinary', otherType: 'char(64)' }, { index: 2, name: 'Note', dataType: 'nvarchar' }])
    expect(pairing.newOnly).toEqual([{ index: 1, name: 'Hash', dataType: 'char(64)', otherType: 'varbinary' }, { index: 2, name: 'Added', dataType: 'date' }])
  })

  it('compares names as OrdinalIgnoreCase does: by the casing table of .NET, length for length', () => {
    expect(sameName('ItemId', 'ITEMID')).toBe(true)
    expect(sameName('', '')).toBe(true)
    expect(sameName('Id', 'Id ')).toBe(false)
    // ß has no one-letter upper case, so it is compared as itself; the Kelvin sign only lower-cases to k.
    expect(sameName('Straße', 'STRASSE')).toBe(false)
    expect(sameName('Key', 'key')).toBe(false)
  })
})
