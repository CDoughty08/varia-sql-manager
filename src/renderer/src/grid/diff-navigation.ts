import { formatCount } from '../results/status'

/** A change unit's place in its row: a changed cell (its data column), or the whole row (an added or removed row, or a cut
 *  row's unlisted changes), which is selected with its first column active. */
export interface DiffUnit { readonly column: number; readonly whole: boolean }

/** A row's change units from its tone (`<kind> [flag…] [cell…]`): an added or removed row is one unit, the row itself; a
 *  changed entry (one row, or the new half of two) has a unit per changed cell it lists, in column order, and one more for
 *  the whole row when its list was cut (" …"). Soft (collation-only) cells and the old half have none, as in the backend's
 *  change index. */
export interface DiffRowUnits { readonly row: boolean; readonly units: readonly DiffUnit[] }

const cellToken = /^(~?)(\d{1,5})(?:-(\d{1,5}))?$/
const none: DiffRowUnits = { row: false, units: [] }

/** The change units of a row whose tone is `tone`, among its first `columns` (data) columns. */
export function rowUnits(tone: string | null | undefined, columns: number): DiffRowUnits {
  if (!tone) return none
  const tokens = tone.split(' '), kind = tokens[0]
  if (kind === 'added' || kind === 'removed') return { row: true, units: [{ column: 0, whole: true }] }
  if (kind !== 'changed' && kind !== 'changedNew') return none
  const cells = new Set<number>()
  for (const token of tokens.slice(1)) {
    const match = cellToken.exec(token)
    if (!match || match[1]) continue
    const first = Number(match[2]), last = match[3] === undefined ? first : Number(match[3])
    for (let column = first; column <= Math.min(last, columns - 1); column++) cells.add(column)
  }
  const units: DiffUnit[] = [...cells].sort((a, b) => a - b).map(column => ({ column, whole: false }))
  if (tokens.length > 1 && tokens[tokens.length - 1] === '…') units.push({ column: 0, whole: true })
  return { row: false, units }
}

/**
 * The unit of the active row to move to from where the active cell is (`at`: its column, and whether the whole row is
 * selected), or undefined when the move leaves the row. On an added or removed row the active cell is on the row's own
 * unit wherever it is. A cut row's whole-row unit comes after its listed cells.
 */
export function stepWithin(units: DiffRowUnits, at: { readonly column: number; readonly whole: boolean }, direction: 'next' | 'previous'): number | undefined {
  if (units.row || units.units.length === 0) return undefined
  const list = units.units, cut = list[list.length - 1].whole ? list.length - 1 : -1
  if (direction === 'next') {
    if (at.whole) return undefined
    const next = list.findIndex(unit => !unit.whole && unit.column > at.column)
    return next >= 0 ? next : cut >= 0 ? cut : undefined
  }
  let previous = -1
  for (let index = 0; index < list.length; index++) if (!list[index].whole && (at.whole || list[index].column < at.column)) previous = index
  return previous >= 0 ? previous : undefined
}

/** Where a seek's answer lands once its row's tone is read: an added or removed row, or a cut row reached going back (its
 *  whole-row unit is its last), selects the row; any other lands on the answer's cell. */
export function landingFor(tone: string | null | undefined, column: number, direction: 'next' | 'previous', columns: number): DiffUnit {
  const units = rowUnits(tone, columns)
  if (units.row) return { column: 0, whole: true }
  if (direction === 'previous' && units.units.length > 0 && units.units[units.units.length - 1].whole) return { column: 0, whole: true }
  return { column, whole: false }
}

/** "Change 2 of 31": the unit landed on among the units of the rows shown, "… shown" while a filter (a chip included)
 *  leaves some out. */
export const positionText = (index: number, total: number, shown: boolean): string => `Change ${formatCount(index)} of ${formatCount(total)}${shown ? ' shown' : ''}`
/** What the toolbar says before any move: the comparison's change units. */
export const unitsText = (units: number): string => units === 0 ? 'No differences' : `${formatCount(units)} ${units === 1 ? 'change' : 'changes'}`
/** Said when the rows a filter shows have no change to move to. */
export const noneShownText = 'No differences shown'
/** Said when Go to Possible Match's partner is hidden by a filter. */
export const partnerHiddenText = 'The possible match is hidden by a filter'
/** Said when the row Go to Possible Match ran on has none (it changed since the command was offered). */
export const noPartnerText = 'This row has no possible match'

/** The kind of a row's possible match: a removed row's is added, an added row's removed; undefined for any other row or one
 *  with no `poss=` flag. */
export function partnerKind(tone: string | null | undefined): 'added' | 'removed' | undefined {
  if (!tone) return undefined
  const tokens = tone.split(' '), kind = tokens[0]
  if (kind !== 'added' && kind !== 'removed') return undefined
  for (let at = 1; at < tokens.length && at <= 3; at++) if (/^poss=[1-9]\d*$/.test(tokens[at])) return kind === 'added' ? 'removed' : 'added'
  return undefined
}
