import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { connectionKey, connectionLibrarySchema } from '../shared/connections'
import { recoveryLimits } from '../shared/files/recovery'
import { sessionLimits } from '../shared/files/session'
import { quarantine, readJsonFile, writeBytesAtomic } from './json-file'
import { recoveryRecordSchema } from './recovery-store'
import { savedPasswordFileSchema, savedPasswordFileLimit } from './saved-passwords'
import { storedSessionSchema } from './session-store'
import { connectionLibraryLimit } from './connection-store'

/**
 * 0.10.0's profile files. 0.9.0 parses its files strictly and would quarantine one holding a BigQuery entry, losing every
 * SQL Server connection with it, so 0.10.0 never writes a file 0.9.0 reads: it keeps its own copies under new names.
 */
export const profileFiles = {
  connections: { legacy: 'connections.json', current: 'mssql-connections.json' },
  bigQueryConnections: { current: 'bigquery-connections.json' },
  savedPasswords: { legacy: 'saved-passwords.json', current: 'mssql-saved-passwords.json' },
  session: { legacy: 'Session', current: 'WorkbenchSession' },
  autoRecover: { legacy: 'AutoRecover', current: 'WorkbenchAutoRecover' }
} as const

export const migrationSteps = ['connections', 'savedPasswords', 'session', 'autoRecover'] as const
export type MigrationStep = typeof migrationSteps[number]
/**
 * What one step did: copied 0.9.0 content (into a new file, or beside what a store wrote since an unfinished attempt), found
 * nothing to do, quarantined an unreadable 0.9.0 file (the existing rule), copied what fit and left the rest for a start
 * with room (`partial`), or failed. A partial or failed step runs again at the next start.
 */
export type MigrationOutcome = 'migrated' | 'skipped' | 'quarantined' | 'partial' | 'failed'
export interface ProfileMigrationOptions {
  /** Writes a file atomically; tests replace it to fail a write. */
  readonly write?: typeof writeBytesAtomic
}

/**
 * The steps that finished, and the 0.9.0 records already copied, in userData. Done is recorded here rather than read from
 * the new file existing, because the stores create their files too: a library a reconnect wrote after a failed step, or a
 * 0.10.0 file a store later quarantined, must neither hide nor bring back 0.9.0's copy. `copied` keeps a step that runs
 * again from offering a query the user has since recovered or discarded.
 */
export const migrationMarker = 'profile-migration.json'
const copiedName = /^(?:AutoRecover\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json|Session\/(?:session|previous)\.json)$/i
const markerSchema = z.object({
  version: z.literal(1), done: z.array(z.enum(migrationSteps)).max(migrationSteps.length), copied: z.array(z.string().regex(copiedName)).max(4096).optional()
}).strict()
const markerLimit = 256 * 1024
const staging = /^(?:WorkbenchSession|WorkbenchAutoRecover)\.migrating-[0-9a-f-]{36}$/

const posix = process.platform !== 'win32'
const exists = (path: string) => stat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const record = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
/** A 0.10.0 file its store could not read: the store quarantines it once it starts, and the next start merges into what it writes then. */
const unreadable = () => Object.assign(new Error('The 0.10.0 file is not readable yet.'), { code: 'EINVALID' })
const recordName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
const sessionName = /^(session|previous)\.json$/

interface StepResult { readonly outcome: MigrationOutcome; readonly finished: boolean }
const finished = (outcome: MigrationOutcome): StepResult => ({ outcome, finished: true })
interface StepContext {
  readonly path: (name: string) => string
  readonly write: typeof writeBytesAtomic
  /** `copied` from the marker; a step adds what it copied, and the caller records it even when the step fails later. */
  readonly copied: Set<string>
}

/** A 0.9.0 file parsed by today's schema: missing, quarantined (unreadable, as its store would), or its content. */
async function readLegacy<T>(path: string, limit: number, schema: z.ZodType<T>): Promise<{ kind: 'missing' | 'quarantined' } | { kind: 'ok'; value: T }> {
  const read = await readJsonFile(path, limit)
  if (read.kind === 'missing') return { kind: 'missing' }
  const parsed = read.kind === 'ok' ? schema.safeParse(read.value) : undefined
  if (!parsed?.success) { await quarantine(path); return { kind: 'quarantined' } }
  return { kind: 'ok', value: parsed.data }
}
/** A 0.10.0 file its store wrote; an unreadable one fails the step, so it runs again once the store has replaced it. */
async function readCurrent<T>(path: string, limit: number, schema: z.ZodType<T>): Promise<T | undefined> {
  const read = await readJsonFile(path, limit)
  if (read.kind === 'missing') return undefined
  const parsed = read.kind === 'ok' ? schema.safeParse(read.value) : undefined
  if (!parsed?.success) throw unreadable()
  return parsed.data
}

