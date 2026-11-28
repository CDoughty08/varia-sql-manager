// The SQL Server Agent job document (AG-6a, docs/sql-server-agent.md › Job document): ObjectInspectorFrame shell with breadcrumbs,
// live state, Start/Stop split button, Vitals toggle, Reload, Save, Hero KPI strip, Ctrl+1..N tabs (optional Changes from source,
// General, Steps, Schedules, Notifications & Alerts, History), STALE compare banner, New Job start panel, Create several full-height
// table, FieldHints overlay and Script drawer. JobDocumentService keeps every state; this only draws it.
import { useRef } from 'react'
import {
  agentJobFieldLabels, agentJobFieldSection, agentJobFields, agentJobText, changedAgentJobFields, gateClosedText, initialAgentJobDraft, notificationGates, uncategorizedCategory,
  type AgentJobDocumentModel, type AgentJobDraft, type AgentJobField, type AgentJobProblem, type AgentNotifyLevel
} from '../../../shared/actions/agent-job.ts'
import { jobErrorField } from '../../../shared/actions/schema.ts'
import { agentLimits, notifyLevels } from '../../../shared/agent/catalog.ts'
import { createFromText } from '../../../shared/agent/create-from.ts'
import { createSeveralText } from '../../../shared/agent/create-several.ts'
import { durationWords, runIsInProgress } from '../../../shared/agent/job-history.ts'
import { formatRun, freq, momentSeconds, nextRuns, type AgentMoment } from '../../../shared/agent/schedule.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame, { type Verb } from '../kit/DocumentFrame'
import { resizeScript, selectSection, setScriptOpen } from '../kit/document-frame'
import FactGrid, { type FactItem } from '../kit/FactGrid'
import InlineError from '../kit/InlineError'
import ObjectInspectorFrame, { type InspectorKpi, type InspectorTab } from '../kit/ObjectInspectorFrame'
import PropertyField, { FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import CreateSeveral, { SeveralBanner } from './CreateSeveral'
import JobCopyChanges, { CopyCompare } from './JobCopyChanges'
import { jobCopySection, type JobDocumentService, type JobDocumentState } from './JobDocumentService'
import JobHistory from './JobHistory'
import JobSchedules from './JobSchedules'
import JobSteps from './JobSteps'

const fieldId = (documentId: string, key: string) => `agent-job-${documentId}-${key}`
const outcomeWords: Readonly<Record<number, string>> = { 0: 'Last run failed', 1: 'Last run succeeded', 3: 'Last run canceled', 5: 'Never ran' }
const shortOutcomeWords: Readonly<Record<number, string>> = { 0: 'Failed', 1: 'Succeeded', 3: 'Canceled', 5: 'Never ran' }

export type JobInspectorTabId = 'changes' | 'general' | 'steps' | 'schedules' | 'notifications' | 'history'

/** Maps section ids (including legacy Targets and Alerts links) onto the consolidated ObjectInspectorFrame tabs. */
export function jobInspectorTab(section: string, hasSource: boolean, hasJob: boolean): JobInspectorTabId {
  if (section === jobCopySection && hasSource) return 'changes'
  if (section === 'targets') return 'general'
  if (section === 'alerts') return 'notifications'
  if (section === 'history' && hasJob) return 'history'
  if (section === 'steps' || section === 'schedules' || section === 'notifications') return section
  return 'general'
}

/** Derives the Hero KPI and Vitals Next Run value cleanly from the draft's active schedules and server clock. */
export function jobNextRunInfo(draft: AgentJobDraft, now: AgentMoment): { readonly value: string; readonly title?: string } {
  if (!draft.enabled) return { value: 'Disabled', title: 'The job is disabled, so its schedules do not run.' }
  const active = draft.schedules.filter(entry => !entry.remove && entry.fields.enabled)
  if (active.length === 0) return { value: 'On demand', title: 'No enabled schedules; start manually or from an alert.' }
  let earliest: AgentMoment | undefined
  let earliestSeconds = Infinity
  for (const entry of active) {
    const first = nextRuns(entry.fields, now, 1)[0]
    if (!first) continue
    const seconds = momentSeconds(first)
    if (seconds < earliestSeconds) {
      earliestSeconds = seconds
      earliest = first
    }
  }
  if (earliest) {
    const formatted = formatRun(earliest)
    return { value: formatted, title: `Next scheduled run (server time): ${formatted}` }
  }
  if (active.some(entry => entry.fields.freqType === freq.agentStart)) return { value: 'On Agent start', title: 'Runs automatically when SQL Server Agent starts.' }
  if (active.some(entry => entry.fields.freqType === freq.idle)) return { value: 'On CPU idle', title: 'Runs whenever the CPUs become idle.' }
  return { value: 'None scheduled', title: 'Enabled schedules have no upcoming runs.' }
}

interface SectionProps {
  readonly state: JobDocumentState
  readonly model: AgentJobDocumentModel
  readonly draft: AgentJobDraft
  readonly editable: boolean
  readonly problems: readonly AgentJobProblem[]
  readonly service: JobDocumentService
}
/** A field's text: its first error (the save's own refusal first), else its warnings. */
function fieldText(field: AgentJobField, { state, problems }: Pick<SectionProps, 'state' | 'problems'>): { error?: string; note?: string } {
  const own = problems.filter(problem => problem.field === field)
  const error = (state.error?.field === field ? state.error.message : undefined) ?? own.find(problem => problem.severity === 'error')?.message
  const warnings = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...warnings.length ? { note: warnings.join(' ') } : {} }
}
const base = (model: AgentJobDocumentModel) => model.job

