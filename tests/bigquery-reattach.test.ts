import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, QueryResult, VariaApi } from '../src/shared/contracts'
import { attachExpiredRerun, failedAbortsText, heldAfter, jobHeldAfterFailure, jobStillRunning, QueryService, restoredJobRunning, type QueryApi, type TabJob } from '../src/renderer/src/services/queries'
import type { ResultsService } from '../src/renderer/src/results/ResultsService'
import { deferred, documentFixture } from './fixtures/documents'
import { defaultSettings } from '../src/shared/settings/catalog'
import type { RecordedJobsCancel } from '../src/shared/bigquery/jobs'

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

describe('a run that failed while its job ran', () => {
  it('keeps the job the session holds, says so, and settles it once a later run completes', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', location: 'US', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    await run; await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    // Held in this backend's session: holdsJob asks the backend.
    f.queryApi.querySessionState.mockResolvedValueOnce({ ok: true, value: { transactionCount: 0, checked: false, job: 'running' } })
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
    expect(f.results.addMessage).toHaveBeenCalledWith(f.tab.id, jobHeldAfterFailure(['job_1']), 'info')
    expect(f.results.addMessage).not.toHaveBeenCalledWith(f.tab.id, jobStillRunning(['job_1']), 'info')
    // This backend's session follows it already: no re-attach.
    expect(f.queryApi.attach).not.toHaveBeenCalled()
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
})

describe('a run after Leave it running', () => {
  it('keeps the detached job through a run that failed (perhaps waiting for it), and settles it after one that completed', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', location: 'US', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run; await settle()
    f.queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
  it("keeps a failed run's own running job beside the detached one it waited for", async () => {
    const f = fixture(), first = deferred<ApiResult<QueryResult>>(), second = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(first.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', location: 'US', state: 'running' })
    first.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run; await settle()
    f.queryApi.execute.mockReturnValueOnce(second.promise)
    const failing = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_2', location: 'US', state: 'running' })
    second.resolve({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    await failing; await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1', 'job_2'])
    // Both are held in this backend's session: the box says so, and once the backend sees them end they are let go.
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 0, checked: false, job: 'running' } })
    await f.queries.prepareSessions('close', [f.tab.id])
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 0, checked: true, job: 'none' } })
    expect(f.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ detached: true })
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
  })
  it('leaves a job held after a failed run to the backend when Cancel the job ends its session', async () => {
    const cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>(async () => ({ ok: true, value: { jobs: [], uncancellable: [] } }))
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    Object.assign(f.queryApi, { cancelRestoredJobs, dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })) })
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_2', location: 'US', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    await run; await settle()
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    await settle()
    expect(cancelRestoredJobs).not.toHaveBeenCalled()
  })
  it('treats a re-attach that failed after its identity check as held in its session: asks the backend, labels it left running and leaves Cancel the job to the backend', async () => {
    const cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>(async () => ({ ok: true, value: { jobs: [], uncancellable: ['job_1'] } }))
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    Object.assign(f.queryApi, { cancelRestoredJobs, dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })) })
    f.documents.update(f.tab.id, { jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10' })
    f.queryApi.attach.mockReturnValueOnce(pending.promise)
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    await settle()
    f.job({ jobId: 'job_1', location: 'US', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    await settle(); await settle()
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 0, checked: false, job: 'running' } })
    await f.queries.prepareSessions('close', [f.tab.id])
    expect(f.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ detached: true })
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    await settle(); await settle()
    expect(cancelRestoredJobs).not.toHaveBeenCalled()
  })
  it('names a held job left running, not the Preview Rows the tab runs meanwhile', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_2', location: 'US', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'detached' }) })
    await run; await settle()
    const snapshot = f.queries.getSnapshot()[f.tab.id]
    ;(f.queries as unknown as { update: (id: string, patch: object) => void }).update(f.tab.id, { running: { queryId: 'preview-1', connectionId: 'bq-a', startedAt: 0, kind: 'preview' }, jobs: snapshot.jobs })
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 0, checked: false, job: 'running' } })
    await f.queries.prepareSessions('close', [f.tab.id])
    expect(f.queryApi.confirmSessions.mock.calls[0][0].tabs[0].job).toMatchObject({ detached: true })
  })
})

