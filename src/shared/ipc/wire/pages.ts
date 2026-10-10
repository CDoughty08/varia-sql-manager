// Columnar result pages, the body of a DATA frame (docs/ipc.md):
//   array(7) [ formatVersion = 1, resultId, firstRow, rowCount, [ColumnChunk…], bin pad (0..7 zero bytes), bin32 data ]
//   ColumnChunk = array(11) [ wire (1 text | 2 binary), validityOff, validityLen, offsetsOff, offsetsLen, dataOff, dataLen,
//                             truncatedOff, truncatedLen, errorsOff, errorsLen ]   (offsets relative to the data blob)
// The pad puts the data blob at a body offset ≡ 0 (mod 8), so the decoder views the u32 cell offsets in place.
// The C# PageBuilder writes byte-identical pages (tests/fixtures/pages).
import { DecodeError, MsgPackCursor, MsgPackWriter } from './msgpack.ts'

export const PAGE_FORMAT_VERSION = 1
export type WireKind = 'text' | 'binary'
const wireCodes: Readonly<Record<WireKind, number>> = { text: 1, binary: 2 }

export interface PageLimits { readonly maxRows: number; readonly maxColumns: number }
export const pageLimits: PageLimits = Object.freeze({ maxRows: 4096, maxColumns: 4096 })

export type PageErrorCode = 'HEADER' | 'VERSION' | 'ROWS' | 'COLUMNS' | 'WIRE' | 'PAD' | 'ALIGN' | 'BOUNDS' | 'BITMAP' | 'OFFSETS' | 'NULL_SPAN' | 'FLAGS' | 'TRAILING'
/** The only error decodePage throws. It names the defect, never the page's bytes. */
export class PageFormatError extends Error {
  readonly code: PageErrorCode
  constructor(code: PageErrorCode, column?: number) {
    super(`Invalid result page: ${code}${column === undefined ? '' : ` in column ${column}`}`)
    this.name = 'PageFormatError'
    this.code = code
  }
}

/** Zero-copy views over one column of a page. Absent bitmaps mean all valid, none truncated, no errors. */
export interface ColumnView {
  readonly wire: WireKind
  /** LSB-first; bit 1 means non-null. */
  readonly validity: Uint8Array | undefined
  /** rowCount + 1 non-decreasing byte offsets into `data`; a NULL cell has an empty span. */
  readonly offsets: Uint32Array
  readonly data: Uint8Array
  readonly truncated: Uint8Array | undefined
  readonly errors: Uint8Array | undefined
}
export interface PageView { readonly resultId: number; readonly firstRow: number; readonly rowCount: number; readonly columns: readonly ColumnView[]; readonly byteLength: number }

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const U32 = 0xffffffff

function bit(bitmap: Uint8Array | undefined, row: number, absent: boolean): boolean {
  return bitmap === undefined ? absent : (bitmap[row >>> 3] & (1 << (row & 7))) !== 0
}

/**
 * Validates a page against the result's columns and every bound, then returns views over the received buffer.
 * O(columns) for the header plus O(cells) for offsets and bitmaps; text is decoded later, per requested cell.
 */
