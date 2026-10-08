import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore } from '../src/main/connection-store'
import { connectionDefaults, connectionKey, connectionLibrarySchema, connectionOptionsSchema, savedConnection } from '../src/shared/connections'
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
    const options = { ...connectionDefaults, advanced: { commandTimeout: 0, connectTimeout: 0, packetSize: 8000, networkProtocol: 'tcp', applicationIntent: 'ReadOnly' }, encrypt: 'strict' }
    for (const method of ['connections.connect', 'connections.databases', 'connections.preview']) expect(validateRequest(method, options)).toEqual(options)
    for (const advanced of [{ packetSize: 511 }, { connectRetryInterval: 0 }, { commandTimeout: -1 }, { networkProtocol: 'shell' }, { arbitrarySql: 'SELECT 1' }]) expect(connectionOptionsSchema.safeParse({ ...connectionDefaults, advanced }).success).toBe(false)
    expect(connectionOptionsSchema.safeParse({ ...connectionDefaults, color: 'red; background:url(...)' }).success).toBe(false)
    expect(() => validateRequest('connections.discover', { scope: 'azure' })).toThrow()
  })
  it('removes passwords, and separates authentication/advanced settings in saved identities', () => {
    const sql = { ...connectionDefaults, authentication: 'sql' as const, username: 'reader', password: 'secret' }
    expect(savedConnection(sql)).not.toHaveProperty('password')
    expect(connectionKey(sql)).toBe(connectionKey({ ...sql, password: 'different', color: '#abcdef', displayName: 'Staging' }))
    expect(connectionKey(sql)).not.toBe(connectionKey({ ...sql, username: 'other' }))
    expect(connectionKey(sql)).not.toBe(connectionKey({ ...sql, advanced: { applicationIntent: 'ReadOnly' } }))
    expect(connectionLibrarySchema.safeParse({ version: 1, profiles: [{ id: crypto.randomUUID(), options: sql, favorite: true, registered: false }] }).success).toBe(false)
  })
})
describe('saved connection library', () => {
  it('persists favorites, registered servers, and recent connections without credentials', async () => {
    const { store: library, path } = await store()
    const options = { ...connectionDefaults, authentication: 'sql' as const, username: 'reader', password: 'secret-marker', displayName: 'Development', color: '#e66b73', advanced: { commandTimeout: 12 } }
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
    await library.save({ options: { ...connectionDefaults, server: 'favorite-old' }, favorite: true })
    await Promise.all(Array.from({ length: 34 }, (_, index) => library.remember({ ...connectionDefaults, server: 'server-' + index })))
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
