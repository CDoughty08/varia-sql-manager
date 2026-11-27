// Copy and Save Results As text in TypeScript: the twin of the C# ResultTextWriter, held to the same goldens
// (tests/fixtures/results-text/cases.json, checked by tests/results-text.test.ts and Varia.Backend.Tests/TextChecks.cs),
// so the two write byte-identical text. Local tables (src/shared/results/local-table.ts) and the fake backend
// (tests/fixtures/backend.mjs) write through it; query results are written by the C# writer, where their rows are. It
// reads decoded pages (src/shared/ipc/wire/pages.ts) and works on UTF-8 bytes, as the C# writer does. Plain erasable
// TypeScript, so Node runs it unbuilt.
import type { ColumnView, PageView, WireKind } from '../ipc/wire/pages.ts'
import { sortKindOf, type SortKind } from './sort-kind.ts'

export const MAX_SAFE = Number.MAX_SAFE_INTEGER
export const NO_COLUMN_NAME = '(No column name)'
/** Source rows a transposed copy or save writes: those a transposed grid draws (limits.transpose.maxRows). */
export const MAX_TRANSPOSED_ROWS = 4095
const NAME_FIELD = 'Column'
const FIELD_NAME_CHARS = 128
const encoder = new TextEncoder()
const bytes = (text: string): Uint8Array => encoder.encode(text)
const literals = new Map<string, Uint8Array>()
/** A literal's bytes, encoded once: quotes, separators and escapes are written per cell, some per byte. */
const literal = (text: string): Uint8Array => { let encoded = literals.get(text); if (!encoded) literals.set(text, encoded = encoder.encode(text)); return encoded }
const numberKinds = new Set<SortKind>(['integer', 'decimal', 'float'])
const jsonNumber = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
// A JSON number keeps its digits through a double (how most readers parse one) at 15 significant digits or fewer, provided it stays finite.
const keepsValue = (text: string) => Number.isFinite(Number(text)) && text.split(/[eE]/)[0].replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '').length <= 15
const hexDigits = bytes('0123456789ABCDEF')
const B = { tab: 9, lf: 10, cr: 13, quote: 34, comma: 44, backslash: 92 } as const

export type TextFormat = 'tsv' | 'csv' | 'json'
export interface TextOptions {
  readonly format: TextFormat
  readonly headers: boolean
  readonly nullAsEmpty: boolean
  readonly crlf: boolean
  readonly trailingEol: boolean
  readonly bom: boolean
  readonly clipboard?: boolean
}
/** A column as the writer needs it: its name, its SQL type (numbers and bits are typed in JSON) and how its cells travel. */
export interface TextColumn { readonly name: string; readonly dataType: string; readonly wire: WireKind; readonly role?: string; readonly sortKind?: SortKind }
/** Inclusive [first, last] ranges of rows and of columns. */
export interface TextPart { readonly rows: readonly (readonly [number, number])[]; readonly columns: readonly (readonly [number, number])[] }
export interface ResolvedPart { readonly rows: readonly (readonly [number, number])[]; readonly columns: readonly number[] }
/** The decoded page containing a row. Row-wise writers also supply the end of the range and its selected columns. */
export type PageAt = (row: number, last?: number, selected?: readonly number[]) => PageView

/** Copy: tab-separated, NULL as NULL, the platform's end of line between lines and none after the last, NUL as a space. */
export const copyOptions = (headers: boolean, crlf: boolean): TextOptions => ({ format: 'tsv', headers, nullAsEmpty: false, crlf, trailingEol: false, bom: false, clipboard: true })
/** Save: CSV and TSV with a BOM and CRLF after every line; JSON with LF, no BOM and no header. */
export const exportOptions = (format: TextFormat, headers: boolean, nullText: 'empty' | 'NULL'): TextOptions => ({ format, headers: headers && format !== 'json', nullAsEmpty: nullText === 'empty', crlf: format !== 'json', trailingEol: true, bom: format !== 'json' })

