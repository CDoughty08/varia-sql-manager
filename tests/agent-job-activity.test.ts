import { afterEach, describe, expect, it } from 'vitest'
import { agentLimits } from '../src/shared/agent/catalog'
import {
  agentAvailability, agentBanner, agentJobTiles, agentJobsArgsSchema, agentStatusOverride, bulkUnavailable, stampText, tileValue, watchedPhase, watchedSlot, watchedText,
  type WatchedJob
} from '../src/shared/agent/jobs'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { stampOf } from '../src/renderer/src/agent/AgentJobStatusService'
import { activeFilters, bulkLine, jobActivityArgs, jobActivityText, selectionRows } from '../src/renderer/src/agent/JobActivityService'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const nightly = '11111111-1111-1111-1111-111111111111'
const backup = '22222222-2222-2222-2222-222222222222'
/** A job row's stored cells in the list's column order (name … created): what the service reads back. */
const row = (id: string, name: string, status = 'Idle', lastRun = '2026-11-15 02:30:00') =>
  [name, 'Yes', status, '', 'Succeeded', lastRun, '', '', 'ETL', 'Yes', 'Yes', 'sa', id.toUpperCase(), '2026-01-02T03:04:05']

/** A LiveGrid stand-in whose selection is rows of jobs. */
class FakeGrid extends SnapshotStore<LiveGridSnapshot> {
  select(rows: string[][], blocks: { top: number; bottom: number }[] = [{ top: 0, bottom: rows.length - 1 }]) {
    const columns = 14
    const handle = {
      getWindow: async (first: number, count: number) => {
        const slice = rows.slice(first, first + count)
        return { first, count: slice.length, colStart: 0, colEnd: columns, text: slice.flat(), flags: new Uint8Array(slice.length * columns) }
      }
    }
    this.publish({
      newRows: 0, following: true, lost: false, activeKey: rows[0]?.[12],
      selection: { entry: 'live', active: { row: blocks[0]?.top ?? 0, column: 0 }, blocks: blocks.map(block => ({ kind: 'rows', anchor: { row: block.top, column: 0 }, focus: { row: block.bottom, column: 14 } })) },
      table: { handle, descriptor: { rowsAvailable: rows.length, columns: Array.from({ length: 15 }, () => ({})) } }
    } as unknown as LiveGridSnapshot)
  }
}

function monitor() {
  const fixture = workbenchFixture({ agentPreview: true })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const handles = () => fixture.live.handles as FakeLiveHandle[]
  return { ...fixture, handles, handle: () => handles().find(handle => handle.spec.probes.some(probe => probe.probe === 'agent.jobs.list'))! }
}

