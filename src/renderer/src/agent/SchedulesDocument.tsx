// SQL Server Agent's Schedules document (AG-6c, docs/agent-ui-rethink.md › rx-schedules-doc): the toolbar (filter, All / Unused / Disabled,
// New schedule, Duplicate, Delete, Refresh), the schedules' grid with an Enabled switch that saves at once, and beside it the selected
// schedule's editor (the job document's ScheduleEditor), the jobs that use it with Attach and Detach, and "Save · n changes"; or, with
// Timeline chosen (AG-14), SchedulesTimeline: when the jobs run over the next 24 hours or 7 days. SchedulesService keeps every state; this
// only draws it.
import { memo, useDeferredValue, useMemo, useState } from 'react'
import { scheduleFieldsOf, type AgentScheduleRecord, type AgentSchedulesModel } from '../../../shared/actions/agent-schedule.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { agentNextRun, formatRun, freq, nextRuns, scheduleProblems, scheduleWhen, type AgentMoment } from '../../../shared/agent/schedule.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { DocumentFrameView, useHeaderVerbs, type HeaderVerb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import ResizableSplit from '../kit/ResizableSplit'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import { formatCount } from '../results/status'
import ScheduleEditor from './ScheduleEditor'
import SchedulesTimeline from './SchedulesTimeline'
import { newScheduleKey, schedulesText, timelineFiltered, visibleSchedules, type SchedulesMode, type SchedulesService, type SchedulesState, type SchedulesView } from './SchedulesService'

function nextRunText(record: AgentScheduleRecord, model: AgentSchedulesModel, now: AgentMoment): { readonly text: string; readonly muted: boolean } {
  if (!record.enabled) return { text: 'Disabled', muted: true }
  if (record.freqType === freq.agentStart) return { text: 'On Agent start', muted: true }
  if (record.freqType === freq.idle) return { text: 'On CPU idle', muted: true }
  const next = nextRuns(record, now, 1, agentNextRun(model.links, record.id, record, now))[0]
  return next ? { text: formatRun(next), muted: false } : { text: '—', muted: true }
}

function Detail({ state, service }: { readonly state: SchedulesState; readonly service: SchedulesService }) {
  const [attaching, setAttaching] = useState('')
  const key = state.selected
  const draft = service.draft(state.id)
  if (!key || !draft) return <p className="field-note agent-schedules-empty">Choose a schedule to edit it here, or New schedule.</p>
  const record = service.record(state.id, key)
  const readOnly = service.readOnly(state.id, record)
  const now = service.now(state.id)
  const jobs = service.draftJobs(state.id)
  const pending = new Map(draft.jobs.map(job => [job.jobId.toLowerCase(), job.attach]))
  const read = record && !state.model?.links ? state.scheduleJobs?.[record.id] : undefined
  const using = new Set(jobs.map(job => job.id.toLowerCase()))
  const attachable = (state.model?.jobs ?? []).filter(job => !using.has(job.id.toLowerCase()) && service.canChangeJob(state.id, job))
  const changes = service.changes(state.id)
  const busy = !!state.busy
  const idPrefix = `agent-schedules-${state.id}-${key}`
  return <div className="agent-schedules-detail" role="region" aria-label={key === newScheduleKey ? 'New schedule' : `Schedule ${record?.name ?? ''}`}>
    <div className="agent-schedules-detail-head">
      <div className="agent-schedules-detail-title">
        <h3>{key === newScheduleKey ? 'New schedule' : record?.name}</h3>
        {record?.owner && <span className="field-note">Owner <span className="agent-mono">{record.owner}</span></span>}
      </div>
      <div className="agent-schedules-detail-actions">
        <button type="button" disabled={!state.drafts[key] || busy} onClick={() => service.discard(state.id)}>Discard</button>
        <button type="button" className="primary" disabled={!service.canSave(state.id)} onClick={() => { void service.saveSelected(state.id) }}>
          <Icon name="save" />{state.busy === 'saving' ? 'Saving…' : key === newScheduleKey ? 'Create' : changes ? `Save · ${changes} ${changes === 1 ? 'change' : 'changes'}` : 'Save'}
        </button>
      </div>
    </div>
    <div className="agent-schedules-detail-body">
      {readOnly && <p className="field-note" role="note"><Icon name="lock" />{readOnly}</p>}
      <ScheduleEditor idPrefix={idPrefix} fields={draft.fields} {...record ? { base: scheduleFieldsOf(record) } : {}} disabled={!!readOnly || busy}
        problems={scheduleProblems(draft.fields, now, service.server(state.id))} now={now} platform={state.model?.platform} {...record ? { anchor: agentNextRun(state.model?.links, record.id, record, now) } : {}} onChange={fields => service.update(state.id, fields)}
        aside={<section aria-label="Jobs using it">
          <h4>Jobs using it <span className="agent-mono">{jobs.length}</span></h4>
          {jobs.length ? <ul className="agent-schedule-jobs">{jobs.map(job => {
            const change = pending.get(job.id.toLowerCase())
            return <li key={job.id}><Icon name="agent-job" /><span className="agent-schedule-job-name">{job.name}</span>{change === true && <span className="agent-schedule-tag"> · attached on save</span>}
              <button type="button" className="agent-schedules-link" disabled={!service.canChangeJobsOf(state.id, record) || busy || !service.canChangeJob(state.id, job)} aria-label={change === true ? `Undo attach ${job.name}` : `Detach ${job.name}`}
                onClick={() => service.toggleJob(state.id, job.id, false)}>{change === true ? 'Undo' : 'Detach'}</button></li>
          })}</ul> : <p className="field-note">{read?.state === 'loading' ? 'Reading…' : read?.state === 'failed' ? 'Which jobs use it could not be read.' : record?.jobCount ? 'Only your own jobs are listed.' : 'No job uses it.'}</p>}
          {draft.jobs.filter(job => !job.attach).map(job => <p key={job.jobId} className="field-note">{state.model?.jobs?.find(item => item.id.toLowerCase() === job.jobId.toLowerCase())?.name ?? 'A job'} is detached on save.
            <button type="button" className="agent-schedules-link" disabled={busy} onClick={() => service.toggleJob(state.id, job.jobId, false)}>Undo</button></p>)}
          {service.canChangeJobsOf(state.id, record) && attachable.length > 0 && <div className="agent-schedules-attach">
            <select className="property-input" aria-label="Attach a job" value={attaching} disabled={busy} onChange={event => setAttaching(event.target.value)}>
              <option value="">Attach a job…</option>
              {attachable.slice(0, agentLimits.listRows).map(job => <option key={job.id} value={job.id}>{job.name}</option>)}
            </select>
            <button type="button" disabled={!attaching || busy} onClick={() => { service.toggleJob(state.id, attaching, true); setAttaching('') }}><Icon name="add" />Attach</button>
          </div>}
        </section>} />
      {state.confirmDelete && record && <div className="agent-schedules-confirm" role="alertdialog" aria-label="Delete schedule">
        <p>{schedulesText.deleteConfirm(record.name)}</p>
        {record.jobCount > 0 && <p className="field-note">{schedulesText.inUse(record.jobCount)}</p>}
        <button type="button" className="danger" onClick={() => { void service.confirmDelete(state.id) }}>Delete</button>
        <button type="button" onClick={() => service.cancelDelete(state.id)}>Cancel</button>
      </div>}
      <p className="field-note">Edits to the selected schedule save on their own, guarded by its version; the grid's Enabled switch saves at once.</p>
    </div>
  </div>
}

interface GridProps {
  readonly documentId: string
  readonly rows: readonly AgentScheduleRecord[]
  readonly selected?: string
  /** The ids with a draft, joined, so a keystroke in the editor leaves the grid as it is. */
  readonly edited: string
  readonly busy: boolean
  readonly service: SchedulesService
  /** The read the rows came from: whether each is read-only follows it. */
  readonly model: AgentSchedulesModel
  /** Whether the login is in SQLAgentOperatorRole, read after the schedules (AG-10): its Enabled switches follow the answer. */
  readonly operatorRole: boolean
}
const ScheduleGrid = memo(function ScheduleGrid({ documentId, rows, selected: current, edited, busy, service, model }: GridProps) {
  const drafts = new Set(edited.split(',').filter(Boolean))
  const now = service.now(documentId)
  return <table className="agent-table borderless agent-schedules-grid" aria-label="Schedules" aria-rowcount={rows.length}>
    <thead><tr><th scope="col">Name</th><th scope="col">When</th><th scope="col">Enabled</th><th scope="col" className="num">Jobs</th><th scope="col">Next Run</th><th scope="col">Owner</th></tr></thead>
    <tbody>
      {rows.map(record => {
        const key = String(record.id), selected = current === key
        const toggle = service.canToggle(documentId, record)
        const switchId = `agent-schedules-${documentId}-enabled-${record.id}`
        const next = nextRunText(record, model, now)
        return <tr key={key} aria-selected={selected} data-disabled={record.enabled ? undefined : true} onClick={() => service.select(documentId, key)}>
          <td><button type="button" className="agent-schedules-row" aria-current={selected || undefined} onClick={event => { event.stopPropagation(); service.select(documentId, key) }}>
            {record.name}{drafts.has(key) && <span className="agent-schedule-tag"> · edited</span>}</button></td>
          <td>{scheduleWhen(record)}</td>
          <td onClick={event => event.stopPropagation()}>
            <label htmlFor={switchId} className="visually-hidden">{`Enabled: ${record.name}`}</label>
            <Switch id={switchId} checked={record.enabled} disabled={!toggle || busy}
              onChange={checked => { void service.setEnabled(documentId, record.id, checked) }} />
          </td>
          <td className="num">{record.jobCount || <span className="agent-schedule-tag">unused</span>}</td>
          <td className={next.muted ? undefined : 'agent-mono'}>{next.muted ? <span className="agent-schedule-tag">{next.text}</span> : next.text}</td>
          <td className="agent-mono">{record.owner ?? ''}</td>
        </tr>
      })}
    </tbody>
  </table>
})

export default function SchedulesDocument({ documentId }: { readonly documentId: string }) {
  const service = useWorkbench().schedules
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  const model = state?.model
  const rows = useMemo(() => visibleSchedules(model, state?.view ?? 'all', state?.filter ?? ''), [model, state?.view, state?.filter])
  // The Timeline rebuilds its model per filter (up to 40,000 runs): typing goes on at once and the Timeline follows when React has time.
  const timelineFilter = useDeferredValue(state?.filter ?? '')
  const timelineRead = useMemo(() => model && timelineFiltered(model, timelineFilter), [model, timelineFilter])
  const refreshVerbs = useHeaderVerbs([{ command: 'agentSchedules.refresh', args: { tabId: documentId }, label: 'Refresh' }])
  if (!state) return null
  const counts = { all: model?.schedules.length ?? 0, unused: model?.schedules.filter(record => record.jobCount === 0).length ?? 0, disabled: model?.schedules.filter(record => !record.enabled).length ?? 0 }
  const viewId = `agent-schedules-view-${documentId}`
  const modeId = `agent-schedules-mode-${documentId}`
  const filterId = `agent-schedules-filter-${documentId}`
  const busy = !!state.busy
  const timeline = state.mode === 'timeline'
  const newScheduleVerb: HeaderVerb = {
    key: 'new-schedule',
    label: 'New schedule',
    title: 'New schedule',
    icon: 'add',
    emphasis: 'primary',
    disabled: busy || !model,
    run: () => service.newSchedule(documentId)
  }
  const tools = <>
    <span id={modeId} className="visually-hidden">View</span>
    <Segmented id={`${modeId}-seg`} labelledBy={modeId} value={state.mode ?? 'grid'} onChange={value => service.setMode(documentId, value as SchedulesMode)}
      segments={[{ value: 'grid', label: 'Grid' }, { value: 'timeline', label: 'Timeline' }]} />
  </>
  const body = <div className="document-body agent-schedules-doc">
    <div className="activity-pane-tools one-row agent-schedules-tools" role="toolbar" aria-label="Schedules">
      <span className="activity-filter-box">
        <Icon name="search" />
        <label htmlFor={filterId} className="visually-hidden">Filter schedules or jobs</label>
        <input id={filterId} type="search" placeholder="Filter schedules or jobs…" maxLength={agentLimits.nameChars} value={state.filter}
          data-agent-schedules-focus onChange={event => service.setFilter(documentId, event.target.value)} />
      </span>
      {!timeline && <>
        <span id={viewId} className="visually-hidden">Show</span>
        <Segmented id={`${viewId}-seg`} labelledBy={viewId} value={state.view} onChange={value => service.setView(documentId, value as SchedulesView)}
          segments={[{ value: 'all', label: `All ${counts.all}` }, { value: 'unused', label: `Unused ${counts.unused}` }, { value: 'disabled', label: `Disabled ${counts.disabled}` }]} />
        <span className="activity-tools-separator" aria-hidden="true" />
        <button type="button" className="activity-tool" disabled={busy || !service.draft(documentId)} onClick={() => service.duplicate(documentId)}><Icon name="copy" />Duplicate</button>
        <button type="button" className="activity-tool danger" disabled={!service.canDelete(documentId)} onClick={() => service.askDelete(documentId)}><Icon name="trash" />Delete</button>
      </>}
      <span className="field-note agent-schedules-time">Times are server time</span>
    </div>
    {state.error && <InlineError message={state.error.message} code={state.error.code} context={`Schedules on ${state.server}`} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.truncated && <p className="field-note">{schedulesText.truncated}</p>}
    {!timeline && state.view === 'unused' && <p className="field-note">{schedulesText.unusedNote}</p>}
    {state.phase === 'loading' && !model ? <Skeleton /> : model && timeline && timelineRead ? <SchedulesTimeline documentId={documentId} model={timelineRead} span={state.span ?? 'day'}
      onSpan={span => service.setSpan(documentId, span)} onOpenJob={name => service.openJob(documentId, name)} onOpenSchedule={id => service.openSchedule(documentId, id)} />
      : model && <ResizableSplit className="agent-schedules-split" mainClassName="agent-schedules-main" railClassName="agent-schedules-rail"
        storageKey="agent.schedules.detail" side="right" defaultWidth={472} minWidth={360} maxWidth={660} minOtherWidth={340} narrowStackWidth={680}
        label="Resize schedule detail" railLabel="Schedule detail" rail={<Detail key={state.selected ?? ''} state={state} service={service} />}>
        <div className="agent-schedules-grid-wrap">
          <ScheduleGrid documentId={documentId} rows={rows} {...state.selected ? { selected: state.selected } : {}} edited={Object.keys(state.drafts).sort().join(',')} busy={busy}
            service={service} model={model} operatorRole={!!state.operatorRole} />
          {!rows.length && <p className="field-note agent-schedules-empty">{model.schedules.length ? 'No schedule matches.' : 'This server has no schedule yet.'}</p>}
        </div>
      </ResizableSplit>}
  </div>
  return <DocumentFrameView id={`agent-schedules-${documentId}`} title="Schedules"
    crumbs={[{ label: state.server }, { label: 'SQL Server Agent' }]}
    state={model && <StatusPill tone="neutral" icon={null} label={`${formatCount(model.schedules.length)} shared`} />}
    tools={tools} verbs={[...refreshVerbs, newScheduleVerb]} attributes={{ 'data-agent-schedules': documentId }} body={body} />
}
