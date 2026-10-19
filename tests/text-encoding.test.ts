import { describe, expect, it } from 'vitest'
import { codePageName, detectAndDecode, detectEol, encodeText, legacyCodePage, type DecoderFactory } from '../src/main/text-encoding'
import type { FileEncoding } from '../src/shared/contracts'
import { encodingLabel } from '../src/shared/files/encoding'

const bytes = (...values: number[]) => Uint8Array.from(values)
const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16()
const decode = (data: Uint8Array, label = 'windows-1252') => detectAndDecode(data, label)

describe('detecting and decoding SQL files', () => {
  it('decides by the byte order mark, then strict UTF-8, then BOM-less UTF-16, then the ANSI code page', () => {
    const text = "SELECT N'Grüße 日本';\r\n"
    const cases: [string, Buffer, FileEncoding][] = [
      ['UTF-8', Buffer.from(text), 'utf8'],
      ['UTF-8 with BOM', Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from(text)]), 'utf8bom'],
      ['UTF-16 LE with BOM', Buffer.concat([bytes(0xff, 0xfe), Buffer.from(text, 'utf16le')]), 'utf16le'],
      ['UTF-16 BE with BOM', Buffer.concat([bytes(0xfe, 0xff), utf16be(text)]), 'utf16be'],
      ['UTF-16 LE without BOM', Buffer.from(text, 'utf16le'), 'utf16le'],
      ['UTF-16 BE without BOM', utf16be(text), 'utf16be']
    ]
    for (const [name, data, encoding] of cases) expect(decode(data), name).toEqual({ text, encoding })
    expect(decode(new Uint8Array())).toEqual({ text: '', encoding: 'utf8' })
    // é and the euro sign in Windows-1252, which are not valid UTF-8.
    expect(decode(Buffer.from([0x53, 0xe9, 0x80]))).toEqual({ text: 'Sé€', encoding: 'legacy', codePage: 'Windows-1252' })
    expect(decode(Buffer.from([0x82, 0xa0]), 'shift_jis')).toEqual({ text: 'あ', encoding: 'legacy', codePage: 'Shift_JIS' })
  })
  it('keeps a second byte order mark as text, so it is written back', () => {
    expect(decode(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41]))).toEqual({ text: '﻿A', encoding: 'utf8bom' })
    expect(decode(Buffer.from([0xff, 0xfe, 0xff, 0xfe, 0x41, 0]))).toEqual({ text: '﻿A', encoding: 'utf16le' })
  })
  it('detects BOM-less UTF-16 only from mostly NUL bytes on one side of each pair', () => {
    // ASCII in UTF-16: every other byte is NUL.
    expect(decode(Buffer.from('SELECT 1;', 'utf16le')).encoding).toBe('utf16le')
    // An odd length is not UTF-16, and NUL in UTF-8 text is not SQL.
    expect(() => decode(Buffer.concat([Buffer.from('SELECT 1;', 'utf16le'), bytes(0x41)]))).toThrow('not a supported SQL text file')
    // NULs on both sides (binary data) is neither.
    expect(() => decode(bytes(0, 0, 0x41, 0, 0, 0x42, 0x43, 0))).toThrow('not a supported SQL text file')
    // Mostly CJK text has few NUL bytes, so it is not taken for UTF-16 without a BOM; it is valid UTF-8 here.
    expect(decode(Buffer.from('日本語のテキスト')).encoding).toBe('utf8')
    // Only the first 4 KiB are sampled: a long ASCII UTF-16 text is still detected.
    expect(decode(Buffer.from('x'.repeat(10_000) + 'é', 'utf16le')).encoding).toBe('utf16le')
  })
  it('refuses UTF-32, a BOM that does not match its text, and text that holds NUL', () => {
    expect(() => decode(bytes(0xff, 0xfe, 0, 0, 0x41, 0, 0, 0))).toThrow('UTF-32 files are not supported. Save the file as UTF-8 or UTF-16 first.')
    expect(() => decode(bytes(0, 0, 0xfe, 0xff, 0, 0, 0, 0x41))).toThrow('UTF-32 files are not supported')
    expect(() => decode(bytes(0xef, 0xbb, 0xbf, 0xc3, 0x28))).toThrow('starts with a UTF-8 byte order mark but is not valid UTF-8 text')
    expect(() => decode(bytes(0xff, 0xfe, 0x41))).toThrow('starts with a UTF-16 byte order mark but is not valid UTF-16 text')
    // An unpaired surrogate is invalid UTF-16; strict decoding never turns it into U+FFFD.
    expect(() => decode(bytes(0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00))).toThrow('not valid UTF-16')
    expect(() => decode(Buffer.from('SELECT 1;\0'))).toThrow('This file is not a supported SQL text file. Use UTF-8 or UTF-16.')
    expect(() => decode(Buffer.from([0x81, 0x20]), 'shift_jis')).toThrow('This file is not UTF-8, UTF-16 or Shift_JIS text.')
  })
  it('refuses a legacy file when Electron\'s ICU has no converter for the code page, rather than guess', () => {
    const noLegacy: DecoderFactory = label => {
      if (label === 'utf-8' || label === 'utf-16le') return new TextDecoder(label, { fatal: true, ignoreBOM: true })
      throw new RangeError(`The "${label}" encoding is not supported`)
    }
    expect(() => detectAndDecode(Buffer.from([0x82, 0xa0]), 'shift_jis', noLegacy)).toThrow('This file is not UTF-8 or UTF-16, and its Shift_JIS encoding cannot be read here. Save it as UTF-8 first.')
    // Unicode files never need the converter.
    expect(detectAndDecode(Buffer.from('SELECT 1'), 'shift_jis', noLegacy)).toEqual({ text: 'SELECT 1', encoding: 'utf8' })
  })
  it('has a strict decoder for every code page the locale table names, in Node as in Electron\'s main process', () => {
    const labels = [...new Set(['en-US', 'cs', 'ru', 'el', 'tr', 'he', 'ar', 'lt', 'vi', 'th', 'ja', 'zh-CN', 'zh-TW', 'ko'].map(legacyCodePage))]
    expect(labels).toHaveLength(14)
    for (const label of labels) expect(() => new TextDecoder(label, { fatal: true }), label).not.toThrow()
  })
})

