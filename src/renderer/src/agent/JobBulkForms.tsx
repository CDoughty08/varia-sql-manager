// Job Activity Monitor's Change owner and Attach schedule forms (AG-3b, docs/sql-server-agent.md): below the bulk bar, for the jobs
// selected when the form opened. Change owner takes a login (the logins New Job's describe lists, for a sysadmin); Attach schedule picks
// a shared schedule as the job document's Schedules section does (search by name or by when, then its sentence, owner, next runs and
// jobs). Change or Attach closes the form and sends one request per job, each with its own result line. JobActivityService keeps every
// state; this only draws it.
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { agentBulkText } from '../../../shared/agent/bulk'
import { agentLimits } from '../../../shared/agent/catalog'
import { agentBulkTitles } from '../../../shared/agent/jobs'
import { momentOfText } from '../../../shared/actions/agent-schedule'
import { formatRun, freq, nextRuns, noRunsReason, scheduleMatches, scheduleSentence, scheduleWhen } from '../../../shared/agent/schedule'
import Icon from '../Icon'
import InlineError from '../kit/InlineError'
import { pickRows } from './JobSchedules'
import type { JobActivityService, OwnerForm, ScheduleForm } from './JobActivityService'

/** The jobs a form is for, by name: the first few, then how many more. */
function jobNames(jobs: readonly { readonly name: string }[]): string {
  const shown = jobs.slice(0, 4).map(job => job.name).join(', ')
  return jobs.length > 4 ? `${shown} and ${jobs.length - 4} more` : shown
}

interface FrameProps {
  readonly id: string
  readonly service: JobActivityService
  readonly form: OwnerForm | ScheduleForm
  readonly title: string
  readonly submit: string
  readonly children: ReactNode
}

/** What both forms share: the title and jobs, the read's state, the value's controls, and Change or Attach with Cancel. Escape cancels. */
function FormFrame({ id, service, form, title, submit, children }: FrameProps) {
  const why = service.formUnavailable(id)
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    service.closeForm(id)
  }
  return <section className="agent-bulk agent-bulk-form" aria-label={title} data-bulk-form={form.verb} onKeyDown={keyDown}>
    <div className="agent-bulk-head">
      <strong>{title}</strong>
      <span title={form.jobs.map(job => job.name).join('\n')}>{jobNames(form.jobs)}</span>
    </div>
    <div className="agent-bulk-form-body">
      {form.state === 'loading' ? <p role="status" className="field-note">Reading…</p>
        : form.state === 'failed' ? <InlineError role="status" message={form.error ?? agentBulkText.readFailed} actions={[{ label: 'Retry', run: () => void service.openForm(id, form.verb) }]} />
        : children}
      <p className="agent-bulk-form-buttons">
        <button type="button" className="primary" disabled={!!why} title={why} onClick={() => void service.submitForm(id)}>{submit}</button>
        <button type="button" onClick={() => service.closeForm(id)}>Cancel</button>
      </p>
    </div>
  </section>
}

function OwnerFields({ id, service, form }: { readonly id: string; readonly service: JobActivityService; readonly form: OwnerForm }) {
  const inputId = useId()
  const denied = form.sysadmin === false
  return <>
    <label htmlFor={inputId}>New owner</label>
    <input id={inputId} className="property-input" type="text" list={`${inputId}-logins`} maxLength={agentLimits.nameChars} spellCheck={false} autoFocus value={form.owner} disabled={denied}
      onChange={event => service.setFormOwner(id, event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void service.submitForm(id) } }} />
    {form.owners && <datalist id={`${inputId}-logins`}>{form.owners.map(login => <option key={login} value={login} />)}</datalist>}
    <p className="field-note">{denied ? <><Icon name="lock" />{agentBulkText.ownerSysadmin}</> : agentBulkText.ownerHint}</p>
  </>
}