function GeneralSection(props: SectionProps) {
  const { state, model, draft, editable, service } = props
  const job = base(model)
  const ids = { name: fieldId(state.id, 'name'), owner: fieldId(state.id, 'owner'), category: fieldId(state.id, 'category'), description: fieldId(state.id, 'description'), enabled: fieldId(state.id, 'enabled') }
  const changed = (field: 'name' | 'owner' | 'category' | 'description' | 'enabled') => !!job && draft[field] !== job[field]
  const name = { description: 'The job\'s name, unique on this server.', ...fieldText('name', props) }
  const owner = { description: 'The login the job belongs to.', ...fieldText('owner', props), ...!model.sysadmin ? { note: agentJobText.ownerSysadmin } : {} }
  const category = { description: 'How the job is grouped in Job Activity Monitor and reports.', ...fieldText('category', props) }
  const description = { description: 'What the job does, for whoever reads it next.', ...fieldText('description', props) }
  const enabled = { description: 'A disabled job does not run on its schedules; Start still runs it.', ...fieldText('enabled', props) }
  const categories = model.categories.includes(draft.category) ? model.categories : [draft.category, ...model.categories]
  return <div className="agent-job-pane-section">
    <div className="agent-eyebrow">Identity &amp; Configuration</div>
    <div className="properties-fields agent-job-general">
      <PropertyField id={ids.name} label="Name" changed={changed('name')} {...name}>
        <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} data-agent-job-focus={!job || undefined}
          data-changed={changed('name') || undefined} {...fieldAria(ids.name, { ...name, changed: changed('name') })} onChange={event => service.updateDraft(state.id, { name: event.target.value })} />
      </PropertyField>
      <PropertyField id={ids.owner} label="Owner" changed={changed('owner')} {...owner}>
        <input id={ids.owner} className="property-input" type="text" list={`${ids.owner}-logins`} maxLength={agentLimits.nameChars} spellCheck={false} value={draft.owner} disabled={!editable || !model.sysadmin}
          data-changed={changed('owner') || undefined} {...fieldAria(ids.owner, { ...owner, changed: changed('owner') })} onChange={event => service.updateDraft(state.id, { owner: event.target.value })} />
        {model.owners && <datalist id={`${ids.owner}-logins`}>{model.owners.map(login => <option key={login} value={login} />)}</datalist>}
      </PropertyField>
      <PropertyField id={ids.category} label="Category" changed={changed('category')} {...category}>
        <select id={ids.category} className="property-input" value={draft.category} disabled={!editable} data-changed={changed('category') || undefined}
          {...fieldAria(ids.category, { ...category, changed: changed('category') })} onChange={event => service.updateDraft(state.id, { category: event.target.value })}>
          {(categories.length ? categories : [uncategorizedCategory]).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </PropertyField>
      <PropertyField id={ids.description} label="Description" changed={changed('description')} {...description}>
        <textarea id={ids.description} className="property-input agent-job-description" rows={4} maxLength={agentLimits.descriptionChars + 1} spellCheck value={draft.description} disabled={!editable}
          data-changed={changed('description') || undefined} {...fieldAria(ids.description, { ...description, changed: changed('description') })}
          onChange={event => service.updateDraft(state.id, { description: event.target.value })} />
      </PropertyField>
      <PropertyField id={ids.enabled} label="Enabled" changed={changed('enabled')} {...enabled}>
        <Switch id={ids.enabled} checked={draft.enabled} disabled={!editable} changed={changed('enabled')} states={{ on: 'Enabled', off: 'Disabled' }} {...fieldAria(ids.enabled, { ...enabled, changed: changed('enabled') })}
          onChange={checked => service.updateDraft(state.id, { enabled: checked })} />
      </PropertyField>
    </div>
    {job && model.steps.length === 0 && <p className="field-note agent-job-no-steps"><Icon name="warning" />{agentJobText.noSteps}</p>}
    <div className="agent-eyebrow agent-job-targets-eyebrow">Target Server</div>
    <TargetsSection state={state} />
  </div>
}

