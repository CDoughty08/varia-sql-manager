import { afterEach, describe, expect, it } from 'vitest'
import { agentJobSave, agentJobSaveProblems, uncategorizedCategory, type AgentJobDocumentModel, type AgentJobRecord } from '../src/shared/actions/agent-job'
import type { AgentScheduleRecord } from '../src/shared/actions/agent-schedule'
import type { ActionDescribeResult, ActionExecuteRequest, ActionExecuteResult, ActionRequest } from '../src/shared/actions/schema'
import { createFromDraft, jobCopySource } from '../src/shared/agent/create-from'
import {
  addSeveralRow, createSeveralLimits, createSeveralText, defaultSeveralColumns, duplicateSeveralRow, fillSeveralNames, pasteSeveralRows, removeSeveralRow, resetSeveralDifference, severalCell,
  severalChecks, severalContext, severalDifferences, severalDoneText, severalOtherCount, severalRowDraft, severalSummary, startSeveral, withSeveralCell, withSeveralColumn, withSeveralEdited,
  type SeveralTable
} from '../src/shared/agent/create-several'
import { defaultSchedule } from '../src/shared/agent/schedule'
import { parseSsisCommand } from '../src/shared/agent/ssis-step'
import type { AgentJobStepRecord } from '../src/shared/agent/steps'
import type { ApiResult } from '../src/shared/contracts'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const ssis = (pkg: string, env = 3) => `/ISSERVER "\\"\\SSISDB\\Finance\\ETL\\${pkg}\\"" /SERVER "\\".\\"" /ENVREFERENCE ${env} /Par "\\"$ServerOption::SYNCHRONIZED(Boolean)\\"";True /CALLERINFO SQLAGENT /REPORTING E`
const steps: AgentJobStepRecord[] = [
  { id: 1, name: 'Truncate staging', subsystem: 'TSQL', command: 'TRUNCATE TABLE stg.SalesPeople;', databaseName: 'StagingDW', onSuccessAction: 3, onFailAction: 2 },
  { id: 2, name: 'Load package', subsystem: 'SSIS', command: ssis('LoadStagingSales.dtsx'), onSuccessAction: 3, onFailAction: 2, proxyId: 5 },
  { id: 3, name: 'Merge facts', subsystem: 'TSQL', command: 'EXEC dbo.MergeFactSales;', databaseName: 'SalesDW', onSuccessAction: 1, onFailAction: 2 }
]
const schedule = (id: number, name: string, patch: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord =>
  ({ ...defaultSchedule(20261101, name), freqType: 4, freqInterval: 1, activeStartTime: 23000, id, jobCount: 1, owner: 'sa', version: 2, modified: '2026-11-01T02:30:00.000', ...patch })
const record = (patch: Partial<AgentJobRecord> = {}): AgentJobRecord => ({
  jobId: '11111111-1111-1111-1111-111111111111', name: 'ETL – Load warehouse', enabled: true, description: 'Loads Sales', category: 'Data Collector', owner: 'CONTOSO\\svc-etl',
  emailLevel: 2, emailOperator: 'DBA team', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
  created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, ...patch
})
const operator = (name: string) => ({ name, enabled: true, email: true, pager: false, netSend: false, pagerDays: 0, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } })
const model = (patch: Partial<AgentJobDocumentModel> = {}): AgentJobDocumentModel => ({
  job: record(), login: 'CONTOSO\\dana', sysadmin: false, platform: 'windows', categories: [uncategorizedCategory, 'Data Collector'], operators: [operator('DBA team'), operator('Payroll team')], steps,
  alerts: [], alertsEditable: false, mail: { checked: false, sysadmin: false }, schedules: [schedule(9, 'Nightly 02:30')],
  proxies: [{ id: 5, name: 'SSISRunner', enabled: true, subsystems: ['SSIS'] }], databases: ['master', 'StagingDW', 'SalesDW', 'HRDW'], ...patch
})
/** New Job's describe (the table's model), the copy's source and its template. */
function contextOf(source = model(), created: Partial<AgentJobDocumentModel> = {}) {
  const newJob = { ...source, job: undefined, steps: [], alerts: undefined, schedules: [], jobs: ['ETL – Load warehouse', 'ETL – Load Sales'], ...created }
  const template = createFromDraft(source, newJob.login, newJob.sysadmin)
  return severalContext(jobCopySource(source), template, newJob)
}
const typed = (context: ReturnType<typeof contextOf>, table: SeveralTable, key: string, cells: Record<string, string>) =>
  Object.entries(cells).reduce((next, [column, value]) => withSeveralCell(context, next, key, column, value), table)

