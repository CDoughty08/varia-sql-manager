import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateProfile, migrationMarker, profileFiles } from '../src/main/profile-migration'
import { ConnectionStore } from '../src/main/connection-store'
import { SessionStore } from '../src/main/session-store'
import { RecoveryStore } from '../src/main/recovery-store'
import { writeBytesAtomic } from '../src/main/json-file'
import { recoveryLimits } from '../src/shared/files/recovery'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'varia-migration-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

const profileId = randomUUID(), targetId = randomUUID(), recordId = randomUUID()
const library = { version: 1, profiles: [{ id: profileId, options: { server: 'sql-prod-01', database: 'Sales', authentication: 'sql', username: 'reader', trustServerCertificate: false, encrypt: 'mandatory' }, favorite: true, registered: false, lastConnected: '2026-11-01T10:00:00.000Z' }] }
const passwords = { version: 1, entries: [{ profileId, binding: 'a'.repeat(64), cipher: Buffer.from('ciphertext').toString('base64'), savedAt: '2026-11-01T10:00:00.000Z' }] }
/** A 0.9.0 session: version 2, the principal spelled `sqlServer`, one query attached to the target. */
const session = {
  version: 2, savedAt: '2026-11-01T10:00:00.000Z', activeIndex: 0,
  workspace: { version: 1, targets: [{ id: targetId, options: { server: 'sql-prod-01', database: 'Sales', authentication: 'windows', trustServerCertificate: false }, details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal: { provider: 'sqlServer', authentication: 'windows', id: 'sid:0105' } }] },
  documents: [{ name: 'Orders.sql', kind: 'sql', eol: 'crlf', dirty: true, targetId, database: 'Sales', attachWanted: true, text: 'select 1' }]
}
const recovery = { version: 1, id: recordId, owner: { instance: randomUUID(), generation: 1 }, name: 'Query 1', kind: 'sql', eol: 'lf', server: 'sql-prod-01', database: 'Sales', savedAt: '2026-11-01T10:00:00.000Z', text: 'select 2' }

async function seed09(): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    [profileFiles.connections.legacy]: JSON.stringify(library),
    [profileFiles.savedPasswords.legacy]: JSON.stringify(passwords),
    [join(profileFiles.session.legacy, 'session.json')]: JSON.stringify(session),
    [join(profileFiles.session.legacy, 'previous.json')]: JSON.stringify({ ...session, documents: [] }),
    [join(profileFiles.autoRecover.legacy, recordId + '.json')]: JSON.stringify(recovery)
  }
  await mkdir(join(directory, profileFiles.session.legacy))
  await mkdir(join(directory, profileFiles.autoRecover.legacy))
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text)
  return files
}
const read = async (name: string) => JSON.parse(await readFile(join(directory, name), 'utf8'))

