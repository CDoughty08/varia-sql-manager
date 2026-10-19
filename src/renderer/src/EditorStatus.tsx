import { documentEncodingLabel, lineEndingLabel } from '../../shared/files/encoding'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'

/**
 * The IDE status bar's editor segments, as Visual Studio shows them: Ln, Col and Ch of the caret, INS or OVR, the line
 * ending, the file's encoding (what a new query will be saved in), and Read-only. Shown while a document is open.
 */
export default function EditorStatus() {
  const { editorStatus, inputMode, documents, settings } = useWorkbench()
  const caret = useServiceSnapshot(editorStatus)
  const { mode } = useServiceSnapshot(inputMode)
  const { documents: list, activeId } = useServiceSnapshot(documents)
  const values = useServiceSnapshot(settings).values
  const active = list.find(document => document.id === activeId)
  if (!active || !caret) return <span className="editor-status" />
  const file = active.file
  const encoding = documentEncodingLabel(file, values['environment.documents.saveWithSpecificEncoding'] ? values['environment.documents.saveEncoding'] : undefined)
  return <span className="editor-status">
    <span className="editor-status-position" aria-label={`Line ${caret.line}, column ${caret.column}, character ${caret.character}`}><span>Ln {caret.line}</span><span>Col {caret.column}</span><span>Ch {caret.character}</span></span>
    <span className="editor-status-mode" title={mode === 'insert' ? 'Insert mode (Insert switches to overtype)' : 'Overtype mode (Insert switches to insert)'}>{mode === 'insert' ? 'INS' : 'OVR'}</span>
    <span className="editor-status-eol" title="Line endings">{lineEndingLabel(caret.eol)}</span>
    <span className="editor-status-encoding" title="Encoding">{encoding}</span>
    {file?.readOnly && <span className="editor-status-readonly" title="The file is read-only: Save asks before overwriting it."><span className="codicon codicon-lock" aria-hidden="true" />Read-only</span>}
  </span>
}
