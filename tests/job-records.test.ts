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
    store.markDetached(keyA)
    expect(store.list()).toEqual([expect.objectContaining({ detached: true })])
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