describe('writing SQL files', () => {
  it('writes the bytes it read for every Unicode encoding, with and without a final line break', () => {
    for (const text of ["SELECT N'Grüße 😀';\r\nGO", "SELECT N'Grüße 😀';\r\nGO\r\n", '', '﻿']) {
      const files: [FileEncoding, Buffer][] = [
        ['utf8', Buffer.from(text)], ['utf8bom', Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from(text)])],
        ['utf16le', Buffer.concat([bytes(0xff, 0xfe), Buffer.from(text, 'utf16le')])], ['utf16be', Buffer.concat([bytes(0xfe, 0xff), utf16be(text)])]
      ]
      for (const [encoding, data] of files) {
        // An empty UTF-8 file has nothing to detect; it is UTF-8.
        if (encoding === 'utf8' && text === '﻿') continue
        const decoded = decode(data)
        expect(decoded, `${encoding} ${JSON.stringify(text)}`).toEqual({ text, encoding: data.length || encoding === 'utf8' ? encoding : 'utf8' })
        if (data.length) expect(encodeText(decoded.text, decoded.encoding).equals(data), `${encoding} ${JSON.stringify(text)}`).toBe(true)
      }
    }
  })
  it('never writes a legacy code page', () => {
    expect(() => encodeText('Sé', 'legacy')).toThrow('Varia SQL Manager saves only Unicode.')
  })
})

describe('the ANSI code page of a locale', () => {
  it('follows Windows\' table for the language, and the script or region where they differ', () => {
    const table: Readonly<Record<string, string>> = {
      'en-US': 'windows-1252', fr: 'windows-1252', 'de-DE': 'windows-1252', 'pt-BR': 'windows-1252', '': 'windows-1252', C: 'windows-1252',
      'pl-PL': 'windows-1250', hu: 'windows-1250', 'sr-Latn-RS': 'windows-1250', 'sr-Cyrl-RS': 'windows-1251', sr: 'windows-1251',
      'ru-RU': 'windows-1251', uk: 'windows-1251', kk: 'windows-1251', 'el-GR': 'windows-1253', tr: 'windows-1254', az: 'windows-1254', he: 'windows-1255',
      'ar-SA': 'windows-1256', fa: 'windows-1256', et: 'windows-1257', lv: 'windows-1257', vi: 'windows-1258', th: 'windows-874', 'ja-JP': 'shift_jis', 'ko-KR': 'euc-kr',
      'zh-CN': 'gbk', 'zh-SG': 'gbk', 'zh-Hans': 'gbk', zh: 'gbk', 'zh-TW': 'big5', 'zh-HK': 'big5', 'zh-Hant-TW': 'big5', zh_TW: 'big5', 'ja_JP.UTF-8': 'shift_jis'
    }
    for (const [locale, label] of Object.entries(table)) expect(legacyCodePage(locale), locale).toBe(label)
  })
  it('names code pages as the status bar shows them', () => {
    expect(['windows-1252', 'windows-874', 'shift_jis', 'gbk', 'big5', 'euc-kr'].map(codePageName)).toEqual(['Windows-1252', 'Windows-874', 'Shift_JIS', 'GBK', 'Big5', 'EUC-KR'])
    expect(['utf8', 'utf8bom', 'utf16le', 'utf16be'].map(encoding => encodingLabel(encoding as FileEncoding))).toEqual(['UTF-8', 'UTF-8 with BOM', 'UTF-16 LE', 'UTF-16 BE'])
    expect(encodingLabel('legacy', 'Windows-1252')).toBe('Windows-1252')
  })
})

describe('line endings', () => {
  it('takes the most common of CRLF and LF, and the platform\'s when there is none', () => {
    expect(detectEol('a\r\nb\r\n', 'linux')).toEqual({ eol: 'crlf', mixed: false })
    expect(detectEol('a\nb\n', 'win32')).toEqual({ eol: 'lf', mixed: false })
    expect(detectEol('a\r\nb\nc\r\n', 'linux')).toEqual({ eol: 'crlf', mixed: true })
    expect(detectEol('a\nb\nc\r\n', 'win32')).toEqual({ eol: 'lf', mixed: true })
    // A tie keeps CRLF, SQL Server tools' line ending.
    expect(detectEol('a\nb\r\n', 'linux')).toEqual({ eol: 'crlf', mixed: true })
    // A bare CR (classic Mac OS) cannot be kept: the editor treats it as a line break and writes the other kind.
    expect(detectEol('a\rb\r', 'linux')).toEqual({ eol: 'lf', mixed: true })
    expect(detectEol('a\rb\r\n', 'linux')).toEqual({ eol: 'crlf', mixed: true })
    expect(detectEol('SELECT 1', 'win32')).toEqual({ eol: 'crlf', mixed: false })
    expect(detectEol('SELECT 1', 'darwin')).toEqual({ eol: 'lf', mixed: false })
    expect(detectEol('', 'linux')).toEqual({ eol: 'lf', mixed: false })
  })
})
