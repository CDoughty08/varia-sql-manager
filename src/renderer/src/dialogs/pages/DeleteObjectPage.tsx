import { useState } from 'react'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../../core/WorkbenchContext'
import type { DeleteTarget } from '../../../../shared/actions/schema.ts'
import { queryWindowsOn } from '../database-gone'
import { canCloseConnections, closeDescription, rollbackNote, type DeleteDraft } from '../definitions'
import type { PageProps } from '../ObjectDialog'
import Icon from '../../Icon'

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`

/**
 * Delete Object's General page, as SSMS lays it out: the "Object to be deleted" grid (Object Name, Object Type, Owner,
 * Status, Message), what blocks the DROP, and for a database the sessions using it (a disclosure whose grid scrolls within
 * its own height, so the options below stay in view), its two options and the query windows that use it. Close existing
 * connections is described by its reason when greyed and by what it rolls back (A7).
 */
export default function DeleteObjectPage({ open, editable }: PageProps) {
  const { dialogs, documents } = useWorkbench()
  const { documents: tabs } = useServiceSnapshot(documents)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const model = open.model as DeleteTarget | undefined, draft = open.draft as DeleteDraft | undefined
  const database = open.target.kind === 'database'
  const windows = database && open.target.name !== undefined ? queryWindowsOn(tabs, open.connectionId, open.target.name) : 0
  const failed = open.steps?.find(step => step.status === 'failed')
  const status = open.phase === 'executing' ? 'In progress' : open.phase === 'failed' ? 'Error' : open.phase === 'stopped' ? 'Stopped' : ''
  const message = open.phase === 'failed' ? failed?.message ?? open.error?.message ?? '' : ''
  const closable = !!model && canCloseConnections(model)
  const blockers = database ? model?.blockers ?? [] : []
  const listed = model?.blockersTruncated && (model.sessions ?? 0) > blockers.length ? model.sessions! : blockers.length
  const rollback = database && model ? rollbackNote(model, open) : ''
  const usage = database && model ? [
    windows > 0 ? `${count(windows, 'query window uses', 'query windows use')} this database.` : '',
    model.sessions ? `${count(model.sessions, 'session is', 'sessions are')} connected to it.` : ''
  ].filter(Boolean).join(' ') : ''
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
    {model && blockers.length > 0 && <section className="object-dialog-sessions" aria-labelledby="delete-object-sessions-toggle">
      <button type="button" id="delete-object-sessions-toggle" className="object-dialog-disclosure" aria-expanded={sessionsOpen} aria-controls="delete-object-sessions"
        onClick={() => setSessionsOpen(!sessionsOpen)}><Icon name={sessionsOpen ? 'chevron-down' : 'chevron-right'} /><span>Sessions using <bdi>{displayText(model.name)}</bdi> ({listed.toLocaleString('en-US')})</span></button>
      {sessionsOpen && <div className="object-dialog-sessions-body" id="delete-object-sessions">
        <table className="object-dialog-grid" aria-label="Sessions using the database">
          <thead><tr><th scope="col">Session</th><th scope="col">Program</th><th scope="col">Host</th><th scope="col">Open transaction</th></tr></thead>
          <tbody>{blockers.map(blocker => {
            const program = blocker.program ? displayText(blocker.program) : '', host = blocker.host ? displayText(blocker.host) : ''
            return <tr key={blocker.sessionId}><td>{blocker.sessionId}</td><td title={program}><bdi>{program}</bdi></td><td title={host}><bdi>{host}</bdi></td><td>{blocker.openTransaction ? 'Yes' : ''}</td></tr>
          })}</tbody>
        </table>
        {model.blockersTruncated && <p className="field-note">More sessions are connected than are listed.</p>}
      </div>}
    </section>}
    {database && model && draft && <fieldset className="object-dialog-options" disabled={!editable}>
      <label className="checkbox-label"><input type="checkbox" checked={draft.deleteHistory && !model.isSnapshot} disabled={!!model.isSnapshot}
        onChange={event => dialogs.updateDraft({ deleteHistory: event.target.checked })} />Delete backup and restore history information for databases</label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.closeConnections && closable} disabled={!closable} aria-describedby={closeDescription(model, rollback)}
        onChange={event => dialogs.updateDraft({ closeConnections: event.target.checked })} />Close existing connections</label>
      {model.closeConnectionsNote && <p className="field-note" id="delete-object-close-note">{model.closeConnectionsNote}</p>}
      {rollback && <p className="field-note" id="delete-object-rollback-note">{rollback}</p>}
    </fieldset>}
    {usage && <p className="field-note">{usage}</p>}
  </div>
}
