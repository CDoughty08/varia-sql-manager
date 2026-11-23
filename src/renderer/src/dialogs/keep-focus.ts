import { useEffect, useRef, type RefObject } from 'react'

const isInertOrDisabled = (element: HTMLElement) => !!(element as HTMLButtonElement).disabled || !!element.closest('[inert], [hidden]')
const canTakeFocus = (element: HTMLElement) => !isInertOrDisabled(element) && element.getClientRects().length > 0
const resolveDialog = (dialog: RefObject<HTMLElement | null> | HTMLElement | null): HTMLElement | null =>
  dialog && 'current' in dialog ? dialog.current : dialog

/**
 * Keeps keyboard focus inside a modal dialog, where its Escape and Tab handlers are. The dialog needs `tabIndex={-1}`,
 * so a press on its text or padding focuses the dialog rather than the page. A control that becomes disabled (Save
 * while it saves) or is removed (a History row's Remove) drops focus to the page: after each render, and when focus
 * leaves for nowhere, focus goes back to that control once it can take focus again, meanwhile to the dialog itself.
 * `held` (a dialog open over this one) leaves focus alone.
 */
export function useKeepFocus(dialog: RefObject<HTMLElement | null> | HTMLElement | null, held: boolean): void {
  const current = resolveDialog(dialog)
  // The control inside the dialog that last had focus, and the one to give it back to while the dialog holds it.
  const last = useRef<HTMLElement | null>(null)
  const wanted = useRef<HTMLElement | null>(null)
  const parking = useRef(false)
  const heldNow = useRef(held)
  heldNow.current = held
  const restore = useRef(() => {})
  restore.current = () => {
    const element = resolveDialog(dialog)
    if (!element || heldNow.current || element.inert || !element.isConnected) return
    const doc = element.ownerDocument, active = doc.activeElement
    const activeDisabled = !!active && active !== element && element.contains(active) && isInertOrDisabled(active as HTMLElement)
    const lost = !active || active === doc.body || activeDisabled
    if (!lost && !(active === element && wanted.current)) return
    const target = wanted.current ?? (activeDisabled ? active as HTMLElement : last.current)
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
    if (!current) return
    const focusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      if (target !== current) { last.current = target; wanted.current = null }
      else if (!parking.current) wanted.current = null
    }
    // A control disabled or removed while focused blurs with no new target; restore once the change has been drawn.
    let frame = 0
    const view = current.ownerDocument.defaultView
    const focusOut = (event: FocusEvent) => {
      if (event.relatedTarget || !view) return
      view.cancelAnimationFrame(frame)
      frame = view.requestAnimationFrame(() => restore.current())
    }
    current.addEventListener('focusin', focusIn)
    current.addEventListener('focusout', focusOut)
    return () => { current.removeEventListener('focusin', focusIn); current.removeEventListener('focusout', focusOut); view?.cancelAnimationFrame(frame) }
  }, [current])
  // Each render may have disabled, re-enabled or removed the focused control.
  useEffect(() => restore.current())
}
