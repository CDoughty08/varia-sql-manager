import { gridLimits as g } from './constants'
import type { ColumnLayout } from './layout'

// Vertical scrolling. Chromium lays out in physical pixels and clamps boxes at about 33.5 million layout units, so the
// tallest spacer that still scrolls to its end is that limit divided by the device pixel ratio. Up to the cap the
// scroller is native (Mode A: the compositor scrolls, JS only fills rows). Past it (Mode B) the spacer is cap tall,
// the scrollbar thumb maps proportionally to a virtual offset, wheel and keys move the virtual offset 1:1, and the row
// container is translated so rows sit near the viewport whatever the virtual offset.

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** The tallest spacer, in CSS pixels, at a device pixel ratio (zoom included). */
export function scrollCap(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return Math.min(g.scrollCap, Math.floor(g.scrollCapPhysical / ratio))
}

export interface ScrollModel {
  /** 'native' is Mode A, 'virtual' Mode B. */
  readonly mode: 'native' | 'virtual'
  readonly rows: number
  /** Header plus rows: the height the content would have without a cap. */
  readonly contentHeight: number
  /** The spacer's height: the content, or the cap in Mode B. */
  readonly spacerHeight: number
  readonly viewportHeight: number
  /** The largest virtual offset (the last row at the bottom). */
  readonly maxVirtual: number
  /** The largest native scrollTop. */
  readonly maxNative: number
  /** Virtual pixels per native pixel; 1 in Mode A. */
  readonly ratio: number
}

export function scrollModel(rows: number, viewportHeight: number, cap: number): ScrollModel {
  const contentHeight = g.headerHeight + Math.max(0, rows) * g.rowHeight, viewport = Math.max(0, viewportHeight)
  const maxVirtual = Math.max(0, contentHeight - viewport)
  if (contentHeight <= cap) return { mode: 'native', rows, contentHeight, spacerHeight: contentHeight, viewportHeight: viewport, maxVirtual, maxNative: maxVirtual, ratio: 1 }
  const maxNative = Math.max(0, cap - viewport)
  return { mode: 'virtual', rows, contentHeight, spacerHeight: cap, viewportHeight: viewport, maxVirtual, maxNative, ratio: maxNative > 0 ? maxVirtual / maxNative : 1 }
}

/** The virtual offset a native scrollTop shows: itself in Mode A, proportional in Mode B (a scrollbar drag). */
export function toVirtual(model: ScrollModel, scrollTop: number): number {
  return model.mode === 'native' ? clamp(scrollTop, 0, model.maxVirtual) : clamp(scrollTop * model.ratio, 0, model.maxVirtual)
}
/** The native scrollTop that shows a virtual offset. */
export function toNative(model: ScrollModel, virtualTop: number): number {
  return model.mode === 'native' ? clamp(virtualTop, 0, model.maxNative) : clamp(Math.round(virtualTop / model.ratio), 0, model.maxNative)
}

/**
 * The virtual offset after a scroll event. In Mode B a scrollTop within 1 px of the one the grid set itself is that
 * write's echo and keeps the virtual offset (which is finer than a native pixel); anything else is the user's drag.
 */
export function onNativeScroll(model: ScrollModel, scrollTop: number, virtualTop: number, written?: number): number {
  if (model.mode === 'virtual' && written !== undefined && Math.abs(scrollTop - written) <= 1) return clamp(virtualTop, 0, model.maxVirtual)
  return toVirtual(model, scrollTop)
}

/** The first row whose top is at or above the body's top edge. */
export const topRowOf = (virtualTop: number): number => Math.max(0, Math.floor(virtualTop / g.rowHeight))
/** In Mode B rows are positioned from a base row, a multiple of 4,096, so their offsets stay small. */
export const rebaseRow = (topRow: number): number => Math.max(0, Math.floor(topRow / g.rebaseRows) * g.rebaseRows)
/** A row's `top` inside the row container. */
export const rowTop = (row: number, baseRow: number): number => g.headerHeight + (row - baseRow) * g.rowHeight
/** The row container's translateY: 0 in Mode A; in Mode B it moves the base row to its virtual place under the viewport. */
export function rowsContainerY(model: ScrollModel, scrollTop: number, virtualTop: number, baseRow: number): number {
  return model.mode === 'native' ? 0 : scrollTop - (virtualTop - baseRow * g.rowHeight)
}

/**
 * The virtual offset to keep when the model changes (rows streamed in, the viewport resized, the cap moved): the same
 * offset, clamped, so the top row stays put even when the mode flips from native to virtual; and the scrollTop to write.
 */
export function remap(next: ScrollModel, virtualTop: number): { readonly virtualTop: number; readonly scrollTop: number } {
  const top = clamp(virtualTop, 0, next.maxVirtual)
  return { virtualTop: top, scrollTop: toNative(next, top) }
}

/** A wheel delta in pixels: deltaMode 1 is lines (a row each), 2 is pages (the body less one row). */
export function normalizeWheel(delta: number, deltaMode: number, viewportHeight: number): number {
  if (deltaMode === 1) return delta * g.rowHeight
  if (deltaMode === 2) return delta * Math.max(g.rowHeight, viewportHeight - g.headerHeight - g.rowHeight)
  return delta
}
/**
 * A Mode B wheel step, which moves the virtual offset 1:1. `handled` is false at the first or last row in the wheel's
 * direction, so the event is left to the outer stack, which then scrolls instead.
 */
export function applyWheel(model: ScrollModel, virtualTop: number, deltaPx: number): { readonly virtualTop: number; readonly handled: boolean } {
  const next = clamp(virtualTop + deltaPx, 0, model.maxVirtual)
  const atEdge = (deltaPx < 0 && virtualTop <= 0) || (deltaPx > 0 && virtualTop >= model.maxVirtual)
  return { virtualTop: next, handled: deltaPx !== 0 && !atEdge }
}

/**
 * The offsets that bring a cell into view with the least movement ('nearest', never smooth). A column wider than the
 * body aligns its left edge; `column` −1 leaves the horizontal offset alone.
 */
export function ensureVisible(o: {
  readonly virtualTop: number; readonly scrollLeft: number; readonly viewportWidth: number; readonly viewportHeight: number
  readonly rowHeader: number; readonly layout: ColumnLayout; readonly rows: number
}, row: number, column: number): { readonly virtualTop: number; readonly scrollLeft: number } {
  const bodyHeight = Math.max(g.rowHeight, o.viewportHeight - g.headerHeight), bodyWidth = Math.max(0, o.viewportWidth - o.rowHeader)
  const maxVirtual = Math.max(0, g.headerHeight + o.rows * g.rowHeight - o.viewportHeight)
  let virtualTop = o.virtualTop
  if (row >= 0) {
    const top = row * g.rowHeight
    if (top < virtualTop) virtualTop = top
    else if (top + g.rowHeight > virtualTop + bodyHeight) virtualTop = top + g.rowHeight - bodyHeight
  }
  let scrollLeft = o.scrollLeft
  if (column >= 0 && column < o.layout.count) {
    const left = o.layout.xOf(column), right = left + o.layout.width(column)
    if (left < scrollLeft || right - left > bodyWidth) scrollLeft = left
    else if (right > scrollLeft + bodyWidth) scrollLeft = right - bodyWidth
  }
  return { virtualTop: clamp(virtualTop, 0, maxVirtual), scrollLeft: clamp(scrollLeft, 0, Math.max(0, o.layout.total + o.rowHeader - o.viewportWidth)) }
}
