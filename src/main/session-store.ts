import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { documentKinds, type DocumentKind } from '../shared/contracts'
import { sessionLimits, type SessionWrite } from '../shared/files/session'
import { editorGroupsLayoutSchema, layoutViews, remapEditorGroups } from '../shared/editor-groups'
import { connectionWorkspaceSchema } from '../shared/connection-targets'
import { bigQueryProjectSchema } from '../shared/connections'
import { providerIds, providerOf, type ProviderId } from '../shared/providers'
import { jobKeySchema } from '../shared/bigquery/jobs'
import { isKeptAgentKind, keptAgentKinds, keptAgentLimits, type KeptAgentKind } from '../shared/agent/kept'
import { workspaceSealSchema, type WorkspaceSeal } from './connection-workspace-seal'
import { quarantine, readJsonFile, replaceFile, writeBytesAtomic } from './json-file'
import { fileKinds, maxDocumentCharacters } from './sql-files'

const fits = (value: { kind: DocumentKind | KeptAgentKind; text?: string }) => value.text === undefined || value.text.length <= (isKeptAgentKind(value.kind) ? keptAgentLimits.stateChars : fileKinds[value.kind].maxChars)
/** A SQL Server Agent document (AG-6g) keeps its state as text and its target: never a file, a provider or a job key. */
const agentShaped = (document: { kind: string; text?: string; fileId?: string; path?: string; fileSha256?: string; provider?: string; jobKey?: string; multiMode?: string; multiTargets?: readonly unknown[]; crossView?: string }) => !isKeptAgentKind(document.kind)
  || (document.text !== undefined && document.fileId === undefined && document.path === undefined && document.fileSha256 === undefined && document.provider === undefined && document.jobKey === undefined && document.multiMode === undefined && document.multiTargets === undefined && document.crossView === undefined)
const name = z.string().min(1).max(sessionLimits.nameChars)
const server = z.string().min(1).max(sessionLimits.serverChars)
const database = z.string().max(sessionLimits.databaseChars)
const dataset = z.string().max(sessionLimits.datasetChars)
const multiTargetSchema = z.object({
  targetId: z.uuid().optional(),
  attachWanted: z.boolean().optional(),
  provider: z.enum(providerIds),
  database: dataset,
  enabled: z.boolean(),
  lastServer: server.optional()
}).strict()
  .refine(target => (target.targetId === undefined) === (target.attachWanted === undefined), 'A multi-server target pairs its target id and attachment preference.')
  .refine(target => target.provider === 'bigquery' || target.database.length <= sessionLimits.databaseChars, 'A database name has at most 128 characters.')
const multiFields = {
  multiMode: z.enum(['same', 'cross']).optional(),
  multiTargets: z.array(multiTargetSchema).max(sessionLimits.multiTargets).optional(),
  crossView: z.enum(['split', 'file']).optional()
}
const multiShaped = (document: { kind: string; targetId?: string; attachWanted?: boolean; jobKey?: string; multiMode?: 'same' | 'cross'; multiTargets?: readonly { targetId?: string; provider: ProviderId }[]; crossView?: 'split' | 'file' }) => {
  if (document.multiMode === undefined) return document.multiTargets === undefined && document.crossView === undefined
  if (document.multiTargets === undefined || document.kind !== 'sql') return false
  if (document.crossView !== undefined && document.multiMode !== 'cross') return false
  if (document.targetId !== undefined || document.attachWanted !== undefined || document.jobKey !== undefined) return false
  if (document.multiMode === 'same' && new Set(document.multiTargets.map(target => target.provider)).size > 1) return false
  const definedIds = document.multiTargets.map(target => target.targetId).filter((id): id is string => id !== undefined)
  return new Set(definedIds).size === definedIds.length
}
const legacyFields = { name, baseName: name.optional(), kind: z.enum(documentKinds), eol: z.enum(['crlf', 'lf']), dirty: z.boolean(), pinned: z.boolean().optional(), server: server.optional(), database: database.min(1).optional(), text: z.string().max(maxDocumentCharacters).optional() }
const fields = { ...legacyFields, database: database.optional(), targetId: z.uuid().optional(), attachWanted: z.boolean().optional() }
/** Version 3: the tab's provider, a BigQuery tab's dataset at BigQuery's length (SQL Server's 128 characters otherwise), and
 *  its job key (docs/bigquery.md, Re-attaching to jobs). */
