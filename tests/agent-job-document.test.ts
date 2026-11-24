import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentJobChangeCount, agentJobCommandEntries, agentJobCompare, agentJobProblems, agentJobSavable, agentJobSave, agentJobSaveProblems, agentJobSaveSchema, agentJobTabName, type AgentJobSave,
  initialAgentJobDraft, pagerDuty, rebaseAgentJobDraft, uncategorizedCategory, type AgentJobDocumentModel, type AgentJobOperator, type AgentJobRecord
} from '../src/shared/actions/agent-job'
import { actionMenuState, dialogSpecs } from '../src/shared/actions/catalog'
import type { ActionDescribeResult, ActionExecuteResult, ActionRequest } from '../src/shared/actions/schema'
import { agentLimits } from '../src/shared/agent/catalog'
import { createFromDraft } from '../src/shared/agent/create-from'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import type { ApiResult } from '../src/shared/contracts'
import { jobDocumentText, jobLive } from '../src/renderer/src/agent/JobDocumentService'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const always = { start: 0, end: 235959 }
const operator = (name: string, patch: Partial<AgentJobOperator> = {}): AgentJobOperator =>
  ({ name, enabled: true, email: true, pager: true, netSend: false, pagerDays: 127, weekday: always, saturday: always, sunday: always, ...patch })
const record = (patch: Partial<AgentJobRecord> = {}): AgentJobRecord => ({
  jobId: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', enabled: true, description: 'Loads the warehouse', category: 'Data Collector', owner: 'sa',
  emailLevel: 2, emailOperator: 'DBA', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 2, deleteLevel: 0,
  created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, lastRun: '2026-11-20T02:00:00', lastOutcome: 1, ...patch
})
const model = (patch: Partial<AgentJobDocumentModel> = {}): AgentJobDocumentModel => ({
  job: record(), login: 'sa', sysadmin: true, platform: 'windows', categories: [uncategorizedCategory, 'Data Collector', 'Database Maintenance'],
  operators: [operator('DBA'), operator('On-call', { pagerDays: 62, weekday: { start: 80000, end: 180000 } }), operator('Old', { enabled: false })],
  owners: ['sa', 'CONTOSO\\dana'], steps: [{ id: 1, name: 'Extract', subsystem: 'TSQL' }, { id: 2, name: 'Load', subsystem: 'TSQL' }],
  alerts: [{ id: 11, name: 'Log full', enabled: true, severity: 0, messageId: 9002 }, { id: 12, name: 'Severity 017', enabled: true, severity: 17, messageId: 0 }], alertsEditable: true,
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }, ...patch
})