export function decodePage(body: Uint8Array | ArrayBuffer, columns: readonly { readonly wire: WireKind }[], limits: PageLimits = pageLimits): PageView {
  let bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  // Typed-array views need aligned offsets; pages from main always start at byteOffset 0. (A copy, not Buffer#slice.)
  if (bytes.byteOffset % 8 !== 0) bytes = new Uint8Array(bytes)
  const c = new MsgPackCursor(bytes)
  const chunks: { wire: WireKind; regions: number[] }[] = []
  let resultId: number, firstRow: number, rowCount: number, dataStart: number, blobLength: number
  try {
    if (c.arrayHeader() !== 7) throw new PageFormatError('HEADER')
    if (c.uint() !== PAGE_FORMAT_VERSION) throw new PageFormatError('VERSION')
    resultId = c.uint()
    if (resultId < 1 || resultId > U32) throw new PageFormatError('HEADER')
    firstRow = c.uint()
    rowCount = c.uint()
    if (rowCount < 1 || rowCount > limits.maxRows) throw new PageFormatError('ROWS')
    const count = c.arrayHeader()
    if (count < 1 || count > limits.maxColumns || count !== columns.length) throw new PageFormatError('COLUMNS')
    for (let i = 0; i < count; i++) {
      if (c.arrayHeader() !== 11) throw new PageFormatError('HEADER', i)
      const code = c.uint()
      const wire: WireKind | undefined = code === 1 ? 'text' : code === 2 ? 'binary' : undefined
      if (wire === undefined || wire !== columns[i].wire) throw new PageFormatError('WIRE', i)
      const regions: number[] = []
      for (let r = 0; r < 10; r++) regions.push(c.uint())
      chunks.push({ wire, regions })
    }
    const pad = c.binHeader()
    if (pad > 7) throw new PageFormatError('PAD')
    for (let i = 0; i < pad; i++) if (bytes[c.offset + i] !== 0) throw new PageFormatError('PAD')
    c.offset += pad
    if (c.byte() !== 0xc6) throw new PageFormatError('HEADER')
    blobLength = c.u32()
    dataStart = c.offset
  } catch (error) {
    if (error instanceof DecodeError) throw new PageFormatError('HEADER')
    throw error
  }
  if (dataStart % 8 !== 0) throw new PageFormatError('ALIGN')
  if (dataStart + blobLength !== bytes.length) throw new PageFormatError(dataStart + blobLength > bytes.length ? 'BOUNDS' : 'TRAILING')
  const bitmapBytes = Math.ceil(rowCount / 8)
  const views: ColumnView[] = chunks.map(({ wire, regions }, i) => {
    for (let r = 0; r < 10; r += 2) if (regions[r] + regions[r + 1] > blobLength) throw new PageFormatError('BOUNDS', i)
    const [validityOff, validityLen, offsetsOff, offsetsLen, dataOff, dataLen, truncatedOff, truncatedLen, errorsOff, errorsLen] = regions
    const bitmap = (off: number, len: number): Uint8Array | undefined => {
      if (len === 0) {
        if (off !== 0) throw new PageFormatError('BITMAP', i)
        return undefined
      }
      if (len !== bitmapBytes) throw new PageFormatError('BITMAP', i)
      const view = bytes.subarray(dataStart + off, dataStart + off + len)
      // Bits past the last row must be zero, so every page has one encoding.
      if (rowCount % 8 !== 0 && (view[len - 1] >>> (rowCount % 8)) !== 0) throw new PageFormatError('BITMAP', i)
      return view
    }
    const validity = bitmap(validityOff, validityLen)
    const truncated = bitmap(truncatedOff, truncatedLen)
    const errors = bitmap(errorsOff, errorsLen)
    if (offsetsLen !== 4 * (rowCount + 1)) throw new PageFormatError('OFFSETS', i)
    if (offsetsOff % 8 !== 0) throw new PageFormatError('ALIGN', i)
    const offsets = littleEndian ? new Uint32Array(bytes.buffer, bytes.byteOffset + dataStart + offsetsOff, rowCount + 1) : readOffsets(bytes, dataStart + offsetsOff, rowCount + 1)
    if (offsets[0] !== 0 || offsets[rowCount] !== dataLen) throw new PageFormatError('OFFSETS', i)
    for (let row = 0; row < rowCount; row++) {
      const empty = offsets[row + 1] === offsets[row]
      if (offsets[row + 1] < offsets[row]) throw new PageFormatError('OFFSETS', i)
      const valid = bit(validity, row, true)
      if (!valid && !empty) throw new PageFormatError('NULL_SPAN', i)
      // A truncated cell holds a stored prefix; a read error leaves the cell NULL.
      if ((bit(truncated, row, false) && !valid) || (bit(errors, row, false) && valid)) throw new PageFormatError('FLAGS', i)
    }
    return { wire, validity, offsets, data: bytes.subarray(dataStart + dataOff, dataStart + dataOff + dataLen), truncated, errors }
  })
  return { resultId, firstRow, rowCount, columns: views, byteLength: bytes.length }
}

function readOffsets(bytes: Uint8Array, start: number, count: number): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, count * 4)
  const offsets = new Uint32Array(count)
  for (let i = 0; i < count; i++) offsets[i] = view.getUint32(i * 4, true)
  return offsets
}

