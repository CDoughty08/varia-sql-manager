import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobRecordStore, type JobEventInput } from '../src/main/job-records'
import { jobLimits, jobRecordsFileSchema, queryAttachParamsSchema } from '../src/shared/bigquery/jobs'
import { mainOnlyMethods, methodPolicies } from '../src/shared/ipc/methods'
import { requestSchemas } from '../src/main/validation'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'varia-job-records-'))
  directories.push(directory)
  return directory
}
const keyA = '11111111-1111-4111-8111-111111111111', keyB = '22222222-2222-4222-8222-222222222222'
const job = (jobId: string, state: 'running' | 'done' = 'running', transaction: JobEventInput['transaction'] = 'none'): JobEventInput =>
  ({ jobId, project: 'fictional-project', location: 'US', state, auxiliary: false, transaction })
const onDisk = async (directory: string) => jobRecordsFileSchema.parse(JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8')))

describe('BigQuery job records (WorkbenchSession/jobs.json)', () => {
  it('records a job under its key, writes the file on every change, and keeps the first transaction state and time', async () => {
    const directory = await folder()
    let now = 1_000_000
    const store = new JobRecordStore(directory, { now: () => now })
    await store.load()
    store.record(keyA, job('varia_1', 'running', 'open'), 'profile-1')
    await store.flush()
    expect((await onDisk(directory)).records).toEqual([{ jobKey: keyA, jobId: 'varia_1', project: 'fictional-project', location: 'US', profileId: 'profile-1', createdAt: 1_000_000, state: 'running', auxiliary: false, transaction: 'open' }])
    now += 5000
    store.record(keyA, job('varia_1', 'done', 'none'))
    await store.flush()
    expect((await onDisk(directory)).records).toEqual([expect.objectContaining({ state: 'done', transaction: 'open', createdAt: 1_000_000, profileId: 'profile-1' })])
    // A fresh store reads it back.
    const again = new JobRecordStore(directory, { now: () => now })
    await again.load()
    expect(again.forKeys([keyA])).toHaveLength(1)
  })

  it('moves a job re-attached from another tab to the new key', async () => {
    const store = new JobRecordStore(await folder())
    await store.load()
    store.record(keyA, job('varia_1'))
    store.record(keyB, job('varia_1'))
    expect(store.forKeys([keyA])).toEqual([])
    expect(store.forKeys([keyB])).toEqual([expect.objectContaining({ jobId: 'varia_1' })])
    expect(store.withoutTab([keyB])).toEqual([])
    expect(store.withoutTab([keyA])).toHaveLength(1)
  })

  it('marks Close Results\' Leave detached and drops a detached record once its job is DONE', async () => {
    const store = new JobRecordStore(await folder())
    await store.load()
    store.record(keyA, job('varia_1'))
    // A job kept from a lost backend under the same key is not the request's: it keeps its mode.
    store.record(keyA, job('varia_kept'))
    store.markDetached(keyA, new Set(['varia_1']))
    expect(store.list()).toEqual([expect.objectContaining({ jobId: 'varia_1', detached: true }), expect.not.objectContaining({ detached: true })])
    store.drop(keyA, record => record.jobId === 'varia_kept')
    store.record(keyA, job('varia_1', 'done'))
    expect(store.list()).toEqual([])
  })

  it('expires records 24 hours after their job was created, on load and on change', async () => {
    const directory = await folder()
    let now = 10 * jobLimits.lifetimeMs
    const store = new JobRecordStore(directory, { now: () => now })
    await store.load()
    store.record(keyA, job('varia_old'))
    await store.flush()
    now += jobLimits.lifetimeMs
    const later = new JobRecordStore(directory, { now: () => now })
    await later.load()
    expect(later.list()).toEqual([])
    await later.flush()
    expect((await onDisk(directory)).records).toEqual([])
    // A store left open past a record's 24 hours stops offering it, with no change in between.
    const open = new JobRecordStore(await folder(), { now: () => now })
    await open.load()
    open.record(keyA, job('varia_aging'))
    now += jobLimits.lifetimeMs
    expect([open.list(), open.forKeys([keyA]), open.withoutTab([])]).toEqual([[], [], []])
  })

  it('drops the oldest finished records past the per-key and total limits, never a running one', async () => {
    let now = 1
    const store = new JobRecordStore(await folder(), { now: () => now++ })
    await store.load()
    store.record(keyA, job('varia_running'))
    for (let i = 0; i < jobLimits.perKey + 5; i++) store.record(keyA, job(`varia_done_${i}`, 'done'))
    const records = store.forKeys([keyA])
    expect(records).toHaveLength(jobLimits.perKey)
    expect(records[0]).toEqual(expect.objectContaining({ jobId: 'varia_running' }))
    expect(records.some(record => record.jobId === 'varia_done_0')).toBe(false)
    expect(records.at(-1)).toEqual(expect.objectContaining({ jobId: `varia_done_${jobLimits.perKey + 4}` }))
  })

  it('keeps 1,024 records in all, dropping the oldest finished ones first, then the newest running ones', async () => {
    let now = 1
    const store = new JobRecordStore(await folder(), { now: () => now++ })
    await store.load()
    const key = (k: number) => `${String(k).padStart(8, '0')}-1111-4111-8111-111111111111`
    store.record(key(0), job('varia_running_first'))
    for (let i = 0; i < jobLimits.records + 4; i++) store.record(key(1 + i % 20), job(`varia_done_${i}`, 'done'))
    const records = store.list()
    expect(records).toHaveLength(jobLimits.records)
    expect(records.some(record => record.jobId === 'varia_running_first')).toBe(true)
    expect(records.some(record => record.jobId === 'varia_done_0')).toBe(false)
    expect(records.some(record => record.jobId === `varia_done_${jobLimits.records + 3}`)).toBe(true)
    // Only running records past the cap: the newest is not kept.
    const running = new JobRecordStore(await folder(), { now: () => now++ })
    await running.load()
    for (let i = 0; i <= jobLimits.records; i++) running.record(key(1 + i % 20), job(`varia_run_${i}`))
    expect(running.list()).toHaveLength(jobLimits.records)
    expect(running.list().some(record => record.jobId === `varia_run_${jobLimits.records}`)).toBe(false)
  })

  it('quarantines an unreadable file instead of overwriting it', async () => {
    const directory = await folder()
    await writeFile(join(directory, 'jobs.json'), JSON.stringify({ version: 1, records: [{ jobKey: 'not-a-key' }] }))
    const store = new JobRecordStore(directory)
    await store.load()
    expect(store.list()).toEqual([])
    expect((await readdir(directory)).some(name => name.startsWith('jobs.json.invalid-'))).toBe(true)
    store.record(keyA, job('varia_1'))
    await store.flush()
    expect((await onDisk(directory)).records).toHaveLength(1)
  })

  it('never replaces a file it could not read, and keeps the file records when a job is recorded before the read', async () => {
    const directory = await folder()
    // A directory where the file should be: the read throws, as a locked file does.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'jobs.json'))
    const errors: unknown[] = []
    const store = new JobRecordStore(directory, { onWriteError: error => errors.push(error) })
    await expect(store.load()).rejects.toThrow()
    store.record(keyA, job('varia_1'))
    await store.flush()
    expect(errors).toHaveLength(1)
    expect((await readdir(join(directory, 'jobs.json')))).toEqual([])
    // A record made before the read finishes merges with the file's, rather than overwriting them.
    const other = await folder()
    const first = new JobRecordStore(other)
    await first.load()
    first.record(keyA, job('varia_old'))
    await first.flush()
    const second = new JobRecordStore(other)
    second.record(keyB, job('varia_new'))
    await second.load()
    await second.flush()
    expect((await onDisk(other)).records.map(record => record.jobId).sort()).toEqual(['varia_new', 'varia_old'])
  })

  it('refuses a reference the file schema would refuse, so one odd event cannot quarantine the rest', async () => {
    const directory = await folder()
    const store = new JobRecordStore(directory)
    await store.load()
    store.record(keyA, job('varia_1'))
    store.record(keyA, { ...job('varia_2'), location: 'us_central' })
    // Nor does an odd update of a kept job remove the record it would have replaced.
    store.record(keyB, { ...job('varia_1'), location: 'us_central' })
    expect(store.forKeys([keyA]).map(record => record.jobId)).toEqual(['varia_1'])
    await store.flush()
    expect((await onDisk(directory)).records.map(record => record.jobId)).toEqual(['varia_1'])
  })

  it('marks Leave it running from the request own detached answer (index.ts), which may come before the query.cancel answer', async () => {
    const source = await readFile(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    expect(source).toContain("if (result.status === 'detached') { jobRecords.markDetached(jobKey, seen); return }")
    // A summary after a reload or crash replaced the page never reached a tab: nothing is dropped for it.
    expect(source).toContain("if (result.status === 'superseded' || generation !== rendererGeneration) return")
    // Read after SessionStore's purge, which deletes interrupted writes in the same folder.
    expect(source).toContain('void openSession.purge(retentionDays(settings)).catch(() => {}).then(() => jobRecords.load())')
    // A quit waits for the records written while the stop ends idle sessions.
    // A run Varia timed out had its job cancelled, as Stop does: its record goes.
    // A job Stop cancelled goes even if Leave it running marked it before (a later detached re-attach, or a detach that came too late).
    expect(source).toContain("seen.has(record.jobId) && (record.state === 'done' || result.status === 'cancelled' || result.status === 'timedOut')")
    // The crash prompt's BigQuery line is decided before the reset restarts the backend.
    expect(source).toMatch(/const hadBigQuery = backend\?\.hasProvider\('bigquery'\) \?\? false\n    resetRendererState/)
    expect(source).toContain('backend.stop().then(() => jobRecords.flush())')
  })

  it('defers drops for the keys a quit keeps, and applies them when the quit stops', async () => {
    const store = new JobRecordStore(await folder())
    await store.load()
    store.record(keyA, job('varia_1', 'done', 'open'))
    store.record(keyB, job('varia_2', 'done'))
    store.holdDrops([keyA])
    store.drop(keyA)
    store.drop(keyB)
    expect(store.list().map(record => record.jobKey)).toEqual([keyA])
    store.releaseHolds()
    expect(store.list()).toEqual([])
  })

  it('keeps bigquery.cancelJobs and bigquery.endIdleSessions main-only, and query.attach on the query lane', () => {
    expect(mainOnlyMethods).toEqual(expect.arrayContaining(['bigquery.cancelJobs', 'bigquery.endIdleSessions']))
    expect(Object.hasOwn(requestSchemas, 'bigquery.cancelJobs')).toBe(false)
    expect(Object.hasOwn(requestSchemas, 'bigquery.endIdleSessions')).toBe(false)
    expect(methodPolicies['bigquery.cancelJobs']).toEqual(expect.objectContaining({ sensitive: true, providers: ['bigquery'] }))
    expect(methodPolicies['query.attach']).toEqual(expect.objectContaining({ lane: 'query', deadlineMs: 0, providers: ['bigquery'] }))
    // Bounded strings: a job id past BigQuery's 1,024 characters, or with other characters, is refused.
    const params = { connectionId: keyA, sessionId: keyA, queryId: keyB, jobKey: keyA, jobId: 'varia_1', project: 'fictional-project', maxRows: 0, maxResultSets: 10, adoptSession: true }
    expect(queryAttachParamsSchema.safeParse(params).success).toBe(true)
    expect(queryAttachParamsSchema.safeParse({ ...params, jobId: 'x'.repeat(jobLimits.jobId + 1) }).success).toBe(false)
    expect(queryAttachParamsSchema.safeParse({ ...params, jobId: 'a/b' }).success).toBe(false)
    expect(queryAttachParamsSchema.safeParse({ ...params, extra: true }).success).toBe(false)
  })
})
