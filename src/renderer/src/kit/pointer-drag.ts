/** The ways a captured pointer drag ends: a cancelled touch or pen drag sends pointercancel and no pointerup, and a capture
 *  the browser takes back sends lostpointercapture. */
export const pointerDragEnds = ['pointerup', 'pointercancel', 'lostpointercapture'] as const

/**
 * Follows one pointer's drag on `target` (a splitter): captures the pointer, calls `onMove` with each of its moves, and drops
 * every listener however the drag ends, so a drag that ends without a pointerup does not keep resizing on a later hover.
 */
export function followPointerDrag(target: HTMLElement, pointerId: number, onMove: (moved: PointerEvent) => void, onEnd?: (ended: PointerEvent) => void): boolean {
  // A pointer already gone cannot be captured: without capture its pointerup could land elsewhere and leave the listeners, so no drag starts.
  try { target.setPointerCapture(pointerId) } catch { return false }
  const move = (moved: PointerEvent) => { if (moved.pointerId === pointerId) onMove(moved) }
  const end = (ended: PointerEvent) => {
    if (ended.pointerId !== pointerId) return
    target.removeEventListener('pointermove', move)
    for (const type of pointerDragEnds) target.removeEventListener(type, end)
    onEnd?.(ended)
  }
  target.addEventListener('pointermove', move)
  for (const type of pointerDragEnds) target.addEventListener(type, end)
  return true
}