/** A growing list of 1 MiB chunks, so large output never needs one huge buffer. */
export class ChunkedBytes {
  readonly size: number
  length = 0
  private full: Uint8Array[] = []
  private chunk: Uint8Array
  private used = 0
  constructor(size = 1024 * 1024) { this.size = size; this.chunk = new Uint8Array(size) }
  write(data: Uint8Array): void {
    const len = data.length
    if (len === 0) return
    if (len <= this.size - this.used) {
      this.chunk.set(data, this.used)
      this.used += len
      this.length += len
      return
    }
    let offset = 0
    while (offset < len) {
      if (this.used === this.size) this.seal()
      const count = Math.min(this.size - this.used, len - offset)
      this.chunk.set(data.subarray(offset, offset + count), this.used)
      this.used += count
      offset += count
    }
    this.length += len
  }
  seal(): void {
    if (this.used === 0) return
    this.full.push(this.used === this.size ? this.chunk : this.chunk.slice(0, this.used))
    this.chunk = new Uint8Array(this.size)
    this.used = 0
  }
  /** Sealed chunks, oldest first; each is taken once. */
  take(): Uint8Array[] { return this.full.splice(0) }
  /** Everything written, as one array. */
  bytes(): Uint8Array {
    this.seal()
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.full) { out.set(chunk, at); at += chunk.length }
    return out
  }
}

type CellKind = 'binary' | 'bit' | 'number' | 'text'
function kind(column: TextColumn): CellKind {
  if (column.wire === 'binary') return 'binary'
  const sort = sortKindOf(column)
  return sort === 'boolean' ? 'bit' : numberKinds.has(sort) ? 'number' : 'text'
}

/** `name`, or with _2, _3 and so on when it is already used. */
function unique(used: Set<string>, name: string, next = new Map<string, number>()): string {
  if (!used.has(name)) { used.add(name); return name }
  // Each repeated name goes on from its last suffix: a header column of few values repeats one thousands of times.
  let n = next.get(name) ?? 2, key
  do key = `${name}_${n++}`
  while (used.has(key))
  used.add(key)
  next.set(name, n)
  return key
}
function jsonKey(key: string): Uint8Array {
  const out = new ChunkedBytes(64 * 1024)
  jsonString(out, bytes(key))
  return out.bytes()
}
/** JSON keys: a blank name becomes Column{ordinal}; a repeated one gets _2, _3 and so on. */
function jsonKeys(columns: readonly Pick<TextColumn, 'name'>[]): Uint8Array[] {
  const used = new Set<string>(), next = new Map<string, number>()
  return columns.map((column, index) => jsonKey(unique(used, column.name === '' ? `Column${index + 1}` : column.name, next)))
}
/** The bytes of each column's JSON key as a save writes it (quoted and escaped, Column{n} or _n as needed). */
export function jsonKeyBytes(columns: readonly Pick<TextColumn, 'name'>[]): number[] { return jsonKeys(columns).map(key => key.length) }

function bit(bitmap: Uint8Array | undefined, row: number): boolean { return bitmap !== undefined && (bitmap[row >>> 3] & (1 << (row & 7))) !== 0 }

const fieldDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
/** A source row's field name from a header column's value, as a transposed grid's header shows it: NULL, (blank), binary
 *  as 0x hex, and at most 128 characters. */
export function fieldName(page: PageView, row: number, column: number): string {
  const chunk = page.columns[column]
  if (chunk.validity !== undefined && !bit(chunk.validity, row)) return 'NULL'
  const value = chunk.data.subarray(chunk.offsets[row], chunk.offsets[row + 1])
  if (chunk.wire === 'binary') {
    const out = new ChunkedBytes(1024)
    hex(out, value.subarray(0, (FIELD_NAME_CHARS - 2) / 2))
    return '0x' + fieldDecoder.decode(out.bytes())
  }
  if (value.length === 0) return '(blank)'
  let take = Math.min(value.length, 4 * (FIELD_NAME_CHARS + 1))
  while (take < value.length && take > 0 && (value[take] & 0xc0) === 0x80) take--
  // A line break, TAB or NUL is a space, as tab-separated text writes one, so distinct names stay distinct once written.
  const text = fieldDecoder.decode(value.subarray(0, take)).replace(/\r\n|[\t\n\r\0]/g, ' ')
  if (text.length <= FIELD_NAME_CHARS) return text
  const high = text.charCodeAt(FIELD_NAME_CHARS - 1)
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? FIELD_NAME_CHARS - 1 : FIELD_NAME_CHARS)
}
/** Transposed text's field names after "Column", made distinct as JSON keys are, in every format. */
export function uniqueFields(names: readonly string[]): string[] {
  const used = new Set([NAME_FIELD]), next = new Map<string, number>()
  return names.map(name => unique(used, name, next))
}

