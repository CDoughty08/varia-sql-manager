// The Credential document (AG-8b, docs/sql-server-agent.md › Proxies and credentials): the credential (name, identity, password behind
// "Change identity and password", provider for New Credential) and what uses it (proxies, then their job steps). AgentObjectDocumentService
// keeps the tab, the describe, the Script drawer and Save; this says what a credential's model, draft, problems and request are. Save always
// sends the secret: ALTER CREDENTIAL sets the identity and the secret together.
import {
  credentialChangeCount, credentialProblems, credentialSave, credentialTabName, credentialText, initialCredentialDraft,
  type CredentialDocumentModel, type CredentialDraft, type CredentialField
} from '../../../shared/actions/agent-proxy.ts'
import type { ActionDescribeResult } from '../../../shared/actions/schema.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { AgentObjectDocumentService, type AgentObjectDocumentServiceOptions, type AgentObjectDocumentState, type AgentObjectDocumentText, type AgentObjectSave } from './AgentObjectDocumentService'

export type CredentialDocumentState = AgentObjectDocumentState<CredentialDocumentModel, CredentialDraft>
export type CredentialSection = 'credential' | 'usedBy'
export const credentialSections: readonly { readonly id: CredentialSection; readonly title: string }[] = [{ id: 'credential', title: 'Credential' }, { id: 'usedBy', title: 'Used by' }]
export const credentialFieldLabels: { readonly [F in CredentialField]: string } = { name: 'Name', identity: 'Identity', secret: 'Password', provider: 'Provider' }

const text: AgentObjectDocumentText = {
  readFailed: 'The credential could not be read: it may have been dropped or renamed. Refresh Object Explorer.',
  saving: 'The credential is being saved. Wait for Save to finish before closing it.',
  disconnected: 'The connection is closed. Reconnect, then reload the credential.',
  lost: 'The connection was lost while saving; the credential may or may not have been saved. Reconnect and reload it to see.',
  backendLost: 'The backend stopped while saving; the credential may or may not have been saved. Reload it once the backend is back.',
  savedUnread: 'The credential was saved, but reading it again failed.',
  unsaved: 'The credential was not saved.',
  partlySaved: 'The rest of the credential was saved.'
}

export class CredentialDocumentService extends AgentObjectDocumentService<CredentialDocumentModel, CredentialDraft, CredentialField> {
  protected readonly dialog = 'credential' as const
  protected readonly text = text
  protected readonly sectionIds = credentialSections

  constructor(options: AgentObjectDocumentServiceOptions) { super(options, 'credential') }

  /** A credential's document (Properties on a credential). */
  openCredential(connectionId: string, name: string): string { return this.openTarget(connectionId, { kind: 'credential', name }) }
  /** New Credential, on the server. */
  newCredential(connectionId: string): string { return this.openTarget(connectionId, { kind: 'server' }) }

  /** "Change identity and password": unchecking it puts the identity back and empties the password fields. */
  setChange(id: string, change: boolean): void {
    const state = this.get(id)
    if (!state?.model?.credential || !state.draft || state.draft.change === change) return
    this.updateDraft(id, change ? { change } : { change, identity: state.model.credential.identity })
    if (!change) this.forgetSecret(id)
  }

  protected tabName(target: ObjectRef): string { return credentialTabName(target.kind === 'credential' ? target.name : undefined) }
  protected existing(target: ObjectRef): boolean { return target.kind === 'credential' }
  protected modelOf(result: ActionDescribeResult): CredentialDocumentModel | undefined { return result.credentialDocument }
  protected hasObject(model: CredentialDocumentModel): boolean { return !!model.credential }
  protected initialDraft(model: CredentialDocumentModel): CredentialDraft { return initialCredentialDraft(model) }
  protected changedFields(base: CredentialDraft, draft: CredentialDraft): readonly CredentialField[] {
    const fields: CredentialField[] = []
    if (base.name !== draft.name) fields.push('name')
    if (base.identity !== draft.identity) fields.push('identity')
    if (base.provider !== draft.provider) fields.push('provider')
    if (base.change !== draft.change) fields.push('secret')
    return fields
  }
  protected draftProblems(model: CredentialDocumentModel, draft: CredentialDraft, secrets: Parameters<typeof credentialProblems>[2]) { return credentialProblems(model, draft, secrets) }
  protected changeCount(model: CredentialDocumentModel, draft: CredentialDraft): number { return credentialChangeCount(model, draft) }
  protected buildSave(model: CredentialDocumentModel, draft: CredentialDraft): AgentObjectSave | undefined {
    const save = credentialSave(model, draft)
    if (!save) return undefined
    const target: ObjectRef = model.credential ? { kind: 'credential', name: model.credential.name } : { kind: 'server' }
    return { request: { action: 'credential', target, credential: save }, secret: true }
  }
  protected savedTarget(state: CredentialDocumentState, save: AgentObjectSave): ObjectRef {
    const request = save.request as { readonly credential?: { readonly name?: string } }
    return { kind: 'credential', name: request.credential?.name ?? state.model?.credential?.name ?? '' }
  }
  protected savedNotice(created: boolean): string { return created ? credentialText.created : credentialText.saved }
  protected readOnly(model: CredentialDocumentModel): string | undefined { return model.readOnly }
}
