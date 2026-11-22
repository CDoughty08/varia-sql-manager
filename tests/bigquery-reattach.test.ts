import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { failedAbortsText, heldAfter, jobStillRunning, QueryService, restoredJobRunning, type QueryApi, type TabJob } from '../src/renderer/src/services/queries'
import type { ResultsService } from '../src/renderer/src/results/ResultsService'
import { deferred, documentFixture } from './fixtures/documents'
import { defaultSettings } from '../src/shared/settings/catalog'

const output = (patch: Partial<QueryResult> = {}): QueryResult => ({
  status: 'completed', resultSets: [], discardedResultSets: 0, messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'sales', messagesTruncated: false,
  budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-11-21T10:00:00.0000000+00:00', ...patch
})
const job = (jobId: string, patch: Partial<TabJob> = {}): TabJob => ({ jobId, project: 'example-project', location: 'US', state: 'running', transaction: 'none', createdAt: 1, ...patch })
type JobEvent = { type: 'query.job'; jobId: string; project: string; location?: string; state: 'running' | 'done'; auxiliary: boolean; transaction: 'none' | 'open' | 'unknown' }

/** A BigQuery tab on a live connection (`connected` false: a restored tab with none yet). */
function fixture({ connected = true }: { connected?: boolean } = {}) {
  const docs = documentFixture()
  const connection: ConnectionInfo & { lost?: true; providerId: string; options: object } = {
    id: 'bq-a', server: 'example-project', database: 'sales', serverVersion: 'BigQuery', commandTimeout: 0, generation: 1, providerId: 'bigquery', options: { provider: 'bigquery' }
  }
  const api = {
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: output() })),
    attach: vi.fn<VariaApi['attach']>(async () => ({ ok: true, value: output() })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    confirmSessions: vi.fn<VariaApi['confirmSessions']>(async () => ({ ok: true, value: 'cancel' })),
    querySessionState: vi.fn<VariaApi['querySessionState']>(async () => ({ ok: true, value: { transactionCount: 0, checked: true, job: 'none' } }))
  }
  let onJob: ((event: JobEvent) => void) | undefined
  const results = {
    begin: vi.fn<ResultsService['begin']>((_tab, _query, _session, o) => { onJob = o?.onJob as typeof onJob }),
    finish: vi.fn(), addMessage: vi.fn<ResultsService['addMessage']>()
  }
  let live = connected
  const queries = new QueryService(docs.documents, api, id => live && id === connection.id ? connection : undefined, docs.events, results, () => 5000, undefined, () => defaultSettings)
  const tab = docs.documents.create('orders.sql', 'SELECT 1', 'sales', connection.id)
  return { ...docs, queries, queryApi: api, connection, tab, results, job: (event: Omit<JobEvent, 'type' | 'auxiliary' | 'project' | 'transaction'> & Partial<JobEvent>) => onJob?.({ type: 'query.job', project: 'example-project', auxiliary: false, transaction: 'none', ...event }), connect: () => { live = true } }
}
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

describe('BigQuery job keys', () => {
  it("gives a BigQuery tab a job key at its first run, sends it with every run, and keeps it on the tab", async () => {
    const f = fixture()
    await f.queries.execute(f.tab.id)
    const key = f.documents.get(f.tab.id)?.jobKey
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(f.queryApi.execute.mock.calls[0][0]).toMatchObject({ jobKey: key })
    await f.queries.execute(f.tab.id)
    expect(f.queryApi.execute.mock.calls[1][0]).toMatchObject({ jobKey: key })
  })
  it('sends no job key for SQL Server', async () => {
    const f = fixture()
    Object.assign(f.connection, { providerId: 'sqlserver' })
    await f.queries.execute(f.tab.id)
    expect(f.queryApi.execute.mock.calls[0][0]).not.toHaveProperty('jobKey')
    expect(f.documents.get(f.tab.id)?.jobKey).toBeUndefined()
  })
})

