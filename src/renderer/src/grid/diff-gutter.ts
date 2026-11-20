import { formatCount } from '../results/status'

/** What a comparison's inputs are called in its gutter's names, and the larger input's row count (the number's width). */
export interface DiffSides { readonly old: string; readonly new: string; readonly rows?: number }

/**
 * A comparison row's gutter: the mark it draws, its number (its row in its own input), its flag (≈ for a repeated key, else
 * ? for a possible match, else ''), and its accessible name and tooltip.
 */
export interface DiffGutter { readonly mark: string; readonly number: string; readonly flag: string; readonly name: string }

/** A tone's flags (UnifiedDiff.Tone): its key repeats (`dup`), its possible match's 1-based row in the other input
 *  (`poss=<row>`), and whether its listed cells were cut (it ends with "…"). Unknown flags are ignored. */
export interface ToneFlags { readonly repeated: boolean; readonly partner?: number; readonly cut: boolean }

const flagLimit = 3
/** The flags of a tone text ("removed dup poss=12", "changedOld gap=3 2 4-6 …"): read from the tokens after the kind, up
 *  to the first cell, at most three. */
export function toneFlagsOf(tone: string | null | undefined): ToneFlags {
  if (!tone) return { repeated: false, cut: false }
  const tokens = tone.split(' ')
  let repeated = false, partner: number | undefined
  for (let at = 1; at < tokens.length && at <= flagLimit; at++) {
    const token = tokens[at]
    if (token === 'dup') repeated = true
    else if (token.startsWith('poss=')) {
      const row = Number(token.slice(5))
      if (Number.isSafeInteger(row) && row > 0) partner = row
    } else if (!token.startsWith('gap=') && !/^[a-z]+(=\d+)?$/.test(token)) break
  }
  return { repeated, ...partner === undefined ? {} : { partner }, cut: tokens.length > 1 && tokens[tokens.length - 1] === '…' }
}

const fallbackSides: DiffSides = { old: 'the old result', new: 'the new result' }

/** The sentence a cut row's gutter name ends with: its cells past the tone's cut are drawn as unchanged. */
export const cutRowText = 'More changes in this row are not listed'

/**
 * A comparison row's gutter from its hidden suffix cells (`null` for NULL): the marker (" " same, "−" removed or a changed
 * entry's old half, "+" added or its new half), its 1-based rows in the old and new inputs, and its tone (for its flags).
 * The number is the new input's row, except on a "−" row, which shows the old input's. Both halves of a changed entry carry
 * both rows; a row with one side is added or removed. A possible match's partner is in the other input: the new one for a
 * removed row, the old one for an added row.
 */
export function diffGutter(mark: string | null, leftRow: string | null, rightRow: string | null, sides: DiffSides = fallbackSides, tone?: string | null): DiffGutter {
  const removed = mark === '−', added = mark === '+'
  const kind = removed ? (rightRow === null ? 'Removed' : 'Changed, old values') : added ? (leftRow === null ? 'Added' : 'Changed, new values') : 'Unchanged'
  const own = removed ? leftRow : rightRow
  const flags = toneFlagsOf(tone)
  const partner = flags.partner !== undefined && (removed || added) ? `possible match with row ${formatCount(flags.partner)} in ${removed ? sides.new : sides.old}` : ''
  const described = [kind, flags.repeated ? 'repeated key' : '', partner].filter(Boolean).join(', ')
  const rows = [leftRow === null ? '' : `row ${formatCount(Number(leftRow))} in ${sides.old}`, rightRow === null ? '' : `row ${formatCount(Number(rightRow))} in ${sides.new}`].filter(Boolean)
  const name = (rows.length > 0 ? `${described}; ${rows.join(', ')}` : described) + (flags.cut ? `. ${cutRowText}` : '')
  return { mark: removed ? '−' : added ? '+' : '', number: own === null ? '' : own, flag: flags.repeated ? '≈' : partner ? '?' : '', name }
}
