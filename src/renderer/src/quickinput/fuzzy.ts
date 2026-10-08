/**
 * The quick input's matcher. Every query word must match the label (or, scoring less and highlighting nothing, a
 * keyword), in any order. Per word the first strategy that matches wins: a contiguous substring, then word-start
 * initials ("fsa" for "File: Save As…"), then a subsequence. Work is linear in the capped label length.
 */
export type MatchRange = readonly [start: number, end: number]
export interface FuzzyMatch { readonly score: number; readonly ranges: readonly MatchRange[] }
export interface PreparedQuery { readonly words: readonly string[] }

export const fuzzyLimits = { query: 256, words: 8, label: 512, keywords: 16, keyword: 64, occurrences: 32 } as const
const keywordWeight = 0.8

/** Lowercases one UTF-16 unit at a time, so offsets in the result are offsets in the original. */
function lowerUnits(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let result = ''
  for (let index = 0; index < text.length; index++) { const unit = text[index].toLowerCase(); result += unit.length === 1 ? unit : text[index] }
  return result
}

const separators = new Set([...':._-/()[]'].map(character => character.charCodeAt(0)))
// ASCII is decided by code; other characters by whether they change case the other way.
const isCased = (code: number, lower: boolean) => { const character = String.fromCharCode(code); return character !== (lower ? character.toUpperCase() : character.toLowerCase()) }
const isLower = (code: number) => (code >= 97 && code <= 122) || (code > 127 && isCased(code, true))
const isUpper = (code: number) => (code >= 65 && code <= 90) || (code > 127 && isCased(code, false))
/** Words start at the first character, after a space or separator, and at a lower-to-upper case change. */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text.charCodeAt(index - 1)
  return previous <= 32 || separators.has(previous) || (previous > 127 && /\s/.test(text[index - 1])) || (isLower(previous) && isUpper(text.charCodeAt(index)))
}
interface Subject { readonly original: string; readonly text: string }
const subject = (value: string): Subject => ({ original: value, text: lowerUnits(value) })

export function prepareQuery(query: string): PreparedQuery {
  const words = lowerUnits(query.trimStart().slice(0, fuzzyLimits.query)).split(/\s+/).filter(Boolean)
  return { words: words.slice(0, fuzzyLimits.words) }
}

function substring(word: string, { original, text }: Subject): FuzzyMatch | undefined {
  let first = -1, best = -1
  for (let index = text.indexOf(word), seen = 0; index >= 0 && seen < fuzzyLimits.occurrences; index = text.indexOf(word, index + 1), seen++) {
    if (first < 0) first = index
    if (isWordStart(original, index)) { best = index; break }
  }
  if (first < 0) return undefined
  const at = best < 0 ? first : best
  return { score: 100 + (best < 0 ? 0 : 50) + (at === 0 ? 25 : 0), ranges: [[at, at + word.length]] }
}

function initials(word: string, { original, text }: Subject): FuzzyMatch | undefined {
  const ranges: MatchRange[] = []
  let position = 0
  for (let index = 0; index < word.length; index++) {
    while (position < text.length && !(text[position] === word[index] && isWordStart(original, position))) position++
    if (position === text.length) return undefined
    ranges.push([position, position + 1])
    position++
  }
  return { score: 60 + 5 * word.length, ranges }
}

function subsequence(word: string, { original, text }: Subject): FuzzyMatch | undefined {
  const positions: number[] = []
  for (let index = 0, position = 0; index < word.length; index++, position++) {
    while (position < text.length && text[position] !== word[index]) position++
    if (position === text.length) return undefined
    positions.push(position)
  }
  // Pull earlier characters right, toward the next one, so "cdb" highlights "Change Database", not stray letters.
  for (let index = positions.length - 2; index >= 0; index--) {
    let position = positions[index + 1] - 1
    while (position > positions[index] && text[position] !== word[index]) position--
    positions[index] = position
  }
  let score = 0, gaps = 0
  const ranges: MatchRange[] = []
  positions.forEach((position, index) => {
    const consecutive = index > 0 && position === positions[index - 1] + 1
    score += 1 + (isWordStart(original, position) ? 8 : 0) + (consecutive ? 4 : 0)
    if (index > 0) gaps += position - positions[index - 1] - 1
    ranges.push([position, position + 1])
  })
  return { score: Math.max(1, Math.min(59, score - Math.min(gaps, 20))), ranges }
}

function matchWord(word: string, target: Subject): FuzzyMatch | undefined {
  return substring(word, target) ?? initials(word, target) ?? subsequence(word, target)
}

/** Sorted, disjoint ranges within `[0, length]`, with touching ranges joined. */
export function mergeRanges(ranges: readonly MatchRange[], length: number): MatchRange[] {
  const sorted = ranges.map(([start, end]) => [Math.max(0, Math.min(start, length)), Math.max(0, Math.min(end, length))] as const)
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * Scores `label` against `query` (a string or a `prepareQuery` result, for scoring many labels). Returns undefined
 * when some word matches neither the label nor a keyword; an empty query matches everything with score 0.
 */
export function scoreQuery(query: string | PreparedQuery, label: string, keywords: readonly string[] = []): FuzzyMatch | undefined {
  const { words } = typeof query === 'string' ? prepareQuery(query) : query
  if (!words.length) return { score: 0, ranges: [] }
  const target = subject(label.slice(0, fuzzyLimits.label))
  let score = 0, ranges: MatchRange[] = [], keywordTargets: Subject[] | undefined
  for (const word of words) {
    const match = matchWord(word, target)
    if (match) { score += match.score; ranges = ranges.concat(match.ranges); continue }
    keywordTargets ??= keywords.slice(0, fuzzyLimits.keywords).map(keyword => subject(keyword.slice(0, fuzzyLimits.keyword)))
    let best = 0
    for (const keyword of keywordTargets) best = Math.max(best, matchWord(word, keyword)?.score ?? 0)
    if (!best) return undefined
    score += best * keywordWeight
  }
  return { score, ranges: mergeRanges(ranges, target.original.length) }
}

export interface RankedItem { readonly score: number; readonly label: string; readonly disabled?: boolean; readonly recentRank?: number }
/** Best first: score, then enabled before disabled, then recently used, then the shorter label, then alphabetical. */
export function compareRanked(a: RankedItem, b: RankedItem): number {
  return b.score - a.score
    || Number(!!a.disabled) - Number(!!b.disabled)
    || (a.recentRank ?? Infinity) - (b.recentRank ?? Infinity)
    || a.label.length - b.label.length
    || a.label.localeCompare(b.label)
}
