import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { decodePage, encodePage, type PageCell, type PageView, type WireKind } from '../src/shared/ipc/wire/pages'
// @ts-expect-error The fake backend's modules are plain JavaScript without declarations.
import { copyText, exportText, resolvePart, validTurn, MAX_SAFE, MAX_TRANSPOSED_ROWS } from './fixtures/backend/text-writer.mjs'
import { limits } from '../src/shared/ipc/wire/protocol'

// The same goldens the C# ResultTextWriter is checked against (Varia.Backend.Tests/TextChecks.cs), so the fake backend's
// Copy and Save Results As text matches the real one byte for byte.
interface Column { name: string; dataType: string; wire: WireKind }
type FixtureCell = string | null | { error: true } | { text: string; truncated: true } | { hex: string; truncated?: true }
interface Turned { transposed?: true; headerColumn?: number; capped?: number }
interface CopyCase extends Turned { name: string; headers: boolean; eol: 'crlf' | 'lf'; parts: { rows: number[][]; columns: number[][] }[]; expected: string; rows: number; truncatedCells: number }
interface SaveCase extends Turned { format: 'csv' | 'tsv' | 'json'; headers: boolean; nullText: 'empty' | 'NULL'; expected: string; rows: number; truncatedCells: number }
interface Case { name: string; columns: Column[]; rows: FixtureCell[][]; copy: CopyCase[]; save: SaveCase[] }
const fixture = JSON.parse(readFileSync('tests/fixtures/results-text/cases.json', 'utf8')) as { cases: Case[] }

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16))
function cell(value: FixtureCell): PageCell {
  if (value === null || typeof value === 'string') return value
  if ('error' in value) return { error: true }
  if ('hex' in value) return value.truncated ? { value: fromHex(value.hex), truncated: true } : fromHex(value.hex)
  return { value: value.text, truncated: true }
}
/** Pages of two rows each, so the writer crosses page boundaries as the C# checks do. */
function pages(item: Case): (row: number) => PageView & { firstRow: number } {
  const decoded: PageView[] = []
  for (let first = 0; first < item.rows.length; first += 2)
    decoded.push(decodePage(encodePage({ resultId: 1, firstRow: first, columns: item.columns, rows: item.rows.slice(first, first + 2).map(row => row.map(cell)) }), item.columns))
  return row => decoded.find(page => row >= page.firstRow && row < page.firstRow + page.rowCount)!
}
const utf8 = (text: string) => new TextEncoder().encode(text)
const shown = (data: Uint8Array) => JSON.stringify(new TextDecoder('utf-8', { ignoreBOM: true }).decode(data))

