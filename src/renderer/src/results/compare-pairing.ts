import type { ResultColumn } from '../../../shared/contracts'
import { ordinalKey, sameName } from '../../../shared/ordinal-casing'
import { isHiddenColumn } from '../grid/hidden-columns'

export { sameName }

/** A column one side of a comparison leaves out: its place and name, its type, and the type of a column of the same name
 *  on the other side that did not pair with it, for saying why; `repeat` when that is only because each column of the name
 *  and wire there already paired (its name repeats on this side), not because the wires differ. */
export interface UnpairedColumn { readonly index: number; readonly name: string; readonly dataType: string; readonly otherType?: string; readonly repeat?: true }
/** How two results' columns pair for a diff: `[old, new]` places, and each side's columns left out. */
export interface ColumnPairing {
  readonly pairs: readonly (readonly [number, number])[]
  readonly oldOnly: readonly UnpairedColumn[]
  readonly newOnly: readonly UnpairedColumn[]
}

type PairableColumn = Pick<ResultColumn, 'name' | 'wire' | 'role'> & Partial<Pick<ResultColumn, 'dataType'>>

interface SameName { first: PairableColumn; wires: Map<PairableColumn['wire'], { indices: number[]; next: number }> }

function indexColumns(columns: readonly PairableColumn[]) {
  const names = new Map<string, SameName>()
  const keys = columns.map((column, i) => {
    if (isHiddenColumn(column)) return undefined
    let key = ''
    for (const point of column.name) key += String.fromCodePoint(ordinalKey(point.codePointAt(0)!))
    let named = names.get(key)
    if (!named) names.set(key, named = { first: column, wires: new Map() })
    let wire = named.wires.get(column.wire)
    if (!wire) named.wires.set(column.wire, wire = { indices: [], next: 0 })
    wire.indices.push(i)
    return key
  })
  return { names, keys, columns, used: new Array<boolean>(columns.length).fill(false) }
}

/**
 * The backend's pairing (ResultDiffer.Pairs), copied for the Compare popover: each visible column of the old side, in order,
 * with the first unused visible column of the new side of the same name (case-insensitive) and wire. A tone column never
 * pairs. tests/fixtures/compare-pairing/cases.json pins this to the backend's rule; both test suites read it.
 */
export function pairColumns(old: readonly PairableColumn[], neu: readonly PairableColumn[]): ColumnPairing {
  const left = indexColumns(old), right = indexColumns(neu)
  const pairs: [number, number][] = []
  old.forEach((column, l) => {
    const key = left.keys[l]
    const wire = key === undefined ? undefined : right.names.get(key)?.wires.get(column.wire)
    if (!wire || wire.next === wire.indices.length) return
    const r = wire.indices[wire.next++]
    right.used[r] = true
    left.used[l] = true
    pairs.push([l, r])
  })
  const unpaired = (source: typeof left, opposite: typeof right): UnpairedColumn[] =>
    source.columns.flatMap((column, index) => {
      const key = source.keys[index]
      if (source.used[index] || key === undefined) return []
      const named = opposite.names.get(key)
      const wire = named?.wires.get(column.wire)
      const other = wire ? opposite.columns[wire.indices[0]] : named?.first
      return [{ index, name: column.name, dataType: column.dataType ?? '', ...other ? { otherType: other.dataType ?? '' } : {}, ...other?.wire === column.wire ? { repeat: true as const } : {} }]
    })
  return { pairs, oldOnly: unpaired(left, right), newOnly: unpaired(right, left) }
}
