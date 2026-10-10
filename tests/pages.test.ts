import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PageFormatError, decodePage, encodePage, type PageCell, type PageView, type WireKind } from '../src/shared/ipc/wire/pages.ts'
import { CELL_ERROR, CELL_NULL, CELL_TRUNCATED, cellFlags, cellText, hex, runText, textRun, utf8Prefix } from '../src/shared/ipc/wire/cells.ts'
import { fuzzIterations, fuzzSeed, mulberry32, mutate } from './fuzz/prng.ts'

interface Golden { resultId: number; firstRow: number; columns: { name: string; dataType: string; wire: WireKind }[]; rows: [string | null, number][][] }
const golden = ['w1', 'n1', 'b1', 'wide'].map(name => ({
  name,
  page: new Uint8Array(readFileSync(`tests/fixtures/pages/${name}.page`)),
  expected: JSON.parse(readFileSync(`tests/fixtures/pages/${name}.json`, 'utf8')) as Golden
}))
const display = (body: Uint8Array | ArrayBuffer, wires: readonly WireKind[], maxChars?: number): [string | null, number][][] => {
  const view = decodePage(body, wires.map(wire => ({ wire })))
  return Array.from({ length: view.rowCount }, (_, row) => wires.map((_, column) => {
    const flags = cellFlags(view, column, row)
    if (flags & CELL_NULL) return [null, flags]
    const cell = cellText(view, column, row, maxChars)
    return [cell.text, flags | (cell.truncated ? CELL_TRUNCATED : 0)]
  }))
}
/** The encodePage input for a golden page's display JSON. */
const cellsOf = (expected: Golden): PageCell[][] => expected.rows.map(row => row.map(([text, flags], column): PageCell => {
  if (flags & CELL_ERROR) return { error: true }
  if (text === null) return null
  const value = expected.columns[column].wire === 'binary' ? new Uint8Array(Buffer.from(text.slice(2), 'hex')) : text
  return flags & CELL_TRUNCATED ? { value, truncated: true } : value
}))

