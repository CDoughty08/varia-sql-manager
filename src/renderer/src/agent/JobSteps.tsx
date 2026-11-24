// The job document's Steps section (AG-6b, docs/sql-server-agent.md › Steps; mocks rx-job-steps, rx-step-ssis, rx-step-ps, rx-step-cmdexec,
// rx-step-delete): the steps list (drag to reorder, ✓ and ✗ targets, the Start step) beside the selected step's editor, edited in place.
// T-SQL commands are edited in the query editor with the step's database (completion, Parse, Open in query window); an SSIS step is one
// scroll with an inline SSISDB picker; SSMS's Advanced page is the More options fold. JobDocumentService keeps every state.
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import type { editor } from 'monaco-editor'
import { agentLimits, stepActions } from '../../../shared/agent/catalog.ts'
import {
  serverSubsystems, stepFlagChoices, stepOutputSubsystems, stepFlagsWith, stepOptionsSummary, stepTargetShort, stepText, stepTypeLabel, stepTypeShort, type AgentStepDraft, type AgentStepField,
  type AgentStepProblem, type StepAction
} from '../../../shared/agent/steps.ts'
import {
  buildSsisCommand, newSsisCommand, parseSsisCommand, ssisAdvancedSummary, ssisLoggingLevels, ssisPackagePath, ssisParameterRows, ssisSourceLabel, withSsisPackage, withSsisParameter,
  type SsisStepCommand
} from '../../../shared/agent/ssis-step.ts'
import type { AgentJobDocumentModel, AgentJobDraft } from '../../../shared/actions/agent-job.ts'
import { isStepScriptSubsystem, stepScriptText } from '../../../shared/agent/step-file.ts'
import { useWorkbench } from '../core/WorkbenchContext'
import { createQueryEditor, type QueryEditorInstance } from '../editor/create-editor'
import { registerSqlModel } from '../explorer/peek-editor'
import Icon from '../Icon'
import type { JobDocumentService, JobDocumentState } from './JobDocumentService'

/** The step types the Type switch shows first, as SSMS users reach for them; the rest are under More. */
const mainTypes = ['TSQL', 'PowerShell', 'CmdExec', 'SSIS'] as const
const stepLanguage = (subsystem: string) => subsystem === 'TSQL' ? 'sql' : subsystem === 'PowerShell' ? 'powershell' : subsystem === 'CmdExec' ? 'bat' : 'plaintext'
const stepEditorContextKey = 'variaStepEditor'

interface StepsProps {
  readonly state: JobDocumentState
  readonly model: AgentJobDocumentModel
  readonly draft: AgentJobDraft
  readonly editable: boolean
  readonly service: JobDocumentService
}

/** One field's error (else its warnings) on the selected step. */
function problemText(problems: readonly AgentStepProblem[], key: string, field: AgentStepField): { error?: string; note?: string } {
  const own = problems.filter(problem => problem.key === key && problem.field === field)
  const error = own.find(problem => problem.severity === 'error')?.message
  const notes = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...notes.length ? { note: notes.join(' ') } : {} }
}
function FieldMessages({ text, id }: { readonly text: { error?: string; note?: string }; readonly id: string }) {
  return <>
    {text.error && <p className="property-field-error" id={`${id}-error`} role="alert"><Icon name="error" />{text.error}</p>}
    {text.note && <p className="field-note" id={`${id}-note`}><Icon name="warning" />{text.note}</p>}
  </>
}

/** Puts `text` in place of step `key`'s whole command as one edit the editor's Undo takes back (Load from file…), keeping the file's line
 *  endings; false when that step's model is not the one showing (the caller then writes the editable draft) or the editor is read-only. */
interface StepCommandHandle { replace(key: string, text: string): boolean }
/** The command's editor: the query editor (Tools › Options, Find) on a model per step, served by the language service with the step's
 *  connection and database when it is T-SQL. */
/** `epoch` changes each time the job is read: a save renumbers steps, so `s1` may then be another step, and a model (with its undo stack)
 *  is never carried from one read to the next. */
