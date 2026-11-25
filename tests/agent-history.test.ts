import { afterEach, describe, expect, it } from 'vitest'
import { actionExecuteRequestSchema } from '../src/shared/actions/schema'
import { agentLimits } from '../src/shared/agent/catalog'
import {
  agentHistoryArgsSchema, agentHistoryDeleteSchema, agentHistoryMessageSchema, deleteHistoryUnavailable, historyActiveFilters, historyArgs, historyRunKeyText, logViewerCommandEntries, parseHistoryRunKey
} from '../src/shared/agent/history'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { methodPolicies } from '../src/shared/ipc/methods'
import { liveProbes } from '../src/shared/live/catalog'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { requestSchemas } from '../src/main/validation'
import type { LiveTable } from '../src/renderer/src/live/LiveService'
import { deleteOutcome, logViewerText } from '../src/renderer/src/agent/LogViewerService'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const nightly = '11111111-1111-1111-1111-111111111111'
const backup = '22222222-2222-2222-2222-222222222222'
const uuid = '33333333-3333-4333-8333-333333333333'

/** The source's jobs table (jobId, jobName, jobOwner, jobRunning, jobEnabled) as a LiveTable stand-in. */
function jobsTable(rows: string[][]): LiveTable {
  const columns = 5
  return {
    handle: { getWindow: async (first: number, count: number) => { const slice = rows.slice(first, first + count); return { first, count: slice.length, colStart: 0, colEnd: columns, text: slice.flat(), flags: new Uint8Array(slice.length * columns) } } },
    descriptor: { rowsAvailable: rows.length, columns: Array.from({ length: columns }, () => ({})) }
  } as unknown as LiveTable
}

function viewer() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const handles = () => fixture.live.handles as FakeLiveHandle[]
  const handle = () => handles().find(item => item.spec.source === 'agent.history')!
  const tick = (seq: number, status?: { id: string; value: number }[]) => handle().deliver({ type: 'live.tick', seq, sampledAt: seq, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000, ...status ? { status } : {} }] })
  return { ...fixture, handles, handle, tick }
}

