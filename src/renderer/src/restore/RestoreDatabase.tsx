import { useEffect, useRef, useState } from 'react'
import { isRestoreSystemDatabase, restoreLimits, restoreMessages, restoreRecoveryLabels, restoreRecoveryStates, restoreSections, restoreTargetProblem, type RestoreRecovery } from '../../../shared/actions/restore.ts'
import type { ServerFilePurpose } from '../../../shared/actions/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { IconId } from '../../../shared/icons.ts'
import type { StatusTone } from '../../../shared/theme/tones.ts'
import { useActionProgress } from '../actions/ActionProgressService'
import { useTicker } from '../core/useTicker'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PropertyField, { fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import StepList from '../kit/StepList'
import { formatElapsed } from '../results/status'
import {
  checkable, destinationNote, destinationOf, deviceDatabases, draftPlan, draftProblems, fileRows, restoreToText, setCells, setColumns, setManual, setReason, sourceDatabase, sourceSets,
  tailLogPossible, toggleSet, type RestoreDraft, type RestoreFacts
} from './model'
import type { RestoreRun, RestoreService, RestoreState } from './RestoreService'
import BackupTimeline from './BackupTimeline'
import { outcomeTitle, overallPercent, restoredText, runNote, runSteps, sectionSummaries, stopQuestion, type RunOutcome } from './run'

const fieldId = (documentId: string, key: string) => `restore-${documentId}-${key}`

export interface SectionProps {
  readonly state: RestoreState
  readonly draft: RestoreDraft
  readonly facts: RestoreFacts
  readonly service: RestoreService
  readonly problems: readonly string[]
  readonly browse: (purpose: ServerFilePurpose, initialPath?: string) => Promise<string | undefined>
}

function Problems({ problems }: { readonly problems: readonly string[] }) {
  return problems.length === 0 ? null : <ul className="restore-problems">{problems.map(problem => <li key={problem}><Icon name="error" />{problem}</li>)}</ul>
}

/** A path field with SSMS's "…" button, which opens the server file picker. */
function PathField({ id, label, value, disabled, note, purpose, browse, onChange }: {
  readonly id: string; readonly label: string; readonly value: string; readonly disabled?: boolean; readonly note?: string; readonly purpose: ServerFilePurpose
  readonly browse: SectionProps['browse']; readonly onChange: (value: string) => void
}) {
  return <PropertyField id={id} label={label} note={note}>
    <span className="property-input-action">
      <input id={id} className="property-input" type="text" spellCheck={false} maxLength={260} value={value} title={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
      <button type="button" className="property-browse" aria-label={`Browse for ${label.replace(/:$/, '').toLowerCase()}`} title={`Browse for ${label.replace(/:$/, '').toLowerCase()}`} disabled={disabled}
        onClick={() => void browse(purpose, value || undefined).then(path => { if (path) onChange(path) })}>…</button>
    </span>
  </PropertyField>
}

/** General: Source (Database, or Device and the database on it), Destination (Database, Restore to and Timeline…), and the Restore plan's sets. */
function GeneralSection({ state, draft, facts, service, problems }: SectionProps) {
  const update = (patch: Partial<RestoreDraft>) => service.updateDraft(state.id, patch)
  const plan = draftPlan(draft, facts)
  const databases = facts.historyDatabases.includes(draft.database) || !draft.database ? facts.historyDatabases : [draft.database, ...facts.historyDatabases]
  const onMedia = deviceDatabases(facts)
  const destinations = facts.server?.destinations.filter(item => !isRestoreSystemDatabase(item.name)) ?? []
  const sets = [...sourceSets(draft, facts)].sort((a, b) => a.finish < b.finish ? -1 : a.finish > b.finish ? 1 : a.position - b.position)
  const sourceId = fieldId(state.id, 'source'), databaseId = fieldId(state.id, 'database'), deviceId = fieldId(state.id, 'device'), destinationId = fieldId(state.id, 'destination')
  const mediaDatabaseId = fieldId(state.id, 'mediaDatabase'), gridId = fieldId(state.id, 'sets'), planId = fieldId(state.id, 'plan')
  const target = restoreTargetProblem(draft.destination), note = destinationNote(draft, facts)
  const mediaNote = onMedia.length > 1 ? `The backup files hold ${onMedia.length} databases; the grid lists the chosen one's sets.` : undefined
  return <div className="restore-general">
    <Problems problems={problems} />
    <h3 className="properties-group-title" id={`${sourceId}-label`}>Source</h3>
    <div className="restore-source-choice">
      <Segmented id={sourceId} labelledBy={`${sourceId}-label`} segments={[{ value: 'database', label: 'Database' }, { value: 'device', label: 'Device' }]} value={draft.source}
        onChange={value => update({ source: value as RestoreDraft['source'] })} />
    </div>
    <div className="properties-fields">
      {draft.source === 'database'
        ? <PropertyField id={databaseId} label="Database:" note={databases.length === 0 ? restoreMessages.noHistory : undefined}>
          <select id={databaseId} className="property-input" value={draft.database} disabled={databases.length === 0} onChange={event => update({ database: event.target.value })}>
            {databases.map(name => <option key={name} value={name}>{displayText(name)}</option>)}
          </select>
        </PropertyField>
        : <>
          <PropertyField id={deviceId} label="Device:">
            <span className="property-input-action">
              <input id={deviceId} className="property-input" type="text" readOnly value={draft.devices.join(', ')} title={draft.devices.join('\n')} />
              <button type="button" className="property-browse" aria-label="Select backup devices" title="Select backup devices" onClick={() => service.openDialog(state.id, 'devices')}>…</button>
            </span>
          </PropertyField>
          {onMedia.length > 0 && <PropertyField id={mediaDatabaseId} label="Database:" note={mediaNote}>
            <select id={mediaDatabaseId} className="property-input" {...fieldAria(mediaDatabaseId, { note: mediaNote })} value={sourceDatabase(draft, facts)} onChange={event => update({ deviceDatabase: event.target.value })}>
              {onMedia.map(name => <option key={name} value={name}>{displayText(name)}</option>)}
            </select>
          </PropertyField>}
        </>}
    </div>
    <h3 className="properties-group-title">Destination</h3>
    <div className="properties-fields">
      <PropertyField id={destinationId} label="Database:" error={target} note={note}>
        <input id={destinationId} className="property-input" {...fieldAria(destinationId, { note, error: target })} type="text" list={`${destinationId}-list`} maxLength={128} spellCheck={false} value={draft.destination} onChange={event => update({ destination: event.target.value })} />
        <datalist id={`${destinationId}-list`}>{destinations.map(item => <option key={item.name} value={item.name} />)}</datalist>
      </PropertyField>
      <PropertyField id={fieldId(state.id, 'restoreTo')} label="Restore to:" labelFor={false}>
        <span className="property-input-action">
          <span id={fieldId(state.id, 'restoreTo')} className="property-value restore-to" role="textbox" aria-readonly="true" aria-labelledby={`${fieldId(state.id, 'restoreTo')}-label`} tabIndex={0}
            title={restoreToText(draft, facts, plan)}>{restoreToText(draft, facts, plan)}</span>
          <button type="button" className="property-browse" disabled={sets.length === 0} onClick={() => service.openDialog(state.id, 'timeline')}>Timeline…</button>
        </span>
      </PropertyField>
    </div>
    <h3 className="properties-group-title">Restore plan</h3>
    <p className="restore-grid-title" id={gridId}>Backup sets to restore:</p>
    {state.sets === 'loading' ? <Skeleton rows={3} label="Reading the backup sets" />
      // The grid is wider than the column: its scroller is a tab stop, so the keyboard reaches the columns past the edge.
      : <div className="properties-table restore-sets" role="region" aria-labelledby={gridId} tabIndex={0}>
        <table className="object-dialog-grid" aria-labelledby={gridId}>
          <thead><tr>{setColumns.map(column => <th key={column} scope="col" data-wrap="never">{column}</th>)}</tr></thead>
          <tbody>{sets.map(set => {
            const checked = plan.ids.includes(set.id), cells = setCells(set), reason = setReason(set), reasonId = `${gridId}-${set.id}-reason`
            return <tr key={set.id} data-set={set.id} data-problem={reason ? true : undefined} title={reason}>
              <td><input type="checkbox" aria-label={`Restore ${set.name || cells[2]} (${cells[11]})`} checked={checked} disabled={!checkable(draft, set)} aria-describedby={reason ? reasonId : undefined}
                onChange={event => update(toggleSet(draft, facts, set.id, event.target.checked))} />{reason && <span id={reasonId} hidden>{reason}</span>}</td>
              {cells.map((cell, index) => <td key={index} data-wrap={index === 0 || index === 3 || index === 4 || index === 13 ? undefined : 'never'}><bdi>{displayText(cell)}</bdi></td>)}
            </tr>
          })}</tbody>
        </table>
      </div>}
    {facts.setsTruncated && <p className="field-note">Only the newest {restoreLimits.historySets} backup sets are listed.</p>}
    <div className="restore-plan-row">
      <label className="checkbox-label"><input type="checkbox" checked={!!draft.manual} disabled={sets.length === 0} aria-describedby={planId} onChange={event => update(setManual(draft, facts, event.target.checked))} />Manual Selection</label>
      <span className="field-note" id={planId}>{plan.manual ? 'The checked backup sets restore in order.' : 'The plan restores to the point chosen in Restore to; check Manual Selection to choose the sets.'}</span>
      <button type="button" disabled title={restoreMessages.notYetAvailable}>Verify Backup Media</button>
    </div>
  </div>
}

/** Files: Relocate all files to folder, and each file's Restore As (SSMS's grid, recalled). */
function FilesSection({ state, draft, facts, service, problems, browse }: SectionProps) {
  const update = (patch: Partial<RestoreDraft>) => service.updateDraft(state.id, patch)
  const rows = fileRows(draft, facts), gridId = fieldId(state.id, 'files')
  return <div className="restore-files">
    <Problems problems={problems} />
    <label className="checkbox-label"><input type="checkbox" checked={draft.relocate} onChange={event => update({ relocate: event.target.checked })} />Relocate all files to folder</label>
    <div className="properties-fields">
      <PathField id={fieldId(state.id, 'dataFolder')} label="Data file folder:" value={draft.dataFolder} disabled={!draft.relocate} purpose="folder" browse={browse} onChange={dataFolder => update({ dataFolder })} />
      <PathField id={fieldId(state.id, 'logFolder')} label="Log file folder:" value={draft.logFolder} disabled={!draft.relocate} purpose="folder" browse={browse} onChange={logFolder => update({ logFolder })} />
    </div>
    <h3 className="properties-group-title" id={gridId}>Restore the database files as</h3>
    {state.files === 'loading' ? <Skeleton rows={2} label="Reading the backup's files" /> : <div className="properties-table restore-files-table">
      <table className="object-dialog-grid" aria-labelledby={gridId}>
        <thead><tr><th scope="col">Logical File Name</th><th scope="col" data-wrap="never">File Type</th><th scope="col">Original File Name</th><th scope="col">Restore As</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.file.logical} data-problem={row.problem ? true : undefined}>
          <td><bdi>{displayText(row.file.logical)}</bdi></td><td data-wrap="never">{row.file.type === 'log' ? 'Log' : row.file.type === 'data' ? 'Rows Data' : row.file.type === 'filestream' ? 'FILESTREAM Data' : row.file.type === 'fulltext' ? 'Full-text' : 'Other'}</td>
          <td data-wrap="anywhere"><bdi>{displayText(row.file.physical)}</bdi></td>
          <td><input className="property-input" type="text" spellCheck={false} maxLength={260} aria-label={`Restore ${row.file.logical} as`} title={row.problem ?? row.restoreAs} aria-invalid={row.problem ? true : undefined} value={row.restoreAs}
            onChange={event => update({ restoreAs: { ...draft.restoreAs, [row.file.logical]: event.target.value } })} /></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {rows.length === 0 && state.files !== 'loading' && <p className="field-note">The files show once a full backup is chosen.</p>}
  </div>
}

/** Options: Restore options, Recovery state, Tail-Log backup, Server connections and Prompt (SSMS's groups, recalled). */
function OptionsSection({ state, draft, facts, service, problems, browse }: SectionProps) {
  const update = (patch: Partial<RestoreDraft>) => service.updateDraft(state.id, patch)
  const tail = tailLogPossible(draft, facts), recoveryId = fieldId(state.id, 'recovery')
  const check = (label: string, checked: boolean, change: (value: boolean) => void, disabled = false, title?: string) =>
    <label className="checkbox-label" title={title}><input type="checkbox" checked={checked} disabled={disabled} onChange={event => change(event.target.checked)} />{label}</label>
  return <div className="restore-options object-dialog-options">
    <Problems problems={problems} />
    <h3 className="properties-group-title">Restore options</h3>
    {check('Overwrite the existing database (WITH REPLACE)', draft.replace, replace => update({ replace }))}
    {check('Preserve the replication settings (WITH KEEP_REPLICATION)', draft.keepReplication, keepReplication => update({ keepReplication }), draft.recovery === 'norecovery')}
    {check('Restrict access to the restored database (WITH RESTRICTED_USER)', draft.restrictedUser, restrictedUser => update({ restrictedUser }))}
    <div className="properties-fields">
      <PropertyField id={recoveryId} label="Recovery state:">
        <select id={recoveryId} className="property-input" value={draft.recovery} onChange={event => update({ recovery: event.target.value as RestoreRecovery })}>
          {restoreRecoveryStates.map(value => <option key={value} value={value}>{restoreRecoveryLabels[value]}</option>)}
        </select>
      </PropertyField>
      <PathField id={fieldId(state.id, 'standby')} label="Standby file:" value={draft.standbyFile} disabled={draft.recovery !== 'standby'} purpose="backup" browse={browse} onChange={standbyFile => update({ standbyFile })} />
    </div>
    <h3 className="properties-group-title">Tail-Log backup</h3>
    {check('Take tail-log backup before restore', draft.tailLog && tail, tailLog => update({ tailLog }), !tail, tail ? undefined : 'Only a database restored over itself, online, in the full or bulk-logged recovery model has a log to back up.')}
    {check('Leave source database in the restoring state (WITH NORECOVERY)', draft.leaveRestoring, leaveRestoring => update({ leaveRestoring }), !(draft.tailLog && tail))}
    <div className="properties-fields">
      <PathField id={fieldId(state.id, 'tailFile')} label="Backup file:" value={draft.tailLogFile} disabled={!(draft.tailLog && tail)} purpose="backup" browse={browse} onChange={tailLogFile => update({ tailLogFile })} />
    </div>
    <h3 className="properties-group-title">Server connections</h3>
    {check('Close existing connections to destination database', draft.closeConnections, closeConnections => update({ closeConnections }), !destinationOf(facts, draft.destination))}
    <h3 className="properties-group-title">Prompt</h3>
    {check('Prompt before restoring each backup', false, () => {}, true, restoreMessages.notYetAvailable)}
    <p className="field-note">{restoreMessages.notYetAvailable}</p>
  </div>
}

/** Select backup devices: File media only, the files in the order added (SSMS's sub-dialog, recalled). */
function SelectBackupDevices({ state, draft, service, browse }: Pick<SectionProps, 'state' | 'draft' | 'service' | 'browse'>) {
  const [devices, setDevices] = useState<readonly string[]>(draft.devices)
  const [chosen, setChosen] = useState<string>('')
  const listId = fieldId(state.id, 'media'), typeId = fieldId(state.id, 'mediaType')
  const add = () => void browse('backup').then(path => { if (path && !devices.includes(path)) { setDevices([...devices, path]); setChosen(path) } })
  return <SubDialog title="Select backup devices" okDisabled={devices.length === 0} onCancel={() => service.openDialog(state.id, undefined)}
    onOk={() => { service.openDialog(state.id, undefined); service.updateDraft(state.id, { source: 'device', devices }) }} initialFocus={listId} className="restore-devices">
    <div className="property-row"><label htmlFor={typeId}>Backup media type:</label><select id={typeId} value="file" onChange={() => {}}><option value="file">File</option></select></div>
    <label htmlFor={listId}>Backup media:</label>
    <div className="restore-media">
      <select id={listId} size={8} value={chosen} onChange={event => setChosen(event.target.value)}>
        {devices.map(device => <option key={device} value={device} title={device}>{device}</option>)}
      </select>
      <div className="restore-media-buttons">
        <button type="button" disabled={devices.length >= restoreLimits.backupDevices} onClick={add}>Add</button>
        <button type="button" disabled={!chosen} onClick={() => { setDevices(devices.filter(device => device !== chosen)); setChosen('') }}>Remove</button>
        <button type="button" disabled title={restoreMessages.notYetAvailable}>Contents</button>
      </div>
    </div>
    {devices.length >= restoreLimits.backupDevices && <p className="field-note">A restore reads at most {restoreLimits.backupDevices} files.</p>}
  </SubDialog>
}

/** The confirm bar before a restore runs (owner decision 4): its lines, then Restore and Cancel; Cancel has focus and Escape answers it. */
function RunConfirm({ state, lines, service }: { readonly state: RestoreState; readonly lines: readonly string[]; readonly service: RestoreService }) {
  const cancel = useRef<HTMLButtonElement>(null)
  // The safe answer has focus, so a stray Enter never overwrites a database.
  useEffect(() => cancel.current?.focus(), [lines])
  const textId = `restore-${state.id}-confirm`
  return <div className="restore-confirm" role="alertdialog" aria-label="Restore Database" aria-describedby={textId}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); service.cancelRun(state.id) } }}>
    <Icon name="warning" />
    <div id={textId} className="restore-confirm-text">{lines.map(line => <p key={line}>{line}</p>)}</div>
    <button type="button" className="danger" onClick={() => void service.confirmRun(state.id)}>Restore</button>
    <button type="button" ref={cancel} onClick={() => service.cancelRun(state.id)}>Cancel</button>
  </div>
}

