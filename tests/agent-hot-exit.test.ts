import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialAgentJobDraft, uncategorizedCategory, type AgentJobDocumentModel, type AgentJobRecord } from '../src/shared/actions/agent-job'
import type { AgentProxyDocumentModel, CredentialDocumentModel } from '../src/shared/actions/agent-proxy'
import { notifyEmail, type AgentAlertDocumentModel, type AgentAlertRecord } from '../src/shared/actions/agent-alert'
import { withCell, type AgentOperatorsModel } from '../src/shared/actions/agent-operator'
import type { AgentSchedulesModel } from '../src/shared/actions/agent-schedule'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import { decodeKeptState, encodeKeptState, keptAgentLimits, keptAgentText, keptJson, rebaseKeptDraft, sameShape } from '../src/shared/agent/kept'
import type { ConnectionAuthentication } from '../src/shared/connection-targets'
import type { RestoredSession } from '../src/shared/contracts'
import { sessionWriteSchema } from '../src/main/session-store'
import { recoveryWriteSchema } from '../src/main/recovery-store'
import { keptSession, restoreSession } from '../src/renderer/src/services/session'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const targetId = uuid(1)
const secret = "Tr0ub4dor&3 o'clock"

const record = (patch: Partial<AgentJobRecord> = {}): AgentJobRecord => ({
  jobId: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', enabled: true, description: 'Loads the warehouse', category: 'Data Collector', owner: 'sa',
  emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 2, deleteLevel: 0,
  created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, ...patch
})
const jobModel = (patch: Partial<AgentJobDocumentModel> = {}): AgentJobDocumentModel => ({
  job: record(), login: 'sa', sysadmin: true, platform: 'windows', categories: [uncategorizedCategory, 'Data Collector', 'Database Maintenance'], operators: [], owners: ['sa'],
  steps: [{ id: 1, name: 'Extract', subsystem: 'TSQL' }], alerts: [], alertsEditable: true, mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }, ...patch
})
const proxyModel = (): AgentProxyDocumentModel => ({
  proxy: { id: 5, name: 'FileShareWriter', enabled: true, description: 'Writes extracts', credential: 'FileShareWriterCred', credentialIdentity: 'CONTOSO\\svc-fswriter', subsystems: [3], principals: [] },
  platform: 'windows', subsystems: [{ id: 3, name: 'CmdExec' }], credentials: [{ name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter' }], credentialsTruncated: false, canCreateCredential: true,
  principalChoices: [], references: [], referencesTruncated: false
})
const credentialModel = (): CredentialDocumentModel => ({
  credential: { id: 9, name: 'FileShareWriterCred', identity: 'CONTOSO\svc-fswriter', created: '2025-03-02T10:20:00', modified: '2026-11-08T16:02:11.123' },
  platform: 'box', providers: [], usedBy: [], usedByTruncated: false
})
const schedulesModel = (): AgentSchedulesModel => ({ login: 'sa', sysadmin: true, platform: 'windows', now: '2026-11-22T14:30:00', schedules: [], jobs: [], links: [], durations: [] })

/** A workbench whose describe answers each Agent document from `models`, with registry-backed connection targets. */
function bench() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  const models = { job: jobModel(), proxy: proxyModel(), schedules: schedulesModel() }
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'agentJob' ? { agentJobDocument: params.target.kind === 'agent' ? { ...models.job, job: undefined, jobs: [], jobIds: [] } : models.job, elapsedMs: 1 }
    : params.dialog === 'agentProxy' ? { agentProxyDocument: params.target.kind === 'agent' ? { ...models.proxy, proxy: undefined } : models.proxy, elapsedMs: 1 }
      : params.dialog === 'credential' ? { credentialDocument: credentialModel(), elapsedMs: 1 }
      : params.dialog === 'agentSchedules' ? { agentSchedules: models.schedules, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
  const accept = (handleId: string, generation = 1) => {
    const attempt = fixture.connections.beginConnect(connectionOptions, generation, targetId)!
    const authentication: ConnectionAuthentication = { principal: { provider: 'sqlserver', authentication: 'sql', id: 'reader' } }
    expect(fixture.connections.accept(connectionInfo(handleId, generation), connectionOptions, targetId, authentication, attempt).status).toBe('accepted')
  }
  return { ...fixture, models, accept }
}
/** The state a job document keeps after the user changed its description, from a workbench that is then thrown away. */
async function keptJob(description = 'Mine'): Promise<{ readonly state: string; readonly name: string }> {
  const first = bench()
  first.accept(uuid(50))
  const id = first.jobDocuments.openJob(uuid(50), 'Nightly load')
  await settled()
  first.jobDocuments.updateDraft(id, { description })
  const state = first.documents.keepCustom(id)!
  return { state, name: first.documents.get(id)!.name }
}

describe('a kept SQL Server Agent document state', () => {
  it('round-trips through JSON, Maps included, and refuses another kind, an unknown target, a missing draft or a state past its limit', () => {
    const matrix = new Map([['Severity 017', new Map([['DBA', 1]])]])
    const text = encodeKeptState({ version: 1, kind: 'agentOperators', target: { kind: 'agent' }, server: 'sql01', model: { login: 'sa' }, draft: matrix, extra: { base: new Map() } })!
    const value = decodeKeptState(text, 'agentOperators')!
    expect(value.draft).toBeInstanceOf(Map)
    expect(keptJson(value.draft)).toBe(keptJson(matrix))
    expect(decodeKeptState(text, 'agentJob')).toBeUndefined()
    expect(decodeKeptState(encodeKeptState({ version: 1, kind: 'agentJob', target: { kind: 'table' as never }, server: 's', model: {}, draft: {} })!, 'agentJob')).toBeUndefined()
    expect(decodeKeptState(JSON.stringify({ version: 1, kind: 'agentJob', target: { kind: 'agentJob' }, server: 's', model: {} }), 'agentJob')).toBeUndefined()
    expect(decodeKeptState(JSON.stringify({ version: 1, kind: 'agentJob', target: { kind: 'agentJob' }, server: 's', model: {}, draft: {}, password: 'x' }), 'agentJob')).toBeUndefined()
    expect(decodeKeptState('not json', 'agentJob')).toBeUndefined()
    expect(encodeKeptState({ version: 1, kind: 'agentJob', target: { kind: 'agentJob', name: 'x' }, server: 's', model: { text: 'x'.repeat(keptAgentLimits.stateChars) }, draft: {} })).toBeUndefined()
  })
  it('checks a draft against the shape the document makes itself', () => {
    const draft = initialAgentJobDraft(jobModel())
    expect(sameShape(draft, { ...draft, description: 'Mine' })).toBe(true)
    expect(sameShape(draft, { ...draft, description: 7 })).toBe(false)
    expect(sameShape(draft, { ...draft, steps: [] })).toBe(false)
    const { name: _name, ...missing } = draft
    expect(sameShape(draft, missing)).toBe(false)
  })
  it('puts the user\'s changes on the object as read now, and names the fields both sides changed', () => {
    const base = { name: 'a', description: 'old', enabled: true, owner: 'sa' }
    const current = { name: 'a', description: 'theirs', enabled: true, owner: 'dana' }
    const mine = { name: 'b', description: 'mine', enabled: true, owner: 'sa' }
    expect(rebaseKeptDraft(base, current, mine)).toEqual({ draft: { name: 'b', description: 'mine', enabled: true, owner: 'dana' }, conflicts: ['description'] })
    const was = new Map([['A', 1], ['B', 1]]), now = new Map([['A', 2], ['B', 1], ['C', 1]]), changed = new Map([['A', 1], ['B', 3]])
    const rebased = rebaseKeptDraft(was, now, changed)
    expect([...rebased.draft.entries()]).toEqual([['A', 2], ['B', 3], ['C', 1]])
    expect(rebased.conflicts).toEqual([])
  })
})

describe('the session and AutoRecover records for SQL Server Agent documents', () => {
  const agent = { name: 'Job Properties - Nightly load', kind: 'agentJob', eol: 'lf', dirty: true, targetId, attachWanted: true, database: 'msdb', text: '{}' }
  it('keeps an Agent document\'s state and target, and never a file, a provider or a job key with it', () => {
    const f = bench()
    f.accept(uuid(50))
    const workspace = f.connectionTargets.exportWorkspace()
    expect(sessionWriteSchema.safeParse({ documents: [agent], activeIndex: 0, workspace }).success).toBe(true)
    expect(sessionWriteSchema.safeParse({ documents: [{ ...agent, targetId: uuid(2) }], activeIndex: 0, workspace }).success).toBe(false)
    expect(sessionWriteSchema.safeParse({ documents: [{ ...agent, fileId: uuid(3) }], activeIndex: 0, workspace }).success).toBe(false)
    expect(sessionWriteSchema.safeParse({ documents: [{ ...agent, provider: 'bigquery' }], activeIndex: 0, workspace }).success).toBe(false)
    expect(sessionWriteSchema.safeParse({ documents: [{ ...agent, text: undefined }], activeIndex: 0, workspace }).success).toBe(false)
    expect(sessionWriteSchema.safeParse({ documents: [{ ...agent, text: 'x'.repeat(keptAgentLimits.stateChars + 1) }], activeIndex: 0, workspace }).success).toBe(false)
    expect(sessionWriteSchema.safeParse({ documents: [{ ...agent, kind: 'tableDesigner' }], activeIndex: 0, workspace }).success).toBe(false)
  })
  it('keeps an Agent document\'s AutoRecover copy with its target, and a target on no query\'s copy', () => {
    const copy = { id: uuid(9), name: 'New Job', kind: 'agentJob', eol: 'lf', targetId, text: '{}' }
    expect(recoveryWriteSchema.safeParse(copy).success).toBe(true)
    expect(recoveryWriteSchema.safeParse({ ...copy, fileId: uuid(3) }).success).toBe(false)
    expect(recoveryWriteSchema.safeParse({ ...copy, kind: 'sql' }).success).toBe(false)
    expect(recoveryWriteSchema.safeParse({ ...copy, text: 'x'.repeat(keptAgentLimits.stateChars + 1) }).success).toBe(false)
  })
})

describe('hot exit for SQL Server Agent documents', () => {
  it('keeps a job document with unsaved changes on its target, and leaves out a clean one', async () => {
    const f = bench()
    f.accept(uuid(50))
    const id = f.jobDocuments.openJob(uuid(50), 'Nightly load')
    await settled()
    expect(f.documents.get(id)?.targetId).toBe(targetId)
    const before = keptSession(f.documents, () => undefined, { connectionTargets: f.connectionTargets })
    expect(before.kept.has(id)).toBe(false)
    f.jobDocuments.updateDraft(id, { description: 'Mine' })
    const kept = keptSession(f.documents, () => undefined, { connectionTargets: f.connectionTargets })
    expect(kept.kept.has(id)).toBe(true)
    const entry = kept.session.documents.find(document => document.kind === 'agentJob')!
    expect(entry).toMatchObject({ kind: 'agentJob', dirty: true, targetId, attachWanted: true, database: 'msdb', name: 'Job Properties - Nightly load' })
    expect(decodeKeptState(entry.text!, 'agentJob')).toMatchObject({ target: { kind: 'agentJob', name: 'Nightly load' }, draft: { description: 'Mine' }, model: { job: { version: 7 } } })
    // Main's schema takes what the page writes.
    expect(sessionWriteSchema.safeParse(kept.session).success).toBe(true)
    // With Restore open queries on startup off only pinned tabs are kept, so the job is asked about as before.
    expect(keptSession(f.documents, () => undefined, { connectionTargets: f.connectionTargets, pinnedOnly: true }).kept.has(id)).toBe(false)
    // While its save runs it is not kept, so the close is refused as before rather than cutting the save short.
    let finish!: () => void
    f.api.executeObjectAction.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }) }))
    const saving = f.jobDocuments.save(id)
    await settled()
    expect(f.jobDocuments.get(id)?.phase).toBe('saving')
    expect(keptSession(f.documents, () => undefined, { connectionTargets: f.connectionTargets }).kept.has(id)).toBe(false)
    expect(f.documents.closeRefusal(id)).toBeTruthy()
    finish()
    await saving
  })
  it('reopens a kept job disconnected with the draft, and reads it again on the automatic reconnect with the draft on top', async () => {
    const { state, name } = await keptJob()
    const f = bench()
    f.models.job = jobModel({ job: record({ category: 'Database Maintenance' }) })
    const document = f.documents.reopenKept('agentJob', { name, state, targetId, database: 'msdb' })
    expect(f.documents.get(document.id)).toMatchObject({ kind: 'agentJob', name: 'Job Properties - Nightly load', targetId, dirty: true })
    expect(f.documents.get(document.id)?.connectionId).toBeUndefined()
    expect(f.jobDocuments.get(document.id)).toMatchObject({ phase: 'ready', restored: true, changes: 1, draft: { description: 'Mine' }, error: { code: 'CONNECTION_LOST' } })
    expect(f.api.describeObject).not.toHaveBeenCalled()
    f.accept(uuid(60))
    // The startup reconnect attaches queries only; a reopened Agent document follows too, as a query that wants to attach does.
    f.targets.attachTarget(targetId, uuid(60))
    expect(f.documents.get(document.id)?.connectionId).toBe(uuid(60))
    await settled()
    expect(f.jobDocuments.get(document.id)).toMatchObject({ phase: 'ready', changes: 1, notice: keptAgentText.reread('job'), draft: { description: 'Mine', category: 'Database Maintenance' } })
    expect(f.jobDocuments.get(document.id)?.restored).toBeUndefined()
    expect(f.documents.get(document.id)?.dirty).toBe(true)
    expect(f.jobDocuments.canSave(document.id)).toBe(true)
  })
  it('opens the compare when the job changed on the server since it was kept', async () => {
    const { state, name } = await keptJob()
    const f = bench()
    f.models.job = jobModel({ job: record({ description: 'Theirs', version: 8, modified: '2026-11-21T09:00:00.000' }) })
    const document = f.documents.reopenKept('agentJob', { name, state, targetId })
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    const job = f.jobDocuments.get(document.id)!
    expect(job.stale?.rows.map(row => [row.field, row.conflict])).toEqual([['description', true]])
    expect(job.error).toMatchObject({ code: 'STALE', message: keptAgentText.jobChanged })
    expect(job.model?.job?.version).toBe(7)
    f.jobDocuments.reloadKeep(document.id)
    expect(f.jobDocuments.get(document.id)).toMatchObject({ draft: { description: 'Mine' }, model: { job: { version: 8 } } })
  })
  it('keeps a Create Job Like This copy as a New Job with its changes, without the link to its source', async () => {
    const first = bench()
    first.accept(uuid(50))
    const id = first.jobDocuments.createLike(uuid(50), 'Nightly load')
    await settled()
    expect(first.jobDocuments.get(id)).toMatchObject({ phase: 'ready', draft: { name: 'Copy of Nightly load' }, source: { base: { name: 'Nightly load' } } })
    first.jobDocuments.updateDraft(id, { description: 'Copied' })
    const state = first.documents.keepCustom(id)!
    expect(decodeKeptState(state, 'agentJob')).toMatchObject({ target: { kind: 'agent' }, draft: { name: 'Copy of Nightly load', description: 'Copied' } })
    const f = bench()
    const document = f.documents.reopenKept('agentJob', { name: first.documents.get(id)!.name, state, targetId, database: 'msdb' })
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    const job = f.jobDocuments.get(document.id)!
    expect(job).toMatchObject({ phase: 'ready', draft: { name: 'Copy of Nightly load', description: 'Copied' } })
    expect(job.source).toBeUndefined()
    expect(job.restored).toBeUndefined()
    expect(f.documents.get(document.id)).toMatchObject({ name: 'New Job', dirty: true })
  })
  it('takes a live connection at once when the target is already connected, and refuses a state that is not a job', async () => {
    const { state, name } = await keptJob()
    const f = bench()
    f.accept(uuid(60))
    const document = f.documents.reopenKept('agentJob', { name, state, targetId })
    expect(f.documents.get(document.id)?.connectionId).toBe(uuid(60))
    await settled()
    expect(f.jobDocuments.get(document.id)).toMatchObject({ phase: 'ready', draft: { description: 'Mine' } })
    const before = f.documents.getSnapshot().documents.length
    expect(() => f.documents.reopenKept('agentJob', { name, state: state.replace('"kind":"agentJob"', '"kind":"agentAlert"') })).toThrow(keptAgentText.unreadable(name))
    expect(() => f.documents.reopenKept('agentJob', { name, state: state.replace('"description":"Mine"', '"description":7') })).toThrow()
    expect(f.documents.getSnapshot().documents.length).toBe(before)
  })
  it('restores Agent documents with no release gate to open (AG-9), and names the ones it cannot read', async () => {
    const { state, name } = await keptJob()
    const f = bench()
    const restored: RestoredSession = { documents: [{ name, kind: 'agentJob', eol: 'lf', dirty: true, targetId, attachWanted: true, database: 'msdb', text: state }, { name: 'Broken', kind: 'agentProxy', eol: 'lf', dirty: true, text: '{}' }], activeIndex: 0, problems: [] }
    const api = { hotExit: true, takeSession: vi.fn(async () => ({ ok: true as const, value: restored })), finishSessionRestore: vi.fn(async () => ({ ok: true as const, value: undefined })) }
    const warned = vi.spyOn(f.files, 'reportError')
    const opened = await restoreSession({ api, documents: f.documents, files: f.files })
    expect(opened).toBe(1)
    expect(f.documents.getSnapshot().documents.map(document => document.kind)).toContain('agentJob')
    expect(f.documents.active?.kind).toBe('agentJob')
    expect(warned).toHaveBeenCalledWith(keptAgentText.unreadable('Broken'), 'warning')
  })
  it('never keeps a proxy\'s typed password: one with a password typed is asked about, and a kept one reopens with its password fields empty', async () => {
    const first = bench()
    first.accept(uuid(50))
    const id = first.proxyDocuments.openProxy(uuid(50), 'FileShareWriter')
    await settled()
    first.proxyDocuments.updateDraft(id, { description: 'Mine' })
    first.proxyDocuments.setCredentialMode(id, 'new')
    first.proxyDocuments.updateDraft(id, { newCredentialName: 'NewCred', newCredentialIdentity: 'CONTOSO\svc' })
    const state = first.documents.keepCustom(id)!
    first.proxyDocuments.setSecret(id, 'secret', secret)
    first.proxyDocuments.setSecret(id, 'confirm', secret)
    expect(first.documents.keepCustom(id)).toBeUndefined()
    const session = keptSession(first.documents, () => undefined, { connectionTargets: first.connectionTargets })
    expect(session.kept.has(id)).toBe(false)
    expect(JSON.stringify(session.session)).not.toContain(secret)
    await first.recovery.flush()
    expect(JSON.stringify(first.api.writeRecovery.mock.calls)).not.toContain(secret)
    // A password alone (an existing credential's only change) is asked about too, rather than kept and lost.
    const credential = first.credentialDocuments.openCredential(uuid(50), 'FileShareWriterCred')
    await settled()
    first.credentialDocuments.setSecret(credential, 'secret', secret)
    first.credentialDocuments.setSecret(credential, 'confirm', secret)
    expect(first.documents.get(credential)?.dirty).toBe(true)
    expect(keptSession(first.documents, () => undefined, { connectionTargets: first.connectionTargets }).kept.has(credential)).toBe(false)
    const f = bench()
    const document = f.documents.reopenKept('agentProxy', { name: 'Proxy Account Properties - FileShareWriter', state, targetId })
    expect(f.proxyDocuments.get(document.id)).toMatchObject({ restored: true, draft: { description: 'Mine', credentialMode: 'new', newCredentialName: 'NewCred' }, secrets: { secret: 'empty' } })
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    expect(f.proxyDocuments.get(document.id)).toMatchObject({ phase: 'ready', draft: { description: 'Mine' }, notice: keptAgentText.reread('proxy') })
    expect(f.proxyDocuments.holdsSecrets).toBe(false)
  })
  it('keeps the Schedules document\'s new schedule and reads the schedules again once connected', async () => {
    const first = bench()
    first.accept(uuid(50))
    const id = first.schedules.open(uuid(50), true)
    await settled()
    first.schedules.update(id, { ...first.schedules.draft(id)!.fields, name: 'Month end' })
    const state = first.documents.keepCustom(id)!
    const f = bench()
    const document = f.documents.reopenKept('agentSchedules', { name: 'Schedules', state, targetId })
    expect(f.schedules.get(document.id)).toMatchObject({ restored: true, selected: 'new' })
    expect(f.schedules.draft(document.id)?.fields.name).toBe('Month end')
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    expect(f.schedules.get(document.id)).toMatchObject({ phase: 'ready', selected: 'new' })
    expect(f.schedules.get(document.id)?.restored).toBeUndefined()
    expect(f.schedules.draft(document.id)?.fields.name).toBe('Month end')
    expect(f.documents.get(document.id)?.dirty).toBe(true)
  })
  it('keeps a reopened proxy whose first read failed on last session\'s read: Save waits, and the next connection reads it again', async () => {
    const first = bench()
    first.accept(uuid(50))
    const id = first.proxyDocuments.openProxy(uuid(50), 'FileShareWriter')
    await settled()
    first.proxyDocuments.updateDraft(id, { description: 'Mine' })
    const state = first.documents.keepCustom(id)!
    const f = bench()
    const document = f.documents.reopenKept('agentProxy', { name: 'Proxy Account Properties - FileShareWriter', state, targetId })
    f.api.describeObject.mockImplementationOnce(async () => ({ ok: false, error: 'The read timed out.' }))
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    expect(f.proxyDocuments.get(document.id)).toMatchObject({ phase: 'ready', restored: true, draft: { description: 'Mine' } })
    expect(f.proxyDocuments.canSave(document.id)).toBe(false)
    expect(await f.proxyDocuments.save(document.id)).toBe(false)
    expect(f.api.executeObjectAction).not.toHaveBeenCalled()
    // Other changes do not read it again on the same connection.
    f.documents.update(document.id, { database: 'msdb' })
    await settled()
    expect(f.api.describeObject).toHaveBeenCalledTimes(1)
    // Reload instead takes the proxy as read now, without the kept changes, and it saves as any other.
    const reloaded = bench()
    const again = reloaded.documents.reopenKept('agentProxy', { name: 'Proxy Account Properties - FileShareWriter', state, targetId })
    reloaded.api.describeObject.mockImplementationOnce(async () => ({ ok: false, error: 'The read timed out.' }))
    reloaded.accept(uuid(70))
    reloaded.targets.attachTarget(targetId, uuid(70))
    await settled()
    expect(reloaded.proxyDocuments.get(again.id)?.restored).toBe(true)
    reloaded.proxyDocuments.reload(again.id)
    await settled()
    expect(reloaded.proxyDocuments.get(again.id)?.restored).toBeUndefined()
    reloaded.proxyDocuments.updateDraft(again.id, { description: 'After reload' })
    expect(reloaded.proxyDocuments.canSave(again.id)).toBe(true)
    f.connections.remove(uuid(60))
    f.accept(uuid(61), 2)
    f.targets.attachTarget(targetId, uuid(61))
    await settled()
    expect(f.api.describeObject).toHaveBeenCalledTimes(2)
    expect(f.proxyDocuments.get(document.id)).toMatchObject({ phase: 'ready', draft: { description: 'Mine' }, notice: keptAgentText.reread('proxy') })
    expect(f.proxyDocuments.get(document.id)?.restored).toBeUndefined()
    expect(f.proxyDocuments.canSave(document.id)).toBe(true)
  })
  it('says when a kept schedule draft was dropped because its schedule was deleted on the server', async () => {
    const state = encodeKeptState({ version: 1, kind: 'agentSchedules', target: { kind: 'agent' }, server: 'server-a', model: schedulesModel() as unknown as Record<string, unknown>,
      draft: { 9: { fields: { name: 'Gone' }, jobs: [] } }, extra: { view: 'all', filter: '' } })!
    const f = bench()
    const document = f.documents.reopenKept('agentSchedules', { name: 'Schedules', state, targetId })
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    expect(f.schedules.get(document.id)).toMatchObject({ phase: 'ready', notice: keptAgentText.schedulesGone(1) })
  })
})