describe("agent.history's shared rules", () => {
  it('takes args main and the backend both accept', () => {
    expect(liveArgsSchemas['agent.history']).toBe(agentHistoryArgsSchema)
    expect(agentHistoryArgsSchema.safeParse({ jobs: [nightly, backup], days: 7, outcome: 'failed', text: 'error', step: 2, run: { job: nightly, instance: 15 } }).success).toBe(true)
    expect(agentHistoryArgsSchema.safeParse({ jobs: [] }).success).toBe(true)
    for (const refused of [{ jobs: ['x'] }, { jobs: [nightly, nightly.toUpperCase()] }, { jobs: Array.from({ length: agentLimits.historyJobs + 1 }, (_, at) => `00000000-0000-0000-0000-${String(at).padStart(12, '0')}`) },
      { days: 0 }, { days: 3651 }, { outcome: 'xpsOff' }, { text: '' }, { text: 'x'.repeat(agentLimits.searchChars + 1) }, { step: -1 }, { step: 1001 }, { run: { job: nightly, instance: 0 } }, { other: 1 }])
      expect(agentHistoryArgsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false)
  })
  it('sends only the filters that apply, and counts the ones Clear filters resets', () => {
    expect(historyArgs({ text: '', days: 7 })).toEqual({ days: 7 })
    expect(historyArgs({ checked: [nightly.toUpperCase()], text: '  boom ', outcome: 'failed', step: 0, run: { job: nightly.toUpperCase(), instance: 4 } }))
      .toEqual({ jobs: [nightly], text: 'boom', outcome: 'failed', step: 0, run: { job: nightly, instance: 4 } })
    expect(historyArgs({ text: 'x'.repeat(500) }).text).toHaveLength(agentLimits.searchChars)
    expect(historyActiveFilters({ text: '', days: 7 })).toBe(0)
    expect(historyActiveFilters({ text: 'a', days: undefined, outcome: 'retry', step: 1 })).toBe(4)
  })
  it("reads a run's key back from the runs table's key column", () => {
    expect(historyRunKeyText({ job: nightly.toUpperCase(), instance: 12 })).toBe(`${nightly}:12`)
    expect(parseHistoryRunKey(`${nightly.toUpperCase()}:12`)).toEqual({ job: nightly, instance: 12 })
    for (const text of ['', 'x:1', `${nightly}:0`, `${nightly}:`, `${nightly}:99999999999`]) expect(parseHistoryRunKey(text), text).toBeUndefined()
    expect(liveProbes['agent.history.list'].tables![0].key).toEqual(['runKey'])
  })
  it("checks Delete History as the backend does, and adds it to actions.execute only", () => {
    expect(agentHistoryDeleteSchema.safeParse({ jobs: [nightly], all: true }).success).toBe(true)
    expect(agentHistoryDeleteSchema.safeParse({ jobs: [nightly, backup], olderThan: { count: 30, unit: 1 } }).success).toBe(true)
    for (const refused of [{ jobs: [], all: true }, { jobs: [nightly] }, { jobs: [nightly], all: true, olderThan: { count: 1, unit: 1 } }, { jobs: [nightly, nightly], all: true },
      { jobs: [nightly], olderThan: { count: 0, unit: 1 } }, { jobs: [nightly], olderThan: { count: 1, unit: 4 } }, { jobs: [nightly], olderThan: { count: agentLimits.purgeCount + 1, unit: 1 } },
      { jobs: [nightly], olderThan: { count: 1, unit: 1, before: '2026-11-15 02:30:00' } }])
      expect(agentHistoryDeleteSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false)
    const request = { action: 'deleteJobHistory', connectionId: uuid, requestId: uuid, target: { kind: 'agent' }, agentHistory: { jobs: [nightly], all: true } }
    expect(actionExecuteRequestSchema.safeParse(request).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...request, target: { kind: 'agent', name: 'x' } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...request, agentHistory: undefined }).success).toBe(false)
    expect(requestSchemas['actions.script'].safeParse(request).success).toBe(false)
  })
  it('registers agent.historyMessage in every place a backend method needs', () => {
    expect(requestSchemas['agent.historyMessage']).toBe(agentHistoryMessageSchema)
    expect(methodPolicies['agent.historyMessage']).toMatchObject({ kind: 'unary', lane: 'metadata' })
    expect(agentHistoryMessageSchema.safeParse({ connectionId: uuid, requestId: uuid, jobId: nightly, instanceId: 1 }).success).toBe(true)
    expect(agentHistoryMessageSchema.safeParse({ connectionId: uuid, requestId: uuid, jobId: nightly, instanceId: 0 }).success).toBe(false)
  })
  it('offers Delete History as msdb allows it', () => {
    const base = { checked: 1, live: true } as const
    expect(deleteHistoryUnavailable({ ...base, role: 'sysadmin' })).toBeUndefined()
    expect(deleteHistoryUnavailable({ ...base, role: 'operator' })).toBeUndefined()
    expect(deleteHistoryUnavailable({ ...base, role: 'user', purge: true })).toBeUndefined()
    expect(deleteHistoryUnavailable({ ...base, role: 'user' })).toContain('SQLAgentOperatorRole')
    expect(deleteHistoryUnavailable({ ...base, role: 'unknown' })).toContain('Reading')
    expect(deleteHistoryUnavailable({ ...base, role: 'sysadmin', checked: 0 })).toContain('Check')
    expect(deleteHistoryUnavailable({ ...base, role: 'sysadmin', checked: agentLimits.historyJobs + 1 })).toContain(String(agentLimits.historyJobs))
    expect(deleteHistoryUnavailable({ ...base, role: 'sysadmin', live: false })).toContain('Connect')
  })
  it("offers View History on the Agent node, the Jobs folder and a job, with no release gate (AG-9)", () => {
    const entries = logViewerCommandEntries()
    for (const id of ['agent.viewHistory', 'agent.refreshHistory', 'agent.deleteHistory'] as const) {
      expect(commandDescriptor(id).precondition).toBe(entries[id].precondition)
      expect(entries[id].precondition).not.toContain('agentEnabled')
    }
    const [placement] = commandDescriptor('agent.viewHistory').menus!
    const when = compileWhen(placement.when!)
    const on = (keys: Record<string, unknown>) => evaluateWhen(when, { explorerServerLost: false, ...keys } as never)
    expect(on({ explorerNode: 'agent' }) && on({ explorerNode: 'agentJob' }) && on({ explorerNode: 'folder', explorerFolder: 'agentJobs' })).toBe(true)
    expect(on({ explorerNode: 'folder', explorerFolder: 'agentAlerts' }) || on({ explorerNode: 'database' }) || on({ explorerNode: 'agent', explorerServerLost: true })).toBe(false)
  })
  it('reads a Delete History answer as its outcome line', () => {
    expect(deleteOutcome({ ok: true, value: { steps: [], messages: ['14226: 12 history entries purged.'], elapsedMs: 1 } }, 2)).toEqual({ ok: true, line: `${logViewerText.deleted(2)} 14226: 12 history entries purged.` })
    expect(deleteOutcome({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'No.', retryable: false } } }, 1)).toEqual({ ok: false, code: 'PERMISSION_DENIED', message: 'No.' })
    expect(deleteOutcome({ ok: false, code: 'BACKEND_LOST', error: 'gone' } as never, 1)).toEqual({ ok: false, code: 'BACKEND_LOST', message: logViewerText.lost })
    expect(deleteOutcome(undefined, 1)).toEqual({ ok: false, message: logViewerText.lost })
    // Only older rows: the line says so, rather than that all of their history went.
    expect(deleteOutcome({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }, 3, undefined, { count: 30, unit: 1 })).toEqual({ ok: true, line: 'Deleted the history older than 30 days of 3 jobs.' })
    expect(logViewerText.deletedOlder(1, 1, 3)).toBe('Deleted the history older than 1 month of 1 job.')
  })
})

