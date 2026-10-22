import { useState } from 'react'
import { autogrowthText, fileTypeLabel, notApplicable } from '../../../../../shared/actions/database.ts'
import { displayText } from '../../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../../core/WorkbenchContext'
import { draftErrors, ownerState } from '../../database-properties'
import type { PageProps } from '../../ObjectDialog'
import SubDialog from '../../SubDialog'
import { databaseState, PageNote } from './shared'

/** "Select Database Owner": the server's logins in a list, as SSMS's browse button offers them (simplified). */
function SelectOwner({ logins, current, onOk, onCancel }: { logins: readonly string[]; current: string; onOk(login: string): void; onCancel(): void }) {
  const [chosen, setChosen] = useState(logins.includes(current) ? current : logins[0] ?? '')
  return <SubDialog title="Select Database Owner" okDisabled={!chosen} onOk={() => onOk(chosen)} onCancel={onCancel} initialFocus="database-owner-list">
    <label htmlFor="database-owner-list">Logins:</label>
    <select id="database-owner-list" className="database-owner-list" size={12} value={chosen} onChange={event => setChosen(event.target.value)} onDoubleClick={() => chosen && onOk(chosen)}>
      {logins.map(login => <option key={login} value={login}>{displayText(login)}</option>)}
    </select>
  </SubDialog>
}

/**
 * Database Properties' Files page: the database's name, its Owner (a login, typed or chosen), "Use full-text indexing"
 * (always on since SQL Server 2008), and the database files grid. Adding, removing and resizing files is a follow-up, so
 * the grid is read-only.
 */
export default function FilesPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const [choosing, setChoosing] = useState(false)
  const { model, draft } = databaseState(open)
  if (!model || !draft) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const owner = ownerState(model, open.target), ownerError = draftErrors(model, draft, open.target).get('owner')
  const ownerDisabled = !editable || owner.disabled
  return <div className="database-page database-files">
    {model.readOnlyReason && <PageNote>{model.readOnlyReason}</PageNote>}
    <div className="database-header">
      <div className="database-field"><label htmlFor="database-files-name">Database name:</label><input id="database-files-name" type="text" readOnly value={model.general.name} /></div>
      <div className="database-field">
        <label htmlFor="database-files-owner">Owner:</label>
        <span className="database-owner">
          <input id="database-files-owner" type="text" list="database-files-logins" maxLength={128} value={draft.owner} disabled={ownerDisabled} data-changed={draft.owner !== (model.general.owner ?? '') || undefined}
            aria-invalid={ownerError ? true : undefined} aria-errormessage={ownerError ? 'database-files-owner-error' : undefined} onChange={event => dialogs.updateDraft({ owner: event.target.value })} />
          <datalist id="database-files-logins">{model.logins.map(login => <option key={login} value={login} />)}</datalist>
          <button type="button" aria-label="Browse for the owner" disabled={ownerDisabled || model.logins.length === 0} onClick={() => setChoosing(true)}>…</button>
        </span>
        {ownerError && <span className="options-field-error" id="database-files-owner-error">{ownerError}</span>}
        {owner.note && !model.readOnlyReason && <span className="field-note">{owner.note}</span>}
      </div>
      <label className="checkbox-label"><input type="checkbox" checked disabled />Use full-text indexing</label>
    </div>
    <div className="object-dialog-caption" id="database-files-grid">Database files:</div>
    <div className="database-table">
      <table className="object-dialog-grid" aria-labelledby="database-files-grid">
        <thead><tr><th scope="col">Logical Name</th><th scope="col">File Type</th><th scope="col">Filegroup</th><th scope="col">Size (MB)</th><th scope="col">Autogrowth / Maxsize</th><th scope="col">Path</th><th scope="col">File Name</th></tr></thead>
        <tbody>{model.files.map(file => <tr key={file.name}>
          <td><bdi>{displayText(file.name)}</bdi></td><td>{fileTypeLabel[file.type]}</td><td><bdi>{file.type === 'log' ? notApplicable : displayText(file.filegroup ?? '')}</bdi></td>
          <td>{file.type === 'filestream' ? '' : file.sizeMb.toLocaleString()}</td><td>{autogrowthText(file.growth, file.type)}</td><td><bdi>{displayText(file.path)}</bdi></td><td><bdi>{displayText(file.fileName)}</bdi></td>
        </tr>)}</tbody>
      </table>
    </div>
    <PageNote>{model.filesTruncated ? 'The database has more files than are listed. ' : ''}Adding, removing and resizing files is not supported yet.</PageNote>
    {choosing && <SelectOwner logins={model.logins} current={draft.owner} onCancel={() => setChoosing(false)} onOk={login => { setChoosing(false); dialogs.updateDraft({ owner: login }) }} />}
  </div>
}
