import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { documentKinds, type DocumentKind } from '../shared/contracts'
import { sessionLimits, type SessionWrite } from '../shared/files/session'
import { editorGroupsLayoutSchema, layoutViews, remapEditorGroups } from '../shared/editor-groups'
import { connectionWorkspaceSchema } from '../shared/connection-targets'
import { quarantine, readJsonFile, replaceFile, writeBytesAtomic } from './json-file'
import { fileKinds, maxDocumentCharacters } from './sql-files'

const fits = (value: { kind: DocumentKind; text?: string }) => value.text === undefined || value.text.length <= fileKinds[value.kind].maxChars
const name = z.string().min(1).max(sessionLimits.nameChars)
const server = z.string().min(1).max(sessionLimits.serverChars)
const database = z.string().max(sessionLimits.databaseChars)
const legacyFields = { name, baseName: name.optional(), kind: z.enum(documentKinds), eol: z.enum(['crlf', 'lf']), dirty: z.boolean(), pinned: z.boolean().optional(), server: server.optional(), database: database.min(1).optional(), text: z.string().max(maxDocumentCharacters).optional() }
const fields = { ...legacyFields, database: database.optional(), targetId: z.uuid().optional(), attachWanted: z.boolean().optional() }
const associated = (document: { kind: string; targetId?: string; attachWanted?: boolean; database?: string }) => document.targetId
  ? document.kind === 'sql' && document.attachWanted !== undefined && document.database !== undefined
  : document.attachWanted === undefined
const targetsPresent = (session: { documents: readonly { targetId?: string }[]; workspace?: { targets: readonly { id: string }[] } }) => {
  const ids = new Set(session.workspace?.targets.map(target => target.id))
  return session.documents.every(document => !document.targetId || ids.has(document.targetId))
}
/** varia:session-write: the tabs in strip order. Only a clean tab with a file may leave its text out (it reopens from the file). */
export const sessionWriteSchema = z.object({
  documents: z.array(z.object({ ...fields, fileId: z.uuid().optional() }).strict()
    .refine(associated, 'A query target requires its database and attachment preference.')
    .refine(fits, 'A query is too large to keep for the next start.')
    .refine(document => document.text !== undefined || (!!document.fileId && !document.dirty), 'A query without a file must keep its text.')).max(sessionLimits.documents),
  activeIndex: z.int().min(-1).max(sessionLimits.documents - 1),
  groups: editorGroupsLayoutSchema.optional(), workspace: connectionWorkspaceSchema.optional()
}).strict().refine(session => !session.groups || layoutViews(session.groups).every(view => view < session.documents.length), 'An editor group names a query that is not kept.')
  .refine(targetsPresent, 'A query names a connection target that is not kept.')

/** `session.json`: what main wrote at the last close, with each file's path in place of its id. */
const recordFields = { savedAt: z.iso.datetime(),
  activeIndex: z.int().min(-1).max(sessionLimits.documents - 1), groups: editorGroupsLayoutSchema.optional() }
const fileFields = { path: z.string().min(1).max(sessionLimits.pathChars).optional(), fileSha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }
const legacyRecordSchema = z.object({
  ...recordFields, version: z.literal(1),
  documents: z.array(z.object({ ...legacyFields, ...fileFields }).strict().refine(fits)
    .refine(document => document.text !== undefined || (!!document.path && !document.dirty))
    .refine(document => document.fileSha256 === undefined || (!!document.path && document.text !== undefined))).max(sessionLimits.documents)
}).strict().refine(session => !session.groups || layoutViews(session.groups).every(view => view < session.documents.length))
const recordSchema = z.object({
  ...recordFields, version: z.literal(2), workspace: connectionWorkspaceSchema.optional(),
  documents: z.array(z.object({
    ...fields, ...fileFields
  }).strict().refine(fits).refine(associated)
    .refine(document => document.text !== undefined || (!!document.path && !document.dirty))
    .refine(document => document.fileSha256 === undefined || (!!document.path && document.text !== undefined))).max(sessionLimits.documents),
}).strict().refine(session => !session.groups || layoutViews(session.groups).every(view => view < session.documents.length)).refine(targetsPresent)
/** Version 1 has only server hints. Migration cannot infer an account or manufacture a target association. */
const storedSessionSchema = z.union([recordSchema, legacyRecordSchema.transform(record => ({ ...record, version: 2 as const }))])
export type SessionRecord = z.infer<typeof recordSchema>
export type SessionRecordDocument = SessionRecord['documents'][number]
/** What `write` takes: the page's request with main's paths and disk baselines in place of file ids. */
export type SessionInput = Omit<SessionWrite, 'documents'> & { readonly documents: readonly (Omit<SessionWrite['documents'][number], 'fileId'> & Pick<SessionRecordDocument, 'path' | 'fileSha256'>)[] }

/** Why a write was refused at the cap; a fixed sentence, as the banner shows it. */
export const sessionCapMessage = 'The open queries are too large to keep for the next start (64 MB in all).'
const posix = process.platform !== 'win32'
/** What a quarantine of either file leaves (`json-file.ts`'s `quarantine`), and a write a crash interrupted (`writeBytesAtomic`'s temporary file). */
const leftover = /^((session|previous)\.json\.invalid-[0-9a-f-]{36}\.json|\.varia-[0-9a-f-]{36}\.tmp)$/i
const dayMs = 86_400_000