describe('BigQuery job references', () => {
  it('keeps a running job when the backend is lost, says it carries on, and holds it for the prompt', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', location: 'US', state: 'running', transaction: 'open' })
    // Lost backend: the connection is gone until the next start or Reconnect.
    Object.assign(f.connection, { lost: true })
    pending.resolve({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await run
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toEqual([job('job_1', { transaction: 'open', createdAt: 5000 })])
    expect(f.results.addMessage).toHaveBeenCalledWith(f.tab.id, jobStillRunning(['job_1']), 'info')
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
  })
  it("drops a finished run's jobs once its summary reached the tab", async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: true, value: output() })
    await run
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
  })
  it('keeps a job left running as detached, and lets go of it once the backend sees it end', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', location: 'US', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run
    await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toEqual([job('job_1', { detached: true, createdAt: 5000 })])
    // This backend follows it already: no re-attach.
    expect(f.queryApi.attach).not.toHaveBeenCalled()
    f.queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 0, checked: false, job: 'running' } })
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
    // A failed read falls back to the tab's own reference.
    f.queryApi.querySessionState.mockResolvedValueOnce({ ok: false, error: 'No answer.', code: 'TIMEOUT' })
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
})

describe('re-attaching restored tabs', () => {
  it("re-attaches a connected tab's newest job, adopting its session with the record's transaction, and never an older one over its results", async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10' })
    f.queries.restoreJobs(f.tab.id, [job('job_done', { createdAt: 0, state: 'done' }), job('job_old', { createdAt: 1 }), job('job_new', { createdAt: 2, transaction: 'open' })])
    await settle(); await settle(); await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(1)
    expect(f.queryApi.attach.mock.calls[0][0]).toMatchObject({ connectionId: 'bq-a', sessionId: f.tab.id, jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10', jobId: 'job_new', project: 'example-project', location: 'US', adoptSession: true, transaction: 'open' })
    expect(f.queryApi.attach.mock.calls[0][0]).not.toHaveProperty('detached')
    // An attach releases the tab's results: the newest job's stay. The older finished job is dropped; the older running
    // one stays with the tab for its prompt, and is not tried again on this connection.
    expect(f.results.begin).toHaveBeenCalledTimes(1)
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toEqual([job('job_old', { createdAt: 1 })])
    f.queries.reattach()
    await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(1)
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
    expect(f.results.addMessage).not.toHaveBeenCalled()
  })
  it('says a restored running job carries on while the tab is not connected, then re-attaches once it is, once per connection', async () => {
    const f = fixture({ connected: false })
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    expect(f.results.addMessage).toHaveBeenCalledWith(f.tab.id, restoredJobRunning(['job_1']), 'info')
    expect(f.queryApi.attach).not.toHaveBeenCalled()
    f.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'Not connected.', code: 'NOT_CONNECTED' })
    f.connect()
    f.queries.reattach()
    await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(1)
    // The job is kept, but not tried again on the same connection.
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toEqual([job('job_1')])
    f.queries.reattach()
    await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(1)
    // The next connection (Reconnect) tries again.
    Object.assign(f.connection, { generation: 2 })
    f.queries.reattach()
    await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(2)
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
  it("drops a job another principal ran, and Stop on a re-attach cancels it like a query's", async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'This job was run by another account.', code: 'AUTH_IDENTITY' })
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    f.queryApi.attach.mockReturnValueOnce(pending.promise)
    f.queries.restoreJobs(f.tab.id, [job('job_2')])
    await settle()
    expect(f.queries.getSnapshot()[f.tab.id].running).toMatchObject({ kind: 'attach', jobId: 'job_2' })
    expect(f.queries.isRunning(f.tab.id)).toBe(true)
    await f.queries.cancel(f.tab.id)
    expect(f.queryApi.cancel).toHaveBeenCalledWith(f.queryApi.attach.mock.calls[1][0].queryId)
    pending.resolve({ ok: true, value: output({ status: 'cancelled' }) })
    await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
})

describe('heldAfter', () => {
  const running = job('a'), done = job('b', { state: 'done' }), detached = job('c', { detached: true })
  it('keeps what each ending leaves for a re-attach', () => {
    expect(heldAfter(undefined, [], [running, done], output({ status: 'detached' }), undefined)).toEqual([{ ...running, detached: true }])
    expect(heldAfter(undefined, [detached, running], [], output(), undefined)).toEqual([running])
    expect(heldAfter(running, [detached], [], output(), undefined)).toEqual([detached])
    expect(heldAfter(undefined, [], [running, done], undefined, 'BACKEND_LOST')).toEqual([running])
    expect(heldAfter(done, [], [], undefined, 'CONNECTION_LOST')).toEqual([done])
    expect(heldAfter(running, [detached], [], undefined, 'AUTH_IDENTITY')).toEqual([detached])
  })
})