/** Stop over a database that existed asks first (critic A11c): Keep restoring has focus and Escape answers it. */
function StopConfirm({ state, run, service }: { readonly state: RestoreState; readonly run: RestoreRun; readonly service: RestoreService }) {
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [])
  const textId = `restore-${state.id}-stop`
  return <div className="restore-confirm" role="alertdialog" aria-label="Stop the restore" aria-describedby={textId}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); service.answerStop(state.id, false) } }}>
    <Icon name="warning" />
    <div id={textId} className="restore-confirm-text"><p>{stopQuestion(run.database, run.replace)}</p></div>
    <button type="button" ref={keep} onClick={() => service.answerStop(state.id, false)}>Keep restoring</button>
    <button type="button" className="danger" onClick={() => service.answerStop(state.id, true)}>Stop</button>
  </div>
}

const outcomeTones: Readonly<Record<RunOutcome, StatusTone>> = { done: 'success', failed: 'critical', stopped: 'warning', unknown: 'warning' }
const outcomeIcons: Readonly<Record<RunOutcome, IconId>> = { done: 'pass', failed: 'error', stopped: 'debug-stop', unknown: 'warning' }

/**
 * The Run panel at the top of the document once Restore runs (spec 9.1): the restore's title, elapsed time and overall
 * percent, Stop's question, the steps with the running RESTORE's STATS bar, what a Stop or a failure leaves, and once it
 * ends, the outcome with the database's state and Restore again (which keeps the choices).
 */
