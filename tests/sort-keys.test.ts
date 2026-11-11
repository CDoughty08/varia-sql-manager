import { describe, expect, it } from 'vitest'
import { cycleSortKeys, sortKeysBy } from '../src/renderer/src/grid/sort-keys'

const make = (column: string) => (descending: boolean) => ({ column, descending })
const keys = (...spec: string[]) => spec.map(item => ({ column: item.replace('-', ''), descending: item.endsWith('-') }))

describe('sort keys (results and live grids alike)', () => {
  it('cycles a header: alone ascending, descending, unsorted; with add, in place among the keys', () => {
    const cycle = (current: ReturnType<typeof keys>, column: string, add = false) => cycleSortKeys(current, column, add, 4, make(column))
    expect(cycle([], 'a')).toEqual(keys('a'))
    expect(cycle(keys('a'), 'a')).toEqual(keys('a-'))
    expect(cycle(keys('a-'), 'a')).toEqual([])
    // Without add, a click on a column among several keys sorts by it alone; the sole key is the only one that cycles.
    expect(cycle(keys('a', 'b'), 'b')).toEqual(keys('b'))
    expect(cycle(keys('a', 'b'), 'c', true)).toEqual(keys('a', 'b', 'c'))
    expect(cycle(keys('a', 'b'), 'a', true)).toEqual(keys('a-', 'b'))
    expect(cycle(keys('a-', 'b'), 'a', true)).toEqual(keys('b'))
  })
  it('sorts and then-sorts within the cap, dropping the oldest key so the one chosen counts', () => {
    expect(sortKeysBy(keys('a', 'b'), 'c', 'descending', false, 4, make('c'))).toEqual(keys('c-'))
    expect(sortKeysBy(keys('a', 'b'), 'a', 'descending', true, 4, make('a'))).toEqual(keys('b', 'a-'))
    expect(sortKeysBy(keys('a', 'b'), 'a', 'none', true, 4, make('a'))).toEqual(keys('b'))
    expect(sortKeysBy(keys('a', 'b', 'c', 'd'), 'e', 'ascending', true, 4, make('e'))).toEqual(keys('b', 'c', 'd', 'e'))
    expect(cycleSortKeys(keys('a', 'b', 'c', 'd'), 'e', true, 4, make('e'))).toEqual(keys('b', 'c', 'd', 'e'))
  })
})