describe('re-attaching restored tabs', () => {
  it("opens a job's results without taking over its session when Job History asks (adopt false), and adopts otherwise", async () => {
    const f = fixture()
    f.documents.update(f.tab.id, { jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10' })
    f.queries.restoreJobs(f.tab.id, [job('job_seen', { state: 'done', adopt: false })])
    await settle(); await settle(); await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(1)
    expect(f.queryApi.attach.mock.calls[0][0]).toMatchObject({ jobId: 'job_seen', adoptSession: false })
  })
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
  it('says Execute runs the query again when BigQuery no longer keeps a re-attached job\'s results, in a tab that holds its SQL', async () => {
    const f = fixture()
    f.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'BigQuery no longer has the results of job job_1.', code: 'REMOTE_EXPIRED' })
    f.queries.restoreJobs(f.tab.id, [job('job_1', { state: 'done', adopt: false })])
    await settle()
    expect(f.results.addMessage).toHaveBeenCalledWith(f.tab.id, attachExpiredRerun, 'info')
    // An empty tab (Job History could not read the job's SQL) is not told to run what it does not hold.
    const empty = f.documents.create('empty.sql', '', '', f.connection.id)
    f.results.addMessage.mockClear()
    f.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'Gone.', code: 'REMOTE_EXPIRED' })
    f.queries.restoreJobs(empty.id, [job('job_2', { state: 'done', adopt: false })])
    await settle()
    expect(f.queryApi.attach).toHaveBeenCalledTimes(2)
    expect(f.results.addMessage).not.toHaveBeenCalledWith(empty.id, attachExpiredRerun, 'info')
  })
  it("drops a job another principal ran, and Stop on a re-attach cancels it like a query's", async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    // The principal check runs in the attach (jobs.get, jobs.list): the backend answers it as a failed summary.
    f.queryApi.attach.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed', error: { code: 'AUTH_IDENTITY', message: 'This job was run by another account.', batchNumber: 1, iteration: 1 } }) })
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
    // A sign-in check failing mid-poll after the re-attach's identity check passed (the job was reported) keeps it.
    const authFailed = output({ status: 'failed', error: { code: 'AUTH_IDENTITY', message: 'Could not be verified.', batchNumber: 1, iteration: 1 } })
    expect(heldAfter(running, [], [running], authFailed, undefined)).toEqual([running])
    expect(heldAfter(running, [], [], authFailed, undefined)).toEqual([])
    // A run that failed while its job ran (no done event): the backend holds the job in the session.
    expect(heldAfter(undefined, [detached], [running, done], output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }), undefined)).toEqual([running])
    expect(heldAfter(running, [detached], [], output(), undefined)).toEqual([detached])
    expect(heldAfter(undefined, [], [running, done], undefined, 'BACKEND_LOST')).toEqual([running])
    expect(heldAfter(done, [], [], undefined, 'CONNECTION_LOST')).toEqual([done])
    // Before the run, AUTH_IDENTITY is the project check: another project's job waits for a connection to that project.
    expect(heldAfter(running, [detached], [], undefined, 'AUTH_IDENTITY')).toEqual([detached, running])
    expect(heldAfter(running, [detached], [], undefined, 'DUPLICATE_QUERY')).toEqual([detached])
  })
  it("keeps a re-attach's running job through a passing failure, and its reference through a lost backend", () => {
    const failed = (code: string) => output({ status: 'failed', error: { code, message: 'x', batchNumber: 1, iteration: 1 } })
    // A quota or timeout says nothing about the job: tried again on the next connection.
    expect(heldAfter(running, [detached], [running], failed('QUOTA'), undefined)).toEqual([detached, running])
    expect(heldAfter(running, [], [], undefined, 'SESSION_BUSY')).toEqual([running])
    // Another principal's job (refused before it was reported), or one Stop cancelled, is dropped.
    expect(heldAfter(running, [], [], failed('AUTH_IDENTITY'), undefined)).toEqual([])
    expect(heldAfter(running, [], [running], output({ status: 'cancelled' }), undefined)).toEqual([])
    // A finished job's re-attach cut off keeps it, to read its results on the next connection.
    expect(heldAfter(running, [], [{ ...running, state: 'done', createdAt: 99 }], undefined, 'BACKEND_LOST')).toEqual([{ ...running, state: 'done' }])
    // A left-running job stays left running, with its own age, not the report's.
    const left = job('d', { detached: true })
    expect(heldAfter(left, [], [{ ...left, detached: undefined, createdAt: 99 }], undefined, 'BACKEND_LOST')).toEqual([left])
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
  it("asks the transaction of a session that holds none of the tab's jobs after Leave it running, and ends it as answered", async () => {
    // A restored job whose re-attach failed its project check: kept as a reference, outside the tab's session.
    const f = fixture(), notifyJobs = vi.fn(), dropJobRecords = vi.fn<VariaApi['dropJobRecords']>(async () => ({ ok: true, value: undefined }))
    Object.assign(f.queryApi, { dropJobRecords })
    f.queries.notifyJobs = notifyJobs
    f.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'Another project.', code: 'AUTH_IDENTITY' })
    f.queries.restoreJobs(f.tab.id, [job('job_p')])
    await settle(); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(held => held.jobId)).toEqual(['job_p'])
    // The tab then opened a transaction in its own session, which holds no job.
    f.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 1, checked: true, job: 'none' } })
    f.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'leave' }).mockResolvedValueOnce({ ok: true, value: 'commit' })
    const prepared = await f.queries.prepareSessions('close', [f.tab.id])
    expect(f.queryApi.confirmSessions.mock.calls.map(call => call[0].tabs.map(tab => [tab.transactions, !!tab.job]))).toEqual([[[0, true]], [[1, false]]])
    expect(prepared?.plan.get(f.tab.id)).toBe('leaveCommit')
    // The session ends with the commit, not keepJob (which the backend refuses with JOB_FINISHED), and the job is left as Leave leaves it.
    f.documents.sessionHooks = { message: vi.fn(), bigQuery: () => true, ended: (id, entry) => f.queries.sessionClosed(id, entry) }
    await f.documents.endSession(f.tab.id, prepared!.plan.get(f.tab.id))
    expect(f.api.closeQuerySession).toHaveBeenLastCalledWith(f.tab.id, { transaction: 'commit' })
    expect(notifyJobs).toHaveBeenCalledWith("orders.sql: BigQuery job job_p was left running. Find it in BigQuery's job history.", ['job_p'])
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    // Cancel the job still rolls the transaction back with the job, so the transaction is not asked.
    const g = fixture()
    g.queryApi.attach.mockResolvedValueOnce({ ok: false, error: 'Another project.', code: 'AUTH_IDENTITY' })
    g.queries.restoreJobs(g.tab.id, [job('job_p')])
    await settle(); await settle()
    g.queryApi.querySessionState.mockResolvedValue({ ok: true, value: { transactionCount: 1, checked: true, job: 'none' } })
    g.queryApi.confirmSessions.mockResolvedValueOnce({ ok: true, value: 'proceed' })
    expect((await g.queries.prepareSessions('close', [g.tab.id]))?.plan.get(g.tab.id)).toBe('cancelJob')
    expect(g.queryApi.confirmSessions).toHaveBeenCalledTimes(1)
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
    // The estimate of the text sent, not the whole document's held by the cost service.
    f.queries.estimateOf = (_tab, sql) => sql === 'SELECT 1' ? 3 * 2 ** 30 : 5 * 2 ** 40
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
  it("cancels a restored tab's jobs through main, which drops the records it read (not the tab's whole key), and shows what could not be cancelled", async () => {
    const f = fixture({ connected: false }), notifyJobs = vi.fn(), order: string[] = []
    const cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>(async () => { order.push('cancel'); return { ok: true, value: { jobs: [{ jobId: 'job_1', cancelled: true }, { jobId: 'job_2', cancelled: false, error: 'Access denied.' }], uncancellable: ['job_3'] } } })
    const dropJobRecords = vi.fn<VariaApi['dropJobRecords']>(async () => { order.push('drop'); return { ok: true, value: undefined } })
    Object.assign(f.queryApi, { cancelRestoredJobs, dropJobRecords })
    f.queries.notifyJobs = notifyJobs
    const key = '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10'
    f.documents.update(f.tab.id, { jobKey: key })
    f.queries.restoreJobs(f.tab.id, [job('job_1'), job('job_2', { createdAt: 2 }), job('job_3', { createdAt: 3 }), job('job_4', { createdAt: 4 })])
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    await settle(); await settle()
    expect(cancelRestoredJobs).toHaveBeenCalledWith([key])
    // A job the tab starts while the cancel waits for DONE keeps its record: main dropped only the ones it read.
    expect(order).toEqual(['cancel'])
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    // job_4 has no record in main (a deleted connection's): not cancelled either.
    expect(notifyJobs).toHaveBeenCalledWith("orders.sql: BigQuery jobs job_3, job_2, job_4 could not be cancelled. Cancel them in BigQuery's job history.", ['job_3', 'job_2', 'job_4'])
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
  it('connects a recovered tab without asking about its jobs, so they re-attach on the new connection', async () => {
    const f = fixture({ connected: false })
    // A recovered tab keeps its provider without a connection (DocumentService restores it).
    f.documents.update(f.tab.id, { provider: 'bigquery' } as Parameters<typeof f.documents.update>[1])
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    // A remembered Cancel would otherwise cancel the job the user is connecting to get back.
    const prepared = await f.queries.prepareSessions('changeConnection', [f.tab.id], { bigQuery: true })
    expect(f.queryApi.confirmSessions).not.toHaveBeenCalled()
    expect(prepared?.plan.get(f.tab.id)).not.toBe('cancelJob')
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toEqual([job('job_1')])
    // Closing it, or moving it to SQL Server (where nothing re-attaches), still asks.
    await f.queries.prepareSessions('changeConnection', [f.tab.id], { bigQuery: false })
    await f.queries.prepareSessions('close', [f.tab.id])
    expect(f.queryApi.confirmSessions).toHaveBeenCalledTimes(2)
  })
  it("keeps a job the backend reports cut off by the network in a failed summary (its real shape), and re-attaches to it", async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.attach.mockResolvedValue({ ok: false, error: 'Network.', code: 'CONNECTION_LOST' })
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'failed', error: { code: 'CONNECTION_LOST', message: 'Network lost.', batchNumber: 1, iteration: 1 } }) })
    await run; await settle(); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    expect(f.results.addMessage).toHaveBeenCalledWith(f.tab.id, jobStillRunning(['job_1']), 'info')
    expect(f.queryApi.attach).toHaveBeenCalled()
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
    // The next run on that connection waited for it: its summary settles the job.
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    // A re-attach that failed at its identity check (no job reported) holds nothing in the session: a later run never
    // settles it, and the tab still holds it to ask about.
    const g = fixture()
    g.queryApi.attach.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    g.queries.restoreJobs(g.tab.id, [job('job_1')])
    await settle(); await settle()
    await g.queries.execute(g.tab.id); await settle()
    expect(g.queries.getSnapshot()[g.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    await expect(g.queries.holdsJob(g.tab.id)).resolves.toBe(true)
  })
  it("never lets go of a restored detached job this backend did not leave running when the session reports none", async () => {
    const f = fixture()
    f.queryApi.attach.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    f.queries.restoreJobs(f.tab.id, [job('job_d', { detached: true })])
    await settle(); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => [item.jobId, !!item.detached])).toEqual([['job_d', true]])
    // query.session.state answers job 'none' (the fixture's default): the job was never in this session.
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(true)
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_d'])
    // Cancel the job cancels it through main: the tab's session does not hold it.
    const cancelRestoredJobs = vi.fn<VariaApi['cancelRestoredJobs']>(async () => ({ ok: true, value: { jobs: [{ jobId: 'job_d', cancelled: true }], uncancellable: [] } }))
    const g = fixture()
    Object.assign(g.queryApi, { cancelRestoredJobs, dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })) })
    g.queryApi.attach.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed', error: { code: 'PERMISSION_DENIED', message: 'No jobs.list.', batchNumber: 1, iteration: 1 } }) })
    g.queries.restoreJobs(g.tab.id, [job('job_d', { detached: true })])
    await settle(); await settle()
    g.queries.sessionClosed(g.tab.id, 'cancelJob')
    expect(cancelRestoredJobs).toHaveBeenCalledOnce()
    // Nor does a later run in the tab, whose session never waited behind it.
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => [item.jobId, !!item.detached])).toEqual([['job_d', true]])
    // A failed re-attach on a live connection never says the job re-attaches once the connection is back.
    expect(f.results.addMessage.mock.calls.flat().join(' ')).not.toContain("connection is back")
  })
  it('waits at a quit for Cancel the job carried out through main, and says whether it reported anything', async () => {
    const f = fixture({ connected: false }), cancel = deferred<ApiResult<RecordedJobsCancel>>()
    Object.assign(f.queryApi, { cancelRestoredJobs: vi.fn(() => cancel.promise), dropJobRecords: vi.fn(async () => ({ ok: true, value: undefined })) })
    f.queries.notifyJobs = vi.fn()
    f.documents.update(f.tab.id, { jobKey: '6f2b8f84-2b7c-4b55-9c55-9d6f8c2a1b10' })
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    f.queries.sessionClosed(f.tab.id, 'cancelJob')
    let settled: boolean | undefined
    void f.queries.restoredCancelsSettled().then(value => { settled = value })
    await settle()
    expect(settled).toBeUndefined()
    cancel.resolve({ ok: true, value: { jobs: [{ jobId: 'job_1', cancelled: false, error: 'Access denied.' }], uncancellable: [] } })
    await settle(); await settle()
    expect(settled).toBe(true)
    await expect(f.queries.restoredCancelsSettled()).resolves.toBe(false)
  })
  it("settles a re-attach kept after a passing failure once a later run, which waited for it, completes (not one that failed)", async () => {
    const f = fixture()
    // The backend reported the job (its identity check passed, so it adopted the session), then the read failed.
    f.queryApi.attach.mockImplementationOnce(async () => { f.job({ jobId: 'job_1', state: 'running' }); return { ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) } })
    f.queries.restoreJobs(f.tab.id, [job('job_1')])
    await settle(); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    // A run that failed may have failed waiting for it: the job stays.
    f.queryApi.execute.mockResolvedValueOnce({ ok: true, value: output({ status: 'failed', error: { code: 'QUOTA', message: 'Rate limited.', batchNumber: 1, iteration: 1 } }) })
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
  })
  it('settles a job a lost connection held when a later run, which waited for it, is left running', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.attach.mockResolvedValue({ ok: false, error: 'Network.', code: 'CONNECTION_LOST' })
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: true, value: output({ status: 'failed', error: { code: 'CONNECTION_LOST', message: 'Network lost.', batchNumber: 1, iteration: 1 } }) })
    await run; await settle(); await settle()
    const second = deferred<ApiResult<QueryResult>>()
    f.queryApi.execute.mockReturnValueOnce(second.promise)
    const next = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_2', state: 'running' })
    second.resolve({ ok: true, value: output({ status: 'detached' }) })
    await next; await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => [item.jobId, !!item.detached])).toEqual([['job_2', true]])
  })
  it('settles a job a lost connection held once a later run on that connection, which waited for it, finishes', async () => {
    const f = fixture(), pending = deferred<ApiResult<QueryResult>>()
    f.queryApi.attach.mockResolvedValue({ ok: false, error: 'Network.', code: 'CONNECTION_LOST' })
    f.queryApi.execute.mockReturnValueOnce(pending.promise)
    const run = f.queries.execute(f.tab.id)
    await settle()
    f.job({ jobId: 'job_1', state: 'running' })
    pending.resolve({ ok: false, error: 'Network lost.', code: 'CONNECTION_LOST' })
    await run; await settle(); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs?.map(item => item.jobId)).toEqual(['job_1'])
    // The network is back on the same handle: the backend ran this only after job_1 finished.
    await f.queries.execute(f.tab.id); await settle()
    expect(f.queries.getSnapshot()[f.tab.id].jobs).toBeUndefined()
    await expect(f.queries.holdsJob(f.tab.id)).resolves.toBe(false)
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
    await f.queries.reviewJobsWithoutTab({ reviewJobsWithoutTab }, undefined, () => ['varia-alpha'])
    // Main offers Show in Job History for the projects the page is connected to.
    expect(reviewJobsWithoutTab).toHaveBeenCalledWith({ keys: [key], liveProjects: ['varia-alpha'] })
    expect(notifyJobs).toHaveBeenCalledWith("BigQuery job job_8 could not be cancelled. Cancel it in BigQuery's job history.", ['job_8'])
    reviewJobsWithoutTab.mockResolvedValueOnce({ ok: true, value: { answer: 'keep', jobIds: ['job_7'] } })
    await f.queries.reviewJobsWithoutTab({ reviewJobsWithoutTab })
    expect(notifyJobs).toHaveBeenCalledTimes(1)
  })
  it('hands Show in Job History its jobs by project, and finds the tab that holds a job of a project', async () => {
    const f = fixture(), show = vi.fn(), notifyJobs = vi.fn()
    f.queries.notifyJobs = notifyJobs
    const projects = [{ project: 'example-project', jobs: [{ jobId: 'job_9', location: 'US' }] }]
    await f.queries.reviewJobsWithoutTab({ reviewJobsWithoutTab: async () => ({ ok: true, value: { answer: 'show', jobIds: ['job_9'], show: projects } }) }, show)
    expect(show).toHaveBeenCalledExactlyOnceWith(projects)
    expect(notifyJobs).not.toHaveBeenCalled()
    const update = (patch: object) => (f.queries as unknown as { update: (id: string, patch: object) => void }).update(f.tab.id, patch)
    expect(f.queries.tabHoldingJob('job_1', 'example-project')).toBeUndefined()
    update({ summary: { job: { jobId: 'job_1', project: 'example-project' } } })
    expect(f.queries.tabHoldingJob('job_1', 'example-project')).toBe(f.tab.id)
    expect(f.queries.tabHoldingJob('job_1', 'other-project')).toBeUndefined()
    update({ summary: undefined, running: { queryId: 'q-1', connectionId: 'bq-a', startedAt: 0, jobId: 'job_2' } })
    expect(f.queries.tabHoldingJob('job_2', 'example-project')).toBe(f.tab.id)
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
    // Before a stop or restart (main's onFailedAborts) the backend that would retry ends: no retry is promised.
    expect(failedAbortsText(1, false)).not.toContain('tries again')
    expect(failedAbortsText(1)).toContain('tries again')
    expect(failedAbortsText(2)).toContain('2 idle BigQuery sessions')
  })
})