describe("agent.jobs' shared rules", () => {
  it('reads Agent\'s state from the service probe, with unknown where the login cannot read the service', () => {
    expect(agentAvailability(undefined)).toBe('pending')
    expect(agentAvailability({ agentXps: 1, serviceState: 4 })).toBe('running')
    expect(agentAvailability({ agentXps: 1 })).toBe('running')
    expect(agentAvailability({ agentXps: 0, serviceState: 1 })).toBe('stopped')
    expect(agentAvailability({ agentXps: 0, serviceState: 4 })).toBe('xpsOff')
    expect(agentAvailability({ agentXps: 0 })).toBe('unknown')
    expect(agentBanner('running', undefined, true, false)).toBeUndefined()
    expect(agentBanner('stopped', { agentXps: 0, serviceState: 1, startupType: 4 }, true, false)).toMatchObject({ start: false, text: expect.stringContaining('Disabled') })
    expect(agentBanner('xpsOff', undefined, false, true)?.text).toContain('mssql-conf')
    expect(agentStatusOverride('stopped')).toBe('Agent stopped')
    expect(agentStatusOverride('running')).toBeUndefined()
  })
  it('shows a live tile as 0 while Agent is stopped and unknown while its state cannot be read; history tiles keep their count', () => {
    const [running, failed] = agentJobTiles
    expect(tileValue(running, 3, 'running')).toBe(3)
    expect(tileValue(running, 3, 'stopped')).toBe(0)
    expect(tileValue(running, 3, 'unknown')).toBe('—')
    expect(tileValue(failed, 2, 'stopped')).toBe(2)
  })
  it('offers a bulk verb for one to agentLimits.startJobs jobs', () => {
    expect(bulkUnavailable(0)).toBe('Select one or more jobs.')
    expect(bulkUnavailable(1)).toBeUndefined()
    expect(bulkUnavailable(agentLimits.startJobs)).toBeUndefined()
    expect(bulkUnavailable(agentLimits.startJobs + 1)).toContain(String(agentLimits.startJobs))
  })
  it('takes args main and the backend both accept: an expanded job, distinct watched jobs and one filter per faceted column', () => {
    const schema = liveArgsSchemas['agent.jobs']
    expect(schema).toBe(agentJobsArgsSchema)
    expect(schema.safeParse({ expand: nightly, watch: [nightly, backup], filters: [{ column: 'status', values: ['Executing'] }] }).success).toBe(true)
    for (const refused of [{ expand: 'x' }, { watch: [] }, { watch: [nightly, nightly.toUpperCase()] }, { watch: [nightly, backup, nightly.replace('1', '3'), nightly.replace('1', '4')] },
      { filters: [{ column: 'owner', values: ['sa'] }] }, { filters: [{ column: 'status' }, { column: 'status' }] }, { other: 1 }]) expect(schema.safeParse(refused).success, JSON.stringify(refused)).toBe(false)
    expect(jobActivityArgs({ columnFilters: [] })).toEqual({})
    expect(jobActivityArgs({ expanded: { id: nightly, name: 'Nightly' }, columnFilters: [{ column: 'category', values: ['ETL'] }, { column: 'status' }] }))
      .toEqual({ expand: nightly, filters: [{ column: 'category', values: ['ETL'] }] })
    expect(activeFilters({ view: 'failed', text: ' x ', columnFilters: [{ column: 'status', values: ['Idle'] }] })).toBe(3)
  })
  it('follows a started job: Starting… until it runs or a newer run ends, then its outcome; unknown when it never shows', () => {
    const start: WatchedJob = { before: 20261115023000, idleSamples: 0, seenRunning: false }
    const idle = { status: 4, steps: 3, lastOutcome: 1, lastRun: 20261115023000 }
    let step = watchedPhase(start, idle, 'running')
    expect(step.phase).toEqual({ phase: 'starting' })
    step = watchedPhase(step.job, { status: 1, step: 2, steps: 3, started: 20261115140000, lastOutcome: 1, lastRun: 20261115023000 }, 'running')
    expect(step.phase).toEqual({ phase: 'running', step: 2, steps: 3, retrying: false })
    expect(watchedText('Nightly', step.phase)).toBe('Nightly: running step 2 of 3')
    step = watchedPhase(step.job, { ...idle, lastOutcome: 0, lastRun: 20261115140000 }, 'running')
    expect(step.phase).toEqual({ phase: 'ended', outcome: 0, lastRun: 20261115140000 })
    expect(watchedText('Nightly', step.phase, 20261115)).toBe('Nightly: Failed (started 14:00:00, server time)')
    // A job that never shows running and leaves no newer run gives up after watchStartSamples idle samples.
    let never = { phase: { phase: 'starting' } as ReturnType<typeof watchedPhase>['phase'], job: start }
    for (let sample = 0; sample < 4; sample++) never = watchedPhase(never.job, idle, 'running')
    expect(never.phase).toEqual({ phase: 'unknown', reason: 'gone' })
    expect(watchedPhase(start, idle, 'stopped').phase).toEqual({ phase: 'unknown', reason: 'agentStopped' })
    expect(watchedSlot([4, null, 3, null, 1, 20261115023000, null, null, null, null, null, null], 0)).toEqual({ status: 4, step: undefined, steps: 3, started: undefined, lastOutcome: 1, lastRun: 20261115023000 })
    expect(watchedSlot([4, null, 3, null, 1, 0, null, null, null, null, null, null], 1)).toBeUndefined()
    expect(stampText(20261114235959, 20261115)).toBe('2026-11-14 23:59:59')
    expect(stampOf('2026-11-15 02:30:00')).toBe(20261115023000)
    expect(stampOf('')).toBe(0)
  })
  it('words each bulk line by what the backend answered', () => {
    expect(bulkLine('startJob', { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })).toEqual({ state: 'done', message: 'Start requested' })
    expect(bulkLine('stopJob', { ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'JOB_STATE', message: 'Nightly is not running.', retryable: false } } } as never))
      .toEqual({ state: 'failed', message: 'Nightly is not running.' })
    expect(bulkLine('enable', { ok: false, error: 'gone', code: 'BACKEND_LOST' })).toEqual({ state: 'failed', message: jobActivityText.lost })
    expect(bulkLine('disable', undefined, new Error('boom'))).toEqual({ state: 'failed', message: 'boom' })
  })
  it('reads the selected rows from the grid\'s blocks and active row, at most the cap', () => {
    const selection = { entry: 'live', active: { row: 9, column: 0 }, blocks: [{ kind: 'rows' as const, anchor: { row: 2, column: 0 }, focus: { row: 4, column: 3 } }, { kind: 'cells' as const, anchor: { row: 7, column: 1 }, focus: { row: 7, column: 1 } }] }
    expect(selectionRows(selection, 20, 15, 100)).toEqual([2, 3, 4, 7, 9])
    expect(selectionRows(selection, 20, 15, 2)).toEqual([2, 3])
    expect(selectionRows({ entry: 'live', active: { row: 0, column: 0 }, blocks: [{ kind: 'all' }] } as never, agentLimits.startJobs * 3, 15, agentLimits.startJobs + 1)).toHaveLength(agentLimits.startJobs + 1)
  })
})