type Library = z.infer<typeof connectionLibrarySchema>
type Profile = Library['profiles'][number]
const maxProfiles = 200
const keyOf = (profile: Profile) => connectionKey(profile.options)

/**
 * The connection library. When the 0.10.0 library already exists (a reconnect or a Connect wrote it after a failed
 * attempt), each 0.9.0 entry it lacks, by id and by connection key, is added beside its entries with its 0.9.0 id, so its
 * saved password still finds it; an entry both have keeps 0.10.0's fields and gains 0.9.0's favorite and registration.
 */
async function migrateConnections({ path, write }: StepContext): Promise<StepResult> {
  const legacy = await readLegacy(path(profileFiles.connections.legacy), connectionLibraryLimit, connectionLibrarySchema)
  if (legacy.kind !== 'ok') return finished(legacy.kind === 'missing' ? 'skipped' : 'quarantined')
  const to = path(profileFiles.connections.current)
  const current = await readCurrent(to, connectionLibraryLimit, connectionLibrarySchema)
  if (!current) { await write(to, json(legacy.value)); return finished('migrated') }
  const byKey = new Map(legacy.value.profiles.map(profile => [keyOf(profile), profile]))
  const ids = new Set(current.profiles.map(profile => profile.id)), keys = new Set(current.profiles.map(keyOf))
  let changed = false
  const kept = current.profiles.map(profile => {
    const old = byKey.get(keyOf(profile))
    if (!old || (profile.favorite || !old.favorite) && (profile.registered || !old.registered)) return profile
    changed = true
    return { ...profile, favorite: profile.favorite || old.favorite, registered: profile.registered || old.registered }
  })
  const added = legacy.value.profiles.filter(profile => !ids.has(profile.id) && !keys.has(keyOf(profile))).slice(0, Math.max(0, maxProfiles - kept.length))
  if (!changed && !added.length) return finished('skipped')
  await write(to, json(connectionLibrarySchema.parse({ ...current, profiles: [...kept, ...added] })))
  return finished('migrated')
}

/**
 * The saved passwords: ciphertext, unchanged, since the SQL Server binding it is checked against does not change in
 * 0.10.0. Each is keyed to its entry in the 0.10.0 library: the same id, or for an entry the library already had under
 * another id, that entry (an equal connection key means an equal binding). When the 0.10.0 file exists, a password is
 * added only for an entry that has none.
 */
async function migrateSavedPasswords({ path, write }: StepContext): Promise<StepResult> {
  const legacy = await readLegacy(path(profileFiles.savedPasswords.legacy), savedPasswordFileLimit, savedPasswordFileSchema)
  if (legacy.kind !== 'ok') return finished(legacy.kind === 'missing' ? 'skipped' : 'quarantined')
  const library = await readCurrent(path(profileFiles.connections.current), connectionLibraryLimit, connectionLibrarySchema)
  const oldLibrary = await readJsonFile(path(profileFiles.connections.legacy), connectionLibraryLimit).then(read => read.kind === 'ok' ? connectionLibrarySchema.safeParse(read.value) : undefined)
  const oldProfiles = new Map((oldLibrary?.success ? oldLibrary.data.profiles : []).map(profile => [profile.id, profile]))
  const ids = new Set(library?.profiles.map(profile => profile.id)), byKey = new Map(library?.profiles.map(profile => [keyOf(profile), profile.id]))
  // Without a 0.10.0 library there is nothing to key to; the store reconciles the ids once one exists.
  const target = (id: string) => !library || ids.has(id) ? id : (oldProfiles.has(id) ? byKey.get(keyOf(oldProfiles.get(id)!)) : undefined)
  const to = path(profileFiles.savedPasswords.current)
  const current = await readCurrent(to, savedPasswordFileLimit, savedPasswordFileSchema)
  const taken = new Set(current?.entries.map(entry => entry.profileId))
  const added = legacy.value.entries.flatMap(entry => {
    const profileId = target(entry.profileId)
    if (!profileId || taken.has(profileId)) return []
    taken.add(profileId)
    return [{ ...entry, profileId }]
  }).slice(0, Math.max(0, 200 - (current?.entries.length ?? 0)))
  if (current && !added.length) return finished('skipped')
  await write(to, json(savedPasswordFileSchema.parse({ version: 1, entries: [...current?.entries ?? [], ...added] })), { mode: 0o600 })
  return finished('migrated')
}

