// A grid's pooled row slots, kept in the DOM in row order: screen readers' browse mode and table commands follow the
// DOM, whatever aria-rowindex says. Slot s shows row r when s = (r − base) mod n, and the DOM holds the n slots as a
// rotation that starts with the slot of the first row shown (`start`).

export interface RowRing { readonly base: number; readonly start: number; readonly first: number }
/** The ring after the first row moved, and the slots to move: `toEnd` in order to the end of the rotation, or `toFront`
 *  in order to its front (each before the one moved before it). */
export interface RingStep { readonly ring: RowRing; readonly toEnd: readonly number[]; readonly toFront: readonly number[] }

const mod = (value: number, n: number) => ((value % n) + n) % n
const none: readonly number[] = []

/** A ring of `count` slots whose DOM order is slot 0 to slot count − 1, showing `first` in slot 0. */
export const freshRing = (first: number): RowRing => ({ base: first, start: 0, first })
export const slotOf = (ring: RowRing, row: number, count: number): number => mod(row - ring.base, count)

/**
 * The first row shown is now `first`. Rows still shown keep their slots, so moving by d < n rows wraps d slots around,
 * which move from one end of the rotation to the other (or the n − d that stay move the other way, whichever is fewer).
 * A move of n rows or more keeps no row, so the slots are renumbered instead and nothing moves.
 */
export function ringStep(ring: RowRing, first: number, count: number): RingStep {
  const delta = first - ring.first
  if (delta === 0 || count <= 0) return { ring, toEnd: none, toFront: none }
  if (Math.abs(delta) >= count) return { ring: { base: first - ring.start, start: ring.start, first }, toEnd: none, toFront: none }
  const shift = mod(delta, count), next: RowRing = { base: ring.base, start: mod(ring.start + delta, count), first }
  if (shift <= count - shift) return { ring: next, toEnd: Array.from({ length: shift }, (_, index) => mod(ring.start + index, count)), toFront: none }
  return { ring: next, toEnd: none, toFront: Array.from({ length: count - shift }, (_, index) => mod(ring.start - 1 - index, count)) }
}
