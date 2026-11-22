// The job document's Schedules section (AG-6c, docs/agent-ui-rethink.md › rx-job-schedules, rx-schedule-pick, rx-schedule-remove): the
// job's schedules on the left with Add (search the shared schedules by name or by when, or New schedule), and beside them the selected
// schedule edited in place, a shared schedule's preview with Attach, or a removed one's detach or delete choice with Undo. Nothing reaches
// the server until the job is saved. JobDocumentService keeps every state; this only draws it.
import { useEffect } from 'react'
import { jobScheduleProblems, jobScheduleText, ownsSchedule, scheduleFieldsOf, type AgentScheduleJob, type AgentScheduleRecord, type JobScheduleEntry } from '../../../shared/actions/agent-schedule.ts'
import type { AgentJobDocumentModel, AgentJobDraft } from '../../../shared/actions/agent-job.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import {
  formatRun, freeSlotCheck, freeSlotText, freq, nextRuns, noRunsReason, scheduleMatches, scheduleProblems, scheduleSentence, scheduleText, scheduleWhen, type ScheduledJob
} from '../../../shared/agent/schedule.ts'
import Icon from '../Icon'
import ScheduleEditor from './ScheduleEditor'
import type { JobDocumentService, JobDocumentState } from './JobDocumentService'

/** How many shared schedules the pick lists at once; the search narrows the rest. */
export const pickRows = 50

interface Props {
  readonly state: JobDocumentState
  readonly model: AgentJobDocumentModel
  readonly draft: AgentJobDraft
  readonly editable: boolean
  readonly service: JobDocumentService
}

/** The jobs other than this one that use a schedule, as the shared read (sysadmin's links) or that schedule's own read lists them. */
function otherJobs(state: JobDocumentState, model: AgentJobDocumentModel, scheduleId: number): readonly AgentScheduleJob[] | undefined {
  const shared = state.shared?.model, self = model.job?.jobId.toLowerCase()
  if (shared?.links) {
    const ids = new Set(shared.links.filter(link => link.scheduleId === scheduleId).map(link => link.jobId.toLowerCase()))
    return (shared.jobs ?? []).filter(job => ids.has(job.id.toLowerCase()) && job.id.toLowerCase() !== self)
  }
  return state.scheduleJobs?.[scheduleId]?.jobs?.filter(job => job.id.toLowerCase() !== self)
}

/** The free-slot check, where the shared read knows every job's schedules and durations (sysadmin); undefined otherwise. */
function freeSlot(state: JobDocumentState, model: AgentJobDocumentModel, entry: JobScheduleEntry, now: ReturnType<JobDocumentService['now']>): string | undefined {
  const shared = state.shared?.model
  if (!shared?.links || !shared.jobs || entry.fields.freqType === freq.agentStart || entry.fields.freqType === freq.idle) return undefined
  const self = model.job?.jobId.toLowerCase()
  const durations = new Map((shared.durations ?? []).map(item => [item.jobId.toLowerCase(), item.seconds]))
  const records = new Map(shared.schedules.map(record => [record.id, record]))
  const others: ScheduledJob[] = shared.jobs.filter(job => job.id.toLowerCase() !== self).map(job => ({
    name: job.name, enabled: job.enabled, ...durations.has(job.id.toLowerCase()) ? { usualSeconds: durations.get(job.id.toLowerCase())! } : {},
    schedules: shared.links!.filter(link => link.jobId.toLowerCase() === job.id.toLowerCase()).flatMap(link => records.get(link.scheduleId) ?? [])
  }))
  return freeSlotText(freeSlotCheck(entry.fields, now, self ? durations.get(self) : undefined, others))
}

