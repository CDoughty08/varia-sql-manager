import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { documentEncodingLabel, lineEndingLabel } from '../../shared/files/encoding'
import type { IconId } from '../../shared/icons'
import { modalOpen } from './core/modal'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import Icon from './Icon'
import { isQueryDocument } from './documents'
import { useCommandEnabled, useKeybindingLabel } from './core/useCommand'
import IntelliSensePopover from './languages/IntelliSensePopover'
import { withKey } from './query-context'

export interface SqlStatusItem { readonly label: string; readonly detail: string }
export interface SqlStatusChip {
  readonly label: string
  readonly icon: IconId
  readonly tone: 'normal' | 'muted' | 'warning' | 'error'
  readonly detail: string
  readonly ariaLabel: string
}

/**
 * Condenses the SQL IntelliSense availability and query-analysis status into one calm status-bar chip while keeping
 * full detail in its tooltip.
 */
export function sqlStatusChip(language: SqlStatusItem | undefined, issues: SqlStatusItem | undefined): SqlStatusChip | undefined {
  if (!language && !issues) return undefined
  const detailParts: string[] = []
  if (language) detailParts.push(language.detail ? `${language.label}: ${language.detail}` : language.label)
  if (issues) detailParts.push(issues.detail ? `${issues.label}: ${issues.detail}` : issues.label)
  detailParts.push('Click to inspect IntelliSense status and actions.')
  const detail = detailParts.join('\n')

  let label: string, icon: IconId, tone: SqlStatusChip['tone']
  if (issues && /\berrors?\b/i.test(issues.label)) { label = issues.label; icon = 'error'; tone = 'error' }
  else if (issues && /\bwarnings?\b/i.test(issues.label)) { label = issues.label; icon = 'warning'; tone = 'warning' }
  else if (issues && (issues.label === 'Checking SQL' || issues.label === 'Checking with BigQuery')) { label = issues.label; icon = 'sync'; tone = 'normal' }
  else if (issues?.label === 'SQL analysis incomplete') { label = 'SQL: Incomplete'; icon = 'warning'; tone = 'warning' }
  else if (language?.label === 'IntelliSense refreshing') { label = 'SQL: Refreshing'; icon = 'sync'; tone = 'normal' }
  else if (language?.label === 'IntelliSense loading') { label = 'SQL: Loading'; icon = 'sync'; tone = 'normal' }
  else if (language?.label === 'IntelliSense indexing') { label = 'SQL: Indexing'; icon = 'sync'; tone = 'normal' }
  else if (language?.label === 'IntelliSense starting') { label = 'SQL: Starting'; icon = 'sync'; tone = 'normal' }
  else if (language?.label === 'IntelliSense unavailable' || issues?.label === 'SQL analysis unavailable' || issues?.label === 'Dry run unavailable') {
    label = 'SQL: Unavailable'; icon = 'warning'; tone = 'warning'
  } else if (issues?.label === 'SQL analysis paused' || language?.label === 'IntelliSense paused' || language?.label === 'IntelliSense disconnected') {
    label = 'SQL: Paused'; icon = 'code'; tone = 'muted'
  } else if (language?.label === 'IntelliSense off') {
    label = 'SQL: Off'; icon = 'code'; tone = 'muted'
  } else if (issues) {
    label = issues.label; icon = 'pass'; tone = 'normal'
  } else {
    label = language!.label; icon = 'code'; tone = 'normal'
  }
  return { label, icon, tone, detail, ariaLabel: `SQL status: ${label}. Open IntelliSense status popover.` }
}

/**
 * The IDE status bar's editor segments, as Visual Studio shows them: Ln, Col and Ch of the caret, INS or OVR, the line
 * ending, the file's encoding (what a new query will be saved in), the condensed SQL language/analysis status chip
 * (which opens the unified IntelliSense status popover), and Read-only. Shown while a document is open.
 */