describe('0.9.0 profile migration', () => {
  it('copies every 0.9.0 file to its 0.10.0 name and leaves the 0.9.0 files untouched', async () => {
    const before = await seed09()
    expect(await migrateProfile(directory)).toEqual({ connections: 'migrated', savedPasswords: 'migrated', session: 'migrated', autoRecover: 'migrated' })
    expect(await read(profileFiles.connections.current)).toEqual(library)
    expect(await read(profileFiles.savedPasswords.current)).toEqual(passwords)
    const migrated = await read(join(profileFiles.session.current, 'session.json'))
    expect(migrated.version).toBe(3)
    expect(migrated.documents).toEqual(session.documents)
    // The old spelling reads as 'sqlserver' and is written so from then on.
    expect(migrated.workspace.targets[0].expectedPrincipal).toEqual({ provider: 'sqlserver', authentication: 'windows', id: 'sid:0105' })
    expect((await read(join(profileFiles.session.current, 'previous.json'))).version).toBe(3)
    expect(await read(join(profileFiles.autoRecover.current, recordId + '.json'))).toEqual({ ...recovery, version: 2 })
    for (const [name, text] of Object.entries(before)) expect(await readFile(join(directory, name), 'utf8'), name).toBe(text)
    expect(await readFile(join(directory, profileFiles.bigQueryConnections.current)).catch(() => undefined)).toBeUndefined()
  })

  it('does not migrate again at the next start, so what 0.10.0 changed stays', async () => {
    await seed09()
    await migrateProfile(directory)
    // 0.10.0 runs: it saves a connection, closes every tab and discards the recovered query.
    const connections = new ConnectionStore(join(directory, profileFiles.connections.current))
    await connections.save({ options: { server: 'sql-test-02', database: '', authentication: 'windows', trustServerCertificate: false }, favorite: true })
    const tabs = new SessionStore(join(directory, profileFiles.session.current))
    expect((await tabs.take(true))?.documents).toHaveLength(1)
    tabs.restored()
    await tabs.clear()
    const records = new RecoveryStore(join(directory, profileFiles.autoRecover.current))
    const listed = await records.list(5)
    await records.discard(listed.map(entry => entry.id), 5)
    expect(await migrateProfile(directory)).toEqual({ connections: 'skipped', savedPasswords: 'skipped', session: 'skipped', autoRecover: 'skipped' })
    expect((await read(profileFiles.connections.current)).profiles).toHaveLength(2)
    expect(await readdir(join(directory, profileFiles.session.current))).toEqual([])
    expect(await readdir(join(directory, profileFiles.autoRecover.current))).toEqual([])
  })

  it('a 0.9.0 reader still opens the frozen files after a 0.10.0 session wrote its own', async () => {
    const before = await seed09()
    await migrateProfile(directory)
    const tabs = new SessionStore(join(directory, profileFiles.session.current))
    await tabs.take(true)
    await tabs.write({ documents: [{ name: 'New.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'select 3' }], activeIndex: 0 }, 1)
    expect((await read(join(profileFiles.session.current, 'session.json'))).version).toBe(3)
    // 0.9.0 reads its own names, which still hold exactly what it wrote: version 2 sessions, version 1 records.
    const frozen = await read(join(profileFiles.session.legacy, 'session.json'))
    expect(frozen).toEqual(session)
    expect(frozen.workspace.targets[0].expectedPrincipal.provider).toBe('sqlServer')
    expect(await read(join(profileFiles.autoRecover.legacy, recordId + '.json'))).toEqual(recovery)
    expect(await readFile(join(directory, profileFiles.connections.legacy), 'utf8')).toBe(before[profileFiles.connections.legacy])
  })

  it('quarantines an unreadable 0.9.0 file instead of migrating it', async () => {
    await writeFile(join(directory, profileFiles.connections.legacy), '{ not json')
    await mkdir(join(directory, profileFiles.autoRecover.legacy))
    await writeFile(join(directory, profileFiles.autoRecover.legacy, recordId + '.json'), JSON.stringify({ ...recovery, kind: 'nonsense' }))
    const outcomes = await migrateProfile(directory)
    expect(outcomes.connections).toBe('quarantined')
    expect(outcomes.autoRecover).toBe('quarantined')
    const names = await readdir(directory)
    expect(names).not.toContain(profileFiles.connections.current)
    expect(names.some(name => name.startsWith('connections.json.invalid-'))).toBe(true)
    expect(await readdir(join(directory, profileFiles.autoRecover.current))).toEqual([])
  })

  it('a failed write leaves the 0.10.0 file absent, and the next start retries', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing: typeof writeBytesAtomic = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    expect(await migrateProfile(directory, { write: failing })).toEqual({ connections: 'failed', savedPasswords: 'failed', session: 'failed', autoRecover: 'failed' })
    const names = await readdir(directory)
    for (const name of [profileFiles.connections.current, profileFiles.savedPasswords.current, profileFiles.session.current, profileFiles.autoRecover.current]) expect(names).not.toContain(name)
    expect(names.some(name => name.includes('.migrating-'))).toBe(false)
    // Nothing that names a path or content reaches the log.
    expect(String(vi.mocked(console.error).mock.calls)).not.toContain(directory)
    expect(await migrateProfile(directory)).toEqual({ connections: 'migrated', savedPasswords: 'migrated', session: 'migrated', autoRecover: 'migrated' })
  })

  it('does nothing for a profile without 0.9.0 files', async () => {
    expect(await migrateProfile(directory)).toEqual({ connections: 'skipped', savedPasswords: 'skipped', session: 'skipped', autoRecover: 'skipped' })
    expect(await readdir(directory)).toEqual([migrationMarker])
  })

  it('keeps saved passwords waiting while the connections step fails, so the password store never reconciles them away', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failConnections: typeof writeBytesAtomic = async (path, bytes, options) => {
      if (path.endsWith(profileFiles.connections.current)) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return writeBytesAtomic(path, bytes, options)
    }
    expect(await migrateProfile(directory, { write: failConnections })).toEqual({ connections: 'failed', savedPasswords: 'failed', session: 'migrated', autoRecover: 'migrated' })
    expect(await readdir(directory)).not.toContain(profileFiles.savedPasswords.current)
    expect(await migrateProfile(directory)).toEqual({ connections: 'migrated', savedPasswords: 'migrated', session: 'skipped', autoRecover: 'skipped' })
    expect(await read(profileFiles.savedPasswords.current)).toEqual(passwords)
  })

  it('adds 0.9.0 records to a folder a store made while their step waited, without replacing what the store wrote', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failFolders: typeof writeBytesAtomic = async (path, bytes, options) => {
      if (path.includes('.migrating-')) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      return writeBytesAtomic(path, bytes, options)
    }
    expect(await migrateProfile(directory, { write: failFolders })).toMatchObject({ session: 'failed', autoRecover: 'failed' })
    // 0.10.0 runs: an AutoRecover copy and a session close create both folders.
    const ownId = randomUUID()
    await new RecoveryStore(join(directory, profileFiles.autoRecover.current)).write({ id: ownId, name: 'Query 2', kind: 'sql', eol: 'lf', text: 'select 4' }, 1)
    const tabs = new SessionStore(join(directory, profileFiles.session.current))
    await tabs.take(true)
    await tabs.write({ documents: [{ name: 'New.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'select 5' }], activeIndex: 0 }, 1)
    expect(await migrateProfile(directory)).toMatchObject({ session: 'migrated', autoRecover: 'migrated' })
    const names = await readdir(join(directory, profileFiles.autoRecover.current))
    expect(names).toHaveLength(3)
    expect(names).toEqual(expect.arrayContaining([ownId + '.json', recordId + '.json']))
    expect(await read(join(profileFiles.autoRecover.current, recordId + '.json'))).toEqual({ ...recovery, version: 2 })
    // The session 0.10.0 wrote is newer than 0.9.0's, so it stays; 0.9.0's unsaved tab is offered through AutoRecover instead.
    expect((await read(join(profileFiles.session.current, 'session.json'))).documents[0].name).toBe('New.sql')
    const offered = await new RecoveryStore(join(directory, profileFiles.autoRecover.current)).list(7)
    expect(offered.map(entry => entry.name).sort()).toEqual(['Orders.sql', 'Query 1', 'Query 2'])
    // Once copied, a record the user discards is never offered again, even by a run that repeats the step.
    const store = new RecoveryStore(join(directory, profileFiles.autoRecover.current))
    await store.list(8)
    await store.discard(offered.map(entry => entry.id), 8)
    const marker = await read(migrationMarker)
    await writeFile(join(directory, migrationMarker), JSON.stringify({ ...marker, done: [] }))
    expect(await migrateProfile(directory)).toMatchObject({ session: 'skipped', autoRecover: 'skipped' })
    expect(await readdir(join(directory, profileFiles.autoRecover.current))).toEqual([])
  })

  it('merges 0.9.0 connections into a library a reconnect wrote while the step waited, and keys their passwords to it', async () => {
    const otherId = randomUUID()
    const other = { id: otherId, options: { server: 'sql-dw-01', database: 'Warehouse', authentication: 'sql', username: 'loader', trustServerCertificate: false, encrypt: 'mandatory' }, favorite: false, registered: true }
    await seed09()
    await writeFile(join(directory, profileFiles.connections.legacy), JSON.stringify({ version: 1, profiles: [...library.profiles, other] }))
    await writeFile(join(directory, profileFiles.savedPasswords.legacy), JSON.stringify({ version: 1, entries: [...passwords.entries, { ...passwords.entries[0], profileId: otherId }] }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failConnections: typeof writeBytesAtomic = async (path, bytes, options) => {
      if (path.endsWith(profileFiles.connections.current)) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return writeBytesAtomic(path, bytes, options)
    }
    expect(await migrateProfile(directory, { write: failConnections })).toMatchObject({ connections: 'failed', savedPasswords: 'failed' })
    // The same run reconnects the first server, which remembers it under a new id and without the favorite.
    const store = new ConnectionStore(join(directory, profileFiles.connections.current))
    await store.rememberEntry(library.profiles[0].options as never)
    const ownId = (await read(profileFiles.connections.current)).profiles[0].id
    expect(ownId).not.toBe(profileId)
    expect(await migrateProfile(directory)).toMatchObject({ connections: 'migrated', savedPasswords: 'migrated' })
    const profiles = (await read(profileFiles.connections.current)).profiles
    expect(profiles.map((profile: { id: string }) => profile.id)).toEqual([ownId, otherId])
    expect(profiles[0].favorite).toBe(true)
    expect((await read(profileFiles.savedPasswords.current)).entries.map((entry: { profileId: string }) => entry.profileId)).toEqual([ownId, otherId])
  })

  it('quarantines an unreadable marker rather than overwriting it, and repeats no step', async () => {
    await seed09()
    await migrateProfile(directory)
    await writeFile(join(directory, migrationMarker), '{ not json')
    expect(await migrateProfile(directory)).toEqual({ connections: 'skipped', savedPasswords: 'skipped', session: 'skipped', autoRecover: 'skipped' })
    expect((await readdir(directory)).some(name => name.startsWith(migrationMarker + '.invalid-'))).toBe(true)
    // It is replaced with every step done, so the next start repeats nothing either.
    expect(await read(migrationMarker)).toEqual({ version: 1, done: ['connections', 'savedPasswords', 'session', 'autoRecover'] })
    expect((await read(profileFiles.connections.current)).profiles).toHaveLength(1)
    expect((await read(profileFiles.savedPasswords.current)).entries).toHaveLength(1)
  })

  it('tries a refused marker write once more at the end, so the next start repeats nothing', async () => {
    await seed09()
    let refused = 0
    const busyMarker: typeof writeBytesAtomic = async (path, bytes, options) => {
      if (path.endsWith(migrationMarker) && refused++ < 4) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      return writeBytesAtomic(path, bytes, options)
    }
    await migrateProfile(directory, { write: busyMarker })
    expect((await read(migrationMarker)).done).toEqual(['connections', 'savedPasswords', 'session', 'autoRecover'])
  })

  it('retries moving a staging folder that Windows briefly refuses', async () => {
    await seed09()
    let refused = 0
    const move: typeof rename = async (from, to) => {
      if (refused++ < 2) throw Object.assign(new Error('held'), { code: 'EPERM' })
      return rename(from, to)
    }
    expect(await migrateProfile(directory, { move, platform: 'win32' })).toMatchObject({ session: 'migrated', autoRecover: 'migrated' })
    expect((await read(join(profileFiles.session.current, 'session.json'))).documents).toEqual(session.documents)
  })

  it('offers each 0.9.0 tab once when an attempt to offer them fails part-way', async () => {
    await seed09()
    const two = { ...session, documents: [...session.documents, { name: 'Lines.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'select 7' }] }
    await writeFile(join(directory, profileFiles.session.legacy, 'session.json'), JSON.stringify(two))
    await mkdir(join(directory, profileFiles.session.current))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let records = 0
    const failSecond: typeof writeBytesAtomic = async (path, bytes, options) => {
      if (path.includes(profileFiles.autoRecover.current) && !path.includes('.migrating-') && records++ === 1) throw Object.assign(new Error('full'), { code: 'ENOSPC' })
      return writeBytesAtomic(path, bytes, options)
    }
    expect((await migrateProfile(directory, { write: failSecond })).session).toBe('failed')
    expect((await migrateProfile(directory)).session).toBe('migrated')
    const offered = await new RecoveryStore(join(directory, profileFiles.autoRecover.current)).list(4)
    expect(offered.map(entry => entry.name).filter(name => name !== 'Query 1').sort()).toEqual(['Lines.sql', 'Orders.sql'])
  })

  it('leaves 0.9.0 tabs waiting while AutoRecover has no room for them', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mkdir(join(directory, profileFiles.session.current))
    const into = join(directory, profileFiles.autoRecover.current)
    const store = new RecoveryStore(into)
    for (let index = 0; index < 64; index++) await store.write({ id: randomUUID(), name: `Query ${index}`, kind: 'sql', eol: 'lf', text: 'select 6' }, 1)
    expect((await migrateProfile(directory)).session).toBe('partial')
    await rm(join(into, (await readdir(into))[0]))
    expect((await migrateProfile(directory)).session).toBe('migrated')
  })

  it.skipIf(process.platform === 'win32')('writes folders 0700 and query and password files 0600', async () => {
    await seed09()
    await migrateProfile(directory)
    const mode = async (name: string) => (await stat(join(directory, name))).mode & 0o777
    expect(await mode(profileFiles.session.current)).toBe(0o700)
    expect(await mode(profileFiles.autoRecover.current)).toBe(0o700)
    expect(await mode(join(profileFiles.session.current, 'session.json'))).toBe(0o600)
    expect(await mode(join(profileFiles.autoRecover.current, recordId + '.json'))).toBe(0o600)
    expect(await mode(profileFiles.savedPasswords.current)).toBe(0o600)
  })

  it('copies saved passwords as they are when there is no library to key them to', async () => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, profileFiles.savedPasswords.legacy), JSON.stringify(passwords))
    expect(await migrateProfile(directory)).toMatchObject({ connections: 'skipped', savedPasswords: 'migrated' })
    expect(await read(profileFiles.savedPasswords.current)).toEqual(passwords)
  })

  it("leaves a marker naming a later version's step alone", async () => {
    await seed09()
    const later = JSON.stringify({ version: 1, done: ['connections', 'bigQueryConnections'] })
    await writeFile(join(directory, migrationMarker), later)
    expect(await migrateProfile(directory)).toEqual({ connections: 'skipped', savedPasswords: 'skipped', session: 'skipped', autoRecover: 'skipped' })
    expect(await readFile(join(directory, migrationMarker), 'utf8')).toBe(later)
  })

  it("leaves a newer version's marker alone and repeats nothing", async () => {
    await seed09()
    await migrateProfile(directory)
    const store = new ConnectionStore(join(directory, profileFiles.connections.current))
    await store.remove((await read(profileFiles.connections.current)).profiles[0].id)
    const newer = JSON.stringify({ version: 2, done: ['connections', 'bigQueryConnections'] })
    await writeFile(join(directory, migrationMarker), newer)
    expect(await migrateProfile(directory)).toEqual({ connections: 'skipped', savedPasswords: 'skipped', session: 'skipped', autoRecover: 'skipped' })
    expect(await readFile(join(directory, migrationMarker), 'utf8')).toBe(newer)
    expect((await read(profileFiles.connections.current)).profiles).toEqual([])
  })

  it('offers 0.9.0 tabs through AutoRecover once a newer run made the session folder, even when it left it empty', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failFolders: typeof writeBytesAtomic = async (path, bytes, options) => {
      if (path.includes('.migrating-')) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      return writeBytesAtomic(path, bytes, options)
    }
    expect(await migrateProfile(directory, { write: failFolders })).toMatchObject({ session: 'failed' })
    // 0.10.0 runs and closes with nothing kept: the folder exists and is empty.
    const tabs = new SessionStore(join(directory, profileFiles.session.current))
    await tabs.take(true)
    await tabs.write({ documents: [{ name: 'New.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'select 5' }], activeIndex: 0 }, 1)
    await tabs.clear()
    expect(await readdir(join(directory, profileFiles.session.current))).toEqual([])
    expect(await migrateProfile(directory)).toMatchObject({ session: 'migrated' })
    // The newer, empty session stays; 0.9.0's unsaved tab is offered, not reopened.
    expect(await readdir(join(directory, profileFiles.session.current))).toEqual([])
    const offered = await new RecoveryStore(join(directory, profileFiles.autoRecover.current)).list(3)
    expect(offered.map(entry => entry.name)).toContain('Orders.sql')
  })

  it('adds no 0.9.0 password for credentials the 0.10.0 file already has one for', async () => {
    const otherId = randomUUID()
    // Another database on the same server and login: another key, the same binding.
    const other = { ...library.profiles[0], id: otherId, options: { ...library.profiles[0].options, database: 'Archive' } }
    await seed09()
    await writeFile(join(directory, profileFiles.connections.legacy), JSON.stringify({ version: 1, profiles: [other] }))
    await writeFile(join(directory, profileFiles.savedPasswords.legacy), JSON.stringify({ version: 1, entries: [{ ...passwords.entries[0], profileId: otherId }] }))
    const newer = { profileId, revision: randomUUID(), binding: passwords.entries[0].binding, cipher: Buffer.from('newer').toString('base64'), savedAt: '2026-11-18T10:00:00.000Z' }
    await writeFile(join(directory, profileFiles.connections.current), JSON.stringify(library))
    await writeFile(join(directory, profileFiles.savedPasswords.current), JSON.stringify({ version: 1, entries: [newer] }))
    expect(await migrateProfile(directory)).toMatchObject({ connections: 'migrated', savedPasswords: 'skipped' })
    expect((await read(profileFiles.connections.current)).profiles.map((profile: { id: string }) => profile.id)).toEqual([profileId, otherId])
    expect((await read(profileFiles.savedPasswords.current)).entries).toEqual([newer])
  })

  it('copies no AutoRecover record past the store\'s byte cap', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const into = join(directory, profileFiles.autoRecover.current)
    await mkdir(into)
    // A record file that leaves a few bytes under the 256 MB cap (its size is all the count reads).
    const big = join(into, randomUUID() + '.json')
    await writeFile(big, '')
    await truncate(big, recoveryLimits.totalBytes - 16)
    expect((await migrateProfile(directory)).autoRecover).toBe('partial')
    expect(await readdir(into)).not.toContain(recordId + '.json')
    await rm(big)
    expect((await migrateProfile(directory)).autoRecover).toBe('migrated')
  })

  it('copies AutoRecover records only while the folder has room, and the rest at a later start', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const into = join(directory, profileFiles.autoRecover.current)
    await mkdir(into)
    const store = new RecoveryStore(into)
    for (let index = 0; index < 64; index++) await store.write({ id: randomUUID(), name: `Query ${index}`, kind: 'sql', eol: 'lf', text: 'select 6' }, 1)
    expect((await migrateProfile(directory)).autoRecover).toBe('partial')
    expect(await readdir(into)).not.toContain(recordId + '.json')
    const own = (await readdir(into))[0]
    await rm(join(into, own))
    expect((await migrateProfile(directory)).autoRecover).toBe('migrated')
    expect(await readdir(into)).toContain(recordId + '.json')
  })

  it('copies the AutoRecover records it can when one cannot be read, and only that one later', async () => {
    await seed09()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stuck = randomUUID() + '.json'
    await mkdir(join(directory, profileFiles.autoRecover.legacy, stuck))
    expect((await migrateProfile(directory)).autoRecover).toBe('failed')
    expect(await readdir(join(directory, profileFiles.autoRecover.current))).toEqual([recordId + '.json'])
    await rm(join(directory, profileFiles.autoRecover.current, recordId + '.json'))
    expect((await migrateProfile(directory)).autoRecover).toBe('failed')
    expect(await readdir(join(directory, profileFiles.autoRecover.current))).toEqual([])
  })

  it('never copies a 0.9.0 file back once its step finished, even when the 0.10.0 file is later quarantined', async () => {
    await seed09()
    await migrateProfile(directory)
    await rename(join(directory, profileFiles.connections.current), join(directory, profileFiles.connections.current + '.invalid-x.json'))
    await rm(join(directory, profileFiles.autoRecover.current), { recursive: true })
    expect(await migrateProfile(directory)).toEqual({ connections: 'skipped', savedPasswords: 'skipped', session: 'skipped', autoRecover: 'skipped' })
    expect(await readdir(directory)).not.toContain(profileFiles.connections.current)
    expect(await readdir(directory)).not.toContain(profileFiles.autoRecover.current)
  })

  it('removes a staging folder left by a run that stopped mid-copy', async () => {
    const left = join(directory, `${profileFiles.session.current}.migrating-${randomUUID()}`)
    await mkdir(left)
    await writeFile(join(left, 'session.json'), '{}')
    await migrateProfile(directory)
    expect(await readdir(directory)).toEqual([migrationMarker])
  })
})

