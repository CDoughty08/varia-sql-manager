import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { documentKinds, type DocumentKind } from '../shared/contracts'
import { recoveryCapMessage, recoveryLimits, type RecoveryEntry, type RecoveryWrite } from '../shared/files/recovery'
import { quarantine, readJsonFile, writeBytesAtomic } from './json-file'
import type { SettingsStore } from './settings-store'
import { fileKinds, maxSqlFileBytes } from './sql-files'

const fits = (value: { kind: DocumentKind; text: string }) => value.text.length <= fileKinds[value.kind].maxChars
const eol = z.enum(['crlf', 'lf'])
const name = z.string().min(1).max(recoveryLimits.nameChars)
const server = z.string().min(1).max(recoveryLimits.serverChars)
const database = z.string().min(1).max(recoveryLimits.databaseChars)
// Lower-case, as crypto.randomUUID() makes them: a record has one file name, so the caps, the list and the purge all see it.
const recordId = z.uuid().regex(/^[0-9a-f-]{36}$/, 'An AutoRecover id is a lower-case uuid.')
/** varia:recovery-write: the query's text, at most its kind's limit, and what the dialog shows about it. */
export const recoveryWriteSchema = z.object({
  id: recordId, name, kind: z.enum(documentKinds), fileId: z.uuid().optional(), eol, server: server.optional(), database: database.optional(), text: z.string().max(maxSqlFileBytes)
}).strict().refine(fits, 'The query is too large for AutoRecover.')
export const recoveryDiscardSchema = z.object({ ids: z.array(recordId).min(1).max(recoveryLimits.discardIds) }).strict()
export const recoveryTakeSchema = z.object({ id: recordId }).strict()

/** One record, `<id>.json`. `owner` is the main process (`instance`) and renderer generation that wrote or took it. */
const recordSchema = z.object({
  version: z.literal(1), id: recordId, owner: z.object({ instance: z.uuid(), generation: z.int().min(0) }).strict(),
  name, kind: z.enum(documentKinds), path: z.string().min(1).max(recoveryLimits.pathChars).optional(), eol, server: server.optional(), database: database.optional(),
  savedAt: z.iso.datetime(), text: z.string().max(maxSqlFileBytes)
}).strict().refine(fits)
export type RecoveryRecord = z.infer<typeof recordSchema>

// In any case: this version names records only in lower case, but one in upper case (written by hand, or by a build
// before that rule) still counts against the caps and is purged; `list` quarantines it rather than offer it.
const recordName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i
/** What a quarantine (`readJsonFile`'s callers' `quarantine`) leaves of an invalid record, and an interrupted write's temporary file. */
const leftover = /^([0-9a-f-]{36}\.json\.invalid-[0-9a-f-]{36}\.json|\.varia-[0-9a-f-]{36}\.tmp)$/i
const dayMs = 86_400_000
const posix = process.platform !== 'win32'

export interface RecoveryStoreOptions {
  /** This main process; records another one wrote are offered. */
  readonly instance?: string
  readonly now?: () => Date
  /** Smaller caps, for tests: records and bytes in all. */
  readonly caps?: { readonly records: number; readonly totalBytes: number }
}
interface RecordFile { readonly id: string; readonly file: string; readonly canonical: boolean; readonly size: number; readonly mtimeMs: number }
interface Listed { readonly size: number; readonly mtimeMs: number; readonly entry: RecoveryEntry; readonly owner: RecoveryRecord['owner'] }

/**
 * `<userData>/AutoRecover/`: a copy of each query with unsaved changes, kept until the query is saved, closed or
 * discarded, so a crash, a kill or a power loss does not lose it. The folder is 0700 and each record 0600 on POSIX
 * (Windows' user profile is the user's alone), and each is written atomically. Records hold the query's text and what
 * the Recover dialog shows (name, original path, server, database), never results, connections or credentials.
 *
 * A record belongs to the main process and renderer generation that wrote it. A page may write only a new record or
 * one its own generation owns, so it cannot replace what an earlier page left before that is offered; `list` offers
 * every other record: an earlier run's (the app crashed or was killed) and an earlier generation's (the renderer
 * crashed, hung, or reloaded). Taking a record moves it to the current generation, which protects it until the
 * reopened query writes or discards it. Work runs one task at a time; nothing here logs a record's content.
 */