describe('the Log File Viewer', () => {
  it('opens one viewer per connection with every job, the checked jobs or a job by name, and reads the role', async () => {
    const { logViewer, handle, api, documents } = viewer()
    api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } })
    const id = logViewer.open('c1')
    expect(documents.get(id)).toMatchObject({ kind: 'agentLogViewer' })
    expect(handle().spec).toMatchObject({ source: 'agent.history', args: { days: 7 } })
    await settled()
    expect(logViewer.role(id)).toBe('sysadmin')
    // The same server again shows the open viewer, with the jobs asked for.
    expect(logViewer.open('c1', { jobs: [backup.toUpperCase()] })).toBe(id)
    expect(handle().args.at(-1)).toEqual({ jobs: [backup], days: 7 })
    // A job's menu names it: nothing is read until the jobs list says its id.
    logViewer.open('c1', { jobName: 'Nightly' })
    expect(handle().args.at(-1)).toEqual({ jobs: [], days: 7 })
    handle().tables.set('agent.history.list:2', jobsTable([[backup.toUpperCase(), 'Backup', 'sa', 'Yes', 'Yes'], [nightly.toUpperCase(), 'Nightly', 'sa', 'No', 'Yes']]))
    handle().deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000, status: [{ id: 'historyMaxRows', value: 1000 }, { id: 'historyMaxRowsPerJob', value: 100 }] }] })
    await settled()
    expect(logViewer.get(id)).toMatchObject({ checked: [nightly], caps: { maxRows: 1000, perJob: 100 }, jobs: [{ id: backup, name: 'Backup', running: true }, { id: nightly, name: 'Nightly', running: false }] })
    expect(logViewer.get(id)).not.toHaveProperty('pendingJob')
    expect(handle().args.at(-1)).toEqual({ jobs: [nightly], days: 7 })
  })
  it('keeps how many checked jobs the history cap left unread, until a sample says none', async () => {
    const { logViewer, tick } = viewer()
    const id = logViewer.open('c1')
    tick(1, [{ id: 'historyMaxRows', value: 1000 }, { id: 'historySkippedJobs', value: 3 }])
    await settled()
    expect(logViewer.get(id)?.skipped).toBe(3)
    tick(2, [{ id: 'historyMaxRows', value: 1000 }])
    await settled()
    expect(logViewer.get(id)?.skipped).toBeUndefined()
  })
  it('checks no job when two share the name a job node names, and says so', async () => {
    const { logViewer, handle } = viewer()
    const id = logViewer.open('c1', { jobName: 'Backup' })
    handle().tables.set('agent.history.list:2', jobsTable([[backup.toUpperCase(), 'Backup', 'sa', 'No', 'Yes'], [uuid.toUpperCase(), 'Backup', 'sa', 'No', 'Yes']]))
    handle().deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000 }] })
    await settled()
    expect(logViewer.get(id)).toMatchObject({ checked: [], note: logViewerText.ambiguous('Backup') })
    expect(logViewer.get(id)).not.toHaveProperty('pendingJob')
  })
  it("forgets the old server's checked jobs and reads the role again when the viewer moves to another connection", async () => {
    const { logViewer, handle, api, documents, connect, tick } = viewer()
    connect(connectionInfo('c2'))
    api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } })
    const id = logViewer.open('c1', { jobs: [backup] })
    handle().tables.set('agent.history.list:2', jobsTable([[nightly, 'Nightly', 'sa', 'No', 'Yes'], [backup, 'Backup', 'sa', 'No', 'Yes']]))
    tick(1)
    await settled()
    expect(api.agentProfile).toHaveBeenCalledTimes(1)
    logViewer.askDelete(id)
    expect(logViewer.get(id)?.confirm).toBeDefined()
    documents.update(id, { connectionId: 'c2' })
    await settled()
    expect(logViewer.get(id)).toMatchObject({ connectionId: 'c2', jobs: [] })
    expect(logViewer.get(id)?.checked).toBeUndefined()
    // The confirmation listed the old connection's checked jobs: it closes rather than widen to All jobs.
    expect(logViewer.get(id)?.confirm).toBeUndefined()
    expect(handle().args.at(-1)).toEqual({ days: 7 })
    expect(api.agentProfile).toHaveBeenCalledTimes(2)
    expect(api.agentProfile.mock.calls.at(-1)?.[0]).toMatchObject({ connectionId: 'c2' })
  })
  it('checks jobs up to historyJobs, reads every job as All jobs, and refuses more', async () => {
    const { logViewer, handle, tick } = viewer()
    const id = logViewer.open('c1')
    const rows = Array.from({ length: agentLimits.historyJobs + 2 }, (_, at) => [`00000000-0000-0000-0000-${String(at).padStart(12, '0')}`, `Job ${at}`, 'sa', 'No', 'Yes'])
    handle().tables.set('agent.history.list:2', jobsTable(rows))
    tick(1)
    await settled()
    expect(logViewer.allChecked(id)).toBe(true)
    // Unchecking one of all would check more than historyJobs: refused, with a note.
    logViewer.toggleJob(id, rows[0][0])
    expect(logViewer.get(id)).toMatchObject({ note: logViewerText.tooMany })
    expect(logViewer.get(id)).not.toHaveProperty('checked')
    logViewer.toggleJob(id, undefined)
    expect(logViewer.allChecked(id)).toBe(false)
    expect(handle().args.at(-1)).toEqual({ jobs: [], days: 7 })
    logViewer.toggleJob(id, rows[1][0])
    expect(logViewer.allChecked(id)).toBe('mixed')
    expect(logViewer.isChecked(id, rows[1][0])).toBe(true)
    logViewer.setOutcome(id, 'failed')
    logViewer.setText(id, 'boom')
    logViewer.setStep(id, 3)
    logViewer.setDays(id, undefined)
    expect(handle().args.at(-1)).toEqual({ jobs: [rows[1][0]], outcome: 'failed', text: 'boom', step: 3 })
    expect(logViewer.activeFilters(id)).toBe(4)
    logViewer.clearFilters(id)
    expect(handle().args.at(-1)).toEqual({ jobs: [rows[1][0]], days: 7 })
  })
  it("reads a kept run's message again when the viewer gets a connection back", async () => {
    const { logViewer, api, documents, connect } = viewer()
    connect(connectionInfo('c2'))
    const id = logViewer.open('c1')
    const grid = { snapshot: { activeKey: `${nightly}:15` } as Record<string, unknown>, subscribe() { return () => {} }, getSnapshot() { return this.snapshot } }
    api.agentHistoryMessage.mockResolvedValue({ ok: true, value: { elapsedMs: 1, message: 'The job failed.' } })
    logViewer.attachRuns(id, grid as never)
    await settled()
    documents.update(id, { connectionId: undefined })
    await settled()
    const reads = api.agentHistoryMessage.mock.calls.length
    // Lost then given a new connection: the run stays, so its message is read again on the new one rather than left reading.
    documents.update(id, { connectionId: 'c2' })
    await settled()
    expect(logViewer.get(id)?.run).toEqual({ job: nightly, instance: 15 })
    expect(api.agentHistoryMessage.mock.calls.length).toBe(reads + 1)
    expect(api.agentHistoryMessage).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c2', jobId: nightly, instanceId: 15 }))
    expect(logViewer.get(id)?.message).toEqual({ key: `${nightly}:15`, state: 'ready', text: 'The job failed.' })
  })
  it('reads the selected row\'s whole message, and retries a failed read', async () => {
    const { logViewer, handle, api } = viewer()
    const id = logViewer.open('c1')
    const grid = { listeners: [] as (() => void)[], snapshot: { activeKey: `${nightly}:15` } as Record<string, unknown>, subscribe(listener: () => void) { this.listeners.push(listener); return () => {} }, getSnapshot() { return this.snapshot } }
    api.agentHistoryMessage.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'TIMEOUT', message: 'Timed out.', retryable: true } } })
    logViewer.attachRuns(id, grid as never)
    await settled()
    expect(handle().args.at(-1)).toEqual({ days: 7, run: { job: nightly, instance: 15 } })
    expect(api.agentHistoryMessage).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1', jobId: nightly, instanceId: 15 }))
    expect(logViewer.get(id)?.message).toEqual({ key: `${nightly}:15`, state: 'failed', text: 'Timed out.' })
    api.agentHistoryMessage.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, message: 'The job failed.' } })
    logViewer.retryMessage(id)
    await settled()
    expect(logViewer.get(id)?.message).toEqual({ key: `${nightly}:15`, state: 'ready', text: 'The job failed.' })
  })
  it('deletes the checked jobs\' history behind a confirmation, and keeps a refusal in it', async () => {
    const { logViewer, handle, api, commands, tick } = viewer()
    api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: false, msdbAccess: true, operatorRole: true, purgeHistory: true } as never } })
    const id = logViewer.open('c1', { jobs: [nightly] })
    handle().tables.set('agent.history.list:2', jobsTable([[nightly, 'Nightly', 'sa', 'No', 'Yes'], [backup, 'Backup', 'sa', 'No', 'Yes']]))
    tick(1)
    await settled()
    expect(logViewer.canDelete(id)).toBe(true)
    await commands.execute('agent.deleteHistory', { tabId: id }, 'api')
    expect(logViewer.get(id)?.confirm).toMatchObject({ scope: 'older', count: 30, unit: 1, running: false })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Refused.', retryable: false } } })
    logViewer.setConfirm(id, { scope: 'all' })
    await logViewer.confirmDelete(id)
    expect(api.executeObjectAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'deleteJobHistory', connectionId: 'c1', target: { kind: 'agent' }, agentHistory: { jobs: [nightly], all: true } }))
    expect(logViewer.get(id)?.confirm).toMatchObject({ running: false, error: { code: 'PERMISSION_DENIED', message: 'Refused.' } })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: ['3 history entries purged.'], elapsedMs: 1 } })
    logViewer.setConfirm(id, { scope: 'older', count: 2, unit: 2 })
    // A selected run whose message shows: after the delete its message is read again, not left reading.
    const grid = { snapshot: { activeKey: `${nightly}:15` } as Record<string, unknown>, subscribe() { return () => {} }, getSnapshot() { return this.snapshot } }
    api.agentHistoryMessage.mockResolvedValue({ ok: true, value: { elapsedMs: 1, message: 'The job failed.' } })
    logViewer.attachRuns(id, grid as never)
    await settled()
    const reads = api.agentHistoryMessage.mock.calls.length
    const refreshes = handle().refreshes
    await logViewer.confirmDelete(id)
    await settled()
    expect(api.agentHistoryMessage.mock.calls.length).toBe(reads + 1)
    expect(logViewer.get(id)?.message).toEqual({ key: `${nightly}:15`, state: 'ready', text: 'The job failed.' })
    expect(api.executeObjectAction).toHaveBeenLastCalledWith(expect.objectContaining({ agentHistory: { jobs: [nightly], olderThan: { count: 2, unit: 2 } } }))
    expect(logViewer.get(id)).not.toHaveProperty('confirm')
    expect(logViewer.get(id)?.deleted).toBe(`${logViewerText.deletedOlder(1, 2, 2)} 3 history entries purged.`)
    expect(handle().refreshes).toBe(refreshes + 1)
  })
  it('offers no Delete History to a login msdb lets read only', async () => {
    const { logViewer, api, commands } = viewer()
    api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: false, msdbAccess: true, readerRole: true, purgeHistory: false } as never } })
    const id = logViewer.open('c1')
    await settled()
    expect(logViewer.deleteUnavailable(id)).toBeDefined()
    await commands.execute('agent.deleteHistory', { tabId: id }, 'api')
    expect(logViewer.get(id)).not.toHaveProperty('confirm')
  })
})
