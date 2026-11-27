import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { trapFocus } from '../trap-focus'
import { focusToReturn, isElement, returnFocusTo } from '../core/focus'
import DialogFooter from '../kit/DialogFooter'
import { useDialogWindow } from '../popouts/DialogWindow'

export interface SubDialogProps {
  readonly title: string
  readonly okLabel?: string
  readonly cancelLabel?: string
  readonly okDisabled?: boolean
  onOk(): void
  onCancel(): void
  /** The id of the element that takes focus as it opens; otherwise its first field. */
  readonly initialFocus?: string
  /** A size of its own (`server-file-picker`), beside the default 420 px. */
  readonly className?: string
  /** A line beside OK and Cancel (the server file picker's count and hint). */
  readonly status?: ReactNode
  /** A destructive OK (Kill Process): Cancel takes focus as the dialog opens, so a stray Enter cancels, and OK is drawn as danger. */
  readonly destructive?: boolean
  /** A third choice between OK and Cancel (Don't Save in Save / Don't Save / Cancel). */
  readonly alternative?: { readonly label: string; run(): void }
  /** A question that needs an answer (BigQuery's cost prompt): announced as an alert dialog with `describedBy` read out,
   *  Cancel takes focus as it opens, and OK runs only from its own button, as for a destructive OK, without the danger style. */
  readonly alert?: boolean
  readonly describedBy?: string
  /** When false, suppresses per-instance focus capture/return (managed by an outer modal queue wrapper). */
  readonly manageReturnFocus?: boolean
  /** Invoked on mount right before initial focus is placed (after any closing modal's cleanup has restored focus). */
  readonly onBeforeInitialFocus?: () => void
  readonly children: ReactNode
}

/**
 * A modal dialog over another one (SSMS's Change Autogrowth, the table designer's Choose Name): a title, its fields, and
 * OK and Cancel. Tab stays inside it, and Escape and Enter are handled here, so only this dialog closes; focus returns
 * to where it was.
 */
export default function SubDialog({ title, okLabel = 'OK', cancelLabel = 'Cancel', okDisabled, onOk, onCancel, initialFocus, className, status, destructive, alternative, alert, describedBy, manageReturnFocus = true, onBeforeInitialFocus, children }: SubDialogProps) {
  const { ownerDocument } = useDialogWindow()
  const titleId = useId()
  const form = useRef<HTMLFormElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // Read while rendering, before the dialog takes focus.
  const returnFocus = useRef(manageReturnFocus ? focusToReturn() : null)
  const beforeInitialFocusRef = useRef(onBeforeInitialFocus)
  beforeInitialFocusRef.current = onBeforeInitialFocus
  useEffect(() => {
    beforeInitialFocusRef.current?.()
    const doc = form.current?.ownerDocument ?? ownerDocument
    const target = (destructive || alert ? cancel.current : null) ?? (initialFocus ? doc.getElementById(initialFocus) : null) ?? form.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')
    target?.focus()
    if (!manageReturnFocus) return
    const previous = returnFocus.current
    return () => returnFocusTo(previous)
  }, [initialFocus, destructive, alert, ownerDocument, manageReturnFocus])
  // OK disabled while its work runs (Killing…) drops focus to the page: keep it in the dialog, where Tab and Escape work.
  useEffect(() => {
    const doc = form.current?.ownerDocument ?? ownerDocument
    const active = doc.activeElement
    if (okDisabled && form.current && (!active || active === doc.body)) form.current.focus()
  }, [okDisabled, ownerDocument])
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // A portal's events still bubble to the dialog it opened over, which must not also act on them.
    event.stopPropagation()
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    else if (event.key === 'Enter') {
      // A button presses itself and a drop-down list opens; a list box (Select Database Owner's) chooses, as OK does.
      // A destructive or alert OK runs only from its own button: prevent implicit form submission from inputs/checkboxes.
      if (isElement(event.target) && (event.target.tagName === 'BUTTON' || (event.target.tagName === 'SELECT' && (event.target as HTMLSelectElement).size <= 1))) return
      event.preventDefault()
      if (destructive || alert) return
      if (!okDisabled) onOk()
    }
  }
  // In a portal of the active window's document: a form cannot hold another form, and a dialog OS window keeps its own document.
  return createPortal(<div className="modal-backdrop sub-dialog-backdrop"><form ref={form} className={className ? `connection-modal sub-dialog ${className}` : 'connection-modal sub-dialog'} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!okDisabled) onOk() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id={titleId}>{title}</h2></div>
    <div className="sub-dialog-body">{children}</div>
    <DialogFooter
      status={<span className="sub-dialog-status">{status}</span>}
      trailing={<>
        <button className={destructive ? 'danger' : 'primary'} type="submit" disabled={okDisabled}>{okLabel}</button>
        {alternative && <button type="button" onClick={alternative.run}>{alternative.label}</button>}
        <button type="button" ref={cancel} onClick={onCancel}>{cancelLabel}</button>
      </>}
    />
  </form></div>, ownerDocument.body)
}
