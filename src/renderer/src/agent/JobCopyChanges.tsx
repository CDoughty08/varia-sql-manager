// Create Job Like This's Changes from source section (AG-6e, docs/agent-ui-rethink.md › Create from…, mock rx-create-from): what usually
// differs from the source in one place. Replace across the copy with its preview, the job's name, owner and Enable when saved, each step's
// key fields (with Edit command and Set it now on Steps), and each source schedule's Share, Copy or Leave out; then what else is copied
// and what is not. Compare with source is drawn by CopyCompare. JobDocumentService keeps every state; this only draws it.
import { useEffect } from 'react'
import { agentJobText, type AgentJobDocumentModel, type AgentJobDraft, type AgentJobProblem } from '../../../shared/actions/agent-job.ts'
import { jobScheduleText } from '../../../shared/actions/agent-schedule.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import {
  alsoCopiedText, canShareSchedule, changedPackages, copiedScheduleKey, copyScheduleChoice, createFromLimits, createFromText, stepKeyChanged, stepKeyFields, type CopyScheduleChoice, type StepKeyField
} from '../../../shared/agent/create-from.ts'
import { createSeveralText } from '../../../shared/agent/create-several.ts'
import { scheduleWhen } from '../../../shared/agent/schedule.ts'
import { parseSsisCommand, ssisPackagePath } from '../../../shared/agent/ssis-step.ts'
import { stepTypeShort, type AgentStepDraft } from '../../../shared/agent/steps.ts'
import Icon from '../Icon'
import PropertyField, { fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import type { JobDocumentService, JobDocumentState } from './JobDocumentService'

interface Props {
  readonly state: JobDocumentState
  readonly model: AgentJobDocumentModel
  readonly draft: AgentJobDraft
  readonly editable: boolean
  readonly problems: readonly AgentJobProblem[]
  readonly service: JobDocumentService
  /** Goes to a section (Steps, Schedules) and, for Steps, selects a step there. */
  readonly goTo: (section: 'steps' | 'schedules', key?: string) => void
}

const fieldId = (documentId: string, key: string) => `agent-job-${documentId}-copy-${key}`
const keyLabels: { readonly [F in StepKeyField]: string } = { database: 'Database', command: 'Command', package: 'Package', environment: 'Environment' }
const firstLine = (text: string) => { const line = text.split(/\r?\n/, 1)[0] ?? ''; return line.length > 90 || text.includes('\n') ? `${line.slice(0, 90)} …` : line }

function ReplaceAcross({ state, service, editable }: Pick<Props, 'state' | 'service' | 'editable'>) {
  const replace = state.replace ?? { find: '', with: '', matchCase: false }
  const preview = service.replacePreviewCurrent(state.id) ? replace.preview : undefined
  const ids = { find: fieldId(state.id, 'find'), with: fieldId(state.id, 'with'), matchCase: fieldId(state.id, 'match-case') }
  return <div role="group" className="agent-copy-group" aria-labelledby={`${ids.find}-title`}>
    <h3 id={`${ids.find}-title`}>{createFromText.replaceTitle}<span className="field-note">{createFromText.replaceScope}</span></h3>
    <div className="agent-copy-replace">
      <label htmlFor={ids.find} className="visually-hidden">{createFromText.replaceFind}</label>
      <input id={ids.find} className="property-input" type="text" placeholder={createFromText.replaceFind} maxLength={createFromLimits.replaceChars} spellCheck={false} value={replace.find} disabled={!editable}
        onChange={event => service.setReplace(state.id, { find: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); service.previewReplace(state.id) } }} />
      <span className="field-note">with</span>
      <label htmlFor={ids.with} className="visually-hidden">{createFromText.replaceWith}</label>
      <input id={ids.with} className="property-input" type="text" placeholder={createFromText.replaceWith} maxLength={createFromLimits.replaceChars} spellCheck={false} value={replace.with} disabled={!editable}
        onChange={event => service.setReplace(state.id, { with: event.target.value })} />
      <label className="agent-copy-check"><input id={ids.matchCase} type="checkbox" checked={replace.matchCase} disabled={!editable} onChange={event => service.setReplace(state.id, { matchCase: event.target.checked })} />{createFromText.matchCase}</label>
      <button type="button" disabled={!editable || !replace.find} onClick={() => service.previewReplace(state.id)}>Preview</button>
    </div>
    <p className="field-note">{createFromText.previewHint}</p>
    {preview && <div className="agent-copy-preview">
      <p role="status">{createFromText.preview(preview.matches.length, preview.more)}{preview.more && <span className="field-note"> {createFromText.replaceTooMany}</span>}</p>
      {preview.matches.length > 0 && <>
        <ul aria-label="Matches">
          {preview.matches.map(match => <li key={match.id}>
            <label>
              <input type="checkbox" checked={preview.chosen.includes(match.id)} disabled={!editable} onChange={() => service.toggleReplaceMatch(state.id, match.id)} />
              <span className="agent-copy-where">{match.label}</span>
              <span className="agent-copy-context agent-copy-mono">{match.before}<del>{match.match}</del><ins>{replace.with}</ins>{match.after}</span>
            </label>
          </li>)}
        </ul>
        <p><button type="button" className="primary" disabled={!editable || preview.chosen.length === 0} onClick={() => service.applyReplace(state.id)}>{createFromText.apply(preview.chosen.length)}</button></p>
      </>}
    </div>}
  </div>
}

