/** Menu placement in CSS pixels, without the DOM: the layer measures each menu once and passes the numbers in. */
export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface Size { readonly width: number; readonly height: number }
/**
 * Where a menu opens: at the pointer; below a menubar button, tree row, tab, or cell; or to the right of a submenu's
 * parent item, whose rect spans the parent menu's left and right and the item's top and bottom.
 */
export type Anchor = { readonly kind: 'point'; readonly x: number; readonly y: number } | { readonly kind: 'below' | 'right'; readonly rect: Rect }
export interface Placement { readonly x: number; readonly y: number; readonly maxHeight: number }

/** Distance kept from the viewport's edges. */
export const menuMargin = 4
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * The top-left corner and height limit of a menu of `size` in `viewport`. It flips to stay inside the viewport,
 * scrolls when it is taller than the space it gets, and stays clear of `avoid` (the window controls' area on Windows
 * and Linux).
 */
export function placeMenu(anchor: Anchor, size: Size, viewport: Size, avoid?: Rect): Placement {
  const m = menuMargin, { width: w, height: h } = size, { width: vw, height: vh } = viewport
  const fitX = (x: number) => w > vw - 2 * m ? m : clamp(x, m, vw - m - w)
  let x: number, y: number, maxHeight = vh - 2 * m
  if (anchor.kind === 'point') {
    x = anchor.x + w > vw - m ? Math.max(m, anchor.x - w) : anchor.x
    y = anchor.y
    if (y + h > vh - m) { y = anchor.y - h; if (y < m) y = Math.max(m, vh - m - h) }
    if (h > vh - 2 * m) y = m
    x = fitX(x)
  } else if (anchor.kind === 'below') {
    const { rect } = anchor
    x = fitX(rect.left + w > vw - m ? rect.right - w : rect.left)
    const below = vh - m - rect.bottom, above = rect.top - m
    if (h <= below) y = rect.bottom
    else if (h <= above) y = rect.top - h
    else if (below >= above) { y = rect.bottom; maxHeight = below }
    else { y = Math.max(m, rect.top - h); maxHeight = above }
  } else {
    const { rect } = anchor
    x = rect.right - 2
    if (x + w > vw - m) { x = rect.left - w + 2; if (x < m) x = m }
    y = clamp(rect.top - 4, m, Math.max(m, vh - m - h))
  }
  if (avoid && intersects({ left: x, top: y, right: x + w, bottom: y + Math.min(h, maxHeight) }, avoid)) y = avoid.bottom + m
  return { x, y, maxHeight: Math.max(0, Math.min(maxHeight, vh - m - y)) }
}

const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
/**
 * Whether the pointer at `p` is still heading from `exit` (where it left the submenu's parent item) into the open
 * submenu: inside the triangle from `exit` to the submenu's near edge, widened by `tolerance` pixels. A pointer that
 * has reached the submenu's side, or an exit point already past the near edge, is not in it.
 */
export function inSafeTriangle(p: Point, exit: Point, submenu: Rect, side: 'left' | 'right', tolerance = 4): boolean {
  const edge = side === 'right' ? submenu.left : submenu.right, toward = side === 'right' ? 1 : -1
  if ((edge - exit.x) * toward <= 0 || (edge - p.x) * toward < 0) return false
  const apex = { x: exit.x - toward * tolerance, y: exit.y }
  const top = { x: edge, y: submenu.top - tolerance }, bottom = { x: edge, y: submenu.bottom + tolerance }
  const [a, b, c] = [cross(apex, top, p), cross(top, bottom, p), cross(bottom, apex, p)]
  return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)
}
