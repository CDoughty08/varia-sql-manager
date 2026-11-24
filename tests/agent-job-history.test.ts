import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJobDocumentModel } from '../src/shared/actions/agent-job'
import { uncategorizedCategory } from '../src/shared/actions/agent-job'
import { agentLimits } from '../src/shared/agent/catalog'
import { agentHistoryArgsSchema } from '../src/shared/agent/history'
import {
  durationSeconds, durationText, durationWords, elapsedSeconds, failedStep, invokedBy, jobHistoryArgs, lastStepOf, runningSteps, runProgress, runSummary, sparkSamples, sparkStepMs, ssisExecutionId,
  ssisExecutionQuery, type JobHistoryRun, type JobHistoryStep
} from '../src/shared/agent/job-history'
import { liveProbes } from '../src/shared/live/catalog'
import { jobLive } from '../src/renderer/src/agent/JobDocumentService'
import { JobHistoryService, jobHistoryText } from '../src/renderer/src/agent/JobHistoryService'
import type { LiveTable } from '../src/renderer/src/live/LiveService'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import { fakeLive, type FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const job = '11111111-1111-1111-1111-111111111111'
const run = (instance: number, patch: Partial<JobHistoryRun> = {}): JobHistoryRun =>
  ({ key: { job, instance }, started: `2026-11-${String(instance).padStart(2, '0')} 02:30:00`, outcome: 'Succeeded', seconds: 60, duration: '00:01:00', message: 'The job succeeded.', tone: 'success', ...patch })
const step = (instance: number, stepId: number, patch: Partial<JobHistoryStep> = {}): JobHistoryStep =>
  ({ instance, stepId, name: `Step ${stepId}`, outcome: 'Succeeded', started: '2026-11-15 02:30:00', seconds: 10, duration: '00:00:10', retries: 0, message: 'ok', tone: 'success', ...patch })

describe("the job document's History rules", () => {
  it('asks agent.history for one job with its usual durations, which main and the backend both refuse for several jobs', () => {
    expect(jobHistoryArgs(job.toUpperCase())).toEqual({ jobs: [job], usual: true })
    expect(jobHistoryArgs(job, { failedOnly: true, run: { job: job.toUpperCase(), instance: 7 } })).toEqual({ jobs: [job], usual: true, outcome: 'failed', run: { job, instance: 7 } })
    expect(agentHistoryArgsSchema.safeParse(jobHistoryArgs(job)).success).toBe(true)
    for (const refused of [{ usual: true }, { jobs: [], usual: true }, { jobs: [job, '22222222-2222-2222-2222-222222222222'], usual: true }, { jobs: [job], usual: false }])
      expect(agentHistoryArgsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false)
    const usual = liveProbes['agent.history.list'].tables![3]
    expect(usual.id).toBe('usual')
    expect(usual.columns.map(column => column.id)).toEqual(['usualStep', 'usualSeconds', 'usualRuns'])
  })
  it('reads durations as SSMS writes them and says the usual time in words', () => {
    expect(durationSeconds('00:18:42')).toBe(1122)
    expect(durationSeconds('123:00:01')).toBe(442801)
    for (const text of ['', '1:00:00', '00:60:00', 'x', undefined]) expect(durationSeconds(text), String(text)).toBeUndefined()
    expect(durationText(1122)).toBe('00:18:42')
    expect(durationText(442801)).toBe('123:00:01')
    expect([durationWords(42), durationWords(1080), durationWords(3600), durationWords(3900)]).toEqual(['42 s', '18 min', '1 h', '1 h 5 min'])
  })
  it("reads who invoked a run and its last step from msdb's outcome message, and the SSIS execution a step's message names", () => {
    const message = 'The job failed.  The Job was invoked by Schedule 4 (Nightly 02:30).  The last step to run was step 3 (Merge facts).'
    expect(invokedBy(message)).toBe('Schedule 4 (Nightly 02:30)')
    expect(invokedBy('The job succeeded.  The Job was invoked by User CONTOSO\\dana.  The last step to run was step 1 (a.b).')).toBe('User CONTOSO\\dana')
    expect(invokedBy('ok')).toBeUndefined()
    expect(lastStepOf(message)).toEqual({ id: 3, name: 'Merge facts' })
    expect(runSummary(run(1, { outcome: 'Failed', tone: 'error', message }))).toBe('Failed at step 3')
    expect(runSummary(run(1))).toBe('Succeeded')
    const ssis = 'Executed as user: NT SERVICE\\SQLSERVERAGENT. Package execution on IS Server failed. Execution ID: 48213, Execution Status:4.  To view the details…'
    expect(ssisExecutionId(ssis)).toBe(48213)
    expect(ssisExecutionId('Execution ID: 0')).toBeUndefined()
    expect(ssisExecutionId('The step succeeded.')).toBeUndefined()
    const query = ssisExecutionQuery(48213)
    expect(query).toContain('FROM SSISDB.catalog.event_messages')
    expect(query).toContain('WHERE operation_id = 48213')
    expect(() => ssisExecutionQuery(1.5)).toThrow()
  })
  it('samples the newest finished runs oldest first for ChartView, evenly spaced, with the usual time as a second series (AG-10)', () => {
    const runs = [run(5, { tone: 'running', outcome: 'In progress', seconds: undefined, duration: '' }), run(4, { seconds: 120, tone: 'error' }), run(3, { seconds: 60 }), run(2, { seconds: undefined })]
    const { samples, top, label } = sparkSamples(runs, 90)
    expect(samples).toEqual([{ time: 0, values: [60, 90] }, { time: sparkStepMs, values: [120, 90] }])
    expect(top).toBe(120)
    expect(label).toBe(`Durations of the last 2 runs, 1 failed; usual ${durationWords(90)}`)
    expect(sparkSamples(runs).samples.map(sample => sample.values)).toEqual([[60, null], [120, null]])
    expect(sparkSamples(Array.from({ length: 30 }, (_, at) => run(at + 1))).samples).toHaveLength(14)
    expect(sparkSamples([])).toEqual({ samples: [], top: 1, label: '' })
  })
  it("opens a run's detail on its last failed step", () => {
    expect(failedStep([step(1, 0, { tone: 'error' }), step(2, 1, { tone: 'error' }), step(3, 2, { tone: 'error' }), step(4, 3)])?.instance).toBe(3)
    expect(failedStep([step(1, 0, { tone: 'error' }), step(2, 1)])).toBeUndefined()
  })
  it("lists each step's state while the job runs: done as its rows say, the current one executing, the rest waiting", () => {
    const steps = [{ id: 1, name: 'Check' }, { id: 2, name: 'Rebuild' }, { id: 3, name: 'Stats' }]
    const rows = [step(10, 1, { seconds: 120 }), step(11, 1, { outcome: 'Retry', tone: 'warning', seconds: 10 })]
    expect(runningSteps(steps, rows, 2, false, { bySteps: { 1: 125, 2: 690 }, job: 960, runs: 10 })).toEqual([
      { id: 1, name: 'Check', state: 'retry', label: 'Retry', seconds: 130, usual: 125 },
      { id: 2, name: 'Rebuild', state: 'executing', label: 'Executing', usual: 690 },
      { id: 3, name: 'Stats', state: 'waiting', label: 'Waiting' }
    ])
    expect(runningSteps(steps, [], 1, true)[0]).toMatchObject({ state: 'retrying', label: 'Between retries' })
    // Without this run's rows (another run selected, or Failed on) only the current step is known: the rest are never called Waiting.
    expect(runningSteps(steps, [], 2, false, undefined, false).map(item => item.state)).toEqual(['unknown', 'executing', 'unknown'])
  })
  it('times this run from the server clock against the usual time, never a guess', () => {
    expect(elapsedSeconds(20261122140900, 20261122142104)).toBe(724)
    expect(elapsedSeconds(20261122235959, 20261123000001)).toBe(2)
    expect(elapsedSeconds(undefined, 20261122142104)).toBeUndefined()
    expect(elapsedSeconds(20261122142104, 20261122140900)).toBeUndefined()
    expect(runProgress(724, 960)).toEqual({ share: 724 / 960, text: '00:12:04 elapsed · usual 16 min' })
    expect(runProgress(1200, 960)).toMatchObject({ share: 1, text: expect.stringContaining('longer than usual') })
    expect(runProgress(undefined, 960).share).toBeUndefined()
    expect(runProgress(30, undefined).text).toContain('no usual time')
  })
  it("keeps the run's start and the server's clock in the header's live state only while the job runs", () => {
    expect(jobLive({ status: 1, step: 2, steps: 4, started: 20261122140900 }, 20261122142104)).toEqual({ running: true, step: 2, steps: 4, retrying: false, started: 20261122140900, now: 20261122142104 })
    expect(jobLive({ status: 4, started: 20261122140900, lastOutcome: 1 }, 20261122142104)).toEqual({ running: false, lastOutcome: 1 })
    expect(jobLive({ status: 1 }, 20261122142104)).toEqual({ running: true, retrying: false })
  })
})

// --- The section's service against a fake live view ---------------------------------------------------------------------------

const model: AgentJobDocumentModel = {
  job: {
    jobId: job, name: 'Nightly load', enabled: true, description: '', category: uncategorizedCategory, owner: 'sa', emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0,
    netSendOperator: '', eventLogLevel: 0, deleteLevel: 0, created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, lastRun: '2026-11-20T02:00:00', lastOutcome: 0
  },
  login: 'sa', sysadmin: true, platform: 'windows', categories: [uncategorizedCategory], owners: ['sa'], steps: [{ id: 1, name: 'Extract', subsystem: 'TSQL' }, { id: 2, name: 'Load', subsystem: 'SSIS' }],
  alerts: [], alertsEditable: true, mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
}

/** A table of the probe as a LiveTable stand-in: rows of cell texts in the catalogue's column order. */
function table(index: number, rows: Record<string, string>[]): LiveTable {
  const columns = liveProbes['agent.history.list'].tables![index].columns.map(column => column.id)
  const cells = rows.map(row => columns.map(column => row[column] ?? ''))
  return {
    handle: { getWindow: async (first: number, count: number) => { const slice = cells.slice(first, first + count); return { first, count: slice.length, colStart: 0, colEnd: columns.length, text: slice.flat(), flags: new Uint8Array(slice.length * columns.length) } } },
    descriptor: { rowsAvailable: rows.length, columns: columns.map(() => ({})) }
  } as unknown as LiveTable
}
const runRow = (instance: number, patch: Record<string, string> = {}) => ({
  runDate: `2026-11-${String(instance).padStart(2, '0')} 02:30:00`, runJob: 'Nightly load', runOutcome: 'Succeeded', runDuration: '00:01:00', runSteps: '2',
  runMessage: 'The job succeeded.  The Job was invoked by Schedule 4 (Nightly).  The last step to run was step 2 (Load).', runKey: `${job}:${instance}`, runJobId: job, runTone: '', ...patch
})
const stepRow = (instance: number, stepId: number, patch: Record<string, string> = {}) => ({
  stepId: String(stepId), stepName: stepId ? ['', 'Extract', 'Load'][stepId] : '(Job outcome)', stepOutcome: 'Succeeded', stepStarted: '2026-11-20 02:30:00', stepDuration: '00:00:30',
  stepRetries: '0', stepMessage: 'ok', stepInstance: String(instance), stepJobId: job, stepTone: '', ...patch
})

function opened() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: model, elapsedMs: 1 } }))
  const history = () => (fixture.live.handles as FakeLiveHandle[]).find(handle => handle.spec.source === 'agent.history')
  const deliver = async (tables: Record<number, LiveTable>) => {
    const handle = history()!
    for (const [index, value] of Object.entries(tables)) handle.tables.set(`agent.history.list:${index}`, value)
    handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000, tables: [] as never }] })
    await settled()
  }
  return { ...fixture, history, deliver }
}

