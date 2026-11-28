// SQL Server Agent's Operators and notifications grid (AG-7, docs/sql-server-agent.md › Operators and notifications): alerts down, operators
// across, each cell how the operator hears about the alert; the selected operator beside it with Open, Send test e-mail and Delete (with
// Reassign to); the jobs that notify operators, read-only; and Add recommended alerts. Save sends one change per changed alert.
import { useEffect, useState, type KeyboardEvent } from 'react'
import { agentAlertText, notifyEmail, notifyNetSend, notifyPager, type AgentRecommendedSave } from '../../../shared/actions/agent-alert.ts'
import { agentOperatorText, cellText, operatorUses, withCell, type AgentJobNotifyRow, type AgentNotifyMatrix, type AgentOperatorRecord, type AgentOperatorsModel } from '../../../shared/actions/agent-operator.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import { resizeScript, setScriptOpen } from '../kit/document-frame'
import { type Verb } from '../kit/DocumentFrame'
import FactGrid from '../kit/FactGrid'
import InlineError from '../kit/InlineError'
import ObjectInspectorFrame, { type InspectorTab } from '../kit/ObjectInspectorFrame'
import ResizableSplit from '../kit/ResizableSplit'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import { agentObjectText, type AgentObjectState, type OperatorsDocumentService } from './AlertOperatorDocumentService'
import { methodChoices } from './AlertDocument'

type State = AgentObjectState<AgentOperatorsModel, AgentNotifyMatrix>
/** A cell click cycles e-mail and pager (none, E, E and P, P) and keeps net send as it is, which only the alert document changes. */
export const nextMethods = (methods: number): number => {
  const paged = methods & (notifyEmail | notifyPager)
  return (paged === 0 ? notifyEmail : paged === notifyEmail ? notifyEmail | notifyPager : paged === (notifyEmail | notifyPager) ? notifyPager : 0) | (methods & notifyNetSend)
}
/** The grid's one tab stop moves by arrow keys, Home and End (a row's first and last cell) and Ctrl+Home and Ctrl+End (the corners). */
/** Why Delete… waits: unsaved changes, or a grid read-only because its notifications are partial or unread, where the dialog's count of uses could say nothing notifies an operator that something does. */
export const deleteBlocked = (changes: number, model: Pick<AgentOperatorsModel, 'readOnly'>): string | undefined => changes > 0 ? agentObjectText.saveFirst : model.readOnly

/** The grid body's note without alert rows; the operator headers still show, so any operator can be selected, opened, tested or deleted. */
export const alertsNote = (model: Pick<AgentOperatorsModel, 'alerts' | 'platform'>): string =>
  model.alerts ? 'The server has no alerts. Add recommended alerts creates the usual set.' : model.platform === 'windows' ? agentAlertText.readAlertsDenied : agentAlertText.platformAlerts

export function gridStep(key: string, ctrl: boolean, at: { readonly row: number; readonly column: number }, rows: number, columns: number): { row: number; column: number } | undefined {
  const clamp = (value: number, size: number) => Math.max(0, Math.min(size - 1, value))
  switch (key) {
    case 'ArrowUp': return { row: clamp(at.row - 1, rows), column: at.column }
    case 'ArrowDown': return { row: clamp(at.row + 1, rows), column: at.column }
    case 'ArrowLeft': return { row: at.row, column: clamp(at.column - 1, columns) }
    case 'ArrowRight': return { row: at.row, column: clamp(at.column + 1, columns) }
    case 'Home': return ctrl ? { row: 0, column: 0 } : { row: at.row, column: 0 }
    case 'End': return ctrl ? { row: rows - 1, column: columns - 1 } : { row: at.row, column: columns - 1 }
    default: return undefined
  }
}
/** Runs an open, reporting a failure (a lost connection) in the command banner rather than throwing from the click. */
const reported = (commands: { reportError: (message: string) => void }, run: () => unknown, fallback: string) => {
  try { run() } catch (error) { commands.reportError(error instanceof Error ? error.message : fallback) }
}
const methodsWords = (methods: number) => methodChoices.filter(choice => methods & choice.bit).map(choice => choice.label).join(' and ') || 'not notified'

