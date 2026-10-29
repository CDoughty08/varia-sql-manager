import { describe, expect, it } from 'vitest'
import type { ResultColumn } from '../src/shared/contracts'
import { displayColumns, fitWidth, initialWidth, measureCharWidth, sqlTypeLabel, typeHintChars } from '../src/renderer/src/grid/measure'

const column = (dataType: string, extra: Partial<ResultColumn> = {}) => ({ dataType, ...extra })

describe('column measuring', () => {
  it('writes each column\'s SQL type as its header shows it', () => {
    expect(sqlTypeLabel(column('int'))).toBe('int')
    expect(sqlTypeLabel(column('nvarchar', { maxLength: 50 }))).toBe('nvarchar(50)')
    expect(sqlTypeLabel(column('VARCHAR'))).toBe('varchar(max)')
    expect(sqlTypeLabel(column('varbinary', { maxLength: 16 }))).toBe('varbinary(16)')
    expect(sqlTypeLabel(column('char', { maxLength: 1 }))).toBe('char(1)')
    expect(sqlTypeLabel(column('decimal', { precision: 18, scale: 2 }))).toBe('decimal(18,2)')
    expect(sqlTypeLabel(column('numeric', { precision: 10 }))).toBe('numeric(10,0)')
    expect(sqlTypeLabel(column('decimal'))).toBe('decimal')
    expect(sqlTypeLabel(column('datetimeoffset', { scale: 7 }))).toBe('datetimeoffset(7)')
    expect(sqlTypeLabel(column('time', { scale: 0 }))).toBe('time(0)')
    expect(sqlTypeLabel(column('datetime2'))).toBe('datetime2')
    expect(sqlTypeLabel(column('xml'))).toBe('xml')
    expect(sqlTypeLabel(column('hierarchyid'))).toBe('hierarchyid')
  })
  it('estimates characters from the declared type, as SSMS displays each type', () => {
    const hints = Object.fromEntries([
      'bit', 'tinyint', 'smallint', 'int', 'bigint', 'money', 'smallmoney', 'real', 'float', 'date', 'datetime', 'smalldatetime', 'uniqueidentifier'
    ].map(type => [type, typeHintChars(column(type))]))
    expect(hints).toEqual({ bit: 1, tinyint: 3, smallint: 6, int: 11, bigint: 20, money: 21, smallmoney: 12, real: 14, float: 24, date: 10, datetime: 23, smalldatetime: 19, uniqueidentifier: 36 })
    expect(typeHintChars(column('INT'))).toBe(11)
    expect(typeHintChars(column('decimal', { precision: 18, scale: 2 }))).toBe(20)
    expect(typeHintChars(column('numeric', { precision: 38, scale: 0 }))).toBe(40)
    expect(typeHintChars(column('decimal'))).toBe(20)
    // time(n), datetime2(n) and datetimeoffset(n) grow with their fractional digits.
    expect([0, 3, 7].map(scale => typeHintChars(column('time', { scale })))).toEqual([9, 12, 16])
    expect([0, 7].map(scale => typeHintChars(column('datetime2', { scale })))).toEqual([20, 27])
    expect(typeHintChars(column('datetimeoffset', { scale: 7 }))).toBe(34)
    expect(typeHintChars(column('datetime2'))).toBe(27)
    expect([typeHintChars(column('nvarchar', { maxLength: 10 })), typeHintChars(column('varchar', { maxLength: 200 })), typeHintChars(column('nchar', { maxLength: 1 })), typeHintChars(column('nvarchar'))]).toEqual([10, 30, 1, 40])
    expect([typeHintChars(column('binary', { maxLength: 4 })), typeHintChars(column('varbinary', { maxLength: 100 })), typeHintChars(column('varbinary'))]).toEqual([10, 40, 40])
    for (const other of [column('xml', { role: 'xml' }), column('nvarchar', { role: 'json' }), column('nvarchar', { role: 'plan' }), column('sql_variant'), column('hierarchyid', { role: 'udt' }), column('geography')]) expect(typeHintChars(other), other.dataType).toBe(40)
  })
  it('sizes columns before rows between 40 and 400 px, and a double-click fit between 32 and 3,000', () => {
    // The wider of the header and the type hint, plus padding and the gridline.
    expect(initialWidth(30, 11, 7)).toBe(11 * 7 + 13)
    expect(initialWidth(150.2, 1, 7)).toBe(151 + 13)
    expect(initialWidth(0, 1, 7)).toBe(40)
    expect(initialWidth(0, 512, 7)).toBe(400)
    expect(initialWidth(900, 1, 7)).toBe(400)
    expect(fitWidth(0, 0, 7)).toBe(32)
    expect(fitWidth(10, 2, 7)).toBe(32)
    expect(fitWidth(0, 100, 7.25)).toBe(725 + 13)
    expect(fitWidth(0, 400, 7.2)).toBe(2880 + 13)
    // 512 characters (the display cap) are wider than the widest column.
    expect(fitWidth(0, 512, 7.2)).toBe(3000)
    expect(fitWidth(5000, 0, 7)).toBe(3000)
  })
  it('measures the grid font from 100 digits, with a fallback when measuring fails', () => {
    const asked: string[] = []
    expect(measureCharWidth(text => { asked.push(text); return text.length * 7.25 })).toBe(7.25)
    expect(asked).toEqual(['0'.repeat(100)])
    expect([measureCharWidth(() => 0), measureCharWidth(() => Number.NaN), measureCharWidth(() => -5)]).toEqual([7.2, 7.2, 7.2])
  })
  it('counts display columns: wide East Asian characters and emoji as two, combining marks and joiners as none', () => {
    expect(displayColumns('')).toBe(0)
    expect(displayColumns('Customer 0000000042 GmbH')).toBe(24)
    expect(displayColumns('Société')).toBe(7)
    expect(displayColumns('日本語')).toBe(6)
    expect(displayColumns('한국어')).toBe(6)
    expect(displayColumns('ＡＢ')).toBe(4)
    expect(displayColumns('a😀b')).toBe(4)
    // e + combining acute, then a family joined by zero-width joiners: three wide emoji.
    expect(displayColumns('é')).toBe(1)
    expect(displayColumns('👨‍👩‍👧')).toBe(6)
    expect(displayColumns('\u{20000}x')).toBe(3)
    expect(displayColumns('Привет')).toBe(6)
    expect(displayColumns('�')).toBe(1)
    // A lone surrogate is one column, and the count stops at the cap.
    expect(displayColumns('\ud800x')).toBe(2)
    expect(displayColumns('x'.repeat(10_000))).toBe(512)
    expect(displayColumns('日'.repeat(1000), 100)).toBe(100)
  })
})