function ScheduleFields({ id, service, form }: { readonly id: string; readonly service: JobActivityService; readonly form: ScheduleForm }) {
  const searchId = useId()
  const model = form.model
  if (!model) return null
  const usable = model.schedules.filter(item => item.version !== undefined && !!item.modified)
  const matches = form.search.trim() ? usable.filter(item => scheduleMatches(item, form.search)) : usable
  const picked = form.picked === undefined ? undefined : model.schedules.find(item => item.id === form.picked)
  const now = momentOfText(model.now)
  const runs = picked && now ? nextRuns(picked, now, 5) : []
  return <div className="agent-schedules agent-bulk-schedules">
    <div className="agent-schedule-list">
      <input id={searchId} className="property-input" type="search" placeholder="Search shared schedules" aria-label="Search shared schedules" maxLength={agentLimits.nameChars} autoFocus
        value={form.search} onChange={event => service.setFormSearch(id, event.target.value)} />
      {matches.length ? <ul aria-label="Shared schedules">
        {matches.slice(0, pickRows).map(item => <li key={item.id}>
          <button type="button" className="agent-schedule-item" aria-current={form.picked === item.id || undefined} onClick={() => service.pickFormSchedule(id, item.id)}>
            <Icon name="agent-schedule" />
            <span className="agent-schedule-item-text">
              <span className="agent-schedule-item-name">{item.name}{item.freqType === freq.idle && model.idleDefined === false && <span className="agent-schedule-tag"> · never runs</span>}</span>
              <span className="field-note">{scheduleWhen(item)}{item.enabled ? '' : ' · disabled'} · {item.jobCount} {item.jobCount === 1 ? 'job' : 'jobs'}</span>
            </span>
          </button>
        </li>)}
      </ul> : <p className="field-note">{form.search.trim() ? 'No shared schedule matches.' : 'This login sees no shared schedule.'}</p>}
      {matches.length > pickRows && <p className="field-note">{`Showing ${pickRows} of ${matches.length}: search to narrow them.`}</p>}
    </div>
    <div className="agent-schedule-detail">
      {picked ? <div className="agent-schedule-preview" role="region" aria-label={`Shared schedule ${picked.name}`}>
        <h3>{picked.name}<span className="field-note"> · {picked.enabled ? 'Enabled' : 'Disabled'}</span></h3>
        <p className="agent-schedule-sentence"><strong>{scheduleSentence(picked)}</strong>{picked.owner ? ` Owner: ${picked.owner}.` : ''}</p>
        <section aria-label="Next 5 runs">
          <h4>Next 5 runs <span className="field-note">server time</span></h4>
          {runs.length ? <ol className="agent-schedule-runs">{runs.map(run => <li key={`${run.date}-${run.time}`}>{formatRun(run)}</li>)}</ol>
            : <p className="field-note">{now ? noRunsReason(picked, now) : 'The server time was not read.'}</p>}
        </section>
        <p className="field-note">{picked.jobCount} {picked.jobCount === 1 ? 'job uses' : 'jobs use'} it now.</p>
      </div> : <p className="field-note">{agentBulkText.scheduleNone}</p>}
      <p className="field-note">{agentBulkText.scheduleHint}{model.sysadmin ? '' : ` ${agentBulkText.ownJobsOnly}`}</p>
    </div>
  </div>
}

/** The open form of a Job Activity Monitor document, if any. */
export default function JobBulkForm({ id, service, form }: { readonly id: string; readonly service: JobActivityService; readonly form: OwnerForm | ScheduleForm | undefined }) {
  if (!form) return null
  if (form.verb === 'changeOwner') {
    return <FormFrame id={id} service={service} form={form} title={agentBulkText.ownerTitle(form.jobs.length)} submit="Change owner">
      <OwnerFields id={id} service={service} form={form} />
    </FormFrame>
  }
  return <FormFrame id={id} service={service} form={form} title={agentBulkText.scheduleTitle(form.jobs.length)} submit={agentBulkTitles.attachSchedule.line}>
    <ScheduleFields id={id} service={service} form={form} />
  </FormFrame>
}
