import { afterEach, describe, expect, it } from 'vitest'
import {
  agentAlertChangeCount, agentAlertCommandEntries, agentAlertProblems, agentAlertSavable, agentAlertSave, agentAlertSaveSchema, agentRecommendedSchema, initialAgentAlertDraft,
  notificationChanges, notifyEmail, notifyPager, parseCondition, recommendedAlertStates, conditionOf, type AgentAlertDocumentModel, type AgentAlertRecord
} from '../src/shared/actions/agent-alert'
import {
  agentOperatorChangeCount, agentOperatorCommandEntries, agentOperatorProblems, agentOperatorSave, agentOperatorSaveSchema, initialAgentOperatorDraft, matrixChangeCount, matrixChanges,
  matrixProblems, notifyMatrix, operatorUses, withCell, type AgentOperatorDocumentModel, type AgentOperatorRecord, type AgentOperatorsModel
} from '../src/shared/actions/agent-operator'
import type { AgentJobOperator } from '../src/shared/actions/agent-job'
import { actionMenuState, dialogSpecs } from '../src/shared/actions/catalog'
import { actionExecuteRequestSchema, type ActionDescribeResult, type ActionExecuteResult, type ActionRequest, type DeleteTarget } from '../src/shared/actions/schema'
import { agentLimits } from '../src/shared/agent/catalog'
import { commandDescriptor } from '../src/shared/commands/catalog'
import type { ApiResult } from '../src/shared/contracts'
import { agentObjectText } from '../src/renderer/src/agent/AlertOperatorDocumentService'
import { gridStep, nextMethods } from '../src/renderer/src/agent/OperatorsDocument'
import { testBlocked, timeText, timeValue } from '../src/renderer/src/agent/OperatorDocument'
import { deleteObjectDefinition } from '../src/renderer/src/dialogs/definitions'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const always = { start: 0, end: 235959 }
const mail = { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
const jobOperator = (name: string, patch: Partial<AgentJobOperator> = {}): AgentJobOperator =>
  ({ name, enabled: true, email: true, pager: true, netSend: false, pagerDays: 127, weekday: always, saturday: always, sunday: always, ...patch })
const alertRecord = (patch: Partial<AgentAlertRecord> = {}): AgentAlertRecord => ({
  id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17, database: '', keyword: '', condition: '', wmiNamespace: '', wmiQuery: '',
  jobId: '', jobName: '', delay: 60, includeIn: notifyEmail, message: '', occurrences: 3, lastOccurred: '2026-11-20T02:00:00', ...patch
})
const alertModel = (patch: Partial<AgentAlertDocumentModel> = {}): AgentAlertDocumentModel => ({
  alert: alertRecord(), login: 'sa', sysadmin: true, platform: 'windows', operators: [jobOperator('DBA'), jobOperator('On-call', { email: false })],
  notifications: [{ operator: 'DBA', methods: notifyEmail }], jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load' }], databases: ['master', 'Sales'], mail, ...patch
})
const operatorRecord = (id: number, name: string, patch: Partial<AgentOperatorRecord> = {}): AgentOperatorRecord => ({
  id, name, enabled: true, email: `${name.toLowerCase()}@example.test`, pager: '', netSend: '', pagerDays: 127, weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 }, ...patch
})
const alertRows = [
  { id: 7, name: 'Severity 017', enabled: true, kind: 'event' as const, messageId: 0, severity: 17 },
  { id: 8, name: 'Error 823', enabled: true, kind: 'event' as const, messageId: 823, severity: 0 }
]
const operatorModel = (patch: Partial<AgentOperatorDocumentModel> = {}): AgentOperatorDocumentModel => ({
  operator: operatorRecord(9, 'DBA'), login: 'sa', sysadmin: true, platform: 'windows', alerts: alertRows, notifications: [{ alertId: 7, operatorId: 9, methods: notifyEmail }],
  jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', email: 'DBA', page: '', netSend: '' }], mail, ...patch
})
const gridModel = (patch: Partial<AgentOperatorsModel> = {}): AgentOperatorsModel => ({
  login: 'sa', sysadmin: true, platform: 'windows', operators: [operatorRecord(9, 'DBA'), operatorRecord(10, 'Backup')], alerts: alertRows,
  notifications: [{ alertId: 7, operatorId: 9, methods: notifyEmail }, { alertId: 8, operatorId: 10, methods: notifyEmail | notifyPager }],
  jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', email: 'DBA', page: '', netSend: '' }], mail, ...patch
})

