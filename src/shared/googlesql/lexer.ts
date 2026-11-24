// A small GoogleSQL scanner for editor features that need to know where strings, comments and brackets are: signature
// help and the scope reader of BigQuery's completion (docs/language-services.md, Completion from the index). Colours come from the
// Monarch tokenizer (languages/googlesql.ts), which Monaco runs line by line; this reads a whole text at once.
import { googleSqlFunction, googleSqlReservedKeywords } from './catalog'

export type GoogleSqlTokenKind = 'whitespace' | 'comment' | 'string' | 'quotedIdentifier' | 'number' | 'word' | 'parameter' | 'systemVariable' | 'punctuation'
/** `end` is exclusive. `open`: a string, quoted identifier or block comment the text ends inside, or a line comment, which
 *  runs to its line's end, so a caret at its end is still inside it. */
export interface GoogleSqlToken { readonly kind: GoogleSqlTokenKind; readonly start: number; readonly end: number; readonly open?: boolean }

const wordStart = /[A-Za-z_]/, wordPart = /[A-Za-z0-9_]/, digit = /[0-9]/, space = /[ \t\r\n\f\v]/
const number = /0[xX][0-9A-Fa-f]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y

/** The length of a string prefix (`r`, `b`, `rb`, `br`, any case) when one starts a string literal at `at`, else 0. */
function stringPrefix(text: string, at: number): number {
  const isPrefix = (char: string | undefined) => char === 'r' || char === 'R' || char === 'b' || char === 'B'
  const quote = (char: string | undefined) => char === '\'' || char === '"'
  if (!isPrefix(text[at])) return 0
  if (quote(text[at + 1])) return 1
  if (isPrefix(text[at + 1]) && text[at + 1].toLowerCase() !== text[at].toLowerCase() && quote(text[at + 2])) return 2
  return 0
}

/** Scans a quoted body from `at` (just past the opening quote): a backslash escapes the next character, in raw strings
 *  too (it still keeps the quote from closing them). A single-quoted string ends at its line's end when unclosed. */
function quoted(text: string, at: number, quote: string, triple: boolean): { end: number; open: boolean } {
  let index = at
  while (index < text.length) {
    const char = text[index]
    // A backslash cannot carry a single-quoted string onto the next line (the tokenizer ends it there too).
    if (char === '\\' && (triple || text[index + 1] !== '\n')) { index += 2; continue }
    if (!triple && char === '\n') return { end: index, open: true }
    if (char === quote && (!triple || (text[index + 1] === quote && text[index + 2] === quote))) return { end: index + (triple ? 3 : 1), open: false }
    index++
  }
  return { end: text.length, open: true }
}

/** Every token of `text`, in order, covering it without gaps. */
export function scanGoogleSql(text: string): GoogleSqlToken[] {
  const tokens: GoogleSqlToken[] = []
  let at = 0
  const push = (kind: GoogleSqlTokenKind, end: number, open = false) => { tokens.push(open ? { kind, start: at, end, open } : { kind, start: at, end }); at = end }
  while (at < text.length) {
    const char = text[at], next = text[at + 1]
    if (space.test(char)) {
      let end = at + 1
      while (end < text.length && space.test(text[end])) end++
      push('whitespace', end)
    } else if (char === '#' || (char === '-' && next === '-')) {
      const newline = text.indexOf('\n', at)
      push('comment', newline < 0 ? text.length : newline, true)
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', at + 2)
      push('comment', close < 0 ? text.length : close + 2, close < 0)
    } else if (char === '\'' || char === '"' || stringPrefix(text, at)) {
      const body = at + stringPrefix(text, at), quote = text[body], triple = text[body + 1] === quote && text[body + 2] === quote
      const { end, open } = quoted(text, body + (triple ? 3 : 1), quote, triple)
      push('string', end, open)
    } else if (char === '`') {
      const { end, open } = quoted(text, at + 1, '`', false)
      push('quotedIdentifier', end, open)
    } else if (digit.test(char) || (char === '.' && digit.test(next ?? ''))) {
      number.lastIndex = at
      number.test(text)
      const end = number.lastIndex
      push('number', end)
    } else if (char === '@' && next === '@' && wordStart.test(text[at + 2] ?? '')) {
      let end = at + 3
      while (end < text.length && (wordPart.test(text[end]) || (text[end] === '.' && wordStart.test(text[end + 1] ?? '')))) end++
      push('systemVariable', end)
    } else if (char === '@' && wordStart.test(next ?? '')) {
      let end = at + 2
      while (end < text.length && wordPart.test(text[end])) end++
      push('parameter', end)
    } else if (wordStart.test(char)) {
      let end = at + 1
      while (end < text.length && wordPart.test(text[end])) end++
      push('word', end)
    } else push('punctuation', at + 1)
  }
  return tokens
}

