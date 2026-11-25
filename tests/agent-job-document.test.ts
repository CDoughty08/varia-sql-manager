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

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
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
  owners: ['sa', 'CONTOSO\\dana'], steps: [{ id: 1, name: 'Extract', subsystem: 'TSQL', onSuccessAction: 3 }, { id: 2, name: 'Load', subsystem: 'TSQL' }],
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
  it('needs no release gate for any command (AG-9), and Properties on a job a document', () => {
    for (const [id, entry] of Object.entries(agentJobCommandEntries())) expect(entry.precondition, id).not.toContain('agentEnabled')
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
  const fixture = workbenchFixture()
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
  it('opens at a section a link asks for, a collapsed one opened, and again in the tab already open (AG-16)', async () => {
    const { jobDocuments, documents } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    const frame = jobDocuments.get(id)!.frame
    jobDocuments.setFrame(id, { ...frame, collapsed: [...frame.collapsed, 'history'] })
    expect(jobDocuments.openJob('c1', 'Nightly load', 'history')).toBe(id)
    expect(jobDocuments.get(id)!.frame).toMatchObject({ section: 'history', reveal: 1 })
    expect(jobDocuments.get(id)!.frame.collapsed).not.toContain('history')
    // Another click on the link scrolls there again in the one tab.
    expect(jobDocuments.openJob('c1', 'Nightly load', 'history')).toBe(id)
    expect(jobDocuments.get(id)!.frame.reveal).toBe(2)
    expect(Object.values(documents.getSnapshot().documents).filter(item => item.kind === 'agentJob')).toHaveLength(1)
  })
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
  it('loads a CmdExec or PowerShell command from main\'s open dialog, naming only the step type, and says why a file was refused', async () => {
    const fixture = opened(stepped()), { jobDocuments } = fixture
    const open = vi.fn<(subsystem: 'PowerShell' | 'CmdExec') => Promise<ApiResult<string | null>>>(async () => ({ ok: true, value: 'robocopy D:\\a \\\\fs\\b' }))
    let answer!: (value: ApiResult<string | null>) => void
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    // Without the API (a test workbench) the step says so; a T-SQL step never asks.
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    expect(await jobDocuments.loadStepScript(id, 's1')).toBeUndefined()
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', failure: 'Load from file is not available here.' })
    Object.assign(fixture.api, { openAgentStepScript: open })
    expect(await jobDocuments.loadStepScript(id, 's2')).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    expect(await jobDocuments.loadStepScript(id, 's1')).toBe('robocopy D:\\a \\\\fs\\b')
    expect(open).toHaveBeenCalledWith('CmdExec')
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    // Cancel loads nothing; a refusal is shown under the command until the command changes.
    open.mockResolvedValueOnce({ ok: true, value: null })
    expect(await jobDocuments.loadStepScript(id, 's1')).toBeUndefined()
    open.mockResolvedValueOnce({ ok: false, error: 'The file is longer than a step\'s command may be (100,000 characters).' })
    expect(await jobDocuments.loadStepScript(id, 's1')).toBeUndefined()
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', running: false, failure: expect.stringContaining('100,000') })
    jobDocuments.updateStep(id, 's1', { command: 'dir' })
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    // A refusal's message also goes with a type change or another step's selection, and does not come back with the step.
    open.mockResolvedValueOnce({ ok: false, error: 'This file is not a text file Varia can read. Use UTF-8 or UTF-16.' })
    jobDocuments.selectStep(id, 's1')
    await jobDocuments.loadStepScript(id, 's1')
    jobDocuments.updateStep(id, 's1', { subsystem: 'PowerShell' })
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    open.mockResolvedValueOnce({ ok: false, error: 'The file does not exist.' })
    await jobDocuments.loadStepScript(id, 's1')
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', failure: 'The file does not exist.' })
    jobDocuments.selectStep(id, 's2')
    jobDocuments.selectStep(id, 's1')
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    // A refusal that answers after another step was selected, or after the type changed, is not kept for the step either.
    open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const refusedAway = jobDocuments.loadStepScript(id, 's1')
    jobDocuments.selectStep(id, 's2')
    answer({ ok: false, error: 'The file does not exist.' })
    await refusedAway
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    jobDocuments.selectStep(id, 's1')
    open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const refusedRetyped = jobDocuments.loadStepScript(id, 's1')
    jobDocuments.updateStep(id, 's1', { subsystem: 'PowerShell' })
    answer({ ok: false, error: 'The file does not exist.' })
    await refusedRetyped
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    // Deleting or adding a step drops a refusal, so a new step that reuses a key never inherits it.
    open.mockResolvedValueOnce({ ok: false, error: 'The file does not exist.' })
    await jobDocuments.loadStepScript(id, 's1')
    expect(jobDocuments.get(id)?.stepFile).toBeDefined()
    jobDocuments.addStepOf(id, 'CmdExec')
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    jobDocuments.deleteStepOf(id, jobDocuments.selectedStep(id)!.key)
    jobDocuments.dismissDeletion(id)
    jobDocuments.selectStep(id, 's1')
    // The type changed while the dialog was up: the text is not for this step any more.
    open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const pending = jobDocuments.loadStepScript(id, 's1')
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', running: true })
    expect(await jobDocuments.loadStepScript(id, 's1')).toBeUndefined()
    expect(open).toHaveBeenCalledTimes(9)
    jobDocuments.updateStep(id, 's1', { subsystem: 'PowerShell' })
    answer({ ok: true, value: 'Get-Date' })
    expect(await pending).toBeUndefined()
    expect(await jobDocuments.loadStepScript(id, 's1')).toBe('robocopy D:\\a \\\\fs\\b')
    expect(open).toHaveBeenLastCalledWith('PowerShell')
    // Another step selected while the dialog was up (a popout's dialog is not modal to it): the text lands nowhere.
    jobDocuments.selectStep(id, 's1')
    open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const moved = jobDocuments.loadStepScript(id, 's1')
    jobDocuments.selectStep(id, 's2')
    answer({ ok: true, value: 'Get-Date' })
    expect(await moved).toBeUndefined()
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    // The job read again while the dialog was up: its steps may be other steps now.
    jobDocuments.selectStep(id, 's1')
    open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const reread = jobDocuments.loadStepScript(id, 's1')
    jobDocuments.reload(id)
    await settled()
    answer({ ok: true, value: 'Get-Date' })
    expect(await reread).toBeUndefined()
  })
  it('says so when the step can no longer be edited by the time a step script is chosen', async () => {
    const fixture = opened(stepped()), { jobDocuments, answers, setModel } = fixture
    let answer!: (value: ApiResult<string | null>) => void
    Object.assign(fixture.api, { openAgentStepScript: vi.fn(() => new Promise<ApiResult<string | null>>(resolve => { answer = resolve })) })
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    const pending = jobDocuments.loadStepScript(id, 's1')
    // A save that loses the race leaves the document stale (read-only until Reload) while the dialog is still up.
    setModel({ ...stepped(), job: record({ version: 8 }) })
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'stale', retryable: false } } })
    expect(await jobDocuments.save(id)).toBe(false)
    expect(jobDocuments.canEditSteps(id)).toBe(false)
    answer({ ok: true, value: 'dir' })
    expect(await pending).toBeUndefined()
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', running: false, failure: 'The step could not be edited when the file was chosen, so it was not loaded.' })
  })
  it('lets a newer load of the same step survive an older dialog answering after a re-read', async () => {
    const fixture = opened(stepped()), { jobDocuments } = fixture
    const answers: ((value: ApiResult<string | null>) => void)[] = []
    Object.assign(fixture.api, { openAgentStepScript: vi.fn(() => new Promise<ApiResult<string | null>>(resolve => { answers.push(resolve) })) })
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    jobDocuments.selectStep(id, 's1')
    const first = jobDocuments.loadStepScript(id, 's1')
    // Reload re-reads the job: the first load's entry goes, so Load from file can be clicked again (a popout's dialogs
    // queue in main behind the first).
    jobDocuments.reload(id)
    await settled()
    expect(jobDocuments.get(id)?.stepFile).toBeUndefined()
    jobDocuments.updateStep(id, 's1', { subsystem: 'CmdExec' })
    jobDocuments.selectStep(id, 's1')
    const second = jobDocuments.loadStepScript(id, 's1')
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', running: true })
    answers[0]!({ ok: true, value: 'old' })
    expect(await first).toBeUndefined()
    expect(jobDocuments.get(id)?.stepFile).toMatchObject({ key: 's1', running: true })
    answers[1]!({ ok: true, value: 'echo new' })
    expect(await second).toBe('echo new')
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
  it('sets a step\'s actions, adds after it, applies a flow check\'s fix and starts once at a saved step (Steps › Flow)', async () => {
    const { jobDocuments, executes } = opened(stepped())
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    // Every document opens on List; Flow is per document and not remembered, and leaving it closes its docked editor.
    expect(jobDocuments.get(id)?.stepsView).toBeUndefined()
    jobDocuments.setStepsView(id, 'flow')
    jobDocuments.openStepEditor(id, 's2')
    expect(jobDocuments.get(id)).toMatchObject({ stepsView: 'flow', stepEditor: true, step: 's2' })
    jobDocuments.closeStepEditor(id)
    expect(jobDocuments.get(id)?.stepEditor).toBeUndefined()
    jobDocuments.openStepEditor(id, 's3')
    jobDocuments.setStepsView(id, 'list')
    expect([jobDocuments.get(id)?.stepsView, jobDocuments.get(id)?.stepEditor, jobDocuments.get(id)?.step]).toEqual([undefined, undefined, 's3'])
    // A go-to needs another step that exists; the other actions drop the target.
    jobDocuments.setStepAction(id, 's2', 'fail', 4, 's2')
    jobDocuments.setStepAction(id, 's2', 'fail', 4, 'n9')
    expect(jobDocuments.get(id)?.draft?.steps.steps[1]).toMatchObject({ onFail: 2 })
    jobDocuments.setStepAction(id, 's2', 'fail', 4, 's1')
    expect(jobDocuments.get(id)?.draft?.steps.steps[1]).toMatchObject({ onFail: 4, onFailTarget: 's1' })
    jobDocuments.setStepAction(id, 's1', 'fail', 1)
    expect(jobDocuments.get(id)?.draft?.steps.steps[0]).toMatchObject({ onFail: 1, onFailTarget: undefined })
    // Add step after: just below the step, selected.
    jobDocuments.addStepAfter(id, 's1', 'CmdExec')
    expect(keys(jobDocuments, id)).toEqual(['s1', 'n1', 's2', 's3'])
    expect(jobDocuments.selectedStep(id)).toMatchObject({ key: 'n1', subsystem: 'CmdExec' })
    // Make Start step and the last step's Quit, as the Flow checks offer them.
    jobDocuments.applyFlowFix(id, 's2', { kind: 'makeStart' })
    expect(jobDocuments.get(id)?.draft?.steps.startKey).toBe('s2')
    jobDocuments.applyFlowFix(id, 's3', { kind: 'quit', which: 'success', success: false })
    expect(jobDocuments.get(id)?.draft?.steps.steps[3]).toMatchObject({ key: 's3', onSuccess: 2 })
    // Start job at this step: a saved step by its saved name; a new one cannot be started yet.
    expect(jobDocuments.canStartAtStep(id, 'n1')).toBe(false)
    expect(jobDocuments.canStartAtStep(id, 's2')).toBe(true)
    await jobDocuments.startAtStep(id, 's2')
    expect(executes().at(-1)).toMatchObject({ action: 'startJob', stepName: 'Load' })
  })
  it('opens the step menu with On success, On failure and Add step after from the draft on Windows and Linux, and pickers on macOS', async () => {
    const { jobDocuments, menus, commands, quickInput } = opened(stepped())
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    const target = { kind: 'agentStep', tabId: id, key: 's2' } as const
    const items = menus.resolve('agent.steps.context', target)
    const titles = (list: typeof items) => list.map(item => item.kind === 'separator' ? '-' : item.title)
    expect(titles(items)).toEqual(['Edit step', 'Start job at this step', 'Make Start step', '-', 'On success', 'On failure', '-', 'Add step after', 'Move up', 'Move down', '-', 'Delete step'])
    const failure = items.find(item => item.kind === 'submenu' && item.title === 'On failure')
    if (failure?.kind !== 'submenu') throw new Error('no On failure submenu')
    expect(titles(failure.items)).toEqual(['Go to the next step (3 · Notify)', '-', 'Go to step 1: Extract', 'Go to step 3: Notify', '-', 'Quit the job reporting success', 'Quit the job reporting failure'])
    expect(failure.items.filter(item => item.kind === 'command' && item.checked).map(item => item.kind === 'command' && item.title)).toEqual(['Quit the job reporting failure'])
    // Picking an item sets the action on the menu's step, not the selected one.
    const goTo = failure.items.find(item => item.kind === 'command' && item.title === 'Go to step 1: Extract')
    if (goTo?.kind !== 'command') throw new Error('no item')
    expect(jobDocuments.selectedStep(id)?.key).toBe('s1')
    await commands.execute(goTo.id, goTo.args, 'menu')
    expect(jobDocuments.get(id)?.draft?.steps.steps[1]).toMatchObject({ key: 's2', onFail: 4, onFailTarget: 's1' })
    const add = items.find(item => item.kind === 'submenu' && item.title === 'Add step after')
    if (add?.kind !== 'submenu') throw new Error('no Add step after submenu')
    expect(titles(add.items)).toEqual(['T-SQL', 'PowerShell', 'CmdExec', 'SSIS'])
    const cmd = add.items.find(item => item.kind === 'command' && item.title === 'CmdExec')
    if (cmd?.kind !== 'command') throw new Error('no CmdExec')
    await commands.execute(cmd.id, cmd.args, 'menu')
    expect(keys(jobDocuments, id)).toEqual(['s1', 's2', 'n1', 's3'])
    // Enter and Delete on the graph act on the selected step.
    jobDocuments.selectStep(id, 's3')
    await commands.execute('agentJob.deleteStep', { tabId: id }, 'keybinding')
    expect(keys(jobDocuments, id)).toEqual(['s1', 's2', 'n1'])
    await commands.execute('agentJob.editStep', { tabId: id }, 'keybinding')
    expect(jobDocuments.get(id)?.stepEditor).toBe(true)
    // The picker lists the same choices (macOS's On failure…, and a port dropped on empty space).
    await commands.execute('agentJob.pickStepOnFailure', { tabId: id, target }, 'menu')
    expect(quickInput.getSnapshot()).toMatchObject({ visible: true, ariaLabel: 'Step 2: On failure' })
  })
  it('places macOS\'s step pickers where Windows and Linux have the submenus', async () => {
    const fixture = workbenchFixture({ platform: 'darwin' })
    cleanups.push(() => fixture.dispose())
    const items = fixture.menus.resolve('agent.steps.context', { kind: 'agentStep', tabId: 'none', key: 's1' })
    expect(items.map(item => item.kind === 'separator' ? '-' : item.title)).toEqual(['Edit step', 'Start job at this step', 'Make Start step', '-', 'On success…', 'On failure…', '-', 'Add step after…', 'Move up', 'Move down', '-', 'Delete step'])
  })
  it('keeps the step menu\'s edits, Enter and the drop picker with the backend lost; Start job at this step needs it', () => {
    const local = ['agentJob.editStep', 'agentJob.makeStartStep', 'agentJob.setStepAction', 'agentJob.pickStepOnSuccess', 'agentJob.pickStepOnFailure',
      'agentJob.addStepAfter', 'agentJob.pickStepToAdd', 'agentJob.deleteStep', 'agentJob.moveStepUp', 'agentJob.moveStepDown'] as const
    const lost = { activeDocumentIsAgentJob: true, backendReady: false }
    for (const command of local) expect(evaluateWhen(compileWhen(commandDescriptor(command).precondition!), lost), command).toBe(true)
    for (const command of ['agentJob.startAtThisStep', 'agentJob.start', 'agentJob.save', 'agentJob.reload'] as const)
      expect(evaluateWhen(compileWhen(commandDescriptor(command).precondition!), lost), command).toBe(false)
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

describe("the job document's step command models", () => {
  it('keeps each step\'s model (and its undo) across the views until the document closes, and drops an older read\'s', async () => {
    const { stepModels, pruneStepModels } = await import('../src/renderer/src/agent/step-models')
    const { jobDocuments } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    const fake = () => ({ dispose: vi.fn() }) as unknown as import('monaco-editor').editor.ITextModel
    const kept = fake(), older = fake()
    stepModels(id).set('read2|s1', { model: kept, documentId: 'a' })
    stepModels(id).set('read1|s1', { model: older, documentId: 'b' })
    // List and Flow mount and unmount the editor; the models stay with the document.
    jobDocuments.setStepsView(id, 'flow')
    jobDocuments.setStepsView(id, 'list')
    expect(stepModels(id).get('read2|s1')?.model).toBe(kept)
    pruneStepModels(id, 'read2')
    expect(older.dispose).toHaveBeenCalled()
    expect([...stepModels(id).keys()]).toEqual(['read2|s1'])
    jobDocuments.closed(id)
    expect(kept.dispose).toHaveBeenCalled()
    expect(stepModels(id).size).toBe(0)
  })
  it('opens Flow\'s docked editor for an Edit step link from History or the copy review, and selects the step on List', async () => {
    const { jobDocuments } = opened(model({ steps: [{ id: 1, name: 'Extract', subsystem: 'TSQL' }, { id: 2, name: 'Load', subsystem: 'TSQL' }] }))
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.editStep(id, 's2')
    expect(jobDocuments.get(id)?.step).toBe('s2')
    expect(jobDocuments.get(id)?.stepEditor).toBeUndefined()
    jobDocuments.setStepsView(id, 'flow')
    jobDocuments.editStep(id, 's1')
    expect(jobDocuments.get(id)).toMatchObject({ step: 's1', stepEditor: true })
  })
})