function StepCommandEditor({ epoch, stepKey: key, value, subsystem, connectionId, database, readOnly, label, onChange, handle }: {
  readonly epoch: string; readonly stepKey: string; readonly value: string; readonly subsystem: string; readonly connectionId?: string; readonly database?: string; readonly readOnly: boolean
  readonly label: string; readonly onChange: (value: string) => void; readonly handle?: RefObject<StepCommandHandle | null>
}) {
  const workbench = useWorkbench()
  const stepKey = `${epoch}|${key}`
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<QueryEditorInstance | undefined>(undefined)
  const models = useRef(new Map<string, { model: editor.ITextModel; documentId: string }>())
  const changed = useRef(onChange)
  changed.current = onChange
  useEffect(() => {
    const element = host.current
    if (!element) return
    instance.current = createQueryEditor(workbench, element, { compact: true, ariaLabel: label, contextKey: stepEditorContextKey, inEditorPane: false })
    const owned = models.current
    return () => { instance.current?.dispose(); instance.current = undefined; for (const entry of owned.values()) entry.model.dispose(); owned.clear() }
  // The editor lives as long as the section; each step gets its own model below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const view = instance.current
    if (!view) return
    let entry = models.current.get(stepKey)
    for (const [cached, stale] of models.current) if (!cached.startsWith(`${epoch}|`)) { stale.model.dispose(); models.current.delete(cached) }
    if (!entry || entry.model.isDisposed()) {
      const documentId = crypto.randomUUID()
      const model = workbench.monaco.editor.createModel(value, stepLanguage(subsystem), workbench.monaco.Uri.parse(`varia-sql://step/${documentId}`))
      entry = { model, documentId }
      models.current.set(stepKey, entry)
    }
    const { model, documentId } = entry
    if (model.getLanguageId() !== stepLanguage(subsystem)) workbench.monaco.editor.setModelLanguage(model, stepLanguage(subsystem))
    if (connectionId) registerSqlModel(model, { documentId, connectionId, ...database ? { database } : {}, editable: true })
    if (view.instance.getModel() !== model) view.instance.setModel(model)
    const listener = model.onDidChangeContent(() => changed.current(model.getValue()))
    return () => listener.dispose()
  // `value` is applied by the effect below, so typing does not reset the model.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, subsystem, connectionId, database, workbench])
  useEffect(() => {
    const model = models.current.get(stepKey)?.model
    if (model && !model.isDisposed() && model.getValue() !== value) model.setValue(value)
  }, [stepKey, value])
  useEffect(() => { instance.current?.instance.updateOptions({ readOnly }) }, [readOnly])
  useEffect(() => {
    if (!handle) return
    handle.current = {
      replace: (target, text) => {
        const view = instance.current?.instance, model = models.current.get(`${epoch}|${target}`)?.model
        if (!view || readOnly || !model || model.isDisposed() || view.getModel() !== model) return false
        // Stops on both sides, so one Undo takes back exactly the load; the content listener then writes the draft, which marks it dirty.
        view.pushUndoStop()
        // Monaco rewrites inserted line breaks to the model's: the model takes the file's (CRLF if it has any), inside the same undo step,
        // so a CRLF .bat keeps CRLF (a mixed file becomes all CRLF, a little longer; Save's limit still applies).
        const eol = text.includes('\r\n') ? workbench.monaco.editor.EndOfLineSequence.CRLF : workbench.monaco.editor.EndOfLineSequence.LF
        if (model.getEndOfLineSequence() !== eol) model.pushEOL(eol)
        const applied = view.executeEdits('agent-step-load-file', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }])
        view.pushUndoStop()
        if (applied) view.setPosition({ lineNumber: 1, column: 1 })
        return applied
      }
    }
    return () => { handle.current = null }
  }, [handle, epoch, readOnly, workbench])
  return <div className="agent-step-editor"><div ref={host} className="agent-step-editor-host" /></div>
}

/** Run as: the SQL Server Agent service account (sysadmin) and the proxies active for the step's type; others are listed disabled, saying why. */
function RunAs({ step, model, editable, problems, update, id }: { readonly step: AgentStepDraft; readonly model: AgentJobDocumentModel; readonly editable: boolean; readonly problems: readonly AgentStepProblem[]; readonly update: (patch: Partial<AgentStepDraft>) => void; readonly id: string }) {
  if (step.subsystem === 'TSQL') return null
  const proxies = model.proxies
  const text = problemText(problems, step.key, 'runAs')
  const known = !proxies || step.proxyId === 0 || proxies.some(proxy => proxy.id === step.proxyId)
  return <div className="agent-step-row">
    <label htmlFor={id}>Run as</label>
    <div>
      <select id={id} className="property-input" value={step.proxyId} disabled={!editable} aria-invalid={text.error ? true : undefined}
        onChange={event => update({ proxyId: Number(event.target.value) })}>
        <option value={0} disabled={!model.sysadmin && step.proxyId !== 0}>{stepText.serviceAccount}</option>
        {!known && <option value={step.proxyId}>{`Proxy ${step.proxyId}`}</option>}
        {(proxies ?? []).map(proxy => {
          const active = proxy.subsystems.some(subsystem => subsystem.toLowerCase() === step.subsystem.toLowerCase())
          return <option key={proxy.id} value={proxy.id} disabled={!active && proxy.id !== step.proxyId}>
            {proxy.name}{proxy.identity ? ` (${proxy.identity})` : ''}{active ? '' : ` · not active for ${stepTypeShort(step.subsystem)}`}{proxy.enabled ? '' : ' · disabled'}
          </option>
        })}
      </select>
      <FieldMessages text={text} id={id} />
    </div>
  </div>
}

