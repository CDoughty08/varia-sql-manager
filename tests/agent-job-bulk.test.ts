// @vitest-environment happy-dom
// Job Activity Monitor's bulk Change owner and Attach schedule (AG-3b): the request each sends for one job, which jobs get one, and the
// forms' flow through JobActivityService, with a refusal failing only its own job's line.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { actionExecuteRequestSchema } from '../src/shared/actions/schema'
import type { AgentScheduleRecord, AgentSchedulesModel } from '../src/shared/actions/agent-schedule'
import { agentBulkText, attachPlan, changeJobOwnerRequestSchema, ownerPlan, ownerUnavailable } from '../src/shared/agent/bulk'
import JobBulkForm from '../src/renderer/src/agent/JobBulkForms'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const nightly = '11111111-1111-1111-1111-111111111111'
const backup = '22222222-2222-2222-2222-222222222222'
const archive = '33333333-3333-3333-3333-333333333333'
const ids = { connectionId: '4c2d8b6e-1f3a-4e5b-9c7d-0a1b2c3d4e5f', requestId: '5d3e9c7f-2a4b-4f6c-8d9e-1b2c3d4e5f60' }
/** A job row's stored cells in the list's column order (name … created), with its owner. */
const row = (id: string, name: string, owner = 'sa') => [name, 'Yes', 'Idle', '', 'Succeeded', '2026-11-15 02:30:00', '', '', 'ETL', 'Yes', 'Yes', owner, id.toUpperCase(), '2026-01-02T03:04:05']

/** A LiveGrid stand-in whose selection is every row given. */
class FakeGrid extends SnapshotStore<LiveGridSnapshot> {
  select(rows: string[][]) {
    const columns = 13
    const handle = {
      getWindow: async (first: number, count: number) => {
        const slice = rows.slice(first, first + count)
        return { first, count: slice.length, colStart: 0, colEnd: columns, text: slice.flatMap(cells => cells.slice(0, columns)), flags: new Uint8Array(slice.length * columns) }
      }
    }
    this.publish({
      newRows: 0, following: true, lost: false, activeKey: rows[0]?.[12],
      selection: { entry: 'live', active: { row: 0, column: 0 }, blocks: [{ kind: 'rows', anchor: { row: 0, column: 0 }, focus: { row: rows.length - 1, column: 14 } }] },
      table: { handle, descriptor: { rowsAvailable: rows.length, columns: Array.from({ length: 15 }, () => ({})) } }
    } as unknown as LiveGridSnapshot)
  }
}

async function monitor(rows: string[][]) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const id = fixture.jobActivity.open('c1')
  const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
  fixture.jobActivity.attachGrid(id, grid as unknown as LiveGrid)
  grid.select(rows)
  await settled()
  return { ...fixture, id, grid }
}