describe("the alert document's shared rules", () => {
  it('opens New Alert on severity 17 with a job preset, and an existing alert as read', () => {
    expect(initialAgentAlertDraft({ notifications: [] }, { jobId: '11111111-1111-1111-1111-111111111111' })).toMatchObject({ name: '', kind: 'event', raiseOn: 'severity', severity: 17, jobId: '11111111-1111-1111-1111-111111111111', delay: 60 })
    expect(initialAgentAlertDraft(alertModel())).toMatchObject({ name: 'Severity 017', raiseOn: 'severity', severity: 17, notify: [{ operator: 'DBA', methods: notifyEmail }] })
    const condition = 'SQLServer:Databases|Log File(s) Used Size (KB)|_Total|>|1000'
    expect(parseCondition(condition)).toEqual({ object: 'SQLServer:Databases', counter: 'Log File(s) Used Size (KB)', instance: '_Total', comparator: '>', value: '1000' })
    expect(conditionOf(parseCondition(condition)!)).toBe(condition)
  })
  it('saves only what changed, a raise-on as error number and severity together, and counts each notification change', () => {
    const model = alertModel(), draft = initialAgentAlertDraft(model)
    expect(agentAlertSave(model, draft)).toBeUndefined()
    const changed = { ...draft, raiseOn: 'message' as const, messageId: '9002', notify: [{ operator: 'DBA', methods: notifyEmail | notifyPager }, { operator: 'Ops', methods: notifyEmail }], newOperators: [{ name: 'Ops', email: 'ops@example.test', pager: '' }] }
    expect(agentAlertSave(model, changed)).toEqual({
      messageId: 9002, severity: 0, newOperators: [{ name: 'Ops', email: 'ops@example.test' }],
      notifications: [{ name: 'DBA', methods: notifyEmail | notifyPager, change: 'update' }, { name: 'Ops', methods: notifyEmail, change: 'add' }]
    })
    // when (1) + two notification changes + one new operator
    expect(agentAlertChangeCount(draft, changed)).toBe(4)
    expect(notificationChanges([{ name: 'A', methods: 1 }], [])).toEqual([{ name: 'A', methods: 0, change: 'delete' }])
  })
  it('sends New Alert whole, named and with its raise-on', () => {
    const model = alertModel({ alert: undefined, notifications: [] })
    const save = agentAlertSave(model, { ...initialAgentAlertDraft(model), name: ' Sev 19 ', severity: 19, notify: [{ operator: 'DBA', methods: notifyEmail }] })!
    expect(save).toMatchObject({ name: 'Sev 19', enabled: true, messageId: 0, severity: 19, delay: 60, includeIn: notifyEmail, notifications: [{ name: 'DBA', methods: notifyEmail, change: 'add' }] })
    expect(save).not.toHaveProperty('resetCount')
    expect(agentAlertSaveSchema.safeParse(save).success).toBe(true)
  })
  it('bounds the save in zod as C# does', () => {
    expect(agentAlertSaveSchema.safeParse({ message: 'm'.repeat(agentLimits.alertMessageChars) }).success).toBe(true)
    expect(agentAlertSaveSchema.safeParse({ message: 'm'.repeat(agentLimits.alertMessageChars + 1) }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ keyword: 'k'.repeat(agentLimits.alertKeywordChars + 1) }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ condition: 'not a condition' }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ delay: agentLimits.alertDelaySeconds + 1 }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ severity: 26 }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ notifications: [] }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ newOperators: Array.from({ length: agentLimits.newOperators + 1 }, (_, at) => ({ name: `o${at}` })) }).success).toBe(false)
    expect(agentAlertSaveSchema.safeParse({ enabled: true, other: 1 }).success).toBe(false)
  })
  it('warns about notifications that reach no one, and only a missing or invalid value blocks Save', () => {
    const model = alertModel(), draft = initialAgentAlertDraft(model)
    const warned = agentAlertProblems(model, { ...draft, notify: [{ operator: 'On-call', methods: notifyEmail }] })
    expect(warned).toEqual([{ field: 'notify', severity: 'warning', message: 'On-call has no e-mail address.' }])
    expect(agentAlertSavable(warned)).toBe(true)
    expect(agentAlertSavable(agentAlertProblems(model, { ...draft, raiseOn: 'message', messageId: 'abc' }))).toBe(false)
    expect(agentAlertSavable(agentAlertProblems(model, { ...draft, kind: 'performance', object: 'SQLServer:Databases', counter: '', value: '' }))).toBe(false)
    expect(agentAlertProblems(model, { ...draft, notify: [], jobId: '' }).map(problem => problem.message)).toContain('This alert runs no job and notifies no one, so it only counts occurrences.')
    expect(agentAlertProblems(model, { ...draft, newOperators: [{ name: 'DBA', email: '', pager: '' }], notify: [{ operator: 'DBA', methods: notifyEmail }] }).some(problem => problem.severity === 'error')).toBe(true)
  })
  it('marks which recommended alerts the server already has, by name or by what they raise on', () => {
    const states = recommendedAlertStates([{ name: 'My sev 19', messageId: 0, severity: 19 }, { name: 'Error 824 - Logical consistency I/O error', messageId: 0, severity: 10 }])
    expect(states.filter(state => state.exists).map(state => state.name)).toEqual(['Severity 019 - Fatal error in resource', 'Error 824 - Logical consistency I/O error'])
    expect(states).toHaveLength(11)
    expect(agentRecommendedSchema.safeParse({ alerts: [{ name: 'x', messageId: 0, severity: 19 }], methods: 0, delay: 60 }).success).toBe(true)
    expect(agentRecommendedSchema.safeParse({ alerts: [{ name: 'x', messageId: 0, severity: 19 }], operator: 'DBA', methods: 0, delay: 60 }).success).toBe(false)
    expect(agentRecommendedSchema.safeParse({ alerts: [{ name: 'x', messageId: 823, severity: 19 }], methods: 0, delay: 60 }).success).toBe(false)
    expect(agentRecommendedSchema.safeParse({ alerts: [{ name: 'x', messageId: 0, severity: 19 }, { name: 'x', messageId: 0, severity: 20 }], methods: 0, delay: 60 }).success).toBe(false)
  })
})

