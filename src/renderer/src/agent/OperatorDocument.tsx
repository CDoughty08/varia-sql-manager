// The SQL Server Agent operator document (AG-7, docs/sql-server-agent.md › Operators): General (name, addresses, Send test e-mail), Pager
// duty, and the alerts that notify it. AlertOperatorDocumentService keeps every state; this only draws it.
import { agentAlertText, notifyEmail, notifyPager } from '../../../shared/actions/agent-alert.ts'
import type { AgentDutyHours } from '../../../shared/actions/agent-job.ts'
import { agentOperatorText, changedAgentOperatorFields, type AgentOperatorDocumentModel, type AgentOperatorDraft, type AgentOperatorField, type AgentOperatorProblem } from '../../../shared/actions/agent-operator.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { resizeScript, selectSection, setScriptOpen } from '../kit/document-frame'
import { type Verb } from '../kit/DocumentFrame'
import FactGrid from '../kit/FactGrid'
import InlineError from '../kit/InlineError'
import ObjectInspectorFrame, { type InspectorTab } from '../kit/ObjectInspectorFrame'
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
  readonly changed: ReadonlySet<AgentOperatorField>
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

function GeneralSection({ state, model, draft, editable, problems, changed, service }: Props) {
  const update = (patch: Partial<AgentOperatorDraft>) => service.updateDraft(state.id, current => ({ ...current, ...patch }))
  const ids = { name: fieldId(state.id, 'name'), enabled: fieldId(state.id, 'enabled'), email: fieldId(state.id, 'email'), pager: fieldId(state.id, 'pager'), netSend: fieldId(state.id, 'netSend') }
  const isChanged = (field: AgentOperatorField) => changed.has(field)
  const name = { description: 'The operator\'s name, unique on this server.', ...fieldText('name', problems) }
  const email = { description: 'Where Database Mail sends its e-mail; several addresses are separated by semicolons.', ...fieldText('email', problems) }
  const pager = { description: 'An e-mail address that reaches a pager, used only during pager duty.', ...fieldText('pager', problems) }
  const netSend = { description: agentOperatorText.netSendRetired, ...fieldText('netSend', problems) }
  const blocked = testBlocked(model, draft, state.changes)
  return <div className="agent-object-flow agent-operator-flow">
    <h2 className="agent-eyebrow">Identity &amp; Addresses</h2>
    <div className="properties-fields agent-operator-general">
      <PropertyField id={ids.name} label="Name" changed={isChanged('name')} {...name}>
        <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} data-agent-object-focus={!model.operator || undefined}
          data-changed={isChanged('name') || undefined} {...fieldAria(ids.name, { ...name, changed: isChanged('name') })} onChange={event => update({ name: event.target.value })} />
      </PropertyField>
      <PropertyField id={ids.enabled} label="Enabled" changed={isChanged('enabled')} description="A disabled operator is sent nothing.">
        <Switch id={ids.enabled} checked={draft.enabled} disabled={!editable} changed={isChanged('enabled')} onChange={checked => update({ enabled: checked })} />
      </PropertyField>
      <PropertyField id={ids.email} label="E-mail" changed={isChanged('email')} {...email}>
        <div className="agent-field-stack">
          <span className="agent-operator-email">
            <input id={ids.email} className="property-input" type="text" maxLength={agentLimits.addressChars + 1} spellCheck={false} value={draft.email} disabled={!editable} data-changed={isChanged('email') || undefined} {...fieldAria(ids.email, { ...email, changed: isChanged('email') })} onChange={event => update({ email: event.target.value })} />
            <button type="button" title={blocked} disabled={!!blocked || !service.canReload(state.id)} onClick={() => void service.sendTest(state.id, model.operator!)}><Icon name="agent-operator" />Send test e-mail</button>
          </span>
          {blocked && model.operator && <p className="field-note">{blocked}</p>}
        </div>
      </PropertyField>
      <PropertyField id={ids.pager} label="Pager e-mail" changed={isChanged('pager')} {...pager}>
        <input id={ids.pager} className="property-input" type="text" maxLength={agentLimits.addressChars + 1} spellCheck={false} value={draft.pager} disabled={!editable} data-changed={isChanged('pager') || undefined} {...fieldAria(ids.pager, { ...pager, changed: isChanged('pager') })} onChange={event => update({ pager: event.target.value })} />
      </PropertyField>
      {(draft.netSend || model.operator?.netSend) && <PropertyField id={ids.netSend} label="Net send" changed={isChanged('netSend')} {...netSend}>
        <input id={ids.netSend} className="property-input" type="text" maxLength={agentLimits.addressChars + 1} spellCheck={false} value={draft.netSend} disabled={!editable} data-changed={isChanged('netSend') || undefined} {...fieldAria(ids.netSend, { ...netSend, changed: isChanged('netSend') })} onChange={event => update({ netSend: event.target.value })} />
      </PropertyField>}
    </div>
    {model.operator && <>
      <h2 className="agent-eyebrow">Activity</h2>
      <FactGrid facts={[
        { id: 'lastEmail', label: 'Last e-mail', value: model.operator.lastEmail?.replace('T', ' ') ?? 'Never', mono: !!model.operator.lastEmail },
        { id: 'lastPager', label: 'Last page', value: model.operator.lastPager?.replace('T', ' ') ?? 'Never', mono: !!model.operator.lastPager }
      ]} />
    </>}
  </div>
}