describe('AutoRecover for SQL Server Agent documents', () => {
  it('copies an Agent document with unsaved changes once per change, with its target, and deletes the copy once it is clean', async () => {
    const f = bench()
    f.accept(uuid(50))
    const id = f.jobDocuments.openJob(uuid(50), 'Nightly load')
    await settled()
    f.jobDocuments.updateDraft(id, { description: 'Mine' })
    await f.recovery.flush()
    const writes = () => f.api.writeRecovery.mock.calls.map(([write]) => write).filter(write => write.kind === 'agentJob')
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ kind: 'agentJob', eol: 'lf', targetId, name: 'Job Properties - Nightly load' })
    expect(recoveryWriteSchema.safeParse(writes()[0]).success).toBe(true)
    await f.recovery.flush()
    expect(writes()).toHaveLength(1)
    f.jobDocuments.updateDraft(id, { description: 'Mine again' })
    await f.recovery.flush()
    expect(writes()).toHaveLength(2)
    f.jobDocuments.updateDraft(id, { description: 'Loads the warehouse' })
    await settled()
    expect(f.api.discardRecovery).toHaveBeenCalledWith([writes()[0].id])
    // One with no saved connection target could never connect once recovered, so it is not copied.
    const loose = f.jobDocuments.openJob(uuid(50), 'Weekly load')
    await settled()
    f.documents.update(loose, { targetId: undefined })
    f.jobDocuments.updateDraft(loose, { description: 'Loose' })
    await f.recovery.flush()
    expect(writes().filter(write => write.name === 'Job Properties - Weekly load')).toHaveLength(0)
  })
  it('offers and recovers an Agent document\'s copy on its target with no release gate to open (AG-9)', async () => {
    const { state } = await keptJob()
    const f = bench()
    const id = uuid(70)
    f.api.recoveryState.offered = [{ id, name: 'Job Properties - Nightly load', kind: 'agentJob', savedAt: '2026-11-22T10:00:00.000Z', characters: state.length }]
    f.api.texts.set(id, { text: state, kind: 'agentJob', eol: 'lf', targetId })
    const entries = await f.recovery.refresh()
    expect(entries.map(entry => entry.kind)).toEqual(['agentJob'])
    await f.recovery.recover([id])
    const document = f.documents.getSnapshot().documents.find(item => item.kind === 'agentJob')!
    expect(document).toMatchObject({ targetId, dirty: true })
    expect(f.jobDocuments.get(document.id)).toMatchObject({ restored: true, draft: { description: 'Mine' } })
    expect(f.recovery.copyId(document.id)).toBe(id)
  })
})

