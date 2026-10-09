import { gridLimits as g } from '../grid/constants'

// Pretty-printers for XML, JSON and plan values opened from the grid. They run in the results worker on untrusted
// text, so both are single-pass tokenizers: linear, iterative (no recursion), bounded in nesting and output, and
// never interpreting anything. XML entities and DTDs are copied, never expanded; JSON numbers and strings are copied
// verbatim. Anything malformed or over a bound comes back as the raw text with `formatted: false`.

export interface Formatted { readonly text: string; readonly formatted: boolean }
export interface FormatOptions { readonly maxChars?: number; readonly maxDepth?: number }

class Malformed {}
const malformed = new Malformed()
const raw = (text: string): Formatted => ({ text, formatted: false })

class Output {
  private readonly parts: string[] = []
  private length = 0
  constructor(private readonly max: number) {}
  push(part: string): void {
    this.length += part.length
    if (this.length > this.max) throw malformed
    this.parts.push(part)
  }
  text(): string { return this.parts.join('') }
}
const indents: string[] = ['']
const indent = (depth: number): string => indents[depth] ??= '  '.repeat(depth)
const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

// XML token kinds.
const Text = 0, Start = 1, End = 2, Empty = 3, Comment = 4, Pi = 5, CData = 6, Declaration = 7
const LT = 0x3c, GT = 0x3e, SLASH = 0x2f, QUOTE = 0x22, APOS = 0x27, OPEN_BRACKET = 0x5b, CLOSE_BRACKET = 0x5d

function nameEnd(text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (isSpace(code) || code === GT || code === SLASH) break
    if (code === LT || code === QUOTE || code === APOS || code === 0x3d || code === 0x21 || code === 0x3f) throw malformed
    index++
  }
  if (index === from) throw malformed
  return index
}
/** The index of the `>` that closes a start tag or declaration, skipping quoted values (and, in a DOCTYPE, its internal subset). */
function tagEnd(text: string, from: number, subset: boolean): number {
  let quote = 0, brackets = 0
  for (let index = from; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (quote) { if (code === quote) quote = 0; continue }
    if (code === QUOTE || code === APOS) quote = code
    else if (subset && code === OPEN_BRACKET) brackets++
    else if (subset && code === CLOSE_BRACKET) brackets--
    else if (subset && code === LT && text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4)
      if (close < 0) throw malformed
      index = close + 2
    } else if (code === LT && !subset) throw malformed
    else if (code === GT && brackets <= 0) return index
  }
  throw malformed
}

/**
 * Indents by two spaces the elements whose content is only elements, comments and processing instructions (and
 * whitespace between them), one item per line. Elements with any other text, CDATA, or no content keep their content
 * exactly as it was. Top-level items (a FOR XML fragment may have many) start lines of their own.
 */
export function formatXml(text: string, o: FormatOptions = {}): Formatted {
  const maxChars = o.maxChars ?? g.formattedChars, maxDepth = o.maxDepth ?? g.xmlDepth
  if (text.length > maxChars) return raw(text)
  try {
    const kinds: number[] = [], starts: number[] = [], ends: number[] = [], match: number[] = [], mixed: boolean[] = [], children: boolean[] = []
    const open: number[] = [], names: string[] = []
    const add = (kind: number, start: number, end: number) => { kinds.push(kind); starts.push(start); ends.push(end); match.push(-1); mixed.push(false); children.push(false); return kinds.length - 1 }
    const child = () => { if (open.length) children[open[open.length - 1]] = true }
    const n = text.length
    let index = 0
    while (index < n) {
      if (text.charCodeAt(index) !== LT) {
        const next = text.indexOf('<', index), end = next < 0 ? n : next
        let blank = true
        for (let at = index; at < end && blank; at++) blank = isSpace(text.charCodeAt(at))
        if (!blank) { if (!open.length) throw malformed; mixed[open[open.length - 1]] = true }
        add(Text, index, end)
        index = end
        continue
      }
      let end: number
      if (text.startsWith('<?', index)) {
        const close = text.indexOf('?>', index + 2)
        if (close < 0) throw malformed
        end = close + 2
        add(Pi, index, end); child()
      } else if (text.startsWith('<!--', index)) {
        const close = text.indexOf('-->', index + 4)
        if (close < 0) throw malformed
        end = close + 3
        add(Comment, index, end); child()
      } else if (text.startsWith('<![CDATA[', index)) {
        const close = text.indexOf(']]>', index + 9)
        if (close < 0 || !open.length) throw malformed
        end = close + 3
        mixed[open[open.length - 1]] = true
        add(CData, index, end)
      } else if (text.startsWith('<!', index)) {
        // A DOCTYPE or other declaration belongs before the root element.
        if (open.length) throw malformed
        end = tagEnd(text, index + 2, true) + 1
        add(Declaration, index, end)
      } else if (text.charCodeAt(index + 1) === SLASH) {
        const nameStop = nameEnd(text, index + 2)
        let close = nameStop
        while (close < n && isSpace(text.charCodeAt(close))) close++
        if (text.charCodeAt(close) !== GT || !open.length) throw malformed
        const start = open.pop()!
        if (names.pop() !== text.slice(index + 2, nameStop)) throw malformed
        end = close + 1
        match[start] = add(End, index, end)
      } else {
        const nameStop = nameEnd(text, index + 1), close = tagEnd(text, nameStop, false)
        end = close + 1
        if (open.length + 1 > maxDepth) throw malformed
        child()
        if (text.charCodeAt(close - 1) === SLASH) add(Empty, index, end)
        else { open.push(add(Start, index, end)); names.push(text.slice(index + 1, nameStop)) }
      }
      index = end
    }
    // Nothing but text, comments or declarations is not a document worth reformatting.
    if (open.length || !kinds.some(kind => kind === Start || kind === Empty)) throw malformed
    const out = new Output(maxChars)
    let depth = 0, first = true
    const line = (start: number, end: number) => {
      out.push(first ? text.slice(start, end) : '\n' + indent(depth) + text.slice(start, end))
      first = false
    }
    for (let token = 0; token < kinds.length; token++) {
      switch (kinds[token]) {
        // Text left here is whitespace between items: the indentation replaces it.
        case Text: break
        case Start:
          if (mixed[token] || !children[token]) { line(starts[token], ends[match[token]]); token = match[token] }
          else { line(starts[token], ends[token]); depth++ }
          break
        case End: depth--; line(starts[token], ends[token]); break
        default: line(starts[token], ends[token])
      }
    }
    return { text: out.text(), formatted: true }
  } catch (error) {
    if (error === malformed) return raw(text)
    throw error
  }
}

