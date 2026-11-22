import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { jobLimits, jobRecordSchema, jobRecordsFileSchema, type JobRecord, type JobTransaction } from '../shared/bigquery/jobs'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'

/** The file's byte cap: 1,024 records of bounded strings fit well inside it. */
export const jobRecordsMaxBytes = 2 * 1024 * 1024
const posix = process.platform !== 'win32'

/** A `query.job` event as main records it, under the request's job key. */
export interface JobEventInput {
  readonly jobId: string; readonly project: string; readonly location?: string
  readonly state: 'running' | 'done'; readonly auxiliary: boolean; readonly transaction: JobTransaction
}

export interface JobRecordStoreOptions {
  readonly now?: () => number
  /** Called after a write fails; the records stay in memory and the next change writes them again. */
  readonly onWriteError?: (error: unknown) => void
}

/**
 * `WorkbenchSession/jobs.json` (docs/bigquery.md, Re-attaching to jobs): the BigQuery jobs main heard of through
 * `query.job` events, under their tab's job key, so a restore, a backend restart or a crash of the whole app can re-attach
 * to them. Written atomically on every change whatever the hot exit setting; an unreadable file is quarantined, never
 * overwritten. 64 records per key and 1,024 in all, past which the oldest finished records go first (a running job's
 * record is never dropped for space); records expire 24 hours after main first heard of their job. No secrets and no SQL text.
 *
 * While a quit is deciding, drops for the keys it will keep (`holdDrops`) are deferred, so a result that reaches a kept tab
 * after the prompt cannot drop the record the next start needs; `releaseHolds` applies them when the quit stops.
 */
export class JobRecordStore {
  private records: JobRecord[] = []
  private loaded: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()
  private held: ReadonlySet<string> = new Set()
  /** The file was read (or found missing): only then may a write replace it. */
  private readable = false
  private deferred: (() => void)[] = []
  private readonly now: () => number

