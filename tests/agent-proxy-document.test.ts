import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandDescriptor } from '../src/shared/commands/catalog'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import {
  agentProxyChangeCount, agentProxyProblems, agentProxySave, agentProxySaveProblems, agentProxySaveSchema, agentProxyText, credentialProblems, credentialSave, credentialSaveSchema, credentialSecretsSchema,
  credentialText, initialAgentProxyDraft, initialCredentialDraft, proxyPrincipalsStep, savable, type AgentProxyDocumentModel, type CredentialDocumentModel
} from '../src/shared/actions/agent-proxy'
import { actionExecuteResultSchema, type ActionDescribeResult, type ActionExecuteResult, type ActionRequest, type ActionScriptRequest } from '../src/shared/actions/schema'
import { agentLimits } from '../src/shared/agent/catalog'
import type { ApiResult } from '../src/shared/contracts'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const secret = "Tr0ub4dor&3 o'clock"
const proxyModel = (patch: Partial<AgentProxyDocumentModel> = {}): AgentProxyDocumentModel => ({
  proxy: { id: 5, name: 'FileShareWriter', enabled: true, description: 'Writes extracts', credential: 'FileShareWriterCred', credentialIdentity: 'CONTOSO\\svc-fswriter', subsystems: [3, 12], principals: [{ name: 'CONTOSO\\etl', kind: 'login' }] },
  platform: 'windows', subsystems: [{ id: 3, name: 'CmdExec' }, { id: 11, name: 'SSIS' }, { id: 12, name: 'PowerShell' }],
  credentials: [{ name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter' }, { name: 'Other', identity: 'CONTOSO\\other' }], credentialsTruncated: false, canCreateCredential: true,
  principalChoices: [{ name: 'CONTOSO\\etl', kind: 'login' }, { name: 'SQLAgentOperatorRole', kind: 'msdbRole' }, { name: 'securityadmin', kind: 'serverRole' }], references: [], referencesTruncated: false, ...patch
})
const credentialModel = (patch: Partial<CredentialDocumentModel> = {}): CredentialDocumentModel => ({
  credential: { id: 9, name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter', created: '2025-03-02T10:20:00', modified: '2026-11-08T16:02:11.123' },
  platform: 'box', providers: [], usedBy: [{ proxy: 'FileShareWriter', subsystems: ['CmdExec'], steps: [{ job: 'Export', stepId: 2, step: 'Upload' }] }], usedByTruncated: false, ...patch
})

describe("the proxy and credential documents' shared rules", () => {
  it('saves only what changed on a proxy, and New Proxy whole with its credential', () => {
    const model = proxyModel(), draft = initialAgentProxyDraft(model)
    expect(agentProxySave(model, draft)).toBeUndefined()
    const changed = { ...draft, description: 'x', subsystems: [3, 11], principals: [{ name: 'SQLAgentOperatorRole', kind: 'msdbRole' as const }] }
    expect(agentProxySave(model, changed)).toEqual({ description: 'x', grantSubsystems: [11], revokeSubsystems: [12], grantPrincipals: [{ name: 'SQLAgentOperatorRole', kind: 'msdbRole' }], revokePrincipals: ['CONTOSO\\etl'] })
    expect(agentProxyChangeCount(draft, changed)).toBe(5)
    const created = proxyModel({ proxy: undefined, references: undefined })
    const blank = initialAgentProxyDraft(created, 'PowerShell')
    expect(blank).toMatchObject({ subsystems: [12], credentialMode: 'existing', enabled: true })
    const save = agentProxySave(created, { ...blank, name: ' New ', credentialMode: 'new', newCredentialName: 'NewCred', newCredentialIdentity: 'CONTOSO\\svc' })!
    expect(save).toEqual({ name: 'New', newCredential: { name: 'NewCred', identity: 'CONTOSO\\svc' }, grantSubsystems: [12] })
    expect(agentProxySaveProblems(save, true)).toEqual([])
    expect(agentProxySaveProblems({ name: 'x', credential: 'c', revokeSubsystems: [3] }, true)).toContain('A new proxy has nothing to revoke.')
  })
  it('stops Save on a new credential without its secret, a mismatched confirmation or a taken name, and only warns with no subsystem', () => {
    const created = proxyModel({ proxy: undefined })
    const draft = { ...initialAgentProxyDraft(created), name: 'New', credentialMode: 'new' as const, newCredentialName: 'NewCred', newCredentialIdentity: 'CONTOSO\\svc' }
    expect(agentProxyProblems(created, draft).map(problem => problem.message)).toContain(credentialText.secretRequired)
    expect(agentProxyProblems(created, draft, { secret: 'set', matches: false, wellFormed: true, tooLong: false }).map(problem => problem.message)).toContain(credentialText.secretMismatch)
    expect(agentProxyProblems(created, { ...draft, newCredentialName: 'other' }, { secret: 'set', matches: true, wellFormed: true, tooLong: false }).map(problem => problem.message)).toContain(agentProxyText.newCredentialTaken)
    const fine = agentProxyProblems(created, draft, { secret: 'set', matches: true, wellFormed: true, tooLong: false })
    expect(fine.map(problem => [problem.field, problem.severity])).toEqual([['subsystems', 'warning']])
    expect(savable(fine)).toBe(true)
  })
  it('sends an existing credential\'s identity with its STALE guard only behind "Change identity and password"', () => {
    const model = credentialModel(), draft = initialCredentialDraft(model)
    expect(credentialSave(model, draft)).toBeUndefined()
    expect(credentialSave(model, { ...draft, change: true })).toEqual({ id: 9, modified: '2026-11-08T16:02:11.123', identity: 'CONTOSO\\svc-fswriter' })
    expect(credentialProblems(model, draft)).toEqual([])
    expect(credentialProblems(model, { ...draft, change: true }).map(problem => problem.field)).toEqual(['secret'])
    expect(credentialProblems(credentialModel({ platform: 'managedInstance' }), { ...draft, change: true }, { secret: 'set', matches: true, wellFormed: true, tooLong: false }).map(problem => problem.message))
      .toEqual([credentialText.windowsIdentityManagedInstance])
  })
  it("lets main pass a refusal that lands on a proxy's or a credential's field", () => {
    for (const field of ['credential', 'subsystems', 'principals', 'identity', 'secret', 'provider', 'description'])
      expect(actionExecuteResultSchema.safeParse({ steps: [], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'no', retryable: false, field } }).success, field).toBe(true)
    expect(actionExecuteResultSchema.safeParse({ steps: [], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'no', retryable: false, field: 'password' } }).success).toBe(false)
  })
  it('bounds the requests in zod as C# does: a 128-character identity (SQL Server refuses more) and a 4,000-character secret', () => {
    expect(credentialSaveSchema.safeParse({ name: 'c', identity: 'i'.repeat(agentLimits.credentialIdentityChars) }).success).toBe(true)
    expect(agentLimits.credentialIdentityChars).toBe(128)
    expect(credentialSaveSchema.safeParse({ name: 'c', identity: 'i'.repeat(129) }).success).toBe(false)
    expect(agentProxySaveSchema.safeParse({ newCredential: { name: 'c', identity: 'i'.repeat(129) } }).success).toBe(false)
    expect(credentialSecretsSchema.safeParse({ secret: 's'.repeat(4000) }).success).toBe(true)
    expect(credentialSecretsSchema.safeParse({ secret: 's'.repeat(4001) }).success).toBe(false)
    expect(credentialSecretsSchema.safeParse({ secret: '' }).success).toBe(false)
    expect(credentialSecretsSchema.safeParse({ secret: 'a\uD800' }).success).toBe(false)
    expect(credentialSaveSchema.safeParse({ id: 9, modified: '2026-11-08T16:02:11.123', identity: 'x', secret: 'leak' }).success).toBe(false)
  })
})

/** A workbench whose describe answers the proxy and credential documents' models. */
function opened(proxy = proxyModel(), credential = credentialModel()) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  let currentProxy = proxy, currentCredential = credential
  const answers: ApiResult<ActionExecuteResult>[] = []
  fixture.api.describeObject.mockImplementation(async params => ({
    ok: true, value: (params.dialog === 'agentProxy' ? { agentProxyDocument: params.target.kind === 'agent' ? { ...currentProxy, proxy: undefined, references: undefined } : currentProxy, elapsedMs: 1 }
      : params.dialog === 'credential' ? { credentialDocument: params.target.kind === 'server' ? { ...currentCredential, credential: undefined, usedBy: undefined } : currentCredential, elapsedMs: 1 }
        : { elapsedMs: 1 }) as ActionDescribeResult
  }))
  fixture.api.executeObjectAction.mockImplementation(async () => answers.shift() ?? { ok: true, value: { steps: [{ status: 'done', title: 'Save' }], messages: [], elapsedMs: 1 } })
  fixture.api.scriptObjectAction.mockImplementation(async () => ({ ok: true, value: { text: 'EXEC msdb.dbo.sp_add_proxy', database: 'msdb', warnings: [], elapsedMs: 1 } }))
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, executes, answers, setProxy: (next: AgentProxyDocumentModel) => { currentProxy = next }, setCredential: (next: CredentialDocumentModel) => { currentCredential = next } }
}
const holds = (value: unknown, text: string) => JSON.stringify(value).includes(text)

