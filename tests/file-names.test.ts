import { describe, expect, it } from 'vitest'
import { sanitizeFileName } from '../src/main/file-names'

describe('sanitizeFileName', () => {
  it('keeps ordinary names, Unicode included', () => {
    for (const name of ['dbo.Orders.sql', 'Sales.Order Lines.sql', 'dbo.Über_Tabelle.sql', 'データ.表.sql', "dbo.O'Brien.sql", '.hidden.sql']) expect(sanitizeFileName(name)).toBe(name)
  })
  it('replaces characters Windows forbids, path separators, and invisible or reordering characters', () => {
    expect(sanitizeFileName('dbo.a/b\\c:d*e?f"g<h>i|j.sql')).toBe('dbo.a_b_c_d_e_f_g_h_i_j.sql')
    expect(sanitizeFileName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeFileName('dbo.x*/ DROP TABLE dbo.Victim /*.sql')).toBe('dbo.x__ DROP TABLE dbo.Victim __.sql')
    for (const character of ['\u0000', '\u0007', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\ufeff']) {
      expect(sanitizeFileName(`dbo.a${character}b.sql`), JSON.stringify(character)).toBe('dbo.a_b.sql')
    }
  })
  it('trims trailing dots and spaces, which Windows drops', () => {
    expect(sanitizeFileName('dbo.Orders. . ')).toBe('dbo.Orders')
    expect(sanitizeFileName('name...')).toBe('name')
  })
  it('prefixes reserved Windows device names, in any case and with any extension', () => {
    for (const stem of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(sanitizeFileName(`${stem}.sql`), stem).toBe(`_${stem}.sql`)
      expect(sanitizeFileName(stem), stem).toBe(`_${stem}`)
    }
    for (const name of ['CONSOLE.sql', 'com0.sql', 'com10.sql', 'lpt.sql', 'dbo.CON.sql']) expect(sanitizeFileName(name), name).toBe(name)
  })
  it('keeps at most 200 UTF-16 units with the extension, never splitting a surrogate pair', () => {
    const long = sanitizeFileName('dbo.' + 'x'.repeat(300) + '.sql')
    expect(long).toHaveLength(200)
    expect(long).toMatch(/^dbo\.x+\.sql$/)
    // A pair would straddle the cut: the whole pair goes.
    const pairs = sanitizeFileName('a' + '😀'.repeat(150) + '.sql')
    expect(pairs.length).toBeLessThanOrEqual(200)
    expect(pairs.endsWith('😀.sql')).toBe(true)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(pairs)).toBe(false)
    expect(sanitizeFileName('x'.repeat(250)).length).toBe(200)
  })
  it('falls back to Script.sql when nothing is left', () => {
    for (const name of ['', '...', '   ', '. .', '.']) expect(sanitizeFileName(name), JSON.stringify(name)).toBe('Script.sql')
  })
})
