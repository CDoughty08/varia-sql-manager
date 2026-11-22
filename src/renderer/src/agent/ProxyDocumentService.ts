// The SQL Server Agent proxy document (AG-8b, docs/sql-server-agent.md › Proxies and credentials): one screen, Proxy (with its credential,
// existing or created in place), Subsystems, Principals and References. AgentObjectDocumentService keeps the tab, the describe, the Script
// drawer and Save; this says what a proxy's model, draft, problems and request are.
import {
  agentProxyChangeCount, agentProxyProblems, agentProxySave, agentProxySaveSendsSecret, agentProxyTabName, agentProxyText, changedAgentProxyFields, initialAgentProxyDraft,
  type AgentProxyDocumentModel, type AgentProxyDraft, type AgentProxyField, type ProxyPrincipal
} from '../../../shared/actions/agent-proxy.ts'
import type { ActionDescribeResult } from '../../../shared/actions/schema.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { AgentObjectDocumentService, type AgentObjectDocumentServiceOptions, type AgentObjectDocumentState, type AgentObjectDocumentText, type AgentObjectSave } from './AgentObjectDocumentService'

export type ProxyDocumentState = AgentObjectDocumentState<AgentProxyDocumentModel, AgentProxyDraft>
export type ProxySection = 'proxy' | 'subsystems' | 'principals' | 'references'
export const proxySections: readonly { readonly id: ProxySection; readonly title: string }[] = [
  { id: 'proxy', title: 'Proxy' }, { id: 'subsystems', title: 'Subsystems' }, { id: 'principals', title: 'Principals' }, { id: 'references', title: 'References' }
]
/** The section each field's problem marks. */
export const proxyFieldSection: { readonly [F in AgentProxyField]: ProxySection } = {
  name: 'proxy', enabled: 'proxy', description: 'proxy', credential: 'proxy', subsystems: 'subsystems', principals: 'principals'
}
export const proxyFieldLabels: { readonly [F in AgentProxyField]: string } = {
  name: 'Name', enabled: 'Enabled', description: 'Description', credential: 'Credential', subsystems: 'Subsystems', principals: 'Principals'
}

const text: AgentObjectDocumentText = {
  readFailed: 'The proxy could not be read: it may have been deleted or renamed. Refresh Object Explorer.',
  saving: 'The proxy is being saved. Wait for Save to finish before closing it.',
  disconnected: 'The connection is closed. Reconnect, then reload the proxy.',
  lost: 'The connection was lost while saving; the proxy may or may not have been saved. Reconnect and reload it to see.',
  backendLost: 'The backend stopped while saving; the proxy may or may not have been saved. Reload it once the backend is back.',
  savedUnread: 'The proxy was saved, but reading it again failed.',
  unsaved: 'The proxy was not saved.',
  partlySaved: 'The proxy was saved, but not every principal change:'
}

export class ProxyDocumentService extends AgentObjectDocumentService<AgentProxyDocumentModel, AgentProxyDraft, AgentProxyField> {
  protected readonly dialog = 'agentProxy' as const
  protected readonly text = text
  protected readonly sectionIds = proxySections

  constructor(options: AgentObjectDocumentServiceOptions) { super(options, 'agentProxy') }

  /** A proxy's document (Properties on a proxy). */
  openProxy(connectionId: string, name: string): string { return this.openTarget(connectionId, { kind: 'agentProxy', name }) }
  /** New Proxy, active to `subsystem` when opened from that subsystem's folder. */
  newProxy(connectionId: string, subsystem?: string): string { return this.openTarget(connectionId, { kind: 'agent' }, subsystem) }

