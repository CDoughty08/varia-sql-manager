import { describe, expect, it } from 'vitest'
import { inSafeTriangle, menuMargin as m, placeMenu, type Rect } from '../src/renderer/src/menus/geometry'

const small = { width: 220, height: 300 }
const viewports = [{ width: 1024, height: 700 }, { width: 1600, height: 1000 }]
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height })
const inside = (placement: { x: number; y: number; maxHeight: number }, size: { width: number; height: number }, viewport: { width: number; height: number }) =>
  placement.x >= m && placement.y >= m && placement.x + size.width <= viewport.width - m && placement.y + Math.min(size.height, placement.maxHeight) <= viewport.height - m

describe('menu placement', () => {
  it.each(viewports)('opens at the pointer, flipping and clamping into a $width×$height viewport', viewport => {
    const { width: vw, height: vh } = viewport
    expect(placeMenu({ kind: 'point', x: 100, y: 120 }, small, viewport)).toEqual({ x: 100, y: 120, maxHeight: vh - m - 120 })
    // Near the bottom-right corner it opens up and to the left of the pointer.
    const corner = placeMenu({ kind: 'point', x: vw - 5, y: vh - 5 }, small, viewport)
    expect(corner).toMatchObject({ x: vw - 5 - small.width, y: vh - 5 - small.height })
    expect(inside(corner, small, viewport)).toBe(true)
    // Too tall to open above or below the pointer: as low as it fits.
    const tall = { width: 220, height: vh - 100 }
    expect(placeMenu({ kind: 'point', x: 10, y: 300 }, tall, viewport)).toMatchObject({ y: vh - m - tall.height })
    // Taller than the viewport: from the top margin, scrolling.
    expect(placeMenu({ kind: 'point', x: 10, y: 300 }, { width: 220, height: vh + 50 }, viewport)).toEqual({ x: 10, y: m, maxHeight: vh - 2 * m })
    // Wider than the space left of the pointer: floored at the margin.
    expect(placeMenu({ kind: 'point', x: 100, y: 10 }, { width: vw - 50, height: 100 }, viewport).x).toBe(m)
    expect(placeMenu({ kind: 'point', x: 0, y: 0 }, small, viewport)).toMatchObject({ x: m, y: 0 })
  })
  it.each(viewports)('opens below an anchor, flipping above or limiting its height in a $width×$height viewport', viewport => {
    const { width: vw, height: vh } = viewport
    const button = rect(40, 0, 50, 34)
    expect(placeMenu({ kind: 'below', rect: button }, small, viewport)).toEqual({ x: 40, y: 34, maxHeight: vh - m - 34 })
    // At the right edge it aligns its right side with the anchor's.
    expect(placeMenu({ kind: 'below', rect: rect(vw - 60, 100, 50, 20) }, small, viewport)).toMatchObject({ x: vw - 10 - small.width, y: 120 })
    // No room below but room above: flipped.
    expect(placeMenu({ kind: 'below', rect: rect(200, vh - 40, 100, 24) }, small, viewport)).toMatchObject({ y: vh - 40 - small.height })
    // Room on neither side: the larger one, scrolling.
    const tall = { width: 220, height: vh }
    expect(placeMenu({ kind: 'below', rect: rect(200, 100, 100, 24) }, tall, viewport)).toEqual({ x: 200, y: 124, maxHeight: vh - m - 124 })
    expect(placeMenu({ kind: 'below', rect: rect(200, vh - 100, 100, 24) }, tall, viewport)).toEqual({ x: 200, y: m, maxHeight: vh - 100 - m })
  })
  it.each(viewports)('opens a submenu beside its parent item in a $width×$height viewport', viewport => {
    const { width: vw, height: vh } = viewport
    const parent = { left: 100, right: 320, top: 200, bottom: 224 }
    expect(placeMenu({ kind: 'right', rect: parent }, small, viewport)).toEqual({ x: 318, y: 196, maxHeight: vh - m - 196 })
    // No room on the right: on the left, overlapping the parent by 2 px.
    const nearRight = { left: vw - 230, right: vw - 10, top: 200, bottom: 224 }
    expect(placeMenu({ kind: 'right', rect: nearRight }, small, viewport).x).toBe(vw - 230 - small.width + 2)
    // No room on either side: at the margin, over the parent.
    expect(placeMenu({ kind: 'right', rect: { left: 10, right: vw - 10, top: 200, bottom: 224 } }, small, viewport).x).toBe(m)
    // Near the bottom it moves up to fit.
    const low = placeMenu({ kind: 'right', rect: { ...parent, top: vh - 30, bottom: vh - 6 } }, small, viewport)
    expect(low.y).toBe(vh - m - small.height)
    expect(inside(low, small, viewport)).toBe(true)
  })
  it('stays clear of the window controls', () => {
    const viewport = { width: 1024, height: 700 }, avoid = rect(880, 0, 144, 34)
    expect(placeMenu({ kind: 'point', x: 900, y: 10 }, small, viewport, avoid)).toMatchObject({ x: 900 - small.width, y: 34 + m })
    expect(placeMenu({ kind: 'point', x: 300, y: 10 }, small, viewport, avoid)).toMatchObject({ x: 300, y: 10 })
    expect(placeMenu({ kind: 'point', x: 900, y: 10 }, { width: 100, height: 800 }, viewport, avoid)).toEqual({ x: 900, y: 34 + m, maxHeight: 700 - m - 34 - m })
  })
})

