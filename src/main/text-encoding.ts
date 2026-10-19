// How SQL files' bytes become text and back: Unicode with or without a byte order mark, UTF-16 without one, and the
// system's ANSI code page as a read-only fallback. Pure, so tests cover it without Electron.
import type { FileEncoding, LineEnding } from '../shared/contracts'

export interface DecodedText { readonly text: string; readonly encoding: FileEncoding; readonly codePage?: string }
/** Builds a strict decoder; ICU without a converter for `label` throws a RangeError. Injected so tests can take one away. */
export type DecoderFactory = (label: string) => TextDecoder

const strictDecoder: DecoderFactory = label => new TextDecoder(label, { fatal: true, ignoreBOM: true })
/** BOM-less UTF-16 is detected from at most this many leading bytes. */
const sniffBytes = 4096

/** The display name of a WHATWG label, as the status bar and prompts show it: 'Windows-1252', 'Shift_JIS'. */
export function codePageName(label: string): string {
  const names: Readonly<Record<string, string>> = { shift_jis: 'Shift_JIS', gbk: 'GBK', big5: 'Big5', 'euc-kr': 'EUC-KR' }
  return names[label] ?? label.replace(/^windows-/, 'Windows-')
}

/**
 * The ANSI code page Windows uses for `locale` (Electron's `app.getSystemLocale()`, such as 'en-US' or 'zh-Hant-TW'),
 * as a WHATWG encoding label. Linux and macOS use the same table, since files in a legacy code page usually come from
 * Windows. Anything unknown is Windows-1252.
 */
export function legacyCodePage(locale: string): string {
  const parts = locale.replace(/_/g, '-').split(/[-.@]/).filter(Boolean).map(part => part.toLowerCase())
  const language = parts[0] ?? '', rest = new Set(parts.slice(1))
  if (language === 'zh') return rest.has('hant') || rest.has('tw') || rest.has('hk') || rest.has('mo') ? 'big5' : 'gbk'
  if (language === 'sr') return rest.has('latn') ? 'windows-1250' : 'windows-1251'
  const table: Readonly<Record<string, string>> = {
    cs: 'windows-1250', pl: 'windows-1250', hu: 'windows-1250', sk: 'windows-1250', sl: 'windows-1250', hr: 'windows-1250', ro: 'windows-1250', sq: 'windows-1250', bs: 'windows-1250',
    ru: 'windows-1251', uk: 'windows-1251', be: 'windows-1251', bg: 'windows-1251', mk: 'windows-1251', kk: 'windows-1251',
    el: 'windows-1253', tr: 'windows-1254', az: 'windows-1254', he: 'windows-1255', ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256',
    et: 'windows-1257', lv: 'windows-1257', lt: 'windows-1257', vi: 'windows-1258', th: 'windows-874', ja: 'shift_jis', ko: 'euc-kr'
  }
  return table[language] ?? 'windows-1252'
}

/** Whether `bytes` look like UTF-16 without a BOM: mostly NULs in one byte of each pair and almost none in the other. */
function utf16Order(bytes: Uint8Array): 'le' | 'be' | undefined {
  const length = Math.min(bytes.length, sniffBytes) & ~1
  if (length < 2 || bytes.length % 2) return undefined
  let even = 0, odd = 0
  for (let index = 0; index < length; index += 2) {
    if (bytes[index] === 0) even++
    if (bytes[index + 1] === 0) odd++
  }
  const pairs = length / 2
  if (odd > pairs * 0.4 && even < pairs * 0.05) return 'le'
  if (even > pairs * 0.4 && odd < pairs * 0.05) return 'be'
  return undefined
}

/** UTF-16 BE as LE: a byte-swapped copy, so the caller's buffer is never changed. */
function swapped(bytes: Uint8Array): Buffer {
  const copy = Buffer.from(bytes)
  return copy.length % 2 ? copy : copy.swap16()
}

function attempt(decode: () => string): string | undefined {
  try { return decode() } catch { return undefined }
}

/**
 * Decodes a SQL file's bytes. In order: a UTF-32 byte order mark is refused; a UTF-8 or UTF-16 one decides; text that
 * is valid UTF-8 is UTF-8; text that looks like BOM-less UTF-16 and decodes as it is UTF-16; anything else is read in
 * `legacyLabel`, the system's ANSI code page. Every decode is strict, so a byte that does not belong never becomes U+FFFD,
 * and saving unchanged text writes the same bytes. Text that still holds NUL is not a SQL script.
 */