describe("the job document's shared rules", () => {
  it('opens New Job with SSMS defaults and an existing job as read, counting each change and each removed alert', () => {
    expect(initialAgentJobDraft({ login: 'CONTOSO\\dana' })).toMatchObject({ name: '', owner: 'CONTOSO\\dana', category: uncategorizedCategory, enabled: true, emailLevel: 0, removeAlerts: [] })
    const opened = model(), draft = initialAgentJobDraft(opened)
    expect(draft).toMatchObject({ name: 'Nightly load', emailLevel: 2, emailOperator: 'DBA' })
    expect(agentJobChangeCount(draft, { ...draft, description: 'x', enabled: false, removeAlerts: [11, 12] })).toBe(4)
    expect(agentJobTabName('Nightly load')).toBe('Job Properties - Nightly load')
    expect(agentJobTabName(undefined)).toBe('New Job')
  })
  it('saves only what changed, with the STALE guard\'s version, a notification as its level and operator together, and New Job whole', () => {
    const opened = model(), draft = initialAgentJobDraft(opened)
    expect(agentJobSave(opened, draft)).toBeUndefined()
    expect(agentJobSave(opened, { ...draft, description: 'Rebuilds', emailLevel: 0, removeAlerts: [12] })).toEqual({
      version: 7, modified: '2026-11-20T14:32:07.123', description: 'Rebuilds', emailLevel: 0, emailOperator: '', removeAlerts: [{ id: 12, name: 'Severity 017' }]
    })
    const created = model({ job: undefined, login: 'sa' })
    const blank = { ...initialAgentJobDraft(created), name: 'New job' }
    const save = agentJobSave(created, blank)!
    expect(save).toMatchObject({ name: 'New job', enabled: true, category: uncategorizedCategory, emailLevel: 0, emailOperator: '', eventLogLevel: 0 })
    expect(save).not.toHaveProperty('owner')
    expect(save).not.toHaveProperty('version')
    expect(agentJobSave(created, { ...blank, owner: 'CONTOSO\\dana' })).toMatchObject({ owner: 'CONTOSO\\dana' })
    expect(agentJobSaveProblems(save, true)).toEqual([])
    expect(agentJobSaveProblems({ version: 1, modified: '2026-11-20T14:32:07.123' }, false)).toEqual(['There is nothing to change.'])
    expect(agentJobSaveProblems({ name: 'x', emailLevel: 2 }, true)).toContain('A notification goes as its level and operator together.')
    expect(agentJobSaveProblems({ name: 'x', pageLevel: 0, pageOperator: 'DBA' }, true)).toContain('A notification names an operator exactly when it is sent.')
  })
  it('bounds the save in zod as C# does', () => {
    expect(agentJobSaveSchema.safeParse({ version: 7, modified: '2026-11-20T14:32:07.123', description: 'd'.repeat(agentLimits.descriptionChars) }).success).toBe(true)
    expect(agentJobSaveSchema.safeParse({ description: 'd'.repeat(agentLimits.descriptionChars + 1) }).success).toBe(false)
    expect(agentJobSaveSchema.safeParse({ modified: '2026-02-30T14:32:07.000' }).success).toBe(false)
    expect(agentJobSaveSchema.safeParse({ modified: '2026-11-20T14:32:07' }).success).toBe(false)
    expect(agentJobSaveSchema.safeParse({ emailLevel: 4 }).success).toBe(false)
    expect(agentJobSaveSchema.safeParse({ removeAlerts: [] }).success).toBe(false)
    expect(agentJobSaveSchema.safeParse({ removeAlerts: Array.from({ length: agentLimits.jobAlerts + 1 }, (_, at) => ({ id: at + 1, name: `a${at}` })) }).success).toBe(false)
    expect(agentJobSaveSchema.safeParse({ owner: 'x', other: 1 }).success).toBe(false)
  })
  it('warns about notifications that reach no one and never blocks Save for a warning', () => {
    const opened = model(), draft = initialAgentJobDraft(opened)
    const warned = agentJobProblems(opened, { ...draft, emailOperator: 'Old', pageLevel: 2, pageOperator: 'On-call' })
    expect(warned.map(problem => [problem.field, problem.severity])).toEqual([['email', 'warning'], ['page', 'warning']])
    expect(warned[1].message).toContain('weekdays 08:00–18:00')
    expect(agentJobSavable(warned)).toBe(true)
    expect(agentJobSavable(agentJobProblems(opened, { ...draft, name: ' ' }))).toBe(false)
    expect(agentJobSavable(agentJobProblems(opened, { ...draft, pageLevel: 2, pageOperator: '' }))).toBe(false)
    // An empty owner is refused by the save's own schema, so it is an error on the Owner field, not a failed request.
    expect(agentJobProblems(opened, { ...draft, owner: ' ' })).toContainEqual({ field: 'owner', severity: 'error', message: 'The job needs an owner.' })
    expect(pagerDuty(operator('x'))).toBeUndefined()
    expect(agentJobProblems(model({ mail: { checked: true, xps: false, sysadmin: true } }), draft).map(problem => problem.message)).toContain('Database Mail is off on this server (Database Mail XPs), so e-mail notifications are not sent.')
    expect(agentJobProblems(model({ mail: { checked: false, sysadmin: false } }), draft)).toEqual([])
  })
  it('compares what each side changed, conflicts first, and rebases the draft onto the job as read now', () => {
    const opened = model(), draft = { ...initialAgentJobDraft(opened), description: 'Mine', enabled: false }
    const current = model({ job: record({ description: 'Theirs', category: 'Database Maintenance', version: 8 }) })
    const rows = agentJobCompare(opened, current, draft)
    expect(rows.map(row => [row.field, row.conflict])).toEqual([['description', true], ['category', false], ['enabled', false]])
    expect(rebaseAgentJobDraft(opened, current, draft)).toMatchObject({ description: 'Mine', category: 'Database Maintenance', enabled: false })
    expect(rebaseAgentJobDraft(opened, current, draft, new Set(['description']))).toMatchObject({ description: 'Theirs', enabled: false })
    expect(createFromDraft(opened, 'dana', false)).toMatchObject({ name: 'Copy of Nightly load', owner: 'dana', emailOperator: 'DBA', enabled: false, removeAlerts: [] })
  })
  it('keeps every command behind the release gate, and Properties on a job a document', () => {
    for (const [id, entry] of Object.entries(agentJobCommandEntries())) expect(entry.precondition, id).toContain('agentEnabled')
    expect(commandDescriptor('agent.newJob').menus?.[0].when).toContain("explorerFolder == 'agentJobs'")
    expect(actionMenuState({ kind: 'agentJob' }).properties).toBe('enabled')
    expect(dialogSpecs.agentJob).toMatchObject({ surface: 'document', action: 'agentJob' })
  })
  it('reads the header from the watched slot', () => {
    expect(jobLive(undefined)).toBeUndefined()
    expect(jobLive({ status: 1, step: 2, steps: 3, lastOutcome: 1 })).toEqual({ running: true, step: 2, steps: 3, retrying: false, lastOutcome: 1 })
    expect(jobLive({ status: 4, lastOutcome: 0 })).toEqual({ running: false, lastOutcome: 0 })
    expect(jobLive({ status: -1 })).toEqual({ running: false, gone: true })
  })
})

