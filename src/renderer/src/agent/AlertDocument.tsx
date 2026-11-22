// The SQL Server Agent alert document (AG-7, docs/sql-server-agent.md › Alerts): one screen of When / Then / Options, the alert's history
// in the header, the counter's current values beside a performance condition, and operator chips with an inline new operator.
// AlertOperatorDocumentService keeps every state; this only draws it.
import { useState } from 'react'
import {
  alertComparators, alertKindLabels, alertKindsOffered, agentAlertText, notifyEmail, notifyNetSend, notifyPager, type AgentAlertDocumentModel, type AgentAlertDraft, type AgentAlertField,
  type AgentAlertKind, type AgentAlertProblem, type AgentComparator
} from '../../../shared/actions/agent-alert.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PropertyField, { FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import { alertSections, type AgentObjectState, type AlertDocumentService } from './AlertOperatorDocumentService'

type State = AgentObjectState<AgentAlertDocumentModel, AgentAlertDraft>
interface Props {
  readonly state: State
  readonly model: AgentAlertDocumentModel
  readonly draft: AgentAlertDraft
  readonly editable: boolean
  readonly problems: readonly AgentAlertProblem[]
  readonly service: AlertDocumentService
}
const fieldId = (documentId: string, key: string) => `agent-alert-${documentId}-${key}`
function fieldText(field: AgentAlertField, problems: readonly AgentAlertProblem[]): { error?: string; note?: string } {
  const own = problems.filter(problem => problem.field === field)
  const error = own.find(problem => problem.severity === 'error')?.message
  const warnings = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...warnings.length ? { note: warnings.join(' ') } : {} }
}
export const methodChoices = [{ bit: notifyEmail, label: 'E-mail', short: 'E' }, { bit: notifyPager, label: 'Pager', short: 'P' }, { bit: notifyNetSend, label: 'Net send', short: 'N' }] as const

