// The fake backend's Copy and Save Results As text: a JavaScript twin of the C# ResultTextWriter, written against the
// same goldens (tests/fixtures/results-text/cases.json, checked by tests/results-text.test.ts). It reads decoded pages
// (src/shared/ipc/wire/pages.ts) and works on UTF-8 bytes, as the C# writer does.

export const MAX_SAFE = Number.MAX_SAFE_INTEGER
export const NO_COLUMN_NAME = '(No column name)'
const encoder = new TextEncoder()
const bytes = text => encoder.encode(text)
const numberTypes = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney', 'real', 'float'])
const jsonNumber = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
const hexDigits = bytes('0123456789ABCDEF')
const B = { tab: 9, lf: 10, cr: 13, quote: 34, comma: 44, backslash: 92 }

/** Copy: tab-separated, NULL as NULL, the platform's end of line between lines and none after the last, NUL as a space. */
export const copyOptions = (headers, crlf) => ({ format: 'tsv', headers, nullAsEmpty: false, crlf, trailingEol: false, bom: false, clipboard: true })
/** Save: CSV and TSV with a BOM and CRLF after every line; JSON with LF, no BOM and no header. */
export const exportOptions = (format, headers, nullText) => ({ format, headers: headers && format !== 'json', nullAsEmpty: nullText === 'empty', crlf: format !== 'json', trailingEol: true, bom: format !== 'json' })

/** A growing list of 1 MiB chunks, so large output never needs one huge buffer. */
export class ChunkedBytes {
  constructor(size = 1024 * 1024) { this.size = size; this.full = []; this.chunk = new Uint8Array(size); this.used = 0; this.length = 0 }
  write(data) {
    let offset = 0
    while (offset < data.length) {
      if (this.used === this.size) this.seal()
      const count = Math.min(this.size - this.used, data.length - offset)
      this.chunk.set(data.subarray(offset, offset + count), this.used)
      this.used += count
      offset += count
    }
    this.length += data.length
  }
  seal() {
    if (this.used === 0) return
    this.full.push(this.used === this.size ? this.chunk : this.chunk.slice(0, this.used))
    this.chunk = new Uint8Array(this.size)
    this.used = 0
  }
  /** Sealed chunks, oldest first; each is taken once. */
  take() { return this.full.splice(0) }
  /** Everything written, as one array. */
  bytes() {
    this.seal()
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.full) { out.set(chunk, at); at += chunk.length }
    return out
  }
}

function kind(column) {
  if (column.wire === 'binary') return 'binary'
  const type = column.dataType.split('(')[0].trim().toLowerCase()
  return type === 'bit' ? 'bit' : numberTypes.has(type) ? 'number' : 'text'
}

/** JSON keys: a blank name becomes Column{ordinal}; a repeated one gets _2, _3 and so on. */
function jsonKeys(columns) {
  const used = new Set()
  return columns.map((column, index) => {
    const name = column.name === '' ? `Column${index + 1}` : column.name
    let key = name
    for (let n = 2; used.has(key); n++) key = `${name}_${n}`
    used.add(key)
    const out = new ChunkedBytes(64 * 1024)
    jsonString(out, bytes(key))
    return out.bytes()
  })
}

function bit(bitmap, row) { return bitmap !== undefined && (bitmap[row >>> 3] & (1 << (row & 7))) !== 0 }

/** CRLF, CR, LF and TAB (and NUL on the clipboard, which Windows ends at the first one) each become one space. */
function tsvText(out, text, clipboard) {
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const value = text[i]
    if (value !== B.tab && value !== B.lf && value !== B.cr && !(clipboard && value === 0)) continue
    out.write(text.subarray(start, i))
    out.write(bytes(' '))
    if (value === B.cr && text[i + 1] === B.lf) i++
    start = i + 1
  }
  out.write(text.subarray(start))
}

/** RFC 4180: quoted only when needed, or when empty so '' differs from NULL. */
function csvField(out, text) {
  if (text.length > 0 && !text.some(value => value === B.comma || value === B.quote || value === B.cr || value === B.lf)) { out.write(text); return }
  out.write(bytes('"'))
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== B.quote) continue
    out.write(text.subarray(start, i + 1))
    out.write(bytes('"'))
    start = i + 1
  }
  out.write(text.subarray(start))
  out.write(bytes('"'))
}

const escapes = { [B.quote]: '\\"', [B.backslash]: '\\\\', [B.lf]: '\\n', [B.cr]: '\\r', [B.tab]: '\\t', 8: '\\b', 12: '\\f' }
/** Quote, backslash, C0, U+2028 and U+2029 escaped; everything else raw UTF-8. */
function jsonString(out, text) {
  out.write(bytes('"'))
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const value = text[i]
    if (value === 0xe2 && text[i + 1] === 0x80 && (text[i + 2] === 0xa8 || text[i + 2] === 0xa9)) {
      out.write(text.subarray(start, i))
      out.write(bytes(text[i + 2] === 0xa8 ? '\\u2028' : '\\u2029'))
      i += 2
      start = i + 1
      continue
    }
    if (value >= 0x20 && value !== B.quote && value !== B.backslash) continue
    out.write(text.subarray(start, i))
    out.write(bytes(escapes[value] ?? '\\u00' + value.toString(16).toUpperCase().padStart(2, '0')))
    start = i + 1
  }
  out.write(text.subarray(start))
  out.write(bytes('"'))
}

