import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { connectionLibrarySchema } from '../shared/connections'
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
/** What one step did: copied the 0.9.0 content, found nothing to do (no 0.9.0 file, done before, or a 0.10.0 file a store
 *  wrote since an unfinished attempt), quarantined an unreadable 0.9.0 file (the existing rule), or failed (retried next start). */
export type MigrationOutcome = 'migrated' | 'skipped' | 'quarantined' | 'failed'
export interface ProfileMigrationOptions {
  /** Writes a file atomically; tests replace it to fail a write. */
  readonly write?: typeof writeBytesAtomic
}

/**
 * The steps that finished, in userData. Done is recorded here rather than read from the new file existing, because the
 * stores create their files too: a folder an AutoRecover write made after a failed step, or a 0.10.0 file a store later
 * quarantined, must neither hide nor bring back 0.9.0's copy.
 */
export const migrationMarker = 'profile-migration.json'
const markerSchema = z.object({ version: z.literal(1), done: z.array(z.enum(migrationSteps)).max(migrationSteps.length) }).strict()
const staging = /^(?:WorkbenchSession|WorkbenchAutoRecover)\.migrating-[0-9a-f-]{36}$/

const posix = process.platform !== 'win32'
const exists = (path: string) => stat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const record = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')

/** One file: the 0.9.0 content, parsed by the 0.10.0 schema, written to the new name; the old file is left as it was. A
 *  0.10.0 file that already exists was written by its store after an unfinished attempt and is newer: it stays. */
async function migrateFile(from: string, to: string, limit: number, schema: z.ZodType, encode: (value: unknown) => Buffer, write: typeof writeBytesAtomic, mode?: number): Promise<MigrationOutcome> {
  if (await exists(to)) return 'skipped'
  const read = await readJsonFile(from, limit)
  if (read.kind === 'missing') return 'skipped'
  const parsed = read.kind === 'ok' ? schema.safeParse(read.value) : undefined
  if (!parsed?.success) { await quarantine(from); return 'quarantined' }
  await write(to, encode(parsed.data), mode === undefined ? {} : { mode })
  return 'migrated'
}

/**
 * A folder of records: each one the store could read is copied, in its 0.10.0 version, into a temporary folder renamed
 * into place at the end, so a failure leaves no half-migrated folder. When the store already made the new folder (it
 * writes there while a failed step waits for the next start), records are added beside its own under names it does not
 * have; a `whole` folder (the session's pair of files) is copied only into a folder without them. An unreadable record
 * is quarantined beside the original, as the store would.
 */
async function migrateFolder(from: string, to: string, files: (name: string) => boolean, limit: number, schema: z.ZodType, write: typeof writeBytesAtomic, whole: boolean): Promise<MigrationOutcome> {
  let names: string[]
  try { names = (await readdir(from)).filter(files) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return 'skipped'
    throw error
  }
  let quarantined = false
  const copy = async (into: string, name: string) => {
    const read = await readJsonFile(join(from, name), limit)
    if (read.kind === 'missing') return
    const parsed = read.kind === 'ok' ? schema.safeParse(read.value) : undefined
    if (!parsed?.success) { await quarantine(join(from, name)); quarantined = true; return }
    await write(join(into, name), record(parsed.data), { mode: 0o600 })
  }
  if (await exists(to)) {
    const present = new Set((await readdir(to)).filter(files))
    if (whole && present.size) return 'skipped'
    for (const name of names) if (!present.has(name)) await copy(to, name)
    return quarantined ? 'quarantined' : names.length ? 'migrated' : 'skipped'
  }
  const temporary = `${to}.migrating-${randomUUID()}`
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    if (posix) await chmod(temporary, 0o700)
    for (const name of names) await copy(temporary, name)
    await rename(temporary, to)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return quarantined ? 'quarantined' : 'migrated'
}

const recordName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
const sessionName = /^(session|previous)\.json$/

async function doneSteps(path: string): Promise<Set<MigrationStep>> {
  const read = await readJsonFile(path, 4096).catch(() => undefined)
  const parsed = read?.kind === 'ok' ? markerSchema.safeParse(read.value) : undefined
  return new Set(parsed?.success ? parsed.data.done : [])
}

/**
 * Startup's one-time copy of 0.9.0's files to 0.10.0's names (docs/bigquery-plan.md, decision 24), before any store reads
 * them. The 0.9.0 files are never written again (an unreadable one is quarantined, as its store would), so downgrading
 * opens the state from the moment of upgrade. Each finished step is recorded in `migrationMarker` and never runs again; a
 * failed one (logged without paths or content) runs again at the next start. Saved passwords wait for the connections,
 * since the password store drops every entry its connection library does not have.
 */
export async function migrateProfile(userData: string, options: ProfileMigrationOptions = {}): Promise<Record<MigrationStep, MigrationOutcome>> {
  const write = options.write ?? writeBytesAtomic
  const path = (name: string) => join(userData, name)
  // A run stopped mid-copy leaves its staging folder; nothing else would ever remove its copies of query text.
  for (const name of await readdir(userData).catch(() => [] as string[])) if (staging.test(name)) await rm(path(name), { recursive: true, force: true }).catch(() => {})
  const steps: Record<MigrationStep, () => Promise<MigrationOutcome>> = {
    connections: () => migrateFile(path(profileFiles.connections.legacy), path(profileFiles.connections.current), connectionLibraryLimit, connectionLibrarySchema, json, write),
    // Ciphertext, unchanged: the SQL Server binding hash it is keyed by does not change in 0.10.0.
    savedPasswords: () => migrateFile(path(profileFiles.savedPasswords.legacy), path(profileFiles.savedPasswords.current), savedPasswordFileLimit, savedPasswordFileSchema, json, write, 0o600),
    session: () => migrateFolder(path(profileFiles.session.legacy), path(profileFiles.session.current), name => sessionName.test(name), sessionLimits.totalBytes, storedSessionSchema, write, true),
    autoRecover: () => migrateFolder(path(profileFiles.autoRecover.legacy), path(profileFiles.autoRecover.current), name => recordName.test(name), recoveryLimits.recordBytes, recoveryRecordSchema, write, false)
  }
  const done = await doneSteps(path(migrationMarker))
  const outcomes = {} as Record<MigrationStep, MigrationOutcome>
  for (const step of migrationSteps) {
    if (done.has(step)) { outcomes[step] = 'skipped'; continue }
    if (step === 'savedPasswords' && outcomes.connections === 'failed') { outcomes[step] = 'failed'; continue }
    try { outcomes[step] = await steps[step]() } catch (error) {
      outcomes[step] = 'failed'
      console.error(`Could not copy the 0.9.0 ${step} file to 0.10.0's (${(error as NodeJS.ErrnoException).code ?? 'error'}); the next start tries again.`)
      continue
    }
    done.add(step)
    try { await write(path(migrationMarker), json({ version: 1, done: migrationSteps.filter(value => done.has(value)) })) } catch (error) {
      console.error(`Could not record the profile migration (${(error as NodeJS.ErrnoException).code ?? 'error'}).`)
    }
  }
  return outcomes
}