function WhenSection({ state, model, draft, editable, problems, service }: Props) {
  const update = (patch: Partial<AgentAlertDraft>) => service.updateDraft(state.id, current => ({ ...current, ...patch }))
  const ids = { name: fieldId(state.id, 'name'), kind: fieldId(state.id, 'kind'), when: fieldId(state.id, 'when'), database: fieldId(state.id, 'database'), keyword: fieldId(state.id, 'keyword'), enabled: fieldId(state.id, 'enabled') }
  const kinds: AgentAlertKind[] = model.alert ? [model.alert.kind] : alertKindsOffered(model.platform)
  const wmi = draft.kind === 'wmi'
  const name = { description: 'The alert\'s name, unique on this server.', ...fieldText('name', problems) }
  const database = { description: 'Only events in this database; all databases when empty.', ...fieldText('database', problems) }
  const keyword = { description: 'Only events whose message contains this text.', ...fieldText('keyword', problems) }
  const when = { description: draft.kind === 'performance' ? agentAlertText.countersHint : 'The error number or the severity the alert raises on.', ...fieldText('when', problems), ...wmi ? { note: agentAlertText.wmiReadOnly } : {} }
  const objects = [...new Set((model.counters ?? []).map(counter => counter.object))]
  const counters = (model.counters ?? []).filter(counter => counter.object === draft.object).map(counter => counter.counter)
  const reading = state.counters?.key === `${draft.object}|${draft.counter}` ? state.counters : undefined
  return <div className="properties-fields agent-alert-when">
    <PropertyField id={ids.name} label="Name" {...name}>
      <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} data-agent-object-focus={!model.alert || undefined}
        {...fieldAria(ids.name, name)} onChange={event => update({ name: event.target.value })} />
    </PropertyField>
    <PropertyField id={ids.enabled} label="Enabled" description="A disabled alert does not respond to its event.">
      <Switch id={ids.enabled} checked={draft.enabled} disabled={!editable} onChange={checked => update({ enabled: checked })} />
    </PropertyField>
    <PropertyField id={ids.kind} label="Type" description={model.alert ? agentAlertText.kindFixed : 'What the alert watches.'}>
      <select id={ids.kind} className="property-input" value={draft.kind} disabled={!editable || !!model.alert} onChange={event => update({ kind: event.target.value as AgentAlertKind })}>
        {kinds.map(kind => <option key={kind} value={kind}>{alertKindLabels[kind]}</option>)}
      </select>
    </PropertyField>
    {draft.kind === 'event' && <>
      <PropertyField id={ids.when} label="Raise on" labelFor={false} {...when}>
        <span className="agent-alert-raise">
          <Segmented id={ids.when} labelledBy={`${ids.when}-label`} segments={[{ value: 'severity', label: 'Severity' }, { value: 'message', label: 'Error number' }]} value={draft.raiseOn} disabled={!editable}
            onChange={value => update({ raiseOn: value as 'message' | 'severity' })} {...fieldAria(ids.when, when)} />
          {draft.raiseOn === 'severity'
            ? <select className="property-input" aria-label="Severity" value={draft.severity} disabled={!editable} onChange={event => update({ severity: Number(event.target.value) })}>
              {Array.from({ length: 25 }, (_, index) => index + 1).map(severity => <option key={severity} value={severity}>{String(severity).padStart(3, '0')}</option>)}
            </select>
            : <input className="property-input" type="text" inputMode="numeric" aria-label="Error number" maxLength={10} value={draft.messageId} disabled={!editable} onChange={event => update({ messageId: event.target.value })} />}
        </span>
        {draft.raiseOn === 'message' && model.messageText && draft.messageId.trim() === String(model.alert?.messageId) && <p className="field-note">{model.messageText}</p>}
      </PropertyField>
      <PropertyField id={ids.database} label="Database" {...database}>
        <select id={ids.database} className="property-input" value={draft.database} disabled={!editable} {...fieldAria(ids.database, database)} onChange={event => update({ database: event.target.value })}>
          <option value="">(All databases)</option>
          {(model.databases.includes(draft.database) || !draft.database ? model.databases : [draft.database, ...model.databases]).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </PropertyField>
      <PropertyField id={ids.keyword} label="Message contains" {...keyword}>
        <input id={ids.keyword} className="property-input" type="text" maxLength={agentLimits.alertKeywordChars + 1} value={draft.keyword} disabled={!editable} {...fieldAria(ids.keyword, keyword)} onChange={event => update({ keyword: event.target.value })} />
      </PropertyField>
    </>}
    {draft.kind === 'performance' && <PropertyField id={ids.when} label="Condition" {...when} {...!model.counters ? { note: agentAlertText.countersTyped } : {}}>
      <span className="agent-alert-condition">
        <input id={ids.when} className="property-input" type="text" list={`${ids.when}-objects`} aria-label="Object" placeholder="Object" maxLength={128} value={draft.object} disabled={!editable} onChange={event => update({ object: event.target.value, counter: '' })} />
        <datalist id={`${ids.when}-objects`}>{objects.map(object => <option key={object} value={object} />)}</datalist>
        <input className="property-input" type="text" list={`${ids.when}-counters`} aria-label="Counter" placeholder="Counter" maxLength={128} value={draft.counter} disabled={!editable} onChange={event => update({ counter: event.target.value })} />
        <datalist id={`${ids.when}-counters`}>{counters.map(counter => <option key={counter} value={counter} />)}</datalist>
        <input className="property-input" type="text" list={`${ids.when}-instances`} aria-label="Instance" placeholder="Instance (any)" maxLength={128} value={draft.instance} disabled={!editable} onChange={event => update({ instance: event.target.value })} />
        <datalist id={`${ids.when}-instances`}>{(reading?.result?.values ?? []).map(value => <option key={value.instance} value={value.instance} />)}</datalist>
        <select className="property-input" aria-label="Comparison" value={draft.comparator} disabled={!editable} onChange={event => update({ comparator: event.target.value as AgentComparator })}>
          {alertComparators.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
        <input className="property-input" type="text" inputMode="decimal" aria-label="Value" placeholder="Value" maxLength={32} value={draft.value} disabled={!editable} onChange={event => update({ value: event.target.value })} />
      </span>
      <CounterValues state={state} draft={draft} service={service} />
    </PropertyField>}
    {wmi && model.alert && <PropertyField id={ids.when} label="WMI query" labelFor={false} {...when}>
      <pre className="agent-alert-wmi">{`${model.alert.wmiNamespace}\n${model.alert.wmiQuery}`}</pre>
    </PropertyField>}
  </div>
}

/** The counter's current values, read on demand (agent.counterValues). */
function CounterValues({ state, draft, service }: Pick<Props, 'state' | 'draft' | 'service'>) {
  const key = `${draft.object}|${draft.counter}`
  const reading = state.counters?.key === key ? state.counters : undefined
  const values = reading?.result?.values ?? []
  return <div className="agent-alert-counter-values" aria-live="polite">
    <button type="button" disabled={!draft.object.trim() || !draft.counter.trim() || reading?.loading || !service.live(state.id)} onClick={() => void service.readCounter(state.id, draft.object, draft.counter)}>
      <Icon name="refresh" />{reading?.loading ? 'Reading…' : 'Current values'}
    </button>
    {reading?.result?.error && <p className="property-field-error" role="alert"><Icon name="error" />{reading.result.error.message}</p>}
    {reading?.result && !reading.result.error && (values.length === 0 ? <p className="field-note">No instance of this counter on the server.</p>
      : <table className="properties-table" aria-label="Current values">
        <thead><tr><th scope="col">Instance</th><th scope="col">Value</th></tr></thead>
        <tbody>{values.map(value => <tr key={value.instance} data-selected={value.instance === draft.instance || undefined}><td>{value.instance || '(none)'}</td><td>{value.value.toLocaleString()}</td></tr>)}</tbody>
      </table>)}
    {reading?.result?.truncated && <p className="field-note">Only the first {agentLimits.counterInstances} instances are shown.</p>}
    {reading?.result?.readAt && <p className="field-note">Read at {reading.result.readAt.replace('T', ' ')} on the server.</p>}
  </div>
}

function ThenSection({ state, model, draft, editable, problems, service }: Props) {
  const update = (patch: Partial<AgentAlertDraft>) => service.updateDraft(state.id, current => ({ ...current, ...patch }))
  const [adding, setAdding] = useState<{ name: string; email: string; pager: string } | undefined>()
  const ids = { job: fieldId(state.id, 'job'), notify: fieldId(state.id, 'notify') }
  const notify = { description: 'Who hears about it, and how. Save adds, changes and removes the notifications.', ...fieldText('notify', problems) }
  const known = new Set([...(model.operators ?? []).map(operator => operator.name), ...draft.newOperators.map(operator => operator.name)])
  const offered = [...known].filter(name => !draft.notify.some(entry => entry.operator === name))
  const setMethods = (operator: string, methods: number) => update({ notify: methods > 0 ? draft.notify.map(entry => entry.operator === operator ? { operator, methods } : entry) : draft.notify.filter(entry => entry.operator !== operator), newOperators: methods > 0 ? draft.newOperators : draft.newOperators.filter(entry => entry.name !== operator) })
  const jobs = model.jobs ?? []
  return <div className="properties-fields agent-alert-then">
    <PropertyField id={ids.job} label="Run job" description="A job SQL Server Agent starts when the alert fires." {...fieldText('job', problems)}>
      <select id={ids.job} className="property-input" value={draft.jobId.toLowerCase()} disabled={!editable || !model.jobs} onChange={event => update({ jobId: event.target.value })}>
        <option value="">(No job)</option>
        {model.alert?.jobId && !jobs.some(job => job.id.toLowerCase() === model.alert!.jobId.toLowerCase()) && <option value={model.alert.jobId.toLowerCase()}>{model.alert.jobName || model.alert.jobId}</option>}
        {state.preset?.jobId && !jobs.some(job => job.id.toLowerCase() === state.preset!.jobId!.toLowerCase()) && <option value={state.preset.jobId.toLowerCase()}>{state.preset.jobName ?? state.preset.jobId}</option>}
        {jobs.map(job => <option key={job.id} value={job.id.toLowerCase()}>{job.name}</option>)}
      </select>
    </PropertyField>
    <PropertyField id={ids.notify} label="Notify operators" labelFor={false} {...notify}>
      <div className="agent-alert-chips">
        <span className="agent-alert-chip-list" role="list" aria-label="Operators notified">{draft.notify.map(entry => {
          const pending = draft.newOperators.some(item => item.name === entry.operator)
          return <span key={entry.operator} className="agent-alert-chip" role="listitem" data-new={pending || undefined}>
            <Icon name="agent-operator" /><span>{entry.operator}{pending && ' (new)'}</span>
            {methodChoices.map(choice => <button key={choice.bit} type="button" className="agent-alert-method" aria-pressed={(entry.methods & choice.bit) !== 0} aria-label={`${choice.label} ${entry.operator}`} title={choice.label}
              disabled={!editable} onClick={() => setMethods(entry.operator, entry.methods ^ choice.bit)}>{choice.short}</button>)}
            <button type="button" aria-label={`Remove ${entry.operator}`} disabled={!editable} onClick={() => setMethods(entry.operator, 0)}><Icon name="close" /></button>
          </span>
        })}</span>
        {offered.length > 0 && <select className="property-input" aria-label="Add an operator" value="" disabled={!editable || draft.notify.length >= agentLimits.notificationChanges}
          onChange={event => { if (event.target.value) update({ notify: [...draft.notify, { operator: event.target.value, methods: notifyEmail }] }) }}>
          <option value="">Add an operator…</option>
          {offered.map(name => <option key={name} value={name}>{name}</option>)}
        </select>}
        {!adding && model.sysadmin && <button type="button" disabled={!editable || draft.newOperators.length >= agentLimits.newOperators} onClick={() => setAdding({ name: '', email: '', pager: '' })}><Icon name="add" />New operator</button>}
      </div>
      {adding && <div className="agent-alert-new-operator" role="group" aria-label="New operator">
        <input className="property-input" type="text" aria-label="New operator name" placeholder="Name" maxLength={agentLimits.nameChars} value={adding.name} onChange={event => setAdding({ ...adding, name: event.target.value })} />
        <input className="property-input" type="email" aria-label="New operator e-mail" placeholder="E-mail address" maxLength={agentLimits.addressChars} value={adding.email} onChange={event => setAdding({ ...adding, email: event.target.value })} />
        <input className="property-input" type="text" aria-label="New operator pager" placeholder="Pager address" maxLength={agentLimits.addressChars} value={adding.pager} onChange={event => setAdding({ ...adding, pager: event.target.value })} />
        <button type="button" className="primary" disabled={!adding.name.trim() || known.has(adding.name.trim())} onClick={() => {
          const name = adding.name.trim()
          update({ newOperators: [...draft.newOperators, { name, email: adding.email.trim(), pager: adding.pager.trim() }], notify: [...draft.notify, { operator: name, methods: adding.pager.trim() && !adding.email.trim() ? notifyPager : notifyEmail }] })
          setAdding(undefined)
        }}>Add</button>
        <button type="button" onClick={() => setAdding(undefined)}>Cancel</button>
        <p className="field-note">{agentAlertText.newOperatorHint}</p>
      </div>}
    </PropertyField>
  </div>
}

function OptionsSection({ state, model, draft, editable, problems, service }: Props) {
  const update = (patch: Partial<AgentAlertDraft>) => service.updateDraft(state.id, current => ({ ...current, ...patch }))
  const ids = { includeIn: fieldId(state.id, 'includeIn'), message: fieldId(state.id, 'message'), delay: fieldId(state.id, 'delay'), count: fieldId(state.id, 'count') }
  const message = { description: 'Sent with every notification.', ...fieldText('message', problems) }
  const delay = { description: agentAlertText.delayHint, ...fieldText('delay', problems) }
  return <div className="properties-fields agent-alert-options">
    <PropertyField id={ids.includeIn} label="Include the error text in" labelFor={false} description="Which notifications carry the error's own message." {...fieldText('includeIn', problems)}>
      <span className="agent-alert-include" id={ids.includeIn}>
        {methodChoices.map(choice => <label key={choice.bit}><input type="checkbox" checked={(draft.includeIn & choice.bit) !== 0} disabled={!editable} onChange={() => update({ includeIn: draft.includeIn ^ choice.bit })} /> {choice.label}</label>)}
      </span>
    </PropertyField>
    <PropertyField id={ids.message} label="Additional message" {...message}>
      <textarea id={ids.message} className="property-input" rows={3} maxLength={agentLimits.alertMessageChars + 1} value={draft.message} disabled={!editable} {...fieldAria(ids.message, message)} onChange={event => update({ message: event.target.value })} />
    </PropertyField>
    <PropertyField id={ids.delay} label="Delay between responses (seconds)" {...delay}>
      <input id={ids.delay} className="property-input" type="number" min={0} max={agentLimits.alertDelaySeconds} step={1} value={draft.delay} disabled={!editable} {...fieldAria(ids.delay, delay)}
        onChange={event => update({ delay: Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
    </PropertyField>
    {model.alert && <PropertyField id={ids.count} label="Occurrence count" labelFor={false} description={draft.resetCount ? agentAlertText.resetPending : model.sysadmin ? 'How many times the alert has fired since its count was reset.' : agentAlertText.resetSysadmin} {...fieldText('count', problems)}>
      <span className="agent-alert-count">
        <strong>{draft.resetCount ? 0 : model.alert.occurrences.toLocaleString()}</strong>
        {model.alert.countReset && <span className="field-note">since {model.alert.countReset.replace('T', ' ')}</span>}
        <button type="button" id={ids.count} aria-pressed={draft.resetCount} disabled={!editable || !model.sysadmin || model.alert.occurrences === 0 && !draft.resetCount} onClick={() => update({ resetCount: !draft.resetCount })}>{draft.resetCount ? 'Keep count' : 'Reset count'}</button>
      </span>
    </PropertyField>}
  </div>
}

/** The header's history: last occurred and how often, or that it has never fired. */
function History({ model }: { readonly model?: AgentAlertDocumentModel }) {
  const alert = model?.alert
  if (!alert) return model ? <StatusPill tone="neutral" label="Not saved yet" /> : null
  if (!alert.enabled) return <StatusPill tone="neutral" label="Disabled" />
  return <StatusPill tone={alert.occurrences ? 'warning' : 'success'} label={alert.lastOccurred ? `Last fired ${alert.lastOccurred.replace('T', ' ')} · ${alert.occurrences.toLocaleString()} times` : 'Never fired'} />
}

export default function AlertDocument({ documentId }: { documentId: string }) {
  const { alertDocuments } = useWorkbench()
  const { documents } = useServiceSnapshot(alertDocuments)
  const state = documents[documentId]
  if (!state) return <div className="agent-alert-document" />
  const { model, draft } = state
  const editable = alertDocuments.canEdit(state.id), problems = alertDocuments.problems(state.id) as readonly AgentAlertProblem[]
  const args = { tabId: state.id }
  const saveLabel = model?.alert ? state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save' : 'Create'
  const verbs: Verb[] = [{ command: 'agentAlert.reload', args, label: 'Reload' }, { command: 'agentAlert.save', args, label: saveLabel, emphasis: 'primary' }]
  const sectionFields: Readonly<Record<string, readonly AgentAlertField[]>> = { when: ['name', 'enabled', 'when', 'database', 'keyword'], then: ['job', 'notify'], options: ['includeIn', 'message', 'delay', 'count'] }
  const content = (section: string) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the alert" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the alert could not be read.' : ''}</p>
    const props: Props = { state, model, draft, editable, problems, service: alertDocuments }
    return section === 'when' ? <WhenSection {...props} /> : section === 'then' ? <ThenSection {...props} /> : <OptionsSection {...props} />
  }
  const sections: FrameSection[] = alertSections.map(section => ({ id: section.id, title: section.title, problem: problems.some(problem => problem.severity === 'error' && sectionFields[section.id]!.includes(problem.field)), content: content(section.id) }))
  const name = model?.alert?.name ?? (draft?.name || 'New Alert')
  const phaseLabel = state.phase === 'loading' ? 'Reading the alert…' : state.phase === 'saving' ? 'Saving the alert…' : undefined
  const recovery = state.phase === 'loadFailed' || state.error?.code === 'NOT_FOUND' ? [{ label: 'Reload', run: () => alertDocuments.reload(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} context={`Alert ${name} on ${state.server}`} actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnly && <p className="document-status"><Icon name="lock" />{model.readOnly}</p>}
  </>
  return <FieldHints><DocumentFrame id={`agent-alert-${state.id}`} title={name} subtitle={model?.alert ? 'Alert Properties' : 'New Alert'}
    crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Alerts' }]}
    state={<History {...model ? { model } : {}} />} verbs={verbs} banner={banner} sections={sections} frame={state.frame} onFrame={frame => alertDocuments.setFrame(state.id, frame)}
    attributes={{ 'data-agent-alert': state.id }} script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void alertDocuments.deliver(state.id, destination) }} hint={<FieldHintStrip />} /></FieldHints>
}
