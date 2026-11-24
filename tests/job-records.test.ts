import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobRecordStore, noteJobConnection, profileDeleteJobs, type JobEventInput } from '../src/main/job-records'
import type { JobRecord } from '../src/shared/bigquery/jobs'
import { jobLimits, jobRecordsFileSchema, queryAttachParamsSchema } from '../src/shared/bigquery/jobs'
import { mainOnlyMethods, methodPolicies } from '../src/shared/ipc/methods'
import { requestSchemas } from '../src/main/validation'

const directories: string[] = []
// A store's last write may still be finishing on Windows when a test ends: retry the removal.
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
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
    await open.flush()
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
    await Promise.all([store.flush(), running.flush()])
  })

  it("asks a profile delete about every running job but those the backend reported on a live connection through that profile", () => {
    const record = (jobId: string, patch: Partial<JobRecord> = {}): JobRecord => ({ jobKey: keyA, jobId, project: 'p', profileId: 'P0', createdAt: 1, state: 'running', auxiliary: false, transaction: 'none', ...patch })
    const records = [record('in_tab'), record('reference'), record('other_profile'), record('gone'), record('done', { state: 'done' }), record('elsewhere', { profileId: 'P9' })]
    const connections: Record<string, string> = { in_tab: 'c0', other_profile: 'c1', gone: 'c2' }
    const asked = profileDeleteJobs(records, 'P0', jobId => connections[jobId], connectionId => connectionId !== 'c2', connectionId => ({ c0: 'P0', c1: 'P1' })[connectionId])
    // A reference the tab only holds (a failed re-attach, a passed-over job), one run through another profile's live
    // connection and one whose connection is gone are asked; the one running in a tab connected through P0 is not.
    expect(asked.map(item => item.jobId)).toEqual(['reference', 'other_profile', 'gone'])
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
    // A burst of changes queued behind one write rides on it: one more attempt, not one per change.
    for (let index = 0; index < 20; index++) store.record(keyA, job(`varia_burst_${index}`))
    await store.flush()
    expect(errors).toHaveLength(2)
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

  it("wires main's record cancels: profiles from connect, restored cancels, jobs without a tab and profile deletes (index.ts)", async () => {
    const source = await readFile(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    expect(source).toContain('if (outcome.ok) await rememberConnectionProfile(')
    expect(source).toContain("jobRecorder(queryId!, jobKey, profileOf(")
    // Deleting a profile drops records only after the profile is gone, and open handles stop naming it; a handle handed
    // back again is re-matched once its profile no longer exists; a failed re-attach's job is asked about at a delete.
    expect(source).toMatch(/const removed = await library\.remove\(id\)\s+if \(running\.length\) jobRecords\.dropJobs/)
    expect(source).toContain('for (const [connectionId, profileId] of [...connectionProfiles]) if (profileId === id) connectionProfiles.delete(connectionId)')
    expect(source).toContain('if (kept !== undefined && matching.some(item => item.id === kept)) return')
    // A failed re-attach keeps its connection (the backend may hold the job); one its identity check refused drops its record.
    expect(source).not.toContain('jobConnections.delete(jobId)')
    expect(source).toContain("if (attachJobId !== undefined && !seen.has(attachJobId) && result.status === 'failed' && result.error?.code === 'AUTH_IDENTITY') jobRecords.drop(jobKey, record => record.jobId === attachJobId)")
    // Deleting a connection lists ten job ids and counts the rest, in its first box and its failed-cancel box.
    expect(source).toContain('ids = listedIds(running.map(record => record.jobId))')
    // Deleting a profile leaves the jobs of tabs still connected through it (running or left running) to those tabs.
    expect(source).toContain("jobRecorder(queryId!, jobKey, profileOf((validated as { connectionId?: string }).connectionId ?? ''), (validated as { connectionId?: string }).connectionId, method === 'query.attach' ? (validated as { jobId?: string }).jobId : undefined)")
    expect(source).toContain("profileDeleteJobs(jobRecords.forProfile(id), id, jobId => jobConnections.get(jobId), connectionId => backend.hasConnection(connectionId), connectionId => connectionProfiles.get(connectionId))")
    expect(source).toMatch(/seen\.add\(event\.jobId\); jobRecords\.record\(jobKey, event, profileId\)\s+if \(connectionId !== undefined\) noteJobConnection\(jobConnections, event\.jobId, connectionId, \(\) => jobRecords\.list\(\)\.map\(record => record\.jobId\), jobLimits\.records\)/)
    expect(source).toContain('detail: `${listedIds(failed)}')
    expect(source).toMatch(/function listedIds[^]*?… and \$\{jobIds\.length - 10\} more/)
    // A connection that runs a job moves to the end, so the 512 bound evicts idle handles, not a busy long-lived one.
    expect(source).toMatch(/function profileOf\(connectionId: string\)[^]*?connectionProfiles\.delete\(connectionId\); connectionProfiles\.set\(connectionId, profile\)/)
    expect(source).toContain("jobRecords.record(jobKey, event, profileId)")
    expect(source).toContain("handle('varia:jobs-cancel-restored', async value => {\n    const keys = z.array(jobKeySchema).min(1).max(jobLimits.keys).parse(value)")
    expect(source).toContain("handle('varia:jobs-without-tab', async value => {\n    const { keys, liveProjects } = jobsWithoutTabRequestSchema.parse(value)")
    // A copy AutoRecover may still reopen keeps its jobs; a store that cannot be read asks about nothing.
    expect(source).toContain('const orphans = jobRecords.withoutTab([...keys, ...kept])')
    // A box a reload, crash or close took away (pageDialog's fallback) drops nothing.
    expect(source).toMatch(/\{ response: -1, checkboxChecked: false \}, true\)\n    \/\/ A box a reload[^\n]*\n    if \(response < 0\) return null/)
    // Connect's chosen entry wins over a twin with the same settings.
    expect(source).toContain('const profile = matching.find(item => item.id === selected) ?? matching[0]')
    // A new window (macOS) holds no earlier quit's keys; a close that went through discards its held drops, so the tabs it
    // kept reopen with their records.
    expect(source).toMatch(/releaseQuitJobs\(!closeApproved\)\n  closeApproved = false/)
    // Only jobs recorded before the review asked; a disconnected handle forgets its profile.
    expect(source).toContain('const orphans = jobRecords.withoutTab([...keys, ...kept]).filter(record => record.createdAt < asked)')
    expect(source).toContain('if (value.disconnected) connectionProfiles.delete(connectionId)')
    // Show in Job History is offered only when a project can be shown: connected now, or with its saved connection.
    expect(source).toContain('const show = jobsByProject(running, profileIds, new Set(liveProjects))')
    expect(source).toContain("const buttons = showable ? [one ? 'Cancel Job' : 'Cancel Jobs', 'Show in Job History', 'Keep'] : [one ? 'Cancel Job' : 'Cancel Jobs', 'Keep']")
    expect(source).toContain('buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1')
    // Show in Job History drops the records as Keep does and hands the jobs, by project, to Job History.
    expect(source).toContain("if (showable && response === 1) { jobRecords.dropJobs(jobIds); return { answer: 'show' as const, jobIds, show } }")
    // Deleting a profile with running jobs asks, and keeps the profile when a cancel fails.
    // A SQL Server delete reads no job records; Keep Connection after failed cancels still says what the others noted.
    expect(source).toContain('const unread = bigQuery && await jobRecords.load().then(() => false, () => true)')
    expect(source).toMatch(/could not be cancelled\.\$\{notes\.length \? ` \$\{notes\.slice\(0, 5\)\.join\(' '\)\}` : ''\}`\)/)
    // A cancel through main drops only the records it read: a job started while it waited keeps its record.
    expect(source).toMatch(/const records = jobRecords\.forKeys\(keys\)\n    const cancel = await cancelRecordedJobs\(records\.filter[^\n]*\n    jobRecords\.dropJobs\(records\.map\(record => record\.jobId\)\)/)
    expect(source).toContain("buttons: ['Delete Anyway', 'Keep Connection'], defaultId: 1, cancelId: 1")
    expect(source).toContain('if (anyway !== 0) throw new Error(`The connection was kept')
    // Records that cannot be read ask before a BigQuery connection goes; reads leave out expired records.
    expect(source).toContain('const failed = [...cancel.uncancellable, ...cancel.jobs.filter(job => !job.cancelled).map(job => job.jobId)]')
    // A review from a page replaced while it read asks nothing; its successor asks.
    expect(source).toMatch(/if \(generation !== rendererGeneration\) return null\n    const orphans/)
    // Records unread decide nothing (a Keep would come back with the file); no running orphan reads no recovery copy.
    expect(source).toMatch(/if \(!\(await jobRecords\.load\(\)\.then\(\(\) => true, \(\) => false\)\)\) return null\n[^\n]*\n    if \(!jobRecords\.withoutTab\(keys\)\.some\([^\n]*\) return null\n[^\n]*\n    const kept = await recovery\.jobKeys\(\)/)
    // Profiles that cannot be read list every job as not cancelled, with why, instead of failing the answer silently.
    expect(source).toMatch(/profiles = bigQueryStore \? \(await bigQueryStore\.load\(\)\)\.library\.profiles : \[\]\n  \} catch \(error\) \{[\s\S]{0,300}return \{ jobs: records\.map\(record => \(\{ jobId: record\.jobId, cancelled: false, error: message \}\)\), uncancellable: \[\] \}/)
    // A SQL Server delete never fails with BigQuery's file.
    expect(source).toContain('(await bigQueryStore.load().catch(() => undefined))?.library.profiles.some(profile => profile.id === id)')
    // The review runs only after a restore that worked.
    const workbench = await readFile(join(__dirname, '..', 'src', 'renderer', 'src', 'core', 'workbench.ts'), 'utf8')
    expect(workbench).toContain('if (restored) void queries.reviewJobsWithoutTab(api, showJobsWithoutTab, () => jobHistory.liveProjects())')
    // Show in Job History connects the records' saved connection directly, never through the Connect dialog.
    expect(workbench).toMatch(/const showJobsWithoutTab = [^]*?connectBigQueryProfile\([^]*?jobHistory\.forget\(project\)/)
    expect(workbench).not.toMatch(/const showJobsWithoutTab = [^]*?'connection\.connect'[^]*?\n  if \(api\.hotExit\)/)
    expect(workbench).toContain('.then(opened => opened >= 0, () => false).then(restored => {')
    // What the cancels noted is said before the connection goes.
    expect(source).toContain("const notes = cancelNotesText('BigQuery', cancel.jobs)")
    // Credentials are the saved profile's, per project, at most jobLimits.cancel per call.
    expect(source).toContain('for (let next = 0; next < group.length; next += jobLimits.cancel)')
    expect(source).toContain("handle('varia:confirm-running-job', async value => {\n    const request = runningJobRequestSchema.parse(value)")
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
    // A close that went through (macOS) discards the held drops: the kept tab reopens with its record.
    store.record(keyA, job('varia_3', 'done'))
    store.holdDrops([keyA])
    store.drop(keyA)
    store.releaseHolds(false)
    expect(store.list().map(record => record.jobId)).toEqual(['varia_3'])
    store.drop(keyA)
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
  it("keeps a recorded job's connection when later jobs fill the map, dropping unrecorded ones first", () => {
    const connections = new Map<string, string>()
    noteJobConnection(connections, 'job_long', 'bq-a', () => ['job_long'], 3)
    for (let index = 0; index < 5; index++) noteJobConnection(connections, `job_${index}`, 'bq-b', () => ['job_long'], 3)
    expect(connections.get('job_long')).toBe('bq-a')
    expect(connections.get('job_4')).toBe('bq-b')
    expect(connections.size).toBeLessThanOrEqual(3)
  })
})