describe("the operator document's and grid's shared rules", () => {
  it('counts spaces around a name as no rename, since msdb would refuse renaming to the name it has', () => {
    const alert = initialAgentAlertDraft(alertModel())
    expect(agentAlertChangeCount(alert, { ...alert, name: `${alert.name} ` })).toBe(0)
    const operator = initialAgentOperatorDraft(operatorModel())
    expect(agentOperatorChangeCount(operator, { ...operator, name: ` ${operator.name}` })).toBe(0)
  })
  it('blocks a save with more notification changes than one request carries', () => {
    const operators = Array.from({ length: agentLimits.notificationChanges + 1 }, (_, index) => operatorRecord(100 + index, `Op ${index}`))
    const model = gridModel({ operators, notifications: [] })
    const draft = operators.reduce((matrix, operator) => withCell(matrix, 'Severity 017', operator.name, notifyEmail), notifyMatrix(model))
    expect(matrixProblems(model, draft)).toEqual([{ severity: 'error', message: expect.stringContaining('Severity 017') }])
    expect(matrixProblems(model, withCell(notifyMatrix(model), 'Severity 017', 'Op 0', notifyEmail))).toEqual([])
    const alert = alertModel({ operators: operators.map(operator => jobOperator(operator.name)) })
    const many = { ...initialAgentAlertDraft(alert), notify: operators.map(operator => ({ operator: operator.name, methods: notifyEmail })) }
    expect(agentAlertProblems(alert, many).some(problem => problem.field === 'notify' && problem.severity === 'error')).toBe(true)
  })
  it('opens New Operator with SSMS defaults and saves only what changed', () => {
    expect(initialAgentOperatorDraft({ notifications: [] })).toMatchObject({ name: '', enabled: true, pagerDays: 127, weekday: { start: 80000, end: 180000 } })
    const model = operatorModel(), draft = initialAgentOperatorDraft(model)
    expect(draft.notify).toEqual([{ alert: 'Severity 017', methods: notifyEmail }])
    expect(agentOperatorSave(model, draft)).toBeUndefined()
    const changed = { ...draft, email: 'dba@example.test;oncall@example.test', notify: [...draft.notify, { alert: 'Error 823', methods: notifyPager }] }
    expect(agentOperatorSave(model, changed)).toEqual({ email: 'dba@example.test;oncall@example.test', notifications: [{ name: 'Error 823', methods: notifyPager, change: 'add' }] })
    expect(agentOperatorChangeCount(draft, changed)).toBe(2)
    expect(agentOperatorSaveSchema.safeParse({ email: 'e'.repeat(agentLimits.addressChars + 1) }).success).toBe(false)
    expect(agentOperatorSaveSchema.safeParse({ weekdayStart: 240000 }).success).toBe(false)
  })
  it('warns about a page that cannot be sent', () => {
    const model = operatorModel(), draft = initialAgentOperatorDraft(model)
    expect(agentOperatorProblems(model, { ...draft, notify: [{ alert: 'Error 823', methods: notifyPager }] }).map(problem => problem.severity)).toContain('warning')
    expect(agentOperatorProblems(model, { ...draft, name: '' }).some(problem => problem.field === 'name' && problem.severity === 'error')).toBe(true)
  })
  it('turns the grid into one change list per alert, and counts who notifies an operator', () => {
    const model = gridModel(), base = notifyMatrix(model)
    expect(base.get('Severity 017')?.get('DBA')).toBe(notifyEmail)
    const draft = withCell(withCell(base, 'Severity 017', 'Backup', notifyEmail), 'Error 823', 'Backup', 0)
    expect(matrixChanges(model, base, draft)).toEqual([
      { alert: alertRows[0], changes: [{ name: 'Backup', methods: notifyEmail, change: 'add' }] },
      { alert: alertRows[1], changes: [{ name: 'Backup', methods: 0, change: 'delete' }] }
    ])
    expect(matrixChangeCount(model, base, draft)).toBe(2)
    expect(operatorUses(model, model.operators[0])).toEqual({ alerts: 1, jobs: 1 })
    expect([0, 1, 3, 2].map(nextMethods)).toEqual([1, 3, 2, 0])
    // Net send stays as it is: only the alert document changes it.
    expect([4, 5, 7, 6].map(nextMethods)).toEqual([5, 7, 6, 4])
    // One tab stop: the arrows move it within the grid and stop at its edges; Home and End go to a row's ends, with Ctrl to the corners.
    expect(gridStep('ArrowDown', false, { row: 0, column: 1 }, 3, 2)).toEqual({ row: 1, column: 1 })
    expect(gridStep('ArrowRight', false, { row: 0, column: 1 }, 3, 2)).toEqual({ row: 0, column: 1 })
    expect(gridStep('End', true, { row: 0, column: 0 }, 3, 2)).toEqual({ row: 2, column: 1 })
    expect(gridStep('Home', false, { row: 2, column: 1 }, 3, 2)).toEqual({ row: 2, column: 0 })
    expect(gridStep('a', false, { row: 0, column: 0 }, 3, 2)).toBeUndefined()
  })
  it('says why Send test e-mail is unavailable', () => {
    const model = operatorModel(), draft = initialAgentOperatorDraft(model)
    expect(testBlocked(model, draft, 0)).toBeUndefined()
    expect(testBlocked(operatorModel({ sysadmin: false }), draft, 0)).toContain('sysadmin')
    expect(testBlocked(operatorModel({ mail: { ...mail, agentProfile: undefined } }), draft, 0)).toContain('no Database Mail profile')
    expect(testBlocked(model, { ...draft, email: 'other@example.test' }, 1)).toContain('Save the operator first')
    expect(testBlocked(operatorModel({ operator: undefined }), draft, 0)).toContain('Save the operator first')
    expect(timeValue(timeText(83000))).toBe(83000)
  })
  it('keeps every command behind the release gate, and Properties on an alert or operator a document', () => {
    for (const [id, entry] of Object.entries({ ...agentAlertCommandEntries(), ...agentOperatorCommandEntries() })) expect(entry.precondition, id).toContain('agentEnabled')
    expect(commandDescriptor('agent.newAlertOnAgent').menus?.some(menu => menu.menu === 'explorer.new' && menu.when?.includes("agentRole == 'sysadmin'") && menu.when.includes('!explorerServerLinux'))).toBe(true)
    expect(commandDescriptor('agent.newOperatorOnAgent').menus?.some(menu => menu.menu === 'explorer.new')).toBe(true)
    expect(commandDescriptor('agent.newAlert').menus?.some(menu => menu.menu === 'explorer.context' && menu.when?.includes("explorerFolder == 'agentAlerts'"))).toBe(true)
    expect(actionMenuState({ kind: 'agentAlert' })).toMatchObject({ properties: 'enabled', rename: 'enabled', delete: 'enabled', disable: 'enabled' })
    expect(actionMenuState({ kind: 'agentOperator', status: 'disabled' })).toMatchObject({ enable: 'enabled' })
    expect(dialogSpecs.agentAlert).toMatchObject({ surface: 'document', action: 'agentAlert' })
    expect(dialogSpecs.agentOperator).toMatchObject({ surface: 'document', action: 'agentOperator' })
  })
  it('validates the AG-7 requests as the backend does', () => {
    const ids = { connectionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222' }
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'agentAlert', target: { kind: 'agentAlert', name: 'Severity 017' }, agentObjectId: 7, agentAlert: { enabled: false } }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'agentAlert', target: { kind: 'agentAlert', name: 'Severity 017' }, agentAlert: { enabled: false } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'agentOperator', target: { kind: 'agent' }, agentOperator: { name: 'Ops' } }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'notifyOperator', target: { kind: 'agentOperator', name: 'DBA' }, agentObjectId: 9 }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'delete', target: { kind: 'agentOperator', name: 'DBA' }, closeConnections: false, deleteHistory: false, agentObjectId: 9, reassignTo: 'Backup' }).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'delete', target: { kind: 'agentAlert', name: 'x' }, closeConnections: false, deleteHistory: false, agentObjectId: 7, reassignTo: 'Backup' }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'addRecommendedAlerts', target: { kind: 'agent' }, agentRecommended: { alerts: [{ name: 'x', messageId: 0, severity: 19 }], methods: 0, delay: 60 } }).success).toBe(true)
  })
  it("builds an operator's Delete with Reassign to only to an operator the dialog listed", () => {
    const model = { name: 'DBA', type: 'Operator', warnings: [], agentObjectId: 9, reassignChoices: ['Backup'], notifiedBy: { alerts: 1, jobs: 1 } } as unknown as DeleteTarget
    const target = { kind: 'agentOperator' as const, name: 'DBA' }
    expect(deleteObjectDefinition.request(target, model, { deleteHistory: false, closeConnections: false, dropMappedUsers: false, reassignTo: 'Backup' }))
      .toEqual({ action: 'delete', target, closeConnections: false, deleteHistory: false, agentObjectId: 9, reassignTo: 'Backup' })
    expect(deleteObjectDefinition.request(target, model, { deleteHistory: false, closeConnections: false, dropMappedUsers: false, reassignTo: 'Gone' }))
      .toEqual({ action: 'delete', target, closeConnections: false, deleteHistory: false, agentObjectId: 9 })
  })
})

