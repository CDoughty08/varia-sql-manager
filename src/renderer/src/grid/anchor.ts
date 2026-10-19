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