describe('result pages', () => {
  it.each(golden.map(item => [item.name, item] as const))('decodes the .NET golden page %s to its display JSON', (_, { page, expected }) => {
    const wires = expected.columns.map(column => column.wire)
    const view = decodePage(page, expected.columns)
    expect({ resultId: view.resultId, firstRow: view.firstRow, rowCount: view.rowCount }).toEqual({ resultId: expected.resultId, firstRow: expected.firstRow, rowCount: expected.rows.length })
    expect(display(page, wires)).toEqual(expected.rows)
  })
  it.each(golden.map(item => [item.name, item] as const))('encodes golden page %s byte for byte like the .NET PageBuilder', (_, { page, expected }) => {
    const encoded = encodePage({ resultId: expected.resultId, firstRow: expected.firstRow, columns: expected.columns, rows: cellsOf(expected) })
    expect(Buffer.from(encoded).toString('hex')).toBe(Buffer.from(page).toString('hex'))
  })
  it('views the received buffer in place and copies only a misaligned view', () => {
    const { page, expected } = golden[0]
    const buffer = page.slice().buffer
    const view = decodePage(buffer, expected.columns)
    expect(view.columns.every(column => column.offsets.buffer === buffer && column.data.buffer === buffer)).toBe(true)
    expect(view.columns[0].offsets.byteOffset % 8).toBe(0)
    const shifted = new Uint8Array(page.length + 3)
    shifted.set(page, 3)
    expect(display(shifted.subarray(3), expected.columns.map(column => column.wire))).toEqual(expected.rows)
    const pooled = Buffer.concat([Buffer.alloc(3), Buffer.from(page)]).subarray(3)
    expect(display(pooled, expected.columns.map(column => column.wire))).toEqual(expected.rows)
  })
  it('aligns the data blob and every region whatever the header size', () => {
    for (let rows = 1; rows <= 20; rows++) {
      for (const resultId of [1, 200, 70_000, 2 ** 32 - 1]) {
        const page = encodePage({ resultId, firstRow: rows * 1_000_003, columns: [{ wire: 'text' }, { wire: 'binary' }], rows: Array.from({ length: rows }, (_, i) => [i % 3 === 0 ? null : 'x'.repeat(i), new Uint8Array(i)]) })
        const view = decodePage(page, [{ wire: 'text' }, { wire: 'binary' }])
        expect(view.rowCount).toBe(rows)
        for (const column of view.columns) {
          expect(column.offsets.byteOffset % 8).toBe(0)
          expect(column.validity === undefined || column.validity.length === Math.ceil(rows / 8)).toBe(true)
        }
      }
    }
  })
  it('checks bounds against the result descriptor and the page limits', () => {
    const page = encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'text' }], rows: [['a']] })
    const code = (action: () => unknown): string | undefined => { try { action() } catch (error) { if (error instanceof PageFormatError) return error.code; throw error } return undefined }
    expect(code(() => decodePage(page, [{ wire: 'binary' }]))).toBe('WIRE')
    expect(code(() => decodePage(page, [{ wire: 'text' }, { wire: 'text' }]))).toBe('COLUMNS')
    expect(code(() => decodePage(page, []))).toBe('COLUMNS')
    const many = encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'text' }], rows: Array.from({ length: 10 }, () => ['a']) })
    expect(code(() => decodePage(many, [{ wire: 'text' }], { maxRows: 9, maxColumns: 4096 }))).toBe('ROWS')
    expect(code(() => decodePage(new Uint8Array(0), [{ wire: 'text' }]))).toBe('HEADER')
    expect(() => encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'text' }], rows: [] })).toThrow(RangeError)
    expect(() => encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'text' }], rows: [[new Uint8Array(1)]] })).toThrow(RangeError)
    expect(() => encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'text' }], rows: [['a', 'b']] })).toThrow(RangeError)
  })
  it('shows binary cells as uppercase hex, capped at the display limit', () => {
    const page = encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'binary' }], rows: [[new Uint8Array([0x00, 0xab, 0xff, 0x10])], [{ value: new Uint8Array([1]), truncated: true }]] })
    const view = decodePage(page, [{ wire: 'binary' }])
    expect(cellText(view, 0, 0)).toEqual({ text: '0x00ABFF10', truncated: false })
    expect(cellText(view, 0, 0, 10)).toEqual({ text: '0x00ABFF10', truncated: false })
    expect(cellText(view, 0, 0, 9)).toEqual({ text: '0x00ABFF', truncated: true })
    expect(cellText(view, 0, 0, 1)).toEqual({ text: '0x', truncated: true })
    expect(cellText(view, 0, 1)).toEqual({ text: '0x01', truncated: true })
    expect(hex(new Uint8Array(256).map((_, i) => i))).toBe(Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(''))
  })
  it('caps text without splitting surrogate pairs and replaces invalid UTF-8', () => {
    const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
    expect(utf8Prefix(utf8('abc'), 3)).toEqual({ text: 'abc', truncated: false })
    expect(utf8Prefix(utf8('abcd'), 3)).toEqual({ text: 'abc', truncated: true })
    expect(utf8Prefix(utf8('ab😀'), 3)).toEqual({ text: 'ab', truncated: true })
    expect(utf8Prefix(utf8('ab😀'), 4)).toEqual({ text: 'ab😀', truncated: false })
    expect(utf8Prefix(utf8('😀😀😀'), 5)).toEqual({ text: '😀😀', truncated: true })
    expect(utf8Prefix(utf8('€€€'), 3)).toEqual({ text: '€€€', truncated: false })
    expect(utf8Prefix(utf8('€€€€'), 3)).toEqual({ text: '€€€', truncated: true })
    expect(utf8Prefix(utf8('﻿x'), 10)).toEqual({ text: '﻿x', truncated: false })
    expect(utf8Prefix(new Uint8Array([0x61, 0xff, 0x62]), 10)).toEqual({ text: 'a�b', truncated: false })
    expect(utf8Prefix(new Uint8Array([0xe2, 0x82]), 10)).toEqual({ text: '�', truncated: false })
    // Every prefix of mixed-width text agrees with the full decode.
    const text = 'aé€😀'.repeat(50)
    for (let cap = 0; cap <= text.length + 2; cap++) {
      const prefix = utf8Prefix(utf8(text), cap)
      expect(text.startsWith(prefix.text)).toBe(true)
      expect(prefix.text.length === cap || prefix.text.length === cap - 1 || !prefix.truncated).toBe(true)
      expect(prefix.truncated).toBe(cap < text.length)
    }
  })
  it('reads only the requested cells and flags truncation from both the backend and the display cap', () => {
    const page = encodePage({ resultId: 1, firstRow: 0, columns: [{ wire: 'text' }], rows: [['x'.repeat(5000)], [{ value: 'short', truncated: true }], [null], [{ error: true }]] })
    expect(display(page, ['text'], 1024)).toEqual([[['x'.repeat(1024), CELL_TRUNCATED]], [['short', CELL_TRUNCATED]], [[null, CELL_NULL]], [[null, CELL_NULL | CELL_ERROR]]])
  })
  it('throws only PageFormatError for mutated pages, and decoded mutants stay readable', () => {
    const seed = fuzzSeed()
    const random = mulberry32(seed)
    const corpus = golden.map(item => ({ page: item.page, columns: item.expected.columns }))
    const iterations = fuzzIterations(5000)
    let decoded = 0
    for (let i = 0; i < iterations; i++) {
      const { page, columns } = corpus[i % corpus.length]
      const input = mutate(random, page)
      try {
        const view = decodePage(input, columns)
        for (let row = 0; row < view.rowCount; row++) for (let column = 0; column < columns.length; column++) { cellFlags(view, column, row); cellText(view, column, row, 64) }
        decoded++
      } catch (error) {
        if (!(error instanceof PageFormatError)) throw new Error(`Seed ${seed}, iteration ${i}: ${String(error)}`)
      }
    }
    // Byte flips inside cell data leave a page valid, so some mutants must decode.
    expect(decoded, `seed ${seed}`).toBeGreaterThan(0)
  }, Math.max(20_000, 2 * fuzzIterations(5000)))
})