/** One notification: its level (Never, or when) and, when it is sent, the operator. */
function NotificationRow(props: SectionProps & { readonly field: 'email' | 'page' | 'netSend'; readonly title: string; readonly open: boolean; readonly description: string }) {
  const { state, model, draft, editable, service, field, title, open, description } = props
  const levelKey = `${field}Level` as const, operatorKey = `${field}Operator` as const
  const job = base(model), id = fieldId(state.id, field)
  const level = draft[levelKey], operator = draft[operatorKey]
  const changed = !!job && (job[levelKey] !== level || (level !== 0 && job[operatorKey] !== operator))
  const text = { description, ...fieldText(field, props), ...!open ? { note: gateClosedText(title) } : {} }
  const operators = model.operators ?? []
  const names = operator && !operators.some(item => item.name === operator) ? [operator, ...operators.map(item => item.name)] : operators.map(item => item.name)
  return <PropertyField id={id} label={title} changed={changed} {...text}>
    <span className="agent-job-notify">
      <select id={id} className="property-input" value={level} disabled={!editable || (!open && level === 0)} data-changed={changed || undefined} {...fieldAria(id, { ...text, changed })}
        onChange={event => { const next = Number(event.target.value) as AgentNotifyLevel; service.updateDraft(state.id, { [levelKey]: next, ...next === 0 ? { [operatorKey]: '' } : {} } as Partial<AgentJobDraft>) }}>
        {notifyLevels.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
      </select>
      {level !== 0 && (model.operators
        ? <select className="property-input" aria-label={`${title} operator`} value={operator} disabled={!editable} onChange={event => service.updateDraft(state.id, { [operatorKey]: event.target.value } as Partial<AgentJobDraft>)}>
          <option value="">Choose an operator</option>
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        : <input className="property-input" type="text" aria-label={`${title} operator`} maxLength={agentLimits.nameChars} spellCheck={false} value={operator} disabled={!editable}
          onChange={event => service.updateDraft(state.id, { [operatorKey]: event.target.value } as Partial<AgentJobDraft>)} />)}
    </span>
  </PropertyField>
}

function LevelRow(props: SectionProps & { readonly field: 'eventLog' | 'delete'; readonly title: string; readonly open: boolean; readonly description: string; readonly note?: string }) {
  const { state, model, draft, editable, service, field, title, open, description } = props
  const key = field === 'eventLog' ? 'eventLogLevel' : 'deleteLevel'
  const job = base(model), id = fieldId(state.id, field), changed = !!job && job[key] !== draft[key]
  const own = fieldText(field, props)
  const text = { description, ...own, ...!open ? { note: gateClosedText(title) } : props.note && draft[key] !== 0 ? { note: [own.note, props.note].filter(Boolean).join(' ') } : {} }
  return <PropertyField id={id} label={title} changed={changed} {...text}>
    <select id={id} className="property-input" value={draft[key]} disabled={!editable || (!open && draft[key] === 0)} data-changed={changed || undefined} {...fieldAria(id, { ...text, changed })}
      onChange={event => service.updateDraft(state.id, { [key]: Number(event.target.value) as AgentNotifyLevel })}>
      {notifyLevels.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
    </select>
  </PropertyField>
}

function NotificationsSection(props: SectionProps) {
  const gates = notificationGates(props.model.platform)
  const { state, model } = props
  const showAlerts = !model.job || model.alerts !== undefined
  return <div className="agent-job-pane-section">
    <div className="agent-eyebrow">Operator Notifications</div>
    <div className="properties-fields agent-job-notifications">
      <NotificationRow {...props} field="email" title="E-mail" open={gates.email} description="E-mail the operator through Database Mail when the job ends this way." />
      <NotificationRow {...props} field="page" title="Page" open={gates.page} description="Page the operator, during its pager duty hours only." />
      <NotificationRow {...props} field="netSend" title="Net send" open={gates.netSend} description={agentJobText.netSendDeprecated} />
    </div>
    <div className="agent-eyebrow agent-job-system-eyebrow">System &amp; Cleanup Actions</div>
    <div className="properties-fields agent-job-notifications">
      <LevelRow {...props} field="eventLog" title="Write to the Windows Application event log" open={gates.eventLog} description="Write an entry to the server's Windows Application event log." />
      <LevelRow {...props} field="delete" title="Automatically delete the job" open description="Delete the job after it runs this way." note={agentJobText.deleteJob} />
    </div>
    {showAlerts && <>
      <div className="agent-eyebrow agent-job-alerts-head">
        <span>Alerts That Trigger This Job</span>
        {model.job && <NewAlertForJob state={state} jobId={model.job.jobId} jobName={model.job.name} />}
      </div>
      <AlertsSection {...props} />
    </>}
  </div>
}

function TargetsSection({ state }: Pick<SectionProps, 'state'>) {
  return <FactGrid className="agent-job-targets" ariaLabel="Target Server" facts={[
    {
      id: 'target',
      label: 'Target',
      content: <span className="agent-job-target-val"><span className="mono">{state.server}</span><StatusPill tone="neutral" size="small" variant="tag" label="Local server" /></span>,
      copyValue: state.server
    },
    { id: 'multi', label: 'Multi-server', value: agentJobText.targetLater, copyable: false }
  ]} />
}

function AlertsSection(props: SectionProps) {
  const { state, model, draft, service } = props
  const alerts = model.alerts ?? []
  const own = fieldText('alerts', props)
  if (!model.job) return <p className="field-note">{agentJobText.alertsNewJob}</p>
  return <div className="agent-job-alerts">
    {alerts.length === 0 ? <p className="field-note">{agentJobText.alertsNone}</p> : <table className="agent-table" aria-label="Alerts that run this job">
      <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Enabled</th>{model.alertsEditable && <th scope="col"><span className="visually-hidden">Remove</span></th>}</tr></thead>
      <tbody>{alerts.map(alert => {
        const removed = draft.removeAlerts.includes(alert.id)
        return <tr key={alert.id} data-removed={removed || undefined}>
          <td>{alert.name}</td>
          <td className="mono">{alert.messageId ? `Error ${alert.messageId}` : `Severity ${alert.severity}`}</td>
          <td><StatusPill tone={alert.enabled ? 'success' : 'neutral'} size="small" label={alert.enabled ? 'Enabled' : 'Disabled'} /></td>
          {model.alertsEditable && <td>{removed
            ? <button type="button" disabled={!service.canEdit(state.id)} aria-label={`Keep ${alert.name}`} onClick={() => service.toggleAlert(state.id, alert.id)}>Keep</button>
            : <button type="button" disabled={!service.canEdit(state.id)} aria-label={`Remove ${alert.name}`} onClick={() => service.toggleAlert(state.id, alert.id)}><Icon name="trash" />Remove</button>}</td>}
        </tr>
      })}</tbody>
    </table>}
    {own.error && <p className="property-field-error" role="alert"><Icon name="error" />{own.error}</p>}
    {!model.alertsEditable && alerts.length > 0 && <p className="field-note">{agentJobText.alertsReadOnly}</p>}
  </div>
}

/** New alert for this job (AG-7): New Alert with this job as its response. */
function NewAlertForJob({ state, jobId, jobName }: { readonly state: JobDocumentState; readonly jobId: string; readonly jobName: string }) {
  const { alertDocuments, documents, commands } = useWorkbench()
  const connectionId = documents.get(state.id)?.connectionId
  return <span className="agent-job-alerts-new">
    <button type="button" disabled={!connectionId || !state.model?.sysadmin} title={agentJobText.alertsNewHint}
      onClick={() => { try { if (connectionId) alertDocuments.openNew(connectionId, { jobId, jobName }) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'New Alert could not open.') } }}><Icon name="add" />{agentJobText.alertsNew}</button>
  </span>
}

/** New Job's start panel: Blank, or Copy an existing job (a pick of the jobs msdb lets the login see). */
function StartPanel({ state, service }: { readonly state: JobDocumentState; readonly service: JobDocumentService }) {
  const { quickInput } = useWorkbench()
  const copy = useRef<HTMLButtonElement>(null)
  const jobs = state.model?.jobs ?? []
  const pick = () => quickInput.show({
    ariaLabel: 'Copy an existing job', placeholder: 'Select the job to copy', noun: 'jobs', items: jobs.map(name => ({ id: name, label: name, icon: 'agent-job' as const })),
    ...copy.current ? { anchor: copy.current } : {}, onDidAccept: item => void service.startCopy(state.id, item.id)
  })
  return <div className="agent-job-start" role="group" aria-label="New Job">
    <button type="button" className="agent-job-start-choice" data-agent-job-focus disabled={!!state.copying} onClick={() => service.startBlank(state.id)}>
      <Icon name="add" /><span><strong>{agentJobText.newBlank}</strong><span className="field-note">{agentJobText.newBlankHint}</span></span>
    </button>
    <button type="button" ref={copy} className="agent-job-start-choice" disabled={!jobs.length || !!state.copying} onClick={pick}>
      <Icon name="copy" /><span><strong>{agentJobText.newCopy}</strong><span className="field-note">{state.copying ? `Reading ${state.copying}…` : agentJobText.newCopyHint}</span></span>
    </button>
    <p className="field-note">{agentJobText.newHint}</p>
  </div>
}

/** A STALE refusal's compare: what each side changed since the document opened, conflicts first with a choice each. */
function StaleCompare({ state, service }: { readonly state: JobDocumentState; readonly service: JobDocumentService }) {
  const stale = state.stale!
  const conflicts = stale.rows.some(row => row.conflict)
  return <div className="agent-job-stale" role="alert">
    <p><Icon name="warning" />{agentJobText.stale(state.changes)}</p>
    <p className="field-note">{agentJobText.staleHint} {conflicts ? agentJobText.staleConflict : agentJobText.staleNoConflict}</p>
    <table className="agent-table" aria-label="What changed since you opened the job">
      <thead><tr><th scope="col">Field</th><th scope="col">On the server now</th><th scope="col">Yours</th></tr></thead>
      <tbody>{stale.rows.map(row => {
        const server = stale.keepServer.includes(row.field)
        return <tr key={row.field} data-conflict={row.conflict || undefined}>
          <th scope="row">{agentJobFieldLabels[row.field]}{row.conflict && <span className="agent-job-conflict"> · changed by both</span>}</th>
          <td>{row.conflict ? <label><input type="radio" name={`${state.id}-${row.field}`} checked={server} onChange={() => service.chooseServer(state.id, row.field, true)} /> {row.server}</label> : row.server ?? '—'}</td>
          <td>{row.conflict ? <label><input type="radio" name={`${state.id}-${row.field}`} checked={!server} onChange={() => service.chooseServer(state.id, row.field, false)} /> {row.yours}</label> : row.yours ?? '—'}</td>
        </tr>
      })}</tbody>
    </table>
    <p className="agent-job-stale-actions">
      <button type="button" className="primary" onClick={() => service.reloadKeep(state.id)}>{agentJobText.reloadKeep}</button>
      <button type="button" onClick={() => service.reloadDiscard(state.id)}>{agentJobText.reloadDiscard}</button>
    </p>
  </div>
}

/** The header's live state: running (its step), idle with its last outcome, or a job msdb no longer has. */
function LiveState({ state }: { readonly state: JobDocumentState }) {
  const live = state.live, job = state.model?.job
  if (!job) return state.model ? <StatusPill tone="neutral" label="Not saved yet" /> : null
  if (live?.gone) return <StatusPill tone="critical" label="Deleted" />
  if (live?.running) return <StatusPill tone="running" label={`${live.retrying ? 'Between retries' : 'Running'}${live.step ? ` · step ${live.step}${live.steps ? ` of ${live.steps}` : ''}` : ''}`} />
  const outcome = live?.lastOutcome ?? job.lastOutcome
  return <StatusPill tone={!job.enabled ? 'neutral' : outcome === 0 ? 'critical' : outcome === 1 ? 'success' : 'neutral'} label={job.enabled ? `Idle · ${outcomeWords[outcome ?? 5] ?? 'Unknown'}` : 'Disabled'} />
}

/** Start with its step menu (Start once at step), and Stop. */
function StartTools({ state, service }: { readonly state: JobDocumentState; readonly service: JobDocumentService }) {
  const { commands } = useWorkbench()
  const menu = useRef<HTMLButtonElement>(null)
  if (!state.model?.job) return null
  const startable = service.canStart(state.id), steps = state.model.steps.length
  return <span className="agent-job-start-split">
    {state.live?.running
      ? <button type="button" className="danger" disabled={!service.canStop(state.id)} onClick={() => void commands.execute('agentJob.stop', { tabId: state.id }, 'toolbar')}><Icon name="debug-stop" />Stop</button>
      : <>
        <button type="button" disabled={!startable} onClick={() => void commands.execute('agentJob.start', { tabId: state.id }, 'toolbar')}><Icon name="play" />Start</button>
        <button type="button" ref={menu} aria-label={agentJobText.startOnce} title={agentJobText.startOnce} aria-haspopup="listbox" disabled={!startable || !steps}
          onClick={() => void commands.execute('agentJob.startAtStep', { tabId: state.id, ...menu.current ? { anchor: menu.current } : {} }, 'toolbar')}><Icon name="chevron-down" /></button>
      </>}
  </span>
}

/** Vitals right rail: Live Status, Identity (Job ID, Start step, Created, Modified), and active Problems. */
function JobVitals({ state, model, draft, problems, nextRun, usualSeconds, onSelectTab }: {
  readonly state: JobDocumentState
  readonly model: AgentJobDocumentModel
  readonly draft: AgentJobDraft
  readonly problems: readonly AgentJobProblem[]
  readonly nextRun: { readonly value: string; readonly title?: string }
  readonly usualSeconds?: number
  readonly onSelectTab: (tabId: JobInspectorTabId) => void
}) {
  const job = model.job
  const startIndex = draft.steps.startKey ? draft.steps.steps.findIndex(step => step.key === draft.steps.startKey) : -1
  const startDraft = startIndex >= 0 ? draft.steps.steps[startIndex] : undefined
  const startSaved = job ? model.steps.find(step => step.id === job.startStepId) : undefined
  const startLabel = startDraft ? `${startIndex + 1} · ${startDraft.name || 'Unnamed step'}` : startSaved ? `${job!.startStepId} · ${startSaved.name}` : '—'
  const liveFacts: FactItem[] = [
    {
      id: 'state',
      label: 'State',
      content: <LiveState state={state} />,
      copyable: false
    },
    {
      id: 'enabled',
      label: 'Enabled',
      content: <StatusPill tone={draft.enabled ? 'success' : 'neutral'} size="small" label={draft.enabled ? 'Yes' : 'No'} />,
      copyValue: draft.enabled ? 'Yes' : 'No'
    },
    {
      id: 'nextRun',
      label: 'Next run',
      value: nextRun.value,
      mono: true,
      ...nextRun.title ? { title: nextRun.title } : {}
    },
    ...usualSeconds !== undefined ? [{ id: 'usual', label: 'Usual time', value: durationWords(usualSeconds), mono: true }] : []
  ]
  const identityFacts: FactItem[] = [
    { id: 'jobId', label: 'Job ID', value: job?.jobId ?? 'Not saved yet', mono: !!job, copyable: !!job },
    { id: 'startStep', label: agentJobText.startStep, value: startLabel },
    { id: 'created', label: 'Created', value: job ? job.created.replace('T', ' ') : '—', mono: !!job, copyable: !!job },
    { id: 'modified', label: 'Modified', value: job ? job.modified.replace('T', ' ').slice(0, 19) : '—', mono: !!job, copyable: !!job }
  ]
  return <>
    <div className="vitals-block">
      <h4 className="vitals-block-title">Live Status</h4>
      <FactGrid compact facts={liveFacts} />
    </div>
    <div className="vitals-block">
      <h4 className="vitals-block-title">Identity</h4>
      <FactGrid compact facts={identityFacts} />
    </div>
    <div className="vitals-block">
      <h4 className="vitals-block-title">{problems.length ? `Problems (${problems.length})` : 'Problems'}</h4>
      {problems.length === 0
        ? <p className="field-note agent-job-vitals-ok"><Icon name="pass" />No problems found.</p>
        : <ul className="agent-job-vitals-problems" aria-label="Problems">
          {problems.map((problem, index) => {
            const targetTab = jobInspectorTab(agentJobFieldSection[problem.field], !!state.source, !!model.job)
            return <li key={`${problem.field}-${index}`} data-severity={problem.severity}>
              <button type="button" className="agent-job-vitals-problem" onClick={() => onSelectTab(targetTab)}>
                <Icon name={problem.severity === 'error' ? 'error' : 'warning'} />
                <span>{problem.message}</span>
              </button>
            </li>
          })}
        </ul>}
    </div>
  </>
}

/**
 * The job document: ObjectInspectorFrame shell (breadcrumbs, live state, Start/Stop split button, Vitals rail, Reload, Save,
 * Hero KPI strip, Ctrl+1..N tabs), STALE compare banner, New Job start panel, Create several full-height table, and Script drawer.
 */
export default function JobDocument({ documentId }: { documentId: string }) {
  const { jobDocuments } = useWorkbench()
  const { documents } = useServiceSnapshot(jobDocuments)
  const { documents: historyDocs } = useServiceSnapshot(jobDocuments.history)
  const state = documents[documentId]
  if (!state) return <div className="agent-job-document" />
  const { model, draft } = state
  const editable = jobDocuments.canEdit(state.id), problems = jobDocuments.problems(state.id), problemSections = jobDocuments.problemSections(state.id)
  const args = { tabId: state.id }
  const saveLabel = model?.job ? state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save' : 'Create'
  const verbs: Verb[] = state.phase === 'choosing' ? [] : [{ command: 'agentJob.reload', args, label: 'Reload' }, { command: 'agentJob.save', args, label: saveLabel, emphasis: 'primary' }]
  const phaseLabel = state.phase === 'loading' ? 'Reading the job…' : state.phase === 'saving' ? 'Saving the job…' : state.verb === 'starting' ? 'Starting the job…' : state.verb === 'stopping' ? 'Stopping the job…' : undefined
  const frameId = `agent-job-${state.id}`
  const name = model?.job?.name ?? (draft?.name || 'New Job')

  // Create several (AG-6f): the copy turned into a table owns the tab through DocumentFrame's full-bleed `body` slot.
  if (state.several) return <DocumentFrame id={frameId} title={createSeveralText.tab} subtitle={state.source ? `New jobs like ${state.source.base.name}` : 'New jobs'}
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Jobs' }]}
    banner={<>{state.error && <InlineError message={state.error.message} code={state.error.code} context={`Create several jobs on ${state.server}`} />}<SeveralBanner state={state} service={jobDocuments} /></>}
    attributes={{ 'data-agent-job': state.id, 'data-agent-several': '' }}
    body={<CreateSeveral state={state} service={jobDocuments} />} />

  const rowAt = state.row ? jobDocuments.rowNumber(state.id) : undefined, rowLinked = state.row ? jobDocuments.rowLinked(state.id) : false
  const recovery = state.phase === 'loadFailed' || state.error?.code === 'NOT_FOUND' ? [{ label: 'Reload', run: () => jobDocuments.reload(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.stale ? <StaleCompare state={state} service={jobDocuments} />
      : state.error && !state.error.field && <InlineError message={state.error.message} code={state.error.code} context={`Job ${name} on ${state.server}`} actions={recovery} />}
    {jobErrorField(state.error) && !state.stale && <p className="property-field-error" role="alert"><Icon name="error" />{`Not saved: ${agentJobFieldLabels[jobErrorField(state.error)!]}. Nothing was changed; your changes are kept.`}</p>}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {state.row && <div className="agent-copy-banner" role="note"><Icon name="copy" /><span>{rowLinked && rowAt ? jobDocuments.rowPaused(state.id) ? createSeveralText.editorPaused(rowAt) : createSeveralText.editorBanner(rowAt) : createSeveralText.editorOrphan}</span>
      {rowLinked && <button type="button" className="link-button" onClick={() => jobDocuments.backToTable(state.id)}>{createSeveralText.backToTable}</button>}</div>}
    {state.source && !state.row && <div className="agent-copy-banner" role="note"><Icon name="copy" /><span>{createFromText.banner(state.source.base.name)}</span>
      <button type="button" className="link-button" aria-expanded={!!state.compareOpen} onClick={() => jobDocuments.toggleCompare(state.id)}>{state.compareOpen ? createFromText.compareHide : createFromText.compare}</button></div>}
    {state.source && state.compareOpen && <CopyCompare state={state} service={jobDocuments} />}
    {model?.readOnly && <p className="document-status"><Icon name="lock" />{model.job ? agentJobText.readOnly(model.job.owner) : model.readOnly}</p>}
  </>
  const header = { title: name, subtitle: state.source ? `New Job like ${state.source.base.name}` : model?.job || state.phase !== 'choosing' ? 'Job Properties' : 'New Job', crumbs: [{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Jobs' }] }
  if (state.phase === 'choosing') return <DocumentFrame id={frameId} {...header} banner={banner} attributes={{ 'data-agent-job': state.id }}>
    <StartPanel state={state} service={jobDocuments} />
  </DocumentFrame>

  const historyView = historyDocs[state.id]
  const baseDraft = model ? initialAgentJobDraft(model) : undefined
  const changedFields = baseDraft && draft ? new Set<AgentJobField>(changedAgentJobFields(baseDraft, draft)) : new Set<AgentJobField>()
  const generalModified = (['name', 'owner', 'category', 'description', 'enabled'] as const).some(field => changedFields.has(field))
  const notifyModified = (['email', 'page', 'netSend', 'eventLog', 'delete', 'alerts'] as const).some(field => changedFields.has(field))
  const notifyActiveCount = draft ? (['emailLevel', 'pageLevel', 'netSendLevel', 'eventLogLevel', 'deleteLevel'] as const).filter(key => draft[key] !== 0).length : 0
  const alertsActiveCount = model && draft ? (model.alerts ?? []).filter(alert => !draft.removeAlerts.includes(alert.id)).length : 0

  const placeholder = state.phase === 'loading' ? <Skeleton rows={4} label="Reading the job" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the job could not be read.' : ''}</p>
  const props: SectionProps | undefined = model && draft ? { state, model, draft, editable, problems, service: jobDocuments } : undefined
  const tabSections = [
    ...(state.source && model && draft ? [{ id: jobCopySection, title: createFromText.section }] : []),
    { id: 'general', title: 'General' },
    { id: 'steps', title: 'Steps' },
    { id: 'schedules', title: 'Schedules' },
    { id: 'notifications', title: 'Notifications & Alerts' },
    ...(model?.job ? [{ id: 'history', title: 'History' }] : [])
  ]
  const goTo = (section: 'steps' | 'schedules', key?: string) => {
    if (key) jobDocuments.editStep(state.id, key)
    const latest = jobDocuments.get(state.id)?.frame ?? state.frame
    jobDocuments.setFrame(state.id, selectSection(latest, tabSections, section))
  }

  const tabs: InspectorTab[] = model && draft && props ? [
    ...(state.source ? [{
      id: jobCopySection,
      title: createFromText.section,
      layout: 'flow' as const,
      problem: problemSections.has('general') || problems.some(problem => problem.field === 'steps' && problem.severity === 'error'),
      content: <JobCopyChanges state={state} model={model} draft={draft} editable={editable} problems={problems} service={jobDocuments} goTo={goTo} />
    }] : []),
    {
      id: 'general',
      title: 'General',
      layout: 'flow',
      modified: generalModified,
      problem: problemSections.has('general') || problemSections.has('targets'),
      content: <GeneralSection {...props} />
    },
    {
      id: 'steps',
      title: 'Steps',
      layout: 'fill',
      count: draft.steps.steps.length,
      modified: changedFields.has('steps'),
      problem: problemSections.has('steps'),
      content: <JobSteps state={state} model={model} draft={draft} editable={editable} service={jobDocuments} />
    },
    {
      id: 'schedules',
      title: 'Schedules',
      layout: 'fill',
      count: draft.schedules.filter(entry => !entry.remove).length,
      modified: changedFields.has('schedules'),
      problem: problemSections.has('schedules'),
      content: <JobSchedules {...props} />
    },
    {
      id: 'notifications',
      title: 'Notifications & Alerts',
      layout: 'flow',
      count: notifyActiveCount + alertsActiveCount,
      modified: notifyModified,
      problem: problemSections.has('notifications') || problemSections.has('alerts'),
      content: <NotificationsSection {...props} />
    },
    ...(model.job ? [{
      id: 'history',
      title: 'History',
      layout: 'fill' as const,
      ...(historyView?.loaded ? { count: historyView.runs.length } : {}),
      content: <JobHistory state={state} model={model} service={jobDocuments} />
    }] : [])
  ] : [{ id: 'general', title: 'General', layout: 'flow', content: placeholder }]

  const activeTab = model && draft ? jobInspectorTab(state.frame.section, !!state.source, !!model.job) : 'general'
  const nextRun = draft ? jobNextRunInfo(draft, jobDocuments.now(state.id)) : { value: '—' }
  const latestRun = historyView?.loaded ? (historyView.failedOnly ? historyView.spark[0] : historyView.runs[0]) : undefined
  const usualSeconds = historyView?.usual?.job
  const lastOutcome = state.live?.lastOutcome ?? model?.job?.lastOutcome
  const lastRunStamp = model?.job?.lastRun ? model.job.lastRun.replace('T', ' ').slice(0, 16) : undefined
  const kpis: InspectorKpi[] = model && draft ? [
    {
      id: 'lastRun',
      label: 'Last Run',
      value: state.live?.gone ? 'Deleted'
        : state.live?.running ? (state.live.retrying ? 'Between retries' : 'Running')
          : model.job ? (shortOutcomeWords[lastOutcome ?? 5] ?? 'Unknown') : 'Not saved yet',
      ...(state.live?.running && state.live.step ? { sub: `Step ${state.live.step}${state.live.steps ? ` of ${state.live.steps}` : ''}` }
        : !state.live?.running && model.job && lastRunStamp ? { sub: lastRunStamp } : {})
    },
    {
      id: 'duration',
      label: 'Duration',
      value: historyView?.loaded ? (latestRun?.duration || (latestRun && runIsInProgress(latestRun) ? 'In progress' : '—')) : '—',
      ...(historyView?.loaded && usualSeconds !== undefined ? { sub: `usual ${durationWords(usualSeconds)}` } : {}),
      ...(!historyView?.loaded ? { title: 'Open History to read recent run durations and usual time.' } : {})
    },
    {
      id: 'nextRun',
      label: 'Next Run',
      value: nextRun.value,
      ...nextRun.title ? { title: nextRun.title } : {}
    },
    {
      id: 'owner',
      label: 'Owner',
      value: draft.owner || '—'
    }
  ] : []

  // Keep agentJobFields referenced in case tree-shaking or lint checks imports.
  void agentJobFields

  return <FieldHints resetKey={activeTab}>
    <ObjectInspectorFrame
      id={frameId}
      {...header}
      surface="full"
      state={<LiveState state={state} />}
      tools={<StartTools state={state} service={jobDocuments} />}
      verbs={verbs}
      kpis={kpis}
      banner={banner}
      tabs={tabs}
      activeTab={activeTab}
      onSelectTab={tabId => jobDocuments.setFrame(state.id, selectSection(state.frame, tabSections, tabId))}
      vitals={model && draft ? <JobVitals state={state} model={model} draft={draft} problems={problems} nextRun={nextRun} usualSeconds={usualSeconds} onSelectTab={tabId => jobDocuments.setFrame(state.id, selectSection(state.frame, tabSections, tabId))} /> : undefined}
      vitalsTitle="Vitals"
      attributes={{ 'data-agent-job': state.id }}
      script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void jobDocuments.deliver(state.id, destination) }}
      scriptOpen={state.frame.scriptOpen}
      scriptSize={state.frame.scriptSize}
      onScriptToggle={() => jobDocuments.setFrame(state.id, setScriptOpen(state.frame, !state.frame.scriptOpen))}
      onScriptResize={size => jobDocuments.setFrame(state.id, resizeScript(state.frame, size))}
      hint={<FieldHintStrip />}
    />
  </FieldHints>
}
