// The SQL Server Agent operator document (AG-7, docs/sql-server-agent.md › Operators): General (name, addresses, Send test e-mail), Pager
// duty, and the alerts that notify it. AlertOperatorDocumentService keeps every state; this only draws it.
import { agentAlertText, notifyEmail, notifyPager } from '../../../shared/actions/agent-alert.ts'
import type { AgentDutyHours } from '../../../shared/actions/agent-job.ts'
import { agentOperatorText, type AgentOperatorDocumentModel, type AgentOperatorDraft, type AgentOperatorField, type AgentOperatorProblem } from '../../../shared/actions/agent-operator.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PropertyField, { FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import { operatorSections, type AgentObjectState, type OperatorDocumentService } from './AlertOperatorDocumentService'
import { methodChoices } from './AlertDocument'

type State = AgentObjectState<AgentOperatorDocumentModel, AgentOperatorDraft>
interface Props {
  readonly state: State
  readonly model: AgentOperatorDocumentModel
  readonly draft: AgentOperatorDraft
  readonly editable: boolean
  readonly problems: readonly AgentOperatorProblem[]
  readonly service: OperatorDocumentService
}
const fieldId = (documentId: string, key: string) => `agent-operator-${documentId}-${key}`
function fieldText(field: AgentOperatorField, problems: readonly AgentOperatorProblem[]): { error?: string; note?: string } {
  const own = problems.filter(problem => problem.field === field)
  const error = own.find(problem => problem.severity === 'error')?.message
  const warnings = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...warnings.length ? { note: warnings.join(' ') } : {} }
}
/** hhmmss as msdb keeps it, and the HH:MM a time input shows. */
export const timeText = (value: number) => `${String(Math.floor(value / 10000)).padStart(2, '0')}:${String(Math.floor(value / 100) % 100).padStart(2, '0')}`
export const timeValue = (text: string) => { const [hours, minutes] = text.split(':').map(Number); return Number.isFinite(hours) && Number.isFinite(minutes) ? hours! * 10000 + minutes! * 100 : 0 }
const days = [{ bit: 2, label: 'Monday' }, { bit: 4, label: 'Tuesday' }, { bit: 8, label: 'Wednesday' }, { bit: 16, label: 'Thursday' }, { bit: 32, label: 'Friday' }, { bit: 64, label: 'Saturday' }, { bit: 1, label: 'Sunday' }] as const

/** Why Send test e-mail is unavailable, or undefined when it can run. */
export function testBlocked(model: AgentOperatorDocumentModel, draft: AgentOperatorDraft, changes: number): string | undefined {
  if (!model.operator) return agentOperatorText.testUnsaved
  if (!model.sysadmin) return agentOperatorText.testSysadmin
  if (!model.operator.enabled) return agentOperatorText.testDisabled
  if (!model.operator.email || draft.email !== model.operator.email && changes > 0) return model.operator.email ? agentOperatorText.testUnsaved : agentOperatorText.testNeedsEmail
  if (model.mail.xps === false) return agentOperatorText.testMailOff
  if (model.mail.checked && !model.mail.agentProfile) return agentOperatorText.testNeedsProfile
  return undefined
}