describe('the proxy document', () => {
  it('opens one tab per proxy and saves only the changes under the id it read', async () => {
    const { proxyDocuments, documents, executes } = opened()
    const id = proxyDocuments.openProxy('c1', 'FileShareWriter')
    expect(documents.active).toMatchObject({ id, kind: 'agentProxy', name: 'Proxy Account Properties - FileShareWriter', connectionId: 'c1' })
    await settled()
    expect(proxyDocuments.openProxy('c1', 'FileShareWriter')).toBe(id)
    proxyDocuments.updateDraft(id, { description: 'Rebuilds' })
    proxyDocuments.toggleSubsystem(id, 12)
    proxyDocuments.addPrincipal(id, { name: 'SQLAgentOperatorRole', kind: 'msdbRole' })
    proxyDocuments.addPrincipal(id, { name: 'contoso\\ETL', kind: 'login' })
    expect(proxyDocuments.get(id)).toMatchObject({ changes: 3 })
    expect(documents.get(id)?.dirty).toBe(true)
    expect(await proxyDocuments.save(id)).toBe(true)
    expect(executes()).toEqual([{
      action: 'agentProxy', target: { kind: 'agentProxy', name: 'FileShareWriter' }, proxyId: 5, connectionId: 'c1', requestId: expect.any(String),
      agentProxy: { description: 'Rebuilds', revokeSubsystems: [12], grantPrincipals: [{ name: 'SQLAgentOperatorRole', kind: 'msdbRole' }] }
    }])
    expect(proxyDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0, notice: agentProxyText.saved })
  })
  it('keeps a new credential\'s password only in the slot: never in a snapshot, a draft or Script, sent once, then emptied', async () => {
    const { proxyDocuments, documents, executes, api } = opened()
    const id = proxyDocuments.newProxy('c1', 'CmdExec')
    await settled()
    expect(documents.get(id)).toMatchObject({ kind: 'agentProxy', name: 'New Proxy' })
    expect(proxyDocuments.get(id)?.draft?.subsystems).toEqual([3])
    proxyDocuments.updateDraft(id, { name: 'New' })
    proxyDocuments.setCredentialMode(id, 'new')
    proxyDocuments.updateDraft(id, { newCredentialName: 'NewCred', newCredentialIdentity: 'CONTOSO\\svc' })
    proxyDocuments.setSecret(id, 'secret', secret)
    expect(proxyDocuments.canSave(id)).toBe(false)
    proxyDocuments.setSecret(id, 'confirm', secret)
    expect(proxyDocuments.canSave(id)).toBe(true)
    expect(proxyDocuments.get(id)?.secrets).toEqual({ secret: 'set', matches: true, wellFormed: true, tooLong: false })
    expect(holds(proxyDocuments.getSnapshot(), secret)).toBe(false)
    expect(holds(documents.getSnapshot(), secret)).toBe(false)
    proxyDocuments.setFrame(id, { ...proxyDocuments.get(id)!.frame, scriptOpen: true })
    await settled()
    const scripted = api.scriptObjectAction.mock.calls.map(([sent]) => sent as ActionScriptRequest)
    expect(scripted.length).toBeGreaterThan(0)
    expect(scripted.every(sent => !holds(sent, secret) && !('secrets' in sent))).toBe(true)
    const epoch = proxyDocuments.get(id)!.secretEpoch
    expect(await proxyDocuments.save(id)).toBe(true)
    expect(executes()).toEqual([{
      action: 'agentProxy', target: { kind: 'agent' }, connectionId: 'c1', requestId: expect.any(String), secrets: { secret },
      agentProxy: { name: 'New', newCredential: { name: 'NewCred', identity: 'CONTOSO\\svc' }, grantSubsystems: [3] }
    }])
    expect(proxyDocuments.holdsSecrets).toBe(false)
    expect(proxyDocuments.get(id)).toMatchObject({ target: { kind: 'agentProxy', name: 'New' }, notice: agentProxyText.savedSecret, secrets: { secret: 'empty' } })
    expect(proxyDocuments.get(id)!.secretEpoch).toBeGreaterThan(epoch)
    expect(documents.get(id)?.name).toBe('Proxy Account Properties - New')
  })
  it('empties the password fields when the proxy goes back to an existing credential, and when it closes', async () => {
    const { proxyDocuments, documents } = opened()
    const id = proxyDocuments.openProxy('c1', 'FileShareWriter')
    await settled()
    proxyDocuments.setCredentialMode(id, 'new')
    proxyDocuments.setSecret(id, 'secret', secret)
    expect(proxyDocuments.holdsSecrets).toBe(true)
    proxyDocuments.setCredentialMode(id, 'existing')
    expect(proxyDocuments.holdsSecrets).toBe(false)
    expect(proxyDocuments.get(id)?.secrets.secret).toBe('empty')
    proxyDocuments.setCredentialMode(id, 'new')
    proxyDocuments.setSecret(id, 'secret', secret)
    await documents.close(id)
    await settled()
    expect(proxyDocuments.holdsSecrets).toBe(false)
  })
  it('keeps the draft and the typed password on a refusal, and reads the proxy again when only the principals step was refused', async () => {
    const { proxyDocuments, answers, api, setProxy } = opened()
    const id = proxyDocuments.openProxy('c1', 'FileShareWriter')
    await settled()
    proxyDocuments.updateDraft(id, { description: 'Mine' })
    answers.push({ ok: true, value: { steps: [{ status: 'failed', title: 'Save the proxy' }], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'Changing the proxy\'s settings was refused: no.', retryable: false, field: 'description' } } })
    expect(await proxyDocuments.save(id)).toBe(false)
    expect(proxyDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 1, draft: { description: 'Mine' }, error: { field: 'description' } })
    const reads = api.describeObject.mock.calls.length
    proxyDocuments.addPrincipal(id, { name: 'securityadmin', kind: 'serverRole' })
    setProxy(proxyModel({ proxy: { ...proxyModel().proxy!, description: 'Mine' } }))
    answers.push({ ok: true, value: { steps: [{ status: 'done', title: 'Save the proxy' }, { status: 'failed', title: 'Grant and revoke principals' }], messages: [], elapsedMs: 1,
      error: { code: 'PERMISSION_DENIED', message: "Granting 'securityadmin' the proxy was refused: no.", retryable: false, field: 'principals' } } })
    expect(await proxyDocuments.save(id)).toBe(false)
    expect(api.describeObject.mock.calls.length).toBe(reads + 1)
    expect(proxyDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0, model: { proxy: { description: 'Mine' } }, error: { field: 'principals' } })
    expect(proxyDocuments.get(id)?.error?.message).toBe("Granting 'securityadmin' the proxy was refused: no. The rest of the proxy was saved.")
    // A principals-only save: its one step runs without a transaction, so the grants before a refused one stay made, and the proxy is read again.
    proxyDocuments.addPrincipal(id, { name: 'securityadmin', kind: 'serverRole' })
    proxyDocuments.addPrincipal(id, { name: 'SQLAgentOperatorRole', kind: 'msdbRole' })
    setProxy(proxyModel({ proxy: { ...proxyModel().proxy!, description: 'Mine', principals: [...proxyModel().proxy!.principals, { name: 'securityadmin', kind: 'serverRole' }] } }))
    answers.push({ ok: true, value: { steps: [{ status: 'failed', title: proxyPrincipalsStep }], messages: [], elapsedMs: 1,
      error: { code: 'SQL_ERROR', message: "Granting 'SQLAgentOperatorRole' the proxy was refused: no.", retryable: false, field: 'principals' } } })
    expect(await proxyDocuments.save(id)).toBe(false)
    expect(api.describeObject.mock.calls.length).toBe(reads + 2)
    expect(proxyDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0, model: { proxy: { principals: [{ name: 'CONTOSO\\etl' }, { name: 'securityadmin' }] } }, error: { field: 'principals' } })
    // A re-read that fails after a partial save says so too, beside the refusal.
    proxyDocuments.addPrincipal(id, { name: 'SQLAgentOperatorRole', kind: 'msdbRole' })
    api.describeObject.mockImplementationOnce(async () => ({ ok: false, error: 'The connection dropped.' }))
    answers.push({ ok: true, value: { steps: [{ status: 'failed', title: proxyPrincipalsStep }], messages: [], elapsedMs: 1,
      error: { code: 'SQL_ERROR', message: 'Refused.', retryable: false, field: 'principals' } } })
    expect(await proxyDocuments.save(id)).toBe(false)
    expect(proxyDocuments.get(id)?.error?.message).toBe('Refused. The rest of the proxy was saved. The proxy was saved, but reading it again failed. The connection dropped.')
    // The model is older than the server now: nothing changes until a read succeeds.
    expect(proxyDocuments.get(id)?.unread).toBe(true)
    expect(proxyDocuments.canEdit(id)).toBe(false)
    proxyDocuments.reload(id)
    await settled()
    expect(proxyDocuments.get(id)?.unread).toBeUndefined()
    expect(proxyDocuments.canEdit(id)).toBe(true)
  })
  it('cannot create a new proxy twice when reading it after its Create fails', async () => {
    const { proxyDocuments, api, executes } = opened()
    const id = proxyDocuments.newProxy('c1')
    await settled()
    proxyDocuments.updateDraft(id, { name: 'New', credential: 'Other' })
    expect(proxyDocuments.canSave(id)).toBe(true)
    api.describeObject.mockImplementationOnce(async () => ({ ok: false, error: 'The connection dropped.' }))
    expect(await proxyDocuments.save(id)).toBe(true)
    expect(proxyDocuments.get(id)).toMatchObject({ phase: 'ready', unread: true, target: { kind: 'agentProxy', name: 'New' } })
    expect(proxyDocuments.canSave(id)).toBe(false)
    expect(await proxyDocuments.save(id)).toBe(false)
    expect(executes()).toHaveLength(1)
  })
  it('flags more principals than the document lists', () => {
    const model = proxyModel(), draft = initialAgentProxyDraft(model)
    const many = Array.from({ length: agentLimits.proxyPrincipals + 1 }, (_, index) => ({ name: `login${index}`, kind: 'login' as const }))
    expect(agentProxyProblems(model, { ...draft, principals: many })).toContainEqual(expect.objectContaining({ field: 'principals', severity: 'error' }))
    expect(agentProxyProblems(model, { ...draft, principals: many.slice(1) }).some(problem => problem.field === 'principals')).toBe(false)
  })
  it("names the principals' step as the backend does", () => {
    expect(readFileSync('backend/Varia.Backend/Actions/AgentProxyDocument.cs', 'utf8')).toContain(`ProxyPrincipalsStep = "${proxyPrincipalsStep}"`)
  })
})

