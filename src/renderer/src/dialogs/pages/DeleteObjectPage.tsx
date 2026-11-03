import { useState } from 'react'
import { loginDeleteText, mappedUserKept } from '../../../../shared/actions/logins.ts'
import { loginConnectionsText } from '../../../../shared/actions/prompts.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../../core/WorkbenchContext'
import type { ActionWarning, DeleteTarget } from '../../../../shared/actions/schema.ts'
import { queryWindowsOn } from '../database-gone'
import { canCloseConnections, canDropMappedUsers, closeDescription, dropMappedUsersNote, loginDeleteRefusal, rollbackNote, type DeleteDraft } from '../definitions'
import type { PageProps } from '../ObjectDialog'
import Icon from '../../Icon'

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`

/**
 * Delete Object's General page, as SSMS lays it out: the "Object to be deleted" grid (Object Name, Object Type, Owner,
 * Status, Message), what blocks the DROP, and for a database the sessions using it (a disclosure whose grid scrolls within
 * its own height, so the options below stay in view), its two options and the query windows that use it. Close existing
 * connections is described by its reason when greyed and by what it rolls back (A7). For a login (D4c): why OK is greyed, what
 * blocks the DROP, Varia's other connections that sign in as it, the database users mapped to it, SSMS's note that a Delete
 * leaves them orphaned, and the option to delete them too.
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
  const login = open.target.kind === 'login'
  // The rules' refusal leads (OK is greyed for it), then the backend's warnings, then Varia's own connections, whose pools' sessions
  // fail the DROP until they disconnect (D4-3).
  const refusal = login && model ? loginDeleteRefusal(model) : undefined
  const connections = login ? open.loginConnections ?? [] : []
  const warnings: readonly ActionWarning[] = model ? [
    ...model.warnings, ...connections.length ? [{ text: loginConnectionsText(connections, loginDeleteText.connections(connections.length)), blocking: true }] : []
  ] : []
  return <div className="object-dialog-delete">
    <div className="object-dialog-caption" id="delete-object-grid">Object to be deleted</div>
    <table className="object-dialog-grid" role="grid" aria-labelledby="delete-object-grid">
      <thead><tr><th scope="col">Object Name</th><th scope="col">Object Type</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Message</th></tr></thead>
      <tbody>{model
        ? <tr><td><bdi>{displayText(model.name)}</bdi></td><td>{model.type}</td><td><bdi>{model.owner ? displayText(model.owner) : ''}</bdi></td><td>{status}</td><td className="object-dialog-cell-message">{message}</td></tr>
        : <tr><td><bdi>{open.label}</bdi></td><td /><td /><td>{open.phase === 'loading' ? 'Loading…' : status}</td><td /></tr>}</tbody>
    </table>
    {model && (refusal || warnings.length > 0) && <ul className="object-dialog-warnings" aria-label="Warnings">
      {refusal && <li className="is-refusal"><Icon name="error" label="Error" /><span>{refusal}</span></li>}
      {/* Only what fails the DROP carries the warning icon and fill (D4 §5.4); the rest (a service that runs as the login) is a note. */}
      {warnings.map((warning, index) => <li key={index} className={warning.blocking ? undefined : 'is-note'}><Icon name={warning.blocking ? 'warning' : 'info'} label={warning.blocking ? 'Warning' : 'Note'} /><span>{warning.text}</span></li>)}
      {model.dependentsTruncated && <li><Icon name="warning" label="Warning" /><span>More objects depend on it than are listed.</span></li>}
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
    {login && model && draft && <LoginMappings model={model} draft={draft} editable={editable} />}
  </div>
}

/** A login's mapped users (its database: its user, and why one is kept), SSMS's orphan note, and the option to delete them too,
 *  described by why it is greyed when it is (dropMappedUsersNote), as Close existing connections is (A7). */
function LoginMappings({ model, draft, editable }: { readonly model: DeleteTarget; readonly draft: DeleteDraft; readonly editable: boolean }) {
  const { dialogs } = useWorkbench()
  const mappings = model.mappings, users = mappings?.users ?? []
  const more = Math.max(0, (mappings?.mapped ?? 0) - users.length), notChecked = mappings?.notChecked ?? 0
  const droppable = canDropMappedUsers(model), note = dropMappedUsersNote(model)
  return <>
    <section className="object-dialog-mapped" aria-labelledby="delete-object-mapped">
      <div className="object-dialog-caption" id="delete-object-mapped">{loginDeleteText.mappedHeading}</div>
      {users.length > 0
        ? <ul className="object-dialog-mapped-list" aria-labelledby="delete-object-mapped">
          {users.map((user, index) => <li key={index}><bdi>{displayText(user.database)}</bdi>: <bdi>{displayText(user.user)}</bdi>
            {mappedUserKept(user) && <span className="object-dialog-kept"> ({loginDeleteText.kept(user)})</span>}</li>)}
          {more > 0 && <li>{loginDeleteText.more(more)}</li>}
        </ul>
        : <p className="field-note">{notChecked > 0 ? loginDeleteText.noneMappedChecked : loginDeleteText.noneMapped}</p>}
      {notChecked > 0 && <p className="field-note">{loginDeleteText.notChecked(notChecked)}</p>}
    </section>
    {/* SSMS's note matters only where a user may be left orphaned: one is listed, or a database went unread. */}
    {(users.length > 0 || notChecked > 0) && <p className="field-note">{loginDeleteText.orphanNote}</p>}
    <fieldset className="object-dialog-options" disabled={!editable}>
      <label className="checkbox-label"><input type="checkbox" checked={draft.dropMappedUsers && droppable} disabled={!droppable} aria-describedby="delete-object-drop-note"
        onChange={event => dialogs.updateDraft({ dropMappedUsers: event.target.checked })} />{loginDeleteText.dropOption}</label>
      <p className="field-note" id="delete-object-drop-note">{note ?? loginDeleteText.dropHint}</p>
    </fieldset>
  </>
}