describe('the job prompt', () => {
  it('asks a running BigQuery query only about its job, and plans Leave it running or Cancel the job without cancelling it here', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'leave' })
    const prepared = await f.queries.prepareSessions('exit', [f.tab.id])
    expect(f.queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'exit', tabs: [{ name: 'orders.sql', running: true, transactions: 0, provider: 'bigquery', job: { elapsedMs: 0, jobIds: ['job_1'] } }] })
    expect(prepared?.plan.get(f.tab.id)).toBe('leave')
    // The close's keepJob leaves the job; query.cancel is never sent for it.
    expect(prepared?.stopping).toEqual([])
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    expect((await f.queries.prepareSessions('close', [f.tab.id]))?.plan.get(f.tab.id)).toBe('cancelJob')
    pending.resolve({ ok: true, value: output() })
    await run
  })
  it('asks a tab holding a detached job while the backend still sees it running, never about its transaction', async () => {
    const f = fixture()
    // Left running on Close Results earlier (this backend follows it).
    const answer = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(answer.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_9', state: 'running' })
    answer.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 1, checked: true, job: 'running' } })
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'cancel' })
    expect(await f.queries.prepareSessions('changeConnection', [f.tab.id])).toBeUndefined()
    expect(f.queryApi.confirmSessions).toHaveBeenCalledExactlyOnceWith({ action: 'changeConnection', tabs: [{ name: 'orders.sql', running: false, transactions: 0, provider: 'bigquery', job: { elapsedMs: 0, detached: true, jobIds: ['job_9'] } }] })
    // Once the backend saw it end, the tab's transaction is asked about as usual.
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 1, checked: true, job: 'none' } })
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'commit' })
    expect((await f.queries.prepareSessions('changeConnection', [f.tab.id]))?.plan.get(f.tab.id)).toBe('commit')
    expect(f.queryApi.confirmSessions.mock.calls[1][0].tabs[0]).not.toHaveProperty('job')
  })
  it('forgets a job left running, drops its records and shows its id to copy; a closed tab drops its records too', async () => {
    const f = fixture(), notifyJobs = vi.fn(), dropJobRecords = vi.fn<VariaApi['dropJobRecords']>(async () => ({ ok: true, value: undefined }))
    Object.assign(f.queryApi, { dropJobRecords })
    f.queries.notifyJobs = notifyJobs
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    const key = f.documents.get(f.tab.id)!.jobKey!
    f.queries.sessionClosed(f.tab.id, 'leave')
    expect(dropJobRecords).toHaveBeenCalledWith(key)
    expect(notifyJobs).toHaveBeenCalledWith("orders.sql: BigQuery job job_1 was left running. Find it in BigQuery's job history.", ['job_1'])
    // The request then answers detached; the tab keeps no reference to it.
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    // The run answered after Leave: a job it reported then is not the tab's either.
    expect(dropJobRecords).toHaveBeenCalledTimes(2)
    f.queries.sessionClosed(f.tab.id, 'rollback')
    expect(dropJobRecords).toHaveBeenCalledTimes(2)
    f.events.emit({ type: 'documents.closed', tabId: f.tab.id })
    expect(dropJobRecords).toHaveBeenLastCalledWith(key)
    expect(dropJobRecords).toHaveBeenCalledTimes(3)
  })
  it('ends a session with keepJob for Leave it running and cancelJob for Cancel the job', async () => {
    const f = fixture(), ended = vi.fn()
    f.documents.sessionHooks = { message: vi.fn(), bigQuery: () => true, ended }
    await f.documents.endSession(f.tab.id, 'leave')
    await f.documents.endSession(f.tab.id, 'cancelJob', { abortOnRefusedCommit: false })
    await f.documents.endSession(f.tab.id, 'commit')
    expect(f.api.closeQuerySession.mock.calls).toEqual([[f.tab.id, { keepJob: true }], [f.tab.id, { cancelJob: true, abortOnRefusedCommit: false }], [f.tab.id, { transaction: 'commit' }]])
    expect(ended.mock.calls).toEqual([[f.tab.id, 'leave'], [f.tab.id, 'cancelJob'], [f.tab.id, 'commit']])
  })
})

