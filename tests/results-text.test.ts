import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { decodePage, encodePage, type PageCell, type PageView, type WireKind } from '../src/shared/ipc/wire/pages'
// @ts-expect-error The fake backend's modules are plain JavaScript without declarations.
import { copyText, exportText, resolvePart, MAX_SAFE } from './fixtures/backend/text-writer.mjs'

// The same goldens the C# ResultTextWriter is checked against (Varia.Backend.Tests/TextChecks.cs), so the fake backend's
// Copy and Save Results As text matches the real one byte for byte.
interface Column { name: string; dataType: string; wire: WireKind }
type FixtureCell = string | null | { error: true } | { text: string; truncated: true } | { hex: string; truncated?: true }
interface CopyCase { name: string; headers: boolean; eol: 'crlf' | 'lf'; parts: { rows: number[][]; columns: number[][] }[]; expected: string; rows: number; truncatedCells: number }
interface SaveCase { format: 'csv' | 'tsv' | 'json'; headers: boolean; nullText: 'empty' | 'NULL'; expected: string; rows: number; truncatedCells: number }
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
        const result = await copyText({ columns: item.columns, pageAt: pages(item), available: item.rows.length, parts: copy.parts, headers: copy.headers, crlf: copy.eol === 'crlf' })
        expect(shown(result.text)).toBe(shown(utf8(copy.expected)))
        expect({ rows: result.rows, truncatedCells: result.truncatedCells, bytes: result.bytes }).toEqual({ rows: copy.rows, truncatedCells: copy.truncatedCells, bytes: utf8(copy.expected).length })
      })
    }
    for (const save of item.save) {
      it(`saves ${item.name.split(':')[0]} as ${save.format} (headers ${save.headers}, NULL ${save.nullText})`, async () => {
        const writer = await exportText({ columns: item.columns, pageAt: pages(item), rows: item.rows.length, format: save.format, headers: save.headers, nullText: save.nullText })
        expect(shown(writer.out.bytes())).toBe(shown(utf8(save.expected)))
        expect({ rows: writer.rows, truncatedCells: writer.truncatedCells }).toEqual({ rows: save.rows, truncatedCells: save.truncatedCells })
      })
    }
  }
  it('validates parts as the backend does and clamps open-ended rows', () => {
    expect(resolvePart({ rows: [[0, MAX_SAFE]], columns: [[0, 1]] }, 2, 5)).toEqual({ rows: [[0, 4]], columns: [0, 1] })
    expect(resolvePart({ rows: [[3, 4], [10, 12]], columns: [[1, 1]] }, 2, 5)).toEqual({ rows: [[3, 4]], columns: [1] })
    for (const part of [{ rows: [], columns: [[0, 0]] }, { rows: [[2, 1]], columns: [[0, 0]] }, { rows: [[0, 3], [3, 4]], columns: [[0, 0]] }, { rows: [[0, 1]], columns: [[0, 2]] }, { rows: [[0, MAX_SAFE + 1]], columns: [[0, 0]] }])
      expect(resolvePart(part, 2, 5), JSON.stringify(part)).toBeUndefined()
  })
})