function GeneralSection({ state, model, draft, editable, problems, service }: Props) {
  const update = (patch: Partial<AgentOperatorDraft>) => service.updateDraft(state.id, current => ({ ...current, ...patch }))
  const ids = { name: fieldId(state.id, 'name'), enabled: fieldId(state.id, 'enabled'), email: fieldId(state.id, 'email'), pager: fieldId(state.id, 'pager'), netSend: fieldId(state.id, 'netSend') }
  const name = { description: 'The operator\'s name, unique on this server.', ...fieldText('name', problems) }
  const email = { description: 'Where Database Mail sends its e-mail; several addresses are separated by semicolons.', ...fieldText('email', problems) }
  const pager = { description: 'An e-mail address that reaches a pager, used only during pager duty.', ...fieldText('pager', problems) }
  const netSend = { description: agentOperatorText.netSendRetired, ...fieldText('netSend', problems) }
  const blocked = testBlocked(model, draft, state.changes)
  return <div className="properties-fields agent-operator-general">
    <PropertyField id={ids.name} label="Name" {...name}>
      <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} data-agent-object-focus={!model.operator || undefined}
        {...fieldAria(ids.name, name)} onChange={event => update({ name: event.target.value })} />
    </PropertyField>
    <PropertyField id={ids.enabled} label="Enabled" description="A disabled operator is sent nothing.">
      <Switch id={ids.enabled} checked={draft.enabled} disabled={!editable} onChange={checked => update({ enabled: checked })} />
    </PropertyField>
    <PropertyField id={ids.email} label="E-mail" {...email}>
      <span className="agent-operator-email">
        <input id={ids.email} className="property-input" type="text" maxLength={agentLimits.addressChars + 1} spellCheck={false} value={draft.email} disabled={!editable} {...fieldAria(ids.email, email)} onChange={event => update({ email: event.target.value })} />
        <button type="button" title={blocked} disabled={!!blocked || !service.canReload(state.id)} onClick={() => void service.sendTest(state.id, model.operator!)}><Icon name="agent-operator" />Send test e-mail</button>
      </span>
      {blocked && model.operator && <p className="field-note">{blocked}</p>}
    </PropertyField>
    <PropertyField id={ids.pager} label="Pager e-mail" {...pager}>
      <input id={ids.pager} className="property-input" type="text" maxLength={agentLimits.addressChars + 1} spellCheck={false} value={draft.pager} disabled={!editable} {...fieldAria(ids.pager, pager)} onChange={event => update({ pager: event.target.value })} />
    </PropertyField>
    {(draft.netSend || model.operator?.netSend) && <PropertyField id={ids.netSend} label="Net send" {...netSend}>
      <input id={ids.netSend} className="property-input" type="text" maxLength={agentLimits.addressChars + 1} spellCheck={false} value={draft.netSend} disabled={!editable} {...fieldAria(ids.netSend, netSend)} onChange={event => update({ netSend: event.target.value })} />
    </PropertyField>}
    {model.operator && <dl className="agent-job-facts">
      <dt>Last e-mail</dt><dd>{model.operator.lastEmail?.replace('T', ' ') ?? 'Never'}</dd>
      <dt>Last page</dt><dd>{model.operator.lastPager?.replace('T', ' ') ?? 'Never'}</dd>
    </dl>}
  </div>
}

function DutySection({ state, draft, editable, problems, service }: Props) {
  const update = (patch: Partial<AgentOperatorDraft>) => service.updateDraft(state.id, current => ({ ...current, ...patch }))
  const hoursRow = (label: string, key: 'weekday' | 'saturday' | 'sunday') => {
    const value: AgentDutyHours = draft[key]
    return <tr key={key}><th scope="row">{label}</th>
      <td><input type="time" className="property-input" aria-label={`${label} start`} value={timeText(value.start)} disabled={!editable} onChange={event => update({ [key]: { ...value, start: timeValue(event.target.value) } })} /></td>
      <td><input type="time" className="property-input" aria-label={`${label} end`} value={timeText(value.end)} disabled={!editable} onChange={event => update({ [key]: { ...value, end: timeValue(event.target.value) } })} /></td>
    </tr>
  }
  const duty = { description: 'When a page may be sent: the days, and the hours on weekdays, Saturday and Sunday.', ...fieldText('duty', problems) }
  const id = fieldId(state.id, 'duty')
  return <div className="properties-fields agent-operator-duty">
    <PropertyField id={id} label="On duty" labelFor={false} {...duty}>
      <span className="agent-operator-days" id={id} role="group" aria-label="Pager duty days">
        {days.map(day => <label key={day.bit}><input type="checkbox" checked={(draft.pagerDays & day.bit) !== 0} disabled={!editable} onChange={() => update({ pagerDays: draft.pagerDays ^ day.bit })} /> {day.label}</label>)}
      </span>
    </PropertyField>
    <table className="properties-table" aria-label="Pager duty hours">
      <thead><tr><th scope="col">Days</th><th scope="col">Start</th><th scope="col">End</th></tr></thead>
      <tbody>{[hoursRow('Weekdays', 'weekday'), hoursRow('Saturday', 'saturday'), hoursRow('Sunday', 'sunday')]}</tbody>
    </table>
  </div>
}