describe('hot exit for the alert, operator and notifications documents', () => {
  const mail = { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
  const always = { start: 0, end: 235959 }
  const alertRecord = (patch: Partial<AgentAlertRecord> = {}): AgentAlertRecord => ({
    id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17, database: '', keyword: '', condition: '', wmiNamespace: '', wmiQuery: '',
    jobId: '', jobName: '', delay: 60, includeIn: notifyEmail, message: '', occurrences: 3, lastOccurred: '2026-11-20T02:00:00', ...patch
  })
  const alertModel = (patch: Partial<AgentAlertRecord> = {}): AgentAlertDocumentModel => ({
    alert: alertRecord(patch), login: 'sa', sysadmin: true, platform: 'windows', operators: [{ name: 'DBA', enabled: true, email: true, pager: true, netSend: false, pagerDays: 127, weekday: always, saturday: always, sunday: always }],
    notifications: [{ operator: 'DBA', methods: notifyEmail }], jobs: [], databases: ['master'], mail
  })
  const operator = (id: number, name: string) => ({ id, name, enabled: true, email: `${name.toLowerCase()}@example.test`, pager: '', netSend: '', pagerDays: 127, weekday: always, saturday: always, sunday: always })
  const gridModel = (): AgentOperatorsModel => ({
    login: 'sa', sysadmin: true, platform: 'windows', operators: [operator(9, 'DBA'), operator(10, 'Backup')], alerts: [{ id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17 }],
    notifications: [{ alertId: 7, operatorId: 9, methods: notifyEmail }], jobs: [], mail
  })
  it('puts a kept alert\'s changes on the alert as read now, saying when the server changed a field the user changed too', async () => {
    let current = alertModel()
    const describe = (f: ReturnType<typeof bench>) => f.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'agentAlert' ? { agentAlertDocument: current, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
    const first = bench()
    describe(first)
    first.accept(uuid(50))
    const id = first.alertDocuments.open(uuid(50), { kind: 'agentAlert', name: 'Severity 017' })
    await settled()
    first.alertDocuments.updateDraft(id, draft => ({ ...draft, delay: 300 }))
    const state = first.documents.keepCustom(id)!
    const f = bench()
    describe(f)
    current = alertModel({ delay: 120, enabled: false })
    const document = f.documents.reopenKept('agentAlert', { name: 'Alert Properties - Severity 017', state, targetId })
    expect(f.alertDocuments.get(document.id)).toMatchObject({ restored: true, draft: { delay: 300 } })
    f.accept(uuid(60))
    f.targets.attachTarget(targetId, uuid(60))
    await settled()
    expect(f.alertDocuments.get(document.id)).toMatchObject({ phase: 'ready', draft: { delay: 300, enabled: false }, base: { delay: 120 }, notice: keptAgentText.conflicts('alert') })
    expect(f.documents.get(document.id)?.dirty).toBe(true)
  })
  it('keeps the notifications grid\'s matrix, a Map, and reopens it as one', async () => {
    const first = bench()
    first.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'agentOperators' ? { agentOperators: gridModel(), elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
    first.accept(uuid(50))
    const id = first.operatorsDocuments.open(uuid(50), { kind: 'agent' })
    await settled()
    first.operatorsDocuments.updateDraft(id, matrix => withCell(matrix, 'Severity 017', 'Backup', notifyEmail))
    expect(first.operatorsDocuments.get(id)?.changes).toBe(1)
    const state = first.documents.keepCustom(id)!
    const f = bench()
    const document = f.documents.reopenKept('agentOperators', { name: 'Operators and Notifications', state, targetId })
    const draft = f.operatorsDocuments.get(document.id)!.draft as Map<string, Map<string, number>>
    expect(draft).toBeInstanceOf(Map)
    expect(draft.get('Severity 017')?.get('Backup')).toBe(notifyEmail)
    expect(f.operatorsDocuments.get(document.id)?.changes).toBe(1)
  })
})