/** On success and On failure: an action, and for "Go to step" the step by its position. */
function Target({ state, step, which, editable, problems, update, id }: { readonly state: JobDocumentState; readonly step: AgentStepDraft; readonly which: 'onSuccess' | 'onFail'; readonly editable: boolean; readonly problems: readonly AgentStepProblem[]; readonly update: (patch: Partial<AgentStepDraft>) => void; readonly id: string }) {
  const steps = state.draft!.steps.steps
  const target = which === 'onSuccess' ? step.onSuccessTarget : step.onFailTarget
  const targetKey = which === 'onSuccess' ? 'onSuccessTarget' : 'onFailTarget'
  const value = step[which] === 4 ? `goto:${target ?? ''}` : String(step[which])
  const text = problemText(problems, step.key, which)
  const missing = step[which] === 4 && (!target || !steps.some(item => item.key === target))
  return <div className="agent-step-row">
    <label htmlFor={id}>{which === 'onSuccess' ? 'On success' : 'On failure'}</label>
    <div>
      <select id={id} className="property-input" value={value} disabled={!editable} aria-invalid={text.error ? true : undefined}
        onChange={event => {
          const next = event.target.value
          if (next.startsWith('goto:')) update({ [which]: 4, [targetKey]: next.slice(5) } as Partial<AgentStepDraft>)
          else update({ [which]: Number(next) as StepAction, [targetKey]: undefined } as Partial<AgentStepDraft>)
        }}>
        {stepActions.filter(action => action.code !== 4).map(action => <option key={action.code} value={action.code}>{action.label}</option>)}
        {missing && <option value={value}>{stepTargetShort(state.draft!.steps, step, which === 'onSuccess' ? 'success' : 'fail')}</option>}
        {steps.map((item, at) => item.key === step.key ? null : <option key={item.key} value={`goto:${item.key}`}>{`Go to step ${at + 1}: ${item.name}`}</option>)}
      </select>
      <FieldMessages text={text} id={id} />
    </div>
  </div>
}

/** More options: SSMS's Advanced page, folded, showing only the fields the step's type uses. */
function MoreOptions({ step, model, editable, problems, update, id }: { readonly step: AgentStepDraft; readonly model: AgentJobDocumentModel; readonly editable: boolean; readonly problems: readonly AgentStepProblem[]; readonly update: (patch: Partial<AgentStepDraft>) => void; readonly id: string }) {
  const [open, setOpen] = useState(false)
  const choices = stepFlagChoices(step)
  const flags = (patch: Parameters<typeof stepFlagsWith>[1]) => update({ flags: stepFlagsWith(step, patch) })
  const output = problemText(problems, step.key, 'output'), user = problemText(problems, step.key, 'runAsUser')
  const tsql = step.subsystem === 'TSQL'
  return <div className="agent-step-more">
    <button type="button" className="agent-step-fold" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(!open)}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} />More options{!open && <span className="agent-step-summary">{stepOptionsSummary(step)}</span>}
    </button>
    {open && <div id={`${id}-panel`} className="agent-step-grid">
      <div className="agent-step-row">
        <label htmlFor={`${id}-retries`}>Retry attempts</label>
        <span className="agent-step-inline">
          <input id={`${id}-retries`} className="property-input agent-step-short" type="number" min={0} max={9999} value={step.retryAttempts} disabled={!editable}
            onChange={event => update({ retryAttempts: Math.max(0, Math.min(9999, Math.trunc(Number(event.target.value) || 0))) })} />
          <label htmlFor={`${id}-interval`}>every</label>
          <input id={`${id}-interval`} className="property-input agent-step-short" type="number" min={0} max={9999} value={step.retryInterval} disabled={!editable}
            onChange={event => update({ retryInterval: Math.max(0, Math.min(9999, Math.trunc(Number(event.target.value) || 0))) })} />
          <span>minutes</span>
        </span>
      </div>
      {stepOutputSubsystems.has(step.subsystem) && <><div className="agent-step-row">
        <label htmlFor={`${id}-output`}>Output file</label>
        <div>
          <span className="agent-step-inline">
            <input id={`${id}-output`} className="property-input agent-step-path" type="text" maxLength={201} spellCheck={false} value={step.outputFileName} disabled={!editable}
              aria-invalid={output.error ? true : undefined} onChange={event => update({ outputFileName: event.target.value })} />
            <label><input type="checkbox" checked={choices.appendOutput} disabled={!editable || !step.outputFileName} onChange={event => flags({ appendOutput: event.target.checked })} />Append</label>
          </span>
          <FieldMessages text={output} id={`${id}-output`} />
        </div>
      </div>
      <div className="agent-step-row">
        <span>Log to table</span>
        <span className="agent-step-inline">
          <label><input type="checkbox" checked={choices.logToTable} disabled={!editable} onChange={event => flags({ logToTable: event.target.checked, ...event.target.checked ? {} : { appendTable: false } })} />Log to table</label>
          <label><input type="checkbox" checked={choices.appendTable} disabled={!editable || !choices.logToTable} onChange={event => flags({ appendTable: event.target.checked })} />Append output to existing entry in table</label>
        </span>
      </div></>}
      {!stepOutputSubsystems.has(step.subsystem) && output.error && <FieldMessages text={output} id={`${id}-output`} />}
      <div className="agent-step-row">
        <span>Step output</span>
        <label><input type="checkbox" checked={choices.includeOutput} disabled={!editable} onChange={event => flags({ includeOutput: event.target.checked })} />Include step output in history</label>
      </div>
      {tsql && <div className="agent-step-row">
        <label htmlFor={`${id}-user`}>Run as user</label>
        <div>
          <input id={`${id}-user`} className="property-input" type="text" maxLength={128} spellCheck={false} value={step.databaseUserName} disabled={!editable || !model.sysadmin}
            onChange={event => update({ databaseUserName: event.target.value })} />
          <FieldMessages text={user} id={`${id}-user`} />
        </div>
      </div>}
      {!tsql && <p className="field-note">Run as user applies only to T-SQL steps, so it is not shown here.</p>}
    </div>}
  </div>
}

