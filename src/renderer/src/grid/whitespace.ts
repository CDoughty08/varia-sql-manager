import { displayText } from '../../../shared/ipc/wire/cells'

/**
 * How the results grid shows white space (queryResults.grid.whitespace): `none` draws values as they are, `spaces` marks
 * spaces and tabs, `all` also names line breaks and the invisible spaces (no-break, zero-width, the Unicode spaces) that
 * make two values look alike. The marks are display only: Copy and Save write the values themselves.
 */
export const whitespaceModes = ['none', 'spaces', 'all'] as const
export type WhitespaceMode = typeof whitespaceModes[number]

/** A piece of a shown value: its own text, a run of marked spaces and tabs, or one named character drawn as a badge. */
export interface WhitespaceRun { readonly kind: 'text' | 'mark' | 'badge'; readonly text: string }

/**
 * Only this much of a value is marked; the rest is left as text. A cell clips long values anyway, and no column a person
 * can read is wider than this many characters.
 */
export const whitespaceMarkLimit = 2048

const space = '·', tab = '→'
/** The characters `all` names, as editors that show every character do (CR, LF), else by code point. */
const named: Readonly<Record<string, string>> = {
  '\r\n': 'CRLF', '\r': 'CR', '\n': 'LF', '\v': 'VT', '\f': 'FF', '\u0085': 'NEL', '\u00a0': 'NBSP', '\u200b': 'ZWSP', '\u2060': 'WJ', '\ufeff': 'BOM',
  '\u2028': 'LS', '\u2029': 'PS'
}
// The other Unicode spaces (Zs), named by code point: U+1680, U+2000..U+200A, U+202F, U+205F, U+3000.
const otherSpaces = /[\u1680\u2000-\u200a\u202f\u205f\u3000]/
const anyMarked = /[ \t\r\n\v\f\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/

function badgeFor(text: string, at: number): [label: string, length: number] | undefined {
  if (text.startsWith('\r\n', at)) return [named['\r\n'], 2]
  const char = text[at]
  if (named[char]) return [named[char], 1]
  if (otherSpaces.test(char)) return ['U+' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'), 1]
  return undefined
}

/**
 * The runs a value's own text shows as under `mode`, or undefined when nothing is marked (`none`, or nothing to mark):
 * the cell then shows its display text (`displayText`, one line). Spaces and tabs become one mark run each stretch, a tab
 * one arrow; in `all`, each named character is a badge of its own and CR LF is one badge. Text between the marks is
 * display text too, so a line break `spaces` does not mark still shows as a space, as SSMS shows it.
 */
export function whitespaceRuns(text: string, mode: WhitespaceMode): readonly WhitespaceRun[] | undefined {
  if (mode === 'none' || !anyMarked.test(text.length > whitespaceMarkLimit ? text.slice(0, whitespaceMarkLimit) : text)) return undefined
  const runs: WhitespaceRun[] = [], end = Math.min(text.length, whitespaceMarkLimit)
  let plain = '', marks = '', changed = false
  const flush = () => {
    if (plain) { runs.push({ kind: 'text', text: displayText(plain) }); plain = '' }
    if (marks) { runs.push({ kind: 'mark', text: marks }); marks = '' }
  }
  for (let at = 0; at < end;) {
    const char = text[at]
    if (char === ' ' || char === '\t') {
      if (plain) { runs.push({ kind: 'text', text: displayText(plain) }); plain = '' }
      marks += char === ' ' ? space : tab
      changed = true
      at++
      continue
    }
    const badge = mode === 'all' ? badgeFor(text, at) : undefined
    if (badge) {
      flush()
      runs.push({ kind: 'badge', text: badge[0] })
      changed = true
      at += badge[1]
      continue
    }
    if (marks) { runs.push({ kind: 'mark', text: marks }); marks = '' }
    plain += char
    at++
  }
  flush()
  if (end < text.length) {
    const last = runs[runs.length - 1]
    if (last?.kind === 'text') runs[runs.length - 1] = { kind: 'text', text: last.text + displayText(text.slice(end)) }
    else runs.push({ kind: 'text', text: displayText(text.slice(end)) })
  }
  return changed ? runs : undefined
}
