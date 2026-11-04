// Restore Files and Filegroups' two sections (D1g), SSMS's General and Options pages (spec D1 §8, labels recalled): the
// document frame, the Run panel and the Script drawer are Restore Database's (RestoreDatabase.tsx, mode 'files').
import { isRestoreSystemDatabase, restoreDevicePickerTitles, restoreFilesRecoveryLabels, restoreLimits, restoreMessages, restoreRecoveryStates, type RestoreRecovery } from '../../../shared/actions/restore.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import PropertyField, { fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import { fieldId, PathField, Problems, type SectionProps } from './fields'
import { filesDestination, filesDestinationNote, filesGridRows, filesMoveRows, filesRowLabel, filesSetCells, filesSetColumns, filesWrappedColumns, logBackupPossible, standbyPossible, toggleFile } from './files'
import { deviceDatabases, sourceDatabase, type RestoreDraft } from './model'

const fileTypeLabel = (type: string) => type === 'log' ? 'Log' : type === 'data' ? 'Rows Data' : type === 'filestream' ? 'FILESTREAM Data' : type === 'fulltext' ? 'Full-text' : 'Other'

/** General: Destination (To database), Source (From database or From device), and Select the backup sets to restore. */
export function FilesGeneralSection({ state, draft, facts, service, problems }: SectionProps) {
  const update = (patch: Partial<RestoreDraft>) => service.updateDraft(state.id, patch)
  const destinations = facts.server?.destinations.filter(item => !isRestoreSystemDatabase(item.name)) ?? []
  const toDatabase = destinations.some(item => item.name === draft.destination) || !draft.destination ? destinations.map(item => item.name) : [draft.destination, ...destinations.map(item => item.name)]
  const onMedia = deviceDatabases(facts)
  const rows = filesGridRows(draft, facts)
  const destinationId = fieldId(state.id, 'destination'), sourceId = fieldId(state.id, 'source'), deviceId = fieldId(state.id, 'device'), mediaDatabaseId = fieldId(state.id, 'mediaDatabase')
  const gridId = fieldId(state.id, 'sets')
  const note = filesDestinationNote(filesDestination(draft, facts))
  const asFilegroup = !!draft.files?.asFilegroup, columns = filesSetColumns(asFilegroup)
  // Rows that cannot be checked (a PRIMARY file online) share one visible reason under the grid, which each one's checkbox is described by.
  const blocked = rows.find(row => row.blocked)?.blocked, blockedId = `${gridId}-blocked`
  return <div className="restore-general">
    <Problems problems={problems} />
    <h3 className="properties-group-title">Destination to restore</h3>
    <div className="properties-fields">
      <PropertyField id={destinationId} label="To database:" note={note}>
        <select id={destinationId} className="property-input" {...fieldAria(destinationId, { note })} value={draft.destination} onChange={event => update({ destination: event.target.value })}>
          {!draft.destination && <option value="" />}
          {toDatabase.map(name => <option key={name} value={name}>{displayText(name)}</option>)}
        </select>
      </PropertyField>
    </div>
    <h3 className="properties-group-title" id={`${sourceId}-label`}>Source for restore</h3>
    <div className="restore-source-choice">
      <Segmented id={sourceId} labelledBy={`${sourceId}-label`} segments={[{ value: 'database', label: 'From database' }, { value: 'device', label: 'From device' }]} value={draft.source}
        onChange={value => update({ source: value as RestoreDraft['source'], ...value === 'database' ? { database: draft.destination } : {} })} />
    </div>
    {draft.source === 'device' && <div className="properties-fields">
      <PropertyField id={deviceId} label="Device:">
        <span className="property-input-action">
          <input id={deviceId} className="property-input" type="text" readOnly value={draft.devices.join(', ')} title={draft.devices.join('\n')} />
          <button type="button" className="property-browse" aria-label={restoreDevicePickerTitles.files} title={restoreDevicePickerTitles.files} onClick={() => service.openDialog(state.id, 'devices')}>…</button>
        </span>
      </PropertyField>
      {onMedia.length > 1 && <PropertyField id={mediaDatabaseId} label="Database:">
        <select id={mediaDatabaseId} className="property-input" value={sourceDatabase(draft, facts)} onChange={event => update({ deviceDatabase: event.target.value })}>
          {onMedia.map(name => <option key={name} value={name}>{displayText(name)}</option>)}
        </select>
      </PropertyField>}
    </div>}
    <p className="restore-grid-title" id={gridId}>Select the backup sets to restore:</p>
    {state.sets === 'loading' || (state.files === 'loading' && rows.length === 0) ? <Skeleton rows={3} label="Reading the backup sets" />
      // The grid is wider than the column: its scroller is a tab stop, so the keyboard reaches the columns past the edge.
      : <div className="properties-table restore-sets" role="region" aria-labelledby={gridId} tabIndex={0}>
        <table className="object-dialog-grid" aria-labelledby={gridId}>
          <thead><tr>{columns.map(column => <th key={column} scope="col" data-wrap="never">{column}</th>)}</tr></thead>
          <tbody>{rows.map(row => {
            const cells = filesSetCells(row, asFilegroup), reasonId = `${gridId}-${row.key.replace(/\W/g, '_')}-reason`
            return <tr key={row.key} data-set={row.set.id} data-log={row.log ? true : undefined} data-problem={row.blocked ? true : undefined} title={row.log ? restoreMessages.logsFollow : row.blocked}>
              <td><input type="checkbox" aria-label={filesRowLabel(row)} checked={row.checked}
                disabled={row.log || (!!row.blocked && !row.checked)} aria-describedby={row.log ? reasonId : row.blocked ? blockedId : undefined}
                onChange={event => { if (row.name !== undefined) update(toggleFile(draft, facts, row.set.id, row.name, event.target.checked)) }} />
                {row.log && <span id={reasonId} hidden>{restoreMessages.logsFollow}</span>}</td>
              {cells.map((cell, index) => <td key={index} data-wrap={filesWrappedColumns.has(columns[index + 1]) ? undefined : 'never'}><bdi>{displayText(cell)}</bdi></td>)}
            </tr>
          })}</tbody>
        </table>
      </div>}
    {blocked && <p className="field-note" id={blockedId}>{blocked}</p>}
    {state.files === 'loading' && rows.length > 0 && <p className="field-note" role="status">Reading the files of the older backup sets…</p>}
    {facts.setsTruncated && <p className="field-note">Only the newest {restoreLimits.historySets} backup sets are read.</p>}
    <p className="field-note">The files of the newest {restoreLimits.fileSets} full and file backups are listed. {restoreMessages.logsFollow}</p>
  </div>
}

