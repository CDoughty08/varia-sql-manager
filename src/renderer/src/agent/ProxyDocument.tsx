// The SQL Server Agent proxy document (AG-8b, docs/agent-ui-rethink.md › rx-proxy): one screen with Proxy (name, the credential, picked or
// created in place with its password, description, enabled), Subsystems, Principals and References. ProxyDocumentService keeps every state;
// this only draws it. The password fields are uncontrolled and remount empty whenever the service empties the secret slot.
import { useState } from 'react'
import {
  agentProxyText, credentialText, proxyPrincipalKindLabel, subsystemLabel, type AgentProxyDocumentModel, type AgentProxyDraft, type AgentProxyField, type AgentProxyProblem, type ProxyPrincipal
} from '../../../shared/actions/agent-proxy.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DocumentFrame, { type FrameSection, type Verb } from '../kit/DocumentFrame'
import InlineError from '../kit/InlineError'
import PasswordField from '../kit/PasswordField'
import PropertyField, { FieldHints, FieldHintStrip, fieldAria } from '../kit/PropertyField'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import Switch from '../kit/Switch'
import { proxyFieldLabels, proxySections, type ProxyDocumentService, type ProxyDocumentState } from './ProxyDocumentService'

const fieldId = (documentId: string, key: string) => `agent-proxy-${documentId}-${key}`

interface SectionProps {
  readonly state: ProxyDocumentState
  readonly model: AgentProxyDocumentModel
  readonly draft: AgentProxyDraft
  readonly editable: boolean
  readonly problems: readonly AgentProxyProblem[]
  readonly service: ProxyDocumentService
}
/** A field's text: its first error (the save's own refusal first), else its warnings. */
function fieldText(field: AgentProxyField, { state, problems }: Pick<SectionProps, 'state' | 'problems'>): { error?: string; note?: string } {
  const own = problems.filter(problem => problem.field === field)
  const error = (state.error?.field === field ? state.error.message : undefined) ?? own.find(problem => problem.severity === 'error')?.message
  const warnings = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...warnings.length ? { note: warnings.join(' ') } : {} }
}

/** The new credential's fields: name, identity, password and its confirmation (the secret slot's, never React's). */
function NewCredential({ state, model, draft, editable, service }: SectionProps) {
  const ids = { name: fieldId(state.id, 'new-credential-name'), identity: fieldId(state.id, 'new-credential-identity'), secret: fieldId(state.id, 'new-credential-secret'), confirm: fieldId(state.id, 'new-credential-confirm') }
  const mismatch = state.secrets.secret === 'set' && !state.secrets.matches
  return <div className="agent-proxy-new-credential" role="group" aria-label="New credential">
    <p className="agent-proxy-sub-head"><strong>New credential</strong> · {agentProxyText.newCredentialHint}
      {model.credentials.length > 0 && <button type="button" className="link-button" disabled={!editable} onClick={() => service.setCredentialMode(state.id, 'existing')}>Use an existing one</button>}</p>
    <div className="properties-fields">
      <PropertyField id={ids.name} label="Name" description="The credential's name, unique on this server.">
        <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.newCredentialName} disabled={!editable}
          onChange={event => service.updateDraft(state.id, { newCredentialName: event.target.value })} />
      </PropertyField>
      <PropertyField id={ids.identity} label="Identity" description={agentProxyText.windowsOnlyIdentity}>
        <input id={ids.identity} className="property-input" type="text" maxLength={agentLimits.credentialIdentityChars + 1} spellCheck={false} value={draft.newCredentialIdentity} disabled={!editable}
          onChange={event => service.updateDraft(state.id, { newCredentialIdentity: event.target.value })} />
      </PropertyField>
      <PropertyField id={ids.secret} label="Password" description="The account's password; sent once when you save, never read back.">
        <PasswordField key={`secret-${state.secretEpoch}`} id={ids.secret} maxLength={agentLimits.credentialSecretChars + 1} disabled={!editable} onValue={value => service.setSecret(state.id, 'secret', value)} />
      </PropertyField>
      <PropertyField id={ids.confirm} label="Confirm password" description="The password again.">
        <PasswordField key={`confirm-${state.secretEpoch}`} id={ids.confirm} maxLength={agentLimits.credentialSecretChars + 1} disabled={!editable} aria-invalid={mismatch || undefined}
          onValue={value => service.setSecret(state.id, 'confirm', value)} />
      </PropertyField>
    </div>
    <p className="field-note"><Icon name="info" />{agentProxyText.batchRight(draft.newCredentialIdentity.trim())}</p>
  </div>
}