function EntryRow({ entry, selected, record, onSelect }: { readonly entry: JobScheduleEntry; readonly selected: boolean; readonly record?: AgentScheduleRecord; readonly onSelect: () => void }) {
  const shared = record ? record.jobCount - (entry.attached ? 0 : 1) : 0
  const tag = entry.remove ? jobScheduleText.removed : entry.id === undefined ? 'new' : entry.attached ? 'attached on save' : undefined
  return <li>
    <button type="button" className="agent-schedule-item" aria-current={selected || undefined} data-removed={entry.remove ? true : undefined} onClick={onSelect}>
      <Icon name="agent-schedule" />
      <span className="agent-schedule-item-text">
        <span className="agent-schedule-item-name">{entry.fields.name || '(no name)'}{tag && <span className="agent-schedule-tag"> · {tag}</span>}</span>
        <span className="field-note">{scheduleWhen(entry.fields)}{entry.fields.enabled ? '' : ' · disabled'} · {shared > 0 ? `shared with ${shared} ${shared === 1 ? 'job' : 'jobs'}` : 'this job only'}</span>
      </span>
    </button>
  </li>
}

/** A shared schedule found by the search: its sentence, owner, next runs and jobs, and Attach. */
function PickPreview(props: Props & { readonly record: AgentScheduleRecord }) {
  const { state, model, draft, editable, service, record } = props
  const now = service.now(state.id)
  const runs = nextRuns(record, now, 5)
  const jobs = otherJobs(state, model, record.id)
  const read = state.scheduleJobs?.[record.id]
  const idle = record.freqType === freq.idle && state.shared?.model?.idleDefined === false
  const full = draft.schedules.filter(entry => !entry.remove).length >= agentLimits.schedulesPerJob
  return <div className="agent-schedule-preview" aria-label={`Shared schedule ${record.name}`} role="region">
    <h3>{record.name}<span className="field-note"> · {record.enabled ? 'Enabled' : 'Disabled'}</span></h3>
    <p className="agent-schedule-sentence"><strong>{scheduleSentence(record)}</strong>{record.owner ? ` Owner: ${record.owner}.` : ''}</p>
    {idle && <p className="field-note"><Icon name="warning" />{scheduleText.idleNotDefined(state.server)}</p>}
    <div className="agent-schedule-facts">
      <section aria-label="Next 5 runs">
        <h4>Next 5 runs <span className="field-note">server time</span></h4>
        {runs.length ? <ol className="agent-schedule-runs">{runs.map(run => <li key={`${run.date}-${run.time}`}>{formatRun(run)}</li>)}</ol> : <p className="field-note">{noRunsReason(record, now)}</p>}
      </section>
      <section aria-label="Jobs in this schedule">
        <h4>Jobs in this schedule <span className="field-note">{record.jobCount}</span></h4>
        {jobs?.length ? <ul className="agent-schedule-jobs">{jobs.map(job => <li key={job.id}><Icon name="agent-job" />{job.name}{job.enabled ? '' : <span className="field-note"> · job disabled</span>}</li>)}</ul>
          : <p className="field-note">{read?.state === 'loading' ? 'Reading…' : read?.state === 'failed' ? jobScheduleText.jobsReadFailed : record.jobCount ? jobScheduleText.onlyYourJobs : 'No job uses it.'}</p>}
        {!state.shared?.model?.links && !!jobs?.length && jobs.length < record.jobCount && <p className="field-note">{jobScheduleText.onlyYourJobs}</p>}
      </section>
    </div>
    <p>
      <button type="button" className="primary" disabled={!editable || full} onClick={() => service.attachSchedule(state.id, record)}><Icon name="add" />Attach to this job</button>
      {full && <span className="field-note"> {jobScheduleText.tooMany}</span>}
    </p>
    <p className="field-note">{jobScheduleText.attachHint}</p>
  </div>
}

