// A local table: a small read-only table the renderer already holds (a Peek list, a Properties page's table), drawn by
// the results grid without becoming a backend result (docs/architecture.md, Grid). Its rows are display text, so nothing
// that is not on screen (a masked value's secret) can leave through Copy or Save. Copy and Save text is written by the
// TypeScript twin of ResultTextWriter (text-writer.ts) over a page built here, so it matches a results grid's byte for byte.
import type { PageView } from '../ipc/wire/pages.ts'
import { copyText, exportText, jsonKeyBytes, NO_COLUMN_NAME, type TextColumn, type TextFormat, type TextPart } from './text-writer.ts'

/** How a column's values read: numbers right-align, sort by value and are numbers in JSON; the rest is text. */
export type LocalColumnKind = 'text' | 'number'
export interface LocalColumn { readonly name: string; readonly kind?: LocalColumnKind }
/** A cell's display text, or null for NULL. */
export type LocalCell = string | null
export interface LocalTableData { readonly columns: readonly LocalColumn[]; readonly rows: readonly (readonly LocalCell[])[] }

/** The bounds of one local table: past them the first rows are kept and the table says it is truncated. */
// `textChars` counts UTF-16 code units of cell text; `saveBytes` bounds a save's file, which UTF-8, quoting and JSON's
// keys make larger than its text (localSaveBytes).
export const localTableLimits = Object.freeze({ rows: 10_000, columns: 64, cellChars: 4_000, nameChars: 128, textChars: 4 * 1024 * 1024, saveBytes: 64 * 1024 * 1024 })

const utf8Bytes = (text: string) => { let bytes = 0; for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3 } return bytes }
/**
 * At least the bytes any save of the table writes, in any format: per cell its key as JSON writes it (Column{n} for a
 * blank name, _n for a repeated one) or its header as CSV quotes it, whichever is longer, a separator, and its text at
 * JSON's worst escape (a control character's six-character escape, 6 bytes a byte) or NULL's letters; per row its
 * brackets and line end; and the header line. Cheap and never under, so a save past `saveBytes` is refused before its
 * file is built.
 */
export function localSaveBytes(table: LocalTableData): number {
  const json = jsonKeyBytes(table.columns)
  const keys = table.columns.map((column, index) => Math.max(json[index], utf8Bytes(column.name || NO_COLUMN_NAME) * 2 + 2) + 2)
  let total = 16 + keys.reduce((sum, key) => sum + key, 0)
  for (const row of table.rows) {
    total += 4
    for (let column = 0; column < table.columns.length; column++) total += keys[column] + Math.max(utf8Bytes(row[column] ?? '') * 6 + 2, 4)
  }
  return total
}

/**
 * The table held to its bounds: at most 64 columns (names at most 128 characters), 10,000 rows, 4,000 characters a cell,
 * and 4 Mi characters in all, every row as wide as the columns (missing cells are NULL). `truncated` counts what was left
 * out: rows past the bounds, and cells cut.
 */
export function boundTable(data: LocalTableData): LocalTableData & { readonly truncatedRows: number; readonly cutCells: number } {
  const columns = data.columns.slice(0, localTableLimits.columns).map(column => ({ ...column, name: column.name.slice(0, localTableLimits.nameChars) }))
  const rows: LocalCell[][] = []
  let chars = 0, cutCells = 0
  for (const source of data.rows) {
    if (rows.length === localTableLimits.rows) break
    const row: LocalCell[] = []
    let rowChars = 0
    for (let column = 0; column < columns.length; column++) {
      const value = source[column] ?? null
      if (value !== null && value.length > localTableLimits.cellChars) { cutCells++; row.push(value.slice(0, localTableLimits.cellChars)) } else row.push(value)
      rowChars += row[column]?.length ?? 0
    }
    if (chars + rowChars > localTableLimits.textChars) break
    chars += rowChars
    rows.push(row)
  }
  return { columns, rows, truncatedRows: data.rows.length - rows.length, cutCells }
}

const encoder = new TextEncoder()
/** The writer's columns: a number column is `decimal`, so JSON writes its values as numbers when they are numbers. */
export const textColumns = (columns: readonly LocalColumn[]): TextColumn[] => columns.map(column => ({ name: column.name, dataType: column.kind === 'number' ? 'decimal' : 'nvarchar', wire: 'text' }))

/** One page over every row, as a decoded result page holds them (pages.ts ColumnView), in the order given. */
export function localPage(table: LocalTableData, order?: readonly number[]): PageView {
  const count = order?.length ?? table.rows.length
  let byteLength = 0
  const columns = table.columns.map((_, column) => {
    const parts: Uint8Array[] = [], offsets = new Uint32Array(count + 1), validity = new Uint8Array(Math.ceil(count / 8))
    let at = 0
    for (let index = 0; index < count; index++) {
      const value = table.rows[order ? order[index] : index][column] ?? null
      if (value !== null) {
        validity[index >>> 3] |= 1 << (index & 7)
        const data = encoder.encode(value)
        parts.push(data)
        at += data.length
      }
      offsets[index + 1] = at
    }
    const data = new Uint8Array(at)
    let offset = 0
    for (const part of parts) { data.set(part, offset); offset += part.length }
    byteLength += at
    return { wire: 'text' as const, validity, offsets, data, truncated: undefined, errors: undefined }
  })
  return { resultId: 0, firstRow: 0, rowCount: count, columns, byteLength }
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
/**
 * Copy of a local table's selection, as a results grid copies (tab-separated, NULL as NULL, the platform's line breaks):
 * `parts` are the grid's copy plan in the rows as shown (`order` maps a shown row to the table's).
 */
export async function localCopyText(table: LocalTableData, parts: readonly TextPart[], o: { headers: boolean; crlf: boolean; order?: readonly number[] }): Promise<{ text: string; rows: number }> {
  const page = localPage(table, o.order)
  const copied = await copyText({ columns: textColumns(table.columns), pageAt: () => page, available: page.rowCount, parts, headers: o.headers, crlf: o.crlf })
  return { text: decoder.decode(copied.text), rows: copied.rows }
}

/** Save Results As of a whole local table in the rows' order, as a results grid saves (a BOM and CRLF for CSV and TSV). */
export async function localExportBytes(table: LocalTableData, o: { format: TextFormat; headers: boolean; nullText: 'empty' | 'NULL' }): Promise<{ data: Uint8Array; rows: number }> {
  const page = localPage(table)
  const writer = await exportText({ columns: textColumns(table.columns), pageAt: () => page, rows: page.rowCount, format: o.format, headers: o.headers, nullText: o.nullText })
  return { data: writer.out.bytes(), rows: writer.rows }
}
