import { displayText } from '../../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../../core/WorkbenchContext'
import type { DatabaseBlocker, DeleteTarget } from '../../../../shared/actions/schema.ts'
import { queryWindowsOn } from '../database-gone'
import { canCloseConnections, type DeleteDraft } from '../definitions'
import type { PageProps } from '../ObjectDialog'
import Icon from '../../Icon'

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
const list = (names: readonly string[], more = 0) => names.map(name => displayText(name)).join(', ') + (more > 0 ? ` and ${more.toLocaleString('en-US')} more` : '')
/** One session in the list: "Session 53: SQLCMD on HOST, open transaction". */
const blockerText = (blocker: DatabaseBlocker) => {
  const program = blocker.program ? displayText(blocker.program) : 'Unknown program', host = blocker.host ? ` on ${displayText(blocker.host)}` : ''
  return `Session ${blocker.sessionId}: ${program}${host}${blocker.openTransaction ? ', open transaction' : ''}`
}

/**
 * Delete Object's General page, as SSMS lays it out: the "Object to be deleted" grid (Object Name, Object Type, Owner,
 * Status, Message), what blocks the DROP, and for a database the sessions using it, its two options and the query windows
 * that use it. Close existing connections says how many sessions it rolls back a transaction in, and names Varia's own query
 * tabs with one (A7); Managed Instance greys it with SQL Server's reason.
 */
export default function DeleteObjectPage({ open, editable }: PageProps) {
  const { dialogs, documents } = useWorkbench()
  const { documents: tabs } = useServiceSnapshot(documents)
  const model = open.model as DeleteTarget | undefined, draft = open.draft as DeleteDraft | undefined
  const database = open.target.kind === 'database'
  const windows = database && open.target.name !== undefined ? queryWindowsOn(tabs, open.connectionId, open.target.name) : 0
  const failed = open.steps?.find(step => step.status === 'failed')
  const status = open.phase === 'executing' ? 'In progress' : open.phase === 'failed' ? 'Error' : open.phase === 'stopped' ? 'Stopped' : ''
  const message = open.phase === 'failed' ? failed?.message ?? open.error?.message ?? '' : ''
  const closable = !!model && canCloseConnections(model)
  const blockers = database ? model?.blockers ?? [] : []
  const sessionNotes = database && model ? [
    windows > 0 ? `${count(windows, 'query window uses', 'query windows use')} this database.` : '',
    model.sessions ? `${count(model.sessions, 'session is', 'sessions are')} connected to it.` : '',
    model.withTransaction ? `${count(model.withTransaction, 'session has an open transaction', 'sessions have open transactions')}, which Close existing connections rolls back.` : '',
    open.tabsWithTransactions?.length ? `Varia's query windows with an open transaction: ${list(open.tabsWithTransactions, open.moreTabsWithTransactions)}.` : ''
  ].filter(Boolean) : []
  return <div className="object-dialog-delete">
    <div className="object-dialog-caption" id="delete-object-grid">Object to be deleted</div>
    <table className="object-dialog-grid" role="grid" aria-labelledby="delete-object-grid">
      <thead><tr><th scope="col">Object Name</th><th scope="col">Object Type</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Message</th></tr></thead>
      <tbody>{model
        ? <tr><td><bdi>{displayText(model.name)}</bdi></td><td>{model.type}</td><td><bdi>{model.owner ? displayText(model.owner) : ''}</bdi></td><td>{status}</td><td className="object-dialog-cell-message">{message}</td></tr>
        : <tr><td><bdi>{open.label}</bdi></td><td /><td /><td>{open.phase === 'loading' ? 'Loading…' : status}</td><td /></tr>}</tbody>
    </table>
    {model && model.warnings.length > 0 && <ul className="object-dialog-warnings" aria-label="Warnings">
      {model.warnings.map((warning, index) => <li key={index}><Icon name="warning" /><span>{warning.text}</span></li>)}
      {model.dependentsTruncated && <li><Icon name="warning" /><span>More objects depend on it than are listed.</span></li>}
    </ul>}
    {blockers.length > 0 && <ul className="object-dialog-sessions" aria-label="Sessions using the database">
      {blockers.map(blocker => <li key={blocker.sessionId}><bdi>{blockerText(blocker)}</bdi></li>)}
      {model?.blockersTruncated && <li>More sessions are connected than are listed.</li>}
    </ul>}
    {database && model && draft && <fieldset className="object-dialog-options" disabled={!editable}>
      <label className="checkbox-label"><input type="checkbox" checked={draft.deleteHistory && !model.isSnapshot} disabled={!!model.isSnapshot}
        onChange={event => dialogs.updateDraft({ deleteHistory: event.target.checked })} />Delete backup and restore history information for databases</label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.closeConnections && closable} disabled={!closable}
        aria-describedby={model.closeConnectionsNote ? 'delete-object-close-note' : undefined}
        onChange={event => dialogs.updateDraft({ closeConnections: event.target.checked })} />Close existing connections</label>
      {model.closeConnectionsNote && <p className="field-note" id="delete-object-close-note">{model.closeConnectionsNote}</p>}
    </fieldset>}
    {sessionNotes.length > 0 && <p className="field-note">{sessionNotes.join(' ')}</p>}
  </div>
}
