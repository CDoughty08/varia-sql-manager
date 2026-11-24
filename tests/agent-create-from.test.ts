import { afterEach, describe, expect, it } from 'vitest'
import { agentJobSave, agentJobSaveProblems, uncategorizedCategory, type AgentJobDocumentModel, type AgentJobRecord } from '../src/shared/actions/agent-job'
import type { AgentScheduleRecord } from '../src/shared/actions/agent-schedule'
import type { ActionDescribeResult, ActionExecuteResult, ActionRequest } from '../src/shared/actions/schema'
import {
  applyReplace, canShareSchedule, changedPackages, copyScheduleChoice, createFromCommandEntries, createFromCompare, createFromDraft, createFromLimits, createFromProblems, createFromText,
  jobCopySource, replaceMatches, stepKeyChanged, stepKeyFields, withCopyScheduleChoice
} from '../src/shared/agent/create-from'
import { defaultSchedule } from '../src/shared/agent/schedule'
import type { AgentJobStepRecord } from '../src/shared/agent/steps'
import { commandDescriptor } from '../src/shared/commands/catalog'
import type { ApiResult } from '../src/shared/contracts'
import { jobCopySection } from '../src/renderer/src/agent/JobDocumentService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const ssis = (pkg: string, env = 3) => `/ISSERVER "\\"\\SSISDB\\Finance\\ETL\\${pkg}\\"" /SERVER "\\".\\"" /ENVREFERENCE ${env} /Par "\\"$ServerOption::SYNCHRONIZED(Boolean)\\"";True /CALLERINFO SQLAGENT /REPORTING E`
const steps: AgentJobStepRecord[] = [
  { id: 1, name: 'Truncate Sales staging', subsystem: 'TSQL', command: 'TRUNCATE TABLE stg.SalesPeople;', databaseName: 'StagingDW', onSuccessAction: 3, onFailAction: 2, outputFileName: 'D:\\Logs\\Sales_truncate.txt' },
  { id: 2, name: 'Load Sales package', subsystem: 'SSIS', command: ssis('LoadStagingSales.dtsx'), onSuccessAction: 4, onSuccessStepId: 3, onFailAction: 2, proxyId: 5 },
  { id: 3, name: 'Merge facts', subsystem: 'TSQL', command: 'EXEC dbo.MergeFactSales;', databaseName: 'SalesDW', onSuccessAction: 1, onFailAction: 2, retryAttempts: 2, retryInterval: 5 }
]
const schedule = (id: number, name: string, patch: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord =>
  ({ ...defaultSchedule(20261101, name), freqType: 4, freqInterval: 1, activeStartTime: 23000, id, jobCount: 1, owner: 'sa', version: 2, modified: '2026-11-01T02:30:00.000', ...patch })
const record = (patch: Partial<AgentJobRecord> = {}): AgentJobRecord => ({
  jobId: '11111111-1111-1111-1111-111111111111', name: 'ETL – Load Sales', enabled: true, description: 'Loads Sales', category: 'Data Collector', owner: 'CONTOSO\\svc-etl',
  emailLevel: 2, emailOperator: 'DBA team', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
  created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, ...patch
})
const model = (patch: Partial<AgentJobDocumentModel> = {}): AgentJobDocumentModel => ({
  job: record(), login: 'CONTOSO\\dana', sysadmin: false, platform: 'windows', categories: [uncategorizedCategory, 'Data Collector'], operators: [], steps,
  alerts: [{ id: 21, name: 'Sales load failed', enabled: true, severity: 0, messageId: 50001 }], alertsEditable: false,
  mail: { checked: false, sysadmin: false }, schedules: [schedule(9, 'Nightly 02:30'), schedule(10, 'Unread', { version: undefined, modified: undefined })],
  proxies: [{ id: 5, name: 'SSISRunner', enabled: true, subsystems: ['SSIS'] }], databases: ['master', 'StagingDW', 'SalesDW', 'HRDW'], ...patch
})

describe('Create Job Like This: the copy', () => {
  it('copies General, Notifications and every step with its flow as new steps, disabled, owned by the login, alerts and history left behind', () => {
    const source = model(), draft = createFromDraft(source, 'CONTOSO\\dana', false)
    expect(draft).toMatchObject({ name: 'Copy of ETL – Load Sales', owner: 'CONTOSO\\dana', enabled: false, category: 'Data Collector', description: 'Loads Sales', emailLevel: 2, emailOperator: 'DBA team', removeAlerts: [] })
    expect(draft.steps.steps.map(step => [step.key, step.name, step.from])).toEqual([['s1', 'Truncate Sales staging', undefined], ['s2', 'Load Sales package', undefined], ['s3', 'Merge facts', undefined]])
    expect(draft.steps.steps[1]).toMatchObject({ onSuccess: 4, onSuccessTarget: 's3', proxyId: 5 })
    // Sysadmin keeps the source's owner.
    expect(createFromDraft(source, 'sa', true).owner).toBe('CONTOSO\\svc-etl')
    // New Job's own save: sp_add_job's fields, every step as a write (ids 1..n, targets resolved), the shared schedule attached under its guard
    // and the unread one copied as a new schedule. Nothing names the source.
    const created = model({ job: undefined, steps: [], schedules: [], alerts: undefined })
    const save = agentJobSave(created, draft)!
    expect(save).toMatchObject({ name: 'Copy of ETL – Load Sales', enabled: false, category: 'Data Collector', emailLevel: 2, emailOperator: 'DBA team' })
    expect(save).not.toHaveProperty('owner')
    expect(save).not.toHaveProperty('removeAlerts')
    expect(save.steps?.writes?.map(write => [write.id, write.name, write.onSuccessAction, write.onSuccessStepId])).toEqual([[1, 'Truncate Sales staging', 3, 0], [2, 'Load Sales package', 4, 3], [3, 'Merge facts', 1, 0]])
    expect(save.steps).not.toHaveProperty('deletes')
    expect(save.schedules).toEqual({ attach: [{ id: 9, version: 2, modified: '2026-11-01T02:30:00.000' }], add: [expect.objectContaining({ name: 'Unread (copy)', enabled: true })] })
    expect(agentJobSaveProblems(save, true)).toEqual([])
  })
  it('switches each schedule between Share, Copy and Leave out in the source\'s order, keeping what a copy was given', () => {
    const source = model(), records = source.schedules!
    const draft = createFromDraft(source, 'CONTOSO\\dana', false)
    expect(records.map(item => copyScheduleChoice(draft.schedules, item))).toEqual(['share', 'copy'])
    expect(canShareSchedule(records[1]!)).toBe(false)
    const left = withCopyScheduleChoice(draft.schedules, records, records[0]!, 'leave')
    expect(left.map(entry => entry.key)).toEqual(['n:copy:10'])
    const copied = withCopyScheduleChoice(left, records, records[0]!, 'copy')
    expect(copied.map(entry => entry.key)).toEqual(['n:copy:9', 'n:copy:10'])
    expect(copied[0]).toMatchObject({ fields: { name: 'Nightly 02:30 (copy)', activeStartTime: 23000 } })
    const renamed = copied.map(entry => entry.key === 'n:copy:9' ? { ...entry, fields: { ...entry.fields, name: 'HR nightly' } } : entry)
    const shared = withCopyScheduleChoice(renamed, records, records[0]!, 'share')
    expect(shared.map(entry => [entry.key, entry.attached ?? false])).toEqual([['s:9', true], ['n:copy:10', false]])
    expect(withCopyScheduleChoice(withCopyScheduleChoice(renamed, records, records[0]!, 'copy'), records, records[0]!, 'copy')[0]?.fields.name).toBe('HR nightly')
    // An unguarded schedule cannot be shared: the choice stays.
    expect(withCopyScheduleChoice(draft.schedules, records, records[1]!, 'share').map(entry => entry.key)).toEqual(['s:9'])
  })
  it('replaces across names, commands with package paths and output files, only the matches chosen, and never a shared schedule\'s name', () => {
    const source = model(), draft = createFromDraft(source, 'CONTOSO\\dana', false)
    const { matches, more } = replaceMatches(draft, 'sales')
    expect(more).toBe(false)
    expect(matches.map(match => match.label)).toEqual([
      'Job name', "Step 1 'Truncate Sales staging' · name", "Step 1 'Truncate Sales staging' · command", "Step 1 'Truncate Sales staging' · output file",
      "Step 2 'Load Sales package' · name", "Step 2 'Load Sales package' · package and command", "Step 3 'Merge facts' · command"
    ])
    expect(matches[2]).toMatchObject({ before: 'TRUNCATE TABLE stg.', match: 'Sales', after: 'People;' })
    expect(replaceMatches(draft, 'sales', { matchCase: true }).matches).toEqual([])
    // Untick the output file: everything else changes.
    const chosen = new Set(matches.filter(match => match.field !== 'stepOutput').map(match => match.id))
    const replaced = applyReplace(draft, 'sales', 'HR', chosen)
    expect(replaced.name).toBe('Copy of ETL – Load HR')
    expect(replaced.steps.steps.map(step => step.name)).toEqual(['Truncate HR staging', 'Load HR package', 'Merge facts'])
    expect(replaced.steps.steps[0]).toMatchObject({ command: 'TRUNCATE TABLE stg.HRPeople;', outputFileName: 'D:\\Logs\\Sales_truncate.txt' })
    expect(replaced.steps.steps[1]?.command).toContain('\\SSISDB\\Finance\\ETL\\LoadStagingHR.dtsx')
    expect(replaced.steps.steps[2]?.command).toBe('EXEC dbo.MergeFactHR;')
    expect(replaced.steps.steps[0]?.onSuccess).toBe(3)
    // The copied (new) schedule's name is replaced; the shared one is the source's schedule too, so it is never offered.
    const withCopy = { ...draft, schedules: withCopyScheduleChoice(draft.schedules, source.schedules!, source.schedules![0]!, 'copy') }
    expect(replaceMatches(withCopy, 'Nightly').matches.map(match => match.label)).toEqual(["Schedule 'Nightly 02:30 (copy)' · name"])
    expect(replaceMatches(draft, 'Nightly').matches).toEqual([])
    expect(applyReplace(draft, 'sales', 'HR', new Set())).toBe(draft)
    expect(replaceMatches(draft, 'x'.repeat(createFromLimits.replaceChars + 1)).matches).toEqual([])
  })
  it('finds case-insensitive matches at their offsets in the original text, even after a character that lower-cases longer', () => {
    const draft = createFromDraft(model({ steps: [{ id: 1, name: 'İstanbul Sales', subsystem: 'TSQL', command: '-- İİ (a+b) [x]\nEXEC dbo.LoadSALES; -- (a+b) [x]' }] }), 'dana', false)
    const replaced = applyReplace(draft, 'sales', 'HR', new Set(replaceMatches(draft, 'sales').matches.map(match => match.id)))
    expect(replaced.steps.steps[0]).toMatchObject({ name: 'İstanbul HR', command: '-- İİ (a+b) [x]\nEXEC dbo.LoadHR; -- (a+b) [x]' })
    // Regular-expression characters in the find text are literal.
    expect(replaceMatches(draft, '(a+b) [x]').matches.filter(match => match.field === 'stepCommand').map(match => match.start)).toEqual([6, 39])
  })
  it('lists at most the match limit and says there were more', () => {
    const draft = createFromDraft(model({ steps: [{ id: 1, name: 'Many', subsystem: 'TSQL', command: 'a'.repeat(createFromLimits.replaceMatches + 5) }] }), 'dana', false)
    const { matches, more } = replaceMatches(draft, 'a')
    expect(matches).toHaveLength(createFromLimits.replaceMatches)
    expect(more).toBe(true)
  })
  it('marks each step\'s key fields that differ from its source step, and flags the SSIS steps whose package changed', () => {
    const source = jobCopySource(model()), draft = createFromDraft(model(), 'dana', false)
    expect(draft.steps.steps.map(step => stepKeyFields(step))).toEqual([['database', 'command'], ['package', 'environment'], ['database', 'command']])
    expect(stepKeyChanged(source, draft.steps.steps[0]!, 'database')).toBe(false)
    const edited = applyReplace(draft, 'Sales', 'HR', new Set(replaceMatches(draft, 'Sales').matches.map(match => match.id)))
    const moved = { ...edited, steps: { ...edited.steps, steps: edited.steps.steps.map(step => step.key === 's1' ? { ...step, databaseName: 'HRDW' } : step) } }
    expect(stepKeyChanged(source, moved.steps.steps[0]!, 'database')).toBe(true)
    expect(stepKeyChanged(source, moved.steps.steps[1]!, 'package')).toBe(true)
    expect(stepKeyChanged(source, moved.steps.steps[1]!, 'environment')).toBe(false)
    expect(changedPackages(source, moved).map(step => step.key)).toEqual(['s2'])
    expect(changedPackages(source, draft)).toEqual([])
  })
  it('compares the copy with its source field by field, steps and schedules included', () => {
    const source = jobCopySource(model()), draft = createFromDraft(model(), 'CONTOSO\\dana', false)
    expect(createFromCompare(source, draft).map(row => [row.group, row.field])).toEqual([['Job', 'Name'], ['Job', 'Owner'], ['Job', 'Enabled'], ["Schedule 'Unread'", 'Schedule']])
    const changed = { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.filter(step => step.key !== 's3').map(step => step.key === 's1' ? { ...step, databaseName: 'HRDW' } : step) } }
    const rows = createFromCompare(source, { ...changed, schedules: [] }, model().proxies)
    expect(rows).toContainEqual({ group: "Step 3 'Merge facts'", field: 'Step', source: 'T-SQL · EXEC dbo.MergeFactSales;', copy: createFromText.removed })
    expect(rows).toContainEqual({ group: "Step 1 'Truncate Sales staging'", field: 'Database', source: 'StagingDW', copy: 'HRDW' })
    // Step 2 went to step 3, which is gone: its flow quits instead.
    expect(rows).toContainEqual(expect.objectContaining({ group: "Step 2 'Load Sales package'", field: 'On success', source: "Go to step 3 'Merge facts'" }))
    expect(rows).toContainEqual(expect.objectContaining({ group: "Schedule 'Nightly 02:30'", copy: 'Left out' }))
  })
  it('refuses to save a copy of a job whose steps were not all read', () => {
    expect(createFromProblems(jobCopySource(model()))).toEqual([])
    expect(createFromProblems(jobCopySource(model({ stepsTruncated: true })))).toEqual([{ field: 'steps', severity: 'error', message: createFromText.stepsTruncated }])
  })
  it('puts Create Job Like This on a job\'s menu after New Job, with no release gate (AG-9)', () => {
    const entry = createFromCommandEntries()['agent.createJobLike']
    expect(entry.precondition).not.toContain('agentEnabled')
    expect(commandDescriptor('agent.createJobLike')).toMatchObject({ title: 'Create Job Like This…', menus: [{ menu: 'explorer.context', group: '0_new', order: 2, when: "explorerNode == 'agentJob' && !explorerServerLost" }, { menu: 'agent.jobs.context', group: '1_open', order: 2 }] })
    expect(entry.keywords).toContain('existing')
  })
})