describe('Close Results while a BigQuery job runs', () => {
  async function running() {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    const confirmRunningJob = vi.fn<VariaApi['confirmRunningJob']>(async () => ({ ok: true, value: 'leave' }))
    Object.assign(f.queryApi, { confirmRunningJob })
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    return { ...f, pending, run, confirmRunningJob }
  }
  it('is offered only once the run reported its job', async () => {
    const f = await running()
    expect(f.queries.canCloseRunningJob(f.tab.id)).toBe(false)
    await expect(f.queries.closeRunningJob(f.tab.id)).resolves.toBe(false)
    expect(f.confirmRunningJob).not.toHaveBeenCalled()
    f.job({ jobId: 'job_1', state: 'running' })
    expect(f.queries.canCloseRunningJob(f.tab.id)).toBe(true)
  })
  it('leaves the job running through query.cancel detach, then lets the results close with the job held', async () => {
    const f = await running()
    f.job({ jobId: 'job_1', location: 'US', state: 'running' })
    const closing = f.queries.closeRunningJob(f.tab.id)
    await settle()
    expect(f.confirmRunningJob).toHaveBeenCalledWith({ name: 'orders.sql', job: { elapsedMs: 0, jobIds: ['job_1'] } })
    expect(f.queryApi.cancel).toHaveBeenCalledWith(f.queryApi.execute.mock.calls[0][0].queryId, { detach: true })
    f.pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await expect(closing).resolves.toBe(true)
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toEqual([job('job_1', { detached: true, createdAt: 5000 })])
  })
  it('cancels the job as Stop does for Cancel the job, and keeps the results for Don\'t Close', async () => {
    const f = await running()
    f.job({ jobId: 'job_1', state: 'running' })
    f.confirmRunningJob.mockResolvedValueOnce({ ok: true, value: 'cancel' })
    await expect(f.queries.closeRunningJob(f.tab.id)).resolves.toBe(false)
    expect(f.queryApi.cancel).not.toHaveBeenCalled()
    f.confirmRunningJob.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    const closing = f.queries.closeRunningJob(f.tab.id)
    await settle()
    expect(f.queryApi.cancel).toHaveBeenCalledWith(f.queryApi.execute.mock.calls[0][0].queryId)
    f.pending.resolve({ ok: true, value: output({ status: 'cancelled' }) })
    await expect(closing).resolves.toBe(true)
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
  it('names the estimate the run started with, and a restored job as not re-attached yet', async () => {
    const f = fixture()
    f.queries.estimateOf = () => 3 * 2 ** 30
    const confirmRunningJob = vi.fn<VariaApi['confirmRunningJob']>(async () => ({ ok: true, value: 'cancel' }))
    Object.assign(f.queryApi, { confirmRunningJob })
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    void f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    f.queries.estimateOf = () => 1
    await f.queries.closeRunningJob(f.tab.id)
    expect(confirmRunningJob.mock.calls[0][0].job).toMatchObject({ estimateBytes: 3 * 2 ** 30 })
    await f.queries.prepareSessions('close', [f.tab.id])
    expect(f.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ estimateBytes: 3 * 2 ** 30 })
    pending.resolve({ ok: true, value: output() })
    // A restored job whose re-attach failed (kept, not tried again on this connection).
    const restored = fixture()
    restored.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'Not connected.', code: 'NOT_CONNECTED' })
    restored.queries.restoreJobs(restored.tab.id, [job('job_2')])
    await settle(); await settle()
    await restored.queries.prepareSessions('close', [restored.tab.id])
    expect(restored.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ unattached: true })
    expect(restored.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).not.toHaveProperty('detached')
  })
  it('keeps the results when the job could not be cancelled', async () => {
    const f = await running(), notify = vi.fn()
    f.queries.notify = notify
    f.job({ jobId: 'job_1', state: 'running' })
    f.confirmRunningJob.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    f.queryApi.cancel.mockResolvedValueOnce({ ok: false, error: 'No answer.', code: 'TIMEOUT' })
    await expect(f.queries.closeRunningJob(f.tab.id)).resolves.toBe(false)
    expect(notify).toHaveBeenCalledWith('Close Results: the job could not be cancelled. No answer.')
  })
  it('keeps the results when the job could not be left running', async () => {
    const f = await running(), notify = vi.fn()
    f.queries.notify = notify
    f.job({ jobId: 'job_1', state: 'running' })
    f.queryApi.cancel.mockResolvedValueOnce({ ok: false, error: 'The query already finished.', code: 'JOB_FINISHED' })
    await expect(f.queries.closeRunningJob(f.tab.id)).resolves.toBe(false)
    expect(notify).toHaveBeenCalledWith('Close Results: the job could not be left running. The query already finished.')
  })
})

