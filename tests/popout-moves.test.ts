import { describe, expect, it } from 'vitest'
import { PopoutMoves } from '../src/renderer/src/popouts/moves'

describe('popout moves', () => {
  it('saves a move made before the first tick, comparing a new window with its saved place', () => {
    const moves = new PopoutMoves()
    // The popout opened at x 151 and that place was saved; it moved to 191 before the check first saw it.
    expect(moves.moved('a', { x: 191, y: 130 }, { x: 151, y: 100 })).toBe(true)
    expect(moves.moved('a', { x: 191, y: 130 }, { x: 191, y: 130 })).toBe(false)
  })

  it('compares later ticks with the previous one, and a window not saved yet with nothing', () => {
    const moves = new PopoutMoves()
    expect(moves.moved('a', { x: 10, y: 10 }, undefined)).toBe(false)
    expect(moves.moved('a', { x: 10, y: 10 }, { x: 0, y: 0 })).toBe(false)
    expect(moves.moved('a', { x: 20, y: 10 }, undefined)).toBe(true)
    expect(moves.moved('a', { x: 20, y: 10 }, { x: 10, y: 10 })).toBe(false)
  })

  it('forgets closed windows', () => {
    const moves = new PopoutMoves()
    moves.moved('a', { x: 10, y: 10 }, undefined)
    moves.keep(new Set())
    expect(moves.moved('a', { x: 30, y: 10 }, undefined)).toBe(false)
  })
})