function ProxySection(props: SectionProps) {
  const { state, model, draft, editable, service } = props
  const proxy = model.proxy
  const ids = { name: fieldId(state.id, 'name'), credential: fieldId(state.id, 'credential'), description: fieldId(state.id, 'description'), enabled: fieldId(state.id, 'enabled') }
  const name = { description: 'The proxy\'s name, unique on this server.', ...fieldText('name', props) }
  const credential = { description: 'The credential whose Windows account job steps run as.', ...fieldText('credential', props) }
  const description = { description: 'What the proxy is for, for whoever reads it next.', ...fieldText('description', props) }
  const enabled = { description: 'Job steps may run as this proxy only while it is enabled.', ...fieldText('enabled', props) }
  const changed = (field: 'name' | 'description' | 'enabled') => !!proxy && draft[field] !== proxy[field]
  const credentialChanged = !!proxy && (draft.credentialMode === 'new' || draft.credential !== proxy.credential)
  const choices = draft.credential && !model.credentials.some(item => item.name === draft.credential) ? [{ name: draft.credential, identity: '' }, ...model.credentials] : model.credentials
  const picked = model.credentials.find(item => item.name === draft.credential)
  return <div className="properties-fields agent-proxy-general">
    <PropertyField id={ids.name} label="Name" changed={changed('name')} {...name}>
      <input id={ids.name} className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={draft.name} disabled={!editable} data-agent-proxy-focus={!proxy || undefined}
        data-changed={changed('name') || undefined} {...fieldAria(ids.name, { ...name, changed: changed('name') })} onChange={event => service.updateDraft(state.id, { name: event.target.value })} />
    </PropertyField>
    <PropertyField id={ids.credential} label="Credential" changed={credentialChanged} {...credential}>
      {draft.credentialMode === 'existing'
        ? <span className="agent-proxy-credential">
          <select id={ids.credential} className="property-input" value={draft.credential} disabled={!editable} data-changed={credentialChanged || undefined} {...fieldAria(ids.credential, { ...credential, changed: credentialChanged })}
            onChange={event => service.updateDraft(state.id, { credential: event.target.value })}>
            <option value="">Choose a credential</option>
            {choices.map(item => <option key={item.name} value={item.name}>{item.identity ? `${item.name} (${item.identity})` : item.name}</option>)}
          </select>
          {model.canCreateCredential && <button type="button" disabled={!editable} onClick={() => service.setCredentialMode(state.id, 'new')}><Icon name="add" />New credential</button>}
        </span>
        : <input id={ids.credential} className="property-input" type="text" readOnly value={draft.newCredentialName ? `New credential: ${draft.newCredentialName}` : 'New credential'} {...fieldAria(ids.credential, { ...credential, changed: credentialChanged })} />}
    </PropertyField>
    {draft.credentialMode === 'existing' && model.credentialsTruncated && <p className="field-note">Only the first {model.credentials.length.toLocaleString('en-US')} credentials are listed.</p>}
    {draft.credentialMode === 'existing' && picked && <p className="field-note"><Icon name="info" />{agentProxyText.batchRight(picked.identity)}</p>}
    {draft.credentialMode === 'new' && <NewCredential {...props} />}
    <PropertyField id={ids.description} label="Description" changed={changed('description')} {...description}>
      <textarea id={ids.description} className="property-input agent-proxy-description" rows={3} maxLength={agentLimits.descriptionChars + 1} spellCheck value={draft.description} disabled={!editable}
        data-changed={changed('description') || undefined} {...fieldAria(ids.description, { ...description, changed: changed('description') })}
        onChange={event => service.updateDraft(state.id, { description: event.target.value })} />
    </PropertyField>
    <PropertyField id={ids.enabled} label="Enabled" changed={changed('enabled')} {...enabled}>
      <Switch id={ids.enabled} checked={draft.enabled} disabled={!editable} changed={changed('enabled')} {...fieldAria(ids.enabled, { ...enabled, changed: changed('enabled') })}
        onChange={checked => service.updateDraft(state.id, { enabled: checked })} />
    </PropertyField>
  </div>
}