const schedule = (patch: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord => ({
  id: 7, name: 'Nightly 02:30', enabled: true, freqType: 4, freqInterval: 1, freqSubdayType: 1, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: 99991231, activeStartTime: 23000, activeEndTime: 235959, jobCount: 1, owner: 'sa', version: 4, modified: '2026-11-01T02:00:00.000', ...patch
})
const schedulesModel = (patch: Partial<AgentSchedulesModel> = {}): AgentSchedulesModel => ({
  login: 'sa', sysadmin: true, platform: 'windows', now: '2026-11-22T14:30:00', schedules: [schedule(), schedule({ id: 8, name: 'Unread', version: undefined })],
  jobs: [{ id: nightly.toUpperCase(), name: 'Nightly', enabled: true, owner: 'sa', version: 3 }, { id: backup.toUpperCase(), name: 'Backup', enabled: true, owner: 'sa', version: 9 }],
  links: [{ scheduleId: 7, jobId: nightly.toUpperCase() }], ...patch
})

describe('Change owner and Attach schedule: shared rules', () => {
  it("takes Change owner's request with the job, its identity and a login of 1 to 128 characters, and nothing else", () => {
    const valid = { ...ids, action: 'changeJobOwner', target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { jobId: nightly }, jobOwner: 'CONTOSO\\agent' }
    expect(actionExecuteRequestSchema.safeParse(valid).success).toBe(true)
    expect(changeJobOwnerRequestSchema.safeParse({ ...valid, jobOwner: 'l'.repeat(128) }).success).toBe(true)
    for (const bad of [{ ...valid, jobOwner: '' }, { ...valid, jobOwner: 'l'.repeat(129) }, { ...valid, jobOwner: 'a\u0000b' }, { ...valid, agentIdentity: undefined },
      { ...valid, agentIdentity: { jobId: 'x' } }, { ...valid, target: { kind: 'agent' } }, { ...valid, newName: 'x' }, { ...valid, jobOwner: undefined }]) {
      expect(actionExecuteRequestSchema.safeParse(bad).success).toBe(false)
    }
  })
  it('skips a job the list already shows with that owner, ignoring case', () => {
    expect(ownerPlan({ owner: 'sa' }, 'sa')).toEqual({ state: 'done', message: agentBulkText.ownerSame('sa') })
    // A case-sensitive server can hold 'SA' and 'sa' as two logins: only an exact match skips.
    expect(ownerPlan({ owner: 'SA' }, 'sa')).toEqual({ send: 'sa' })
    expect(ownerPlan({ owner: 'sa' }, 'ops')).toEqual({ send: 'ops' })
    expect(ownerPlan({}, 'ops')).toEqual({ send: 'ops' })
    expect(ownerUnavailable({ sysadmin: false, owner: 'ops' })).toBe(agentBulkText.ownerSysadmin)
    expect(ownerUnavailable({ sysadmin: true, owner: '  ' })).toBe(agentBulkText.ownerEmpty)
    expect(ownerUnavailable({ sysadmin: true, owner: 'ops' })).toBeUndefined()
  })
  it("attaches with the schedule's guard and the job's version, skips a job already on it, and sends nothing without a version", () => {
    const model = schedulesModel()
    const plan = attachPlan(backup, schedule(), model.jobs, model.links)
    expect(plan).toEqual({ send: { op: 'update', schedule: { id: 7, version: 4, modified: '2026-11-01T02:00:00.000' }, jobs: [{ jobId: backup.toUpperCase(), version: 9, attach: true }] } })
    expect(actionExecuteRequestSchema.safeParse({ ...ids, action: 'agentSchedule', target: { kind: 'agent' }, agentSchedule: 'send' in plan ? plan.send : undefined }).success).toBe(true)
    expect(attachPlan(nightly, schedule(), model.jobs, model.links)).toEqual({ state: 'done', message: agentBulkText.scheduleAlready })
    expect(attachPlan(archive, schedule(), model.jobs, model.links)).toEqual({ state: 'failed', message: agentBulkText.jobUnread })
    expect(attachPlan(backup, schedule({ version: undefined }), model.jobs, model.links)).toEqual({ state: 'failed', message: agentBulkText.scheduleUnguarded })
    // Below sysadmin there are no links: a job already on the schedule is sent, and msdb leaves it as it is.
    expect(attachPlan(nightly, schedule(), model.jobs, undefined)).toMatchObject({ send: { jobs: [{ jobId: nightly.toUpperCase(), version: 3, attach: true }] } })
  })
})

describe('Job Activity Monitor: Change owner', () => {
  it("reads the logins, then sends one changeJobOwner per job; a refusal fails only its line and a job already owned sends nothing", async () => {
    const { jobActivity, api, id, commands } = await monitor([row(nightly, 'Nightly'), row(backup, 'Backup', 'ops'), row(archive, 'Archive')])
    api.describeObject.mockImplementation(async () => ({ ok: true, value: { elapsedMs: 1, agentJobDocument: { login: 'sa', sysadmin: true, owners: ['sa', 'ops', 'etl'] } } }) as never)
    await commands.execute('agent.changeJobOwner', { tabId: id }, 'api')
    expect(api.describeObject).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1', dialog: 'agentJob', target: { kind: 'agent' } }))
    expect(jobActivity.get(id)?.form).toMatchObject({ verb: 'changeOwner', state: 'ready', sysadmin: true, owners: ['sa', 'ops', 'etl'], jobs: [{ name: 'Nightly' }, { name: 'Backup' }, { name: 'Archive' }] })
    expect(jobActivity.formUnavailable(id)).toBe(agentBulkText.ownerEmpty)
    jobActivity.setFormOwner(id, ' ops ')
    expect(jobActivity.formUnavailable(id)).toBeUndefined()
    api.executeObjectAction.mockImplementation(async request => request.target.name === 'Nightly'
      ? { ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Only a member of the sysadmin role can change the owner.', retryable: false } } } as never
      : { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    const focus = vi.fn()
    Object.assign((jobActivity as unknown as { options: object }).options, { focus })
    await jobActivity.submitForm(id)
    expect(jobActivity.get(id)?.form).toBeUndefined()
    expect(focus).toHaveBeenCalledWith(id)
    const sent = api.executeObjectAction.mock.calls.map(([request]) => request)
    expect(sent).toEqual([
      { action: 'changeJobOwner', connectionId: 'c1', requestId: expect.any(String), target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { jobId: nightly }, jobOwner: 'ops' },
      { action: 'changeJobOwner', connectionId: 'c1', requestId: expect.any(String), target: { kind: 'agentJob', name: 'Archive' }, agentIdentity: { jobId: archive }, jobOwner: 'ops' }
    ])
    expect(new Set(sent.map(request => (request as { requestId: string }).requestId)).size).toBe(2)
    expect(jobActivity.get(id)?.bulk).toEqual({ verb: 'changeOwner', running: false, stopping: false, lines: [
      { id: nightly, name: 'Nightly', state: 'failed', message: 'Only a member of the sysadmin role can change the owner.' },
      { id: backup, name: 'Backup', state: 'done', message: agentBulkText.ownerSame('ops') },
      { id: archive, name: 'Archive', state: 'done', message: agentBulkText.ownerDone('ops') }
    ] })
  })
  it('offers no Change below sysadmin, and sends nothing', async () => {
    const { jobActivity, api, id } = await monitor([row(nightly, 'Nightly')])
    api.describeObject.mockImplementation(async () => ({ ok: true, value: { elapsedMs: 1, agentJobDocument: { login: 'u', sysadmin: false } } }) as never)
    await jobActivity.openForm(id, 'changeOwner')
    jobActivity.setFormOwner(id, 'sa')
    expect(jobActivity.formUnavailable(id)).toBe(agentBulkText.ownerSysadmin)
    await jobActivity.submitForm(id)
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(jobActivity.get(id)?.form).toMatchObject({ verb: 'changeOwner' })
  })
  it("says why when the read fails, and drops a read for a form closed meanwhile", async () => {
    const { jobActivity, api, id } = await monitor([row(nightly, 'Nightly')])
    api.describeObject.mockImplementationOnce(async () => ({ ok: false, error: 'The backend stopped.', code: 'BACKEND_LOST' }) as never)
    await jobActivity.openForm(id, 'changeOwner')
    expect(jobActivity.get(id)?.form).toMatchObject({ state: 'failed', error: 'The backend stopped.' })
    expect(jobActivity.formUnavailable(id)).toBe('The backend stopped.')
    let answer!: () => void
    api.describeObject.mockImplementationOnce(() => new Promise(resolve => { answer = () => resolve({ ok: true, value: { elapsedMs: 1, agentJobDocument: { login: 'sa', sysadmin: true } } } as never) }))
    const opening = jobActivity.openForm(id, 'changeOwner')
    await settled()
    jobActivity.closeForm(id)
    answer()
    await opening
    expect(jobActivity.get(id)?.form).toBeUndefined()
  })
})

describe('Job Activity Monitor: Attach schedule', () => {
  it("reads the shared schedules, then attaches the picked one with one guarded save per job; each job's result is its own", async () => {
    const { jobActivity, api, id, commands } = await monitor([row(nightly, 'Nightly'), row(backup, 'Backup'), row(archive, 'Archive')])
    api.describeObject.mockImplementation(async () => ({ ok: true, value: { elapsedMs: 1, agentSchedules: schedulesModel({ jobs: [...schedulesModel().jobs!, { id: archive, name: 'Archive', enabled: true, owner: 'sa', version: 1 }] }) } }) as never)
    await commands.execute('agent.attachJobSchedule', { tabId: id }, 'api')
    expect(api.describeObject).toHaveBeenLastCalledWith(expect.objectContaining({ dialog: 'agentSchedules', target: { kind: 'agent' } }))
    expect(jobActivity.formUnavailable(id)).toBe(agentBulkText.scheduleNone)
    jobActivity.pickFormSchedule(id, 8)
    expect(jobActivity.formUnavailable(id)).toBe(agentBulkText.scheduleUnguarded)
    jobActivity.setFormSearch(id, 'night')
    jobActivity.pickFormSchedule(id, 7)
    expect(jobActivity.formUnavailable(id)).toBeUndefined()
    api.executeObjectAction.mockImplementation(async request => (request as unknown as { agentSchedule: { jobs: { jobId: string }[] } }).agentSchedule.jobs[0].jobId === backup.toUpperCase()
      ? { ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Someone changed this job after it was read.', retryable: false } } } as never
      : { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await jobActivity.submitForm(id)
    const sent = api.executeObjectAction.mock.calls.map(([request]) => request)
    expect(sent).toEqual([backup.toUpperCase(), archive].map((jobId, at) => ({ action: 'agentSchedule', connectionId: 'c1', requestId: expect.any(String), target: { kind: 'agent' },
      agentSchedule: { op: 'update', schedule: { id: 7, version: 4, modified: '2026-11-01T02:00:00.000' }, jobs: [{ jobId, version: [9, 1][at], attach: true }] } })))
    expect(jobActivity.get(id)?.bulk?.lines.map(line => [line.name, line.state, line.message])).toEqual([
      ['Nightly', 'done', agentBulkText.scheduleAlready], ['Backup', 'failed', 'Someone changed this job after it was read.'], ['Archive', 'done', agentBulkText.scheduleDone('Nightly 02:30')]
    ])
  })
  it('Cancel closes the form, and no form opens without a selection', async () => {
    const { jobActivity, api, id, grid } = await monitor([row(nightly, 'Nightly')])
    api.describeObject.mockImplementation(async () => ({ ok: true, value: { elapsedMs: 1, agentSchedules: schedulesModel() } }) as never)
    await jobActivity.openForm(id, 'attachSchedule')
    expect(jobActivity.get(id)?.form?.verb).toBe('attachSchedule')
    jobActivity.closeForm(id)
    expect(jobActivity.get(id)?.form).toBeUndefined()
    grid.select([])
    await settled()
    await jobActivity.openForm(id, 'attachSchedule')
    expect(jobActivity.get(id)?.form).toBeUndefined()
  })
})

describe('JobBulkForms UI (AP-3)', () => {
  it('renders Change owner and Attach schedule in 160px PropertyField rows and closes on Escape', async () => {
    const fixture = await monitor([row(nightly, 'Nightly'), row(backup, 'Backup')])
    const { jobActivity, api, id } = fixture
    api.describeObject.mockImplementation(async () => ({ ok: true, value: { elapsedMs: 1, agentJobDocument: { login: 'sa', sysadmin: true, owners: ['sa', 'ops'] } } }) as never)
    await jobActivity.openForm(id, 'changeOwner')

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const renderForm = async () => {
      await act(async () => { root.render(createElement(JobBulkForm, { id, service: jobActivity, form: jobActivity.get(id)?.form })) })
    }
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    await renderForm()

    const ownerField = host.querySelector('.agent-bulk-form .property-field')!
    expect(ownerField).not.toBeNull()
    expect(ownerField.querySelector('.property-field-label label')?.textContent).toBe('New owner')
    expect(ownerField.querySelector('.property-field-note')?.textContent).toContain(agentBulkText.ownerHint)
    const ownerInput = ownerField.querySelector<HTMLInputElement>('input')!
    await act(async () => { ownerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(jobActivity.get(id)?.form).toBeUndefined()

    api.describeObject.mockImplementation(async () => ({ ok: true, value: { elapsedMs: 1, agentSchedules: schedulesModel() } }) as never)
    await jobActivity.openForm(id, 'attachSchedule')
    await renderForm()
    const scheduleField = host.querySelector('.agent-bulk-form .property-field')!
    expect(scheduleField.querySelector('.property-field-label label')?.textContent).toBe('Shared schedule')
    const pickBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-schedule-item')).find(btn => btn.textContent?.includes('Nightly 02:30'))!
    await act(async () => { pickBtn.click() })
    await renderForm()
    expect(host.querySelector('.agent-schedule-preview')?.textContent).toContain('Next 5 runs')
    await act(async () => { host.querySelector('.agent-bulk-form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(jobActivity.get(id)?.form).toBeUndefined()
  })
})