describe('Job Activity Monitor', () => {
  it('registers its commands only behind the release gate', () => {
    for (const agentPreview of [false, true]) {
      const fixture = workbenchFixture({ agentPreview })
      expect(['agent.jobActivity', 'agent.refreshJobs', 'agent.startJobs'].map(id => fixture.commands.has(id as never))).toEqual([agentPreview, agentPreview, agentPreview])
      fixture.dispose()
    }
  })
  it('opens one document per connection on the list and service probes, and sends view, filter box, column filters and the expanded job', async () => {
    const { jobActivity, documents, handle, live, context } = monitor()
    const id = jobActivity.open('c1')
    expect(documents.active).toMatchObject({ id, kind: 'agentJobActivity', name: 'Job Activity Monitor - c1.example', connectionId: 'c1', database: 'msdb' })
    expect(handle().spec).toEqual({ connectionId: 'c1', source: 'agent.jobs', args: {}, probes: [{ probe: 'agent.jobs.list', intervalMs: 5000 }, { probe: 'agent.jobs.service', intervalMs: 10_000 }] })
    expect(context.getState().activeDocumentIsJobActivity).toBe(true)
    expect(evaluateWhen(compileWhen(commandDescriptor('agent.refreshJobs').precondition!), context.getState())).toBe(true)
    documents.newQuery()
    expect(jobActivity.open('c1')).toBe(id)
    expect(live.open).toHaveBeenCalledTimes(1)
    jobActivity.setView(id, 'failed')
    jobActivity.setText(id, ' night ')
    expect(handle().probes).toEqual([{ probe: 'agent.jobs.list', patch: { view: 'failed' } }, { probe: 'agent.jobs.list', patch: { filter: { text: 'night' } } }])
    jobActivity.setColumnFilter(id, 'category', { values: ['ETL'] })
    jobActivity.toggleExpanded(id, { id: nightly.toUpperCase(), name: 'Nightly' })
    expect(handle().args).toEqual([{ filters: [{ column: 'category', values: ['ETL'] }] }, { expand: nightly, filters: [{ column: 'category', values: ['ETL'] }] }])
    // Between retries is a Status filter; pressed again it comes off. Running is the view chip.
    jobActivity.applyTile(id, agentJobTiles[2].applies)
    expect(jobActivity.tilePressed(id, agentJobTiles[2].applies)).toBe(true)
    jobActivity.applyTile(id, agentJobTiles[2].applies)
    expect(jobActivity.get(id)?.columnFilters).toEqual([{ column: 'category', values: ['ETL'] }])
    jobActivity.applyTile(id, agentJobTiles[0].applies)
    expect(jobActivity.get(id)?.view).toBe('running')
    jobActivity.clearFilters(id)
    expect(jobActivity.get(id)).toMatchObject({ view: 'all', text: '', columnFilters: [] })
    expect(handle().args.at(-1)).toEqual({ expand: nightly })
  })
  it('keeps the tiles\' counts, the facets and Agent\'s state, and restarts a list that stopped on AGENT_DISABLED once Agent runs', () => {
    const { jobActivity, handle } = monitor()
    const id = jobActivity.open('c1')
    handle().deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [
      { probe: 'agent.jobs.list', costMs: 1, effectiveIntervalMs: 5000, metrics: [2, 1, 0, 3], tables: [{ table: 0, descriptor: {} as never, revision: 1, facets: [{ column: 'status', values: [{ text: 'Idle', count: 4 }] }] }] },
      { probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 0 }, { id: 'serviceState', value: 1 }] }
    ] })
    expect(jobActivity.get(id)).toMatchObject({ counts: [2, 1, 0, 3], service: { agentXps: 0, serviceState: 1 }, facets: { status: { column: 'status' } } })
    expect(jobActivity.availability(id)).toBe('stopped')
    handle().set({ status: 'live', probes: { 'agent.jobs.list': { state: 'failing', intervalMs: 5000, effectiveIntervalMs: 5000, error: { probe: 'agent.jobs.list', code: 'AGENT_DISABLED', message: 'Agent XPs are off.' } } } } as never)
    handle().deliver({ type: 'live.tick', seq: 2, sampledAt: 2, samples: [{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 1 }, { id: 'serviceState', value: 4 }] }] })
    expect(jobActivity.availability(id)).toBe('running')
    expect(handle().refreshes).toBe(1)
  })
  it('says why when msdb refuses the login, in place of the rows', () => {
    const { jobActivity, handle } = monitor()
    const id = jobActivity.open('c1')
    handle().set({ status: 'ended', ended: { ended: 'failed', code: 'PERMISSION_DENIED', message: 'denied', ticks: 0, elapsedMs: 1 }, error: { code: 'PERMISSION_DENIED', message: 'denied' } } as never)
    expect(jobActivity.ended(id)).toEqual({ code: 'PERMISSION_DENIED', message: jobActivityText.denied, denied: true })
  })
  it('sends one verb per selected job, one after another, each its own line; a refusal fails only its line, and Start hands the job to the status bar', async () => {
    const { jobActivity, api, handle, agentJobs, commands } = monitor()
    const id = jobActivity.open('c1')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    jobActivity.attachGrid(id, grid as unknown as LiveGrid)
    grid.select([row(nightly, 'Nightly'), row(backup, 'Backup', 'Executing')])
    await settled()
    expect(jobActivity.get(id)?.selected.map(job => job.name)).toEqual(['Nightly', 'Backup'])
    api.executeObjectAction.mockImplementation(async request => request.target.name === 'Backup'
      ? { ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'JOB_STATE', message: 'Backup is already running.', retryable: false } } } as never
      : { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await commands.execute('agent.startJobs', { tabId: id }, 'api')
    expect(api.executeObjectAction.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ action: 'startJob', connectionId: 'c1', target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { created: '2026-01-02T03:04:05' } }),
      expect.objectContaining({ action: 'startJob', connectionId: 'c1', target: { kind: 'agentJob', name: 'Backup' } })
    ])
    expect(api.executeObjectAction.mock.calls[0][0]).not.toHaveProperty('stepName')
    expect(jobActivity.get(id)?.bulk).toEqual({ verb: 'startJob', running: false, stopping: false, lines: [
      { id: nightly, name: 'Nightly', state: 'done', message: 'Start requested' },
      { id: backup, name: 'Backup', state: 'failed', message: 'Backup is already running.' }
    ] })
    expect(handle().refreshes).toBe(1)
    expect(agentJobs.getSnapshot().jobs).toMatchObject([{ id: nightly, name: 'Nightly', job: { before: 20261115023000 }, phase: { phase: 'starting' } }])
    jobActivity.closeBulk(id)
    expect(jobActivity.get(id)?.bulk).toBeUndefined()
  })
  it('Stop sends no more after the job on its way; more than the cap selected offers no verb', async () => {
    const { jobActivity, api } = monitor()
    const id = jobActivity.open('c1')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    jobActivity.attachGrid(id, grid as unknown as LiveGrid)
    grid.select([row(nightly, 'Nightly'), row(backup, 'Backup')])
    await settled()
    let answer!: () => void
    api.executeObjectAction.mockImplementationOnce(() => new Promise(resolve => { answer = () => resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }) }))
    const run = jobActivity.runBulk(id, 'disable')
    await settled()
    expect(jobActivity.canBulk(id)).toBe(false)
    jobActivity.stopBulk(id)
    answer()
    await run
    expect(api.executeObjectAction).toHaveBeenCalledTimes(1)
    expect(jobActivity.get(id)?.bulk?.lines.map(line => [line.name, line.state])).toEqual([['Nightly', 'done'], ['Backup', 'skipped']])
    const many = Array.from({ length: agentLimits.startJobs + 1 }, (_, at) => row(`${String(at).padStart(8, '0')}-1111-1111-1111-111111111111`, `Job ${at}`))
    grid.select(many)
    await settled()
    expect(jobActivity.get(id)).toMatchObject({ overCap: true })
    expect(jobActivity.get(id)?.selected).toHaveLength(agentLimits.startJobs)
    expect(jobActivity.bulkUnavailable(id)).toContain(String(agentLimits.startJobs))
  })
})