/** CRLF, CR, LF and TAB (and NUL on the clipboard, which Windows ends at the first one) each become one space. */
function tsvText(out: ChunkedBytes, text: Uint8Array, clipboard: boolean | undefined): void {
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const value = text[i]
    if (value !== B.tab && value !== B.lf && value !== B.cr && !(clipboard && value === 0)) continue
    out.write(text.subarray(start, i))
    out.write(literal(' '))
    if (value === B.cr && text[i + 1] === B.lf) i++
    start = i + 1
  }
  out.write(text.subarray(start))
}

/** RFC 4180: quoted only when needed, or when empty so '' differs from NULL. */
function csvField(out: ChunkedBytes, text: Uint8Array): void {
  if (text.length > 0) {
    let needsQuotes = false
    for (let i = 0; i < text.length; i++) {
      const value = text[i]
      if (value === B.comma || value === B.quote || value === B.cr || value === B.lf) { needsQuotes = true; break }
    }
    if (!needsQuotes) { out.write(text); return }
  }
  out.write(literal('"'))
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== B.quote) continue
    out.write(text.subarray(start, i + 1))
    out.write(literal('"'))
    start = i + 1
  }
  out.write(text.subarray(start))
  out.write(literal('"'))
}

const escapes: Readonly<Record<number, string>> = { [B.quote]: '\\"', [B.backslash]: '\\\\', [B.lf]: '\\n', [B.cr]: '\\r', [B.tab]: '\\t', 8: '\\b', 12: '\\f' }
/** Quote, backslash, C0, U+2028 and U+2029 escaped; everything else raw UTF-8. */
function jsonString(out: ChunkedBytes, text: Uint8Array): void {
  out.write(literal('"'))
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const value = text[i]
    if (value === 0xe2 && text[i + 1] === 0x80 && (text[i + 2] === 0xa8 || text[i + 2] === 0xa9)) {
      out.write(text.subarray(start, i))
      out.write(literal(text[i + 2] === 0xa8 ? '\\u2028' : '\\u2029'))
      i += 2
      start = i + 1
      continue
    }
    if (value >= 0x20 && value !== B.quote && value !== B.backslash) continue
    out.write(text.subarray(start, i))
    out.write(literal(escapes[value] ?? '\\u00' + value.toString(16).toUpperCase().padStart(2, '0')))
    start = i + 1
  }
  out.write(text.subarray(start))
  out.write(literal('"'))
}

function hex(out: ChunkedBytes, data: Uint8Array): void {
  const text = new Uint8Array(2 * data.length)
  for (let i = 0; i < data.length; i++) { text[2 * i] = hexDigits[data[i] >> 4]; text[2 * i + 1] = hexDigits[data[i] & 15] }
  out.write(text)
}