const OPEN_BRACE = 0x7b, CLOSE_BRACE = 0x7d, COMMA = 0x2c, COLON = 0x3a, BACKSLASH = 0x5c, MINUS = 0x2d, DOT = 0x2e
const isDigit = (code: number) => code >= 0x30 && code <= 0x39
const isHex = (code: number) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)
function skipSpace(text: string, from: number): number {
  let index = from
  while (index < text.length && isSpace(text.charCodeAt(index))) index++
  return index
}
/** The end of the JSON string starting at `from` (its opening quote). */
function stringEnd(text: string, from: number): number {
  for (let index = from + 1; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === QUOTE) return index + 1
    if (code < 0x20) throw malformed
    if (code === BACKSLASH) {
      const escaped = text.charCodeAt(index + 1)
      if (escaped === 0x75) {
        for (let hex = index + 2; hex < index + 6; hex++) if (!isHex(text.charCodeAt(hex))) throw malformed
        index += 5
      } else if (escaped === QUOTE || escaped === BACKSLASH || escaped === SLASH || escaped === 0x62 || escaped === 0x66 || escaped === 0x6e || escaped === 0x72 || escaped === 0x74) index++
      else throw malformed
    }
  }
  throw malformed
}
const literals = ['true', 'false', 'null'] as const
/** The end of the number, string or literal starting at `from`. */
function scalarEnd(text: string, from: number): number {
  const code = text.charCodeAt(from)
  if (code === QUOTE) return stringEnd(text, from)
  for (const literal of literals) if (text.startsWith(literal, from)) return from + literal.length
  let index = from
  if (text.charCodeAt(index) === MINUS) index++
  const digits = () => { const start = index; while (isDigit(text.charCodeAt(index))) index++; if (index === start) throw malformed }
  if (text.charCodeAt(index) === 0x30) index++
  else digits()
  if (text.charCodeAt(index) === DOT) { index++; digits() }
  if ((text.charCodeAt(index) | 0x20) === 0x65) {
    index++
    if (text.charCodeAt(index) === 0x2b || text.charCodeAt(index) === MINUS) index++
    digits()
  }
  return index
}

/** Indents by two spaces, one member or element per line, `"key": value`; `{}` and `[]` stay as they are. */
export function formatJson(text: string, o: FormatOptions = {}): Formatted {
  const maxChars = o.maxChars ?? g.formattedChars, maxDepth = o.maxDepth ?? g.jsonDepth
  if (text.length > maxChars) return raw(text)
  try {
    const out = new Output(maxChars), stack: boolean[] = [], n = text.length
    // `stack` holds true for an object, false for an array; `prefix` goes before the next value.
    let index = 0, state: 'value' | 'key' | 'after' = 'value', prefix = ''
    for (;;) {
      index = skipSpace(text, index)
      if (state === 'value') {
        if (index >= n) throw malformed
        const code = text.charCodeAt(index)
        if (code === OPEN_BRACE || code === OPEN_BRACKET) {
          if (stack.length >= maxDepth) throw malformed
          const object = code === OPEN_BRACE, next = skipSpace(text, index + 1)
          if (text.charCodeAt(next) === (object ? CLOSE_BRACE : CLOSE_BRACKET)) { out.push(prefix + (object ? '{}' : '[]')); index = next + 1; state = 'after'; continue }
          out.push(prefix + (object ? '{' : '['))
          stack.push(object)
          index++
          if (object) state = 'key'
          else prefix = '\n' + indent(stack.length)
          continue
        }
        const end = scalarEnd(text, index)
        out.push(prefix + text.slice(index, end))
        index = end
        state = 'after'
      } else if (state === 'key') {
        if (text.charCodeAt(index) !== QUOTE) throw malformed
        const end = stringEnd(text, index), colon = skipSpace(text, end)
        if (text.charCodeAt(colon) !== COLON) throw malformed
        out.push('\n' + indent(stack.length) + text.slice(index, end) + ': ')
        index = colon + 1
        prefix = ''
        state = 'value'
      } else {
        if (!stack.length) { if (index < n) throw malformed; break }
        const code = text.charCodeAt(index), object = stack[stack.length - 1]
        if (code === COMMA) {
          out.push(',')
          index++
          if (object) state = 'key'
          else { prefix = '\n' + indent(stack.length); state = 'value' }
        } else if (code === (object ? CLOSE_BRACE : CLOSE_BRACKET)) {
          stack.pop()
          out.push('\n' + indent(stack.length) + (object ? '}' : ']'))
          index++
        } else throw malformed
      }
    }
    return { text: out.text(), formatted: true }
  } catch (error) {
    if (error === malformed) return raw(text)
    throw error
  }
}