/** The SSIS step on one scroll (rx-step-ssis): the package from an inline SSISDB picker, server, environment and 32-bit runtime, every
 *  parameter with where its value comes from, and Advanced folded. A command Varia cannot lay out stays text. */
function SsisSection({ state, step, editable, update, service, id }: { readonly state: JobDocumentState; readonly step: AgentStepDraft; readonly editable: boolean; readonly update: (patch: Partial<AgentStepDraft>) => void; readonly service: JobDocumentService; readonly id: string }) {
  const parsed = step.command.trim() ? parseSsisCommand(step.command) : undefined
  const picker = state.ssis
  const [advanced, setAdvanced] = useState(false)
  const [filter, setFilter] = useState('')
  useEffect(() => { void service.loadSsisFolders(state.id) }, [service, state.id])
  useEffect(() => { if (parsed) void service.loadSsisPackage(state.id, parsed.folder, parsed.project, parsed.package) }, [service, state.id, parsed?.folder, parsed?.project, parsed?.package])
  const write = (command: SsisStepCommand) => update({ command: buildSsisCommand(command) })
  const choose = (folder: string, project: string, packageName: string) => write(parsed ? withSsisPackage(parsed, folder, project, packageName) : newSsisCommand(state.server, folder, project, packageName))
  const projectModel = parsed ? picker?.projectModels[`${parsed.folder}\\${parsed.project}`] : undefined
  const packageModel = parsed ? picker?.packageModels[`${parsed.folder}\\${parsed.project}\\${parsed.package}`] : undefined
  const openProject = picker?.open ?? (parsed ? `${parsed.folder}\\${parsed.project}` : undefined)
  const rows = parsed && projectModel && packageModel ? ssisParameterRows(parsed, projectModel.parameters, packageModel.parameters) : undefined
  const needle = filter.trim().toLowerCase()
  return <div className="agent-step-ssis">
    <section className="agent-step-sec" aria-labelledby={`${id}-package-h`}>
      <h4 id={`${id}-package-h`}>Package <span className="field-note">SSIS Catalog</span></h4>
      <div className="agent-step-ssis-pick">
        <div role="tree" aria-label="Packages in SSISDB" className="agent-step-ssis-tree">
          <input className="property-input" type="search" placeholder="Find a package in SSISDB" aria-label="Find a package in SSISDB" value={filter} onChange={event => setFilter(event.target.value)} />
          {picker?.error && <p className="property-field-error" role="alert"><Icon name="error" />{picker.error}</p>}
          {!picker?.folders && !picker?.error && <p className="field-note"><Icon name="loading" spin />Reading SSISDB…</p>}
          {picker?.folders?.length === 0 && <p className="field-note">SSISDB has no folders this login can read.</p>}
          {(picker?.folders ?? []).map(folder => {
            const projects = picker?.projects[folder]
            return <div key={folder} role="treeitem" aria-expanded={!!projects} aria-selected={false}>
              <button type="button" className="agent-step-tree-row" onClick={() => void service.loadSsisProjects(state.id, folder)}><Icon name={projects ? 'chevron-down' : 'chevron-right'} /><Icon name="folder" />{folder}</button>
              {projects && <div role="group">{projects.map(project => {
                const browsed = picker?.projectModels[`${folder}\\${project}`], open = openProject === `${folder}\\${project}` && !!browsed
                const packages = open ? browsed!.packages.filter(item => !needle || item.name.toLowerCase().includes(needle)) : []
                return <div key={project} role="treeitem" aria-expanded={open} aria-selected={false}>
                  <button type="button" className="agent-step-tree-row agent-step-tree-2" onClick={() => void service.loadSsisPackage(state.id, folder, project, undefined, true)}><Icon name={open ? 'chevron-down' : 'chevron-right'} /><Icon name="project" />{project}</button>
                  {open && <div role="group">{packages.map(item => {
                    const selected = parsed?.folder === folder && parsed.project === project && parsed.package === item.name
                    return <div key={item.name} role="treeitem" aria-selected={selected}>
                      <button type="button" className="agent-step-tree-row agent-step-tree-3" disabled={!editable} data-selected={selected || undefined} onClick={() => choose(folder, project, item.name)}><Icon name="ssis-package" />{item.name}</button>
                    </div>
                  })}</div>}
                </div>
              })}</div>}
            </div>
          })}
        </div>
        {parsed && <div className="agent-step-grid">
          <div className="agent-step-row"><label htmlFor={`${id}-server`}>Server</label>
            <input id={`${id}-server`} className="property-input" type="text" maxLength={128} spellCheck={false} value={parsed.server} disabled={!editable} onChange={event => write({ ...parsed, server: event.target.value })} /></div>
          <div className="agent-step-row"><label htmlFor={`${id}-env`}>Environment</label>
            <select id={`${id}-env`} className="property-input" value={parsed.environmentReference ?? ''} disabled={!editable}
              onChange={event => write({ ...parsed, environmentReference: event.target.value === '' ? undefined : Number(event.target.value) })}>
              <option value="">None</option>
              {parsed.environmentReference !== undefined && !projectModel?.references.some(item => item.id === parsed.environmentReference) && <option value={parsed.environmentReference}>{`Reference ${parsed.environmentReference}`}</option>}
              {(projectModel?.references ?? []).map(item => <option key={item.id} value={item.id}>{item.folder ? `${item.folder} › ${item.environment}` : item.environment}</option>)}
            </select></div>
          <div className="agent-step-row"><span>Runtime</span>
            <label><input type="checkbox" checked={parsed.x86} disabled={!editable} onChange={event => write({ ...parsed, x86: event.target.checked })} />32-bit</label></div>
        </div>}
      </div>
      {parsed && <p className="agent-step-runs"><span className="field-note">Runs</span> <code>{ssisPackagePath(parsed)}</code></p>}
    </section>
    {parsed && <section className="agent-step-sec" aria-labelledby={`${id}-params-h`}>
      <h4 id={`${id}-params-h`}>Parameters</h4>
      {!rows ? <p className="field-note"><Icon name="loading" spin />Reading the package's parameters…</p>
        : rows.length === 0 ? <p className="field-note">The package and its project have no parameters.</p>
          : <table className="properties-table" aria-label="Parameters">
            <thead><tr><th scope="col">Parameter</th><th scope="col">Value</th><th scope="col">Comes from</th></tr></thead>
            <tbody>{rows.map(row => {
              const missing = row.required && row.source === 'none'
              return <tr key={`${row.scope}:${row.name}`} data-default={row.source === 'default' || undefined} data-missing={missing || undefined}>
                <th scope="row">{row.name}{row.required && <span className="agent-step-tag" data-tone={missing ? 'warning' : undefined}>required</span>}<span className="field-note"> · {row.scope === 'project' ? 'Project' : 'Package'}</span></th>
                <td>{row.sensitive ? <span className="field-note">sensitive</span>
                  : <input className="property-input" type="text" spellCheck={false} aria-label={`${row.name} value`} disabled={!editable} value={row.source === 'step' ? row.value ?? '' : ''} placeholder={row.value ?? (missing ? 'no value' : '')}
                    onChange={event => write(withSsisParameter(parsed, row.scope, row.name, event.target.value === '' ? undefined : event.target.value, row.dataType))} />}</td>
                <td>{ssisSourceLabel[row.source]}{row.source === 'environment' && row.value ? ` ${row.value}` : ''}</td>
              </tr>
            })}</tbody>
          </table>}
    </section>}
    {parsed && <div className="agent-step-more">
      <button type="button" className="agent-step-fold" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)}>
        <Icon name={advanced ? 'chevron-down' : 'chevron-right'} />Advanced{!advanced && <span className="agent-step-summary">{ssisAdvancedSummary(parsed)}</span>}
      </button>
      {advanced && <div id={`${id}-advanced`} className="agent-step-grid">
        <div className="agent-step-row"><label htmlFor={`${id}-logging`}>Logging level</label>
          <select id={`${id}-logging`} className="property-input" value={parsed.loggingLevel ?? ''} disabled={!editable} onChange={event => write({ ...parsed, loggingLevel: event.target.value === '' ? undefined : Number(event.target.value) })}>
            <option value="">The catalog's default</option>
            {ssisLoggingLevels.map(level => <option key={level.code} value={level.code}>{level.label}</option>)}
          </select></div>
        <div className="agent-step-row"><span>Dump on errors</span>
          <label><input type="checkbox" checked={!!parsed.dumpOnError} disabled={!editable} onChange={event => write({ ...parsed, dumpOnError: event.target.checked || undefined })} />Dump on errors</label></div>
        {parsed.extra.length > 0 && <p className="field-note">{`${parsed.extra.length} property ${parsed.extra.length === 1 ? 'override is' : 'overrides are'} kept as written.`}</p>}
      </div>}
    </div>}
  </div>
}