export class TextWriter {
  readonly options: TextOptions
  readonly columns: readonly TextColumn[]
  readonly out: ChunkedBytes
  lines = 0
  rows = 0
  records = 0
  /** Transposed: the source columns written (its lines), and the rows left out past those a transposed grid draws. */
  columnsWritten = 0
  capped = 0
  truncatedCells = 0
  private readonly kinds: CellKind[]
  private readonly keys: Uint8Array[] | undefined
  private fieldKeys: Uint8Array[] = []
  private field = 0
  private readonly eol: Uint8Array
  private readonly separator: Uint8Array
  constructor(options: TextOptions, columns: readonly TextColumn[], out = new ChunkedBytes()) {
    this.options = options
    this.columns = columns
    this.out = out
    this.kinds = columns.map(kind)
    this.keys = options.format === 'json' ? jsonKeys(columns) : undefined
    this.eol = bytes(options.crlf ? '\r\n' : '\n')
    this.separator = bytes(options.format === 'csv' ? ',' : '\t')
  }
  get bytes(): number { return this.out.length }
  begin(): void {
    if (this.options.bom) this.out.write(literal('﻿'))
    if (this.options.format === 'json') this.out.write(literal('['))
  }
  header(selected: readonly number[]): void {
    if (this.options.format === 'json' || !this.options.headers) return
    this.beginLine()
    selected.forEach((column, i) => {
      if (i > 0) this.out.write(this.separator)
      const name = bytes(this.columns[column].name === '' ? NO_COLUMN_NAME : this.columns[column].name)
      if (this.options.format === 'csv') csvField(this.out, name)
      else tsvText(this.out, name, this.options.clipboard)
    })
    this.endLine()
  }
  /** One row of a decoded page (wire/pages.ts PageView). */
  row(page: PageView, row: number, selected: readonly number[]): void {
    if (this.options.format === 'json') {
      this.out.write(literal(this.records === 0 ? '\n{' : ',\n{'))
      selected.forEach((column, i) => {
        if (i > 0) this.out.write(literal(','))
        this.out.write(this.keys![column])
        this.out.write(literal(':'))
        this.cell(page, row, column)
      })
      this.out.write(literal('}'))
      this.records++
    } else {
      this.beginLine()
      selected.forEach((column, i) => {
        if (i > 0) this.out.write(this.separator)
        this.cell(page, row, column)
      })
      this.endLine()
    }
    this.rows++
  }
  /** Transposed text: names the fields (the rows written); a first line with headers, every object's keys for JSON. */
  transposedHeader(names: readonly string[]): void {
    if (this.options.format === 'json') { this.fieldKeys = [NAME_FIELD, ...names].map(jsonKey); return }
    if (!this.options.headers) return
    this.beginLine()
    this.text(bytes(NAME_FIELD))
    for (const name of names) { this.out.write(this.separator); this.text(bytes(name)) }
    this.endLine()
  }
  /** Starts a source column's line (or JSON object), with its name first when headers are on (always for JSON). */
  beginColumn(column: number): void {
    this.field = 0
    const name = bytes(this.columns[column].name === '' ? NO_COLUMN_NAME : this.columns[column].name)
    if (this.options.format === 'json') {
      this.out.write(literal(this.records === 0 ? '\n{' : ',\n{'))
      this.out.write(this.fieldKeys[0])
      this.out.write(literal(':'))
      jsonString(this.out, name)
      return
    }
    this.beginLine()
    if (this.options.headers) this.text(name)
  }
  /** The line's next field: the column's value for one source row; JSON writes every value as text, NULL as null. */
  columnCell(page: PageView, row: number, column: number): void {
    if (this.options.format === 'json') {
      this.out.write(literal(','))
      this.out.write(this.fieldKeys[this.field + 1])
      this.out.write(literal(':'))
    } else if (this.field > 0 || this.options.headers) this.out.write(this.separator)
    this.field++
    this.cell(page, row, column, false)
  }
  endColumn(): void {
    if (this.options.format === 'json') { this.out.write(literal('}')); this.records++ } else this.endLine()
    this.columnsWritten++
  }
  text(name: Uint8Array): void {
    if (this.options.format === 'csv') csvField(this.out, name)
    else tsvText(this.out, name, this.options.clipboard)
  }
  end(): void { if (this.options.format === 'json') this.out.write(literal(this.records === 0 ? ']\n' : '\n]\n')) }
  private beginLine(): void { if (!this.options.trailingEol && this.lines > 0) this.out.write(this.eol) }
  private endLine(): void { if (this.options.trailingEol) this.out.write(this.eol); this.lines++ }
  private cell(page: PageView, row: number, column: number, typed = true): void {
    const chunk: ColumnView = page.columns[column]
    if (chunk.validity !== undefined && !bit(chunk.validity, row)) {
      if (this.options.format === 'json') this.out.write(literal('null'))
      else if (!this.options.nullAsEmpty) this.out.write(literal('NULL'))
      return
    }
    if (bit(chunk.truncated, row)) this.truncatedCells++
    const value = chunk.data.subarray(chunk.offsets[row], chunk.offsets[row + 1])
    const json = this.options.format === 'json'
    switch (this.kinds[column] === 'binary' || typed ? this.kinds[column] : 'text') {
      case 'binary':
        if (json) this.out.write(literal('"'))
        this.out.write(literal('0x'))
        hex(this.out, value)
        if (json) this.out.write(literal('"'))
        return
      case 'number':
        if (json && value.length <= 64 && jsonNumber.test(String.fromCharCode(...value)) && keepsValue(String.fromCharCode(...value))) { this.out.write(value); return }
        break
      case 'bit':
        if (json) {
          if (value.length === 1 && (value[0] === 48 || value[0] === 49)) { this.out.write(literal(value[0] === 49 ? 'true' : 'false')); return }
          if (value.length === 4 && String.fromCharCode(...value) === 'true' || value.length === 5 && String.fromCharCode(...value) === 'false') { this.out.write(value); return }
        }
        break
    }
    if (this.options.format === 'tsv') tsvText(this.out, value, this.options.clipboard)
    else if (this.options.format === 'csv') csvField(this.out, value)
    else jsonString(this.out, value)
  }
}