function Grid({ state, model, draft, editable, service, selected, onSelect }: {
  readonly state: State; readonly model: AgentOperatorsModel; readonly draft: AgentNotifyMatrix; readonly editable: boolean; readonly service: OperatorsDocumentService
  readonly selected?: string; readonly onSelect: (name: string) => void
}) {
  const alerts = model.alerts ?? []
  const [focus, setFocus] = useState({ row: 0, column: 0 })
  if (!model.operators.length) return <div className="agent-operators-empty"><p className="field-note">The server has no operators yet. New Operator adds one.</p></div>
  const base = state.base
  const rows = alerts.length, columns = model.operators.length
  const stop = { row: Math.min(focus.row, Math.max(0, rows - 1)), column: Math.min(focus.column, Math.max(0, columns - 1)) }
  const keyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (event.altKey || event.metaKey || event.shiftKey) return
    const next = gridStep(event.key, event.ctrlKey, stop, rows, columns)
    if (!next) return
    event.preventDefault()
    setFocus(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-cell="${next.row}:${next.column}"]`)?.focus()
  }
  return <>
    <div className="agent-operators-grid-wrap">
      <table className="agent-table borderless agent-operators-grid" aria-label="Operators and notifications">
        <thead><tr><th scope="col">Alert</th>{model.operators.map(operator => <th key={operator.id} scope="col" data-selected={operator.name === selected || undefined}>
          <button type="button" className="agent-operators-head" aria-pressed={operator.name === selected} onClick={() => onSelect(operator.name)}>{operator.name}{!operator.enabled && ' (disabled)'}</button>
        </th>)}</tr></thead>
        <tbody onKeyDown={keyDown}>{alerts.length === 0 ? <tr><td colSpan={model.operators.length + 1} className="field-note">{alertsNote(model)}</td></tr>
          : alerts.map((alert, row) => <tr key={alert.id} data-disabled={!alert.enabled || undefined}>
            <th scope="row">{alert.name}</th>
            {model.operators.map((operator, column) => {
              const methods = draft.get(alert.name)?.get(operator.name) ?? 0
              const changed = (base?.get(alert.name)?.get(operator.name) ?? 0) !== methods
              return <td key={operator.id} data-changed={changed || undefined} data-selected={operator.name === selected || undefined}>
                <button type="button" className="agent-operators-cell" data-set={methods > 0 || undefined} aria-disabled={!editable || undefined} data-cell={`${row}:${column}`} tabIndex={row === stop.row && column === stop.column ? 0 : -1}
                  onFocus={() => setFocus({ row, column })} aria-label={`${alert.name}, ${operator.name}: ${methodsWords(methods)}`}
                  onClick={() => { if (editable) service.updateDraft(state.id, matrix => withCell(matrix, alert.name, operator.name, nextMethods(methods))) }}>{cellText(methods) || '·'}</button>
              </td>
            })}
          </tr>)}</tbody>
      </table>
    </div>
    <div className="agent-operators-foot">
      <p className="field-note">Click a cell (or press Enter or Space on it; the arrow keys move between cells) to cycle e-mail (E), e-mail and pager (EP), pager (P) and none.</p>
      {model.alertsTruncated && <p className="field-note">Only the first {agentLimits.alertRows} alerts are shown.</p>}
      {model.operatorsTruncated && <p className="field-note">Only the first {agentLimits.operatorRows} operators are shown.</p>}
    </div>
  </>
}

function SidePane({ state, model, operator, service, onDelete }: { readonly state: State; readonly model: AgentOperatorsModel; readonly operator: AgentOperatorRecord; readonly service: OperatorsDocumentService; readonly onDelete: () => void }) {
  const { operatorDocuments, documents, commands } = useWorkbench()
  const uses = operatorUses(model, operator)
  const testBlocked = !model.sysadmin ? agentOperatorText.testSysadmin : !operator.enabled ? agentOperatorText.testDisabled : !operator.email ? agentOperatorText.testNeedsEmail : model.mail.xps === false ? agentOperatorText.testMailOff : model.mail.checked && !model.mail.agentProfile ? agentOperatorText.testNeedsProfile : undefined
  const connectionId = documents.get(state.id)?.connectionId
  return <aside className="agent-operators-side" aria-label={`Operator ${operator.name}`}>
    <div className="agent-operators-side-head">
      <h3><Icon name="agent-operator" /><span>{operator.name}</span></h3>
      <StatusPill size="small" tone={operator.enabled ? 'success' : 'neutral'} label={operator.enabled ? 'Enabled' : 'Disabled'} />
    </div>
    <FactGrid compact facts={[
      { id: 'email', label: 'E-mail', value: operator.email || '', mono: !!operator.email },
      { id: 'pager', label: 'Pager', value: operator.pager || '', mono: !!operator.pager },
      { id: 'alerts', label: 'Alerts', value: String(uses.alerts), copyable: false },
      { id: 'jobs', label: 'Jobs', value: String(uses.jobs), copyable: false }
    ]} />
    <p className="agent-operators-side-actions">
      <button type="button" disabled={!connectionId} onClick={() => { if (connectionId) reported(commands, () => operatorDocuments.open(connectionId, { kind: 'agentOperator', name: operator.name }), 'The operator could not be opened.') }}><Icon name="go-to-file" />Open Operator</button>
      <button type="button" title={testBlocked} disabled={!!testBlocked || !service.canReload(state.id)} onClick={() => void service.sendTest(state.id, operator)}><Icon name="agent-operator" />Send test e-mail</button>
      {model.sysadmin && <button type="button" className="danger" disabled={!service.canReload(state.id) || !!deleteBlocked(state.changes, model)} title={deleteBlocked(state.changes, model)} onClick={onDelete}><Icon name="trash" />Delete &amp; reassign…</button>}
    </p>
    {testBlocked && <p className="field-note">{testBlocked}</p>}
  </aside>
}

/** Delete operator: its notifications moved to another operator, or dropped. Runs at once, apart from Save. */
function DeleteOperator({ state, model, operator, service, onClose }: { readonly state: State; readonly model: AgentOperatorsModel; readonly operator: AgentOperatorRecord; readonly service: OperatorsDocumentService; readonly onClose: () => void }) {
  const others = model.operators.filter(item => item.id !== operator.id)
  const uses = operatorUses(model, operator)
  const [reassign, setReassign] = useState('')
  const textId = `agent-operator-delete-${state.id}`
  return <SubDialog title={agentOperatorText.deleteTitle(operator.name)} okLabel={state.busy ? 'Deleting…' : 'Delete'} okDisabled={!!state.busy} destructive alert describedBy={textId}
    onOk={() => { void service.deleteOperator(state.id, operator, reassign || undefined).then(ok => { if (ok) onClose() }) }} onCancel={onClose}>
    <div id={textId}>
      <p>{uses.alerts + uses.jobs ? agentOperatorText.deleteUses(uses.alerts, uses.jobs) : agentOperatorText.deleteUnused}</p>
      {uses.alerts + uses.jobs > 0 && <label className="agent-operator-reassign">{agentOperatorText.reassign}{' '}
        <select className="property-input" value={reassign} onChange={event => setReassign(event.target.value)} aria-label={agentOperatorText.reassign}>
          <option value="">{agentOperatorText.dropAll}</option>
          {others.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
        </select>
      </label>}
      <p className="field-note">{agentOperatorText.deleteNow}</p>
    </div>
  </SubDialog>
}

/** Add recommended alerts: the usual set, the ones the server has already greyed out, each new one notifying one operator. */
function AddRecommended({ state, model, service, onClose }: { readonly state: State; readonly model: AgentOperatorsModel; readonly service: OperatorsDocumentService; readonly onClose: () => void }) {
  const entries = service.recommended(state.id)
  const [chosen, setChosen] = useState(() => new Set(entries.filter(entry => !entry.exists).map(entry => entry.name)))
  const [operator, setOperator] = useState(model.operators.find(item => item.enabled && item.email)?.name ?? '')
  const [methods, setMethods] = useState(notifyEmail)
  const [delay, setDelay] = useState(5)
  const save: AgentRecommendedSave = {
    alerts: entries.filter(entry => !entry.exists && chosen.has(entry.name)).map(({ name, messageId, severity }) => ({ name, messageId, severity })),
    ...operator && methods ? { operator, methods } : { methods: 0 }, delay: delay * 60
  }
  return <SubDialog title="Add Recommended Alerts" okLabel={state.busy ? 'Creating…' : `Create ${save.alerts.length} alert${save.alerts.length === 1 ? '' : 's'}`} okDisabled={!save.alerts.length || !!state.busy}
    onOk={() => { void service.addRecommended(state.id, save).then(ok => { if (ok) onClose() }) }} onCancel={onClose} className="agent-recommended">
    <p className="field-note">Severity 17 and 19 to 25, and errors 823 to 825: the alerts most servers should have. Ones the server already has are left as they are.</p>
    <ul className="agent-recommended-list" aria-label="Recommended alerts">{entries.map(entry => <li key={entry.name}>
      <label><input type="checkbox" checked={entry.exists || chosen.has(entry.name)} disabled={entry.exists}
        onChange={() => setChosen(current => { const next = new Set(current); if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name); return next })} /> {entry.name}{entry.exists && <span className="field-note"> · already on the server</span>}</label>
    </li>)}</ul>
    <label>Notify <select className="property-input" value={operator} onChange={event => setOperator(event.target.value)} aria-label="Notify operator">
      <option value="">(Nobody)</option>
      {model.operators.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
    </select></label>
    {operator && <span role="group" aria-label="Notify by">{[notifyEmail, notifyPager].map(bit => <label key={bit}><input type="checkbox" checked={(methods & bit) !== 0} onChange={() => setMethods(methods ^ bit)} /> {bit === notifyEmail ? 'E-mail' : 'Pager'}</label>)}</span>}
    <label>Delay between responses (minutes) <input className="property-input" type="number" min={0} max={agentLimits.alertDelaySeconds / 60} value={delay} onChange={event => setDelay(Math.max(0, Math.min(agentLimits.alertDelaySeconds / 60, Math.round(Number(event.target.value) || 0))))} /></label>
  </SubDialog>
}

function JobsTable({ state, jobs }: { readonly state: State; readonly jobs: readonly AgentJobNotifyRow[] }) {
  const { jobDocuments, documents, commands } = useWorkbench()
  const connectionId = documents.get(state.id)?.connectionId
  return <div className="agent-operators-jobs-pane">
    <div className="agent-operators-jobs-scroll">
      <section className="agent-operators-jobs" aria-label="Jobs that notify operators">
        {jobs.length === 0 ? <p className="field-note">No jobs currently notify an operator on completion.</p>
          : <table className="agent-table borderless">
            <thead><tr><th scope="col">Job</th><th scope="col">E-mail</th><th scope="col">Page</th><th scope="col"><span className="visually-hidden">Open</span></th></tr></thead>
            <tbody>{jobs.map(job => <tr key={job.id}><th scope="row">{job.name}</th><td>{job.email || '—'}</td><td>{job.page || '—'}</td>
              <td><button type="button" aria-label={`Open ${job.name}`} disabled={!connectionId} onClick={() => { if (connectionId) reported(commands, () => jobDocuments.openJob(connectionId, job.name), 'The job could not be opened.') }}>Open job</button></td>
            </tr>)}</tbody>
          </table>}
      </section>
    </div>
    <div className="agent-operators-foot">
      <p className="field-note">A job's notifications are changed in its own document.</p>
    </div>
  </div>
}

export default function OperatorsDocument({ documentId }: { documentId: string }) {
  const { operatorsDocuments, commands } = useWorkbench()
  const { documents } = useServiceSnapshot(operatorsDocuments)
  const [selected, setSelected] = useState<string>()
  const [activeTab, setActiveTab] = useState<'matrix' | 'jobs'>('matrix')
  const [chosen, setDialog] = useState<'delete' | 'recommended'>()
  const state = documents[documentId]
  // Add recommended alerts from the Alerts folder asks for its dialog once the grid has read the server.
  const askable = !!state?.model?.sysadmin && !!state.model.alerts && !state.model.readOnly && state.changes === 0
  const dialog = chosen ?? (state?.ask && askable ? state.ask : undefined)
  useEffect(() => {
    if (!state?.ask || !state.model || askable) return
    operatorsDocuments.setAsk(state.id, undefined)
    commands.reportError(state.changes > 0 ? agentObjectText.saveFirst : state.model.readOnly ?? (state.model.platform === 'windows' ? agentAlertText.readAlertsDenied : agentAlertText.platformAlerts))
  }, [state?.ask, state?.model, state?.id, state?.changes, askable, operatorsDocuments, commands])
  if (!state) return <div className="agent-operators-document" />
  const { model, draft } = state
  const editable = operatorsDocuments.canEdit(state.id)
  const args = { tabId: state.id }
  const verbs: Verb[] = [{ command: 'agentOperators.reload', args, label: 'Reload' }, { command: 'agentOperators.save', args, label: state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save', emphasis: 'primary' }]
  const operator = model?.operators.find(item => item.name === selected) ?? model?.operators[0]
  const notifyingJobs = (model?.jobs ?? []).filter(job => job.email || job.page || job.netSend)
  const loadingOrError = state.phase === 'loading'
    ? <div className="agent-operators-empty"><Skeleton rows={4} label="Reading the operators" /></div>
    : <div className="agent-operators-empty"><p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the operators could not be read.' : ''}</p></div>
  const matrixContent = !model || !draft ? loadingOrError : (
    <ResizableSplit className="agent-operators-split" mainClassName="agent-operators-main" side="right" storageKey="agent.operators.side"
      defaultWidth={264} minWidth={220} maxWidth={400} minOtherWidth={380} narrowStackWidth={600} railOpen={!!operator}
      label="Resize selected operator rail"
      rail={operator ? <SidePane state={state} model={model} operator={operator} service={operatorsDocuments} onDelete={() => setDialog('delete')} /> : null}>
      <Grid state={state} model={model} draft={draft} editable={editable} service={operatorsDocuments} {...operator ? { selected: operator.name } : {}} onSelect={setSelected} />
    </ResizableSplit>
  )
  const jobsContent = !model || !draft ? loadingOrError : <JobsTable state={state} jobs={notifyingJobs} />
  const tabs: InspectorTab[] = [
    {
      id: 'matrix', title: 'Alerts Matrix', layout: 'fill',
      count: model?.alerts?.length, modified: state.changes > 0,
      problem: operatorsDocuments.problems(state.id).some(problem => problem.severity === 'error'),
      content: matrixContent
    },
    {
      id: 'jobs', title: 'Jobs Notifying Operators', layout: 'fill',
      count: model ? notifyingJobs.length : undefined,
      content: jobsContent
    }
  ]
  const phaseLabel = state.phase === 'loading' ? 'Reading the operators…' : state.phase === 'saving' ? 'Saving the notifications…' : state.busy
  const recovery = state.phase === 'loadFailed' || state.unread || state.error?.code === 'NOT_FOUND' ? [{ label: 'Reload', run: () => operatorsDocuments.reload(state.id) }] : []
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && <InlineError message={state.error.message} code={state.error.code} context={`Operators on ${state.server}`} actions={recovery} />}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnly && <p className="document-status"><Icon name="lock" />{model.readOnly}</p>}
  </>
  const tools = model?.sysadmin ? <span className="agent-operators-tools">
    <button type="button" disabled={!operatorsDocuments.canReload(state.id) || !model.alerts || state.changes > 0} title={state.changes > 0 ? agentObjectText.saveFirst : undefined} onClick={() => setDialog('recommended')}><Icon name="check" />Add recommended alerts…</button>
    <button type="button" onClick={() => void commands.execute('agent.newOperator', { tabId: state.id }, 'toolbar')}><Icon name="add" />New operator</button>
  </span> : null
  return <>
    <ObjectInspectorFrame id={`agent-operators-${state.id}`} surface="full" title="Operators and notifications" subtitle="SQL Server Agent"
      crumbs={[{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Operators' }]}
      tools={tools} verbs={verbs} banner={banner} tabs={tabs} activeTab={activeTab} onSelectTab={id => setActiveTab(id as 'matrix' | 'jobs')}
      attributes={{ 'data-agent-operators': state.id }}
      script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void operatorsDocuments.deliver(state.id, destination) }}
      scriptOpen={state.frame.scriptOpen} scriptSize={state.frame.scriptSize}
      onScriptToggle={() => operatorsDocuments.setFrame(state.id, setScriptOpen(state.frame, !state.frame.scriptOpen))}
      onScriptResize={size => operatorsDocuments.setFrame(state.id, resizeScript(state.frame, size))} />
    {dialog === 'delete' && operator && model && <DeleteOperator state={state} model={model} operator={operator} service={operatorsDocuments} onClose={() => setDialog(undefined)} />}
    {dialog === 'recommended' && model && <AddRecommended state={state} model={model} service={operatorsDocuments} onClose={() => { setDialog(undefined); operatorsDocuments.setAsk(state.id, undefined) }} />}
  </>
}
