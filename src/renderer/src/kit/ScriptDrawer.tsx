import { useMemo, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { scriptDestinations, scriptDestinationSpecs, type ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { frameLimits, scriptLinesLabel, scriptPreview, scriptPreviewNote, scriptSizeKey } from './document-frame'
import type { IconId } from '../../../shared/icons'
import Icon from '../Icon'
import type { ErrorReport } from './format'
import InlineError from './InlineError'
import Skeleton from './Skeleton'

/**
 * What the drawer shows: a line saying why there is no script yet ("No changes to script."), a placeholder while the
 * document asks for one, the script, or why it could not be made.
 */
export type ScriptContent =
  | { readonly state: 'idle'; readonly message: string }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly text: string }
  | { readonly state: 'failed'; readonly error: ErrorReport }

/** The drawer's ways out, the destinations Script As and the object dialogs' Script button deliver to, worded and drawn as the catalogue says. */
export const scriptDrawerActions: readonly { readonly destination: ScriptDestination; readonly label: string; readonly icon: IconId }[] =
  scriptDestinations.map(destination => ({ destination, label: scriptDestinationSpecs[destination].drawerTitle, icon: scriptDestinationSpecs[destination].icon }))

const dragEnds = ['pointerup', 'pointercancel', 'lostpointercapture'] as const

export interface ScriptDrawerProps {
  /** The document's id, for the drawer's element ids. */
  readonly id: string
  readonly open: boolean
  /** The open drawer's share of the document's height. */
  readonly size: number
  readonly content: ScriptContent
  readonly onToggle: () => void
  readonly onResize: (size: number) => void
  /** Delivers the whole script (never the cut preview) through `deliverScript`. */
  readonly onDeliver: (destination: ScriptDestination) => void
  /** The outcome of the last delivery ("Script copied to the clipboard."). */
  readonly notice?: string
}

/**
 * A live, read-only preview of what the document would run, docked under it (U1 D2): its bar stays when it is closed,
 * so the script is one click or key away, and it never runs anything. Long scripts show their first lines.
 */
export default function ScriptDrawer({ id, open, size, content, onToggle, onResize, onDeliver, notice }: ScriptDrawerProps) {
  const text = content.state === 'ready' ? content.text : ''
  const preview = useMemo(() => scriptPreview(text), [text])
  const ready = content.state === 'ready' && preview.lines > 0
  const note = ready ? scriptPreviewNote(preview) : undefined
  const bodyId = `${id}-script`, headId = `${id}-script-head`
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const frame = event.currentTarget.closest('.document-frame')?.getBoundingClientRect()
    if (!frame || frame.height <= 0) return
    // No text selection starts under the drag; the stylesheet's touch-action keeps a touch drag from becoming a pan.
    event.preventDefault()
    const target = event.currentTarget, pointer = event.pointerId
    target.setPointerCapture(pointer)
    const move = (moved: PointerEvent) => { if (moved.pointerId === pointer) onResize((frame.bottom - moved.clientY) / frame.height) }
    // A cancelled touch or pen drag ends with pointercancel and no pointerup; either way the drag's listeners go.
    const end = (ended: PointerEvent) => {
      if (ended.pointerId !== pointer) return
      target.removeEventListener('pointermove', move)
      for (const type of dragEnds) target.removeEventListener(type, end)
    }
    target.addEventListener('pointermove', move)
    for (const type of dragEnds) target.addEventListener(type, end)
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = scriptSizeKey(size, event.key)
    if (next === undefined) return
    event.preventDefault()
    onResize(next)
  }
  return <section className="document-script" aria-labelledby={headId} data-open={open ? '' : undefined} style={open ? { flexBasis: `${size * 100}%` } : undefined}>
    {open && <div className="document-script-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize Script" tabIndex={0}
      aria-valuenow={Math.round(size * 100)} aria-valuemin={Math.round(frameLimits.scriptMinimum * 100)} aria-valuemax={Math.round(frameLimits.scriptMaximum * 100)} onPointerDown={drag} onKeyDown={key} />}
    <div className="document-script-head">
      <button type="button" id={headId} className="document-script-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />Script
      </button>
      {ready && <span className="document-script-lines">{scriptLinesLabel(preview)}</span>}
      <span className="document-script-notice" role="status">{notice}</span>
      <div className="document-script-actions" role="group" aria-label="Script">
        {scriptDrawerActions.map(action => <button key={action.destination} type="button" className="icon-button" aria-label={action.label} title={action.label} disabled={!ready}
          data-destination={action.destination} onClick={() => onDeliver(action.destination)}><Icon name={action.icon} /></button>)}
      </div>
    </div>
    {open && <div className="document-script-body" id={bodyId}>
      {content.state === 'idle' && <p className="document-script-empty">{content.message}</p>}
      {content.state === 'loading' && <Skeleton rows={4} label="Scripting" />}
      {/* A preview that fails while someone edits says so where it is, without interrupting them. */}
      {content.state === 'failed' && <InlineError {...content.error} role="status" />}
      {content.state === 'ready' && (preview.lines > 0
        // A read-only text box: the caret, Shift+arrows, Ctrl+A and Ctrl+C work inside it, and the keys treat it as text.
        ? <textarea className="document-script-text" readOnly aria-label="Script text" spellCheck={false} wrap="off" value={preview.text} />
        : <p className="document-script-empty">The script is empty.</p>)}
      {note && <p className="document-script-note">{note}</p>}
    </div>}
  </section>
}
