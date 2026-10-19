import { useState, type KeyboardEvent } from 'react'
import { useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import { maxLineDigits, parseLineNumber, type GoToLineRequest } from './go-to-line'

/**
 * SSMS's Go To Line (Ctrl+G): a line number from 1 to the query's line count, starting at the caret's line. OK moves the
 * caret to the start of that line in the query it was opened for, if that query is still the active one; Cancel and
 * Escape leave it. Focus returns to the editor either way.
 */
export default function GoToLineDialog({ request }: { readonly request: GoToLineRequest }) {
  const { documents, editorDialogs } = useWorkbench()
  const [text, setText] = useState(String(request.line))
  // Read while rendering, before the field takes focus: the editor's text area.
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const line = parseLineNumber(text, request.lineCount)
  const close = () => {
    editorDialogs.closeGoToLine()
    if (returnFocus?.isConnected) returnFocus.focus()
    else documents.boundEditor?.focus()
  }
  const ok = () => {
    if (line === undefined) return
    editorDialogs.closeGoToLine()
    const editor = documents.boundEditor, model = editor?.getModel()
    if (!editor || !model || documents.getSnapshot().activeId !== request.tabId || documents.getModel(request.tabId) !== model) { close(); return }
    // The query may have lost lines while the dialog was open.
    const lineNumber = Math.min(line, model.getLineCount())
    editor.setPosition({ lineNumber, column: 1 })
    editor.revealLineInCenterIfOutsideViewport(lineNumber)
    editor.focus()
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }
  return <div className="modal-backdrop"><form className="connection-modal go-to-line-dialog" role="dialog" aria-modal="true" aria-labelledby="go-to-line-title" noValidate
    onSubmit={event => { event.preventDefault(); ok() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="go-to-line-title">Go To Line</h2><button type="button" className="icon-button" aria-label="Close Go To Line" onClick={close}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <label htmlFor="go-to-line-input">{`Line number (1 - ${request.lineCount}):`}</label>
      <input id="go-to-line-input" type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={maxLineDigits} value={text} autoFocus
        onFocus={event => event.currentTarget.select()} aria-invalid={line === undefined || undefined} aria-describedby={line === undefined ? 'go-to-line-hint' : undefined}
        onChange={event => setText(event.target.value)} />
      {line === undefined && <p className="field-note" id="go-to-line-hint">{`Enter a number from 1 to ${request.lineCount}.`}</p>}
    </div>
    <div className="connection-footer">
      <span />
      <button className="primary" type="submit" disabled={line === undefined}>OK</button><button type="button" onClick={close}>Cancel</button>
    </div>
  </form></div>
}