function JobFields({ state, model, draft, editable, problems, service }: Props) {
  const source = state.source!.base
  const ids = { name: fieldId(state.id, 'name'), owner: fieldId(state.id, 'owner'), enabled: fieldId(state.id, 'enabled') }
  const nameError = problems.find(problem => problem.field === 'name' && problem.severity === 'error')?.message
  const name = { description: 'The new job\'s name, unique on this server.', ...nameError ? { error: nameError } : {} }
  const ownerChanged = draft.owner !== source.owner
  const owner = { description: 'The login the new job belongs to.', note: model.sysadmin ? createFromText.ownerSource(source.owner) : `${createFromText.ownerSource(source.owner)} ${createFromText.ownerYou}` }
  const enabled = { description: 'Whether the new job runs on its schedules once it is created.', note: createFromText.enableHint }
  return <div role="group" className="agent-copy-group" aria-label="Job">
    <h3>Job</h3>
    <div className="properties-fields">
      <PropertyField id={ids.name} label="Name" changed={draft.name !== source.name} {...name}>
        <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} data-agent-job-focus
          {...fieldAria(ids.name, { ...name, changed: draft.name !== source.name })} onChange={event => service.updateDraft(state.id, { name: event.target.value })} />
      </PropertyField>
      <PropertyField id={ids.owner} label="Owner" changed={ownerChanged} {...owner}>
        <span className="agent-copy-inline">
          <input id={ids.owner} className="property-input" type="text" list={`${ids.owner}-logins`} maxLength={agentLimits.nameChars} spellCheck={false} value={draft.owner} disabled={!editable || !model.sysadmin}
            {...fieldAria(ids.owner, { ...owner, changed: ownerChanged })} onChange={event => service.updateDraft(state.id, { owner: event.target.value })} />
          {model.sysadmin && ownerChanged && <button type="button" disabled={!editable} onClick={() => service.keepSourceOwner(state.id)}>Keep {source.owner}</button>}
        </span>
        {model.owners && <datalist id={`${ids.owner}-logins`}>{model.owners.map(login => <option key={login} value={login} />)}</datalist>}
      </PropertyField>
      <PropertyField id={ids.enabled} label="Enabled" changed={draft.enabled !== source.enabled} {...enabled} labelFor={false}>
        <label className="agent-copy-check"><input id={ids.enabled} type="checkbox" checked={draft.enabled} disabled={!editable} aria-describedby={`${ids.enabled}-note`}
          onChange={event => service.updateDraft(state.id, { enabled: event.target.checked })} />{createFromText.enableWhenSaved}</label>
      </PropertyField>
    </div>
  </div>
}