/** The selected step's editor pane. */
function StepEditor(props: StepsProps & { readonly step: AgentStepDraft; readonly position: number; readonly problems: readonly AgentStepProblem[] }) {
  const { state, model, editable, service, step, position, problems } = props
  const id = `agent-step-${state.id}`
  const update = (patch: Partial<AgentStepDraft>) => service.updateStep(state.id, step.key, patch)
  // An SSIS step shows fields or text as it was when opened (or its type was chosen), not as each keystroke leaves it, so typing never swaps
  // the editor away; Show as fields switches once the text parses.
  const ssisAsText = () => step.subsystem === 'SSIS' && !!step.command.trim() && !parseSsisCommand(step.command)
  const [ssisText, setSsisText] = useState(ssisAsText)
  const [decided, setDecided] = useState(`${step.key} ${step.subsystem}`)
  if (decided !== `${step.key} ${step.subsystem}`) { setDecided(`${step.key} ${step.subsystem}`); setSsisText(ssisAsText()) }
  const types = model.subsystems?.length ? model.subsystems : [...mainTypes]
  const more = types.filter(type => !(mainTypes as readonly string[]).includes(type))
  const name = problemText(problems, step.key, 'name'), command = problemText(problems, step.key, 'command'), server = problemText(problems, step.key, 'server')
  const proxy = step.proxyId ? model.proxies?.find(item => item.id === step.proxyId) : undefined
  const account = proxy ? proxy.identity ?? proxy.name : 'the SQL Server Agent service account'
  const parse = state.parse?.key === step.key ? state.parse : undefined
  const databases = model.databases && step.databaseName && !model.databases.includes(step.databaseName) ? [step.databaseName, ...model.databases] : model.databases
  const count = state.draft!.steps.steps.length
  const commandEditor = useRef<StepCommandHandle | null>(null)
  const stepFile = state.stepFile?.key === step.key && isStepScriptSubsystem(step.subsystem) ? state.stepFile : undefined
  // Load from file… (AG-11): main's dialog and read; the text replaces the command as one undoable edit, or the draft when the step is still
  // selected but its editor is not mounted.
  const loadFile = async () => {
    const text = await service.loadStepScript(state.id, step.key)
    if (text !== undefined && !commandEditor.current?.replace(step.key, text)) service.updateStep(state.id, step.key, { command: text })
  }
  return <div className="agent-step-edit" role="group" aria-label={`Step ${position + 1}: ${step.name || 'unnamed'}`}>
    <div className="agent-step-tools">
      <button type="button" disabled={!editable || position === 0} onClick={() => service.moveStepBy(state.id, step.key, -1)}><Icon name="arrow-up" />Move up</button>
      <button type="button" disabled={!editable || position === count - 1} onClick={() => service.moveStepBy(state.id, step.key, 1)}><Icon name="arrow-down" />Move down</button>
      <button type="button" disabled={!editable || state.draft!.steps.startKey === step.key} onClick={() => service.setStartStep(state.id, step.key)}><Icon name="pin" />Make Start step</button>
      <button type="button" className="danger" disabled={!editable} onClick={() => service.deleteStepOf(state.id, step.key)}><Icon name="trash" />Delete</button>
    </div>
    <div className="agent-step-grid">
      <div className="agent-step-row">
        <label htmlFor={`${id}-name`}>Step name</label>
        <div>
          <input id={`${id}-name`} className="property-input" type="text" maxLength={129} spellCheck={false} value={step.name} disabled={!editable} aria-invalid={name.error ? true : undefined}
            onChange={event => update({ name: event.target.value })} />
          <FieldMessages text={name} id={`${id}-name`} />
        </div>
      </div>
      <div className="agent-step-row">
        <span id={`${id}-type-label`}>Type</span>
        <span className="agent-step-inline">
          <span className="segmented" role="radiogroup" aria-labelledby={`${id}-type-label`}>
            {mainTypes.filter(type => types.includes(type) || step.subsystem === type).map(type =>
              <button key={type} type="button" role="radio" className="segmented-option" aria-checked={step.subsystem === type} disabled={!editable} onClick={() => update({ subsystem: type })}>{stepTypeLabel(type).replace('Transact-SQL script (T-SQL)', 'Transact-SQL (T-SQL)').replace('SQL Server Integration Services Package', 'SSIS package').replace('Operating system (CmdExec)', 'CmdExec')}</button>)}
          </span>
          {(more.length > 0 || !(mainTypes as readonly string[]).includes(step.subsystem)) && <select className="property-input" aria-label="More step types" disabled={!editable}
            value={(mainTypes as readonly string[]).includes(step.subsystem) ? '' : step.subsystem} onChange={event => { if (event.target.value) update({ subsystem: event.target.value }) }}>
            <option value="">More…</option>
            {[...new Set([...more, ...(mainTypes as readonly string[]).includes(step.subsystem) ? [] : [step.subsystem]])].map(type => <option key={type} value={type}>{stepTypeLabel(type)}</option>)}
          </select>}
        </span>
      </div>
      {step.subsystem === 'TSQL' && <div className="agent-step-row">
        <label htmlFor={`${id}-database`}>Database</label>
        {databases ? <select id={`${id}-database`} className="property-input" value={step.databaseName} disabled={!editable} onChange={event => update({ databaseName: event.target.value })}>
          {databases.map(database => <option key={database} value={database}>{database}</option>)}
        </select> : <input id={`${id}-database`} className="property-input" type="text" maxLength={128} spellCheck={false} value={step.databaseName} disabled={!editable} onChange={event => update({ databaseName: event.target.value })} />}
      </div>}
      <RunAs step={step} model={model} editable={editable} problems={problems} update={update} id={`${id}-runas`} />
    </div>
    {step.subsystem === 'SSIS' && !ssisText && (!step.command.trim() || parseSsisCommand(step.command)) ? <SsisSection state={state} step={step} editable={editable} update={update} service={service} id={id} /> : <div className="agent-step-command">
      <div className="agent-step-command-head">
        <span id={`${id}-command-label`}>Command</span>
        {step.subsystem === 'SSIS' && <span className="field-note"><Icon name="info" />{stepText.unmodelled}</span>}
        {step.subsystem === 'SSIS' && (!step.command.trim() || parseSsisCommand(step.command)) && <button type="button" onClick={() => setSsisText(false)}>Show as fields</button>}
        <span className="agent-step-inline">
          {step.subsystem === 'TSQL' && <button type="button" onClick={() => void service.parseStep(state.id, step.key)} disabled={parse?.running}><Icon name="check" />Parse</button>}
          {step.subsystem === 'TSQL' && <button type="button" onClick={() => service.openStepInQuery(state.id, step.key)}><Icon name="link-external" />Open in query window</button>}
          {isStepScriptSubsystem(step.subsystem) && <button type="button" disabled={!editable || state.stepFile?.running} onClick={() => void loadFile()}><Icon name="file" />{stepScriptText.load}</button>}
        </span>
      </div>
      <StepCommandEditor epoch={`${model.job?.jobId ?? 'new'} ${model.job?.version ?? 0} ${model.job?.modified ?? ''}`} stepKey={step.key} value={step.command} subsystem={step.subsystem} connectionId={service.connectionId(state.id)} {...step.subsystem === 'TSQL' && step.databaseName ? { database: step.databaseName } : {}}
        readOnly={!editable} label={`Step ${position + 1} command`} onChange={value => update({ command: value })} handle={commandEditor} />
      <FieldMessages text={command} id={`${id}-command`} />
      {stepFile?.failure && <p className="property-field-error" role="alert"><Icon name="error" />{stepFile.failure}</p>}
      {parse && <div className="agent-step-parse" role="status">
        {parse.running ? <p><Icon name="loading" spin />Parsing…</p>
          : parse.failure ? <p className="property-field-error"><Icon name="error" />{parse.failure}</p>
            : parse.errors?.length ? <ul aria-label="Parse errors">{parse.errors.map((error, at) => <li key={at}><Icon name="error" />{`Line ${error.line}, column ${error.column}: ${error.message}`}</li>)}{parse.truncated && <li>More errors were not listed.</li>}</ul>
              : <p><Icon name="pass" />{stepText.parseOk}</p>}
      </div>}
      <p className="field-note">{step.subsystem === 'TSQL' ? stepText.tsqlContext(step.databaseName || 'master')
        : step.subsystem === 'PowerShell' ? stepText.powerShellHelp(state.server, account) : step.subsystem === 'CmdExec' ? stepText.cmdExecHelp(state.server, account) : ''}</p>
    </div>}
    <div className="agent-step-grid">
      {serverSubsystems.has(step.subsystem) && <div className="agent-step-row">
        <label htmlFor={`${id}-olap-server`}>Server</label>
        <input id={`${id}-olap-server`} className="property-input" type="text" maxLength={128} spellCheck={false} value={step.server} disabled={!editable}
          aria-invalid={server.error ? true : undefined} onChange={event => update({ server: event.target.value })} />
        <FieldMessages text={server} id={`${id}-olap-server`} />
      </div>}
      {step.subsystem === 'CmdExec' && <div className="agent-step-row">
        <label htmlFor={`${id}-exit`}>Success exit code</label>
        <span className="agent-step-inline">
          <input id={`${id}-exit`} className="property-input agent-step-short" type="number" value={step.cmdexecSuccessCode} disabled={!editable}
            onChange={event => update({ cmdexecSuccessCode: Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(Number(event.target.value) || 0))) })} />
          <span className="field-note">{stepText.successCode}</span>
        </span>
      </div>}
      <Target state={state} step={step} which="onSuccess" editable={editable} problems={problems} update={update} id={`${id}-success`} />
      <Target state={state} step={step} which="onFail" editable={editable} problems={problems} update={update} id={`${id}-fail`} />
    </div>
    <MoreOptions step={step} model={model} editable={editable} problems={problems} update={update} id={`${id}-more`} />
  </div>
}