/** A workbench whose describe answers the AG-7 models. */
function opened() {
  const fixture = workbenchFixture({ agentPreview: true })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  let alert = alertModel(), operator = operatorModel(), grid = gridModel()
  const answers: ApiResult<ActionExecuteResult>[] = []
  fixture.api.describeObject.mockImplementation(async params => ({
    ok: true, value: (params.dialog === 'agentAlert' ? { agentAlertDocument: params.target.kind === 'agent' ? { ...alert, alert: undefined, notifications: [] } : alert, elapsedMs: 1 }
      : params.dialog === 'agentOperator' ? { agentOperatorDocument: params.target.kind === 'agent' ? { ...operator, operator: undefined, notifications: [] } : operator, elapsedMs: 1 }
        : params.dialog === 'agentOperators' ? { agentOperators: grid, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult
  }))
  fixture.api.executeObjectAction.mockImplementation(async () => answers.shift() ?? { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, executes, answers, setAlert: (next: AgentAlertDocumentModel) => { alert = next }, setOperator: (next: AgentOperatorDocumentModel) => { operator = next }, setGrid: (next: AgentOperatorsModel) => { grid = next } }
}

describe('the alert and operator documents', () => {
  it('opens one tab per alert, saves the changes with its id and reads it again', async () => {
    const { alertDocuments, documents, executes, setAlert } = opened()
    const id = alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
    expect(documents.active).toMatchObject({ id, kind: 'agentAlert', name: 'Alert Properties - Severity 017', connectionId: 'c1' })
    await settled()
    expect(alertDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0 })
    expect(alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })).toBe(id)
    alertDocuments.updateDraft(id, draft => ({ ...draft, enabled: false, delay: 300 }))
    expect(alertDocuments.get(id)?.changes).toBe(2)
    expect(documents.get(id)?.dirty).toBe(true)
    setAlert(alertModel({ alert: alertRecord({ enabled: false, delay: 300 }) }))
    expect(await alertDocuments.save(id)).toBe(true)
    expect(executes()).toEqual([{ action: 'agentAlert', target: { kind: 'agentAlert', name: 'Severity 017' }, agentObjectId: 7, agentAlert: { enabled: false, delay: 300 }, connectionId: 'c1', requestId: expect.any(String) }])
    expect(alertDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 0, notice: agentObjectText.saved('alert'), model: { alert: { enabled: false } } })
    expect(documents.get(id)?.dirty).toBe(false)
  })
  it('creates New Alert for a job on the SQL Server Agent node and becomes its document', async () => {
    const { alertDocuments, documents, executes } = opened()
    const id = alertDocuments.openNew('c1', { jobId: '11111111-1111-1111-1111-111111111111', jobName: 'Nightly load' })
    await settled()
    expect(documents.get(id)).toMatchObject({ name: 'New Alert', dirty: false })
    expect(alertDocuments.canSave(id)).toBe(false)
    alertDocuments.updateDraft(id, draft => ({ ...draft, name: 'Sev 19', severity: 19 }))
    expect(await alertDocuments.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({ action: 'agentAlert', target: { kind: 'agent' }, agentAlert: { name: 'Sev 19', severity: 19, jobId: '11111111-1111-1111-1111-111111111111' } })
    expect(executes()[0]).not.toHaveProperty('agentObjectId')
    expect(documents.get(id)?.name).toBe('Alert Properties - Sev 19')
    expect(alertDocuments.get(id)).toMatchObject({ target: { kind: 'agentAlert', name: 'Sev 19' }, notice: agentObjectText.created('alert') })
  })
  it('offers no second Save when the saved object cannot be read again', async () => {
    const { alertDocuments, api, executes } = opened()
    const id = alertDocuments.openNew('c1')
    await settled()
    alertDocuments.updateDraft(id, draft => ({ ...draft, name: 'Sev 19', severity: 19 }))
    api.describeObject.mockResolvedValueOnce({ ok: false, code: 'SQL_ERROR', error: 'read failed' } as never)
    expect(await alertDocuments.save(id)).toBe(true)
    expect(alertDocuments.get(id)).toMatchObject({ unread: true, error: { message: expect.stringContaining(agentObjectText.savedUnread('alert')) } })
    expect(alertDocuments.canSave(id)).toBe(false)
    // Edits wait for Reload too, so nothing already saved is counted or sent again.
    alertDocuments.updateDraft(id, draft => ({ ...draft, delay: 30 }))
    expect(alertDocuments.get(id)).toMatchObject({ changes: 0, draft: { delay: 60 } })
    expect(await alertDocuments.save(id)).toBe(false)
    expect(alertDocuments.get(id)?.error?.message).toBe(agentObjectText.reloadFirst('alert'))
    expect(executes()).toHaveLength(1)
    alertDocuments.reload(id)
    await settled()
    expect(alertDocuments.get(id)).toMatchObject({ phase: 'ready', unread: false })
  })
  it('reads an operator named with spaces around it again by its verbatim name', async () => {
    const { operatorDocuments, api, setOperator } = opened()
    setOperator(operatorModel({ operator: { ...operatorModel().operator!, name: ' ops' } }))
    const id = operatorDocuments.open('c1', { kind: 'agentOperator', name: ' ops' })
    await settled()
    operatorDocuments.updateDraft(id, draft => ({ ...draft, pager: 'p@example.test' }))
    expect(await operatorDocuments.save(id)).toBe(true)
    expect(api.describeObject.mock.calls.at(-1)?.[0].target).toEqual({ kind: 'agentOperator', name: ' ops' })
  })
  it('never sends a save again after the connection closed during it', async () => {
    const fixture = opened()
    const { alertDocuments, executes, api } = fixture
    const id = alertDocuments.openNew('c1')
    await settled()
    alertDocuments.updateDraft(id, draft => ({ ...draft, name: 'Sev 19', severity: 19 }))
    api.executeObjectAction.mockImplementationOnce(async () => { fixture.connections.remove('c1'); return { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } } })
    expect(await alertDocuments.save(id)).toBe(false)
    expect(alertDocuments.get(id)).toMatchObject({ unread: true, error: { code: 'CONNECTION_LOST' } })
    fixture.connect(connectionInfo('c1'))
    expect(alertDocuments.canSave(id)).toBe(false)
    expect(await alertDocuments.save(id)).toBe(false)
    expect(executes()).toHaveLength(1)
  })
  it('keeps the draft and shows the refusal when Save is refused', async () => {
    const { alertDocuments, answers } = opened()
    const id = alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
    await settled()
    alertDocuments.updateDraft(id, draft => ({ ...draft, message: 'Call the DBA' }))
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'denied', retryable: false } } })
    expect(await alertDocuments.save(id)).toBe(false)
    expect(alertDocuments.get(id)).toMatchObject({ phase: 'ready', changes: 1, error: { code: 'PERMISSION_DENIED' }, draft: { message: 'Call the DBA' } })
  })
  it('does not edit a read-only alert', async () => {
    const { alertDocuments, setAlert } = opened()
    setAlert(alertModel({ readOnly: 'Read-only.' }))
    const id = alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
    await settled()
    alertDocuments.updateDraft(id, draft => ({ ...draft, enabled: false }))
    expect(alertDocuments.get(id)?.changes).toBe(0)
    expect(alertDocuments.canSave(id)).toBe(false)
  })
  it("reads the counter's current values on demand", async () => {
    const { alertDocuments, api } = opened()
    api.agentCounterValues.mockResolvedValue({ ok: true, value: { values: [{ instance: '_Total', value: 512 }], readAt: '2026-11-22T10:00:00', elapsedMs: 1 } })
    const id = alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
    await settled()
    await alertDocuments.readCounter(id, 'SQLServer:Databases', 'Log File(s) Used Size (KB)')
    expect(api.agentCounterValues).toHaveBeenCalledWith({ connectionId: 'c1', requestId: expect.any(String), object: 'SQLServer:Databases', counter: 'Log File(s) Used Size (KB)' })
    expect(alertDocuments.get(id)?.counters).toMatchObject({ loading: false, result: { values: [{ instance: '_Total', value: 512 }] } })
  })
  it('saves an operator and sends a test e-mail through its id', async () => {
    const { operatorDocuments, executes } = opened()
    const id = operatorDocuments.open('c1', { kind: 'agentOperator', name: 'DBA' })
    await settled()
    operatorDocuments.updateDraft(id, draft => ({ ...draft, pager: 'dba-pager@example.test' }))
    expect(await operatorDocuments.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({ action: 'agentOperator', target: { kind: 'agentOperator', name: 'DBA' }, agentObjectId: 9, agentOperator: { pager: 'dba-pager@example.test' } })
    expect(await operatorDocuments.sendTest(id, { id: 9, name: 'DBA' })).toBe(true)
    expect(executes()[1]).toEqual({ action: 'notifyOperator', target: { kind: 'agentOperator', name: 'DBA' }, agentObjectId: 9, connectionId: 'c1', requestId: expect.any(String) })
  })
})