/** A removed schedule: detach, or delete when unused (its owner and sysadmin only), and Undo. */
function RemovedPanel(props: Props & { readonly entry: JobScheduleEntry; readonly record?: AgentScheduleRecord }) {
  const { state, model, editable, service, entry, record } = props
  const owner = model.sysadmin || (!!record && ownsSchedule(record, model.login))
  const name = `remove-${state.id}-${entry.key}`
  return <div className="agent-schedule-removed" role="region" aria-label={`${entry.fields.name} removed`}>
    <h3>{entry.fields.name} · {jobScheduleText.removed}<button type="button" disabled={!editable} onClick={() => service.undoRemove(state.id, entry.key)}>Undo</button></h3>
    <p><label><input type="radio" name={name} checked={entry.remove === 'detach'} disabled={!editable} onChange={() => service.setRemoveMode(state.id, entry.key, 'detach')} /> {jobScheduleText.detachKeep}</label></p>
    {owner && <p><label><input type="radio" name={name} checked={entry.remove === 'delete'} disabled={!editable} onChange={() => service.setRemoveMode(state.id, entry.key, 'delete')} /> {jobScheduleText.detachDelete}</label></p>}
    <p className="field-note">{jobScheduleText.removeHint}</p>
    {!owner && <p className="field-note">{jobScheduleText.removeOwnerOnly}</p>}
    <p className="field-note">{jobScheduleText.undoHint}</p>
  </div>
}

/** The selected entry edited in place, with who else uses it and Copy for this job only. */
function EntryEditor(props: Props & { readonly entry: JobScheduleEntry; readonly record?: AgentScheduleRecord }) {
  const { state, model, editable, service, entry, record } = props
  const now = service.now(state.id)
  const changeable = service.canChangeSchedule(state.id, record)
  const others = record ? otherJobs(state, model, record.id) : undefined
  const sharedCount = record ? record.jobCount - (entry.attached ? 0 : 1) : 0
  const problems = scheduleProblems(entry.fields, now)
  const readOnly = !changeable ? record?.owner ? jobScheduleText.readOnly(record.owner) : jobScheduleText.unknownOwner : undefined
  const aside = record && (sharedCount > 0 || readOnly) ? <section aria-label="Also used by">
    <h4>Also used by <span className="field-note">{sharedCount} {sharedCount === 1 ? 'job' : 'jobs'}</span></h4>
    {others?.length ? <ul className="agent-schedule-jobs">{others.map(job => <li key={job.id}><Icon name="agent-job" />{job.name}{job.enabled ? '' : <span className="field-note"> · job disabled</span>}</li>)}</ul>
      : sharedCount > 0 && <p className="field-note">{state.scheduleJobs?.[record.id]?.state === 'failed' ? jobScheduleText.jobsReadFailed : jobScheduleText.onlyYourJobs}</p>}
    {readOnly ? <p className="field-note"><Icon name="lock" />{readOnly}</p> : sharedCount > 0 && <p className="field-note">{jobScheduleText.shared(sharedCount)}</p>}
    <button type="button" disabled={!editable} onClick={() => service.copySchedule(state.id, entry.key)}><Icon name="copy" />{jobScheduleText.copy}</button>
  </section> : undefined
  return <div className="agent-schedule-entry">
    <ScheduleEditor idPrefix={`agent-schedule-${state.id}-${entry.key.replace(/[^\w-]/g, '_')}`} fields={entry.fields} base={record ? scheduleFieldsOf(record) : undefined}
      disabled={!editable || !changeable} problems={problems} now={now} freeSlot={freeSlot(state, model, entry, now)} aside={aside}
      onChange={fields => service.updateSchedule(state.id, entry.key, fields)} />
    <p><button type="button" disabled={!editable} onClick={() => service.removeSchedule(state.id, entry.key)}><Icon name="trash" />Remove from this job</button></p>
  </div>
}