describe("The status bar's running job", () => {
  it('follows a started job in a status-only view of the watched and service probes, to its outcome, then frees the slot', async () => {
    const { agentJobs, handles } = monitor()
    agentJobs.watch('c1', { id: nightly, name: 'Nightly', created: '2026-01-02T03:04:05', lastRun: '2026-11-15 02:30:00' })
    const view = handles().at(-1)!
    expect(view.spec).toMatchObject({ source: 'agent.jobs', args: { watch: [nightly] }, whileHidden: 'statusOnly', probes: [{ probe: 'agent.jobs.watched' }, { probe: 'agent.jobs.service' }] })
    const empty = Array.from({ length: 12 }, () => null)
    view.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 5000, metrics: [1, 2, 3, 20261115140000, 1, 20261115023000, ...empty] }] })
    expect(agentJobs.getSnapshot().jobs[0].phase).toEqual({ phase: 'running', step: 2, steps: 3, retrying: false })
    view.deliver({ type: 'live.tick', seq: 2, sampledAt: 2, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 5000, metrics: [4, null, 3, null, 1, 20261115140000, ...empty] }] })
    expect(agentJobs.getSnapshot().jobs[0].phase).toEqual({ phase: 'ended', outcome: 1, lastRun: 20261115140000 })
    await settled()
    // Nothing left to follow: the view ends.
    expect(view.disposed).toBe(true)
    agentJobs.dismiss(agentJobs.getSnapshot().jobs[0].key)
    expect(agentJobs.getSnapshot().jobs).toEqual([])
  })
  it('says the outcome is unknown when Agent stops mid-run, and Stop sends AG-2\'s Stop Job', async () => {
    const { agentJobs, handles, api } = monitor()
    agentJobs.watch('c1', { id: nightly, name: 'Nightly', created: '2026-01-02T03:04:05', lastRun: '' })
    const key = agentJobs.getSnapshot().jobs[0].key
    await agentJobs.stop(key)
    expect(api.executeObjectAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'stopJob', connectionId: 'c1', target: { kind: 'agentJob', name: 'Nightly' }, agentIdentity: { created: '2026-01-02T03:04:05' } }))
    handles().at(-1)!.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 0 }, { id: 'serviceState', value: 1 }] }] })
    expect(agentJobs.getSnapshot()).toMatchObject({ jobs: [{ phase: { phase: 'unknown', reason: 'agentStopped' } }], agent: { c1: 'stopped' } })
  })
})
