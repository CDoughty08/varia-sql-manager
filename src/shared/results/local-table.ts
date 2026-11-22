// A local table: a small read-only table the renderer already holds (a Peek list, a Properties page's table), drawn by
// the results grid without becoming a backend result (docs/architecture.md, Grid). Its rows are display text, so nothing
// that is not on screen (a masked value's secret) can leave through Copy or Save. Copy and Save text is written by the
// TypeScript twin of ResultTextWriter (text-writer.ts) over a page built here, so it matches a results grid's byte for byte.
import type { ColumnView, PageView } from '../ipc/wire/pages.ts'
import { copyText, exportText, jsonKeyBytes, NO_COLUMN_NAME, type TextColumn, type TextFormat, type TextPart, type TextWriter } from './text-writer.ts'

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

/** A text's most bytes as JSON writes it: a control character's six-character escape, U+2028 and U+2029 likewise, a quote
 *  or backslash escaped, else UTF-8 (a surrogate half counted 3, so a pair 6 and a lone one its replacement's 3). */
function jsonBytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += code < 0x20 || code === 0x2028 || code === 0x2029 ? 6 : code === 0x22 || code === 0x5c ? 2 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
  }
  return bytes
}
/** A text's most bytes as CSV writes it, TSV's never more: a quote doubled, else UTF-8. */
function csvBytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); bytes += code === 0x22 ? 2 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3 }
  return bytes
}
/**
 * At least the bytes a save of the table writes in `format`, or in any format without one. JSON: per row its brackets
 * and line end, per cell its key as written (Column{n} for a blank name, _n for a repeated one) with its colon and comma
 * and its escaped text in quotes or null. CSV and TSV: the header line once (a blank name as "(No column name)"), per row
 * its line end, per cell a separator and its text quoted or NULL. Cheap and never under, so a save past `saveBytes` is
 * refused before its file is built.
 */
export function localSaveBytes(table: LocalTableData, format?: TextFormat): number {
  if (format === undefined) return Math.max(localSaveBytes(table, 'csv'), localSaveBytes(table, 'json'))
  const json = format === 'json', columns = table.columns.length
  const keys = json ? jsonKeyBytes(table.columns).map(key => key + 2) : table.columns.map(() => 1)
  let total = 16 + (json ? 0 : table.columns.reduce((sum, column) => sum + csvBytes(column.name || NO_COLUMN_NAME) + 3, 0))
  for (const row of table.rows) {
    total += 4
    for (let column = 0; column < columns; column++) { const cell = row[column] ?? ''; total += keys[column] + Math.max((json ? jsonBytes(cell) : csvBytes(cell)) + 2, 4) }
  }
  return total
}

/**
 * The table held to its bounds: at most 64 columns (names at most 128 characters), 10,000 rows, 4,000 characters a cell,
 * and 4 Mi characters in all, every row as wide as the columns (missing cells are NULL). `truncated` counts what was left
 * out: rows past the bounds, and cells cut.
 */
export function boundTable(data: LocalTableData): LocalTableData & { readonly truncatedRows: number; readonly droppedColumns: number; readonly cutCells: number; readonly cut: ReadonlySet<number> } {
  const columns = data.columns.slice(0, localTableLimits.columns).map(column => ({ ...column, name: column.name.slice(0, localTableLimits.nameChars) }))
  const rows: LocalCell[][] = []
  let chars = 0, cutCells = 0
  // The cells cut, by row * columns + column of the rows kept: drawn and read out as truncated.
  const cut = new Set<number>()
  for (const source of data.rows) {
    if (rows.length === localTableLimits.rows) break
    const row: LocalCell[] = []
    let rowChars = 0
    for (let column = 0; column < columns.length; column++) {
      const value = source[column] ?? null
      if (value !== null && value.length > localTableLimits.cellChars) { cutCells++; cut.add(rows.length * columns.length + column); row.push(value.slice(0, localTableLimits.cellChars)) } else row.push(value)
      rowChars += row[column]?.length ?? 0
    }
    if (chars + rowChars > localTableLimits.textChars) { for (let column = 0; column < columns.length; column++) if (cut.delete(rows.length * columns.length + column)) cutCells--; break }
    chars += rowChars
    rows.push(row)
  }
  return { columns, rows, truncatedRows: data.rows.length - rows.length, droppedColumns: Math.max(0, data.columns.length - columns.length), cutCells, cut }
}

const encoder = new TextEncoder()
/** The writer's columns: a number column is `decimal`, so JSON writes its values as numbers when they are numbers. */
export const textColumns = (columns: readonly LocalColumn[]): TextColumn[] => columns.map(column => ({ name: column.name, dataType: column.kind === 'number' ? 'decimal' : 'nvarchar', wire: 'text' }))

