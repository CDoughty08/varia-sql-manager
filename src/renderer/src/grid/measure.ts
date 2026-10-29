import type { ResultColumn } from '../../../shared/contracts'
import { gridLimits as g } from './constants'

// Column widths come from character counts in the grid's monospace font, so sizing a column is O(1) per cell: before
// any rows from its declared type, then once from the widest display text of the first rows, then on a double-click.

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const fixed: Readonly<Record<string, number>> = {
  bit: 1, tinyint: 3, smallint: 6, int: 11, bigint: 20, money: 21, smallmoney: 12, real: 14, float: 24,
  date: 10, datetime: 23, smalldatetime: 19, uniqueidentifier: 36
}
const scaled: Readonly<Record<string, number>> = { time: 9, datetime2: 20, datetimeoffset: 27 }
const characters = new Set(['char', 'varchar', 'nchar', 'nvarchar'])
const binaries = new Set(['binary', 'varbinary'])

/** The characters a value of the column's type usually needs, from its SSMS display format (owner decision 8). */
export function typeHintChars(column: Pick<ResultColumn, 'dataType' | 'maxLength' | 'precision' | 'scale' | 'role'>): number {
  const type = column.dataType.toLowerCase()
  if (column.role) return 40
  if (Object.hasOwn(fixed, type)) return fixed[type]
  // time(n), datetime2(n), datetimeoffset(n): n fractional digits after the point; 7 when the scale is unknown.
  if (Object.hasOwn(scaled, type)) return scaled[type] + clamp(column.scale ?? 7, 0, 7)
  if (type === 'decimal' || type === 'numeric') return (column.precision ?? 18) + 2
  // Max types have no length: they and every other type (xml, sql_variant, CLR types) get a medium default.
  if (characters.has(type)) return column.maxLength ? Math.min(column.maxLength, 30) : 40
  if (binaries.has(type)) return column.maxLength ? Math.min(2 + 2 * column.maxLength, 40) : 40
  return 40
}

/**
 * The column's SQL type as a header shows it, SSMS's way of writing it: nvarchar(50), varchar(max), decimal(18,2),
 * datetimeoffset(7), int. Types SQL Server reports without a length (xml, text, CLR types) are their names.
 */
export function sqlTypeLabel(column: Pick<ResultColumn, 'dataType' | 'maxLength' | 'precision' | 'scale'>): string {
  const type = column.dataType.toLowerCase()
  if (characters.has(type) || binaries.has(type)) return `${type}(${column.maxLength ?? 'max'})`
  if (type === 'decimal' || type === 'numeric') return column.precision !== undefined ? `${type}(${column.precision},${column.scale ?? 0})` : type
  if (Object.hasOwn(scaled, type)) return column.scale !== undefined ? `${type}(${column.scale})` : type
  return type
}

/** A column's width before the user sizes it: its header or its type hint, between 40 and 400 px. */
export function initialWidth(headerTextWidth: number, chars: number, charWidth: number): number {
  return clamp(Math.max(Math.ceil(headerTextWidth) + g.cellChrome, Math.ceil(chars * charWidth) + g.cellChrome), g.initialMinWidth, g.initialMaxWidth)
}
/** A double-click on a header border fits the header and the widest display text measured, between 32 and 3,000 px. */
export function fitWidth(headerTextWidth: number, chars: number, charWidth: number): number {
  return clamp(Math.max(Math.ceil(headerTextWidth) + g.cellChrome, Math.ceil(chars * charWidth) + g.cellChrome), g.columnMinWidth, g.columnMaxWidth)
}
/** The width of one digit in the grid font, from a measurement of 100 of them; a typical 12 px monospace digit if it fails. */
export function measureCharWidth(measure: (text: string) => number): number {
  const width = measure('0'.repeat(100)) / 100
  return Number.isFinite(width) && width > 0 ? width : 7.2
}

// East Asian wide and fullwidth characters, and emoji shown as emoji by default, take two columns; combining marks
// and format characters (joiners, variation selectors) take none.
const wide = /[\p{Emoji_Presentation}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u
const zero = /[\p{Mn}\p{Me}\p{Cf}]/u

/** The columns `text` takes in a monospace font, at most `cap`. Characters below U+0300 take one each without a lookup. */
export function displayColumns(text: string, cap: number = g.measureCap): number {
  let width = 0
  for (let index = 0; index < text.length && width < cap; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x300) { width++; continue }
    let char = text[index]
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) { char = text.slice(index, index + 2); index++ }
    }
    width += wide.test(char) ? 2 : zero.test(char) ? 0 : 1
  }
  return Math.min(width, cap)
}
