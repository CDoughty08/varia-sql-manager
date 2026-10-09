// Display text for cells of a decoded page. The backend formats every non-binary value into its SSMS display text,
// so text cells only need UTF-8 decoding; binary cells are shown as 0x plus uppercase hex, as in SSMS.
import type { PageView } from './pages.ts'

/** Cell flags, also used by result windows: NULL, stored truncation (the backend kept a prefix), read error, and (windows
 *  only) cut at the window's maxCellChars. */
export const CELL_NULL = 1
export const CELL_TRUNCATED = 2
export const CELL_ERROR = 4
export const CELL_CAPPED = 16

// Line breaks and tabs show as one space each, as SSMS's grid shows them; other control characters and the Unicode line
// and paragraph separators, which would break a row or hide text, show as U+FFFD.
const unsafe = /[\x00-\x1f\x7f\u2028\u2029]/
const unsafeAll = /\r\n|[\x00-\x1f\x7f\u2028\u2029]/g
const shown = (match: string): string => match.length === 2 || match === '\r' || match === '\n' || match === '\t' ? ' ' : '\ufffd'
/** A grid cell's display text: one line, with nothing that moves the cells around it. */
export function displayText(text: string): string { return unsafe.test(text) ? text.replace(unsafeAll, shown) : text }

const lenient = new TextDecoder('utf-8', { ignoreBOM: true })
const hexPairs = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'))

function bit(bitmap: Uint8Array | undefined, row: number): boolean { return bitmap !== undefined && (bitmap[row >>> 3] & (1 << (row & 7))) !== 0 }

/** The stored flags of a cell (CELL_NULL, CELL_TRUNCATED, CELL_ERROR). */
export function cellFlags(view: PageView, column: number, row: number): number {
  const chunk = view.columns[column]
  const isNull = chunk.validity !== undefined && !bit(chunk.validity, row)
  return (isNull ? CELL_NULL : 0) | (bit(chunk.truncated, row) ? CELL_TRUNCATED : 0) | (bit(chunk.errors, row) ? CELL_ERROR : 0)
}

/**
 * The display text of a non-NULL cell, at most `maxChars` UTF-16 units. `truncated` is set when the backend stored a
 * prefix or the text was capped here. NULL cells give ''; check cellFlags first.
 */
export function cellText(view: PageView, column: number, row: number, maxChars = Number.POSITIVE_INFINITY): { text: string; truncated: boolean } {
  const cell = cellSlice(view, column, row, maxChars)
  return { text: cell.text, truncated: bit(view.columns[column].truncated, row) || cell.cut }
}
/** cellText's text, with `cut` set only when `maxChars` cut it (a prefix the backend stored is CELL_TRUNCATED). */
export function cellSlice(view: PageView, column: number, row: number, maxChars = Number.POSITIVE_INFINITY): { text: string; cut: boolean } {
  const chunk = view.columns[column]
  const span = chunk.data.subarray(chunk.offsets[row], chunk.offsets[row + 1])
  if (chunk.wire === 'text') {
    const prefix = utf8Prefix(span, maxChars)
    return { text: prefix.text, cut: prefix.truncated }
  }
  const fits = 2 + 2 * span.length <= maxChars
  const bytes = fits ? span.length : Math.max(0, Math.floor((maxChars - 2) / 2))
  return { text: '0x' + hex(span.subarray(0, bytes)), cut: !fits }
}

/** Rows of one text column decoded together; see textRun. */
export interface TextRun { readonly text: string; readonly start: number }

/**
 * Rows [from, to) of a text column decoded with one decoder call, which for small cells is several times faster than
 * one call per cell. Only when every byte decodes to exactly one UTF-16 unit (ASCII, or an invalid byte as U+FFFD):
 * then no token spans two cells and each cell's text is the run's slice at its byte offsets, as runText returns it.
 * Undefined for binary columns and any other text.
 */
export function textRun(view: PageView, column: number, from: number, to: number): TextRun | undefined {
  const chunk = view.columns[column]
  if (chunk.wire !== 'text' || to <= from) return undefined
  const start = chunk.offsets[from], end = chunk.offsets[to]
  const text = lenient.decode(chunk.data.subarray(start, end))
  return text.length === end - start ? { text, start } : undefined
}

/** cellText for a cell of `run`'s rows; a run holds no surrogate pairs, so any cut is safe. */
export function runText(run: TextRun, view: PageView, column: number, row: number, maxChars = Number.POSITIVE_INFINITY): { text: string; truncated: boolean } {
  const cell = runSlice(run, view, column, row, maxChars)
  return { text: cell.text, truncated: bit(view.columns[column].truncated, row) || cell.cut }
}
/** cellSlice for a cell of `run`'s rows. */
export function runSlice(run: TextRun, view: PageView, column: number, row: number, maxChars = Number.POSITIVE_INFINITY): { text: string; cut: boolean } {
  const chunk = view.columns[column]
  const at = chunk.offsets[row] - run.start
  const length = chunk.offsets[row + 1] - chunk.offsets[row]
  const fits = length <= maxChars
  return { text: run.text.slice(at, at + (fits ? length : Math.max(0, maxChars))), cut: !fits }
}

/** Uppercase hexadecimal, without a prefix. */
export function hex(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += hexPairs[bytes[i]]
  return text
}

/**
 * Decodes UTF-8 (invalid sequences become U+FFFD) to at most `maxChars` UTF-16 units without splitting a surrogate
 * pair. Decodes no more than 3 × maxChars + 3 bytes, enough for maxChars units whatever the input.
 */
export function utf8Prefix(bytes: Uint8Array, maxChars: number): { text: string; truncated: boolean } {
  // Every byte decodes to at most one UTF-16 unit, so a span no longer than the cap always fits.
  if (bytes.length <= maxChars) return { text: lenient.decode(bytes), truncated: false }
  const limit = Math.min(bytes.length, 3 * maxChars + 3)
  const decoded = lenient.decode(bytes.subarray(0, limit))
  if (limit === bytes.length && decoded.length <= maxChars) return { text: decoded, truncated: false }
  let end = Math.max(0, maxChars)
  const last = decoded.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return { text: decoded.slice(0, end), truncated: true }
}