/** A workbench whose describe answers the job document's model. */
function opened(first = model()) {
  const fixture = workbenchFixture({ agentPreview: true })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  let current = first, byName = false
  const answers: ApiResult<ActionExecuteResult>[] = []
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog !== 'agentJob' ? { elapsedMs: 1 }
    : params.target.kind === 'agent' ? { agentJobDocument: { ...current, job: undefined, steps: [], alerts: undefined, jobs: [current.job?.name ?? 'Nightly load', 'Backup'], jobIds: [current.job?.jobId ?? '', '22222222-2222-2222-2222-222222222222'] }, elapsedMs: 1 }
      // byName: a job is found only under its current name, as msdb finds it.
      : byName && params.target.name !== current.job?.name ? { elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'gone', retryable: false } }
        : { agentJobDocument: current, elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.executeObjectAction.mockImplementation(async () => answers.shift() ?? { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, executes, answers, setModel: (next: AgentJobDocumentModel) => { current = next }, findByName: () => { byName = true } }
}

describe('the job document', () => {
  it('opens one tab per job, saves only the changes under the STALE guard and reads the job again', async () => {
    const { jobDocuments, documents, executes, setModel } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    expect(documents.active).toMatchObject({ id, kind: 'agentJob', name: 'Job Properties - Nightly load', connectionId: 'c1' })
    await settled()
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0 })
    expect(jobDocuments.openJob('c1', 'Nightly load')).toBe(id)
    jobDocuments.updateDraft(id, { description: 'Rebuilds' })
    jobDocuments.toggleAlert(id, 11)
    expect(jobDocuments.get(id)?.changes).toBe(2)
    expect(documents.get(id)?.dirty).toBe(true)
    setModel(model({ job: record({ description: 'Rebuilds', version: 8 }), alerts: [{ id: 12, name: 'Severity 017', enabled: true, severity: 17, messageId: 0 }] }))
    expect(await jobDocuments.save(id)).toBe(true)
    expect(executes()).toEqual([{
      action: 'agentJob', target: { kind: 'agentJob', name: 'Nightly load' }, agentIdentity: { jobId: '11111111-1111-1111-1111-111111111111' }, connectionId: 'c1', requestId: expect.any(String),
      agentJob: { version: 7, modified: '2026-11-20T14:32:07.123', description: 'Rebuilds', removeAlerts: [{ id: 11, name: 'Log full' }] }
    }])
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0, notice: jobDocumentText.saved, model: { job: { version: 8 } } })
    expect(documents.get(id)?.dirty).toBe(false)
  })
  it('opens the compare on STALE, keeps the draft, and reloads keeping or discarding it', async () => {
    const { jobDocuments, answers, setModel } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.updateDraft(id, { description: 'Mine' })
    setModel(model({ job: record({ description: 'Theirs', category: 'Database Maintenance', version: 8 }) }))
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed by someone else since it was opened. Reload to see the changes.', retryable: false } } })
    expect(await jobDocuments.save(id)).toBe(false)
    const stale = jobDocuments.get(id)!.stale!
    expect(stale.rows.map(row => [row.field, row.conflict])).toEqual([['description', true], ['category', false]])
    expect(jobDocuments.get(id)?.draft?.description).toBe('Mine')
    expect(jobDocuments.canEdit(id)).toBe(false)
    jobDocuments.chooseServer(id, 'description', false)
    jobDocuments.reloadKeep(id)
    expect(jobDocuments.get(id)?.stale).toBeUndefined()
    expect(jobDocuments.get(id)).toMatchObject({ changes: 1, draft: { description: 'Mine', category: 'Database Maintenance' }, model: { job: { version: 8 } } })
    // Save waits for the shared schedules read again, which gives picked schedules their new guards.
    expect(jobDocuments.canSave(id)).toBe(false)
    await settled()
    expect(jobDocuments.canSave(id)).toBe(true)
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'stale', retryable: false } } })
    await jobDocuments.save(id)
    jobDocuments.reloadDiscard(id)
    expect(jobDocuments.get(id)).toMatchObject({ changes: 0, draft: { description: 'Theirs' } })
  })
  it('follows a job renamed elsewhere by its id, into the compare and on Reload', async () => {
    const { jobDocuments, documents, answers, setModel, findByName } = opened()
    findByName()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.updateDraft(id, { description: 'Mine' })
    setModel(model({ job: record({ name: 'Nightly renamed', version: 8 }) }))
    // The save resolves the job by the name it read, so a rename elsewhere refuses it NOT_FOUND (50010): that opens the compare too.
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'gone', retryable: false } } })
    expect(await jobDocuments.save(id)).toBe(false)
    expect(jobDocuments.get(id)?.stale?.rows.map(row => [row.field, row.conflict])).toEqual([['name', false], ['description', false]])
    expect(jobDocuments.get(id)?.stale?.rows[0].server).toBe('Nightly renamed')
    expect(jobDocuments.get(id)).toMatchObject({ target: { kind: 'agentJob', name: 'Nightly renamed' }, draft: { description: 'Mine' } })
    expect(documents.get(id)?.name).toBe('Job Properties - Nightly renamed')
    jobDocuments.reloadKeep(id)
    expect(jobDocuments.get(id)).toMatchObject({ draft: { name: 'Nightly renamed', description: 'Mine' }, changes: 1 })
    // Renamed again while open: Reload finds it too; a job that is gone stays a read failure.
    setModel(model({ job: record({ name: 'Nightly again', version: 9 }) }))
    jobDocuments.reload(id)
    await settled()
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', target: { name: 'Nightly again' }, model: { job: { version: 9 } } })
    setModel(model({ job: record({ jobId: '33333333-3333-3333-3333-333333333333', name: 'Other' }) }))
    jobDocuments.reload(id)
    await settled()
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', target: { name: 'Nightly again' }, error: { code: 'NOT_FOUND' } })
  })
  it('does not compare a job deleted and created again under its name, and Reload opens the new one', async () => {
    const { jobDocuments, answers, setModel, live } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.updateDraft(id, { description: 'Mine' })
    setModel(model({ job: record({ jobId: '44444444-4444-4444-4444-444444444444', version: 1 }) }))
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'gone', retryable: false } } })
    expect(await jobDocuments.save(id)).toBe(false)
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', error: { code: 'NOT_FOUND', message: jobDocumentText.replaced }, draft: { description: 'Mine' } })
    expect(jobDocuments.get(id)?.stale).toBeUndefined()
    expect(jobDocuments.get(id)?.model?.job?.jobId).toBe('11111111-1111-1111-1111-111111111111')
    // Reload opens the job now under the name, and the header follows it.
    jobDocuments.reload(id)
    await settled()
    const watched = (live.handles as FakeLiveHandle[]).filter(item => item.owner.key === 'agent-job:' + id && !item.disposed)
    expect(watched.map(item => item.spec.args)).toEqual([{ watch: ['44444444-4444-4444-4444-444444444444'] }])
  })
  it('keeps a blank job chosen while a copy is read', async () => {
    const { jobDocuments, api } = opened()
    const id = jobDocuments.newJob('c1')
    await settled()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const describe = api.describeObject.getMockImplementation()!
    api.describeObject.mockImplementationOnce(async params => { await gate; return describe(params) })
    const copying = jobDocuments.startCopy(id, 'Nightly load')
    expect(jobDocuments.get(id)?.copying).toBe('Nightly load')
    jobDocuments.startBlank(id)
    jobDocuments.updateDraft(id, { name: 'Mine' })
    release()
    await copying
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', draft: { name: 'Mine', emailLevel: 0 } })
    expect(jobDocuments.get(id)?.copying).toBeUndefined()
  })
  it('sends a name as msdb keeps it, trimmed, and opens the job under that name', async () => {
    const { jobDocuments, executes, setModel } = opened(model({ job: undefined }))
    const id = jobDocuments.newJob('c1')
    await settled()
    jobDocuments.startBlank(id)
    jobDocuments.updateDraft(id, { name: '  Weekly  ' })
    setModel(model({ job: record({ name: 'Weekly' }) }))
    expect(await jobDocuments.save(id)).toBe(true)
    expect(executes().at(-1)).toMatchObject({ target: { kind: 'agent' }, agentJob: { name: 'Weekly' } })
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', target: { kind: 'agentJob', name: 'Weekly' } })
  })
  it('lands a refusal on its field and marks its section, and a read-only job cannot be edited', async () => {
    const { jobDocuments, answers } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.updateDraft(id, { category: 'Nope' })
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: "Saving the job's settings was refused: The specified '@category_name' is invalid.", retryable: true, field: 'category' } } })
    expect(await jobDocuments.save(id)).toBe(false)
    expect(jobDocuments.get(id)?.error?.field).toBe('category')
    expect([...jobDocuments.problemSections(id)]).toEqual(['general'])
    jobDocuments.updateDraft(id, { category: 'Database Maintenance' })
    expect(jobDocuments.get(id)?.error).toBeUndefined()
    // A refused value that names its field is that field's problem, never the compare (which a job no longer under its name opens).
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NOT_FOUND', message: "The specified @owner_login_name ('bob') does not exist.", retryable: false, field: 'owner' } } })
    expect(await jobDocuments.save(id)).toBe(false)
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', error: { field: 'owner' } })
    expect(jobDocuments.get(id)?.stale).toBeUndefined()

    const other = opened(model({ sysadmin: false, login: 'dana', readOnly: 'Read-only.', alertsEditable: false }))
    const readOnly = other.jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    other.jobDocuments.updateDraft(readOnly, { description: 'x' })
    expect(other.jobDocuments.get(readOnly)?.changes).toBe(0)
    expect(other.jobDocuments.canSave(readOnly)).toBe(false)
  })
  it('starts New Job blank or as a copy, creates it on the local server and becomes its document', async () => {
    const { jobDocuments, documents, executes, api, setModel } = opened()
    const id = jobDocuments.newJob('c1')
    expect(documents.get(id)?.name).toBe('New Job')
    await settled()
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'choosing', model: { jobs: ['Nightly load', 'Backup'] } })
    await jobDocuments.startCopy(id, 'Nightly load')
    expect(jobDocuments.get(id)).toMatchObject({ phase: 'ready', draft: { name: 'Copy of Nightly load', emailOperator: 'DBA' } })
    expect(documents.get(id)?.dirty).toBe(true)
    setModel(model({ job: record({ name: 'Copy of Nightly load' }) }))
    expect(await jobDocuments.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({ action: 'agentJob', target: { kind: 'agent' }, agentJob: { name: 'Copy of Nightly load', emailLevel: 2, emailOperator: 'DBA' } })
    expect(executes()[0]).not.toHaveProperty('agentIdentity')
    expect(documents.get(id)?.name).toBe('Job Properties - Copy of Nightly load')
    expect(jobDocuments.get(id)).toMatchObject({ target: { kind: 'agentJob', name: 'Copy of Nightly load' }, notice: jobDocumentText.created })
    expect(api.describeObject.mock.calls.at(-1)?.[0]).toMatchObject({ target: { kind: 'agentJob', name: 'Copy of Nightly load' } })
  })
  it('follows the job live in its header, and starts it (at a step) and stops it with its identity', async () => {
    const { jobDocuments, executes, live, connections } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    const handle = (live.handles as FakeLiveHandle[]).find(item => item.owner.key === 'agent-job:' + id)!
    expect(handle.spec).toMatchObject({ source: 'agent.jobs', args: { watch: ['11111111-1111-1111-1111-111111111111'] } })
    await jobDocuments.start(id, 'Load')
    expect(executes().at(-1)).toMatchObject({ action: 'startJob', target: { kind: 'agentJob', name: 'Nightly load' }, agentIdentity: { jobId: '11111111-1111-1111-1111-111111111111' }, stepName: 'Load' })
    expect(handle.refreshes).toBe(1)
    handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 2000, metrics: [1, 2, 2, 0, 1, 0] }] })
    expect(jobDocuments.get(id)?.live).toMatchObject({ running: true, step: 2, steps: 2 })
    expect(jobDocuments.canStart(id)).toBe(false)
    await jobDocuments.stop(id)
    expect(executes().at(-1)).toMatchObject({ action: 'stopJob', agentIdentity: { jobId: '11111111-1111-1111-1111-111111111111' } })
    // A lost connection clears the header's state but keeps its view, which LiveService resumes after a reconnect.
    connections.markLostBefore(2)
    expect(jobDocuments.get(id)?.live).toBeUndefined()
    expect(handle.disposed).toBe(false)
    expect(handle.owner.connectionId?.()).toBeUndefined()
    handle.deliver({ type: 'live.tick', seq: 2, sampledAt: 2, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 2000, metrics: [1, 1, 2, 0, 1, 0] }] })
    expect(jobDocuments.get(id)?.live).toMatchObject({ running: true, step: 1 })
    jobDocuments.closed(id)
    expect(handle.disposed).toBe(true)
  })
})