export class RecoveryStore {
  readonly instance: string
  private queue: Promise<void> = Promise.resolve()
  /** Records this process owns, by the generation that may write or discard them. */
  private owned = new Map<string, number>()
  /** Records `list` offered, by the generation it offered them to: it may take or discard them. */
  private offered = new Map<string, number>()
  /** What `list` read of each record, while its size and time are unchanged: a record is parsed once. */
  private listed = new Map<string, Listed>()
  private prepared = false
  constructor(private readonly dir: string, private readonly options: RecoveryStoreOptions = {}) {
    this.instance = options.instance ?? randomUUID()
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }
  private now(): Date { return this.options.now?.() ?? new Date() }
  private path(id: string): string { return join(this.dir, id + '.json') }
  /** Whether `generation` of this process has kept any query: the crash and hang prompts say AutoRecover has them. */
  hasRecords(generation: number): boolean { return [...this.owned.values()].includes(generation) }

  /** The folder, created user-only; one created before (or by an older version) is made user-only again. */
  private async prepare(): Promise<void> {
    if (this.prepared) return
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (posix) await chmod(this.dir, 0o700)
    this.prepared = true
  }
  /** Record files and their sizes, other than `except`'s own file; none while the folder does not exist. `id` is lower-case,
   *  and `canonical` says whether the file is named so. */
  private async records(except?: string): Promise<RecordFile[]> {
    let names: string[]
    try { names = await readdir(this.dir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const found: RecordFile[] = []
    for (const file of names) {
      const id = recordName.exec(file)?.[1]?.toLowerCase()
      if (!id || (except !== undefined && file === except + '.json')) continue
      try {
        const info = await stat(join(this.dir, file))
        if (info.isFile()) found.push({ id, file, canonical: file === id + '.json', size: info.size, mtimeMs: info.mtimeMs })
      } catch { /* Removed meanwhile. */ }
    }
    return found
  }

  /**
   * Keeps `request`'s query for `generation`, replacing that generation's earlier copy. A record another process or
   * generation owns is refused, and so is a write past 64 records or 256 MB in all.
   */
  write(request: RecoveryWrite & { readonly path?: string }, generation: number): Promise<void> {
    return this.serial(async () => {
      const mine = this.owned.get(request.id)
      if (mine !== undefined && mine !== generation) throw new Error('This AutoRecover copy belongs to an earlier window.')
      if (mine === undefined && await stat(this.path(request.id)).then(() => true, () => false)) throw new Error('This AutoRecover copy belongs to an earlier window.')
      const record: RecoveryRecord = {
        version: 1, id: request.id, owner: { instance: this.instance, generation }, name: request.name, kind: request.kind,
        ...request.path && request.path.length <= recoveryLimits.pathChars ? { path: request.path } : {}, eol: request.eol,
        ...request.server ? { server: request.server } : {}, ...request.database ? { database: request.database } : {}, savedAt: this.now().toISOString(), text: request.text
      }
      const bytes = Buffer.from(JSON.stringify(record) + '\n')
      if (bytes.length > recoveryLimits.recordBytes) throw new Error('The query is too large for AutoRecover.')
      const others = await this.records(request.id)
      const caps = this.options.caps ?? recoveryLimits
      if (others.length + 1 > caps.records || others.reduce((total, other) => total + other.size, 0) + bytes.length > caps.totalBytes) throw new Error(recoveryCapMessage)
      await this.prepare()
      await writeBytesAtomic(this.path(request.id), bytes, { mode: 0o600 })
      this.owned.set(request.id, generation)
      this.listed.delete(request.id)
    })
  }

  /**
   * The records `generation` may recover, newest first, without their text: every record but those it owns. An invalid
   * record is quarantined beside the others (never offered, and purged with them).
   */
  list(generation: number): Promise<RecoveryEntry[]> {
    return this.serial(async () => {
      const entries: RecoveryEntry[] = []
      for (const file of await this.records()) {
        if (!file.canonical) { await quarantine(join(this.dir, file.file)).catch(() => {}); continue }
        let listed = this.listed.get(file.id)
        if (!listed || listed.size !== file.size || listed.mtimeMs !== file.mtimeMs) {
          // One record that cannot be read now (locked, access denied) is left for a later list.
          const record = await this.read(file.id).catch(() => undefined)
          if (!record) continue
          listed = { size: file.size, mtimeMs: file.mtimeMs, owner: record.owner, entry: entryOf(record) }
          this.listed.set(file.id, listed)
        }
        const owner = this.owned.get(file.id) ?? (listed.owner.instance === this.instance ? listed.owner.generation : undefined)
        if (owner === generation) continue
        this.offered.set(file.id, generation)
        entries.push(listed.entry)
      }
      return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name))
    })
  }

