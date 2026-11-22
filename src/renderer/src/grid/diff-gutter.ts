import type { DiffMatchUsed } from '../../../shared/contracts'
import { formatCount, plural } from '../results/status'

/** What a comparison's inputs are called in its gutter's names, and the larger input's row count (the number's width). */
export interface DiffSides { readonly old: string; readonly new: string; readonly rows?: number }

/**
 * A comparison row's gutter: the mark it draws, its number (its row in its own input), its flag (≈ for a repeated key, else
 * ? for a possible match, else ''), and its accessible name and tooltip. In Changes only, with the gaps shown, `above` is
 * the unchanged rows hidden just before it and `below` those hidden after it (the last row), each drawn as a dashed rule.
 */
export interface DiffGutter { readonly mark: string; readonly number: string; readonly flag: string; readonly name: string; readonly above?: number; readonly below?: number }

/** A tone's flags (UnifiedDiff.Tone): its key repeats (`dup`), its possible match's 1-based row in the other input
 *  (`poss=<row>`), the unchanged entries omitted just before it in Changes only (`gap=<n>`), and whether its listed cells
 *  were cut (it ends with "…"). Unknown flags are ignored. */
export interface ToneFlags { readonly repeated: boolean; readonly partner?: number; readonly gap?: number; readonly cut: boolean }

/** What a comparison row's gutter says of the unchanged rows Changes only hides around it: whether the gaps are shown (no
 *  sort or filter reorders or drops rows), and the run hidden after the last row, passed for that row only. */
export interface DiffGaps { readonly shown: boolean; readonly trailing?: number }

const flagLimit = 3
/** The flags of a tone text ("removed dup poss=12", "changedOld gap=3 2 4-6 …"): read from the tokens after the kind, up
 *  to the first cell, at most three. */
export function toneFlagsOf(tone: string | null | undefined): ToneFlags {
  if (!tone) return { repeated: false, cut: false }
  const tokens = tone.split(' ')
  let repeated = false, partner: number | undefined, gap: number | undefined
  for (let at = 1; at < tokens.length && at <= flagLimit; at++) {
    const token = tokens[at]
    if (token === 'dup') repeated = true
    else if (token.startsWith('poss=') || token.startsWith('gap=')) {
      const value = Number(token.slice(token.indexOf('=') + 1))
      if (!Number.isSafeInteger(value) || value <= 0) continue
      if (token.startsWith('poss=')) partner = value
      else gap = value
    } else if (!/^[a-z]+(=\d+)?$/.test(token)) break
  }
  return { repeated, ...partner === undefined ? {} : { partner }, ...gap === undefined ? {} : { gap }, cut: tokens.length > 1 && tokens[tokens.length - 1] === '…' }
}

/** A run of unchanged rows Changes only hides: "312 unchanged rows hidden" before a row, "… hidden after it" past the last. */
export const gapText = (count: number, after = false): string => `${formatCount(count)} unchanged ${plural(count, 'row')} hidden${after ? ' after it' : ''}`

/** Per visible column of a comparison (its pairs, in order), whether it is a key column: those its match used when rows
 *  were matched by columns (asked for, or Automatic's chosen column), each name taking the first unused column of that
 *  name, ignoring case. None when rows were matched by position or by whole rows. */
export function diffKeyFlags(match: DiffMatchUsed | undefined, names: readonly string[]): boolean[] {
  const flags = names.map(() => false)
  if (!match || (match.mode !== 'columns' && match.mode !== 'auto')) return flags
  for (const key of match.columns) {
    const wanted = key.toLowerCase(), at = names.findIndex((name, index) => !flags[index] && name.toLowerCase() === wanted)
    if (at >= 0) flags[at] = true
  }
  return flags
}

const fallbackSides: DiffSides = { old: 'the old result', new: 'the new result' }

/** The sentence a cut row's gutter name ends with: its cells past the tone's cut are drawn as unchanged. */
export const cutRowText = 'More changes in this row are not listed'

/**
 * A comparison row's gutter from its hidden suffix cells (`null` for NULL): the marker (" " same, "~" a changed entry in
 * one row, "−" removed or a changed entry's old half, "+" added or its new half), its 1-based rows in the old and new inputs, and its tone (for its flags).
 * The number is the new input's row, except on a "−" row, which shows the old input's. Both halves of a changed entry carry
 * both rows; a row with one side is added or removed. A possible match's partner is in the other input: the new one for a
 * removed row, the old one for an added row. With `gaps` shown, the unchanged rows hidden around it end its name.
 */
export function diffGutter(mark: string | null, leftRow: string | null, rightRow: string | null, sides: DiffSides = fallbackSides, tone?: string | null, gaps?: DiffGaps): DiffGutter {
  const removed = mark === '−', added = mark === '+', changed = mark === '~'
  const kind = removed ? (rightRow === null ? 'Removed' : 'Changed, old values') : added ? (leftRow === null ? 'Added' : 'Changed, new values') : changed ? 'Changed' : 'Unchanged'
  const own = removed ? leftRow : rightRow
  const flags = toneFlagsOf(tone)
  const partner = flags.partner !== undefined && (removed || added) ? `possible match with row ${formatCount(flags.partner)} in ${removed ? sides.new : sides.old}` : ''
  const described = [kind, flags.repeated ? 'repeated key' : '', partner].filter(Boolean).join(', ')
  const rows = [leftRow === null ? '' : `row ${formatCount(Number(leftRow))} in ${sides.old}`, rightRow === null ? '' : `row ${formatCount(Number(rightRow))} in ${sides.new}`].filter(Boolean)
  const above = gaps?.shown ? flags.gap ?? 0 : 0, below = gaps?.shown ? gaps.trailing ?? 0 : 0
  const name = (rows.length > 0 ? `${described}; ${rows.join(', ')}` : described) + (flags.cut ? `. ${cutRowText}` : '')
    + (above > 0 ? `. ${gapText(above)}` : '') + (below > 0 ? `. ${gapText(below, true)}` : '')
  return { mark: removed ? '−' : added ? '+' : changed ? '~' : '', number: own === null ? '' : own, flag: flags.repeated ? '≈' : partner ? '?' : '', name, ...above > 0 ? { above } : {}, ...below > 0 ? { below } : {} }
}