type Ranges = readonly (readonly [number, number])[]
/** Validates a copy part and clamps its rows to the rows available; undefined when it is invalid. */
export function resolvePart(part: unknown, columnCount: number, available: number): ResolvedPart | undefined {
  const valid = (ranges: unknown, max: number): ranges is Ranges => Array.isArray(ranges) && ranges.length >= 1 && ranges.length <= 64 && ranges.every((range: unknown, i: number) =>
    Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[0] <= range[1] && range[1] <= max && (i === 0 || range[0] > (ranges[i - 1] as number[])[1]))
  const candidate = part as { rows?: unknown; columns?: unknown } | undefined
  if (!valid(candidate?.rows, MAX_SAFE) || !valid(candidate?.columns, columnCount - 1)) return undefined
  const rows = candidate.rows as Ranges, columns = candidate.columns as Ranges
  return {
    rows: rows.filter(([first]) => first < available).map(([first, last]) => [first, Math.min(last, available - 1)] as const),
    columns: columns.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i))
  }
}

/**
 * Writes rows [first, last] through `pageAt(row)`, which returns a decoded page holding the row (with `firstRow` and
 * `rowCount`); `afterPage` runs after each page (the fake backend streams or writes chunks there).
 */
export async function writeRows(writer: TextWriter, pageAt: PageAt, selected: readonly number[], first: number, last: number, afterPage: () => Promise<void> = async () => {}): Promise<void> {
  for (let row = first; row <= last;) {
    const page = pageAt(row, last, selected)
    const end = Math.min(last, page.firstRow + page.rowCount - 1)
    for (let r = row; r <= end; r++) writer.row(page, r - page.firstRow, selected)
    row = end + 1
    await afterPage()
  }
}

export interface TurnedPart { readonly positions: readonly number[]; readonly names: readonly string[]; readonly columns: readonly number[]; readonly capped: number }
/**
 * A resolved part as a transposed grid draws it: the rows written (those at positions under MAX_TRANSPOSED_ROWS), their
 * fields' names ("Row N", or `headerColumn`'s values, made distinct), and the rows left out past them.
 */
export function turnPlan(plan: ResolvedPart, pageAt: PageAt, headerColumn: number | undefined, named = true): TurnedPart {
  const positions: number[] = []
  let capped = 0
  for (const [first, last] of plan.rows) {
    for (let position = first; position <= Math.min(last, MAX_TRANSPOSED_ROWS - 1); position++) positions.push(position)
    capped += Math.max(0, last - Math.max(first, MAX_TRANSPOSED_ROWS) + 1)
  }
  const names = !named ? [] : positions.map(position => {
    if (headerColumn === undefined) return `Row ${position + 1}`
    const page = pageAt(position)
    return fieldName(page, position - page.firstRow, headerColumn)
  })
  return { positions, names: uniqueFields(names), columns: plan.columns, capped }
}

/** Writes a transposed part: the line that names its fields, then a line per column; `afterLine` runs after each. */
export async function writeColumns(writer: TextWriter, pageAt: PageAt, turned: TurnedPart, afterLine: () => Promise<void> = async () => {}): Promise<void> {
  writer.transposedHeader(turned.names)
  for (const column of turned.columns) {
    writer.beginColumn(column)
    for (const position of turned.positions) {
      const page = pageAt(position)
      writer.columnCell(page, position - page.firstRow, column)
    }
    writer.endColumn()
    await afterLine()
  }
}

/** Columns that are not data (ResultTextWriter.Hidden): a tone, a diff's previous values, marker and row numbers, and a
 *  live table's identity columns. */
const hiddenRoles = new Set(['old', 'mark', 'leftRow', 'rightRow', 'tone', 'hidden'])
export const isHidden = (column: TextColumn | undefined): boolean => hiddenRoles.has(column?.role ?? '')
/** The columns Save writes (ResultJobs.SavedColumns): the visible ones, a diff's marker and row numbers first. */
export function savedColumns(columns: readonly TextColumn[], kind?: string): number[] {
  const visible = columns.flatMap((column, at) => isHidden(column) ? [] : [at])
  if (kind !== 'diff') return visible
  return [...['mark', 'leftRow', 'rightRow'].map(role => columns.findIndex(column => column.role === role)), ...visible]
}