describe('restored jobs cancelled from their records', () => {
  it("cancels a restored tab's jobs through main before dropping its records, and shows what could not be cancelled", async () => {
    const f = fixture({ connected: false }), notifyJobs = vi.fn(), order: string[] = []
    const cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>(async () => { order.push('cancel'); return { ok: true, value: { jobs: [{ jobId: 'job_1', cancelled: true }, { jobId: 'job_2', cancelled: false, error: 'Access denied.' }], uncancellable: ['job_3'] } } })
    const dropJobRecords = vi.fn<VariaApi['dropJobRecords']>(async () => { order.push('drop'); return { ok: true, value: undefined } })
    Object.assign(f.queryApi, { cancelRestoredJobs, dropJobRecords })
    f.queries.notifyJobs = notifyJobs
    const key = '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10'
    f.documents.update(f.tab.id, { jobKey: key })
    f.queries.restoreJobs(f.tab.id, [job('job_1'), job('job_2', { createdAt: 2 }), job('job_3', { createdAt: 3 })])
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    await settle(); await settle()
    expect(cancelRestoredJobs).toHaveBeenCalledWith([key])
    expect(order).toEqual(['cancel', 'drop'])
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    expect(notifyJobs).toHaveBeenCalledWith("orders.sql: BigQuery jobs job_3, job_2 could not be cancelled. Cancel them in BigQuery's job history.", ['job_3', 'job_2'])
  })
  it('leaves a running query to the backend: Cancel the job on its session cancels it there', async () => {
    const f = fixture(), cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>()
    Object.assign(f.queryApi, { cancelRestoredJobs, dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })) })
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    void f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    expect(cancelRestoredJobs).not.toHaveBeenCalled()
    pending.resolve({ ok: true, value: output({ status: 'cancelled' }) })
  })
})