describe('Create several: the table', () => {
  it('opens with one row and Name, each step\'s key fields (not its command), each schedule and Enabled as columns', () => {
    const context = contextOf(), table = startSeveral(context)
    expect(table.rows).toEqual([{ key: 'r1', cells: {} }])
    expect(table.columns).toEqual(['name', 'enabled', 'step:s1:database', 'step:s2:package', 'step:s2:environment', 'step:s3:database', 'schedule:9'])
    expect(defaultSeveralColumns(context.columns)).toEqual(table.columns)
    // Owner is a column for sysadmin only; every column has a label.
    expect(context.columns.some(column => column.id === 'owner')).toBe(false)
    expect(contextOf(model({ sysadmin: true, login: 'sa' })).columns.some(column => column.id === 'owner')).toBe(true)
    expect(context.columns.find(column => column.id === 'step:s2:runAs')?.options?.map(option => option.label)).toEqual(['SQL Server Agent Service Account', 'SSISRunner'])
  })
  it('uses the template\'s value in an empty cell and the typed one only for its row, accent-marked when it differs', () => {
    const context = contextOf()
    let table = addSeveralRow(startSeveral(context))
    table = typed(context, table, 'r2', { name: 'ETL – Load Payroll', 'step:s2:package': '\\SSISDB\\Finance\\ETL\\LoadStagingPayroll.dtsx', 'step:s1:database': 'HRDW' })
    const [first, second] = table.rows
    expect(severalRowDraft(context, first!).draft).toEqual(context.template)
    const { draft, cellErrors } = severalRowDraft(context, second!)
    expect(cellErrors).toEqual({})
    expect(draft.name).toBe('ETL – Load Payroll')
    expect(draft.steps.steps[0]?.databaseName).toBe('HRDW')
    expect(parseSsisCommand(draft.steps.steps[1]!.command)).toMatchObject({ package: 'LoadStagingPayroll.dtsx', environmentReference: 3 })
    const name = context.columns.find(column => column.id === 'name')!
    expect(severalCell(context, first!, name)).toEqual({ value: 'Copy of ETL – Load warehouse', inherited: true, changed: false })
    expect(severalCell(context, second!, name)).toEqual({ value: 'ETL – Load Payroll', inherited: false, changed: true })
    // An empty cell goes back to the template's value; typing the template's value is no override.
    expect(withSeveralCell(context, table, 'r2', 'step:s1:database', '').rows[1]!.cells).not.toHaveProperty('step:s1:database')
    expect(withSeveralCell(context, table, 'r2', 'step:s1:database', 'StagingDW').rows[1]!.cells).not.toHaveProperty('step:s1:database')
  })
  it('flags a cell that cannot be used, duplicate names, a name msdb has and New Job\'s errors as blocking, and warnings apart', () => {
    const context = contextOf()
    let table = addSeveralRow(addSeveralRow(addSeveralRow(startSeveral(context))))
    table = typed(context, table, 'r1', { name: 'ETL – Load HR' })
    table = typed(context, table, 'r2', { name: 'etl – load hr ' })
    table = typed(context, table, 'r3', { name: 'ETL – Load Sales', 'step:s2:retries': 'many' })
    table = typed(context, table, 'r4', { name: 'ETL – Load Finance', emailLevel: '2', emailOperator: '(none)' })
    const checks = severalChecks(context, table)
    expect(checks.get('r1')?.blocking).toEqual([createSeveralText.duplicateName])
    expect(checks.get('r2')?.blocking).toEqual([createSeveralText.duplicateName])
    expect(checks.get('r3')?.blocking).toEqual(['Step 2 · retries: A whole number from 0 to 9999.', createSeveralText.existingName])
    expect(checks.get('r3')?.cellErrors).toHaveProperty(['step:s2:retries'])
    expect(checks.get('r4')?.blocking).toEqual(['Choose the operator to notify.'])
    // A required SSIS parameter without a value warns; it does not block.
    const ssis = severalChecks(context, typed(context, startSeveral(context), 'r1', { name: 'ETL – Load HR' }), () => new Map([['s2', ['SourceConnection is required and has no value.']]]))
    expect(ssis.get('r1')).toMatchObject({ blocking: [], warnings: ["Step 2 'Load package': SourceConnection is required and has no value."] })
  })
  it('adds, duplicates (without the result) and removes rows within the limit; created rows stay', () => {
    const context = contextOf()
    let table = typed(context, startSeveral(context), 'r1', { name: 'A' })
    table = duplicateSeveralRow(table, 'r1')
    expect(table.rows.map(row => [row.key, row.cells.name])).toEqual([['r1', 'A'], ['r2', 'A']])
    table = { ...table, rows: table.rows.map(row => row.key === 'r1' ? { ...row, result: { state: 'created', name: 'A', enabled: false } } : row) }
    expect(removeSeveralRow(table, 'r1').rows).toHaveLength(2)
    expect(removeSeveralRow(table, 'r2').rows.map(row => row.key)).toEqual(['r1'])
    expect(duplicateSeveralRow(table, 'r1').rows[1]).not.toHaveProperty('result')
    // A typed cell on a created row changes nothing.
    expect(withSeveralCell(context, table, 'r1', 'name', 'B')).toBe(table)
    let full = startSeveral(context)
    while (full.rows.length < createSeveralLimits.rows) full = addSeveralRow(full)
    expect(addSeveralRow(full)).toBe(full)
  })
  it('pastes rows from a spreadsheet, one tab-separated cell per visible column, and stops at the limit', () => {
    const context = contextOf()
    const pasted = pasteSeveralRows(startSeveral(context), 'ETL – Load HR\tyes\tHRDW\r\nETL – Load Payroll\t\t\t\\SSISDB\\Finance\\ETL\\LoadStagingPayroll.dtsx\n\n')
    expect(pasted.added).toBe(2)
    expect(pasted.table.rows.slice(1).map(row => row.cells)).toEqual([
      { name: 'ETL – Load HR', enabled: 'yes', 'step:s1:database': 'HRDW' },
      { name: 'ETL – Load Payroll', 'step:s2:package': '\\SSISDB\\Finance\\ETL\\LoadStagingPayroll.dtsx' }
    ])
    expect(severalRowDraft(context, pasted.table.rows[1]!).draft).toMatchObject({ name: 'ETL – Load HR', enabled: true })
    const many = Array.from({ length: createSeveralLimits.rows + 3 }, (_, at) => `Job ${at}`).join('\n')
    const cut = pasteSeveralRows(startSeveral(context), many)
    expect(cut.table.rows).toHaveLength(createSeveralLimits.rows)
    expect(cut.cut).toBe(4)
  })
  it('fills names from a pattern with the row\'s package, database, number and source, skipping created rows', () => {
    const context = contextOf()
    let table = addSeveralRow(addSeveralRow(startSeveral(context)))
    table = typed(context, table, 'r2', { 'step:s2:package': '\\SSISDB\\Finance\\ETL\\LoadStagingPayroll.dtsx' })
    table = { ...table, rows: table.rows.map(row => row.key === 'r3' ? { ...row, cells: { name: 'Done' }, result: { state: 'created', name: 'Done', enabled: true } } : row) }
    const filled = fillSeveralNames(context, table, 'ETL – {package} ({n}, {database}, {source}) {other}')
    expect(filled.rows.map(row => row.cells.name)).toEqual([
      'ETL – LoadStagingSales (1, StagingDW, ETL – Load warehouse) {other}', 'ETL – LoadStagingPayroll (2, StagingDW, ETL – Load warehouse) {other}', 'Done'
    ])
    expect(fillSeveralNames(context, table, '  ')).toBe(table)
  })
  it('names a schedule a row copies after the row\'s job, unless it was renamed', () => {
    const context = contextOf()
    const table = typed(context, startSeveral(context), 'r1', { name: 'ETL – Load HR', 'schedule:9': 'Copy' })
    const { draft } = severalRowDraft(context, table.rows[0]!)
    expect(draft.schedules.map(entry => entry.fields.name)).toEqual(['ETL – Load HR – Nightly 02:30'])
    const shared = severalRowDraft(context, startSeveral(context).rows[0]!).draft
    expect(shared.schedules).toEqual(context.template.schedules)
  })
  it('lists what a row differs in, puts the full editor\'s draft on the row, and resets one difference at a time', () => {
    const context = contextOf()
    let table = withSeveralColumn(context, startSeveral(context), 'step:s3:command', true)
    expect(table.columns).toContain('step:s3:command')
    table = typed(context, table, 'r1', { name: 'ETL – Load Payroll' })
    // The full editor changes a column field, a field no visible column shows, and adds a step.
    const opened = severalRowDraft(context, table.rows[0]!).draft
    const extra = { ...opened.steps.steps[2]!, key: 'n1', name: 'Notify' }
    const edited = {
      ...opened, emailOperator: 'Payroll team', description: 'Payroll',
      steps: { ...opened.steps, steps: [...opened.steps.steps.map(step => step.key === 's3' ? { ...step, command: 'EXEC dbo.MergeFactPayroll;', retryAttempts: 2, retryInterval: 5 } : step), extra] }
    }
    table = withSeveralEdited(table, 'r1', edited)
    expect(table.rows[0]!.cells).toEqual({})
    expect(severalRowDraft(context, table.rows[0]!).draft).toEqual(edited)
    const differences = severalDifferences(context, table, table.rows[0]!)
    expect(differences.map(item => [item.label, item.inColumn])).toEqual([
      ['Name', true], ['Description', false], ['E-mail · operator', false], ['Step 3 · command', true], ['Step 3 · retries', false], ['Step 3 · retry minutes', false], ['Steps (other changes)', false]
    ])
    expect(severalOtherCount(context, table, table.rows[0]!)).toBe(5)
    expect(differences.at(-1)?.value).toContain('Added Notify')
    // A cell typed after the editor shows in its column.
    table = typed(context, table, 'r1', { name: 'ETL – Load HR' })
    expect(severalDifferences(context, table, table.rows[0]!).find(item => item.id === 'name')).toMatchObject({ value: 'ETL – Load HR', inColumn: true })
    // Reset: a column field goes back to the template's value; Steps loses the added step and keeps the row's column values.
    table = resetSeveralDifference(context, table, 'r1', 'emailOperator')
    table = resetSeveralDifference(context, table, 'r1', 'field:steps')
    const reset = severalRowDraft(context, table.rows[0]!).draft
    expect(reset.emailOperator).toBe('DBA team')
    expect(reset.steps.steps.map(step => step.name)).toEqual(['Truncate staging', 'Load package', 'Merge facts'])
    expect(reset.steps.steps[2]).toMatchObject({ command: 'EXEC dbo.MergeFactPayroll;', retryAttempts: 2 })
    expect(reset).toMatchObject({ name: 'ETL – Load HR', description: 'Payroll' })
  })
  it('builds New Job\'s own save for each row and says what it sends', () => {
    const context = contextOf()
    const table = typed(context, startSeveral(context), 'r1', { name: 'ETL – Load HR', 'schedule:9': 'Copy', 'step:s1:database': 'HRDW' })
    const { draft } = severalRowDraft(context, table.rows[0]!)
    const save = agentJobSave(context.model, draft)!
    expect(agentJobSaveProblems(save, true)).toEqual([])
    expect(save).toMatchObject({ name: 'ETL – Load HR', enabled: false, schedules: { add: [expect.objectContaining({ name: 'ETL – Load HR – Nightly 02:30' })] } })
    expect(severalSummary(context, table, table.rows[0]!)).toBe('Job, 3 steps (T-SQL, SSIS), new schedule ETL – Load HR – Nightly 02:30, 2 fields differ, disabled')
    const done: SeveralTable = { ...table, rows: [{ ...table.rows[0]!, result: { state: 'created', name: 'ETL – Load HR', enabled: false } }, { key: 'r2', cells: {}, result: { state: 'failed', message: 'x' } }] }
    expect(severalDoneText(done, 1)).toBe('Done: 1 job created (disabled), 1 failed and rolled back, 1 skipped. Each row was its own transaction.')
    // A lost connection is not a rollback: the row on its way is not known and the rest were never sent.
    const lost: SeveralTable = { ...done, rows: [done.rows[0]!, { key: 'r2', cells: {}, result: { state: 'unknown', message: 'x' } }, { key: 'r3', cells: {}, result: { state: 'notSent', message: 'y' } }] }
    expect(severalDoneText(lost, 0)).toBe('Done: 1 job created (disabled), 1 not known (check Jobs before retrying), 1 not sent. Each row was its own transaction.')
  })
  it('drops a failed row\'s result once the row changes, but keeps a created or unknown one', () => {
    const context = contextOf()
    const base = startSeveral(context)
    const table: SeveralTable = { ...base, rows: [{ key: 'r1', cells: {}, result: { state: 'failed', message: 'x' } }, { key: 'r2', cells: {}, result: { state: 'unknown', message: 'y' } }], next: 3 }
    const edited = withSeveralCell(context, withSeveralCell(context, table, 'r1', 'name', 'Renamed'), 'r2', 'name', 'Other')
    expect(edited.rows.map(row => row.result?.state)).toEqual([undefined, 'unknown'])
    expect(withSeveralEdited(table, 'r1', severalRowDraft(context, table.rows[0]!).draft).rows[0]!.result).toBeUndefined()
  })
})

