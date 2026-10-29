import { useState, type ReactNode, type Ref } from 'react'
import Icon from '../Icon'
import { copyStatus, copyText, errorDetailsText, type CopyRecord, type ErrorReport } from './format'

export interface ErrorAction { readonly label: string; readonly run: () => void; readonly buttonRef?: Ref<HTMLButtonElement> }
type Clipboard = (text: string) => Promise<{ readonly ok: boolean }>

interface Props extends ErrorReport {
  /** Why nothing fixes it here, or what to do instead: read with the sentence, under it. */
  readonly note?: string
  /** What to do about it (Retry, Reload …), before Copy details. */
  readonly actions?: readonly ErrorAction[]
  /** Copy details is offered unless this is false. */
  readonly copy?: boolean
  /** `alert` (the default) for a failure the person just met; `status` for one shown again later. */
  readonly role?: 'alert' | 'status'
  readonly className?: string
  /** Main's clipboard API by default: the page never touches the clipboard itself. */
  readonly writeClipboard?: Clipboard
  /** Under the actions, in line with the sentence: what an action of the document's own did ("GRANT statement copied."). */
  readonly children?: ReactNode
}

const mainClipboard: Clipboard = text => typeof window !== 'undefined' && window.varia ? window.varia.writeClipboardText(text) : Promise.resolve({ ok: false })

/** An error where it happened: a glyph, the sentence, what to do, and Copy details with the code for a report. */
export default function InlineError({ actions = [], copy = true, role = 'alert', className, writeClipboard = mainClipboard, note, children, ...report }: Props) {
  // Which details the last copy took, so an error that replaces this one offers its own copy again.
  const [copied, setCopied] = useState<CopyRecord>()
  const text = errorDetailsText(report)
  const copyDetails = () => { void copyText(writeClipboard, text).then(setCopied) }
  return <div className={className ? `inline-error ${className}` : 'inline-error'}>
    <Icon name="error" />
    <div className="inline-error-body">
      {/* Only the sentence is the live region: the copy outcome below is a status of its own, announced once. */}
      <p className="inline-error-message" role={role}>{report.message}{note && <span className="inline-error-note">{note}</span>}</p>
      {(actions.length > 0 || copy) && <div className="inline-error-actions">
        {actions.map(action => <button key={action.label} type="button" ref={action.buttonRef} onClick={action.run}>{action.label}</button>)}
        {copy && <button type="button" onClick={copyDetails}>Copy details</button>}
        <span className="inline-error-status" role="status">{copyStatus(copied, text)}</span>
      </div>}
      {children}
    </div>
  </div>
}
