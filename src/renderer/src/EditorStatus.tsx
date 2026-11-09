import { documentEncodingLabel, lineEndingLabel } from '../../shared/files/encoding'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import Icon from './Icon'
import { isQueryDocument } from './documents'
import { useCommandEnabled, useKeybindingLabel } from './core/useCommand'
import { withKey } from './query-context'

/**
 * The IDE status bar's editor segments, as Visual Studio shows them: Ln, Col and Ch of the caret, INS or OVR, the line
 * ending, the file's encoding (what a new query will be saved in), and Read-only. Shown while a document is open.
 */
export default function EditorStatus() {
  const { editorStatus, inputMode, documents, settings, commands, sqlLanguage } = useWorkbench()
  useServiceSnapshot(sqlLanguage)
  const canGoToLine = useCommandEnabled('edit.goToLine'), canToggleMode = useCommandEnabled('editor.toggleOvertype')
  const goToLineKey = useKeybindingLabel('edit.goToLine')
  const caret = useServiceSnapshot(editorStatus)
  const { mode } = useServiceSnapshot(inputMode)
  const { documents: list, activeId } = useServiceSnapshot(documents)
  const values = useServiceSnapshot(settings).values
  const active = list.find(document => document.id === activeId)
  if (!active || !caret) return <span className="editor-status" />
  const file = active.file
  const encoding = documentEncodingLabel(file, values['environment.documents.saveWithSpecificEncoding'] ? values['environment.documents.saveEncoding'] : undefined)
  const language = isQueryDocument(active) ? sqlLanguage.availability(active.id) : undefined
  return <span className="editor-status">
    <button type="button" className="editor-status-position editor-status-action" disabled={!canGoToLine} title={withKey('Go to line', goToLineKey)} aria-label={`Line ${caret.line}, column ${caret.column}, character ${caret.character}`}
      onClick={() => void commands.execute('edit.goToLine', undefined, 'toolbar')}><span>Ln {caret.line}</span><span>Col {caret.column}</span><span>Ch {caret.character}</span></button>
    <button type="button" className="editor-status-mode editor-status-action" disabled={!canToggleMode} aria-pressed={mode === 'overtype'} aria-label={mode === 'insert' ? 'Switch to overtype mode' : 'Switch to insert mode'} title={mode === 'insert' ? 'Insert mode (Insert switches to overtype). Click to switch to overtype.' : 'Overtype mode (Insert switches to insert). Click to switch to insert.'}
      onClick={() => { void commands.execute('editor.toggleOvertype', undefined, 'toolbar'); documents.focusActive() }}>{mode === 'insert' ? 'INS' : 'OVR'}</button>
    <span className="editor-status-eol" title="Line endings">{lineEndingLabel(caret.eol)}</span>
    <span className="editor-status-encoding" title="Encoding">{encoding}</span>
    {language && <span role="status" aria-live="polite" aria-label="SQL IntelliSense" title={language.detail}>{language.label}</span>}
    {file?.readOnly && <span className="editor-status-readonly" title="The file is read-only: Save asks before overwriting it."><Icon name="lock" />Read-only</span>}
  </span>
}