describe('safe triangle', () => {
  const submenu = rect(300, 100, 200, 300)
  it('holds points between the exit point and the submenu\'s near edge', () => {
    const exit = { x: 250, y: 150 }
    expect(inSafeTriangle({ x: 280, y: 200 }, exit, submenu, 'right')).toBe(true)
    expect(inSafeTriangle({ x: 299, y: 390 }, exit, submenu, 'right')).toBe(true)
    expect(inSafeTriangle({ x: 300, y: 98 }, exit, submenu, 'right')).toBe(true)
    expect(inSafeTriangle({ x: 252, y: 150 }, exit, submenu, 'right')).toBe(true)
    // Moving straight down along the parent menu leaves it.
    expect(inSafeTriangle({ x: 250, y: 200 }, exit, submenu, 'right')).toBe(false)
    expect(inSafeTriangle({ x: 280, y: 90 }, exit, submenu, 'right')).toBe(false)
    expect(inSafeTriangle({ x: 240, y: 150 }, exit, submenu, 'right')).toBe(false)
  })
  it('works for a submenu on the left and allows 4 px of tolerance', () => {
    const left = rect(0, 100, 200, 300), exit = { x: 260, y: 150 }
    expect(inSafeTriangle({ x: 220, y: 200 }, exit, left, 'left')).toBe(true)
    expect(inSafeTriangle({ x: 263, y: 150 }, exit, left, 'left')).toBe(true)
    expect(inSafeTriangle({ x: 265, y: 150 }, exit, left, 'left')).toBe(false)
    expect(inSafeTriangle({ x: 220, y: 200 }, exit, left, 'right')).toBe(false)
  })
  it('is empty when degenerate: an exit point on or past the near edge, or a pointer past it', () => {
    expect(inSafeTriangle({ x: 300, y: 150 }, { x: 300, y: 150 }, submenu, 'right')).toBe(false)
    expect(inSafeTriangle({ x: 320, y: 150 }, { x: 310, y: 150 }, submenu, 'right')).toBe(false)
    expect(inSafeTriangle({ x: 301, y: 150 }, { x: 250, y: 150 }, submenu, 'right')).toBe(false)
    expect(inSafeTriangle({ x: 280, y: 200 }, { x: 250, y: 150 }, rect(300, 100, 200, 0), 'right')).toBe(false)
  })
})