/** A workbench whose describe answers the source job's model, and New Job's for the Agent node. */
function opened(first = model()) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const current = first
  const answers: ApiResult<ActionExecuteResult>[] = []
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog !== 'agentJob' ? { elapsedMs: 1 }
    : params.target.kind === 'agent' ? { agentJobDocument: { ...current, job: undefined, steps: [], alerts: undefined, schedules: [], jobs: [current.job!.name], jobIds: [current.job!.jobId] }, elapsedMs: 1 }
      : { agentJobDocument: current, elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.executeObjectAction.mockImplementation(async () => answers.shift() ?? { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, executes, answers }
}

describe('Create Job Like This: the document', () => {
  it('opens New Job filled from the job with Changes from source first, and creates it through New Job\'s save', async () => {
    const { jobDocuments, documents, executes } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load Sales')
    expect(documents.get(id)?.name).toBe('New Job')
    expect(jobDocuments.get(id)?.copying).toBe('ETL – Load Sales')
    await settled()
    const state = jobDocuments.get(id)!
    expect(state).toMatchObject({ phase: 'ready', draft: { name: 'Copy of ETL – Load Sales', enabled: false }, source: { base: { name: 'ETL – Load Sales' } }, frame: { section: jobCopySection } })
    expect(state.copying).toBeUndefined()
    expect(state.like).toBeUndefined()
    expect(documents.get(id)?.dirty).toBe(true)
    // Replace across the copy: preview, untick one, apply.
    jobDocuments.setReplace(id, { find: 'Sales', with: 'HR' })
    jobDocuments.previewReplace(id)
    const preview = jobDocuments.get(id)!.replace!.preview!
    expect(preview.chosen).toHaveLength(preview.matches.length)
    jobDocuments.toggleReplaceMatch(id, preview.matches.find(match => match.field === 'stepOutput')!.id)
    jobDocuments.applyReplace(id)
    expect(jobDocuments.get(id)).toMatchObject({ draft: { name: 'Copy of ETL – Load HR' }, notice: createFromText.applied(preview.matches.length - 1) })
    expect(jobDocuments.get(id)?.replace?.preview).toBeUndefined()
    // Schedules: leave the shared one out.
    jobDocuments.setCopySchedule(id, 9, 'leave')
    jobDocuments.updateDraft(id, { name: 'ETL – Load HR', enabled: true })
    expect(jobDocuments.compareRows(id).map(row => row.field)).toContain('Name')
    expect(await jobDocuments.save(id)).toBe(true)
    const sent = executes().at(-1)!
    expect(sent).toMatchObject({ action: 'agentJob', target: { kind: 'agent' }, agentJob: { name: 'ETL – Load HR', enabled: true, schedules: { add: [expect.objectContaining({ name: 'Unread (copy)' })] } } })
    expect(sent).not.toHaveProperty('agentIdentity')
    if (sent.action !== 'agentJob') throw new Error('not a job save')
    expect(sent.agentJob.steps?.writes?.map(write => write.name)).toEqual(['Truncate HR staging', 'Load HR package', 'Merge facts'])
    expect(sent.agentJob.schedules).not.toHaveProperty('attach')
    // Once created, the document is the new job's: the copy's source and its section go.
    await settled()
    expect(jobDocuments.get(id)?.source).toBeUndefined()
    expect(jobDocuments.get(id)?.frame.section).toBe('general')
  })
  it('asks for a fresh preview when the copy changed after it, and Compare with source follows the edits', async () => {
    const { jobDocuments } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load Sales')
    await settled()
    jobDocuments.setReplace(id, { find: 'Sales', with: 'HR' })
    jobDocuments.previewReplace(id)
    jobDocuments.updateDraft(id, { description: 'Edited' })
    expect(jobDocuments.replacePreviewCurrent(id)).toBe(false)
    jobDocuments.applyReplace(id)
    expect(jobDocuments.get(id)).toMatchObject({ draft: { name: 'Copy of ETL – Load Sales' }, notice: createFromText.replaceStale })
    // A change of the texts drops the preview too.
    jobDocuments.previewReplace(id)
    jobDocuments.setReplace(id, { with: 'Payroll' })
    expect(jobDocuments.get(id)?.replace?.preview).toBeUndefined()
    jobDocuments.toggleCompare(id)
    expect(jobDocuments.get(id)?.compareOpen).toBe(true)
    expect(jobDocuments.compareRows(id)).toContainEqual(expect.objectContaining({ field: 'Description', source: 'Loads Sales', copy: 'Edited' }))
  })
  it('refuses to save a copy whose source steps were cut, and a failed read leaves New Job reloadable', async () => {
    const truncated = opened(model({ stepsTruncated: true }))
    const id = truncated.jobDocuments.createLike('c1', 'ETL – Load Sales')
    await settled()
    expect(truncated.jobDocuments.problems(id)).toContainEqual({ field: 'steps', severity: 'error', message: createFromText.stepsTruncated })
    expect(truncated.jobDocuments.canSave(id)).toBe(false)

    const failing = opened()
    failing.api.describeObject.mockImplementation(async () => ({ ok: false, error: 'boom' }))
    const other = failing.jobDocuments.createLike('c1', 'ETL – Load Sales')
    await settled()
    expect(failing.jobDocuments.get(other)).toMatchObject({ phase: 'loadFailed' })
    expect(failing.jobDocuments.get(other)?.copying).toBeUndefined()
    expect(failing.jobDocuments.canReload(other)).toBe(true)
  })
  it("copies the job of the menu it runs from, even with Job Activity Monitor active", async () => {
    const { jobDocuments, jobActivity, commands, documents } = opened()
    jobActivity.open('c1')
    expect(jobActivity.get(documents.getSnapshot().activeId)).toBeDefined()
    const node = { id: 3, lost: false, kind: 'agentJob', connectionId: 'c1', label: 'ETL – Load Sales', engine: 'box', ref: { type: 'object', object: { kind: 'agentJob', name: 'ETL – Load Sales' } } } as unknown as ExplorerMenuNode
    await commands.execute('agent.createJobLike', { target: { kind: 'explorer', node } }, 'menu')
    await settled()
    expect(Object.values(jobDocuments.getSnapshot().documents).map(state => state.source?.base.name)).toEqual(['ETL – Load Sales'])
  })
  it('reads a copy made on Schedules as Copy, so Changes from source never adds a second one', async () => {
    const { jobDocuments } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load Sales')
    await settled()
    jobDocuments.copySchedule(id, 's:9')
    expect(copyScheduleChoice(jobDocuments.get(id)!.draft!.schedules, { id: 9 })).toBe('copy')
    jobDocuments.setCopySchedule(id, 9, 'copy')
    expect(jobDocuments.get(id)!.draft!.schedules.filter(entry => entry.id === undefined).map(entry => entry.key).sort()).toEqual(['n:copy:10', 'n:copy:9'])
    expect(jobDocuments.compareRows(id).filter(row => row.field === 'Schedule').map(row => row.group)).toEqual(["Schedule 'Nightly 02:30'", "Schedule 'Unread'"])
  })
  it('keeps the source\'s owner only for sysadmin', async () => {
    const { jobDocuments } = opened(model({ sysadmin: true, login: 'sa' }))
    const id = jobDocuments.createLike('c1', 'ETL – Load Sales')
    await settled()
    jobDocuments.updateDraft(id, { owner: 'sa' })
    jobDocuments.keepSourceOwner(id)
    expect(jobDocuments.get(id)?.draft?.owner).toBe('CONTOSO\\svc-etl')
    const other = opened()
    const mine = other.jobDocuments.createLike('c1', 'ETL – Load Sales')
    await settled()
    other.jobDocuments.keepSourceOwner(mine)
    expect(other.jobDocuments.get(mine)?.draft?.owner).toBe('CONTOSO\\dana')
  })
})

