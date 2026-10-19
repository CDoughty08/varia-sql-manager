import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore } from '../src/main/connection-store'
import { advancedDefaults, advancedToStore, connectionDefaults, connectionKey, defaultAuthentication, connectionLibrarySchema, connectionOptionsSchema, savedConnection } from '../src/shared/connections'
import { validateRequest } from '../src/main/validation'

const directories: string[] = []
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'varia-connections-'))
  directories.push(directory)
  const path = join(directory, 'connections.json')
  return { store: new ConnectionStore(path), directory, path }
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe('connection settings', () => {
  it('accepts default database selection and bounded provider settings at the IPC boundary', () => {
    const options = { ...connectionDefaults('win32'), advanced: { commandTimeout: 0, connectTimeout: 0, packetSize: 8000, networkProtocol: 'tcp', applicationIntent: 'ReadOnly' }, encrypt: 'strict' }
    for (const method of ['connections.connect', 'connections.databases', 'connections.preview']) expect(validateRequest(method, options)).toEqual(options)
    for (const advanced of [{ packetSize: 511 }, { connectRetryInterval: 0 }, { commandTimeout: -1 }, { networkProtocol: 'shell' }, { arbitrarySql: 'SELECT 1' }]) expect(connectionOptionsSchema.safeParse({ ...connectionDefaults('win32'), advanced }).success).toBe(false)
    expect(connectionOptionsSchema.safeParse({ ...connectionDefaults('win32'), color: 'red; background:url(...)' }).success).toBe(false)
    expect(() => validateRequest('connections.discover', { scope: 'azure' })).toThrow()
  })
  it('removes passwords, and separates authentication/advanced settings in saved identities', () => {
    const sql = { ...connectionDefaults('win32'), authentication: 'sql' as const, username: 'reader', password: 'secret' }
    expect(savedConnection(sql)).not.toHaveProperty('password')
    expect(connectionKey(sql)).toBe(connectionKey({ ...sql, password: 'different', color: '#abcdef', displayName: 'Staging' }))
    expect(connectionKey(sql)).not.toBe(connectionKey({ ...sql, username: 'other' }))
    expect(connectionKey(sql)).not.toBe(connectionKey({ ...sql, advanced: { applicationIntent: 'ReadOnly' } }))
    expect(connectionLibrarySchema.safeParse({ version: 1, profiles: [{ id: crypto.randomUUID(), options: sql, favorite: true, registered: false }] }).success).toBe(false)
  })
})
describe('per-platform authentication defaults', () => {
  it('opens with Windows authentication on Windows and SQL Server authentication on Linux and macOS', () => {
    expect(connectionDefaults('win32')).toMatchObject({ server: 'localhost', authentication: 'windows' })
    for (const platform of ['linux', 'darwin', 'freebsd']) expect(connectionDefaults(platform)).toMatchObject({ server: 'localhost', authentication: 'sql' })
    expect(defaultAuthentication('win32')).toBe('windows')
    // Each call is a fresh object, so a dialog that edits its options never changes the defaults.
    expect(connectionDefaults('linux')).not.toBe(connectionDefaults('linux'))
  })
  it('keeps a saved integrated profile on Linux and macOS: it parses, connects as saved, and is not rewritten to SQL authentication', async () => {
    const { store: library, path } = await store()
    const integrated = { server: 'kerberos-sql.contoso.com', database: 'master', authentication: 'windows' as const, trustServerCertificate: false, encrypt: 'mandatory' as const }
    await writeFile(path, JSON.stringify({ version: 1, profiles: [{ id: crypto.randomUUID(), options: integrated, favorite: true, registered: false }] }))
    const loaded = await library.load()
    expect(loaded.warning).toBeUndefined()
    expect(loaded.library.profiles[0].options).toEqual(integrated)
    // The renderer sends the saved choice unchanged on every platform; main validates it without consulting the platform.
    expect(validateRequest('connections.connect', integrated)).toEqual(integrated)
    await library.remember(integrated)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.profiles).toHaveLength(1)
    expect(stored.profiles[0].options.authentication).toBe('windows')
  })
})
describe('saved connection library', () => {
  it('persists favorites, registered servers, and recent connections without credentials', async () => {
    const { store: library, path } = await store()
    const options = { ...connectionDefaults('win32'), authentication: 'sql' as const, username: 'reader', password: 'secret-marker', displayName: 'Development', color: '#e66b73', advanced: { commandTimeout: 12 } }
    let state = await library.save({ options, favorite: true, registered: true })
    const id = state.profiles[0].id
    await library.remember(options)
    state = (await new ConnectionStore(path).load()).library
    expect(state.profiles).toHaveLength(1)
    expect(state.profiles[0]).toMatchObject({ id, favorite: true, registered: true, lastConnected: expect.any(String), options: { color: '#e66b73', advanced: { commandTimeout: 12 } } })
    expect(await readFile(path, 'utf8')).not.toContain('secret-marker')
    expect(await readFile(path, 'utf8')).not.toContain('password')
    state = await library.save({ id, options: { ...options, displayName: 'Updated' }, favorite: false })
    expect(state.profiles[0]).toMatchObject({ favorite: false, registered: true, options: { displayName: 'Updated' } })
    expect((await library.remove(id)).profiles).toEqual([])
  })
  it('serializes concurrent writes and caps history without deleting favorites', async () => {
    const { store: library } = await store()
    await library.save({ options: { ...connectionDefaults('win32'), server: 'favorite-old' }, favorite: true })
    await Promise.all(Array.from({ length: 34 }, (_, index) => library.remember({ ...connectionDefaults('win32'), server: 'server-' + index })))
    const { profiles } = (await library.load()).library
    expect(profiles.filter(profile => profile.lastConnected)).toHaveLength(30)
    expect(profiles.find(profile => profile.options.server === 'favorite-old')?.favorite).toBe(true)
    expect(new Set(profiles.map(profile => profile.id)).size).toBe(profiles.length)
  })
  it('refuses to replace a directory found at the library path', async () => {
    const { directory } = await store()
    await expect(new ConnectionStore(directory).load()).rejects.toThrow('regular file')
    expect(await readdir(directory)).toEqual([])
  })
  it('recovers malformed storage while preserving the original file', async () => {
    const { store: library, path, directory } = await store()
    await writeFile(path, '{ broken')
    expect(await library.load()).toMatchObject({ library: { version: 1, profiles: [] }, warning: expect.any(String) })
    expect((await readdir(directory)).some(name => name.includes('.invalid-'))).toBe(true)
  })
})

