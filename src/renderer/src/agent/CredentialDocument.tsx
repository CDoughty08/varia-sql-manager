// The Credential document (AG-8b, docs/agent-ui-rethink.md › rx-credential): the credential (name, identity, password behind "Change
// identity and password", the provider for New Credential) and Used by (proxies, then their job steps). CredentialDocumentService keeps every
// state; this only draws it. The password fields are uncontrolled and remount empty whenever the service empties the secret slot.
import { credentialText, subsystemLabel, type CredentialDocumentModel, type CredentialDraft, type CredentialField, type CredentialProblem } from '../../../shared/actions/agent-proxy.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { resizeScript, selectSection, setScriptOpen } from '../kit/document-frame'
import { type Verb } from '../kit/DocumentFrame'
import FactGrid from '../kit/FactGrid'
import InlineError from '../kit/InlineError'
import ObjectInspectorFrame, { type InspectorTab } from '../kit/ObjectInspectorFrame'
import PasswordField from '../kit/PasswordField'
import PropertyField, { FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Skeleton from '../kit/Skeleton'
import Switch from '../kit/Switch'
import { credentialFieldLabels, credentialSections, type CredentialDocumentService, type CredentialDocumentState } from './CredentialDocumentService'

const fieldId = (documentId: string, key: string) => `credential-${documentId}-${key}`

interface SectionProps {
  readonly state: CredentialDocumentState
  readonly model: CredentialDocumentModel
  readonly draft: CredentialDraft
  readonly editable: boolean
  readonly problems: readonly CredentialProblem[]
  readonly service: CredentialDocumentService
}
function fieldText(field: CredentialField, { state, problems }: Pick<SectionProps, 'state' | 'problems'>): { error?: string; note?: string } {
  const own = problems.filter(problem => problem.field === field)
  const error = (state.error?.field === field ? state.error.message : undefined) ?? own.find(problem => problem.severity === 'error')?.message
  const warnings = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...warnings.length ? { note: warnings.join(' ') } : {} }
}

function CredentialSection(props: SectionProps) {
  const { state, model, draft, editable, service } = props
  const credential = model.credential
  const ids = { name: fieldId(state.id, 'name'), identity: fieldId(state.id, 'identity'), change: fieldId(state.id, 'change'), secret: fieldId(state.id, 'secret'), confirm: fieldId(state.id, 'confirm'), provider: fieldId(state.id, 'provider') }
  const open = !credential || draft.change
  const name = { description: credential ? 'A credential\'s name cannot change.' : 'The credential\'s name, unique on this server.', ...fieldText('name', props) }
  const identity = { description: 'The account the credential holds: a Windows account (DOMAIN\\user) for proxies, or what the provider expects.', ...fieldText('identity', props) }
  const secret = { description: 'Sent once when you save, never read back.', ...fieldText('secret', props) }
  const provider = { description: credentialText.providerHint, ...fieldText('provider', props) }
  const identityChanged = !!credential && draft.identity !== credential.identity
  const mismatch = state.secrets.secret === 'set' && !state.secrets.matches
  return <div className="agent-object-flow credential-flow">
    <h2 className="agent-eyebrow">Credential</h2>
    <div className="properties-fields credential-general">
      <PropertyField id={ids.name} label="Name" {...name}>
        <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} readOnly={!!credential}
          data-credential-focus={!credential || undefined} {...fieldAria(ids.name, name)} onChange={event => service.updateDraft(state.id, { name: event.target.value })} />
      </PropertyField>
      {credential && <PropertyField id={ids.change} label={credentialText.changeBoth} changed={draft.change} description={credentialText.neverRead}>
        <Switch id={ids.change} checked={draft.change} disabled={!editable} changed={draft.change} data-credential-focus onChange={checked => service.setChange(state.id, checked)} />
      </PropertyField>}
      <PropertyField id={ids.identity} label="Identity" changed={identityChanged} {...identity}>
        <input id={ids.identity} className="property-input" type="text" maxLength={agentLimits.credentialIdentityChars + 1} spellCheck={false} value={draft.identity} disabled={!editable || !open}
          data-changed={identityChanged || undefined} {...fieldAria(ids.identity, { ...identity, changed: identityChanged })} onChange={event => service.updateDraft(state.id, { identity: event.target.value })} />
      </PropertyField>
      {open && <>
        <PropertyField id={ids.secret} label="Password" {...secret}>
          <PasswordField key={`secret-${state.secretEpoch}`} id={ids.secret} maxLength={agentLimits.credentialSecretChars + 1} disabled={!editable} onValue={value => service.setSecret(state.id, 'secret', value)} />
        </PropertyField>
        <PropertyField id={ids.confirm} label="Confirm password" description="The password again.">
          <PasswordField key={`confirm-${state.secretEpoch}`} id={ids.confirm} maxLength={agentLimits.credentialSecretChars + 1} disabled={!editable} aria-invalid={mismatch || undefined}
            onValue={value => service.setSecret(state.id, 'confirm', value)} />
        </PropertyField>
      </>}
      {!credential && model.providers.length > 0 && <PropertyField id={ids.provider} label="Provider" {...provider}>
        <select id={ids.provider} className="property-input" value={draft.provider} disabled={!editable} {...fieldAria(ids.provider, provider)} onChange={event => service.updateDraft(state.id, { provider: event.target.value })}>
          <option value="">None</option>
          {model.providers.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </PropertyField>}
      {credential?.provider && <p className="field-note">{`Provider: ${credential.provider}`}</p>}
      {credential && !draft.change && editable && <p className="field-note">{credentialText.unchanged}</p>}
    </div>
    {credential && <>
      <h2 className="agent-eyebrow">Lifecycle</h2>
      <FactGrid facts={[
        { id: 'created', label: 'Created', value: credential.created.replace('T', ' '), mono: true },
        { id: 'modified', label: 'Last modified', value: credential.modified.replace('T', ' ').slice(0, 19), mono: true }
      ]} />
    </>}
  </div>
}