/** The record files in a folder, or none when it does not exist. */
async function recordsIn(folder: string): Promise<string[]> {
  try { return (await readdir(folder)).filter(name => recordName.test(name)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
async function makeFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if (posix) await chmod(folder, 0o700)
}

/**
 * Hot exit's session. Into a folder without a session, the 0.9.0 files are copied whole, through a temporary folder renamed
 * into place, so a failure leaves no half-migrated folder. A folder with a session holds a newer close, written after an
 * unfinished attempt; 0.9.0's tabs that only it holds (text with no file behind it, or unsaved changes) are then offered
 * through AutoRecover instead, as records of their own, when they fit its 64 records.
 */
async function migrateSession({ path, write, copied }: StepContext): Promise<StepResult> {
  const from = path(profileFiles.session.legacy), to = path(profileFiles.session.current)
  let names: string[]
  try { names = (await readdir(from)).filter(name => sessionName.test(name)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return finished('skipped')
    throw error
  }
  const present = await readdir(to).then(found => found.filter(name => sessionName.test(name)), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
  const sessions: { name: string; value: z.infer<typeof storedSessionSchema> }[] = []
  let quarantined = false
  for (const name of names) {
    if (present?.length && copied.has(`Session/${name}`)) continue
    const read = await readLegacy(join(from, name), sessionLimits.totalBytes, storedSessionSchema)
    if (read.kind === 'quarantined') quarantined = true
    if (read.kind === 'ok') sessions.push({ name, value: read.value })
  }
  if (!present?.length) {
    if (!sessions.length) return finished(quarantined ? 'quarantined' : 'skipped')
    const temporary = `${to}.migrating-${randomUUID()}`
    try {
      if (present) {
        for (const { name, value } of sessions) await write(join(to, name), record(value), { mode: 0o600 })
      } else {
        await makeFolder(temporary)
        for (const { name, value } of sessions) await write(join(temporary, name), record(value), { mode: 0o600 })
        await rename(temporary, to)
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    // A run that repeats the step (its marker lost) then finds these in the new folder and must not offer them again.
    for (const { name } of sessions) copied.add(`Session/${name}`)
    return finished(quarantined ? 'quarantined' : 'migrated')
  }
  const recover = path(profileFiles.autoRecover.current)
  // A tab the newer session still holds (as after a run that copied the session whole and then lost its marker) is not offered.
  const seen = new Set<string>()
  for (const name of present) {
    const read = await readJsonFile(join(to, name), sessionLimits.totalBytes).catch(() => undefined)
    const parsed = read?.kind === 'ok' ? storedSessionSchema.safeParse(read.value) : undefined
    for (const document of parsed?.success ? parsed.data.documents : []) seen.add(JSON.stringify([document.name, document.text]))
  }
  let room = recoveryLimits.records - (await recordsIn(recover)).length, partial = false, offered = false
  for (const { name, value } of sessions) {
    const records = value.documents.flatMap(document => {
      const key = JSON.stringify([document.name, document.text])
      if (document.text === undefined || document.text === '' || (!document.dirty && document.path) || seen.has(key)) return []
      seen.add(key)
      const parsed = recoveryRecordSchema.safeParse({
        version: 2, id: randomUUID(), owner: { instance: randomUUID(), generation: 0 }, name: document.name, kind: document.kind,
        ...document.path ? { path: document.path } : {}, eol: document.eol, ...document.server ? { server: document.server } : {},
        ...document.database ? { database: document.database } : {}, savedAt: value.savedAt, text: document.text, provider: 'sqlserver'
      })
      // A tab too large for an AutoRecover record stays only in 0.9.0's session.
      return parsed.success ? [parsed.data] : []
    })
    if (records.length > room) { partial = true; continue }
    if (records.length) await makeFolder(recover)
    for (const item of records) await write(join(recover, item.id + '.json'), record(item), { mode: 0o600 })
    room -= records.length
    offered ||= records.length > 0
    copied.add(`Session/${name}`)
  }
  if (partial) return { outcome: 'partial', finished: false }
  return finished(quarantined ? 'quarantined' : offered ? 'migrated' : 'skipped')
}

/**
 * AutoRecover's records, each the store could read copied in its 0.10.0 version. Into a new folder they go through a
 * temporary folder renamed into place. Into a folder the store already made (it writes there while a failed step waits),
 * a record is added beside its own unless the marker says it was copied before (the user may have recovered or discarded
 * it since), while the folder has room for it under the store's 64 records. An unreadable record is quarantined beside
 * the original, as the store would.
 */
async function migrateAutoRecover({ path, write, copied }: StepContext): Promise<StepResult> {
  const from = path(profileFiles.autoRecover.legacy), to = path(profileFiles.autoRecover.current)
  let names: string[]
  try { names = (await readdir(from)).filter(name => recordName.test(name)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return finished('skipped')
    throw error
  }
  let quarantined = false, failure: unknown
  // One record that cannot be copied (held open, say) fails the step without holding back the others: undefined.
  const copy = async (into: string, name: string): Promise<boolean | undefined> => {
    try {
      const read = await readLegacy(join(from, name), recoveryLimits.recordBytes, recoveryRecordSchema)
      if (read.kind === 'quarantined') quarantined = true
      if (read.kind !== 'ok') return false
      await write(join(into, name), record(read.value), { mode: 0o600 })
      return true
    } catch (error) { failure ??= error; return undefined }
  }
  if (await exists(to)) {
    const present = new Set(await recordsIn(to))
    let room = recoveryLimits.records - present.size, partial = false, migrated = false
    for (const name of names) {
      if (present.has(name) || copied.has(`AutoRecover/${name}`)) continue
      if (room <= 0) { partial = true; continue }
      const result = await copy(to, name)
      if (result === undefined) continue
      if (result) { room--; migrated = true }
      copied.add(`AutoRecover/${name}`)
    }
    if (failure) throw failure
    if (partial) return { outcome: 'partial', finished: false }
    return finished(quarantined ? 'quarantined' : migrated ? 'migrated' : 'skipped')
  }
  const temporary = `${to}.migrating-${randomUUID()}`, copiedNow: string[] = []
  try {
    await makeFolder(temporary)
    let wrote = false
    for (const name of names) {
      const result = await copy(temporary, name)
      if (result !== undefined) copiedNow.push(name)
      wrote ||= result === true
    }
    // Nothing copied: no folder, so a failed step leaves none behind.
    if (failure && !wrote) throw failure
    await rename(temporary, to)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  for (const name of copiedNow) copied.add(`AutoRecover/${name}`)
  if (failure) throw failure
  return finished(quarantined ? 'quarantined' : 'migrated')
}

/** The marker; an unreadable one is quarantined (never overwritten) and every step runs again, merging rather than replacing. */
async function readMarker(path: string): Promise<z.infer<typeof markerSchema> | undefined> {
  const read = await readJsonFile(path, markerLimit).catch(() => undefined)
  if (!read || read.kind === 'missing') return undefined
  const parsed = read.kind === 'ok' ? markerSchema.safeParse(read.value) : undefined
  if (parsed?.success) return parsed.data
  await quarantine(path).catch(() => {})
  return undefined
}

/**
 * Startup's one-time copy of 0.9.0's files to 0.10.0's names (docs/bigquery-plan.md, decision 24), before any store reads
 * them. The 0.9.0 files are never written again (an unreadable one is quarantined, as its store would), so downgrading
 * opens the state from the moment of upgrade. Each finished step is recorded in `migrationMarker` and never runs again; a
 * failed or partial one (logged without paths or content) runs again at the next start, adding what its 0.10.0 file still
 * lacks. Saved passwords wait for the connections, since the password store drops every entry its library does not have.
 */
export async function migrateProfile(userData: string, options: ProfileMigrationOptions = {}): Promise<Record<MigrationStep, MigrationOutcome>> {
  const write = options.write ?? writeBytesAtomic
  const path = (name: string) => join(userData, name)
  // A run stopped mid-copy leaves its staging folder; nothing else would ever remove its copies of query text.
  for (const name of await readdir(userData).catch(() => [] as string[])) if (staging.test(name)) await rm(path(name), { recursive: true, force: true }).catch(() => {})
  const marker = await readMarker(path(migrationMarker))
  const done = new Set<MigrationStep>(marker?.done), copied = new Set<string>(marker?.copied)
  const context: StepContext = { path, write, copied }
  const steps: Record<MigrationStep, (context: StepContext) => Promise<StepResult>> = {
    connections: migrateConnections, savedPasswords: migrateSavedPasswords, session: migrateSession, autoRecover: migrateAutoRecover
  }
  const outcomes = {} as Record<MigrationStep, MigrationOutcome>
  for (const step of migrationSteps) {
    if (done.has(step)) { outcomes[step] = 'skipped'; continue }
    if (step === 'savedPasswords' && !done.has('connections')) { outcomes[step] = 'failed'; continue }
    const before = copied.size
    try {
      const result = await steps[step](context)
      outcomes[step] = result.outcome
      if (result.finished) done.add(step)
      else console.error(`Some 0.9.0 ${step} records wait for room in 0.10.0's; the next start tries again.`)
    } catch (error) {
      outcomes[step] = 'failed'
      console.error(`Could not copy the 0.9.0 ${step} file to 0.10.0's (${(error as NodeJS.ErrnoException).code ?? 'error'}); the next start tries again.`)
    }
    if (!done.has(step) && copied.size === before) continue
    const value = { version: 1, done: migrationSteps.filter(item => done.has(item)), ...copied.size ? { copied: [...copied] } : {} }
    try { await write(path(migrationMarker), json(value)) } catch (error) {
      console.error(`Could not record the profile migration (${(error as NodeJS.ErrnoException).code ?? 'error'}).`)
    }
  }
  return outcomes
}