function DutySection({ state, draft, editable, problems, changed, service }: Props) {
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
  return <div className="agent-object-flow agent-operator-flow">
    <h2 className="agent-eyebrow">Pager Duty Schedule</h2>
    <div className="properties-fields agent-operator-duty">
      <PropertyField id={id} label="On duty" labelFor={false} changed={changed.has('duty')} {...duty}>
        <span className="agent-operator-days" id={id} role="group" aria-label="Pager duty days">
          {days.map(day => <label key={day.bit}><input type="checkbox" checked={(draft.pagerDays & day.bit) !== 0} disabled={!editable} onChange={() => update({ pagerDays: draft.pagerDays ^ day.bit })} /> {day.label}</label>)}
        </span>
      </PropertyField>
      <table className="agent-table" aria-label="Pager duty hours">
        <thead><tr><th scope="col">Days</th><th scope="col">Start</th><th scope="col">End</th></tr></thead>
        <tbody>{[hoursRow('Weekdays', 'weekday'), hoursRow('Saturday', 'saturday'), hoursRow('Sunday', 'sunday')]}</tbody>
      </table>
    </div>
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
  return <div className="agent-object-flow agent-operator-flow agent-operator-notifications">
    <h2 className="agent-eyebrow">Alerts Notifying This Operator</h2>
    {!alerts ? <p className="field-note">{model.platform === 'windows' ? agentAlertText.readAlertsDenied : agentAlertText.platformAlerts}</p> : alerts.length === 0 ? <p className="field-note">The server has no alerts.</p>
      : <table className="agent-table" aria-label="Alerts that notify this operator">
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
      <h2 className="agent-eyebrow">Jobs Notifying This Operator</h2>
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
  const changed = model?.operator && state.base && draft ? new Set<AgentOperatorField>(changedAgentOperatorFields(state.base, draft)) : new Set<AgentOperatorField>()
  const args = { tabId: state.id }
  const saveLabel = model?.operator ? state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save' : 'Create'
  const verbs: Verb[] = [{ command: 'agentOperator.reload', args, label: 'Reload' }, { command: 'agentOperator.save', args, label: saveLabel, emphasis: 'primary' }]
  const sectionFields: Readonly<Record<string, readonly AgentOperatorField[]>> = { general: ['name', 'enabled', 'email', 'pager', 'netSend'], duty: ['duty'], notifications: ['notify'] }
  const content = (section: string) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the operator" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the operator could not be read.' : ''}</p>
    const props: Props = { state, model, draft, editable, problems, changed, service: operatorDocuments }
    return section === 'general' ? <GeneralSection {...props} /> : section === 'duty' ? <DutySection {...props} /> : <NotificationsSection {...props} />
  }
  const tabs: InspectorTab[] = operatorSections.map(section => ({
    id: section.id,
    title: section.title,
    layout: 'flow',
    ...section.id === 'notifications' && model?.alerts && draft ? { count: draft.notify.length } : {},
    modified: sectionFields[section.id]!.some(field => changed.has(field)),
    problem: problems.some(problem => problem.severity === 'error' && sectionFields[section.id]!.includes(problem.field)),
    content: content(section.id)
  }))
  const name = model?.operator?.name ?? (draft?.name || 'New Operator')
  const phaseLabel = state.phase === 'loading' ? 'Reading the operator…' : state.phase === 'saving' ? 'Saving the operator…' : state.busy
  const recovery = state.phase === 'loadFailed' || state.unread || state.error?.code === 'NOT_FOUND' ? [{ label: 'Reload', run: () => operatorDocuments.reload(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} context={`Operator ${name} on ${state.server}`} actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnly && <p className="document-status"><Icon name="lock" />{model.readOnly}</p>}
  </>
  const pill = !model ? null : !model.operator ? <StatusPill tone="neutral" label="Not saved yet" /> : <StatusPill tone={model.operator.enabled ? 'success' : 'neutral'} label={model.operator.enabled ? 'Enabled' : 'Disabled'} />
  return <FieldHints resetKey={state.frame.section}><ObjectInspectorFrame id={`agent-operator-${state.id}`} surface="full" title={name} subtitle={model?.operator ? 'Operator Properties' : 'New Operator'}
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Operators' }]}
    state={pill} verbs={verbs} banner={banner} tabs={tabs} activeTab={state.frame.section}
    onSelectTab={id => operatorDocuments.setFrame(state.id, selectSection(state.frame, operatorSections, id))}
    attributes={{ 'data-agent-operator': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void operatorDocuments.deliver(state.id, destination) }}
    scriptOpen={state.frame.scriptOpen} scriptSize={state.frame.scriptSize}
    onScriptToggle={() => operatorDocuments.setFrame(state.id, setScriptOpen(state.frame, !state.frame.scriptOpen))}
    onScriptResize={size => operatorDocuments.setFrame(state.id, resizeScript(state.frame, size))}
    hint={<FieldHintStrip />} /></FieldHints>
}