/** A cell for encodePage: text for text columns, bytes for binary columns; `error` is NULL with the read-error flag. */
export type PageCell = string | Uint8Array | null | { readonly value: string | Uint8Array; readonly truncated: true } | { readonly error: true }
export interface PageInput { readonly resultId: number; readonly firstRow: number; readonly columns: readonly { readonly wire: WireKind }[]; readonly rows: readonly (readonly PageCell[])[] }

const encoder = new TextEncoder()

/**
 * Builds a page exactly as the C# PageBuilder does: per column, the present regions in the order validity, offsets,
 * data, truncated, errors, each starting 8-aligned in the blob. Bitmaps are present only when a bit is set.
 * Used by tests, the fake backend and benchmarks.
 */
export function encodePage(input: PageInput): Uint8Array {
  const rowCount = input.rows.length
  if (rowCount < 1 || rowCount > pageLimits.maxRows || input.columns.length < 1 || input.columns.length > pageLimits.maxColumns) throw new RangeError('Page dimensions are out of range.')
  const bitmapBytes = Math.ceil(rowCount / 8)
  const parts: { offset: number; bytes: Uint8Array }[] = []
  const chunks: number[][] = []
  let position = 0
  const place = (bytes: Uint8Array | undefined): [number, number] => {
    if (bytes === undefined) return [0, 0]
    position = (position + 7) & ~7
    parts.push({ offset: position, bytes })
    const region: [number, number] = [position, bytes.length]
    position += bytes.length
    return region
  }
  input.columns.forEach((column, index) => {
    const validity = new Uint8Array(bitmapBytes)
    const truncated = new Uint8Array(bitmapBytes)
    const errors = new Uint8Array(bitmapBytes)
    const offsets = new Uint8Array(4 * (rowCount + 1))
    const offsetsView = new DataView(offsets.buffer)
    const cells: Uint8Array[] = []
    let anyNull = false, anyTruncated = false, anyError = false, length = 0
    input.rows.forEach((row, r) => {
      if (row.length !== input.columns.length) throw new RangeError('Every row needs one cell per column.')
      const cell = row[index]
      const set = (bitmap: Uint8Array): void => { bitmap[r >>> 3] |= 1 << (r & 7) }
      let value: string | Uint8Array | undefined
      if (cell === null) anyNull = true
      else if (typeof cell === 'string' || cell instanceof Uint8Array) value = cell
      else if ('error' in cell) { anyNull = true; anyError = true; set(errors) }
      else { value = cell.value; anyTruncated = true; set(truncated) }
      if (value !== undefined) {
        if ((typeof value === 'string') !== (column.wire === 'text')) throw new RangeError('Cell value does not match the column wire kind.')
        set(validity)
        const bytes = typeof value === 'string' ? encoder.encode(value) : value
        cells.push(bytes)
        length += bytes.length
      }
      offsetsView.setUint32(4 * (r + 1), length, true)
    })
    const data = new Uint8Array(length)
    let at = 0
    for (const bytes of cells) { data.set(bytes, at); at += bytes.length }
    chunks.push([wireCodes[column.wire], ...place(anyNull ? validity : undefined), ...place(offsets), ...place(data), ...place(anyTruncated ? truncated : undefined), ...place(anyError ? errors : undefined)])
  })
  const header = new MsgPackWriter(64 + chunks.length * 24)
  header.arrayHeader(7)
  header.integer(PAGE_FORMAT_VERSION)
  header.integer(input.resultId)
  header.integer(input.firstRow)
  header.integer(rowCount)
  header.arrayHeader(chunks.length)
  for (const chunk of chunks) {
    header.arrayHeader(11)
    for (const value of chunk) header.integer(value)
  }
  // bin8 pad header (2 bytes) + pad + bin32 header (5 bytes) must end 8-aligned.
  const pad = (8 - ((header.size + 7) % 8)) % 8
  header.binHeader(pad)
  header.raw(new Uint8Array(pad))
  header.binHeader(position, true)
  const page = new Uint8Array(header.size + position)
  page.set(header.finish())
  for (const part of parts) page.set(part.bytes, header.size + part.offset)
  return page
}