/** A workbench whose describe answers the source job and New Job's model; executes answer in order from `answers`. */
function opened(first = model()) {
  const fixture = workbenchFixture({ agentPreview: true })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const jobs = [first.job!.name], jobIds = [first.job!.jobId]
  const answers: ApiResult<ActionExecuteResult>[] = []
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog !== 'agentJob' ? { elapsedMs: 1 }
    : params.target.kind === 'agent' ? { agentJobDocument: { ...first, job: undefined, steps: [], alerts: undefined, schedules: [], jobs: [...jobs], jobIds: [...jobIds] }, elapsedMs: 1 }
      : { agentJobDocument: first, elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.executeObjectAction.mockImplementation(async (request: ActionExecuteRequest) => {
    const answer = answers.shift() ?? { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }
    if (answer.ok && !answer.value.error && request.action === 'agentJob' && request.agentJob.name) { jobs.push(request.agentJob.name); jobIds.push(`2222222${jobs.length}-2222-2222-2222-222222222222`) }
    return answer
  })
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, executes, answers, jobIds }
}

describe('Create several: the document', () => {
  it('turns the copy into a table, creates each row on its own with its own result, and enables the created jobs', async () => {
    const { jobDocuments, documents, executes, answers, jobIds } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load warehouse')
    await settled()
    jobDocuments.createSeveral(id)
    expect(documents.get(id)).toMatchObject({ name: createSeveralText.tab, dirty: true })
    expect(jobDocuments.get(id)?.several).toMatchObject({ phase: 'table', selected: 'r1' })
    jobDocuments.pasteSeveral(id, 'ETL – Load HR\nETL – Load Payroll\nETL – Load warehouse\nETL – Load Finance\n')
    jobDocuments.setSeveralCell(id, 'r1', 'name', 'ETL – Load Ops')
    expect(jobDocuments.get(id)?.several?.notice).toBeUndefined()
    const checks = jobDocuments.severalChecks(id)
    expect(checks.get('r4')?.blocking).toEqual([createSeveralText.existingName])
    jobDocuments.reviewSeveral(id)
    expect(jobDocuments.get(id)?.several?.phase).toBe('review')
    // The table cannot change under review.
    jobDocuments.setSeveralCell(id, 'r2', 'name', 'Changed')
    expect(jobDocuments.severalRowName(id, 'r2')).toBe('ETL – Load HR')
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }, { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }, { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } },
      { ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: "The specified @proxy_name ('SSISRunner') does not exist.", retryable: false } } })
    await jobDocuments.createSeveralJobs(id)
    const sent = executes().filter(request => request.action === 'agentJob')
    expect(sent.map(request => request.action === 'agentJob' ? [request.target.kind, request.agentJob.name, request.agentJob.enabled] : [])).toEqual([
      ['agent', 'ETL – Load Ops', false], ['agent', 'ETL – Load HR', false], ['agent', 'ETL – Load Payroll', false], ['agent', 'ETL – Load Finance', false]
    ])
    expect(new Set(sent.map(request => request.requestId)).size).toBe(4)
    const several = jobDocuments.get(id)!.several!
    expect(several.phase).toBe('done')
    expect(several.skipped).toEqual([{ key: 'r4', reason: createSeveralText.existingName }])
    expect(several.table.rows.map(row => row.result?.state)).toEqual(['created', 'created', 'created', undefined, 'failed'])
    expect(severalDoneText(several.table, 1)).toBe('Done: 3 jobs created (disabled), 1 failed and rolled back, 1 skipped. Each row was its own transaction.')
    expect(documents.get(id)?.dirty).toBe(true)
    // Enable the created jobs: one list read for their ids, then one enable per job.
    await jobDocuments.enableSeveralCreated(id)
    const enables = executes().filter(request => request.action === 'enable')
    expect(enables.map(request => request.action === 'enable' ? [request.target, request.agentIdentity] : [])).toEqual([
      [{ kind: 'agentJob', name: 'ETL – Load Ops' }, { jobId: jobIds[1] }], [{ kind: 'agentJob', name: 'ETL – Load HR' }, { jobId: jobIds[2] }], [{ kind: 'agentJob', name: 'ETL – Load Payroll' }, { jobId: jobIds[3] }]
    ])
    expect(jobDocuments.get(id)?.several).toMatchObject({ notice: createSeveralText.enabled(3) })
    // Back to the table: created rows are locked; the failed and skipped rows stay to fix and retry.
    jobDocuments.severalToTable(id)
    jobDocuments.setSeveralCell(id, 'r1', 'name', 'Changed')
    expect(jobDocuments.get(id)?.several?.table.rows[0]?.cells.name).toBe('ETL – Load Ops')
    jobDocuments.removeSeveralRow(id, 'r4')
    jobDocuments.removeSeveralRow(id, 'r5')
    expect(documents.get(id)?.dirty).toBe(false)
  })
  it('stops at a lost connection: the row on its way is unknown and the rest are not sent', async () => {
    const { jobDocuments, executes, answers } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load warehouse')
    await settled()
    jobDocuments.createSeveral(id)
    jobDocuments.pasteSeveral(id, 'A\nB')
    jobDocuments.setSeveralCell(id, 'r1', 'name', 'C')
    jobDocuments.reviewSeveral(id)
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }, { ok: false, error: 'gone', code: 'CONNECTION_LOST' })
    await jobDocuments.createSeveralJobs(id)
    expect(executes().filter(request => request.action === 'agentJob')).toHaveLength(2)
    expect(jobDocuments.get(id)?.several?.table.rows.map(row => row.result?.state)).toEqual(['created', 'unknown', 'notSent'])
  })
  it('opens a row in the full editor, whose edits go back to the row, and Back to the table closes it', async () => {
    const { jobDocuments, documents } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load warehouse')
    await settled()
    jobDocuments.createSeveral(id)
    jobDocuments.setSeveralCell(id, 'r1', 'name', 'ETL – Load HR')
    const editor = jobDocuments.openSeveralRow(id, 'r1')!
    expect(documents.get(editor)).toMatchObject({ name: 'Row 1 · ETL – Load HR', dirty: false })
    expect(jobDocuments.get(editor)).toMatchObject({ phase: 'ready', draft: { name: 'ETL – Load HR' }, row: { table: id, key: 'r1' } })
    // Under review the row cannot change from its editor either: what the review shows is what Create sends.
    jobDocuments.reviewSeveral(id)
    expect(jobDocuments.rowPaused(editor)).toBe(true)
    expect(jobDocuments.canEdit(editor)).toBe(false)
    jobDocuments.updateDraft(editor, { description: 'During review' })
    expect(jobDocuments.get(id)!.several!.table.rows[0]!.edited).toBeUndefined()
    expect(jobDocuments.canSave(editor)).toBe(false)
    jobDocuments.severalToTable(id)
    expect(jobDocuments.canEdit(editor)).toBe(true)
    expect(jobDocuments.openSeveralRow(id, 'r1')).toBe(editor)
    expect(jobDocuments.canSave(editor)).toBe(false)
    expect(jobDocuments.canReload(editor)).toBe(false)
    jobDocuments.updateDraft(editor, { description: 'Payroll' })
    jobDocuments.updateStep(editor, 's3', { retryAttempts: 4 })
    expect(documents.get(editor)?.dirty).toBe(false)
    const row = jobDocuments.get(id)!.several!.table.rows[0]!
    expect(row.edited).toMatchObject({ name: 'ETL – Load HR', description: 'Payroll' })
    expect(jobDocuments.severalRowName(id, 'r1')).toBe('ETL – Load HR')
    jobDocuments.backToTable(editor)
    await settled()
    expect(documents.get(editor)).toBeUndefined()
    expect(documents.getSnapshot().activeId).toBe(id)
    // A row removed while its editor is open leaves the editor a copy of its own, which can be saved.
    const again = jobDocuments.openSeveralRow(id, 'r1')!
    jobDocuments.addSeveralRow(id)
    jobDocuments.removeSeveralRow(id, 'r1')
    expect(jobDocuments.rowLinked(again)).toBe(false)
    expect(jobDocuments.canSave(again)).toBe(true)
  })
  it('refuses to close while the jobs are being created', async () => {
    const { jobDocuments, api } = opened()
    const id = jobDocuments.createLike('c1', 'ETL – Load warehouse')
    await settled()
    jobDocuments.createSeveral(id)
    jobDocuments.setSeveralCell(id, 'r1', 'name', 'A')
    jobDocuments.reviewSeveral(id)
    let release: (value: ApiResult<ActionExecuteResult>) => void = () => {}
    api.executeObjectAction.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const running = jobDocuments.createSeveralJobs(id)
    await settled()
    expect(jobDocuments.canClose(id)).toBe(createSeveralText.busy)
    release({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await running
    expect(jobDocuments.canClose(id)).toBeUndefined()
  })
})