function UsedBySection({ state, model, draft }: Pick<SectionProps, 'state' | 'model' | 'draft'>) {
  if (!model.credential) return <p className="field-note">{credentialText.usedByNone}</p>
  if (!model.usedBy) return <p className="field-note">{credentialText.usedByUnread}</p>
  const windows = /^[^\\\s]+\\[^\\]+$/.test(draft.identity.trim())
  return <div className="agent-object-flow credential-flow credential-used-by">
    <h2 className="agent-eyebrow">Used By</h2>
    {model.usedBy.length === 0 ? <p className="field-note">{credentialText.usedByNone}</p> : <>
      <ul className="credential-uses" aria-label="Proxies and job steps that use this credential">{model.usedBy.map(use => <li key={use.proxy}>
        <span><Icon name="agent-proxy" />{`Proxy ${use.proxy}`}{use.subsystems.length > 0 && <span className="field-note">{` · ${use.subsystems.map(subsystemLabel).join(', ')}`}</span>}</span>
        {use.steps.length > 0 && <ul>{use.steps.map(step => <li key={`${step.job}:${step.stepId}`}><Icon name="agent-job" />{`${step.job} › ${step.stepId} ${step.step}`}</li>)}</ul>}
      </li>)}</ul>
      <p className="field-note">{credentialText.usedByHint}</p>
    </>}
    {model.usedByTruncated && <p className="field-note">Only the first proxies and steps are listed.</p>}
    {windows && model.usedBy.length > 0 && <p className="field-note"><Icon name="info" />{credentialText.batchRight(draft.identity.trim(), state.server)}</p>}
  </div>
}

/** The Credential document: header (where it is, Reload and Save), what the last action said, Credential and Used by, and the Script drawer. */
export default function CredentialDocument({ documentId }: { documentId: string }) {
  const { credentialDocuments } = useWorkbench()
  const { documents } = useServiceSnapshot(credentialDocuments)
  const state = documents[documentId]
  if (!state) return <div className="credential-document" />
  const { model, draft } = state
  const editable = credentialDocuments.canEdit(state.id), problems = credentialDocuments.problems(state.id)
  const args = { tabId: state.id }
  const saveLabel = model?.credential ? state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save' : 'Create'
  const verbs: Verb[] = [{ command: 'credential.reload', args, label: 'Reload' }, { command: 'credential.save', args, label: saveLabel, emphasis: 'primary' }]
  const phaseLabel = state.phase === 'loading' ? 'Reading the credential…' : state.phase === 'saving' ? 'Saving the credential…' : undefined
  const content = (section: string) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the credential" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the credential could not be read.' : ''}</p>
    const props: SectionProps = { state, model, draft, editable, problems, service: credentialDocuments }
    return section === 'credential' ? <CredentialSection {...props} /> : <UsedBySection state={state} model={model} draft={draft} />
  }
  const errorSection = problems.some(problem => problem.severity === 'error') || !!state.error?.field
  const visibleSections = credentialSections.filter(section => section.id !== 'usedBy' || !!model?.credential)
  const activeTab = visibleSections.some(section => section.id === state.frame.section) ? state.frame.section : 'credential'
  const tabs: InspectorTab[] = visibleSections.map(section => ({
    id: section.id,
    title: section.title,
    layout: 'flow',
    ...section.id === 'credential' ? { keepMounted: true, modified: state.changes > 0, problem: errorSection } : { count: model?.usedBy?.length },
    content: content(section.id)
  }))
  const name = model?.credential?.name ?? (draft?.name || 'New Credential')
  const recovery = state.phase === 'loadFailed' || state.unread || state.error?.code === 'NOT_FOUND' || state.error?.code === 'STALE' ? [{ label: 'Reload', run: () => credentialDocuments.reload(state.id) }] : []
  const field = state.error?.field as CredentialField | undefined
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && !field && <InlineError message={state.error.message} code={state.error.code} context={`Credential ${name} on ${state.server}`} actions={recovery} />}
    {field && <p className="property-field-error" role="alert"><Icon name="error" />{`Not saved: ${credentialFieldLabels[field] ?? field}. ${state.error?.message ?? ''}`}</p>}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {model?.readOnly && <p className="document-status"><Icon name="lock" />{model.readOnly}</p>}
    {draft?.change && <p className="field-note"><Icon name="lock" />{credentialText.scriptSecret}</p>}
  </>
  const header = { title: name, subtitle: model?.credential ? 'Credential Properties' : 'New Credential', crumbs: [{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'Security' }, { label: 'Credentials' }] }
  return <FieldHints resetKey={activeTab}><ObjectInspectorFrame id={`credential-${state.id}`} surface="full" {...header} verbs={verbs} banner={banner}
    tabs={tabs} activeTab={activeTab} onSelectTab={id => credentialDocuments.setFrame(state.id, selectSection(state.frame, visibleSections, id))}
    attributes={{ 'data-credential': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void credentialDocuments.deliver(state.id, destination) }}
    scriptOpen={state.frame.scriptOpen} scriptSize={state.frame.scriptSize}
    onScriptToggle={() => credentialDocuments.setFrame(state.id, setScriptOpen(state.frame, !state.frame.scriptOpen))}
    onScriptResize={size => credentialDocuments.setFrame(state.id, resizeScript(state.frame, size))}
    hint={<FieldHintStrip />} /></FieldHints>
}