describe('Advanced Properties OK', () => {
  const draft = (patch: Record<string, unknown> = {}) => ({ ...advancedDefaults, commandTimeout: '', ...patch }) as Parameters<typeof advancedToStore>[0]
  it('stores only the fields that differ from their defaults or that were edited, so an empty command timeout follows Tools › Options', () => {
    expect(advancedToStore(draft(), new Set())).toEqual({})
    expect(advancedToStore(draft({ packetSize: 4096, applicationName: 'Varia SQL Manager' }), new Set(['applicationName']))).toEqual({ packetSize: 4096, applicationName: 'Varia SQL Manager' })
    // An explicit 0 typed into Command timeout means no timeout, whatever Options says; left empty, it is not stored.
    expect(advancedToStore(draft({ commandTimeout: 0 }), new Set(['commandTimeout']))).toEqual({ commandTimeout: 0 })
    expect(advancedToStore(draft(), new Set(['commandTimeout']))).toEqual({})
  })
  it('keeps a command timeout the profile already stored, and the profile\'s identity', () => {
    expect(advancedToStore(draft({ commandTimeout: 0 }), new Set(), { commandTimeout: 0 })).toEqual({ commandTimeout: 0 })
    const options = { ...connectionDefaults('win32'), server: 'db' }
    expect(connectionKey({ ...options, advanced: advancedToStore(draft(), new Set()) })).toBe(connectionKey({ ...options, advanced: advancedDefaults }))
  })
})