describe('the prompt beside a cost gate and held jobs', () => {
  it('stops a run still in its cost prompt instead of asking about a job it never sent', async () => {
    const f = fixture(), gate = deferred<boolean>()
    f.queries.setCostGate(() => gate.promise)
    void f.queries.execute(f.tab.id)
    await settle()
    expect(f.queries.isRunning(f.tab.id)).toBe(true)
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
    gate.resolve(false)
  })
  it('stops a run in its cost prompt beside a job the tab holds, and asks only about the held job', async () => {
    const f = fixture(), gate = deferred<boolean>()
    // A job left running by Close Results, which the backend still sees running.
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const first = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await first
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 0, checked: false, job: 'running' } })
    f.queries.setCostGate(() => gate.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    const prepared = await f.queries.prepareSessions('disconnect', [f.tab.id])
    expect(f.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ detached: true })
    expect(prepared?.plan.get(f.tab.id)).toBe('cancelJob')
    expect(prepared?.stopping.map(tab => tab.id)).toEqual([f.tab.id])
    await f.queries.cancelPreparedSessions(prepared!)
    await run
    expect(f.queries.isRunning(f.tab.id)).toBe(false)
    expect(f.queryApi.execute).toHaveBeenCalledTimes(1)
  })
  it('says a restored job carries on even for a tab that means to reconnect, whose reconnect may fail', () => {
    const f = fixture({ connected: false })
    f.documents.update(f.tab.id, { attachWanted: true })
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    expect(f.results.addMessage).toHaveBeenCalledWith(f.tab.id, restoredJobRunning(['job_1']), 'info')
    expect(restoredJobRunning(['job_1'])).not.toContain('Reconnect')
  })
  it("keeps the new-session notice for a later run: a re-attach adopts the job's session", async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { sessionNotice: 'restarted' })
    f.queries.restoreJobs(f.tab.id, [job('job_1', { transaction: 'open' })])
    await settle(); await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(1)
    expect(f.documents.get(f.tab.id)?.sessionNotice).toBe('restarted')
  })
  it('stops Preview Rows like any query: it runs no job', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    void f.queries.execute(f.tab.id, { project: 'example-project', dataset: 'sales', table: 'orders' })
    await settle()
    expect(f.queries.isRunning(f.tab.id)).toBe(true)
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
    pending.resolve({ ok: true, value: output() })
  })
  it('drops the records of a job reported after Leave it running, on a tab that stays', async () => {
    const f = fixture(), dropJobRecords = vi.fn<VariaApi['dropJobRecords']>(async () => ({ ok: true, value: undefined }))
    Object.assign(f.queryApi, { dropJobRecords })
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.queries.sessionClosed(f.tab.id, 'leave')
    expect(dropJobRecords).toHaveBeenCalledTimes(1)
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run
    expect(dropJobRecords).toHaveBeenCalledTimes(2)
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
  it('never re-attaches an older job passed over beside a newer one, on a later connection either', async () => {
    const f = fixture()
    f.queries.restoreJobs(f.tab.id, [job('job_old', { createdAt: 1 }), job('job_new', { createdAt: 2 })])
    await settle(); await settle(); await settle()
    expect(f.queryApi.attach.mock.calls.map(call => call[0].jobId)).toEqual(['job_new'])
    Object.assign(f.connection, { generation: 2 })
    f.queries.reattach()
    await settle(); await settle()
    expect(f.queryApi.attach.mock.calls.map(call => call[0].jobId)).toEqual(['job_new'])
    expect(f.results.begin).toHaveBeenCalledTimes(1)
  })
  it("treats a finished job's re-attach as reading results, not as a running job", async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    Object.assign(f.queryApi, { confirmRunningJob: vi.fn() })
    f.queryApi.attach.mockReturnValueOnce(pending.promise)
    f.queries.restoreJobs(f.tab.id, [job('job_1', { state: 'done' })])
    await settle()
    expect(f.queries.getSnapshot()[f.tab.id].running).toMatchObject({ kind: 'attach', finished: true })
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
    expect(f.queries.canCloseRunningJob(f.tab.id)).toBe(false)
    pending.resolve({ ok: true, value: output() })
  })
  it('drops the records of a job reported after its tab closed with Leave it running', async () => {
    const f = fixture(), dropJobRecords = vi.fn<VariaApi['dropJobRecords']>(async () => ({ ok: true, value: undefined }))
    Object.assign(f.queryApi, { dropJobRecords })
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.queries.sessionClosed(f.tab.id, 'leave')
    await f.documents.close(f.tab.id)
    expect(f.documents.get(f.tab.id)).toBeUndefined()
    const drops = dropJobRecords.mock.calls.length
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run
    expect(dropJobRecords.mock.calls.length).toBe(drops + 1)
  })
  it('names how long a re-attached job has run since it was created', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.attach.mockReturnValueOnce(pending.promise)
    f.queries.restoreJobs(f.tab.id, [job('job_1', { createdAt: 1000 })])
    await settle()
    await f.queries.prepareSessions('close', [f.tab.id])
    expect(f.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ elapsedMs: 4000 })
    pending.resolve({ ok: true, value: output() })
  })
  it("never holds a finished job's reference for the prompt", async () => {
    const f = fixture({ connected: false })
    f.queries.restoreJobs(f.tab.id, [job('job_1', { state: 'done' })])
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
  })
  it('shows what bigquery.cancelJobs noted for a cancelled job', async () => {
    const f = fixture({ connected: false }), notify = vi.fn()
    f.queries.notify = notify
    Object.assign(f.queryApi, { dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })), cancelRestoredJobs: vi.fn<VariaApi['cancelRestoredJobs']>(async () => ({ ok: true, value: { jobs: [{ jobId: 'job_1', cancelled: true, note: { code: 'committedBeforeCancel' } }], uncancellable: [] } })) })
    f.documents.update(f.tab.id, { jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10' })
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    await settle(); await settle()
    expect(notify).toHaveBeenCalledWith('orders.sql: the stopped job job_1 committed a transaction before it stopped. Stopping does not undo work already committed.')
    notify.mockClear()
    await f.queries.reviewJobsWithoutTab({ reviewJobsWithoutTab: async () => ({ ok: true, value: { answer: 'cancel', jobIds: ['job_9'], cancel: { jobs: [{ jobId: 'job_9', cancelled: true, note: { code: 'abortFailed' } }], uncancellable: [] } } }) })
    expect(notify.mock.calls[0][0]).toMatch(/^BigQuery: Varia could not end the BigQuery session/)
  })
  it("cancels from records only the jobs the backend does not know: never a connected tab's job left running, nor the running request's", async () => {
    const f = fixture(), cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>(async () => ({ ok: true, value: { jobs: [{ jobId: 'job_2', cancelled: false, error: 'x' }, { jobId: 'job_old', cancelled: true }], uncancellable: [] } }))
    const notifyJobs = vi.fn()
    Object.assign(f.queryApi, { cancelRestoredJobs, dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })) })
    f.queries.notifyJobs = notifyJobs
    f.documents.update(f.tab.id, { jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10' })
    // Left running by Close Results, on a connected tab: the backend's session cancels it.
    const pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    expect(cancelRestoredJobs).not.toHaveBeenCalled()
    // A re-attach running beside an older running job: the older one is cancelled from its record, and only its outcome shown.
    const attach = deferred<ApiResult<QueryResult>>()
    f.queryApi.attach.mockReturnValueOnce(attach.promise)
    f.queries.restoreJobs(f.tab.id, [job('job_old', { createdAt: 1 }), job('job_2', { createdAt: 9000 })])
    await settle()
    expect(f.queries.getSnapshot()[f.tab.id].running).toMatchObject({ kind: 'attach', jobId: 'job_2' })
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    await settle(); await settle()
    expect(cancelRestoredJobs).toHaveBeenCalledTimes(1)
    expect(notifyJobs).not.toHaveBeenCalled()
    attach.resolve({ ok: true, value: output({ status: 'cancelled' }) })
  })
})