/** Options: Restore options, Restore the database files as, Recovery state and Rollback undo file, and Varia's log backup. */
export function FilesOptionsSection({ state, draft, facts, service, problems, browse }: SectionProps) {
  const update = (patch: Partial<RestoreDraft>) => service.updateDraft(state.id, patch)
  const files = draft.files!
  const rows = filesMoveRows(draft, facts), gridId = fieldId(state.id, 'files'), recoveryId = fieldId(state.id, 'recovery')
  const destination = filesDestination(draft, facts), simple = destination?.recoveryModel === 'SIMPLE'
  const backup = logBackupPossible(draft, facts), standby = standbyPossible(draft, facts)
  // A greyed option says why in a visible note its control is described by (the label's title alone reaches neither keyboards nor screen readers).
  const check = (label: string, checked: boolean, change: (value: boolean) => void, disabled = false, describedBy?: string) =>
    <label className="checkbox-label"><input type="checkbox" checked={checked} disabled={disabled} aria-describedby={describedBy} onChange={event => change(event.target.checked)} />{label}</label>
  const promptId = fieldId(state.id, 'prompt-note'), standbyId = fieldId(state.id, 'standby-reason'), logBackupFileId = fieldId(state.id, 'logBackupFile')
  const backupWhy = !destination ? undefined : simple ? 'A database in the simple recovery model has no log to back up.' : destination.state !== 'ONLINE' ? `${displayText(destination.name)} is not online, so its log cannot be backed up.`
    : draft.recovery !== 'recovery' ? 'The log backup is restored WITH RECOVERY, so it is taken only with that recovery state.' : undefined
  return <div className="restore-options object-dialog-options">
    <Problems problems={problems} />
    <h3 className="properties-group-title">Restore options</h3>
    {check('Restore as filegroup', files.asFilegroup, asFilegroup => update({ files: { ...files, asFilegroup } }))}
    {check('Overwrite the existing database (WITH REPLACE)', draft.replace, replace => update({ replace }))}
    {check('Prompt before restoring each backup', false, () => {}, true, promptId)}
    <p className="field-note" id={promptId}>{restoreMessages.notYetAvailable}</p>
    {check('Restrict access to the restored database (WITH RESTRICTED_USER)', draft.restrictedUser, restrictedUser => update({ restrictedUser }))}
    {simple && <p className="field-note">{restoreMessages.simpleReadOnly}</p>}
    <h3 className="properties-group-title" id={gridId}>Restore the database files as</h3>
    {state.files === 'loading' && rows.length === 0 ? <Skeleton rows={2} label="Reading the backup's files" /> : <div className="properties-table restore-files-table">
      <table className="object-dialog-grid" aria-labelledby={gridId}>
        <thead><tr><th scope="col">Original File Name</th><th scope="col" data-wrap="never">File Type</th><th scope="col">Restore As</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.file.logical} data-problem={row.problem ? true : undefined}>
          <td data-wrap="anywhere"><bdi>{displayText(row.file.physical)}</bdi></td><td data-wrap="never">{fileTypeLabel(row.file.type)}</td>
          <td><input className="property-input" type="text" spellCheck={false} maxLength={260} aria-label={`Restore ${row.file.logical} as`} title={row.problem ?? row.restoreAs} aria-invalid={row.problem ? true : undefined} value={row.restoreAs}
            onChange={event => update({ restoreAs: { ...draft.restoreAs, [row.file.logical]: event.target.value } })} /></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {rows.length === 0 && state.files !== 'loading' && <p className="field-note">The files show once they are checked on the General page.</p>}
    <fieldset className="restore-recovery" id={recoveryId}>
      <legend className="properties-group-title">Recovery state</legend>
      {restoreRecoveryStates.map(value => {
        const disabled = value === 'standby' && !standby
        return <label key={value} className="checkbox-label">
          <input type="radio" name={recoveryId} value={value} checked={draft.recovery === value} disabled={disabled} aria-describedby={disabled ? standbyId : undefined}
            onChange={() => update({ recovery: value as RestoreRecovery })} />{restoreFilesRecoveryLabels[value]}
        </label>
      })}
      {!standby && <p className="field-note" id={standbyId}>{restoreMessages.standbyOnline}</p>}
    </fieldset>
    <div className="properties-fields">
      <PathField id={fieldId(state.id, 'standby')} label="Rollback undo file:" value={draft.standbyFile} disabled={draft.recovery !== 'standby'} purpose="backup" browse={browse} onChange={standbyFile => update({ standbyFile })} />
    </div>
    <h3 className="properties-group-title">Log backup</h3>
    {check('Back up the log and restore it to bring the files online (WITH COPY_ONLY)', files.logBackup && backup, logBackup => update({ files: { ...files, logBackup } }), !backup,
      backup || backupWhy ? `${logBackupFileId}-note` : undefined)}
    <div className="properties-fields">
      <PathField id={logBackupFileId} label="Log backup file:" value={files.logBackupFile} disabled={!(files.logBackup && backup)} purpose="backup" browse={browse}
        note={backup ? restoreMessages.filesStayRestoring : backupWhy} onChange={logBackupFile => update({ files: { ...files, logBackupFile } })} />
    </div>
  </div>
}