/** Build a page in the given display order, retaining the original column indexes when only selected cells are needed. */
export function localPage(table: LocalTableData, order?: readonly number[], first = 0, rows?: number, selected?: readonly number[]): PageView {
  const count = Math.max(0, Math.min(rows ?? Number.MAX_SAFE_INTEGER, (order?.length ?? table.rows.length) - first))
  let byteLength = 0, empty: ColumnView | undefined
  const wanted = selected && selected.length < table.columns.length ? new Set(selected) : undefined
  const columns = table.columns.map((_, column) => {
    if (wanted && !wanted.has(column)) return empty ??= { wire: 'text', validity: new Uint8Array(Math.ceil(count / 8)), offsets: new Uint32Array(count + 1), data: new Uint8Array(), truncated: undefined, errors: undefined }
    const parts: Uint8Array[] = [], offsets = new Uint32Array(count + 1), validity = new Uint8Array(Math.ceil(count / 8))
    let at = 0
    for (let index = 0; index < count; index++) {
      const value = table.rows[order ? order[first + index] : first + index][column] ?? null
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
  return { resultId: 0, firstRow: first, rowCount: count, columns, byteLength }
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
/**
 * Copy of a local table's selection, as a results grid copies (tab-separated, NULL as NULL, the platform's line breaks):
 * `parts` are the grid's copy plan in the rows as shown (`order` maps a shown row to the table's).
 */
/** A local copy stopped at its bound (`maxBytes`): parts that overlap copy their rows again, past what the table holds. */
export class LocalCopyTooLarge extends RangeError {}
export async function localCopyText(table: LocalTableData, parts: readonly TextPart[], o: { headers: boolean; crlf: boolean; order?: readonly number[]; maxBytes?: number; afterPage?: () => Promise<void> }): Promise<{ text: string; rows: number }> {
  let previous: { page: PageView; columns?: readonly number[] } | undefined
  const pageAt = (row: number, last = row, selected?: readonly number[]) => {
    const count = Math.min(localSavePageRows - row % localSavePageRows, last - row + 1)
    // Overlapping parts can reuse this projection. Retain only the most recent page while writing the clipboard text.
    if (previous && row >= previous.page.firstRow && row + count <= previous.page.firstRow + previous.page.rowCount) {
      const columns = previous.columns
      if (!columns || columns.length === table.columns.length || (selected?.length === columns.length && selected.every((column, i) => column === columns[i]))) return previous.page
    }
    const page = localPage(table, o.order, row, count, selected)
    previous = { page, columns: selected }
    return page
  }
  const maxBytes = o.maxBytes ?? Number.MAX_SAFE_INTEGER
  // After each page: past the bound the copy stops there, before it builds more.
  const afterPage = async (writer: TextWriter) => {
    if (writer.bytes > maxBytes) throw new LocalCopyTooLarge('The selection is too large to copy.')
    await o.afterPage?.()
  }
  const copied = await copyText({ columns: textColumns(table.columns), pageAt, available: o.order?.length ?? table.rows.length, parts, headers: o.headers, crlf: o.crlf }, afterPage)
  if (copied.bytes > maxBytes) throw new LocalCopyTooLarge('The selection is too large to copy.')
  return { text: decoder.decode(copied.text), rows: copied.rows }
}

/**
 * Copy of a whole local table, as a grid copies all of its cells: a list that is not a grid (a plan outline row, plan
 * properties, an editable grid's selected rows) formats its copy through the same writer.
 */
export async function localTableCopyText(table: LocalTableData, o: { headers: boolean; crlf: boolean }): Promise<string> {
  if (!table.columns.length || !table.rows.length) return ''
  return (await localCopyText(table, [{ rows: [[0, table.rows.length - 1]], columns: [[0, table.columns.length - 1]] }], o)).text
}

/** Save Results As of a whole local table in the rows' order, as a results grid saves (a BOM and CRLF for CSV and TSV). */
/** Rows, and cell characters, a save formats between yields: main stays responsive while it writes a large table. */
export const localSavePageRows = 512
export const localSavePageChars = 64 * 1024
/** The rows of the save page from `first`: up to `localSavePageRows`, ending once its text passes `localSavePageChars`. */
function savePageRows(table: LocalTableData, first: number): number {
  let rows = 0, chars = 0
  while (first + rows < table.rows.length && rows < localSavePageRows && chars < localSavePageChars) {
    for (const cell of table.rows[first + rows]) chars += cell?.length ?? 0
    rows++
  }
  return rows
}
export async function localExportBytes(table: LocalTableData, o: { format: TextFormat; headers: boolean; nullText: 'empty' | 'NULL' }, afterPage?: () => Promise<void>): Promise<{ data: Uint8Array; rows: number }> {
  // A page at a time, each built when the writer reaches it, with `afterPage` (main's yield) between them.
  let page: PageView | undefined
  // The writer asks for rows in order, each page from the first row the last one left.
  const pageAt = (row: number) => page && row >= page.firstRow && row < page.firstRow + page.rowCount ? page : page = localPage(table, undefined, row, savePageRows(table, row))
  const writer = await exportText({ columns: textColumns(table.columns), pageAt, rows: table.rows.length, format: o.format, headers: o.headers, nullText: o.nullText }, afterPage)
  return { data: writer.out.bytes(), rows: writer.rows }
}
