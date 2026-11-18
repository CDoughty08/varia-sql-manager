import { useEffect, useRef, type RefObject } from 'react'

const canTakeFocus = (element: HTMLElement) => !(element as HTMLButtonElement).disabled && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0

/**
 * Keeps keyboard focus inside a modal dialog, where its Escape and Tab handlers are. The dialog needs `tabIndex={-1}`,
 * so a press on its text or padding focuses the dialog rather than the page. A control that becomes disabled (Save
 * while it saves) or is removed (a History row's Remove) drops focus to the page: after each render, and when focus
 * leaves for nowhere, focus goes back to that control once it can take focus again, meanwhile to the dialog itself.
 * `held` (a dialog open over this one) leaves focus alone.
 */
export function useKeepFocus(dialog: RefObject<HTMLElement | null>, held: boolean): void {
  // The control inside the dialog that last had focus, and the one to give it back to while the dialog holds it.
  const last = useRef<HTMLElement | null>(null)
  const wanted = useRef<HTMLElement | null>(null)
  const parking = useRef(false)
  const heldNow = useRef(held)
  heldNow.current = held
  const restore = useRef(() => {})
  restore.current = () => {
    const element = dialog.current
    if (!element || heldNow.current || element.inert || !element.isConnected) return
    const doc = element.ownerDocument, active = doc.activeElement
    const lost = !active || active === doc.body
    if (!lost && !(active === element && wanted.current)) return
    const target = wanted.current ?? last.current
    if (target?.isConnected && element.contains(target) && canTakeFocus(target)) {
      target.focus({ preventScroll: true })
      if (doc.activeElement === target) { wanted.current = null; return }
    }
    if (!lost) return
    parking.current = true
    try { element.focus({ preventScroll: true }) } finally { parking.current = false }
    wanted.current = target?.isConnected ? target : null
  }
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const focusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      if (target !== element) { last.current = target; wanted.current = null }
      else if (!parking.current) wanted.current = null
    }
    // A control disabled or removed while focused blurs with no new target; restore once the change has been drawn.
    let frame = 0
    const view = element.ownerDocument.defaultView
    const focusOut = (event: FocusEvent) => {
      if (event.relatedTarget || !view) return
      view.cancelAnimationFrame(frame)
      frame = view.requestAnimationFrame(() => restore.current())
    }
    element.addEventListener('focusin', focusIn)
    element.addEventListener('focusout', focusOut)
    return () => { element.removeEventListener('focusin', focusIn); element.removeEventListener('focusout', focusOut); view?.cancelAnimationFrame(frame) }
  }, [dialog])
  // Each render may have disabled, re-enabled or removed the focused control.
  useEffect(() => restore.current())
}