function NotificationsSection({ state, model, draft, editable, problems, service }: Props) {
  const alerts = model.alerts
  const own = fieldText('notify', problems)
  const methodsOf = (alert: string) => draft.notify.find(entry => entry.alert === alert)?.methods ?? 0
  const setMethods = (alert: string, methods: number) => service.updateDraft(state.id, current => ({
    ...current, notify: methods > 0 ? [...current.notify.filter(entry => entry.alert !== alert), { alert, methods }] : current.notify.filter(entry => entry.alert !== alert)
  }))
  const jobs = (model.jobs ?? []).filter(job => model.operator && (job.email === model.operator.name || job.page === model.operator.name || job.netSend === model.operator.name))
  return <div className="agent-operator-notifications">
    {!alerts ? <p className="field-note">{model.platform === 'windows' ? agentAlertText.readAlertsDenied : agentAlertText.platformAlerts}</p> : alerts.length === 0 ? <p className="field-note">The server has no alerts.</p>
      : <table className="properties-table" aria-label="Alerts that notify this operator">
        <thead><tr><th scope="col">Alert</th>{methodChoices.slice(0, 2).map(choice => <th key={choice.bit} scope="col">{choice.label}</th>)}</tr></thead>
        <tbody>{alerts.map(alert => <tr key={alert.id} data-disabled={!alert.enabled || undefined}>
          <th scope="row">{alert.name}</th>
          {[notifyEmail, notifyPager].map(bit => <td key={bit}><input type="checkbox" aria-label={`${bit === notifyEmail ? 'E-mail' : 'Pager'} on ${alert.name}`} checked={(methodsOf(alert.name) & bit) !== 0} disabled={!editable}
            onChange={() => setMethods(alert.name, methodsOf(alert.name) ^ bit)} /></td>)}
        </tr>)}</tbody>
      </table>}
    {model.alertsTruncated && <p className="field-note">Only the first {agentLimits.alertRows} alerts are shown.</p>}
    {own.error && <p className="property-field-error" role="alert"><Icon name="error" />{own.error}</p>}
    {own.note && <p className="field-note">{own.note}</p>}
    {jobs.length > 0 && <>
      <h4>Jobs that notify it</h4>
      <ul className="agent-operator-jobs">{jobs.map(job => <li key={job.id}>{job.name}</li>)}</ul>
    </>}
  </div>
}

export default function OperatorDocument({ documentId }: { documentId: string }) {
  const { operatorDocuments } = useWorkbench()
  const { documents } = useServiceSnapshot(operatorDocuments)
  const state = documents[documentId]
  if (!state) return <div className="agent-operator-document" />
  const { model, draft } = state
  const editable = operatorDocuments.canEdit(state.id), problems = operatorDocuments.problems(state.id) as readonly AgentOperatorProblem[]
  const args = { tabId: state.id }
  const saveLabel = model?.operator ? state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save' : 'Create'
  const verbs: Verb[] = [{ command: 'agentOperator.reload', args, label: 'Reload' }, { command: 'agentOperator.save', args, label: saveLabel, emphasis: 'primary' }]
  const sectionFields: Readonly<Record<string, readonly AgentOperatorField[]>> = { general: ['name', 'enabled', 'email', 'pager', 'netSend'], duty: ['duty'], notifications: ['notify'] }
  const content = (section: string) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the operator" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the operator could not be read.' : ''}</p>
    const props: Props = { state, model, draft, editable, problems, service: operatorDocuments }
    return section === 'general' ? <GeneralSection {...props} /> : section === 'duty' ? <DutySection {...props} /> : <NotificationsSection {...props} />
  }
  const sections: FrameSection[] = operatorSections.map(section => ({ id: section.id, title: section.title, problem: problems.some(problem => problem.severity === 'error' && sectionFields[section.id]!.includes(problem.field)), content: content(section.id) }))
  const name = model?.operator?.name ?? (draft?.name || 'New Operator')
  const phaseLabel = state.phase === 'loading' ? 'Reading the operator…' : state.phase === 'saving' ? 'Saving the operator…' : state.busy
  const recovery = state.phase === 'loadFailed' || state.error?.code === 'NOT_FOUND' ? [{ label: 'Reload', run: () => operatorDocuments.reload(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} context={`Operator ${name} on ${state.server}`} actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnly && <p className="document-status"><Icon name="lock" />{model.readOnly}</p>}
  </>
  const pill = !model ? null : !model.operator ? <StatusPill tone="neutral" label="Not saved yet" /> : <StatusPill tone={model.operator.enabled ? 'success' : 'neutral'} label={model.operator.enabled ? 'Enabled' : 'Disabled'} />
  return <FieldHints><DocumentFrame id={`agent-operator-${state.id}`} title={name} subtitle={model?.operator ? 'Operator Properties' : 'New Operator'}
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Operators' }]}
    state={pill} verbs={verbs} banner={banner} sections={sections} frame={state.frame} onFrame={frame => operatorDocuments.setFrame(state.id, frame)}
    attributes={{ 'data-agent-operator': state.id }} script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void operatorDocuments.deliver(state.id, destination) }} hint={<FieldHintStrip />} /></FieldHints>
}