describe('text runs', () => {
  /** A one-column page view over raw cell bytes, which may be any byte sequence (encodePage writes only valid UTF-8). */
  function view(cells: readonly (readonly number[])[], wire: WireKind = 'text', truncated?: Uint8Array): PageView {
    const offsets = new Uint32Array(cells.length + 1)
    cells.forEach((cell, row) => { offsets[row + 1] = offsets[row] + cell.length })
    return { resultId: 1, firstRow: 0, rowCount: cells.length, byteLength: 0, columns: [{ wire, validity: undefined, offsets, data: Uint8Array.from(cells.flat()), truncated, errors: undefined }] }
  }
  const bytes = (text: string) => [...new TextEncoder().encode(text)]

  it('cover only text whose every byte decodes to one unit, so no character spans two cells', () => {
    expect(textRun(view([bytes('ab'), [], bytes('c')]), 0, 0, 3)).toEqual({ text: 'abc', start: 0 })
    expect(textRun(view([bytes('ab'), bytes('cd')]), 0, 1, 2)).toEqual({ text: 'cd', start: 2 })
    // A lone invalid byte is one U+FFFD either way; a character split across cells would decode differently.
    expect(textRun(view([[0x41, 0xff], [0xc3], [0x41]]), 0, 0, 3)?.text).toBe('A\uFFFD\uFFFDA')
    expect(textRun(view([[0x41, 0xc3], [0xa9]]), 0, 0, 2)).toBeUndefined()
    expect(textRun(view([bytes('é')]), 0, 0, 1)).toBeUndefined()
    expect(textRun(view([bytes('\uFEFFbom')]), 0, 0, 1)).toBeUndefined()
    expect(textRun(view([[1, 2]], 'binary'), 0, 0, 1)).toBeUndefined()
    expect(textRun(view([bytes('a')]), 0, 1, 1)).toBeUndefined()
  })

  it('give exactly the text and truncation of cellText for every cell and cap', () => {
    const seed = fuzzSeed()
    const random = mulberry32(seed)
    const ascii = [[0x41], [0x7a], [0x00], [0x20]]
    const other = [[0xc3, 0xa9], [0xe6, 0x97, 0xa5], [0xf0, 0x9f, 0x98, 0x80], [0xef, 0xbb, 0xbf], [0x80], [0xbf], [0xc3], [0xe6, 0x97], [0xff], [0xed, 0xa0, 0x80]]
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
    let runs = 0
    for (let iteration = 0; iteration < fuzzIterations(3000); iteration++) {
      const rows = 1 + Math.floor(random() * 12)
      const mixed = random() < 0.5
      const cells = Array.from({ length: rows }, () => Array.from({ length: Math.floor(random() * 7) }, () => pick(mixed && random() < 0.2 ? other : ascii)).flat())
      const truncated = new Uint8Array(Math.ceil(rows / 8))
      for (let row = 0; row < rows; row++) if (random() < 0.2) truncated[row >>> 3] |= 1 << (row & 7)
      const page = view(cells, 'text', truncated)
      const from = Math.floor(random() * rows), to = from + 1 + Math.floor(random() * (rows - from))
      const run = textRun(page, 0, from, to)
      if (!run) continue
      runs++
      for (let row = from; row < to; row++) {
        for (const cap of [Number.POSITIVE_INFINITY, 0, 1, 2, 3, 5]) expect(runText(run, page, 0, row, cap), `seed ${seed}, row ${row}, cap ${cap}`).toEqual(cellText(page, 0, row, cap))
      }
    }
    expect(runs, `seed ${seed}`).toBeGreaterThan(fuzzIterations(3000) / 4)
  })
})