export default function JobSchedules(props: Props) {
  const { state, model, draft, editable, service } = props
  const selected = state.scheduleSelected
  const entry = draft.schedules.find(item => item.key === selected)
  const record = entry ? service.scheduleRecord(state.id, entry) : undefined
  const sharedState = state.shared
  // The shared schedules are read once the section shows (the pick's search, and who else uses each schedule).
  // A save or Reload forgets them, so they are read again then.
  useEffect(() => { if (!sharedState) service.ensureShared(state.id) }, [service, state.id, sharedState])
  // Below sysadmin, a schedule's other jobs are read for the selected one only.
  const selectedId = entry?.id
  useEffect(() => { if (selectedId !== undefined && sharedState?.state === 'ready') service.ensureScheduleJobs(state.id, selectedId) }, [service, state.id, selectedId, sharedState?.state])
  const search = state.scheduleSearch ?? ''
  const onJob = new Set(draft.schedules.filter(item => !item.remove && item.id !== undefined).map(item => item.id!))
  const usable = (sharedState?.model?.schedules ?? []).filter(item => !onJob.has(item.id) && (model.sysadmin || ownsSchedule(item, model.login)))
  const matches = search.trim() ? usable.filter(item => scheduleMatches(item, search)) : []
  const picked = selected?.startsWith('pick:') ? usable.find(item => item.id === Number(selected.slice(5))) ?? sharedState?.model?.schedules.find(item => item.id === Number(selected.slice(5))) : undefined
  const listProblems = jobScheduleProblems(draft.schedules).filter(item => !item.key)
  const searchId = `agent-schedule-search-${state.id}`
  return <div className="agent-schedules">
    <div className="agent-schedule-list">
      <h4 id={`${searchId}-on`}>On this job</h4>
      {draft.schedules.length ? <ul aria-labelledby={`${searchId}-on`}>
        {draft.schedules.map(item => <EntryRow key={item.key} entry={item} selected={item.key === selected} record={service.scheduleRecord(state.id, item)} onSelect={() => service.selectSchedule(state.id, item.key)} />)}
      </ul> : <p className="field-note">{jobScheduleText.noneYet}</p>}
      {state.error?.field === 'schedules' && <p className="property-field-error" role="alert"><Icon name="error" />{state.error.message}</p>}
      {listProblems.map(item => <p key={item.problem.message} className="property-field-error" role="alert"><Icon name="error" />{item.problem.message}</p>)}
      <h4>Add</h4>
      <input id={searchId} className="property-input" type="search" placeholder="Search shared schedules" aria-label="Search shared schedules" maxLength={agentLimits.nameChars} value={search}
        disabled={!editable || sharedState?.state === 'failed'} onChange={event => service.setScheduleSearch(state.id, event.target.value)} />
      <p className="field-note">{sharedState?.state === 'failed' ? jobScheduleText.listFailed : sharedState?.state === 'loading' && search ? 'Reading the shared schedules…' : search ? jobScheduleText.pickHint : jobScheduleText.searchHint}</p>
      {search.trim() && sharedState?.state === 'ready' && (matches.length ? <ul aria-label="Shared schedules">
        {matches.slice(0, pickRows).map(item => <li key={item.id}>
          <button type="button" className="agent-schedule-item" aria-current={selected === `pick:${item.id}` || undefined} onClick={() => service.selectSchedule(state.id, `pick:${item.id}`)}>
            <Icon name="agent-schedule" />
            <span className="agent-schedule-item-text">
              <span className="agent-schedule-item-name">{item.name}{item.freqType === freq.idle && sharedState.model?.idleDefined === false && <span className="agent-schedule-tag"> · never runs</span>}</span>
              <span className="field-note">{scheduleWhen(item)} · {item.jobCount} {item.jobCount === 1 ? 'job' : 'jobs'}</span>
            </span>
          </button>
        </li>)}
      </ul> : <p className="field-note">{jobScheduleText.noMatch}</p>)}
      <button type="button" className="agent-schedule-add" disabled={!editable} onClick={() => service.newSchedule(state.id, search)}><Icon name="add" />{search.trim() ? `New schedule “${search.trim()}”` : 'New schedule'}</button>
    </div>
    <div className="agent-schedule-detail">
      {picked ? <PickPreview {...props} record={picked} />
        : entry?.remove ? <RemovedPanel {...props} entry={entry} {...record ? { record } : {}} />
        : entry ? <EntryEditor {...props} entry={entry} {...record ? { record } : {}} />
        : <p className="field-note">{draft.schedules.length ? 'Choose a schedule to edit it here.' : jobScheduleText.noneYet}</p>}
    </div>
  </div>
}