describe("the job document's History section", () => {
  it('opens its view when it first shows, follows the newest run, and opens its failed step with the whole message', async () => {
    const { jobDocuments, history, deliver, api } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    expect(history()).toBeUndefined()
    jobDocuments.history.attach(id, job)
    jobDocuments.history.attach(id, job)
    const view = history()!
    expect(view.spec).toMatchObject({ connectionId: 'c1', source: 'agent.history', args: { jobs: [job], usual: true } })
    expect(view.owner.visible()).toBe(true)
    jobDocuments.setFrame(id, { ...jobDocuments.get(id)!.frame, collapsed: ['history'] })
    expect(view.owner.visible()).toBe(false)
    const failedMessage = 'The job failed.  The Job was invoked by User sa.  The last step to run was step 2 (Load).'
    await deliver({
      0: table(0, [runRow(20, { runOutcome: 'Failed', runTone: 'error', runMessage: failedMessage }), runRow(19)]),
      1: table(1, []), 3: table(3, [{ usualStep: '0', usualSeconds: '60', usualRuns: '1' }, { usualStep: '2', usualSeconds: '30', usualRuns: '1' }])
    })
    let state = jobDocuments.history.get(id)!
    expect(state).toMatchObject({ loaded: true, selected: { job, instance: 20 }, pinned: false, usual: { job: 60, bySteps: { 0: 60, 2: 30 }, runs: 1 } })
    expect(state.runs.map(item => [item.key.instance, item.seconds])).toEqual([[20, 60], [19, 60]])
    // The live table gives Succeeded no tone (as the backend sends it): the run still reads as a success.
    expect(state.runs.map(item => item.tone)).toEqual(['error', 'success'])
    expect(view.args.at(-1)).toEqual({ jobs: [job], usual: true, run: { job, instance: 20 } })
    expect(view.refreshes).toBe(1)
    // The run's rows: a cut message is read whole through agent.historyMessage.
    const cut = 'Executed as user: sa. Execution ID: 48213, Execution Status:4. ' + 'x'.repeat(agentLimits.gridMessageChars)
    api.agentHistoryMessage.mockResolvedValueOnce({ ok: true, value: { message: cut + ' The step failed.', elapsedMs: 1 } })
    await deliver({ 1: table(1, [stepRow(20, 0, { stepMessage: failedMessage, stepOutcome: 'Failed', stepTone: 'error' }), stepRow(18, 1), stepRow(19, 2, { stepOutcome: 'Failed', stepTone: 'error', stepMessage: cut.slice(0, agentLimits.gridMessageChars - 1) + '…' })]) })
    state = jobDocuments.history.get(id)!
    expect(state).toMatchObject({ stepsFor: `${job}:20`, step: 19, message: { instance: 19, state: 'ready', text: cut + ' The step failed.' } })
    expect(api.agentHistoryMessage).toHaveBeenCalledWith({ connectionId: 'c1', requestId: expect.any(String), jobId: job, instanceId: 19 })
    expect(jobDocuments.history.messageText(id)).toBe(cut + ' The step failed.')
    await jobDocuments.history.copyMessage(id)
    expect(api.writeClipboardText).toHaveBeenLastCalledWith(cut + ' The step failed.')
    expect(jobDocuments.history.get(id)?.notice).toBe(jobHistoryText.copied)
    // A message the grid holds whole is shown without a read.
    api.agentHistoryMessage.mockClear()
    jobDocuments.history.selectStep(id, 18)
    await settled()
    expect(api.agentHistoryMessage).not.toHaveBeenCalled()
    expect(jobDocuments.history.messageText(id)).toBe('ok')
  })
  it('keeps a picked run, sends the Failed filter, and opens an SSIS execution in a query window', async () => {
    const { jobDocuments, history, deliver, documents } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.history.attach(id, job)
    await deliver({ 0: table(0, [runRow(20), runRow(19)]), 1: table(1, [stepRow(20, 0)]), 3: table(3, []) })
    await deliver({ 1: table(1, [stepRow(20, 0)]) })
    expect(jobDocuments.history.get(id)?.stepsFor).toBe(`${job}:20`)
    jobDocuments.history.selectRun(id, { job, instance: 19 })
    // The newest run's rows go with the pick, so its outcome never shows under the picked run before that run's rows arrive.
    expect(jobDocuments.history.get(id)).toMatchObject({ steps: [], stepsFor: undefined })
    expect(history()!.args.at(-1)).toEqual({ jobs: [job], usual: true, run: { job, instance: 19 } })
    // A newer run arrives: the picked one stays selected; its rows from a sample taken before the pick are not taken as its own.
    await deliver({ 0: table(0, [runRow(21), runRow(20), runRow(19)]), 1: table(1, [stepRow(20, 0)]) })
    expect(jobDocuments.history.get(id)).toMatchObject({ selected: { instance: 19 }, pinned: true, steps: [] })
    await deliver({ 1: table(1, [stepRow(19, 0), stepRow(17, 1)]) })
    expect(jobDocuments.history.get(id)).toMatchObject({ stepsFor: `${job}:19`, step: undefined })
    expect(jobDocuments.history.get(id)?.steps.map(item => item.stepId)).toEqual([0, 1])
    jobDocuments.history.setFailedOnly(id, true)
    expect(history()!.args.at(-1)).toEqual({ jobs: [job], usual: true, outcome: 'failed', run: { job, instance: 19 } })
    // With Failed on, the sparkline keeps the runs read with no filter; the picked run gone from the list, the newest is selected.
    await deliver({ 0: table(0, [runRow(18, { runOutcome: 'Failed', runTone: 'error' })]) })
    expect(jobDocuments.history.get(id)).toMatchObject({ selected: { instance: 18 }, pinned: false })
    expect(jobDocuments.history.get(id)?.spark.map(item => item.key.instance)).toEqual([21, 20, 19])
    jobDocuments.history.openSsisExecution(id, 48213)
    expect(documents.active).toMatchObject({ connectionId: 'c1', name: 'SSIS execution 48213.sql', database: 'SSISDB' })
  })
  it('says why the history cannot be read, and closes its view with the document', async () => {
    const { jobDocuments, history, documents } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.history.attach(id, job)
    history()!.set({ status: 'ended', ended: { ended: 'failed', code: 'PERMISSION_DENIED', message: 'denied' } as never })
    expect(jobDocuments.history.ended(id)).toEqual({ code: 'PERMISSION_DENIED', message: jobHistoryText.denied })
    documents.close(id)
    await settled()
    expect(history()!.disposed).toBe(true)
    expect(jobDocuments.history.get(id)).toBeUndefined()
  })
})