function SubsystemsSection(props: SectionProps) {
  const { state, model, draft, editable, service } = props
  const own = fieldText('subsystems', props)
  const base = model.proxy?.subsystems ?? []
  return <div className="agent-proxy-subsystems">
    <fieldset className="agent-proxy-checks" aria-label="Active to the following subsystems" disabled={!editable}>
      {model.subsystems.map(subsystem => {
        const on = draft.subsystems.includes(subsystem.id), changed = !!model.proxy && on !== base.includes(subsystem.id)
        return <label key={subsystem.id} data-changed={changed || undefined}>
          <input type="checkbox" checked={on} onChange={() => service.toggleSubsystem(state.id, subsystem.id)} /> {subsystemLabel(subsystem.name)}
        </label>
      })}
    </fieldset>
    <p className="field-note" aria-live="polite">{`${draft.subsystems.length} of ${model.subsystems.length} subsystems`}</p>
    {own.error && <p className="property-field-error" role="alert"><Icon name="error" />{own.error}</p>}
    {own.note && <p className="field-note"><Icon name="warning" />{own.note}</p>}
  </div>
}

function PrincipalsSection(props: SectionProps) {
  const { state, model, draft, editable, service } = props
  const [typed, setTyped] = useState('')
  const own = fieldText('principals', props)
  const listId = fieldId(state.id, 'principal-choices'), inputId = fieldId(state.id, 'principal')
  const base = new Set((model.proxy?.principals ?? []).map(item => `${item.kind}:${item.name}`))
  const choice = (name: string): ProxyPrincipal => model.principalChoices.find(item => item.name.toLowerCase() === name.trim().toLowerCase()) ?? { name: name.trim(), kind: 'login' }
  const twice = !!typed.trim() && service.hasPrincipal(state.id, typed)
  const add = () => { if (!typed.trim() || twice) return; service.addPrincipal(state.id, choice(typed)); setTyped('') }
  return <div className="agent-proxy-principals">
    <p className="field-note">{agentProxyText.principalsHint}</p>
    {model.principalsTruncated && <p className="field-note">{agentProxyText.principalsTruncated(model.proxy?.principals.length ?? 0)}</p>}
    {draft.principals.length === 0 ? <p className="field-note">{agentProxyText.principalsNone}</p>
      : <ul className="agent-proxy-chips" aria-label="Principals that may use the proxy">{draft.principals.map(principal => {
        const added = !!model.proxy && !base.has(`${principal.kind}:${principal.name}`)
        return <li key={`${principal.kind}:${principal.name}`} className="agent-proxy-chip" data-changed={added || undefined}>
          <Icon name={principal.kind === 'login' ? 'person' : 'shield'} /><span>{principal.name}</span><span className="field-note">{proxyPrincipalKindLabel[principal.kind]}</span>
          <button type="button" aria-label={`Remove ${principal.name}`} title={`Remove ${principal.name}`} disabled={!editable} onClick={() => service.removePrincipal(state.id, principal)}><Icon name="close" /></button>
        </li>
      })}</ul>}
    <span className="agent-proxy-add">
      <label htmlFor={inputId} className="visually-hidden">Add login or role</label>
      <input id={inputId} className="property-input" type="text" list={listId} placeholder="Add login or role" maxLength={agentLimits.nameChars} spellCheck={false} value={typed} disabled={!editable}
        aria-invalid={twice || undefined} onChange={event => setTyped(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
      <datalist id={listId}>{model.principalChoices.map(item => <option key={`${item.kind}:${item.name}`} value={item.name} label={proxyPrincipalKindLabel[item.kind]} />)}</datalist>
      <button type="button" disabled={!editable || !typed.trim() || twice} onClick={add}><Icon name="add" />Add</button>
    </span>
    {twice && <p className="field-note">{agentProxyText.principalTwice}</p>}
    {own.error && <p className="property-field-error" role="alert"><Icon name="error" />{own.error}</p>}
  </div>
}

function ReferencesSection({ model }: Pick<SectionProps, 'model'>) {
  if (!model.proxy) return <p className="field-note">{agentProxyText.referencesNew}</p>
  const references = model.references ?? []
  if (references.length === 0) return <p className="field-note">{agentProxyText.referencesNone}</p>
  return <div className="agent-proxy-references">
    <table className="properties-table" aria-label="Job steps that run as this proxy">
      <thead><tr><th scope="col">Job</th><th scope="col">Step</th><th scope="col">Subsystem</th></tr></thead>
      <tbody>{references.map(reference => <tr key={`${reference.job}:${reference.stepId}`}><td>{reference.job}</td><td>{`${reference.stepId} ${reference.step}`}</td><td>{subsystemLabel(reference.subsystem)}</td></tr>)}</tbody>
    </table>
    {model.referencesTruncated && <p className="field-note">{agentProxyText.referencesTruncated(references.length)}</p>}
  </div>
}

/** The proxy document: header (where it is, Reload and Save), what the last action said, then the four sections and the Script drawer. */
export default function ProxyDocument({ documentId }: { documentId: string }) {
  const { proxyDocuments } = useWorkbench()
  const { documents } = useServiceSnapshot(proxyDocuments)
  const state = documents[documentId]
  if (!state) return <div className="agent-proxy-document" />
  const { model, draft } = state
  const editable = proxyDocuments.canEdit(state.id), problems = proxyDocuments.problems(state.id), problemSections = proxyDocuments.problemSections(state.id)
  const args = { tabId: state.id }
  const saveLabel = model?.proxy ? state.changes ? `Save · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'}` : 'Save' : 'Create'
  const verbs: Verb[] = [{ command: 'agentProxy.reload', args, label: 'Reload' }, { command: 'agentProxy.save', args, label: saveLabel, emphasis: 'primary' }]
  const phaseLabel = state.phase === 'loading' ? 'Reading the proxy…' : state.phase === 'saving' ? 'Saving the proxy…' : undefined
  const content = (section: string) => {
    if (!model || !draft) return state.phase === 'loading' ? <Skeleton rows={4} label="Reading the proxy" /> : <p className="field-note">{state.phase === 'loadFailed' ? 'Nothing to show: the proxy could not be read.' : ''}</p>
    const props: SectionProps = { state, model, draft, editable, problems, service: proxyDocuments }
    switch (section) {
      case 'proxy': return <ProxySection {...props} />
      case 'subsystems': return <SubsystemsSection {...props} />
      case 'principals': return <PrincipalsSection {...props} />
      case 'references': return <ReferencesSection model={model} />
      default: return null
    }
  }
  const sections: FrameSection[] = proxySections.map(section => ({ id: section.id, title: section.title, problem: problemSections.has(section.id), content: content(section.id) }))
  const name = model?.proxy?.name ?? (draft?.name || 'New Proxy')
  const recovery = state.phase === 'loadFailed' || state.unread || state.error?.code === 'NOT_FOUND' ? [{ label: 'Reload', run: () => proxyDocuments.reload(state.id) }] : []
  const field = state.error?.field as AgentProxyField | undefined
  const banner = <>
    {phaseLabel && <p className="document-status" role="status"><Icon name="loading" spin />{phaseLabel}</p>}
    {state.error && !field && <InlineError message={state.error.message} code={state.error.code} context={`Proxy ${name} on ${state.server}`} actions={recovery} />}
    {field && <p className="property-field-error" role="alert"><Icon name="error" />{`Not saved: ${proxyFieldLabels[field] ?? field}. ${state.error?.message ?? ''}`}</p>}
    {!state.error && state.notice && <p className="document-status" role="status"><Icon name="pass" />{state.notice}</p>}
    {draft?.credentialMode === 'new' && <p className="field-note"><Icon name="lock" />{credentialText.scriptSecret}</p>}
  </>
  const pill = model ? model.proxy ? <StatusPill tone={model.proxy.enabled ? 'success' : 'neutral'} label={model.proxy.enabled ? 'Enabled' : 'Disabled'} /> : <StatusPill tone="neutral" label="Not saved yet" /> : null
  const header = { title: name, subtitle: model?.proxy ? 'Proxy Account Properties' : 'New Proxy', crumbs: [{ label: state.server, title: state.login ? `${state.server} (${state.login})` : state.server }, { label: 'SQL Server Agent' }, { label: 'Proxies' }] }
  return <FieldHints><DocumentFrame id={`agent-proxy-${state.id}`} {...header} state={pill} verbs={verbs} banner={banner} sections={sections} frame={state.frame}
    onFrame={frame => proxyDocuments.setFrame(state.id, frame)} attributes={{ 'data-agent-proxy': state.id }}
    script={{ content: state.script, notice: state.scriptNotice, onDeliver: destination => void proxyDocuments.deliver(state.id, destination) }} hint={<FieldHintStrip />} /></FieldHints>
}