describe('the Operators and notifications grid', () => {
  it('saves one change per changed alert, and says how many were saved before a refusal', async () => {
    const { operatorsDocuments, executes, answers } = opened()
    const id = operatorsDocuments.open('c1', { kind: 'agent' })
    await settled()
    expect(operatorsDocuments.open('c1', { kind: 'agent' })).toBe(id)
    operatorsDocuments.updateDraft(id, matrix => withCell(withCell(matrix, 'Severity 017', 'Backup', notifyEmail), 'Error 823', 'Backup', 0))
    expect(operatorsDocuments.get(id)?.changes).toBe(2)
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }, { ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'The alert was deleted.', retryable: false } } })
    expect(await operatorsDocuments.save(id)).toBe(false)
    expect(executes()).toEqual([
      { action: 'agentAlert', target: { kind: 'agentAlert', name: 'Severity 017' }, agentObjectId: 7, agentAlert: { notifications: [{ name: 'Backup', methods: notifyEmail, change: 'add' }] }, connectionId: 'c1', requestId: expect.any(String) },
      { action: 'agentAlert', target: { kind: 'agentAlert', name: 'Error 823' }, agentObjectId: 8, agentAlert: { notifications: [{ name: 'Backup', methods: 0, change: 'delete' }] }, connectionId: 'c1', requestId: expect.any(String) }
    ])
    expect(operatorsDocuments.get(id)?.error?.message).toBe(`The alert was deleted. ${agentObjectText.partly(1, 2)}`)
    // The committed alert's change leaves the count, so the next Save resends only the refused one.
    expect(operatorsDocuments.get(id)?.changes).toBe(1)
    expect(await operatorsDocuments.save(id)).toBe(true)
    expect(executes()[2]).toMatchObject({ target: { kind: 'agentAlert', name: 'Error 823' }, agentAlert: { notifications: [{ name: 'Backup', change: 'delete' }] } })
    expect(executes()).toHaveLength(3)
  })
  it('waits for unsaved cell changes before Delete operator and Add recommended alerts', async () => {
    const { operatorsDocuments, executes } = opened()
    const id = operatorsDocuments.open('c1', { kind: 'agent' })
    await settled()
    operatorsDocuments.updateDraft(id, matrix => withCell(matrix, 'Severity 017', 'Backup', notifyEmail))
    expect(await operatorsDocuments.deleteOperator(id, { id: 9, name: 'DBA' })).toBe(false)
    expect(operatorsDocuments.get(id)?.error?.message).toBe(agentObjectText.saveFirst)
    expect(executes()).toEqual([])
  })
  it('deletes an operator with Reassign to and adds recommended alerts, each reading the grid again', async () => {
    const { operatorsDocuments, executes, api } = opened()
    const id = operatorsDocuments.open('c1', { kind: 'agent' })
    await settled()
    const reads = api.describeObject.mock.calls.length
    expect(await operatorsDocuments.deleteOperator(id, { id: 9, name: 'DBA' }, 'Backup')).toBe(true)
    expect(executes()[0]).toEqual({ action: 'delete', target: { kind: 'agentOperator', name: 'DBA' }, closeConnections: false, deleteHistory: false, agentObjectId: 9, reassignTo: 'Backup', connectionId: 'c1', requestId: expect.any(String) })
    expect(api.describeObject.mock.calls.length).toBe(reads + 1)
    expect(operatorsDocuments.get(id)?.notice).toBe(agentObjectText.deleted('DBA'))
    const chosen = operatorsDocuments.recommended(id).filter(entry => !entry.exists).slice(0, 2).map(({ name, messageId, severity }) => ({ name, messageId, severity }))
    expect(operatorsDocuments.recommended(id).find(entry => entry.messageId === 823)?.exists).toBe(true)
    expect(await operatorsDocuments.addRecommended(id, { alerts: chosen, operator: 'Backup', methods: notifyEmail, delay: 300 })).toBe(true)
    expect(executes()[1]).toMatchObject({ action: 'addRecommendedAlerts', target: { kind: 'agent' }, agentRecommended: { alerts: chosen, operator: 'Backup', methods: notifyEmail, delay: 300 } })
    expect(operatorsDocuments.get(id)?.notice).toBe(agentObjectText.recommendedDone(2))
  })
  it("lists a server's alert and operator names for the palette", async () => {
    const { operatorsDocuments } = opened()
    expect(await operatorsDocuments.names('c1', 'agentAlert')).toEqual(['Severity 017', 'Error 823'])
    expect(await operatorsDocuments.names('c1', 'agentOperator')).toEqual(['DBA', 'Backup'])
  })
})