export interface SessionStoreOptions {
  readonly now?: () => Date
  readonly totalBytes?: number
  /** Hands out each kept tab without its file's path and baseline (sandbox-guard.ts's `profilePathsRefused`): whoever
   *  reopens it has no file to read, so a tab that kept its text reopens without a file and one that kept only its path does not reopen. */
  readonly pathsRefused?: boolean
}

/** Prepares the same bounded record for disk on quit or a one-use in-memory reload checkpoint. */
export function encodeSession(session: SessionInput, options: SessionStoreOptions = {}) {
  const reopens = session.documents.map((document, index) => ({ document, index })).filter(({ document }) => {
    const reopen = document.text !== undefined || (!!document.path && document.path.length <= sessionLimits.pathChars)
    if (!reopen && document.pinned) throw new Error(`Pinned tab “${document.name}” has no file that can be reopened. Save it again or unpin it.`)
    return reopen
  })
  // The groups follow their documents to their places in the record; a group of tabs left out goes.
  const places = new Map(reopens.map(({ index }, place) => [index, place]))
  const groups = session.groups ? remapEditorGroups(session.groups, index => places.get(index)) : undefined
  const record: SessionRecord = {
    version: 2, savedAt: (options.now?.() ?? new Date()).toISOString(), activeIndex: reopens.findIndex(({ index }) => index === session.activeIndex),
    documents: reopens.map(({ document }) => ({
      name: document.name, ...document.baseName ? { baseName: document.baseName } : {}, kind: document.kind, eol: document.eol, dirty: document.dirty,
      ...document.pinned ? { pinned: true } : {},
      ...document.path && document.path.length <= sessionLimits.pathChars ? {
        path: document.path, ...document.text !== undefined && document.fileSha256 ? { fileSha256: document.fileSha256 } : {}
      } : {},
      ...document.server ? { server: document.server } : {}, ...document.database !== undefined ? { database: document.database } : {},
      ...document.targetId ? { targetId: document.targetId, attachWanted: document.attachWanted } : {},
      ...document.text !== undefined ? { text: document.text } : {}
    })),
    ...groups ? { groups } : {}, ...session.workspace ? { workspace: session.workspace } : {}
  }
  recordSchema.parse(record)
  const bytes = Buffer.from(JSON.stringify(record) + '\n')
  if (bytes.length > (options.totalBytes ?? sessionLimits.totalBytes)) throw new Error(sessionCapMessage)
  return { record, bytes, sourceIndices: reopens.map(({ index }) => index) }
}

/** A skipped file must not shift another query onto its AutoRecover copy. */
export function encodeReloadSession(session: SessionInput, recoveryIds: readonly (string | null)[]) {
  const { record, sourceIndices } = encodeSession(session)
  return { record, recoveryIds: sourceIndices.map(index => recoveryIds[index] ?? null) }
}

/**
 * `<userData>/Session/`: hot exit's copy of the open tabs, written once as a normal close goes ahead instead of asking to
 * save them. The folder is 0700 and the file 0600 on POSIX, written atomically; it holds text, names, paths, server and
 * database names and nonsecret connection targets, never results, live handles or secrets, and nothing here logs its content.
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
      // A failed restore must not allow a later close to replace the only copy we could not read or quarantine.
      await this.read(this.current)
      await this.read(this.previous)
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
        await this.read(this.previous)
        await replaceFile(this.current, this.previous)
        return current
      }
      return previous ? this.read(this.previous) : undefined
    })
  }

  /** Deletes what was kept when the close leaves no session to reopen. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await this.read(this.current)
      await this.read(this.previous)
      await rm(this.current, { force: true })
      await rm(this.previous, { force: true })
      this.kept = undefined
    })
  }

  /**
   * Deletes the copies of query text the folder would otherwise keep for ever: quarantined files older than `keepDays`
   * (Keep AutoRecover information for, as AutoRecover's own purge) and interrupted writes, which are always leftovers since
   * no write runs alongside this. `session.json` and `previous.json` stay. It waits for the setting, and deletes nothing
   * when settings could not be read.
   */
  purge(keepDays: Promise<number>): Promise<void> {
    return this.serial(async () => {
      let days: number
      try { days = await keepDays } catch { return }
      if (!Number.isSafeInteger(days) || days < 1) return
      let names: string[]
      try { names = await readdir(this.dir) } catch { return }
      const cutoff = (this.options.now?.() ?? new Date()).getTime() - days * dayMs
      for (const file of names) {
        if (!leftover.test(file)) continue
        try {
          const info = await stat(join(this.dir, file))
          if (info.isFile() && (file.startsWith('.varia-') || info.mtimeMs < cutoff)) await rm(join(this.dir, file), { force: true })
        } catch { /* Removed meanwhile, or locked: the next start tries again. */ }
      }
    })
  }

  private async read(path: string): Promise<SessionRecord | undefined> {
    const read = await readJsonFile(path, sessionLimits.totalBytes)
    if (read.kind === 'missing') return undefined
    const parsed = read.kind === 'ok' ? storedSessionSchema.safeParse(read.value) : undefined
    if (parsed?.success) return this.options.pathsRefused ? { ...parsed.data, documents: parsed.data.documents.map(withoutFile) } : parsed.data
    await quarantine(path)
    return undefined
  }
}

const withoutFile = ({ path: _path, fileSha256: _baseline, ...document }: SessionRecordDocument): SessionRecordDocument => document