  /** A record offered to `generation`, with its text, moved to that generation. One the generation already took (or wrote)
   *  is not offered to it again: two tabs would share one record, and closing either would delete the other's copy. */
  take(id: string, generation: number): Promise<RecoveryRecord> {
    return this.serial(async () => {
      if (this.offered.get(id) !== generation) throw new Error('This query is no longer offered for recovery.')
      const record = await this.read(id)
      if (!record) throw new Error('The AutoRecover copy of this query could not be read.')
      this.owned.set(id, generation)
      this.offered.delete(id)
      return record
    })
  }

  /** Deletes records `generation` owns or was offered; any other id is left alone. */
  discard(ids: readonly string[], generation: number): Promise<void> {
    return this.serial(async () => {
      for (const id of ids) if (this.owned.get(id) === generation || this.offered.get(id) === generation) await this.remove(id)
    })
  }
  /** Deletes every record `generation` owns: its window closed after each query was saved or discarded. */
  discardOwned(generation: number): Promise<void> {
    return this.serial(async () => {
      for (const [id, owner] of [...this.owned]) if (owner === generation) await this.remove(id)
    })
  }

  /**
   * Deletes records, quarantined records, and interrupted writes older than `keepDays` (Keep AutoRecover information
   * for), by when they were last written. It waits for the setting, and deletes nothing when settings could not be read.
   * Temporary files are always leftovers: no write runs alongside this.
   */
  purge(keepDays: Promise<number>): Promise<void> {
    return this.serial(async () => {
      let days: number
      try { days = await keepDays } catch { return }
      if (!Number.isSafeInteger(days) || days < 1) return
      let names: string[]
      try { names = await readdir(this.dir) } catch { return }
      const cutoff = this.now().getTime() - days * dayMs
      for (const file of names) {
        const id = recordName.exec(file)?.[1]?.toLowerCase(), temporary = file.startsWith('.varia-')
        if ((!id && !leftover.test(file)) || (id && file === id + '.json' && this.owned.has(id))) continue
        try {
          const info = await stat(join(this.dir, file))
          if (info.isFile() && (temporary || info.mtimeMs < cutoff)) await rm(join(this.dir, file), { force: true })
        } catch { /* Removed meanwhile, or locked: the next start tries again. */ }
        if (id) { this.listed.delete(id); this.offered.delete(id) }
      }
    })
  }

  private async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
    this.owned.delete(id)
    this.offered.delete(id)
    this.listed.delete(id)
  }
  /** A record, or undefined when it is gone or invalid (then quarantined). Read failures are thrown. */
  private async read(id: string): Promise<RecoveryRecord | undefined> {
    const read = await readJsonFile(this.path(id), recoveryLimits.recordBytes)
    if (read.kind === 'missing') return undefined
    const parsed = read.kind === 'ok' ? recordSchema.safeParse(read.value) : undefined
    if (parsed?.success && parsed.data.id === id) return parsed.data
    await quarantine(this.path(id)).catch(() => {})
    this.listed.delete(id)
    return undefined
  }
}

const retentionKey = 'environment.autoRecover.keepDays'
/**
 * Keep AutoRecover information for, for the startup purge, once settings load. It rejects (and the purge deletes nothing)
 * when settings.json cannot be read, or held a retention that was reset to the default because the file or that value
 * was invalid: the user may have chosen to keep copies longer.
 */
export async function retentionDays(settings: Pick<SettingsStore, 'load' | 'wasReset'>): Promise<number> {
  const { values } = await settings.load()
  if (settings.wasReset(retentionKey)) throw new Error('Keep AutoRecover information for was reset.')
  return values[retentionKey]
}

const entryOf = (record: RecoveryRecord): RecoveryEntry => ({
  id: record.id, name: record.name, kind: record.kind, ...record.path ? { path: record.path } : {}, savedAt: record.savedAt, characters: record.text.length,
  ...record.server ? { server: record.server } : {}, ...record.database ? { database: record.database } : {}
})
