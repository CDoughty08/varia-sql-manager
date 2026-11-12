// What a keyboard-opened menu on a results grid opens below. GridView registers each grid root; the menu targets ask at
// event time, and the grid first paints a frame that is still pending, so a Shift+F10 pressed right after a click or a
// key opens below the cell that is active now rather than the one painted last.

const anchors = new WeakMap<Element, () => Element>()

/** Registers the grid at `root`; the returned function unregisters it. */
export function registerGridAnchor(root: Element, anchor: () => Element): () => void {
  anchors.set(root, anchor)
  return () => { if (anchors.get(root) === anchor) anchors.delete(root) }
}

/** The element a keyboard-opened menu on the grid at `root` opens below, or undefined when no grid is registered there. */
export function gridAnchor(root: Element): Element | undefined {
  return anchors.get(root)?.()
}

/** What a menu opened on an element of a grid is for, in the result's rows and columns: a cell both, a column's header its
 *  column, a row's number its row. The grid answers from its own slots, so the answer holds however it draws them (ARIA
 *  indices number what is drawn). */
export interface GridTarget { readonly row?: number; readonly column?: number }
const targets = new WeakMap<Element, (element: Element) => GridTarget | undefined>()
/** Registers the grid at `root`; the returned function unregisters it. */
export function registerGridTarget(root: Element, target: (element: Element) => GridTarget | undefined): () => void {
  targets.set(root, target)
  return () => { if (targets.get(root) === target) targets.delete(root) }
}
/** The target under `element` in the grid at `root`; undefined when no grid is registered there (`registered` tells which). */
export function gridTarget(root: Element, element: Element): { readonly registered: boolean; readonly target?: GridTarget } {
  const resolve = targets.get(root)
  return resolve ? { registered: true, target: resolve(element) } : { registered: false }
}
