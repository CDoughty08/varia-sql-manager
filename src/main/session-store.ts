import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { documentKinds, type DocumentKind } from '../shared/contracts'
import { sessionLimits, type SessionWrite } from '../shared/files/session'
import { quarantine, readJsonFile, replaceFile, writeBytesAtomic } from './json-file'
import { fileKinds, maxSqlFileBytes } from './sql-files'

const fits = (value: { kind: DocumentKind; text?: string }) => value.text === undefined || value.text.length <= fileKinds[value.kind].maxChars
const name = z.string().min(1).max(sessionLimits.nameChars)
const server = z.string().min(1).max(sessionLimits.serverChars)
const database = z.string().min(1).max(sessionLimits.databaseChars)
const fields = { name, baseName: name.optional(), kind: z.enum(documentKinds), eol: z.enum(['crlf', 'lf']), dirty: z.boolean(), pinned: z.boolean().optional(), server: server.optional(), database: database.optional(), text: z.string().max(maxSqlFileBytes).optional() }
/** varia:session-write: the tabs in strip order. Only a clean tab with a file may leave its text out (it reopens from the file). */
export const sessionWriteSchema = z.object({
  documents: z.array(z.object({ ...fields, fileId: z.uuid().optional() }).strict()
    .refine(fits, 'A query is too large to keep for the next start.')
    .refine(document => document.text !== undefined || (!!document.fileId && !document.dirty), 'A query without a file must keep its text.')).max(sessionLimits.documents),
  activeIndex: z.int().min(-1).max(sessionLimits.documents - 1)
}).strict()

/** `session.json`: what main wrote at the last close, with each file's path in place of its id. */
const recordSchema = z.object({
  version: z.literal(1), savedAt: z.iso.datetime(),
  documents: z.array(z.object({
    ...fields, path: z.string().min(1).max(sessionLimits.pathChars).optional(), fileSha256: z.string().regex(/^[0-9a-f]{64}$/).optional()
  }).strict().refine(fits)
    .refine(document => document.text !== undefined || (!!document.path && !document.dirty))
    .refine(document => document.fileSha256 === undefined || (!!document.path && document.text !== undefined))).max(sessionLimits.documents),
  activeIndex: z.int().min(-1).max(sessionLimits.documents - 1)
}).strict()
export type SessionRecord = z.infer<typeof recordSchema>
export type SessionRecordDocument = SessionRecord['documents'][number]
/** What `write` takes: the page's request with main's paths and disk baselines in place of file ids. */
export type SessionInput = Omit<SessionWrite, 'documents'> & { readonly documents: readonly (Omit<SessionWrite['documents'][number], 'fileId'> & Pick<SessionRecordDocument, 'path' | 'fileSha256'>)[] }

/** Why a write was refused at the cap; a fixed sentence, as the banner shows it. */
export const sessionCapMessage = 'The open queries are too large to keep for the next start (64 MB in all).'
const posix = process.platform !== 'win32'

export interface SessionStoreOptions { readonly now?: () => Date; readonly totalBytes?: number }

/** Prepares the same bounded record for disk on quit or a one-use in-memory reload checkpoint. */
export function encodeSession(session: SessionInput, options: SessionStoreOptions = {}) {
  const reopens = session.documents.map((document, index) => ({ document, index })).filter(({ document }) => {
    const reopen = document.text !== undefined || (!!document.path && document.path.length <= sessionLimits.pathChars)
    if (!reopen && document.pinned) throw new Error(`Pinned tab “${document.name}” has no file that can be reopened. Save it again or unpin it.`)
    return reopen
  })
  const record: SessionRecord = {
    version: 1, savedAt: (options.now?.() ?? new Date()).toISOString(), activeIndex: reopens.findIndex(({ index }) => index === session.activeIndex),
    documents: reopens.map(({ document }) => ({
      name: document.name, ...document.baseName ? { baseName: document.baseName } : {}, kind: document.kind, eol: document.eol, dirty: document.dirty,
      ...document.pinned ? { pinned: true } : {},
      ...document.path && document.path.length <= sessionLimits.pathChars ? {
        path: document.path, ...document.text !== undefined && document.fileSha256 ? { fileSha256: document.fileSha256 } : {}
      } : {},
      ...document.server ? { server: document.server } : {}, ...document.database ? { database: document.database } : {},
      ...document.text !== undefined ? { text: document.text } : {}
    }))
  }
  const bytes = Buffer.from(JSON.stringify(record) + '\n')
  if (bytes.length > (options.totalBytes ?? sessionLimits.totalBytes)) throw new Error(sessionCapMessage)
  return { record, bytes }
}

/**
 * `<userData>/Session/`: hot exit's copy of the open tabs, written once as a normal close goes ahead instead of asking to
 * save them. The folder is 0700 and the file 0600 on POSIX, written atomically; it holds text, names, paths, server and
 * database names, never results, connections or credentials, and nothing here logs its content.
 *
 * The next start takes `session.json` and keeps it as `previous.json` until that run closes: a run that crashes or is
 * killed before its own close leaves it, and the next process's first page reopens it again (AutoRecover offers what
 * changed since), so a restore never loses text. A close keeps a new session (and drops `previous.json`) or, with hot
 * exit off, keeps only pins or drops both if there are none. A later page of the same process (a reload) takes only a session written since, as on macOS,
 * where closing the window leaves the app running. Work runs one task at a time.
 */
export class SessionStore {
  private queue: Promise<void> = Promise.resolve()
  private prepared = false
  /** The page generation whose close kept the session, if any. */
  private kept: number | undefined
  constructor(private readonly dir: string, private readonly options: SessionStoreOptions = {}) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }
  private get current(): string { return join(this.dir, 'session.json') }
  private get previous(): string { return join(this.dir, 'previous.json') }
  /** Whether `generation`'s close kept its tabs: its window may then close without deleting them. */
  keptBy(generation: number): boolean { return this.kept === generation }

  private async prepare(): Promise<void> {
    if (this.prepared) return
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (posix) await chmod(this.dir, 0o700)
    this.prepared = true
  }

  /** Keeps `session` for the next start, for `generation`'s close, replacing whatever was kept before. */
  write(session: SessionInput, generation: number): Promise<void> {
    return this.serial(async () => {
      const { bytes } = encodeSession(session, this.options)
      await this.prepare()
      await writeBytesAtomic(this.current, bytes, { mode: 0o600 })
      await rm(this.previous, { force: true })
      this.kept = generation
    })
  }

  /**
   * The session to reopen, or undefined. `session.json` moves to `previous.json`, which `previous` (the process's first
   * page) also reopens when there is no newer one. An invalid file is quarantined beside it; read failures are thrown.
   */
  take(previous: boolean): Promise<SessionRecord | undefined> {
    return this.serial(async () => {
      const current = await this.read(this.current)
      if (current) {
        await replaceFile(this.current, this.previous)
        return current
      }
      return previous ? this.read(this.previous) : undefined
    })
  }

  /** Deletes what was kept when the close leaves no session to reopen. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await rm(this.current, { force: true })
      await rm(this.previous, { force: true })
      this.kept = undefined
    })
  }

  private async read(path: string): Promise<SessionRecord | undefined> {
    const read = await readJsonFile(path, sessionLimits.totalBytes)
    if (read.kind === 'missing') return undefined
    const parsed = read.kind === 'ok' ? recordSchema.safeParse(read.value) : undefined
    if (parsed?.success) return parsed.data
    await quarantine(path).catch(() => {})
    return undefined
  }
}