describe('fake backend Copy and Save text', () => {
  for (const item of fixture.cases) {
    for (const copy of item.copy) {
      it(`copies ${item.name.split(':')[0]}: ${copy.name}`, async () => {
        const result = await copyText({ columns: item.columns, pageAt: pages(item), available: item.rows.length, parts: copy.parts, headers: copy.headers, crlf: copy.eol === 'crlf', transposed: copy.transposed, headerColumn: copy.headerColumn })
        expect(shown(result.text)).toBe(shown(utf8(copy.expected)))
        expect({ rows: result.rows, truncatedCells: result.truncatedCells, bytes: result.bytes, capped: result.capped }).toEqual({ rows: copy.rows, truncatedCells: copy.truncatedCells, bytes: utf8(copy.expected).length, capped: copy.capped ?? 0 })
      })
    }
    for (const save of item.save) {
      it(`saves ${item.name.split(':')[0]} as ${save.format} (headers ${save.headers}, NULL ${save.nullText}${save.transposed ? `, transposed${save.headerColumn === undefined ? '' : ` with header column ${save.headerColumn}`}` : ''})`, async () => {
        const writer = await exportText({ columns: item.columns, pageAt: pages(item), rows: item.rows.length, format: save.format, headers: save.headers, nullText: save.nullText, transposed: save.transposed, headerColumn: save.headerColumn })
        expect(shown(writer.out.bytes())).toBe(shown(utf8(save.expected)))
        expect({ rows: writer.rows, truncatedCells: writer.truncatedCells, capped: writer.capped }).toEqual({ rows: save.rows, truncatedCells: save.truncatedCells, capped: save.capped ?? 0 })
      })
    }
  }
  it('writes the rows a transposed grid draws and counts the rest as capped', async () => {
    expect(MAX_TRANSPOSED_ROWS).toBe(limits.transpose.maxRows)
    const columns: Column[] = [{ name: 'n', dataType: 'int', wire: 'text' }], count = MAX_TRANSPOSED_ROWS + 5
    const decoded = Array.from({ length: Math.ceil(count / 1000) }, (_, at) => decodePage(encodePage({ resultId: 1, firstRow: at * 1000, columns, rows: Array.from({ length: Math.min(1000, count - at * 1000) }, (_, row) => [String(at * 1000 + row)]) }), columns))
    const pageAt = (row: number) => decoded[Math.floor(row / 1000)]
    const all = await copyText({ columns, pageAt, available: count, parts: [{ rows: [[0, MAX_SAFE]], columns: [[0, 0]] }], headers: false, crlf: false, transposed: true })
    const fields = new TextDecoder().decode(all.text).split('\t')
    expect({ rows: all.rows, capped: all.capped, fields: fields.length, last: fields.at(-1) }).toEqual({ rows: MAX_TRANSPOSED_ROWS, capped: 5, fields: MAX_TRANSPOSED_ROWS, last: String(MAX_TRANSPOSED_ROWS - 1) })
    // A block that straddles the cap keeps its drawn rows; one wholly past it writes nothing.
    const straddling = await copyText({ columns, pageAt, available: count, parts: [{ rows: [[MAX_TRANSPOSED_ROWS - 2, MAX_TRANSPOSED_ROWS + 1]], columns: [[0, 0]] }, { rows: [[MAX_TRANSPOSED_ROWS + 2, MAX_TRANSPOSED_ROWS + 3]], columns: [[0, 0]] }], headers: false, crlf: false, transposed: true })
    expect({ text: new TextDecoder().decode(straddling.text), rows: straddling.rows, capped: straddling.capped }).toEqual({ text: `${MAX_TRANSPOSED_ROWS - 2}\t${MAX_TRANSPOSED_ROWS - 1}`, rows: 2, capped: 4 })
    const saved = await exportText({ columns, pageAt, rows: count, format: 'csv', headers: true, nullText: 'empty', transposed: true })
    expect({ rows: saved.rows, capped: saved.capped, lines: saved.columnsWritten }).toEqual({ rows: MAX_TRANSPOSED_ROWS, capped: 5, lines: 1 })
  })
  it('takes a header column only with transposed, and only a column of the result', () => {
    expect([validTurn(undefined, undefined, 2), validTurn(true, undefined, 2), validTurn(true, 1, 2), validTurn(false, undefined, 2)]).toEqual([true, true, true, true])
    expect([validTurn(undefined, 0, 2), validTurn(false, 0, 2), validTurn(true, 2, 2), validTurn(true, -1, 2), validTurn(true, 0.5, 2), validTurn('yes', undefined, 2)]).toEqual([false, false, false, false, false, false])
  })
  it('validates parts as the backend does and clamps open-ended rows', () => {
    expect(resolvePart({ rows: [[0, MAX_SAFE]], columns: [[0, 1]] }, 2, 5)).toEqual({ rows: [[0, 4]], columns: [0, 1] })
    expect(resolvePart({ rows: [[3, 4], [10, 12]], columns: [[1, 1]] }, 2, 5)).toEqual({ rows: [[3, 4]], columns: [1] })
    for (const part of [{ rows: [], columns: [[0, 0]] }, { rows: [[2, 1]], columns: [[0, 0]] }, { rows: [[0, 3], [3, 4]], columns: [[0, 0]] }, { rows: [[0, 1]], columns: [[0, 2]] }, { rows: [[0, MAX_SAFE + 1]], columns: [[0, 0]] }])
      expect(resolvePart(part, 2, 5), JSON.stringify(part)).toBeUndefined()
  })
})