  /** Grants a principal (a picked choice, or a typed name taken as a login) in the draft. */
  addPrincipal(id: string, principal: ProxyPrincipal): void {
    const draft = this.get(id)?.draft
    const name = principal.name.trim()
    if (!draft || !name || draft.principals.some(item => item.name.toLowerCase() === name.toLowerCase())) return
    this.updateDraft(id, { principals: [...draft.principals, { name, kind: principal.kind }] })
  }
  removePrincipal(id: string, principal: ProxyPrincipal): void {
    const draft = this.get(id)?.draft
    if (draft) this.updateDraft(id, { principals: draft.principals.filter(item => item.name !== principal.name || item.kind !== principal.kind) })
  }
  toggleSubsystem(id: string, subsystem: number): void {
    const draft = this.get(id)?.draft
    if (draft) this.updateDraft(id, { subsystems: draft.subsystems.includes(subsystem) ? draft.subsystems.filter(item => item !== subsystem) : [...draft.subsystems, subsystem].sort((a, b) => a - b) })
  }
  /** Use an existing credential, or create one: leaving "create" empties the password fields, whose secret only a new credential sends. */
  setCredentialMode(id: string, mode: AgentProxyDraft['credentialMode']): void {
    if (this.get(id)?.draft?.credentialMode === mode) return
    this.updateDraft(id, { credentialMode: mode })
    if (mode === 'existing') this.forgetSecret(id)
  }
  /** Whether the draft holds a principal already (the picker's "may use it already"). */
  hasPrincipal(id: string, name: string): boolean { return !!this.get(id)?.draft?.principals.some(item => item.name.toLowerCase() === name.trim().toLowerCase()) }
  /** The sections whose fields have an error (the save's own refusal included). */
  problemSections(id: string): ReadonlySet<ProxySection> {
    const state = this.get(id)
    const fields = this.problems(id).filter(problem => problem.severity === 'error').map(problem => problem.field)
    if (state?.error?.field && state.error.field in proxyFieldSection) fields.push(state.error.field as AgentProxyField)
    return new Set(fields.map(field => proxyFieldSection[field]))
  }

  protected tabName(target: ObjectRef): string { return agentProxyTabName(target.kind === 'agentProxy' ? target.name : undefined) }
  protected existing(target: ObjectRef): boolean { return target.kind === 'agentProxy' }
  protected modelOf(result: ActionDescribeResult): AgentProxyDocumentModel | undefined { return result.agentProxyDocument }
  protected hasObject(model: AgentProxyDocumentModel): boolean { return !!model.proxy }
  protected initialDraft(model: AgentProxyDocumentModel, state: ProxyDocumentState): AgentProxyDraft { return initialAgentProxyDraft(model, state.preset) }
  protected changedFields(base: AgentProxyDraft, draft: AgentProxyDraft): readonly AgentProxyField[] { return changedAgentProxyFields(base, draft) }
  protected draftProblems(model: AgentProxyDocumentModel, draft: AgentProxyDraft, secrets: Parameters<typeof agentProxyProblems>[2]) { return agentProxyProblems(model, draft, secrets) }
  protected changeCount(model: AgentProxyDocumentModel, draft: AgentProxyDraft): number { return agentProxyChangeCount(initialAgentProxyDraft(model), draft) }
  protected buildSave(model: AgentProxyDocumentModel, draft: AgentProxyDraft): AgentObjectSave | undefined {
    const save = agentProxySave(model, draft)
    if (!save) return undefined
    const target: ObjectRef = model.proxy ? { kind: 'agentProxy', name: model.proxy.name } : { kind: 'agent' }
    return { request: { action: 'agentProxy', target, agentProxy: save, ...model.proxy ? { proxyId: model.proxy.id } : {} }, secret: agentProxySaveSendsSecret(save) }
  }
  protected savedTarget(state: ProxyDocumentState, save: AgentObjectSave): ObjectRef {
    const request = save.request as { readonly agentProxy?: { readonly name?: string } }
    return { kind: 'agentProxy', name: request.agentProxy?.name ?? state.model?.proxy?.name ?? state.draft?.name.trim() ?? '' }
  }
  protected savedNotice(created: boolean, secret: boolean): string { return secret ? agentProxyText.savedSecret : created ? agentProxyText.created : agentProxyText.saved }
  protected readOnly(): string | undefined { return undefined }
}