/** The Steps section: the delete banner, the list and the selected step's editor. */
export default function JobSteps(outer: StepsProps) {
  // A job with more steps than Varia reads keeps its steps as they are: they are listed, never saved.
  const props = outer.model.stepsTruncated ? { ...outer, editable: false } : outer
  const { state, draft, editable, service } = props
  const [dragging, setDragging] = useState<string | undefined>(undefined)
  const [over, setOver] = useState<number | undefined>(undefined)
  const [adding, setAdding] = useState('TSQL')
  const steps = draft.steps.steps
  const problems = service.stepProblems(state.id)
  const selected = service.selectedStep(state.id)
  const deletion = state.deletion
  const drop = (event: DragEvent, index: number) => {
    event.preventDefault()
    const key = dragging ?? event.dataTransfer.getData('application/x-varia-step')
    setDragging(undefined); setOver(undefined)
    if (!key) return
    const from = steps.findIndex(step => step.key === key)
    service.moveStepTo(state.id, key, from >= 0 && from < index ? index - 1 : index)
  }
  const types = props.model.subsystems?.length ? props.model.subsystems : [...mainTypes]
  const retargeted = deletion ? deletion.retargeted.map(key => steps.findIndex(step => step.key === key) + 1).filter(at => at > 0) : []
  return <div className="agent-job-steps">
    {props.model.stepsTruncated && <p className="field-note" role="note"><Icon name="info" />{stepText.stepsTruncated}</p>}
    {deletion && <div className="agent-step-banner" role="status">
      <Icon name="trash" />
      <span className="agent-step-banner-text">{[stepText.deleted(deletion.position + 1, deletion.deleted.name), stepText.retargeted(retargeted), deletion.startMoved ? stepText.startMoved : '', stepText.notYet].filter(Boolean).join(' ')}</span>
      <button type="button" disabled={!editable} onClick={() => service.undoDeleteStep(state.id)}>{stepText.undo}</button>
      <button type="button" aria-label="Dismiss" onClick={() => service.dismissDeletion(state.id)}><Icon name="close" /></button>
    </div>}
    <div className="agent-step-body">
      <div className="agent-step-list">
        <div role="listbox" aria-label="Steps" tabIndex={steps.length ? 0 : -1} aria-activedescendant={selected ? `agent-step-${state.id}-${selected.key}` : undefined}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const at = selected ? steps.indexOf(selected) : -1
            const next = steps[Math.max(0, Math.min(steps.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]
            if (next) service.selectStep(state.id, next.key)
          }}>
          {steps.length === 0 && <p className="field-note">{stepText.none}</p>}
          {steps.map((step, at) => {
            const own = problems.filter(problem => problem.key === step.key)
            const errors = own.filter(problem => problem.severity === 'error').length
            const changed = deletion?.retargeted.includes(step.key)
            return <div key={step.key} id={`agent-step-${state.id}-${step.key}`} role="option" aria-selected={selected?.key === step.key} className="agent-step-item"
              data-drop-before={over === at || undefined} draggable={editable || undefined}
              onClick={() => service.selectStep(state.id, step.key)}
              onDragStart={event => { event.dataTransfer.setData('application/x-varia-step', step.key); event.dataTransfer.effectAllowed = 'move'; setDragging(step.key) }}
              onDragEnd={() => { setDragging(undefined); setOver(undefined) }}
              onDragOver={event => { if (!dragging) return; event.preventDefault(); setOver(at) }}
              onDrop={event => drop(event, at)}>
              <span className="agent-step-no">{at + 1}</span>
              <span className="agent-step-name">{step.name || 'Unnamed step'}</span>
              <span className="agent-step-tags">
                {draft.steps.startKey === step.key && <span className="agent-step-tag" data-tone="accent">Start step</span>}
                {own.length > 0 && <span className="agent-step-tag" data-tone={errors ? 'error' : 'warning'}>{`${own.length} ${own.length === 1 ? 'problem' : 'problems'}`}</span>}
                {changed && <span className="agent-step-tag" data-tone="warning">changed</span>}
              </span>
              <span className="agent-step-flow">
                <span>{stepTypeShort(step.subsystem)}</span>
                <span className="agent-step-ok"><Icon name="check" /><span className="visually-hidden">On success: </span>{stepTargetShort(draft.steps, step, 'success')}</span>
                <span className="agent-step-bad"><Icon name="close" /><span className="visually-hidden">On failure: </span>{stepTargetShort(draft.steps, step, 'fail')}</span>
              </span>
            </div>
          })}
          {dragging && <div className="agent-step-drop-end" data-drop-before={over === steps.length || undefined} onDragOver={event => { event.preventDefault(); setOver(steps.length) }} onDrop={event => drop(event, steps.length)} />}
        </div>
        <div className="agent-step-add">
          <button type="button" disabled={!editable || steps.length >= agentLimits.stepsPerJob} title={steps.length >= agentLimits.stepsPerJob ? stepText.tooMany : undefined} onClick={() => service.addStepOf(state.id, adding)}><Icon name="add" />Add step</button>
          <select className="property-input" aria-label="Type of the step to add" value={adding} disabled={!editable} onChange={event => setAdding(event.target.value)}>
            {types.map(type => <option key={type} value={type}>{stepTypeShort(type)}</option>)}
          </select>
        </div>
        <p className="field-note">{stepText.dragHint}</p>
      </div>
      {selected ? <StepEditor {...props} step={selected} position={steps.indexOf(selected)} problems={problems} /> : <div className="agent-step-edit" />}
    </div>
  </div>
}
