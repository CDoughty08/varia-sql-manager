import { describe, expect, it } from 'vitest'
import { DecodeError, EncodeError, MsgPackCursor, MsgPackWriter, controlLimits, decodeControl, encodeControl } from '../src/shared/ipc/wire/msgpack.ts'

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text.replaceAll(' ', ''), 'hex'))
const decodeCode = (input: Uint8Array): string | undefined => {
  try { decodeControl(input) } catch (error) { if (error instanceof DecodeError) return error.code; throw error }
  return undefined
}
const encodeCode = (value: unknown): string | undefined => {
  try { encodeControl(value) } catch (error) { if (error instanceof EncodeError) return error.code; throw error }
  return undefined
}

describe('MessagePack subset', () => {
  it('encodes integers in their smallest form at every boundary', () => {
    const cases: [number, string][] = [
      [127, '7f'], [128, 'cc80'], [255, 'ccff'], [256, 'cd0100'], [65535, 'cdffff'], [65536, 'ce00010000'],
      [2 ** 32 - 1, 'ceffffffff'], [2 ** 32, 'cf0000000100000000'], [2 ** 53 - 1, 'cf001fffffffffffff'],
      [-32, 'e0'], [-33, 'd0df'], [-128, 'd080'], [-129, 'd1ff7f'], [-32768, 'd18000'], [-32769, 'd2ffff7fff'],
      [-(2 ** 31), 'd280000000'], [-(2 ** 31) - 1, 'd3ffffffff7fffffff'], [-(2 ** 53 - 1), 'd3ffe0000000000001']
    ]
    for (const [value, expected] of cases) {
      expect(hex(encodeControl(value)), String(value)).toBe(expected)
      expect(decodeControl(bytes(expected))).toBe(value)
    }
  })
  it('encodes strings, arrays, and maps at their header boundaries', () => {
    for (const [length, prefix] of [[31, 'bf'], [32, 'd920'], [255, 'd9ff'], [256, 'da0100'], [65535, 'daffff'], [65536, 'db00010000']] as const) {
      const value = 'x'.repeat(length)
      const encoded = encodeControl(value)
      expect(hex(encoded.subarray(0, prefix.length / 2)), `str ${length}`).toBe(prefix)
      expect(encoded.length).toBe(prefix.length / 2 + length)
      expect(decodeControl(encoded)).toBe(value)
    }
    // Multi-byte text is sized by its UTF-8 length, not its UTF-16 length.
    expect(hex(encodeControl('€'.repeat(10)).subarray(0, 1))).toBe('be')
    expect(hex(encodeControl('€'.repeat(11)).subarray(0, 2))).toBe('d921')
    expect(hex(encodeControl('é'.repeat(16)).subarray(0, 2))).toBe('d920')
    for (const [count, prefix] of [[15, '9f'], [16, 'dc0010'], [65536, 'dd00010000']] as const) {
      const value = Array.from({ length: count }, () => 0)
      expect(hex(encodeControl(value).subarray(0, prefix.length / 2)), `array ${count}`).toBe(prefix)
      expect(decodeControl(encodeControl(value))).toEqual(value)
    }
    for (const [count, prefix] of [[15, '8f'], [16, 'de0010']] as const) {
      const value = Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]))
      expect(hex(encodeControl(value).subarray(0, prefix.length / 2)), `map ${count}`).toBe(prefix)
      expect(decodeControl(encodeControl(value))).toEqual(value)
    }
    const writer = new MsgPackWriter()
    for (const length of [255, 256, 65535, 65536]) writer.binHeader(length)
    writer.binHeader(1, true)
    expect(hex(writer.finish())).toBe('c4ff' + 'c50100' + 'c5ffff' + 'c600010000' + 'c600000001')
  })
  it('follows JSON semantics for numbers and undefined', () => {
    expect(hex(encodeControl(-0))).toBe('00')
    expect(Object.is(decodeControl(bytes('cb 80 00 00 00 00 00 00 00')), 0)).toBe(true)
    expect(hex(encodeControl(1.5))).toBe('cb3ff8000000000000')
    expect(hex(encodeControl(2 ** 53))).toBe('cb4340000000000000')
    expect(decodeControl(encodeControl(Number.MAX_VALUE))).toBe(Number.MAX_VALUE)
    expect(decodeControl(encodeControl({ a: 1, b: undefined, c: null }))).toEqual({ a: 1, c: null })
    expect(hex(encodeControl({ b: undefined }))).toBe('80')
    expect(encodeCode([1, undefined])).toBe('UNDEFINED')
    expect(encodeCode(undefined)).toBe('UNDEFINED')
    expect(decodeControl(encodeControl(Object.assign(Object.create(null) as object, { a: 1 })))).toEqual({ a: 1 })
  })
  it('round-trips text exactly, including a leading BOM, and replaces lone surrogates like TextEncoder', () => {
    for (const value of ['', 'ascii', 'é', '日本語', '😀', '\u0000', '﻿bom', 'mixed ascii then é and 😀'.repeat(20)]) expect(decodeControl(encodeControl(value))).toBe(value)
    expect(decodeControl(encodeControl('a\uD800b'))).toBe('a�b')
    expect(decodeControl(encodeControl('\uDC00'))).toBe('�')
  })
  it('rejects values that are not JSON-shaped when encoding', () => {
    expect(encodeCode(Number.NaN)).toBe('NUMBER')
    expect(encodeCode(Number.POSITIVE_INFINITY)).toBe('NUMBER')
    expect(encodeCode(1n)).toBe('TYPE')
    expect(encodeCode(new Uint8Array(1))).toBe('TYPE')
    expect(encodeCode(new Date())).toBe('TYPE')
    expect(encodeCode(() => 1)).toBe('TYPE')
    expect(encodeCode(Symbol('s'))).toBe('TYPE')
    expect(encodeCode(JSON.parse('{"__proto__": 1}'))).toBe('KEY_FORBIDDEN')
    expect(encodeCode({ ['k'.repeat(129)]: 1 })).toBe('KEY_LENGTH')
    expect(encodeCode(Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`k${i}`, i])))).toBe('LIMIT')
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(encodeCode(cycle)).toBe('DEPTH')
    expect(encodeCode(JSON.parse('['.repeat(16) + ']'.repeat(16)))).toBeUndefined()
    expect(encodeCode(JSON.parse('['.repeat(17) + ']'.repeat(17)))).toBe('DEPTH')
  })
  it('rejects bin, ext, float32, NaN, duplicate and prototype keys, unsafe integers, bad UTF-8, and trailing bytes', () => {
    const cases: [string, string][] = [
      ['c4 00', 'TYPE'], ['c7 00 01', 'TYPE'], ['d4 01 00', 'TYPE'], ['ca 00 00 00 00', 'TYPE'], ['c1', 'TYPE'],
      ['cb 7f f8 00 00 00 00 00 01', 'NUMBER'], ['cf 00 20 00 00 00 00 00 00', 'NUMBER'], ['d3 ff e0 00 00 00 00 00 00', 'NUMBER'],
      ['82 a1 61 01 a1 61 02', 'KEY_DUPLICATE'], ['81 a9 5f 5f 70 72 6f 74 6f 5f 5f 01', 'KEY_FORBIDDEN'],
      ['a2 c1 bf', 'UTF8'], ['a3 ed b0 80', 'UTF8'], ['a3 e2 82 61', 'UTF8'], ['a3 f0 9f 98', 'UTF8'],
      ['01 02', 'TRAILING'], ['', 'TRUNCATED']
    ]
    for (const [input, code] of cases) expect(decodeCode(bytes(input)), input).toBe(code)
  })
  it('fails a depth bomb at 17 without recursing', () => {
    expect(decodeCode(new Uint8Array(16).fill(0x91).map((value, i) => i === 15 ? 0x90 : value))).toBeUndefined()
    expect(decodeCode(new Uint8Array(17).fill(0x91).map((value, i) => i === 16 ? 0x90 : value))).toBe('DEPTH')
    // A million nested arrays would overflow a recursive decoder's stack; this one stops at level 17.
    expect(decodeCode(new Uint8Array(1_000_000).fill(0x91))).toBe('DEPTH')
    expect(decodeCode(new Uint8Array(1_000_000).fill(0x81))).toBe('KEY_TYPE')
  })
  it('checks lengths against the remaining bytes before allocating', () => {
    expect(decodeCode(bytes('dd 00 10 00 00'))).toBe('TRUNCATED')
    expect(decodeCode(bytes('db ff ff ff ff'))).toBe('TRUNCATED')
    expect(decodeCode(bytes('df 00 00 10 00 a1 61 01'))).toBe('TRUNCATED')
    expect(decodeCode(bytes('dd ff ff ff ff'))).toBe('LIMIT')
    expect(decodeCode(bytes('df ff ff ff ff'))).toBe('LIMIT')
    const custom = { ...controlLimits, maxArrayLength: 2 }
    expect(() => decodeControl(bytes('93 01 02 03'), custom)).toThrow(DecodeError)
    expect(decodeControl(bytes('92 01 02'), custom)).toEqual([1, 2])
  })
  it('reports the offset of the offending value without echoing input bytes', () => {
    try {
      decodeControl(bytes('82 a1 61 01 a1 61 02'))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DecodeError)
      expect((error as DecodeError).offset).toBe(4)
      expect((error as DecodeError).message).toBe('MessagePack KEY_DUPLICATE at offset 4')
    }
  })
  it('reads page header fields leniently with the cursor', () => {
    const cursor = new MsgPackCursor(bytes('93 cd 00 05 d3 00 00 00 00 00 00 00 07 c4 02 aa bb'))
    expect(cursor.arrayHeader()).toBe(3)
    expect(cursor.uint()).toBe(5)
    expect(cursor.uint()).toBe(7)
    expect(cursor.binHeader()).toBe(2)
    expect(cursor.remaining).toBe(2)
    expect(() => new MsgPackCursor(bytes('ff')).uint()).toThrow(DecodeError)
    expect(() => new MsgPackCursor(bytes('c4 05 00')).binHeader()).toThrow(DecodeError)
  })
  it('produces exact-size buffers', () => {
    const encoded = encodeControl({ method: 'system.health', params: {} })
    expect(encoded.byteOffset).toBe(0)
    expect(encoded.buffer.byteLength).toBe(encoded.length)
  })
})