function StepKeys({ state, model, editable, service, goTo, step, at }: Props & { readonly step: AgentStepDraft; readonly at: number }) {
  const source = state.source!
  const id = fieldId(state.id, `step-${step.key}`)
  const parsed = step.subsystem === 'SSIS' ? parseSsisCommand(step.command) : undefined
  const ssisMessages = service.stepProblems(state.id).filter(problem => problem.key === step.key && problem.field === 'package').map(problem => problem.message)
  const projectModel = parsed ? state.ssis?.projectModels[`${parsed.folder}\\${parsed.project}`] : undefined
  const databases = model.databases ?? []
  const value = (field: StepKeyField) => {
    switch (field) {
      case 'database': {
        const options = databases.includes(step.databaseName) || !step.databaseName ? databases : [step.databaseName, ...databases]
        return <select id={`${id}-database`} className="property-input" value={step.databaseName} disabled={!editable} onChange={event => service.updateStep(state.id, step.key, { databaseName: event.target.value })}>
          {options.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      }
      case 'command': return step.subsystem === 'CmdExec'
        ? <input id={`${id}-command`} className="property-input agent-copy-mono" type="text" spellCheck={false} value={step.command} disabled={!editable} onChange={event => service.updateStep(state.id, step.key, { command: event.target.value })} />
        : <span className="agent-copy-inline"><span id={`${id}-command`} className="agent-copy-mono agent-copy-command">{firstLine(step.command) || createFromText.none}</span>
          <button type="button" className="link-button" onClick={() => goTo('steps', step.key)}>{createFromText.editCommand}</button></span>
      case 'package': return <span className="agent-copy-inline"><span id={`${id}-package`} className="agent-copy-mono">{parsed ? ssisPackagePath(parsed) : ''}</span>
        <button type="button" className="link-button" onClick={() => goTo('steps', step.key)}>{createFromText.changePackage}</button></span>
      case 'environment': {
        const reference = parsed?.environmentReference
        const named = reference === undefined ? undefined : projectModel?.references.find(item => item.id === reference)
        return <span id={`${id}-environment`}>{reference === undefined ? 'None' : named ? named.folder ? `${named.folder} › ${named.environment}` : named.environment : `Reference ${reference}`}</span>
      }
    }
  }
  return <div role="group" className="agent-copy-group" aria-label={`Step ${at + 1} ${step.name}`} data-warn={ssisMessages.length > 0 || undefined}>
    <h3>Step {at + 1} <strong>{step.name}</strong> · {stepTypeShort(step.subsystem)}</h3>
    <div className="properties-fields">
      {stepKeyFields(step).map(field => <PropertyField key={field} id={`${id}-${field}`} label={keyLabels[field]} changed={stepKeyChanged(source, step, field)} labelFor={field === 'database' || (field === 'command' && step.subsystem === 'CmdExec')}>
        {value(field)}
      </PropertyField>)}
      {ssisMessages.length > 0 && <p className="field-note agent-copy-warn" role="note"><Icon name="warning" />{ssisMessages.join(' ')}
        <button type="button" className="link-button" onClick={() => goTo('steps', step.key)}>{createFromText.setItNow}</button></p>}
    </div>
  </div>
}

function Schedules({ state, draft, editable, service, goTo }: Props) {
  const records = state.source!.model.schedules ?? []
  if (!records.length) return <div role="group" className="agent-copy-group" aria-label={createFromText.schedulesGroup}><h3>{createFromText.schedulesTitle}</h3><p className="field-note">{createFromText.schedulesNone}</p></div>
  return <div role="group" className="agent-copy-group" aria-label={createFromText.schedulesGroup}>
    <h3>{createFromText.schedulesTitle}</h3>
    <div className="properties-fields">
      {records.map(record => {
        const id = fieldId(state.id, `schedule-${record.id}`), choice = copyScheduleChoice(draft.schedules, record)
        const copied = draft.schedules.find(entry => entry.key === copiedScheduleKey(record.id))
        const shareable = canShareSchedule(record)
        const segments = [{ value: 'share', label: createFromText.share }, { value: 'copy', label: createFromText.copy }, { value: 'leave', label: createFromText.leave }]
        return <PropertyField key={record.id} id={id} label={record.name} labelFor={false} changed={choice !== 'share'} description={createFromText.scheduleHint} {...!shareable ? { note: createFromText.shareUnguarded } : {}}>
          <span className="agent-copy-inline">
            <Segmented id={id} labelledBy={`${id}-label`} segments={segments} value={choice} disabled={!editable} changed={choice !== 'share'}
              onChange={next => { if (next !== 'share' || shareable) service.setCopySchedule(state.id, record.id, next as CopyScheduleChoice) }} />
            <span className="field-note">{choice === 'copy' && copied ? `${copied.fields.name} · ${scheduleWhen(copied.fields)}` : scheduleWhen(record)}</span>
            {choice === 'copy' && copied && <button type="button" className="link-button" onClick={() => { service.selectSchedule(state.id, copied.key); goTo('schedules') }}>{createFromText.editSchedule}</button>}
          </span>
        </PropertyField>
      })}
    </div>
    <p className="field-note">{createFromText.scheduleHint}</p>
    {records.some(record => !canShareSchedule(record)) && <p className="field-note">{jobScheduleText.unread}</p>}
  </div>
}

/** Changes from source. */
export default function JobCopyChanges(props: Props) {
  const { state, draft, service } = props
  const source = state.source!
  // A step whose package differs from the source's: read its project and package, so its required parameters without a value show here.
  const packages = changedPackages(source, draft).map(step => parseSsisCommand(step.command)!).map(command => `${command.folder}\\${command.project}\\${command.package}`)
  const packagesKey = [...new Set(packages)].join('\n')
  useEffect(() => {
    for (const path of packagesKey ? packagesKey.split('\n') : []) {
      const [folder, project, packageName] = path.split('\\')
      if (folder && project && packageName) void service.loadSsisPackage(state.id, folder, project, packageName)
    }
  }, [packagesKey, service, state.id])
  const alerts = (source.model.alerts ?? []).map(alert => alert.name)
  return <div className="agent-copy" data-agent-job-copy>
    <ReplaceAcross {...props} />
    <JobFields {...props} />
    {draft.steps.steps.length === 0 ? <p className="field-note">{createFromText.noSteps}</p> : draft.steps.steps.map((step, at) => <StepKeys key={step.key} {...props} step={step} at={at} />)}
    <Schedules {...props} />
    <details className="agent-copy-more"><summary>{createFromText.alsoCopied}</summary><p>{alsoCopiedText(source) || createFromText.none}</p></details>
    <details className="agent-copy-more"><summary>{createFromText.notCopied}</summary><p>{createFromText.notCopiedText(alerts)}</p></details>
    {source.model.stepsTruncated && <p className="property-field-error" role="alert"><Icon name="error" />{createFromText.stepsTruncated}</p>}
    <p className="field-note">{agentJobText.newHint}</p>
    {!state.row && <p className="agent-copy-inline agent-copy-several">
      <button type="button" disabled={!props.editable || !!source.model.stepsTruncated} onClick={() => service.createSeveral(state.id)}><Icon name="copy" />{createSeveralText.start}</button>
      <span className="field-note">{createSeveralText.startHint}</span>
    </p>}
  </div>
}

/** Compare with source: every field the copy differs in, beside the source's value. */
export function CopyCompare({ state, service }: Pick<Props, 'state' | 'service'>) {
  const rows = service.compareRows(state.id)
  return <div role="group" className="agent-copy-compare" aria-label={createFromText.compare}>
    {rows.length === 0 ? <p className="field-note">{createFromText.compareNone}</p> : <table className="properties-table" aria-label={createFromText.compare}>
      <thead><tr><th scope="col">Where</th><th scope="col">Field</th><th scope="col">Source ({state.source!.base.name})</th><th scope="col">This job</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.group}:${row.field}:${index}`}><td>{row.group}</td><th scope="row">{row.field}</th><td>{row.source}</td><td>{row.copy}</td></tr>)}</tbody>
    </table>}
  </div>
}