/** A header column names a transposed job's fields, so only such a job has one, and it is a column of the result. */
export function validTurn(transposed: unknown, headerColumn: unknown, columnCount: number): boolean {
  if (transposed !== undefined && typeof transposed !== 'boolean') return false
  return headerColumn === undefined || (transposed === true && Number.isInteger(headerColumn) && (headerColumn as number) >= 0 && (headerColumn as number) < columnCount)
}

export interface CopyRequest {
  readonly columns: readonly TextColumn[]
  readonly pageAt: PageAt
  readonly available: number
  readonly parts: readonly unknown[]
  readonly headers: boolean
  readonly crlf: boolean
  readonly transposed?: boolean
  readonly headerColumn?: number
}
export interface CopiedText { readonly text: Uint8Array; readonly rows: number; readonly bytes: number; readonly truncatedCells: number; readonly capped: number; readonly lines: number }
/** Copy's text for parts of a result (all of it at once; callers check its size against their limit).
 *  `transposed` writes each part as a transposed grid draws it. */
export async function copyText({ columns, pageAt, available, parts, headers, crlf, transposed = false, headerColumn }: CopyRequest, afterPage?: (writer: TextWriter) => Promise<void>): Promise<CopiedText> {
  const plans = parts.map(part => resolvePart(part, columns.length, available)).map(plan => plan && { ...plan, columns: plan.columns.filter(column => !isHidden(columns[column])) })
  if (plans.some(plan => plan === undefined) || !validTurn(transposed, headerColumn, columns.length)) throw new RangeError('The copy request is invalid.')
  const writer = new TextWriter(copyOptions(headers, crlf), columns)
  const after = afterPage && (() => afterPage(writer))
  let rows = 0
  writer.begin()
  for (const plan of plans as ResolvedPart[]) {
    if (transposed) {
      const turned = turnPlan(plan, pageAt, headerColumn, headers)
      writer.capped += turned.capped
      rows += turned.positions.length
      if (turned.columns.length > 0 && (headers || turned.positions.length > 0)) await writeColumns(writer, pageAt, turned)
      continue
    }
    if (headers) writer.header(plan.columns)
    for (const [first, last] of plan.rows) await writeRows(writer, pageAt, plan.columns, first, last, after)
  }
  writer.end()
  return { text: writer.out.bytes(), rows: transposed ? rows : writer.rows, bytes: writer.bytes, truncatedCells: writer.truncatedCells, capped: writer.capped, lines: transposed ? writer.columnsWritten : writer.rows }
}

export interface ExportRequest {
  readonly columns: readonly TextColumn[]
  /** The result's kind: a diff saves its marker and row numbers first (savedColumns). */
  readonly kind?: string
  readonly pageAt: PageAt
  readonly rows: number
  readonly format: TextFormat
  readonly headers: boolean
  readonly nullText: 'empty' | 'NULL'
  readonly transposed?: boolean
  readonly headerColumn?: number
}
/** A whole result as Save Results As writes it; `transposed`, as a transposed grid draws it (the writer's `rows` are then
 *  the source rows written and its `capped` those left out). */
export async function exportText({ columns, kind, pageAt, rows, format, headers, nullText, transposed = false, headerColumn }: ExportRequest, afterPage?: (writer: TextWriter) => Promise<void>): Promise<TextWriter> {
  const writer = new TextWriter(exportOptions(format, headers, nullText), columns)
  const all = savedColumns(columns, kind)
  const after = afterPage && (() => afterPage(writer))
  writer.begin()
  if (transposed) {
    const turned = turnPlan({ rows: rows > 0 ? [[0, rows - 1]] : [], columns: all }, pageAt, headerColumn, headers || format === 'json')
    if (all.length > 0 && (headers || format === 'json' || turned.positions.length > 0)) await writeColumns(writer, pageAt, turned, after)
    writer.rows = turned.positions.length
    writer.capped = turned.capped
  } else {
    writer.header(all)
    if (rows > 0) await writeRows(writer, pageAt, all, 0, rows - 1, after)
  }
  writer.end()
  return writer
}
