import { describe, expect, it } from 'vitest'
import { copyName, maxSelectTopScriptLength, quoteName, selectTopRowsScript } from '../src/shared/sql/identifiers'

const header = '/****** Script for SelectTopNRows command from Varia SQL Manager ******/'
const columns = (...names: string[]) => names.map(name => ({ name, dataType: 'int' }))

describe('quoteName', () => {
  it('brackets names and doubles closing brackets, as QUOTENAME does', () => {
    expect(quoteName('Orders')).toBe('[Orders]')
    expect(quoteName('na]me')).toBe('[na]]me]')
    expect(quoteName(']]')).toBe('[]]]]]')
    expect(quoteName("O'Brien; DROP TABLE x--")).toBe("[O'Brien; DROP TABLE x--]")
    expect(quoteName('[a]')).toBe('[[a]]]')
    expect(quoteName('line\nbreak\ttab')).toBe('[line\nbreak\ttab]')
    expect(quoteName('Ünïcödé ✓ 表')).toBe('[Ünïcödé ✓ 表]')
  })
  it('accepts sysname lengths only', () => {
    expect(quoteName('a'.repeat(128))).toBe(`[${'a'.repeat(128)}]`)
    expect(() => quoteName('a'.repeat(129))).toThrow('limited to 128 characters')
    // Lengths are UTF-16 units, as in nvarchar(128): 64 astral characters fill it.
    expect(() => quoteName('𝒜'.repeat(64))).not.toThrow()
    expect(() => quoteName('𝒜'.repeat(64) + 'a')).toThrow('limited to 128 characters')
    expect(() => quoteName('')).toThrow('cannot be empty')
  })
})

describe('selectTopRowsScript', () => {
  const source = { database: 'AppData', schema: 'dbo', name: 'Orders', columns: columns('Id', 'CustomerName'), truncated: false }
  it('lists the columns as SSMS does', () => {
    expect(selectTopRowsScript(source)).toBe([header, 'SELECT TOP (1000) [Id]', '      ,[CustomerName]', '  FROM [AppData].[dbo].[Orders]'].join('\n'))
    expect(selectTopRowsScript({ ...source, columns: columns('only') }, 50)).toBe([header, 'SELECT TOP (50) [only]', '  FROM [AppData].[dbo].[Orders]'].join('\n'))
    expect(selectTopRowsScript({ database: 'my]db', schema: "o'neil", name: 'na]me', columns: columns('id', 'na]me'), truncated: false })).toBe(
      [header, 'SELECT TOP (1000) [id]', '      ,[na]]me]', "  FROM [my]]db].[o'neil].[na]]me]"].join('\n'))
  })
  it('selects * when the column list is incomplete, empty, or too long', () => {
    const star = [header, 'SELECT TOP (1000) *', '  FROM [AppData].[dbo].[Orders]'].join('\n')
    expect(selectTopRowsScript({ ...source, truncated: true })).toBe(star)
    expect(selectTopRowsScript({ ...source, columns: [] })).toBe(star)
    const long = Array.from({ length: Math.ceil(maxSelectTopScriptLength / 128) }, (_, index) => `${index}`.padEnd(120, 'x'))
    expect(selectTopRowsScript({ ...source, columns: columns(...long) })).toBe(star)
    const fits = selectTopRowsScript({ ...source, columns: columns(...long.slice(0, 7000)) })
    expect(fits.length).toBeLessThanOrEqual(maxSelectTopScriptLength)
    expect(fits.split('\n')[1]).toBe('SELECT TOP (1000) [0' + 'x'.repeat(119) + ']')
  })
  it('rejects invalid counts and names', () => {
    for (const count of [0, -1, 1.5, Number.NaN, Infinity]) expect(() => selectTopRowsScript(source, count), String(count)).toThrow('positive integer')
    expect(() => selectTopRowsScript({ ...source, schema: '' })).toThrow('cannot be empty')
    expect(() => selectTopRowsScript({ ...source, columns: columns('a'.repeat(129)) })).toThrow('limited to 128 characters')
  })
})

describe('copyName', () => {
  it('copies the server as connected to, and quoted object names', () => {
    const connection = { server: 'sql01.example,1433' }
    expect(copyName({ kind: 'server' }, connection)).toBe('sql01.example,1433')
    expect(copyName({ kind: 'database', database: 'App]Data' }, connection)).toBe('[App]]Data]')
    expect(copyName({ kind: 'table', schema: 'dbo', name: 'Order Lines' }, connection)).toBe('[dbo].[Order Lines]')
    expect(copyName({ kind: 'serverObject', name: 'NT AUTHORITY\\SYSTEM' }, connection)).toBe('[NT AUTHORITY\\SYSTEM]')
  })
})
