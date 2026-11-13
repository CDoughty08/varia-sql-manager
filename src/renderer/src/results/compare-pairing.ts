import type { ResultColumn } from '../../../shared/contracts'

/** A column one side of a comparison leaves out: its place and name, its type, and the type of a column of the same name
 *  on the other side that did not pair with it (another wire, or already paired), for saying why. */
export interface UnpairedColumn { readonly index: number; readonly name: string; readonly dataType: string; readonly otherType?: string }
/** How two results' columns pair for a diff: `[old, new]` places, and each side's columns left out. */
export interface ColumnPairing {
  readonly pairs: readonly (readonly [number, number])[]
  readonly oldOnly: readonly UnpairedColumn[]
  readonly newOnly: readonly UnpairedColumn[]
}

type PairableColumn = Pick<ResultColumn, 'name' | 'wire' | 'role'> & Partial<Pick<ResultColumn, 'dataType'>>

const hidden = (column: PairableColumn) => column.role === 'tone'
/** One character as OrdinalIgnoreCase compares it: upper-cased when that is one character, as the invariant mapping is. */
// .NET's invariant upper-casing keeps the dotless ı as itself (it does on Windows and, to match, on ICU), where JavaScript gives I.
const upper = (char: string) => { if (char === 'ı') return char; const up = char.toUpperCase(); return up.length === 1 ? up : char }
/** String.Equals(a, b, StringComparison.OrdinalIgnoreCase), code unit by code unit. */
export function sameName(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at] && upper(a[at]) !== upper(b[at])) return false
  return true
}

/**
 * The backend's pairing (ResultDiffer.Pairs), copied for the Compare picker: each visible column of the old side, in order,
 * with the first unused visible column of the new side of the same name (case-insensitive) and wire. A tone column never
 * pairs. tests/fixtures/compare-pairing/cases.json pins this to the backend's rule; both test suites read it.
 */
export function pairColumns(old: readonly PairableColumn[], neu: readonly PairableColumn[]): ColumnPairing {
  const used = new Array<boolean>(neu.length).fill(false)
  const pairs: [number, number][] = []
  const paired = new Array<boolean>(old.length).fill(false)
  old.forEach((column, l) => {
    if (hidden(column)) return
    const r = neu.findIndex((other, at) => !used[at] && !hidden(other) && sameName(column.name, other.name) && column.wire === other.wire)
    if (r < 0) return
    used[r] = true
    paired[l] = true
    pairs.push([l, r])
  })
  const unpaired = (columns: readonly PairableColumn[], taken: readonly boolean[], others: readonly PairableColumn[]): UnpairedColumn[] =>
    columns.flatMap((column, index) => {
      if (taken[index] || hidden(column)) return []
      const other = others.find(item => !hidden(item) && sameName(item.name, column.name))
      return [{ index, name: column.name, dataType: column.dataType ?? '', ...other ? { otherType: other.dataType ?? '' } : {} }]
    })
  return { pairs, oldOnly: unpaired(old, paired, neu), newOnly: unpaired(neu, used, old) }
}