const providerFields = { ...fields, kind: z.enum([...documentKinds, ...keptAgentKinds]), provider: z.enum(providerIds).optional(), database: dataset.optional(), jobKey: jobKeySchema.optional() }
const databaseFits = (document: { provider?: string; database?: string }) => document.provider === 'bigquery' || (document.database ?? '').length <= sessionLimits.databaseChars
const associated = (document: { kind: string; targetId?: string; attachWanted?: boolean; database?: string }) => document.targetId
  ? (document.kind === 'sql' || isKeptAgentKind(document.kind)) && document.attachWanted !== undefined && document.database !== undefined
  : document.attachWanted === undefined
const targetsPresent = (session: { documents: readonly { targetId?: string; multiTargets?: readonly { targetId?: string; provider: ProviderId }[] }[]; workspace?: { targets: readonly { id: string; options: { readonly provider?: ProviderId } }[] } }) => {
  const providers = new Map((session.workspace?.targets ?? []).map(target => [target.id, providerOf(target.options)] as const))
  return session.documents.every(document => (!document.targetId || providers.has(document.targetId))
    && (document.multiTargets ?? []).every(target => !target.targetId || providers.get(target.targetId) === target.provider))
}
/** varia:session-write: the tabs in strip order. Only a clean tab with a file may leave its text out (it reopens from the file). */
export const sessionWriteSchema = z.object({
  documents: z.array(z.object({ ...providerFields, ...multiFields, fileId: z.uuid().optional() }).strict()
    .refine(associated, 'A query target requires its database and attachment preference.')
    .refine(databaseFits, 'A database name has at most 128 characters.')
    .refine(fits, 'A query is too large to keep for the next start.')
    .refine(document => document.text !== undefined || (!!document.fileId && !document.dirty), 'A query without a file must keep its text.')
    .refine(agentShaped, 'A SQL Server Agent document keeps only its state and connection target.')
    .refine(multiShaped, 'Multi-server query targets must match the tab mode.')).max(sessionLimits.documents),
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
const v2RecordSchema = z.object({
  ...recordFields, version: z.literal(2), workspace: connectionWorkspaceSchema.optional(), seal: workspaceSealSchema.optional(),
  documents: z.array(z.object({
    ...fields, ...fileFields
  }).strict().refine(fits).refine(associated)
    .refine(document => document.text !== undefined || (!!document.path && !document.dirty))
    .refine(document => document.fileSha256 === undefined || (!!document.path && document.text !== undefined))).max(sessionLimits.documents),
}).strict().refine(session => !session.groups || layoutViews(session.groups).every(view => view < session.documents.length)).refine(targetsPresent)
/** Version 3 (0.10.0, `WorkbenchSession/`): version 2 with each tab's provider and the provider-tagged workspace. */
const v3RecordSchema = z.object({
  ...recordFields, version: z.literal(3), workspace: connectionWorkspaceSchema.optional(), seal: workspaceSealSchema.optional(),
  documents: z.array(z.object({
    ...providerFields, ...fileFields
  }).strict().refine(fits).refine(associated).refine(databaseFits).refine(agentShaped)
    .refine(document => document.text !== undefined || (!!document.path && !document.dirty))
    .refine(document => document.fileSha256 === undefined || (!!document.path && document.text !== undefined))).max(sessionLimits.documents),
}).strict().refine(session => !session.groups || layoutViews(session.groups).every(view => view < session.documents.length)).refine(targetsPresent)
/** Version 4: version 3 with multi-server / cross-engine tab targets (`multiMode`, `multiTargets`, `crossView`). */
const recordSchema = z.object({
  ...recordFields, version: z.literal(4), workspace: connectionWorkspaceSchema.optional(), seal: workspaceSealSchema.optional(),
  documents: z.array(z.object({
    ...providerFields, ...multiFields, ...fileFields
  }).strict().refine(fits).refine(associated).refine(databaseFits).refine(agentShaped).refine(multiShaped)
    .refine(document => document.text !== undefined || (!!document.path && !document.dirty))
    .refine(document => document.fileSha256 === undefined || (!!document.path && document.text !== undefined))).max(sessionLimits.documents),
}).strict().refine(session => !session.groups || layoutViews(session.groups).every(view => view < session.documents.length)).refine(targetsPresent)
/** Version 1 has only server hints. Migration cannot infer an account or manufacture a target association. Versions 1, 2
 *  and 3 read as version 4 (version 1 and 2 with every tab SQL Server's). */
export const storedSessionSchema = z.union([
  recordSchema,
  v3RecordSchema.transform(record => ({ ...record, version: 4 as const })),
  v2RecordSchema.transform(record => ({ ...record, version: 4 as const })),
  legacyRecordSchema.transform(record => ({ ...record, version: 4 as const }))
])
export type SessionRecord = z.infer<typeof recordSchema>
export type SessionRecordDocument = SessionRecord['documents'][number]
/** What `write` takes: the page's request with main's paths and disk baselines in place of file ids. */
export type SessionInput = Omit<SessionWrite, 'documents'> & { readonly documents: readonly (Omit<SessionWrite['documents'][number], 'fileId'> & Pick<SessionRecordDocument, 'path' | 'fileSha256'>)[]; readonly seal?: WorkspaceSeal }

/** Why a write was refused at the cap; a fixed sentence, as the banner shows it. */
export const sessionCapMessage = 'The open queries are too large to keep for the next start (64 MB in all).'
const posix = process.platform !== 'win32'
/** What a quarantine of either file (or of jobs.json, `job-records.ts`) leaves (`json-file.ts`'s `quarantine`), and a write a crash interrupted (`writeBytesAtomic`'s temporary file). */
const leftover = /^((session|previous|jobs)\.json\.invalid-[0-9a-f-]{36}\.json|\.varia-[0-9a-f-]{36}\.tmp)$/i
const dayMs = 86_400_000

/** Legacy BigQuery `extraProjects` stripped from a pre-upgrade session on disk, keyed by target ID (for seal verification and post-seal migration). */
const legacyExtraProjectsByRecord = new WeakMap<SessionRecord, ReadonlyMap<string, readonly string[]>>()
/** Returns legacy BigQuery `extraProjects` stripped from `record` on read, keyed by target ID (never persisted again). */
export function legacyBigQueryExtraProjects(record: SessionRecord | undefined): ReadonlyMap<string, readonly string[]> | undefined {
  return record ? legacyExtraProjectsByRecord.get(record) : undefined
}

/**
 * Tolerates pre-upgrade `session.json` / `previous.json` files whose BigQuery workspace targets still carry `extraProjects`:
 * strips `extraProjects` from each target's options and retains the raw arrays keyed by target ID so `ConnectionWorkspaceSealer`
 * can verify the pre-upgrade HMAC seal and main can migrate them only after seal verification.
 */
function migrateLegacySession(raw: unknown): { value: unknown; extraByTarget?: ReadonlyMap<string, readonly string[]> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw }
  const record = raw as Record<string, unknown>
  const workspace = record.workspace
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return { value: raw }
  const ws = workspace as Record<string, unknown>
  if (!Array.isArray(ws.targets)) return { value: raw }
  const extraByTarget = new Map<string, readonly string[]>()
  let migrated = false
  const targets = ws.targets.map(target => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return target
    const entry = target as Record<string, unknown>
    const options = entry.options
    if (!options || typeof options !== 'object' || Array.isArray(options)) return target
    const opts = options as Record<string, unknown>
    if (opts.provider !== 'bigquery' || !Object.hasOwn(opts, 'extraProjects')) return target
    const extra = opts.extraProjects
    // Pre-upgrade bigQueryLimits.extraProjects was 16; oversized or malformed arrays still quarantine.
    if (extra !== undefined && (!Array.isArray(extra) || extra.length > 16 || !extra.every(item => typeof item === 'string' && bigQueryProjectSchema.safeParse(item).success))) return target
    migrated = true
    if (Array.isArray(extra) && typeof entry.id === 'string') extraByTarget.set(entry.id, [...extra])
    const { extraProjects: _extraProjects, ...rest } = opts
    return { ...entry, options: rest }
  })
  if (!migrated) return { value: raw }
  return { value: { ...record, workspace: { ...ws, targets } }, ...extraByTarget.size ? { extraByTarget } : {} }
}

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
    version: 4, savedAt: (options.now?.() ?? new Date()).toISOString(), activeIndex: reopens.findIndex(({ index }) => index === session.activeIndex),
    documents: reopens.map(({ document }) => ({
      name: document.name, ...document.baseName ? { baseName: document.baseName } : {}, kind: document.kind, eol: document.eol, dirty: document.dirty,
      ...document.pinned ? { pinned: true } : {},
      ...document.path && document.path.length <= sessionLimits.pathChars ? {
        path: document.path, ...document.text !== undefined && document.fileSha256 ? { fileSha256: document.fileSha256 } : {}
      } : {},
      ...document.server ? { server: document.server } : {}, ...document.database !== undefined ? { database: document.database } : {},
      ...document.targetId ? { targetId: document.targetId, attachWanted: document.attachWanted } : {},
      ...document.provider ? { provider: document.provider } : {}, ...document.jobKey ? { jobKey: document.jobKey } : {},
      ...document.multiMode ? { multiMode: document.multiMode } : {},
      ...document.multiTargets ? {
        multiTargets: document.multiTargets.map(target => ({
          ...target.targetId !== undefined ? { targetId: target.targetId, attachWanted: target.attachWanted } : {},
          provider: target.provider, database: target.database, enabled: target.enabled,
          ...target.lastServer ? { lastServer: target.lastServer } : {}
        }))
      } : {},
      ...document.crossView ? { crossView: document.crossView } : {},
      ...document.text !== undefined ? { text: document.text } : {}
    })),
    ...groups ? { groups } : {}, ...session.workspace ? { workspace: session.workspace, ...session.seal ? { seal: session.seal } : {} } : {}
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
 * `<userData>/WorkbenchSession/` (0.9.0's `Session/`, migrated at startup by profile-migration.ts): hot exit's copy of the open tabs, written once as a normal close goes ahead instead of asking to
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
  /** A take handed out files no page has acknowledged reopening (`restored`). */
  private unrestored = false
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
      await this.setAsideUnrestored(await this.read(this.current), await this.read(this.previous))
      await writeBytesAtomic(this.current, bytes, { mode: 0o600 })
      await rm(this.previous, { force: true })
      this.kept = generation
    })
  }

  /** A page reopened what `take` handed it: its files are no longer the only copy of tabs nobody saw. */
  restored(): void { this.unrestored = false }

  /**
   * A take that no page acknowledged (the read failed, or the restore stopped part-way) leaves the files as the only copy
   * of tabs the user never saw. The first close after it sets them aside as quarantined copies, dated now so the purge
   * keeps them for the full Keep AutoRecover information for, instead of overwriting or deleting them.
   */
  private async setAsideUnrestored(current: SessionRecord | undefined, previous: SessionRecord | undefined): Promise<void> {
    if (!this.unrestored) return
    for (const [record, path] of [[current, this.current], [previous, this.previous]] as const) {
      if (!record) continue
      const aside = `${path}.invalid-${randomUUID()}.json`, now = this.options.now?.() ?? new Date()
      await rename(path, aside)
      await utimes(aside, now, now).catch(() => {})
    }
    this.unrestored = false
  }

  /**
   * The session to reopen, or undefined. `session.json` moves to `previous.json`, which `previous` (the process's first
   * page) also reopens when there is no newer one. An invalid file is quarantined beside it; read failures are thrown.
   */
  take(previous: boolean): Promise<SessionRecord | undefined> {
    return this.serial(async () => {
      this.unrestored = true
      const current = await this.read(this.current)
      if (current) {
        await this.read(this.previous)
        await replaceFile(this.current, this.previous)
        return current
      }
      return previous ? this.read(this.previous) : undefined
    })
  }

  /**
   * `generation` cancelled the close it kept a session for, and stays open. Its file moves to `previous.json`: a reload of
   * this process (which takes only `session.json`) must not reopen tabs the user went on to close, while the next start
   * still has it if the process dies before another close.
   */
  release(generation: number): Promise<void> {
    return this.serial(async () => {
      if (this.kept !== generation) return
      // If the move fails the file must still not be reloaded: removing it is the fallback, and only then is the mark gone.
      try { if (await this.read(this.current)) await replaceFile(this.current, this.previous) } catch { await rm(this.current, { force: true }) }
      this.kept = undefined
    })
  }

  /** Deletes what was kept when the close leaves no session to reopen. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await this.setAsideUnrestored(await this.read(this.current), await this.read(this.previous))
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
    const migrated = read.kind === 'ok' ? migrateLegacySession(read.value) : undefined
    const parsed = migrated ? storedSessionSchema.safeParse(migrated.value) : undefined
    if (parsed?.success) {
      const record = this.options.pathsRefused ? { ...parsed.data, documents: parsed.data.documents.map(withoutFile) } : parsed.data
      if (migrated?.extraByTarget?.size) legacyExtraProjectsByRecord.set(record, migrated.extraByTarget)
      return record
    }
    await quarantine(path)
    return undefined
  }
}

const withoutFile = ({ path: _path, fileSha256: _baseline, ...document }: SessionRecordDocument): SessionRecordDocument => document
