import { describe, expect, it } from 'vitest'
import { meterWork } from './fixtures/work-meter'

describe('work meter', () => {
  it('counts copies, sorts, typed-array allocations and string scans, and restores every global', async () => {
    const arrayIterator = Array.prototype[Symbol.iterator], slice = Array.prototype.slice, int32 = Int32Array, startsWith = String.prototype.startsWith
    const source = Array.from({ length: 1000 }, (_, index) => index)
    const { result, work } = meterWork(() => {
      const copy = [...source].slice(10)
      copy.sort((a, b) => b - a)
      const typed = new Int32Array(64)
      typed.set(new Int32Array(32))
      const view = typed.subarray(0, 8)
      return { first: copy[0], view: view.length, prefix: 'dbo.Orders'.startsWith('dbo.'), lower: 'ABC'.toLocaleLowerCase() }
    })
    expect(result).toEqual({ first: 999, view: 8, prefix: true, lower: 'abc' })
    expect(work).toEqual({ elements: 1000 + 990 + 990 * 10 + 32, allocated: 96, allocations: 2, characters: 4 + 3, costly: 1 })
    expect([Array.prototype[Symbol.iterator], Array.prototype.slice, Int32Array, String.prototype.startsWith]).toEqual([arrayIterator, slice, int32, startsWith])
    const awaited = await meterWork(async () => { await Promise.resolve(); return [1, 2, 3].map(value => value * 2) })
    expect(awaited).toEqual({ result: [2, 4, 6], work: { elements: 3, allocated: 0, allocations: 0, characters: 0, costly: 0 } })
    expect(() => meterWork(() => { throw new Error('stopped') })).toThrow('stopped')
    expect(Array.prototype.slice).toBe(slice)
  })
})