describe('jobs without a tab', () => {
  it("sends the open tabs' job keys and shows the jobs Cancel Jobs could not cancel", async () => {
    const f = fixture(), notifyJobs = vi.fn(), key = '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10'
    f.documents.update(f.tab.id, { jobKey: key })
    f.queries.notifyJobs = notifyJobs
    const reviewJobsWithoutTab = vi.fn<VariaApi['reviewJobsWithoutTab']>(async () => ({ ok: true, value: { answer: 'cancel', jobIds: ['job_9', 'job_8'], cancel: { jobs: [{ jobId: 'job_9', cancelled: true }], uncancellable: ['job_8'] } } }))
    await f.queries.reviewJobsWithoutTab({ reviewJobsWithoutTab })
    expect(reviewJobsWithoutTab).toHaveBeenCalledWith([key])
    expect(notifyJobs).toHaveBeenCalledWith("BigQuery job job_8 could not be cancelled. Cancel it in BigQuery's job history.", ['job_8'])
    reviewJobsWithoutTab.mockResolvedValueOnce({ ok: true, value: { answer: 'keep', jobIds: ['job_7'] } })
    await f.queries.reviewJobsWithoutTab({ reviewJobsWithoutTab })
    expect(notifyJobs).toHaveBeenCalledTimes(1)
  })
})

describe('failed aborts', () => {
  it('says what an idle session left open whose end failed', () => {
    const f = fixture(), notify = vi.fn()
    f.queries.notify = notify
    f.queries.failedAborts(2)
    f.queries.failedAborts(0)
    expect(notify.mock.calls).toEqual([[failedAbortsText(2)]])
    expect(failedAbortsText(1)).toContain('an idle BigQuery session')
    expect(failedAbortsText(2)).toContain('2 idle BigQuery sessions')
  })
})
