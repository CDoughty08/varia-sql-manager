import { formatCount } from '../results/status'

/** What a comparison's inputs are called in its gutter's names, and the larger input's row count (the number's width). */
export interface DiffSides { readonly old: string; readonly new: string; readonly rows?: number }

/** A comparison row's gutter: the mark it draws, its number (its row in its own input), and its accessible name and tooltip. */
export interface DiffGutter { readonly mark: string; readonly number: string; readonly name: string }

const fallbackSides: DiffSides = { old: 'the old result', new: 'the new result' }

/**
 * A comparison row's gutter from its hidden suffix cells (`null` for NULL): the marker (" " same, "−" removed or a changed
 * entry's old half, "+" added or its new half) and its 1-based rows in the old and new inputs. The number is the new
 * input's row, except on a "−" row, which shows the old input's. Both halves of a changed entry carry both rows; a row with
 * one side is added or removed.
 */
export function diffGutter(mark: string | null, leftRow: string | null, rightRow: string | null, sides: DiffSides = fallbackSides): DiffGutter {
  const removed = mark === '−', added = mark === '+'
  const kind = removed ? (rightRow === null ? 'Removed' : 'Changed, old values') : added ? (leftRow === null ? 'Added' : 'Changed, new values') : 'Unchanged'
  const own = removed ? leftRow : rightRow
  const rows = [leftRow === null ? '' : `row ${formatCount(Number(leftRow))} in ${sides.old}`, rightRow === null ? '' : `row ${formatCount(Number(rightRow))} in ${sides.new}`].filter(Boolean)
  return { mark: removed ? '−' : added ? '+' : '', number: own === null ? '' : own, name: rows.length > 0 ? `${kind}; ${rows.join(', ')}` : kind }
}
