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
    for (const stem of ['CON', 'prn', 'Aux', 'nul', 'COM0', 'COM1', 'com9', 'LPT0', 'LPT1', 'lpt9', 'COM\u00b9', 'lpt\u00b3', 'CONIN$', 'conout$']) {
      expect(sanitizeFileName(`${stem}.sql`), stem).toBe(`_${stem}.sql`)
      expect(sanitizeFileName(stem), stem).toBe(`_${stem}`)
    }
    expect(sanitizeFileName('NUL  .sql')).toBe('_NUL  .sql')
    for (const name of ['CONSOLE.sql', 'com10.sql', 'lpt.sql', 'dbo.CON.sql', 'CONIN.sql', 'COM\u2074.sql']) expect(sanitizeFileName(name), name).toBe(name)
  })
  it('checks reserved names after cutting a long one, so the cut never leaves one', () => {
    expect(sanitizeFileName('CON' + ' '.repeat(125) + '.' + ' '.repeat(128) + '.sql')).toBe('_CON.sql')
    const cut = sanitizeFileName('LPT1.' + 'x'.repeat(300) + '.sql')
    expect(cut.startsWith('_LPT1.x') && cut.endsWith('x.sql') && cut.length === 200).toBe(true)
  })
  it('keeps at most 240 UTF-8 bytes, which ext4 and APFS can store, cutting between code points', () => {
    const utf8 = (text: string) => Buffer.byteLength(text)
    const cjk = sanitizeFileName('dbo.' + '\u6ce8\u6587'.repeat(50) + '.sql')
    expect(utf8(cjk)).toBeLessThanOrEqual(240)
    expect(cjk).toMatch(/^dbo\.(\u6ce8\u6587)+\u6ce8?\.sql$/)
    const emoji = sanitizeFileName('Sales.' + '\u{1F600}'.repeat(80) + '.sql')
    expect(utf8(emoji)).toBeLessThanOrEqual(240)
    expect(utf8(emoji)).toBeGreaterThan(230)
    expect(emoji.endsWith('\u{1F600}.sql')).toBe(true)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false)
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
