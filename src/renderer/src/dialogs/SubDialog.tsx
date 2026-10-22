import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { trapFocus } from '../trap-focus'

export interface SubDialogProps {
  readonly title: string
  readonly okLabel?: string
  readonly cancelLabel?: string
  readonly okDisabled?: boolean
  onOk(): void
  onCancel(): void
  /** The id of the element that takes focus as it opens; otherwise its first field. */
  readonly initialFocus?: string
  readonly children: ReactNode
}

/**
 * A modal dialog over another one (SSMS's Change Autogrowth, the table designer's Choose Name): a title, its fields, and
 * OK and Cancel. Tab stays inside it, and Escape and Enter are handled here, so only this dialog closes; focus returns
 * to where it was.
 */
export default function SubDialog({ title, okLabel = 'OK', cancelLabel = 'Cancel', okDisabled, onOk, onCancel, initialFocus, children }: SubDialogProps) {
  const titleId = useId()
  const form = useRef<HTMLFormElement>(null)
  // Read while rendering, before the dialog takes focus.
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    const target = (initialFocus ? document.getElementById(initialFocus) : null) ?? form.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')
    target?.focus()
    const previous = returnFocus.current
    return () => { if (previous?.isConnected) previous.focus() }
  }, [initialFocus])
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // A portal's events still bubble to the dialog it opened over, which must not also act on them.
    event.stopPropagation()
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    else if (event.key === 'Enter') {
      // A button presses itself and a drop-down list opens; a list box (Select Database Owner's) chooses, as OK does.
      if (event.target instanceof HTMLButtonElement || (event.target instanceof HTMLSelectElement && event.target.size <= 1)) return
      event.preventDefault()
      if (!okDisabled) onOk()
    }
  }
  // In a portal: a form cannot hold another form.
  return createPortal(<div className="modal-backdrop sub-dialog-backdrop"><form ref={form} className="connection-modal sub-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!okDisabled) onOk() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id={titleId}>{title}</h2></div>
    <div className="sub-dialog-body">{children}</div>
    <div className="connection-footer">
      <span />
      <button className="primary" type="submit" disabled={okDisabled}>{okLabel}</button>
      <button type="button" onClick={onCancel}>{cancelLabel}</button>
    </div>
  </form></div>, document.body)
}