  constructor(private readonly dir: string, private readonly options: JobRecordStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  private get path(): string { return join(this.dir, 'jobs.json') }

  /**
   * Reads the file once; later calls wait for the same read. Writes wait for it, and a read that failed (a locked file, a
   * refused quarantine) lets the next load try again and writes nothing meanwhile, so an unread file is never replaced.
   */
  load(): Promise<void> {
    const loading = this.loaded ??= (async () => {
      const read = await readJsonFile(this.path, jobRecordsMaxBytes)
      if (read.kind === 'missing') return
      const parsed = read.kind === 'ok' ? jobRecordsFileSchema.safeParse(read.value) : undefined
      if (!parsed?.success) { await quarantine(this.path); return }
      // Records made before the read finished are newer than the file's copy of the same job.
      const fresh = new Set(this.records.map(record => record.project + ':' + record.jobId))
      const kept = this.expire(parsed.data.records).filter(record => !fresh.has(record.project + ':' + record.jobId))
      this.records = [...kept, ...this.records]
      this.trim()
      if (kept.length !== parsed.data.records.length || fresh.size) this.persist()
    })()
    loading.then(() => { this.readable = true }, () => { if (this.loaded === loading) this.loaded = undefined })
    return loading
  }

  /** Every record, oldest first (a copy). */
  list(): readonly JobRecord[] { return this.expire(this.records).map(record => ({ ...record })) }
  forKeys(keys: Iterable<string>): readonly JobRecord[] { const set = new Set(keys); return this.expire(this.records).filter(record => set.has(record.jobKey)).map(record => ({ ...record })) }
  forProfile(profileId: string): readonly JobRecord[] { return this.expire(this.records).filter(record => record.profileId === profileId).map(record => ({ ...record })) }
  /** Records whose job key no open tab carries. Readers never see a record past its 24 hours, recorded or not since. */
  withoutTab(keys: Iterable<string>): readonly JobRecord[] { const set = new Set(keys); return this.expire(this.records).filter(record => !set.has(record.jobKey)).map(record => ({ ...record })) }

  /**
   * A request's `query.job` event: the job's record under `jobKey`, created or updated. A job already recorded under
   * another key moves to this one (a re-attach from another tab), so a crash afterwards still finds it. A record keeps the
   * transaction state its job started with and when main first heard of it.
   */
  record(jobKey: string, event: JobEventInput, profileId?: string): void {
    this.records = this.expire(this.records)
    const index = this.records.findIndex(record => record.jobId === event.jobId && record.project === event.project)
    const existing = index < 0 ? undefined : this.records[index]
    const next: JobRecord = {
      jobKey, jobId: event.jobId, project: event.project, ...event.location ? { location: event.location } : {},
      ...(profileId ?? existing?.profileId) ? { profileId: profileId ?? existing?.profileId } : {},
      createdAt: existing?.createdAt ?? this.now(), state: event.state, auxiliary: event.auxiliary,
      ...existing?.detached ? { detached: true } : {}, transaction: existing?.transaction ?? event.transaction
    }
    // A detached job found DONE has nothing left to re-attach to; a reference the file's schema refuses is not kept, so
    // one odd event never quarantines every other record at the next start.
    // A refused update keeps the record it would have replaced.
    if (!jobRecordSchema.safeParse(next).success) return
    if (existing) this.records.splice(index, 1)
    if (next.detached && next.state === 'done') { this.persist(); return }
    this.records.push(next)
    this.trim()
    this.persist()
  }

  /** Leave it running on Close Results: the request's running jobs (`jobIds`, those it reported) only hold the session's
   *  queue on a re-attach. Another job under the key (one kept from a lost backend) keeps its own mode. */
  markDetached(jobKey: string, jobIds: ReadonlySet<string>): void {
    let changed = false
    for (const record of this.records) if (record.jobKey === jobKey && jobIds.has(record.jobId) && record.state === 'running' && !record.detached) { record.detached = true; changed = true }
    if (changed) this.persist()
  }

  /**
   * Drops the key's records (all, or those `which` picks): Leave it running on a tab close or session end, a finished
   * job whose results reached the tab, a tab closed without leaving its detached job. Deferred while a quit holds the key.
   */
  drop(jobKey: string, which: (record: JobRecord) => boolean = () => true): void {
    if (this.held.has(jobKey)) { this.deferred.push(() => this.drop(jobKey, which)); return }
    const before = this.records.length
    this.records = this.records.filter(record => record.jobKey !== jobKey || !which(record))
    if (this.records.length !== before) this.persist()
  }

  /** Drops records by job id (bigquery.cancelJobs' jobs, the records dialog's Keep). */
  dropJobs(jobIds: Iterable<string>): void {
    const ids = new Set(jobIds), before = this.records.length
    this.records = this.records.filter(record => !ids.has(record.jobId))
    if (this.records.length !== before) this.persist()
  }

  /** From the start of quit: drops for these keys wait (`releaseHolds`). */
  holdDrops(keys: Iterable<string>): void { this.held = new Set([...keys].slice(0, jobLimits.keys)) }
  /** A quit stopped or abandoned: the drops it held are applied. */
  releaseHolds(): void {
    this.held = new Set()
    for (const drop of this.deferred.splice(0)) drop()
  }

  /** Waits for the writes so far (quit, tests). */
  flush(): Promise<void> { return this.queue }

  private expire(records: readonly JobRecord[]): JobRecord[] {
    const cutoff = this.now() - jobLimits.lifetimeMs
    return records.filter(record => record.createdAt > cutoff)
  }

  /** Past a limit the oldest finished records go first; running records stay even then. */
  private trim(): void {
    const perKey = new Map<string, number>()
    for (const record of this.records) perKey.set(record.jobKey, (perKey.get(record.jobKey) ?? 0) + 1)
    const drop = new Set<JobRecord>()
    let total = this.records.length
    for (const record of this.records) {
      if (record.state === 'running') continue
      const count = perKey.get(record.jobKey)!
      if (count > jobLimits.perKey || total > jobLimits.records) { drop.add(record); perKey.set(record.jobKey, count - 1); total-- }
    }
    if (drop.size) this.records = this.records.filter(record => !drop.has(record))
    // Only running records left past the cap: the newest is not kept, so the file stays within its schema.
    if (this.records.length > jobLimits.records) this.records = this.records.slice(0, jobLimits.records)
  }

  private persist(): void {
    this.queue = this.queue.then(async () => {
      if (!this.readable) await this.load()
      // Taken when the write runs, after the read merged the file's records in.
      const snapshot = { version: 1 as const, records: this.records.map(record => ({ ...record })) }
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      if (posix) await chmod(this.dir, 0o700).catch(() => {})
      await writeJsonAtomic(this.path, snapshot, jobRecordsMaxBytes, 'The BigQuery job records are too large.', { mode: 0o600 })
    }).catch(error => { this.options.onWriteError?.(error) })
  }
}