export function detectAndDecode(bytes: Uint8Array, legacyLabel: string, decoder: DecoderFactory = strictDecoder): DecodedText {
  const [a, b, c, d] = bytes
  if ((a === 0xff && b === 0xfe && c === 0 && d === 0) || (a === 0 && b === 0 && c === 0xfe && d === 0xff)) throw new Error('UTF-32 files are not supported. Save the file as UTF-8 or UTF-16 first.')
  let decoded: DecodedText | undefined
  const invalid = (name: string) => new Error(`This file starts with a ${name} byte order mark but is not valid ${name} text.`)
  if (a === 0xef && b === 0xbb && c === 0xbf) {
    const text = attempt(() => decoder('utf-8').decode(bytes.subarray(3)))
    if (text === undefined) throw invalid('UTF-8')
    decoded = { text, encoding: 'utf8bom' }
  } else if (a === 0xff && b === 0xfe) {
    const text = attempt(() => decoder('utf-16le').decode(bytes.subarray(2)))
    if (text === undefined) throw invalid('UTF-16')
    decoded = { text, encoding: 'utf16le' }
  } else if (a === 0xfe && b === 0xff) {
    const text = attempt(() => decoder('utf-16le').decode(swapped(bytes.subarray(2))))
    if (text === undefined) throw invalid('UTF-16')
    decoded = { text, encoding: 'utf16be' }
  } else {
    const utf8 = attempt(() => decoder('utf-8').decode(bytes))
    const order = utf8 === undefined || utf8.includes('\0') ? utf16Order(bytes) : undefined
    const utf16 = order ? attempt(() => decoder('utf-16le').decode(order === 'le' ? bytes : swapped(bytes))) : undefined
    // Without its byte order mark, so a save writes none either.
    if (order && utf16 !== undefined) decoded = { text: utf16, encoding: order === 'le' ? 'utf16leNoBom' : 'utf16beNoBom' }
    else if (utf8 !== undefined) decoded = { text: utf8, encoding: 'utf8' }
    else decoded = decodeLegacy(bytes, legacyLabel, decoder)
  }
  if (decoded.text.includes('\0')) throw new Error('This file is not a supported SQL text file. Use UTF-8 or UTF-16.')
  return decoded
}

function decodeLegacy(bytes: Uint8Array, label: string, decoder: DecoderFactory): DecodedText {
  const name = codePageName(label)
  let strict: TextDecoder
  // Electron's ICU may lack a converter: the file is refused rather than guessed at.
  try { strict = decoder(label) } catch { throw new Error(`This file is not UTF-8 or UTF-16, and its ${name} encoding cannot be read here. Save it as UTF-8 first.`) }
  const text = attempt(() => strict.decode(bytes))
  if (text === undefined) throw new Error(`This file is not UTF-8, UTF-16 or ${name} text.`)
  return { text, encoding: 'legacy', codePage: name }
}

/** The bytes of `text` in `encoding`, with its byte order mark if it has one. A legacy code page is never written. */
export function encodeText(text: string, encoding: FileEncoding): Buffer {
  switch (encoding) {
    case 'utf8': return Buffer.from(text, 'utf8')
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be': return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
    case 'utf16leNoBom': return Buffer.from(text, 'utf16le')
    case 'utf16beNoBom': return Buffer.from(text, 'utf16le').swap16()
    default: throw new Error('Varia SQL Manager saves only Unicode.')
  }
}

/**
 * The line ending a file uses: the most common of CRLF and LF (a bare CR counts as neither), the platform's own when
 * there is no line break, and whether more than one kind occurs.
 */
export function detectEol(text: string, platform: NodeJS.Platform | string = process.platform): { eol: LineEnding; mixed: boolean } {
  let crlf = 0, lf = 0, cr = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 13) { if (text.charCodeAt(index + 1) === 10) { crlf++; index++ } else cr++ }
    else if (code === 10) lf++
  }
  const fallback: LineEnding = platform === 'win32' ? 'crlf' : 'lf'
  const eol: LineEnding = crlf > lf ? 'crlf' : lf > crlf ? 'lf' : crlf ? 'crlf' : fallback
  return { eol, mixed: [crlf, lf, cr].filter(Boolean).length > 1 || (cr > 0 && !crlf && !lf) }
}