describe("the job document's watched state and History", () => {
  it('redraws for the server clock alone only while History shows, and reads History again when a step or the run ends', async () => {
    const { jobDocuments, history, live } = opened()
    const id = jobDocuments.openJob('c1', 'Nightly load')
    await settled()
    jobDocuments.history.attach(id, job)
    const watched = (live.handles as FakeLiveHandle[]).find(handle => handle.spec.source === 'agent.jobs')!
    const tick = (status: number, step: number, now: number) => {
      const metrics = Array.from({ length: 19 }, () => 0)
      metrics.splice(0, 4, status, step, 2, 20261122140900)
      metrics[18] = now
      watched.deliver({ type: 'live.tick', seq: now, sampledAt: now, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 2000, metrics }] })
    }
    tick(1, 1, 20261122141000)
    expect(jobDocuments.get(id)?.live).toMatchObject({ running: true, step: 1, now: 20261122141000 })
    const refreshes = history()!.refreshes
    tick(1, 1, 20261122141002)
    expect(jobDocuments.get(id)?.live?.now).toBe(20261122141002)
    jobDocuments.setFrame(id, { ...jobDocuments.get(id)!.frame, collapsed: ['history'] })
    tick(1, 1, 20261122141004)
    expect(jobDocuments.get(id)?.live?.now).toBe(20261122141002)
    expect(history()!.refreshes).toBe(refreshes)
    // Hidden, a step change leaves History paused: it samples afresh when it shows again.
    tick(1, 2, 20261122141006)
    expect(jobDocuments.get(id)?.live).toMatchObject({ step: 2, now: 20261122141006 })
    expect(history()!.refreshes).toBe(refreshes)
    jobDocuments.setFrame(id, { ...jobDocuments.get(id)!.frame, collapsed: [] })
    tick(1, 3, 20261122141007)
    expect(history()!.refreshes).toBe(refreshes + 1)
    tick(4, 0, 20261122141008)
    expect(jobDocuments.get(id)?.live?.running).toBe(false)
    expect(history()!.refreshes).toBe(refreshes + 2)
  })
})