function hex(out, data) {
  const text = new Uint8Array(2 * data.length)
  for (let i = 0; i < data.length; i++) { text[2 * i] = hexDigits[data[i] >> 4]; text[2 * i + 1] = hexDigits[data[i] & 15] }
  out.write(text)
}

export class TextWriter {
  /** `columns`: { name, dataType, wire }; `out` a ChunkedBytes. */
  constructor(options, columns, out = new ChunkedBytes()) {
    this.options = options
    this.columns = columns
    this.out = out
    this.kinds = columns.map(kind)
    this.keys = options.format === 'json' ? jsonKeys(columns) : undefined
    this.lines = 0
    this.rows = 0
    this.truncatedCells = 0
    this.eol = bytes(options.crlf ? '\r\n' : '\n')
    this.separator = bytes(options.format === 'csv' ? ',' : '\t')
  }
  get bytes() { return this.out.length }
  begin() {
    if (this.options.bom) this.out.write(bytes('﻿'))
    if (this.options.format === 'json') this.out.write(bytes('['))
  }
  header(selected) {
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
  row(page, row, selected) {
    if (this.options.format === 'json') {
      this.out.write(bytes(this.rows === 0 ? '\n{' : ',\n{'))
      selected.forEach((column, i) => {
        if (i > 0) this.out.write(bytes(','))
        this.out.write(this.keys[column])
        this.out.write(bytes(':'))
        this.cell(page, row, column)
      })
      this.out.write(bytes('}'))
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
  end() { if (this.options.format === 'json') this.out.write(bytes(this.rows === 0 ? ']\n' : '\n]\n')) }
  beginLine() { if (!this.options.trailingEol && this.lines > 0) this.out.write(this.eol) }
  endLine() { if (this.options.trailingEol) this.out.write(this.eol); this.lines++ }
  cell(page, row, column) {
    const chunk = page.columns[column]
    if (chunk.validity !== undefined && !bit(chunk.validity, row)) {
      if (this.options.format === 'json') this.out.write(bytes('null'))
      else if (!this.options.nullAsEmpty) this.out.write(bytes('NULL'))
      return
    }
    if (bit(chunk.truncated, row)) this.truncatedCells++
    const value = chunk.data.subarray(chunk.offsets[row], chunk.offsets[row + 1])
    const json = this.options.format === 'json'
    switch (this.kinds[column]) {
      case 'binary':
        if (json) this.out.write(bytes('"'))
        this.out.write(bytes('0x'))
        hex(this.out, value)
        if (json) this.out.write(bytes('"'))
        return
      case 'number':
        if (json && value.length <= 64 && jsonNumber.test(String.fromCharCode(...value))) { this.out.write(value); return }
        break
      case 'bit':
        if (json && value.length === 1 && (value[0] === 48 || value[0] === 49)) { this.out.write(bytes(value[0] === 49 ? 'true' : 'false')); return }
        break
    }
    if (this.options.format === 'tsv') tsvText(this.out, value, this.options.clipboard)
    else if (this.options.format === 'csv') csvField(this.out, value)
    else jsonString(this.out, value)
  }
}

/** Validates a copy part and clamps its rows to the rows available; undefined when it is invalid. */
export function resolvePart(part, columnCount, available) {
  const valid = (ranges, max) => Array.isArray(ranges) && ranges.length >= 1 && ranges.length <= 64 && ranges.every((range, i) =>
    Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[0] <= range[1] && range[1] <= max && (i === 0 || range[0] > ranges[i - 1][1]))
  if (!valid(part?.rows, MAX_SAFE) || !valid(part?.columns, columnCount - 1)) return undefined
  return {
    rows: part.rows.filter(([first]) => first < available).map(([first, last]) => [first, Math.min(last, available - 1)]),
    columns: part.columns.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i))
  }
}

/**
 * Writes rows [first, last] through `pageAt(row)`, which returns a decoded page holding the row (with `firstRow` and
 * `rowCount`); `afterPage` runs after each page (the fake backend streams or writes chunks there).
 */
export async function writeRows(writer, pageAt, selected, first, last, afterPage = async () => {}) {
  for (let row = first; row <= last;) {
    const page = pageAt(row)
    const end = Math.min(last, page.firstRow + page.rowCount - 1)
    for (let r = row; r <= end; r++) writer.row(page, r - page.firstRow, selected)
    row = end + 1
    await afterPage()
  }
}

/** Copy's text for parts of a result (all of it at once; the fake backend checks its size against the limit). */
export async function copyText({ columns, pageAt, available, parts, headers, crlf }) {
  const plans = parts.map(part => resolvePart(part, columns.length, available))
  if (plans.some(plan => plan === undefined)) throw new RangeError('The copy request is invalid.')
  const writer = new TextWriter(copyOptions(headers, crlf), columns)
  writer.begin()
  for (const plan of plans) {
    if (headers) writer.header(plan.columns)
    for (const [first, last] of plan.rows) await writeRows(writer, pageAt, plan.columns, first, last)
  }
  writer.end()
  return { text: writer.out.bytes(), rows: writer.rows, bytes: writer.bytes, truncatedCells: writer.truncatedCells }
}

/** A whole result as Save Results As writes it. */
export async function exportText({ columns, pageAt, rows, format, headers, nullText }, afterPage) {
  const writer = new TextWriter(exportOptions(format, headers, nullText), columns)
  const all = columns.map((_, i) => i)
  writer.begin()
  writer.header(all)
  if (rows > 0) await writeRows(writer, pageAt, all, 0, rows - 1, afterPage && (() => afterPage(writer)))
  writer.end()
  return writer
}