describe("the job document's Steps page", () => {
  const stepped = () => model({ steps: [
    { id: 1, name: 'Extract', subsystem: 'TSQL', command: 'SELECT 1;', databaseName: 'Sales', onSuccessAction: 3, onFailAction: 4, onFailStepId: 3 },
    { id: 2, name: 'Load', subsystem: 'TSQL', command: 'SELEC 2', databaseName: 'master', onSuccessAction: 3, onFailAction: 2 },
    { id: 3, name: 'Notify', subsystem: 'CmdExec', command: 'notify.cmd', onSuccessAction: 1, onFailAction: 2 }
  ] })
  const keys = (jobDocuments: ReturnType<typeof opened>['jobDocuments'], id: string) => jobDocuments.get(id)?.draft?.steps.steps.map(step => step.key)

  it('adds, moves with go-to targets following, deletes with Undo and sets the Start step, saving them in the planner\'s order', async () => {
    const { jobDocuments, executes } = opened(stepped())
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    expect(jobDocuments.selectedStep(id)?.key).toBe('s1')
    jobDocuments.moveStepBy(id, 's3', -2)
    expect(keys(jobDocuments, id)).toEqual(['s3', 's1', 's2'])
    expect(jobDocuments.get(id)?.draft?.steps.steps[1]).toMatchObject({ key: 's1', onFail: 4, onFailTarget: 's3' })
    jobDocuments.deleteStepOf(id, 's3')
    expect(jobDocuments.get(id)?.deletion).toMatchObject({ deleted: { key: 's3' }, retargeted: ['s1'] })
    expect(jobDocuments.get(id)?.draft?.steps.steps[0]).toMatchObject({ key: 's1', onFail: 2 })
    expect(jobDocuments.selectedStep(id)?.key).toBe('s1')
    jobDocuments.undoDeleteStep(id)
    expect(jobDocuments.get(id)?.deletion).toBeUndefined()
    expect(keys(jobDocuments, id)).toEqual(['s3', 's1', 's2'])
    expect(jobDocuments.get(id)?.draft?.steps.steps[1]).toMatchObject({ onFail: 4, onFailTarget: 's3' })
    jobDocuments.addStepOf(id, 'PowerShell')
    expect(jobDocuments.selectedStep(id)).toMatchObject({ key: 'n1', name: 'Step 4', subsystem: 'PowerShell', databaseName: '' })
    // A step added while a deleted new step waits for Undo never takes its key, so Undo still puts it back.
    jobDocuments.deleteStepOf(id, 'n1')
    jobDocuments.addStepOf(id, 'PowerShell')
    expect(jobDocuments.selectedStep(id)?.key).toBe('n2')
    jobDocuments.undoDeleteStep(id)
    expect(keys(jobDocuments, id)).toEqual(['s3', 's1', 's2', 'n1', 'n2'])
    jobDocuments.deleteStepOf(id, 'n2')
    jobDocuments.dismissDeletion(id)
    jobDocuments.updateStep(id, 'n1', { command: 'Get-Date' })
    jobDocuments.setStartStep(id, 's2')
    expect(jobDocuments.get(id)?.draft?.steps.startKey).toBe('s2')
    expect(jobDocuments.get(id)?.changes).toBeGreaterThan(0)
    expect(await jobDocuments.save(id)).toBe(true)
    const steps = (executes()[0] as ActionRequest & { agentJob: AgentJobSave }).agentJob.steps!
    expect(steps.deletes ?? []).toEqual([])
    expect(steps.temporary?.map(item => item.id)).toEqual([1, 2, 3])
    expect(steps.adds?.map(item => item.id)).toEqual([4])
    expect(steps.writes?.map(write => [write.id, write.name, write.onFailAction, write.onFailStepId])).toEqual([[1, 'Notify', 2, 0], [2, 'Extract', 4, 1], [3, 'Load', 2, 0], [4, 'Step 4', 2, 0]])
    expect(steps.startStepId).toBe(3)
  })
  it('drops what a new type cannot keep, parses T-SQL in the backend and opens a step in a query window on its database', async () => {
    const fixture = opened(stepped()), { jobDocuments, documents } = fixture
    const parse = vi.fn(async () => ({ ok: true as const, value: { errors: [{ line: 1, column: 1, number: 102, message: "Incorrect syntax near 'SELEC'." }], truncated: false } }))
    Object.assign(fixture.api, { languageParse: parse })
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    await jobDocuments.parseStep(id, 's2')
    expect(parse).toHaveBeenCalledWith({ text: 'SELEC 2' })
    expect(jobDocuments.get(id)?.parse).toMatchObject({ key: 's2', running: false, errors: [{ number: 102 }] })
    jobDocuments.updateStep(id, 's2', { command: 'SELECT 2' })
    expect(jobDocuments.get(id)?.parse).toBeUndefined()
    await jobDocuments.parseStep(id, 's3')
    expect(parse).toHaveBeenCalledTimes(1)
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    expect(jobDocuments.get(id)?.draft?.steps.steps[0]).toMatchObject({ subsystem: 'CmdExec', databaseName: '' })
    jobDocuments.updateStep(id, 's2', { databaseName: 'Sales' })
    jobDocuments.openStepInQuery(id, 's2')
    expect(documents.active).toMatchObject({ name: 'Load.sql', connectionId: 'c1', database: 'Sales' })
  })
  it('drops a pending delete when Reload and keep my changes rebases the steps', async () => {
    const { jobDocuments, answers, setModel } = opened(stepped())
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.deleteStepOf(id, 's3')
    expect(jobDocuments.get(id)?.deletion).toBeDefined()
    setModel({ ...stepped(), job: record({ version: 8 }) })
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'stale', retryable: false } } })
    expect(await jobDocuments.save(id)).toBe(false)
    jobDocuments.reloadKeep(id)
    expect(jobDocuments.get(id)?.deletion).toBeUndefined()
    jobDocuments.undoDeleteStep(id)
    expect(keys(jobDocuments, id)).toEqual(['s1', 's2'])
  })
  it('keeps the selection on the same step and drops its Parse when a reload renumbers the steps', async () => {
    const fixture = opened(stepped()), { jobDocuments, answers, setModel } = fixture
    Object.assign(fixture.api, { languageParse: vi.fn(async () => ({ ok: true as const, value: { errors: [], truncated: false } })) })
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.selectStep(id, 's3')
    await jobDocuments.parseStep(id, 's3')
    jobDocuments.updateDraft(id, { description: 'mine' })
    const inserted = { ...stepped(), job: record({ version: 8 }), steps: [{ id: 1, name: 'Precheck', subsystem: 'TSQL', command: 'SELECT 0;', onSuccessAction: 3, onFailAction: 2 }, ...stepped().steps.map(step => ({ ...step, id: step.id + 1, ...step.onFailStepId ? { onFailStepId: step.onFailStepId + 1 } : {} }))] }
    setModel(inserted)
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'stale', retryable: false } } })
    expect(await jobDocuments.save(id)).toBe(false)
    jobDocuments.reloadKeep(id)
    const state = jobDocuments.get(id)!
    expect(state.parse).toBeUndefined()
    expect(state.draft?.steps.steps.find(step => step.key === state.step)?.name).toBe('Notify')
  })
  it('moves the selected step with Alt+Up and Alt+Down in the Steps section, not in a field or the step\'s editor (AG-10)', async () => {
    const { jobDocuments, commands } = opened(stepped())
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    for (const [command, key] of [['agentJob.moveStepUp', 'alt+up'], ['agentJob.moveStepDown', 'alt+down']] as const) {
      const binding = commandDescriptor(command).keybindings?.[0]
      expect(binding?.key).toBe(key)
      const when = compileWhen(binding!.when!)
      expect(evaluateWhen(when, { activeDocumentIsAgentJob: true, agentStepsFocus: true, textInputFocus: false })).toBe(true)
      expect(evaluateWhen(when, { activeDocumentIsAgentJob: true, agentStepsFocus: true, textInputFocus: true })).toBe(false)
      expect(evaluateWhen(when, { activeDocumentIsAgentJob: true, agentStepsFocus: false, textInputFocus: false })).toBe(false)
    }
    // The first step selected: it cannot move up; down swaps it with the next, go-to targets following.
    expect(commands.isEnabled('agentJob.moveStepUp', { tabId: id })).toBe(false)
    await commands.execute('agentJob.moveStepDown', { tabId: id }, 'keybinding')
    expect(keys(jobDocuments, id)).toEqual(['s2', 's1', 's3'])
    expect(jobDocuments.selectedStep(id)?.key).toBe('s1')
    jobDocuments.selectStep(id, 's3')
    expect(commands.isEnabled('agentJob.moveStepDown', { tabId: id })).toBe(false)
    await commands.execute('agentJob.moveStepUp', { tabId: id }, 'keybinding')
    expect(keys(jobDocuments, id)).toEqual(['s2', 's3', 's1'])
  })
  it('lists the steps of a job with more than Varia reads read-only, with no problems', async () => {
    const { jobDocuments } = opened({ ...stepped(), stepsTruncated: true })
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    expect(jobDocuments.canEdit(id)).toBe(true)
    expect(jobDocuments.canEditSteps(id)).toBe(false)
    jobDocuments.addStepOf(id)
    jobDocuments.deleteStepOf(id, 's1')
    jobDocuments.moveStepBy(id, 's3', -1)
    expect(keys(jobDocuments, id)).toEqual(['s1', 's2', 's3'])
    expect(jobDocuments.stepProblems(id)).toEqual([])
  })
  it("keeps every SSIS describe it read, whichever reply comes back last", async () => {
    const fixture = opened(stepped()), { jobDocuments } = fixture
    const replies: ((value: unknown) => void)[] = []
    const describeSsis = vi.fn(() => new Promise(resolve => { replies.push(resolve) }))
    Object.assign(fixture.api, { describeSsis })
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    const project = (name: string) => ({ ok: true, value: { elapsedMs: 1, model: { view: 'project', name, parameters: [], packages: [], references: [] } } })
    const first = jobDocuments.loadSsisPackage(id, 'F', 'P1')
    const second = jobDocuments.loadSsisPackage(id, 'F', 'P2')
    await settled()
    replies[1]!(project('P2'))
    await second
    replies[0]!(project('P1'))
    await first
    // Each reply fills its own entry, whichever comes back last; browsing opens a project without dropping another's describe.
    expect(Object.keys(jobDocuments.get(id)?.ssis?.projectModels ?? {}).sort()).toEqual(['F\\P1', 'F\\P2'])
    void jobDocuments.loadSsisPackage(id, 'F', 'P1', undefined, true)
    expect(jobDocuments.get(id)?.ssis).toMatchObject({ open: 'F\\P1', projectModels: { 'F\\P2': expect.anything() } })
  })
})