describe('the credential document', () => {
  it('opens read-only fields behind "Change identity and password" and sends the identity and the secret together', async () => {
    const { credentialDocuments, documents, executes } = opened()
    const id = credentialDocuments.openCredential('c1', 'FileShareWriterCred')
    expect(documents.active).toMatchObject({ id, kind: 'credential', name: 'Credential Properties - FileShareWriterCred' })
    await settled()
    expect(credentialDocuments.canSave(id)).toBe(false)
    credentialDocuments.setChange(id, true)
    credentialDocuments.updateDraft(id, { identity: 'CONTOSO\\svc-new' })
    credentialDocuments.setSecret(id, 'secret', secret)
    credentialDocuments.setSecret(id, 'confirm', secret)
    expect(credentialDocuments.get(id)?.changes).toBe(2)
    expect(holds(credentialDocuments.getSnapshot(), secret)).toBe(false)
    expect(await credentialDocuments.save(id)).toBe(true)
    expect(executes()).toEqual([{
      action: 'credential', target: { kind: 'credential', name: 'FileShareWriterCred' }, connectionId: 'c1', requestId: expect.any(String), secrets: { secret },
      credential: { id: 9, modified: '2026-11-08T16:02:11.123', identity: 'CONTOSO\\svc-new' }
    }])
    expect(credentialDocuments.holdsSecrets).toBe(false)
    expect(credentialDocuments.get(id)).toMatchObject({ notice: credentialText.saved, draft: { change: false } })
  })
  it('puts the identity back and empties the password when the change is unchecked; a read-only credential cannot change', async () => {
    const { credentialDocuments } = opened(proxyModel(), credentialModel({ readOnly: credentialText.readOnly }))
    const readOnly = credentialDocuments.openCredential('c1', 'FileShareWriterCred')
    await settled()
    expect(credentialDocuments.canEdit(readOnly)).toBe(false)
    credentialDocuments.setChange(readOnly, true)
    expect(credentialDocuments.get(readOnly)?.draft?.change).toBe(false)
    const fresh = opened()
    const id = fresh.credentialDocuments.openCredential('c1', 'FileShareWriterCred')
    await settled()
    fresh.credentialDocuments.setChange(id, true)
    fresh.credentialDocuments.updateDraft(id, { identity: 'x' })
    fresh.credentialDocuments.setSecret(id, 'secret', secret)
    fresh.credentialDocuments.setChange(id, false)
    expect(fresh.credentialDocuments.holdsSecrets).toBe(false)
    expect(fresh.credentialDocuments.get(id)).toMatchObject({ changes: 0, draft: { identity: 'CONTOSO\\svc-fswriter', change: false } })
  })
  it('creates a credential on the server with its provider', async () => {
    const { credentialDocuments, executes } = opened(proxyModel(), credentialModel({ providers: ['Ekm'] }))
    const id = credentialDocuments.newCredential('c1')
    await settled()
    credentialDocuments.updateDraft(id, { name: 'Vault', identity: 'vault-user', provider: 'Ekm' })
    credentialDocuments.setSecret(id, 'secret', secret)
    credentialDocuments.setSecret(id, 'confirm', secret)
    expect(await credentialDocuments.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({ action: 'credential', target: { kind: 'server' }, secrets: { secret }, credential: { name: 'Vault', identity: 'vault-user', provider: 'Ekm' } })
    expect(credentialDocuments.get(id)).toMatchObject({ target: { kind: 'credential', name: 'Vault' }, notice: credentialText.created })
  })
})

describe('no release gate (AG-9)', () => {
  it('registers the proxy and credential commands with no environment variable set', () => {
    const ids = ['agent.newProxy', 'agent.newProxyOnAgent', 'agentProxy.save', 'agentProxy.reload', 'agent.newCredential', 'credential.save', 'credential.reload'] as const
    const fixture = workbenchFixture()
    try { expect(ids.filter(id => !fixture.commands.has(id))).toEqual([]) } finally { fixture.dispose() }
  })
  it("offers a credential's Properties (its document) and New Credential… with no gate", () => {
    const credential = { id: 7, lost: false, kind: 'credential', connectionId: 'c1', label: 'FileShareWriterCred', engine: 'box', ref: { type: 'object', object: { kind: 'credential', name: 'FileShareWriterCred' } } } as unknown as ExplorerMenuNode
    const args = { target: { kind: 'explorer' as const, node: credential } }
    const fixture = workbenchFixture()
    try {
      fixture.api.push(readyBackend())
      fixture.connect(connectionInfo('c1'))
      expect(fixture.commands.canRun('explorer.properties', args)).toBe(true)
    } finally { fixture.dispose() }
    expect(commandDescriptor('agent.newCredential').menus?.some(placement => placement.when?.includes('agentEnabled'))).toBe(false)
  })
  it("opens New Credential… from the palette on the selected Credentials folder's server, not the active tab's", async () => {
    const { commands, documents, explorer, connect, credentialDocuments } = opened()
    connect(connectionInfo('c2'))
    documents.newQuery('', undefined, 'c1')
    const folder = { id: 9, lost: false, kind: 'folder', folder: 'credentials', connectionId: 'c2', label: 'Credentials', ref: { type: 'folder', owner: { kind: 'server' }, folder: 'credentials' } } as unknown as ExplorerMenuNode
    vi.spyOn(explorer, 'menuNode').mockReturnValue(folder)
    await commands.execute('agent.newCredential', { state: { explorerSelectionFolder: 'credentials' } }, 'palette')
    await settled()
    const opened_ = Object.values(credentialDocuments.getSnapshot().documents).at(-1)!
    expect(documents.get(opened_.id)?.connectionId).toBe('c2')
    // On a lost server it opens nowhere else: it says to connect.
    vi.spyOn(explorer, 'menuNode').mockReturnValue({ ...folder, lost: true })
    const before = Object.keys(credentialDocuments.getSnapshot().documents).length
    await commands.execute('agent.newCredential', { state: { explorerSelectionFolder: 'credentials' } }, 'palette')
    await settled()
    expect(Object.keys(credentialDocuments.getSnapshot().documents)).toHaveLength(before)
    expect(commands.getSnapshot().error).toBe('Connect to the server first.')
  })
})