function RunPanel({ state, run, service }: { readonly state: RestoreState; readonly run: RestoreRun; readonly service: RestoreService }) {
  const workbench = useWorkbench()
  const running = run.phase === 'running'
  const progress = useActionProgress(workbench.actionProgress, running ? run.requestId : undefined)
  const now = useTicker(running)
  const outcome = running ? undefined : run.phase as RunOutcome
  const titleId = `restore-${state.id}-run`
  const elapsed = run.startedAt === undefined ? 0 : (run.endedAt ?? now) - run.startedAt
  const overall = overallPercent(run.planned, progress)
  const steps = runSteps(run.planned, run.steps, progress, running)
  const left = outcome ? restoredText(run.database, run.restored, run.existed) : undefined
  return <section className="restore-run" aria-labelledby={titleId} data-run={run.phase}>
    <div className="restore-run-head">
      <Icon name={outcome ? outcomeIcons[outcome] : 'loading'} spin={!outcome} className={outcome ? `restore-run-${outcome}` : undefined} />
      <h2 id={titleId} className="restore-run-title">{outcome ? outcomeTitle(outcome, run.database) : `${run.stopping ? 'Stopping' : 'Restoring'} ${displayText(run.database)}`}</h2>
      <span className="restore-run-elapsed">{outcome ? 'Took' : 'Elapsed'} {formatElapsed(elapsed)}</span>
      {running && <span className="restore-run-overall">
        <span>about {overall} %</span>
        <span className="step-list-progress" role="progressbar" aria-label={`Restoring ${run.database}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall} aria-valuetext={`About ${overall} percent`}>
          <span className="step-list-fill" style={{ width: `${overall}%` }} />
        </span>
      </span>}
    </div>
    {running && run.stopConfirm && <StopConfirm state={state} run={run} service={service} />}
    <StepList steps={steps} labelledBy={titleId} />
    {outcome && run.error && <InlineError message={run.error.message} code={run.error.code} role="alert" context={`Restore Database on ${state.server}`} note={left}
      actions={service.canRun(state.id) ? [{ label: 'Restore again', run: () => void service.run(state.id) }] : []} />}
    {outcome === 'done' && <p className="restore-run-outcome" role="status"><Icon name="pass" />{left ?? `Restored ${displayText(run.database)}.`}</p>}
    {running && <p className="document-status"><Icon name="info" />{run.stopping ? 'Stopping: SQL Server ends the running statement, then Varia undoes what this restore changed.' : runNote(run.database, run.existed)}</p>}
  </section>
}

/** The header's state while the restore runs, with the overall percent. */
function RunPill({ run }: { readonly run: RestoreRun }) {
  const progress = useActionProgress(useWorkbench().actionProgress, run.requestId)
  const overall = `about ${overallPercent(run.planned, progress)} %`
  return <StatusPill tone="running" size="small" label={run.stopping ? 'Stopping' : `Restoring · ${overall}`} value={run.stopping ? undefined : overall} />
}

/**
 * Restore Database as a document: General, Files and Options as sections, the Select backup devices and Backup Timeline
 * sub-dialogs, and the Script drawer with the restore's script (D1e). Restore runs it (D1f): the confirm bar first when a
 * fact calls for it, then the Run panel with the steps, Stop and the outcome; while it runs, the sections show their
 * one-line summaries.
 */
export default function RestoreDatabase({ documentId }: { documentId: string }) {
  const workbench = useWorkbench()
  const { restore } = workbench
  const { documents } = useServiceSnapshot(restore)
  const state = documents[documentId]
  if (!state) return <div className="restore-database" />
  const connectionId = workbench.documents.get(state.id)?.connectionId
  const browse: SectionProps['browse'] = (purpose, initialPath) => connectionId ? workbench.serverFiles.pick({ connectionId, purpose, ...initialPath ? { initialPath } : {} }) : Promise.resolve(undefined)
  const { draft, facts, run } = state
  const problems = draft ? draftProblems(draft, facts) : { general: [], files: [], options: [] }
  const busy = run?.phase === 'running' || run?.phase === 'checking'
  const summaries = busy && draft ? sectionSummaries(draft, facts) : undefined
  const content = (section: 'general' | 'files' | 'options') => {
    if (!draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the backups" /> : <p className="field-note">Nothing to show: the backups could not be read.</p>
    // While it runs, the choices stay as they were sent: each section says them in a line, and the steps stay in view.
    if (summaries) return <p className="restore-summary">{summaries[section]}</p>
    const props: SectionProps = { state, draft, facts, service: restore, problems: problems[section], browse }
    switch (section) {
      case 'general': return <GeneralSection {...props} />
      case 'files': return <FilesSection {...props} />
      case 'options': return <OptionsSection {...props} />
    }
  }
  const sections: FrameSection[] = restoreSections.map(section => ({ id: section.id, title: section.title, problem: !summaries && problems[section.id].length > 0, content: content(section.id) }))
  const loading = state.phase === 'loading' ? 'Reading the backups…' : state.sets === 'loading' ? 'Reading the backup sets…' : run?.phase === 'checking' ? 'Reading the server before the restore…' : undefined
  const source = draft ? sourceDatabase(draft, facts) : ''
  const args = { tabId: state.id }
  const verbs: Verb[] = run?.phase === 'running'
    ? [{ command: 'restoreDatabase.stop', args, emphasis: 'danger' }]
    : [{ command: 'restoreDatabase.refresh', args }, { command: 'restoreDatabase.run', args, emphasis: 'primary' }]
  const outcome = run && run.phase !== 'running' && run.phase !== 'checking' && run.phase !== 'confirm' ? run.phase : undefined
  const pill = run?.phase === 'running' ? <RunPill run={run} />
    : outcome ? <StatusPill tone={outcomeTones[outcome]} size="small" label={{ done: 'Restored', failed: 'Failed', stopped: 'Stopped', unknown: 'Unknown' }[outcome]} /> : undefined
  const banner = <>
    {loading && <p className="document-status" role="status"><Icon name="loading" spin />{loading}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} role="alert" context={`Restore Database on ${state.server}`} actions={restore.canRefresh(state.id) ? [{ label: 'Refresh', run: () => restore.refresh(state.id) }] : []} />}
    {state.runNotice && <p className="document-status" role="status"><Icon name="warning" />{state.runNotice}</p>}
    {state.refusal && <p className="document-status" role="alert"><Icon name="warning" />{state.refusal}</p>}
    {run?.phase === 'confirm' && run.confirm && <RunConfirm state={state} lines={run.confirm} service={restore} />}
    {run && run.phase !== 'checking' && run.phase !== 'confirm' && <RunPanel state={state} run={run} service={restore} />}
  </>
  return <><DocumentFrame id={`restore-${state.id}`} title={draft?.destination ? `Restore Database - ${draft.destination}` : 'Restore Database'} subtitle={source && source !== draft?.destination ? `from ${source}` : undefined}
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'Databases' }]} state={pill} verbs={verbs} banner={banner} sections={sections} frame={state.frame}
    onFrame={frame => restore.setFrame(state.id, frame)} attributes={{ 'data-restore': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void restore.deliver(state.id, destination) }} />
    {state.dialog === 'devices' && draft && <SelectBackupDevices state={state} draft={draft} service={restore} browse={browse} />}
    {state.dialog === 'timeline' && draft && <BackupTimeline state={state} draft={draft} facts={facts} service={restore} />}
  </>
}
