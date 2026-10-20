import { displayText } from '../../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../../core/WorkbenchContext'
import type { DeleteTarget } from '../../../../shared/actions/schema.ts'
import type { DeleteDraft } from '../definitions'
import type { PageProps } from '../ObjectDialog'

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`

/**
 * Delete Object's General page, as SSMS lays it out: the "Object to be deleted" grid (Object Name, Object Type, Owner,
 * Status, Message), what blocks the DROP, and for a database its two options and the query windows that use it.
 */
export default function DeleteObjectPage({ open, editable }: PageProps) {
  const { dialogs, documents } = useWorkbench()
  const { documents: tabs } = useServiceSnapshot(documents)
  const model = open.model as DeleteTarget | undefined, draft = open.draft as DeleteDraft | undefined
  const database = open.target.kind === 'database'
  const windows = database ? tabs.filter(tab => tab.connectionId === open.connectionId && tab.database === open.target.name).length : 0
  const failed = open.steps?.find(step => step.status === 'failed')
  const status = open.phase === 'executing' ? 'In progress' : open.phase === 'failed' ? 'Error' : open.phase === 'stopped' ? 'Stopped' : ''
  const message = open.phase === 'failed' ? failed?.message ?? open.error?.message ?? '' : ''
  return <div className="object-dialog-delete">
    <div className="object-dialog-caption" id="delete-object-grid">Object to be deleted</div>
    <table className="object-dialog-grid" role="grid" aria-labelledby="delete-object-grid">
      <thead><tr><th scope="col">Object Name</th><th scope="col">Object Type</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Message</th></tr></thead>
      <tbody>{model
        ? <tr><td><bdi>{displayText(model.name)}</bdi></td><td>{model.type}</td><td><bdi>{model.owner ? displayText(model.owner) : ''}</bdi></td><td>{status}</td><td className="object-dialog-cell-message">{message}</td></tr>
        : <tr><td><bdi>{open.label}</bdi></td><td /><td /><td>{open.phase === 'loading' ? 'Loading…' : status}</td><td /></tr>}</tbody>
    </table>
    {model && model.warnings.length > 0 && <ul className="object-dialog-warnings" aria-label="Warnings">
      {model.warnings.map((warning, index) => <li key={index}><span className="codicon codicon-warning" aria-hidden="true" /><span>{warning.text}</span></li>)}
      {model.dependentsTruncated && <li><span className="codicon codicon-warning" aria-hidden="true" /><span>More objects depend on it than are listed.</span></li>}
    </ul>}
    {database && model && draft && <fieldset className="object-dialog-options" disabled={!editable}>
      <label className="checkbox-label"><input type="checkbox" checked={draft.deleteHistory && !model.isSnapshot} disabled={!!model.isSnapshot}
        onChange={event => dialogs.updateDraft({ deleteHistory: event.target.checked })} />Delete backup and restore history information for databases</label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.closeConnections && !model.isSnapshot} disabled={!!model.isSnapshot}
        onChange={event => dialogs.updateDraft({ closeConnections: event.target.checked })} />Close existing connections</label>
    </fieldset>}
    {database && model && (windows > 0 || (model.sessions ?? 0) > 0) && <p className="field-note">
      {[windows > 0 ? `${count(windows, 'query window uses', 'query windows use')} this database.` : '',
        model.sessions ? `${count(model.sessions, 'session is', 'sessions are')} connected to it.` : ''].filter(Boolean).join(' ')}
    </p>}
  </div>
}
