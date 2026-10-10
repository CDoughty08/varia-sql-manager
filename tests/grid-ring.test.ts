import { describe, expect, it } from 'vitest'
import { freshRing, ringStep, rotation, slotOf, type RowRing } from '../src/renderer/src/grid/ring'

/** Plays the moves on a list of slots standing for the DOM, as GridView does. */
function apply(dom: number[], step: { toEnd: readonly number[]; toFront: readonly number[] }, oldFront: number): number[] {
  let order = [...dom]
  for (const slot of step.toEnd) order = [...order.filter(item => item !== slot), slot]
  let front = oldFront
  for (const slot of step.toFront) {
    order = order.filter(item => item !== slot)
    order.splice(order.indexOf(front), 0, slot)
    front = slot
  }
  return order
}

describe('grid row ring', () => {
  it('keeps the slots of the rows shown in row order in the DOM, moving only the slots that wrap around', () => {
    const count = 10
    let ring: RowRing = freshRing(0), dom = Array.from({ length: count }, (_, slot) => slot)
    let moved = 0
    for (const first of [1, 2, 5, 4, 0, 9, 3, 12, 30, 29, 25, 26]) {
      const step = ringStep(ring, first, count)
      moved += step.toEnd.length + step.toFront.length
      expect(step.toEnd.length + step.toFront.length, `to ${first}`).toBeLessThanOrEqual(count / 2)
      dom = apply(dom, step, dom[0])
      ring = step.ring
      // Rows first..first+count-1 read in DOM order, and a row still shown keeps its slot.
      expect(Array.from({ length: count }, (_, index) => dom.indexOf(slotOf(ring, first + index, count))), `to ${first}`).toEqual(Array.from({ length: count }, (_, index) => index))
    }
    expect(moved).toBeGreaterThan(0)
  })
  it('moves one slot to the end for each row scrolled down, and to the front for each row scrolled up', () => {
    const ring = freshRing(100)
    expect(ringStep(ring, 101, 8)).toEqual({ ring: { base: 100, start: 1, first: 101 }, toEnd: [0], toFront: [] })
    expect(ringStep(ring, 98, 8)).toEqual({ ring: { base: 100, start: 6, first: 98 }, toEnd: [], toFront: [7, 6] })
    // Six rows down in eight slots: the two that stay move to the front instead.
    expect(ringStep(ring, 106, 8)).toEqual({ ring: { base: 100, start: 6, first: 106 }, toEnd: [], toFront: [7, 6] })
  })
  it('catches a DOM left behind while rows scrolled up with the ring in one rotation', () => {
    const count = 10
    let ring: RowRing = freshRing(0)
    const dom = Array.from({ length: count }, (_, slot) => slot)
    // The ring moves frame by frame (and once by more than the pool) while the DOM keeps its order.
    for (const first of [3, 7, 12, 40, 44]) ring = ringStep(ring, first, count).ring
    const caught = apply(dom, rotation(0, ring.start, count), dom[0])
    expect(Array.from({ length: count }, (_, index) => caught.indexOf(slotOf(ring, 44 + index, count)))).toEqual(Array.from({ length: count }, (_, index) => index))
    expect(rotation(4, 4, count)).toEqual({ toEnd: [], toFront: [] })
    expect(rotation(2, 5, 8)).toEqual({ toEnd: [2, 3, 4], toFront: [] })
    expect(rotation(5, 2, 8)).toEqual({ toEnd: [], toFront: [4, 3, 2] })
  })
  it('renumbers the slots instead of moving any when no row stays shown', () => {
    const ring = ringStep(freshRing(0), 3, 8).ring
    const step = ringStep(ring, 50_000, 8)
    expect(step.toEnd).toEqual([])
    expect(step.toFront).toEqual([])
    expect(slotOf(step.ring, 50_000, 8)).toBe(ring.start)
    expect(ringStep(step.ring, 50_000, 8).ring).toBe(step.ring)
  })
})