describe("the History section's service on its own", () => {
  function service() {
    const live = fakeLive(), listeners = new Set<() => void>()
    let connection: string | undefined
    const api = { agentHistoryMessage: vi.fn(), writeClipboardText: vi.fn(async () => ({ ok: true as const, value: undefined })) }
    const history = new JobHistoryService({
      api, live, connectionOf: () => connection, visible: () => true, newId: () => 'r1',
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
    })
    cleanups.push(() => history.dispose())
    const connect = (id: string | undefined) => { connection = id; for (const listener of [...listeners]) listener() }
    const deliver = async (tables: Record<number, LiveTable>) => {
      const handle = live.handles.at(-1)!
      for (const [index, value] of Object.entries(tables)) handle.tables.set(`agent.history.list:${index}`, value)
      handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000, tables: [] as never }] })
      await settled()
    }
    return { history, live, api, connect, deliver, listeners }
  }
  it('opens the view of a section first shown while disconnected once the connection is back, and forgets it when closed', () => {
    const { history, live, connect, listeners } = service()
    history.attach('d1', job)
    expect(live.handles).toHaveLength(0)
    connect('c1')
    expect(live.handles).toHaveLength(1)
    expect(live.handles[0].spec).toMatchObject({ connectionId: 'c1', args: { jobs: [job], usual: true } })
    connect('c1')
    expect(live.handles).toHaveLength(1)
    // A section closed before the connection came back opens nothing.
    connect(undefined)
    history.attach('d2', job)
    history.closed('d2')
    connect('c1')
    expect(live.handles).toHaveLength(1)
    history.dispose()
    expect(listeners.size).toBe(0)
  })
  it("drops the Copy notice with the run, and says a cut message is only its start when it cannot be read whole", async () => {
    const { history, connect, deliver, api } = service()
    connect('c1')
    history.attach('d1', job)
    await deliver({ 0: table(0, [runRow(20), runRow(19)]), 1: table(1, []), 3: table(3, []) })
    await deliver({ 1: table(1, [stepRow(20, 0), stepRow(18, 1, { stepTone: 'error', stepOutcome: 'Failed', stepMessage: 'boom' })]) })
    expect(history.get('d1')).toMatchObject({ step: 18, message: { state: 'ready', text: 'boom' } })
    await history.copyMessage('d1')
    expect(history.get('d1')?.notice).toBe(jobHistoryText.copied)
    history.selectRun('d1', { job, instance: 19 })
    expect(history.get('d1')?.notice).toBeUndefined()
    // Disconnected, a cut message is shown as its start and said to be so; nothing is asked of the backend.
    connect(undefined)
    const cut = 'y'.repeat(agentLimits.gridMessageChars - 1) + '…'
    await deliver({ 1: table(1, [stepRow(19, 0), stepRow(17, 2, { stepTone: 'error', stepOutcome: 'Failed', stepMessage: cut })]) })
    expect(history.get('d1')).toMatchObject({ step: 17, message: { instance: 17, state: 'failed' } })
    expect(history.messageText('d1')).toBe(cut)
    expect(api.agentHistoryMessage).not.toHaveBeenCalled()
  })
  it('reads no sample taken with the filter before as one taken with the new filter', async () => {
    const { history, connect, deliver } = service()
    connect('c1')
    history.attach('d1', job)
    const failed = (instance: number) => runRow(instance, { runOutcome: 'Failed', runTone: 'error' })
    await deliver({ 0: table(0, [runRow(21), failed(20), runRow(19)]), 1: table(1, []), 3: table(3, []) })
    history.setFailedOnly('d1', true)
    // A sample from before Failed (it lists runs that did not fail) is dropped; the next is the filtered one.
    await deliver({ 0: table(0, [runRow(21), failed(20), runRow(19)]) })
    expect(history.get('d1')?.runs.map(item => item.key.instance)).toEqual([21, 20, 19])
    await deliver({ 0: table(0, [failed(20)]) })
    expect(history.get('d1')?.runs.map(item => item.key.instance)).toEqual([20])
    expect(history.get('d1')?.spark.map(item => item.key.instance)).toEqual([21, 20, 19])
    // Back to All: a sample of failed runs only may be from before, so the sparkline keeps the unfiltered runs until a sample shows more.
    history.setFailedOnly('d1', false)
    await deliver({ 0: table(0, [failed(20)]) })
    expect(history.get('d1')?.spark.map(item => item.key.instance)).toEqual([21, 20, 19])
    await deliver({ 0: table(0, [runRow(22), runRow(21), failed(20), runRow(19)]) })
    expect(history.get('d1')?.spark.map(item => item.key.instance)).toEqual([22, 21, 20, 19])
  })
  it("asks for no new sample after an empty one, and drops a re-created job's old view while it waits for a connection", async () => {
    const { history, live, connect, deliver } = service()
    connect('c1')
    history.attach('d1', job)
    await deliver({ 0: table(0, []), 1: table(1, []), 3: table(3, []) })
    await deliver({ 0: table(0, []) })
    expect(live.handles[0].refreshes).toBe(0)
    expect(history.get('d1')).toMatchObject({ loaded: true, runs: [] })
    // Failed with no failed runs: one sample for the new filter, then none of its own.
    history.setFailedOnly('d1', true)
    await deliver({ 0: table(0, []) })
    await deliver({ 0: table(0, []) })
    expect(live.handles[0].refreshes).toBe(1)
    connect(undefined)
    const other = '22222222-2222-2222-2222-222222222222'
    history.attach('d1', other)
    expect(live.handles[0].disposed).toBe(true)
    expect(history.handle('d1')).toBeUndefined()
    expect(history.get('d1')).toMatchObject({ jobId: other, loaded: false, runs: [] })
    connect('c1')
    expect(live.handles).toHaveLength(2)
    expect(live.handles[1].spec.args).toEqual({ jobs: [other], usual: true })
  })
  it("says when a run has more rows than the section reads", async () => {
    const { history, connect, deliver } = service()
    connect('c1')
    history.attach('d1', job)
    await deliver({ 0: table(0, [runRow(500)]), 1: table(1, []), 3: table(3, []) })
    const many = [stepRow(500, 0), ...Array.from({ length: 250 }, (_, at) => stepRow(at + 1, 1, { stepOutcome: 'Retry', stepTone: 'warning' }))]
    await deliver({ 1: table(1, many) })
    expect(history.get('d1')).toMatchObject({ stepsFor: `${job}:500`, stepsCut: true })
    expect(history.get('d1')?.steps).toHaveLength(200)
    await deliver({ 1: table(1, many.slice(0, 3)) })
    expect(history.get('d1')?.stepsCut).toBe(false)
  })
  it('says a Copy is done only under the message it copied', async () => {
    const { history, connect, deliver, api } = service()
    connect('c1')
    history.attach('d1', job)
    await deliver({ 0: table(0, [runRow(20), runRow(19)]), 1: table(1, []), 3: table(3, []) })
    await deliver({ 1: table(1, [stepRow(20, 0), stepRow(18, 1, { stepTone: 'error', stepOutcome: 'Failed', stepMessage: 'boom' })]) })
    let finish!: () => void
    api.writeClipboardText.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true, value: undefined }) }))
    const copying = history.copyMessage('d1')
    history.selectRun('d1', { job, instance: 19 })
    finish()
    await copying
    expect(history.get('d1')?.notice).toBeUndefined()
  })
})
