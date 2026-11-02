import { useEffect, useState } from 'react'
import { actionLimits } from '../../../../shared/actions/catalog.ts'
import { fileTypeLabel } from '../../../../shared/actions/database.ts'
import type { DatabaseStateModel } from '../../../../shared/actions/schema.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import StatusPill from '../../kit/StatusPill'
import { detachConfirmLabel, detachStateWords, detachStatisticsBlocked, type DetachDraft } from '../definitions'
import type { PageProps } from '../ObjectDialog'
import type { OpenObjectDialog } from '../ObjectDialogService'
import { databaseStateStatus, SessionsDisclosure, sessionsMessage, stoppedMessage, TransactionsNote, useOwnTransactions } from './DatabaseStatePage'

/** The row's Message: who is in the database before OK (SSMS counts active connections), then the run's progress and outcome. */
export function detachMessage(open: Pick<OpenObjectDialog, 'phase' | 'model' | 'draft' | 'steps' | 'error'>, waiting: boolean): string {
  const model = open.model as DatabaseStateModel | undefined, draft = open.draft as DetachDraft | undefined
  switch (open.phase) {
    case 'executing':
      return draft?.dropConnections ? 'Closing connections and detaching the database…' : waiting ? 'Detaching the database. Stop to give up.' : 'Detaching the database…'
    case 'succeeded': return 'The database was detached.'
    case 'failed': return open.steps?.find(step => step.status === 'failed' && !step.compensates)?.message ?? open.error?.message ?? ''
    case 'stopped': return stoppedMessage
    default: return model ? model.confirmOffline ? `The database is ${detachStateWords(model.state)}.` : sessionsMessage(model) : ''
  }
}

/**
 * Detach Database's General page (Learn's "Databases to detach" grid, recalled for SSMS 22): Database Name, Drop Connections,
 * Update Statistics, Status and Message; the sessions in the database (closed), what Drop Connections rolls back (A7), the box a
 * database that is not online asks for on Windows (A27), and the files that stay on the server, which Copy paths copies. Once it
 * succeeded, the database is gone: what the page said about its sessions goes, and the boxes no longer change anything.
 */
export default function DetachDatabasePage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  useServiceSnapshot(dialogs)
  const model = open.model as DatabaseStateModel | undefined, draft = open.draft as DetachDraft | undefined
  const ownTransactions = useOwnTransactions(open)
  const blocked = dialogs.blockedReason(open) !== undefined
  const status = databaseStateStatus(open, blocked)
  // sp_detach_db can wait for locks (Update Statistics reads every table); once it has run a moment, the row says Stop gives up.
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (open.phase !== 'executing') { setWaiting(false); return }
    const timer = setTimeout(() => setWaiting(true), actionLimits.statusDelayMs)
    return () => clearTimeout(timer)
  }, [open.phase])
  const name = model ? displayText(model.name) : open.label
  const sessions = model?.sessions ?? 0
  const files = model?.files ?? []
  const choose = (patch: Partial<DetachDraft>) => dialogs.updateDraft(patch)
  const before = open.phase === 'ready' || open.phase === 'loading' || open.phase === 'failed' || open.phase === 'stopped'
  const gone = open.phase === 'succeeded'
  const statisticsBlocked = model ? detachStatisticsBlocked(model) : undefined
  return <div className="object-dialog-state object-dialog-detach">
    <div className="object-dialog-caption" id="detach-database-grid">Databases to detach</div>
    <table className="object-dialog-grid" role="grid" aria-labelledby="detach-database-grid">
      <thead><tr>
        <th scope="col" className="object-dialog-col-name">Database Name</th>
        <th scope="col" className="object-dialog-col-check">Drop Connections</th>
        <th scope="col" className="object-dialog-col-check">Update Statistics</th>
        <th scope="col" className="object-dialog-col-status">Status</th><th scope="col">Message</th>
      </tr></thead>
      <tbody><tr>
        <td><bdi>{name}</bdi></td>
        <td className="object-dialog-cell-check">{draft && <input type="checkbox" aria-label="Drop Connections" checked={draft.dropConnections}
          disabled={!editable || !model || gone || model.sessions === 0} onChange={event => choose({ dropConnections: event.target.checked })} />}</td>
        <td className="object-dialog-cell-check">{draft && <input type="checkbox" aria-label="Update Statistics" checked={draft.updateStatistics && !statisticsBlocked}
          title={statisticsBlocked} disabled={!editable || !model || gone || !!statisticsBlocked} onChange={event => choose({ updateStatistics: event.target.checked })} />}</td>
        <td><StatusPill tone={status.tone} label={status.label} size="small" /></td>
        <td className="object-dialog-cell-message"><span aria-live="polite">{detachMessage(open, waiting)}</span></td>
      </tr></tbody>
    </table>
    {model && model.warnings.length > 0 && <ul className="object-dialog-warnings" aria-label="Warnings">
      {model.warnings.map((warning, index) => <li key={index}><Icon name="warning" /><span>{warning.text}</span></li>)}
    </ul>}
    {model && !gone && <SessionsDisclosure model={model} name={name} defaultOpen={false} />}
    {model && !gone && <TransactionsNote model={model} ownTransactions={ownTransactions} closer="Drop Connections" />}
    {model && sessions > 0 && draft && !draft.dropConnections && open.phase === 'ready' && <p className="object-dialog-note" role="note">
      <Icon name="info" /><span>OK stays disabled while sessions are connected: sp_detach_db refuses a database in use. Check Drop Connections to roll back their
        work and disconnect them (SINGLE_USER WITH ROLLBACK IMMEDIATE), or wait for them to leave and Check Again.</span>
    </p>}
    {model?.confirmOffline && draft && <div className="object-dialog-note warning" role="note">
      <Icon name="warning" /><div className="object-dialog-note-body">
        <span>This database is {detachStateWords(model.state)}. SQL Server may restrict access to the files of a database detached in this state, and attaching it
          again can then fail. Bring it online first if you will attach it again.</span>
        <label className="checkbox-label"><input type="checkbox" checked={draft.detachOffline} disabled={!editable || gone} onChange={event => choose({ detachOffline: event.target.checked })} />{detachConfirmLabel(model.state)}</label>
      </div>
    </div>}
    {model && files.length > 0 && <>
      <div className="object-dialog-caption object-dialog-files-caption" id="detach-database-files">Files that stay on the server</div>
      <table className="object-dialog-grid object-dialog-files" aria-labelledby="detach-database-files">
        <thead><tr><th scope="col" className="object-dialog-col-file">Logical Name</th><th scope="col" className="object-dialog-col-type">File Type</th><th scope="col">Path</th></tr></thead>
        <tbody>{files.map(file => <tr key={file.fileId}>
          <td title={displayText(file.name)}><bdi>{displayText(file.name)}</bdi></td><td>{fileTypeLabel[file.type]}</td>
          <td className="object-dialog-cell-path" title={displayText(file.path)}><bdi>{displayText(file.path)}</bdi></td>
        </tr>)}</tbody>
      </table>
      {model.filesTruncated && <p className="field-note">Only the first {files.length.toLocaleString('en-US')} files are listed.</p>}
    </>}
    {model && (before || files.length > 0) && <div className="object-dialog-actions">
      {before && <button type="button" disabled={open.phase === 'loading'} onClick={() => dialogs.reload()}>Check Again</button>}
      {files.length > 0 && <button type="button" onClick={() => void dialogs.copyPaths()}>Copy paths</button>}
    </div>}
  </div>
}