/** Where a caret sits in a function call: the called name (dotted as written, `NET.HOST`), the argument it is in (from
 *  0), and the offset of the call's opening parenthesis. */
export interface GoogleSqlCallContext { readonly name: string; readonly argument: number; readonly open: number }

interface Frame { readonly bracket: '(' | '[' | '<'; readonly name?: string; readonly open: number; commas: number }
const angleOwners = new Set(['ARRAY', 'STRUCT', 'RANGE'])
const reserved: ReadonlySet<string> = new Set(googleSqlReservedKeywords)
/** A reserved keyword before a parenthesis (`IN (`, `OVER (`) names no call, unless it is also a function (`IF(`, `CAST(`). */
const callName = (chain: readonly string[]) => chain.length === 1 && reserved.has(chain[0].toUpperCase()) && !googleSqlFunction(chain[0]) ? undefined : chain.join('.')

/**
 * The innermost named call that holds `offset` in `text`, or undefined: outside any call, in a parenthesis no name
 * precedes (a subquery, a list), or inside a string, comment or quoted identifier. Commas inside nested parentheses,
 * array brackets and `STRUCT<…>`/`ARRAY<…>` types do not count as the call's.
 */
export function googleSqlCallContext(text: string, offset: number): GoogleSqlCallContext | undefined {
  const frames: Frame[] = []
  let chain: string[] | undefined, last: GoogleSqlToken | undefined, lastText = '', beforeLastText = ''
  for (const token of scanGoogleSql(text.slice(0, offset))) {
    if (token.kind === 'whitespace') continue
    if (token.kind === 'comment' || token.kind === 'string' || token.kind === 'quotedIdentifier') {
      if (token.end === offset && token.open) return undefined
      if (token.kind === 'comment') continue
    }
    const value = text.slice(token.start, token.end)
    if (token.kind === 'word') chain = last?.kind === 'punctuation' && lastText === '.' && chain ? [...chain, value] : [value]
    else if (token.kind === 'punctuation') {
      if (value === '.') { if (last?.kind !== 'word') chain = undefined }
      else {
        const name = value === '(' && last?.kind === 'word' && chain ? callName(chain) : undefined
        if (value === '(') frames.push({ bracket: '(', open: token.start, commas: 0, ...name ? { name } : {} })
        else if (value === '[') frames.push({ bracket: '[', open: token.start, commas: 0 })
        // `t.range < 5` compares a field; only a bare ARRAY, STRUCT or RANGE opens a type's angle brackets.
        else if (value === '<' && last?.kind === 'word' && beforeLastText !== '.' && angleOwners.has(lastText.toUpperCase())) frames.push({ bracket: '<', open: token.start, commas: 0 })
        else if (value === '>' && frames.at(-1)?.bracket === '<') frames.pop()
        else if (value === ')' || value === ']') {
          const opening = value === ')' ? '(' : '['
          const index = frames.findLastIndex(frame => frame.bracket === opening)
          if (index >= 0) frames.length = index
        } else if (value === ',' && frames.length) frames[frames.length - 1].commas++
        chain = undefined
      }
    } else chain = undefined
    beforeLastText = lastText
    last = token
    lastText = value
  }
  const call = frames.findLast(frame => frame.bracket === '(')
  return call?.name ? { name: call.name, argument: call.commas, open: call.open } : undefined
}