export default function EditorStatus() {
  const { editorStatus, inputMode, documents, settings, commands, sqlLanguage, sqlDiagnostics, bigQueryCost, indexCompletion, menus } = useWorkbench()
  useServiceSnapshot(sqlLanguage)
  useServiceSnapshot(sqlDiagnostics)
  useServiceSnapshot(bigQueryCost)
  useServiceSnapshot(indexCompletion)
  const canGoToLine = useCommandEnabled('edit.goToLine'), canToggleMode = useCommandEnabled('editor.toggleOvertype')
  const goToLineKey = useKeybindingLabel('edit.goToLine')
  const caret = useServiceSnapshot(editorStatus)
  const { mode } = useServiceSnapshot(inputMode)
  const { documents: list, activeId } = useServiceSnapshot(documents)
  const values = useServiceSnapshot(settings).values
  const [popoverOpen, setPopoverOpen] = useState(false)
  const sqlTriggerRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  const active = list.find(document => document.id === activeId)

  const closePopover = useCallback((restoreFocus = false) => {
    setPopoverOpen(false)
    if (restoreFocus) sqlTriggerRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!active || !isQueryDocument(active)) setPopoverOpen(false)
  }, [active])

  if (!active || !caret) return <span className="editor-status" />
  const file = active.file
  const encoding = documentEncodingLabel(file, values['environment.documents.saveWithSpecificEncoding'] ? values['environment.documents.saveEncoding'] : undefined)
  // A BigQuery tab's IntelliSense is Varia's own, from the index; SQL Server's is SQL Tools Service's.
  const bigQueryLanguage = isQueryDocument(active) ? indexCompletion.availability(active.id) : undefined
  const language = isQueryDocument(active) ? bigQueryLanguage ?? sqlLanguage.availability(active.id) : undefined
  // A BigQuery tab's issues come from its dry runs; SQL Server's from SQL analysis.
  const bigQueryIssues = isQueryDocument(active) ? bigQueryCost.status(active.id) : undefined
  const issues = isQueryDocument(active) ? bigQueryIssues ?? sqlDiagnostics.status(active.id) : undefined
  const sqlChip = sqlStatusChip(language, issues)
  const isBigQuery = !!(bigQueryLanguage || bigQueryIssues)
  const sqlSetting = isBigQuery ? 'textEditor.googleSql.dryRunDiagnostics' : 'textEditor.sql.errorChecking'
  return <span className="editor-status">
    <span className="editor-status-group editor-status-caret">
      <button type="button" className="editor-status-position editor-status-action" disabled={!canGoToLine} title={withKey('Go to line', goToLineKey)} aria-label={`Line ${caret.line}, column ${caret.column}, character ${caret.character}`}
        onClick={() => void commands.execute('edit.goToLine', undefined, 'toolbar')}><span>Ln {caret.line}</span><span>Col {caret.column}</span><span>Ch {caret.character}</span></button>
      <button type="button" className="editor-status-mode editor-status-action" disabled={!canToggleMode} aria-pressed={mode === 'overtype'} aria-label={mode === 'insert' ? 'Switch to overtype mode' : 'Switch to insert mode'} title={mode === 'insert' ? 'Insert mode (Insert switches to overtype). Click to switch to overtype.' : 'Overtype mode (Insert switches to insert). Click to switch to insert.'}
        onClick={() => { void commands.execute('editor.toggleOvertype', undefined, 'toolbar'); documents.focusActive() }}>{mode === 'insert' ? 'INS' : 'OVR'}</button>
    </span>
    <span className="editor-status-group editor-status-file">
      <span className="editor-status-eol" title="Line endings">{lineEndingLabel(caret.eol)}</span>
      <span className="editor-status-encoding" title="Encoding">{encoding}</span>
      {file?.readOnly && <span className="editor-status-readonly" title="The file is read-only: Save asks before overwriting it."><Icon name="lock" />Read-only</span>}
    </span>
    {sqlChip && isQueryDocument(active) && <span className="editor-status-group editor-status-sql-group">
      <button ref={sqlTriggerRef} type="button" className="editor-status-sql editor-status-action" data-tone={sqlChip.tone}
        aria-label={sqlChip.ariaLabel} aria-expanded={popoverOpen} aria-haspopup="dialog" aria-controls={popoverId} title={sqlChip.detail}
        onClick={() => { if (!modalOpen() && !menus?.ownsKeyboard()) setPopoverOpen(current => !current) }}>
        <Icon name={sqlChip.icon} /><span>{sqlChip.label}</span>
      </button>
      {popoverOpen && <IntelliSensePopover open={popoverOpen} popoverId={popoverId} triggerRef={sqlTriggerRef} active={active} isBigQuery={isBigQuery}
        language={language} issues={issues} sqlSetting={sqlSetting} onClose={closePopover} />}
      {language && <span className="visually-hidden" role="status" aria-live="polite" aria-label="SQL IntelliSense" title={language.detail}>{language.label}</span>}
      {issues && <span className="visually-hidden" role="status" aria-live="polite" aria-label="SQL query issues" title={issues.detail}>{issues.label}</span>}
    </span>}
  </span>
}
