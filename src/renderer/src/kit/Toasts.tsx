import { useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { NotificationService, NotificationSnapshot, Toast, ToastSeverity } from '../core/notifications'
import { copyStatus, copyText, errorDetailsText, type CopyRecord } from './format'

type Clipboard = (text: string) => Promise<{ readonly ok: boolean }>
type Notifications = Pick<NotificationService, 'dismiss' | 'run' | 'hold'>

/** The glyph and the word screen readers hear for each severity (the colour alone says nothing to them). */
export const toastSeverities: Readonly<Record<ToastSeverity, { readonly icon: string; readonly label: string }>> = {
  info: { icon: 'info', label: 'Information' }, warning: { icon: 'warning', label: 'Warning' }, error: { icon: 'error', label: 'Error' }
}
const mainClipboard: Clipboard = text => typeof window !== 'undefined' && window.varia ? window.varia.writeClipboardText(text) : Promise.resolve({ ok: false })

function ToastView({ toast, notifications, writeClipboard, leave }: { toast: Toast; notifications: Notifications; writeClipboard: Clipboard; leave: (element: HTMLElement | null) => void }) {
  const [copied, setCopied] = useState<CopyRecord>()
  const box = useRef<HTMLDivElement>(null)
  // Focus Notifications lands on the toast itself: its name says the severity, and its description reads the sentence.
  const messageId = useId()
  const severity = toastSeverities[toast.severity]
  const details = toast.report && toast.severity === 'error' ? errorDetailsText({ ...toast.report, message: toast.message }) : undefined
  // Focus leaves a dismissed toast for its neighbour, or for where it came from, before the toast goes.
  const dismiss = () => { leave(box.current); notifications.dismiss(toast.id) }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    dismiss()
  }
  const blur = (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) notifications.hold(toast.id, false) }
  return <div ref={box} className="toast" data-severity={toast.severity} role="group" aria-label={severity.label} aria-describedby={messageId} tabIndex={-1} onKeyDown={keyDown}
    onPointerEnter={() => notifications.hold(toast.id, true)} onPointerLeave={() => { if (!box.current?.contains(document.activeElement)) notifications.hold(toast.id, false) }}
    onFocus={() => notifications.hold(toast.id, true)} onBlur={blur}>
    <span className={`toast-icon codicon codicon-${severity.icon}`} aria-hidden="true" />
    <div className="toast-body">
      <p id={messageId} className="toast-message">{toast.message}</p>
      {(!!toast.actions?.length || details !== undefined) && <div className="toast-actions">
        {toast.actions?.map(action => <button key={action.label} type="button" onClick={() => { leave(box.current); notifications.run(toast.id, action) }}>{action.label}</button>)}
        {details !== undefined && <button type="button" onClick={() => { void copyText(writeClipboard, details).then(setCopied) }}>Copy details</button>}
        {details !== undefined && <span className="toast-status" role="status">{copyStatus(copied, details)}</span>}
      </div>}
    </div>
    <button type="button" className="icon-button toast-close" aria-label="Dismiss notification" title="Dismiss (Escape)" onClick={dismiss}><span className="codicon codicon-close" aria-hidden="true" /></button>
  </div>
}

interface Props {
  readonly snapshot: NotificationSnapshot
  readonly notifications: Notifications
  /** Main's clipboard API by default: the page never touches the clipboard itself. */
  readonly writeClipboard?: Clipboard
  /** Where focus goes when the last focused toast leaves and nothing outside the stack had focus before. */
  readonly focusFallback?: () => void
}

/**
 * The toast stack, above the status bar at the bottom right: up to three toasts, newest last, and two live regions that
 * read each new toast once (errors at once, the rest politely). It never takes focus by itself; Notifications: Focus
 * Notifications moves focus to the newest toast, and Escape there dismisses it.
 */
export default function Toasts({ snapshot, notifications, writeClipboard = mainClipboard, focusFallback }: Props) {
  const cameFrom = useRef<HTMLElement | null>(null)
  const entered = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) cameFrom.current = event.relatedTarget
  }
  const leave = (element: HTMLElement | null) => {
    if (!element?.contains(document.activeElement)) return
    const sibling = (element.nextElementSibling ?? element.previousElementSibling) as HTMLElement | null
    if (sibling?.classList.contains('toast')) sibling.focus()
    else if (cameFrom.current?.isConnected) cameFrom.current.focus()
    else focusFallback?.()
  }
  const { announcement } = snapshot
  return <div className="toast-layer">
    {snapshot.visible.length > 0 && <section className="toast-stack" aria-label="Notifications" onFocus={entered}>
      {snapshot.visible.map(toast => <ToastView key={toast.id} toast={toast} notifications={notifications} writeClipboard={writeClipboard} leave={leave} />)}
      {snapshot.queued > 0 && <p className="toast-more">{snapshot.queued === 1 ? '1 more notification' : `${snapshot.queued} more notifications`}</p>}
    </section>}
    {/* Always present, so a new toast's sentence is announced as it changes. */}
    <div className="visually-hidden" role="status">{announcement && !announcement.assertive ? announcement.text : ''}</div>
    <div className="visually-hidden" role="alert">{announcement?.assertive ? announcement.text : ''}</div>
  </div>
}
