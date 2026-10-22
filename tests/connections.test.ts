import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore } from '../src/main/connection-store'
import { advancedDefaults, advancedToStore, canRememberPassword, connectContextSchema, connectionDefaults, connectionKey, credentialBinding, defaultAuthentication, connectionLibrarySchema, connectionOptionsSchema, rememberedProfile, savedConnection, type ConnectionProfile } from '../src/shared/connections'
import { validateRequest, validateResult } from '../src/main/validation'

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
describe('integrated identity', () => {
  it('asks the backend with no parameters, and passes on only a bounded one-line principal', () => {
    expect(validateRequest('connections.identity', {})).toEqual({})
    expect(() => validateRequest('connections.identity', { user: 'alice' })).toThrow()
    expect(validateResult('connections.identity', { principal: 'alice@CONTOSO.COM' })).toEqual({ principal: 'alice@CONTOSO.COM' })
    expect(validateResult('connections.identity', { principal: 'é'.repeat(256) })).toEqual({ principal: 'é'.repeat(256) })
    expect(validateResult('connections.identity', {})).toEqual({})
    // Code points, not UTF-16 units, as the backend's Bounded reads them: a tag character (Cf) is refused, a script letter is not.
    expect(validateResult('connections.identity', { principal: '\u{1D49C}lice@X' })).toEqual({ principal: '\u{1D49C}lice@X' })
    for (const answer of [{ principal: 'a'.repeat(257) }, { principal: '' }, { principal: 'alice\n@CONTOSO.COM' }, { principal: '‮alice@CONTOSO.COM' }, { principal: 'al​ice' }, { principal: 'alice\u{E0041}@X' },
      { principal: 7 }, { principal: 'alice@CONTOSO.COM', password: 'x' }, null]) expect(() => validateResult('connections.identity', answer), JSON.stringify(answer)).toThrow('The backend sent an invalid answer.')
    // Other answers are passed on as they are.
    expect(validateResult('databases.list', [{ name: 'master' }])).toEqual([{ name: 'master' }])
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
  it('returns the id of the history entry a connection touched', async () => {
    const { store: library, path } = await store()
    const options = { ...connectionDefaults('win32'), authentication: 'sql' as const, username: 'reader', password: 'secret-marker' }
    const first = await library.rememberEntry(options)
    expect(first.library.profiles.map(profile => profile.id)).toEqual([first.id])
    // The same connection again touches the same entry; another database is another entry.
    expect((await library.rememberEntry({ ...options, password: 'other' })).id).toBe(first.id)
    const second = await library.rememberEntry({ ...options, database: 'Sales' })
    expect(second.id).not.toBe(first.id)
    expect(second.library.profiles.find(profile => profile.id === second.id)?.options.database).toBe('Sales')
    expect(await readFile(path, 'utf8')).not.toContain('secret-marker')
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

describe('remembered password bindings', () => {
  const sql = { ...connectionDefaults('linux'), server: 'Sql-Prod', authentication: 'sql' as const, username: 'reader', password: 'secret' }
  it('binds a password to where it goes and how the server is verified, not to the database, name or color', () => {
    const binding = credentialBinding(sql)
    for (const same of [{ database: 'Sales' }, { displayName: 'Production' }, { color: '#abcdef' }, { password: 'other' }, { server: '  sql-prod ' }, { advanced: { packetSize: 4096, applicationName: 'x' } },
      { encrypt: 'mandatory' as const }, { advanced: { networkProtocol: 'default' as const } }]) expect(credentialBinding({ ...sql, ...same }), JSON.stringify(same)).toBe(binding)
    // Strict ignores Trust server certificate, as the connection does.
    expect(credentialBinding({ ...sql, encrypt: 'strict', trustServerCertificate: true })).toBe(credentialBinding({ ...sql, encrypt: 'strict' }))
    for (const other of [{ server: 'sql-test' }, { authentication: 'windows' as const }, { username: 'admin' }, { encrypt: 'optional' as const }, { encrypt: 'strict' as const }, { trustServerCertificate: true },
      { hostNameInCertificate: 'x.example' }, { advanced: { serverCertificate: '/c.cer' } }, { advanced: { failoverPartner: 'mirror' } }, { advanced: { networkProtocol: 'np' as const } }]) expect(credentialBinding({ ...sql, ...other }), JSON.stringify(other)).not.toBe(binding)
  })
  it('remembers passwords for SQL Server Authentication only', () => {
    expect(canRememberPassword('sql')).toBe(true)
    expect(canRememberPassword('windows')).toBe(false)
  })
  it('picks the selected entry, then the most recent, a favorite, and a registered one with the same credentials', () => {
    const { password: _password, ...saved } = sql
    const entry = (id: string, patch: Partial<ConnectionProfile> = {}, options: Partial<typeof saved> = {}): ConnectionProfile => ({ id, options: { ...saved, ...options }, favorite: false, registered: false, ...patch })
    const profiles = [
      entry('registered', { registered: true }), entry('favorite', { favorite: true }), entry('old', { lastConnected: '2026-01-01T00:00:00.000Z' }),
      entry('new', { lastConnected: '2026-06-01T00:00:00.000Z' }, { database: 'Sales' }), entry('elsewhere', { lastConnected: '2026-09-01T00:00:00.000Z' }, { server: 'other' }), entry('unsaved', { lastConnected: '2026-10-01T00:00:00.000Z' })
    ]
    const all = new Set(['registered', 'favorite', 'old', 'new', 'elsewhere'])
    expect(rememberedProfile(profiles, all, sql)?.id).toBe('new')
    expect(rememberedProfile(profiles, all, sql, 'old')?.id).toBe('old')
    // A selected entry without a password, or for other credentials, falls back to the best match.
    expect(rememberedProfile(profiles, all, sql, 'unsaved')?.id).toBe('new')
    expect(rememberedProfile(profiles, all, sql, 'elsewhere')?.id).toBe('new')
    expect(rememberedProfile(profiles, new Set(['registered', 'favorite']), sql)?.id).toBe('favorite')
    expect(rememberedProfile(profiles, new Set(['registered']), sql)?.id).toBe('registered')
    expect(rememberedProfile(profiles, new Set(['elsewhere']), sql)).toBeUndefined()
    expect(rememberedProfile(profiles, all, { ...sql, username: 'admin' })).toBeUndefined()
    expect(rememberedProfile(profiles.map(profile => ({ ...profile, options: { ...profile.options, authentication: 'windows' as const } })), all, { ...sql, authentication: 'windows' })).toBeUndefined()
  })
  it('accepts only an entry id and the Remember password choice as the connect context', () => {
    const profileId = crypto.randomUUID()
    expect(connectContextSchema.parse({ profileId, remember: true })).toEqual({ profileId, remember: true })
    expect(connectContextSchema.parse({})).toEqual({})
    for (const value of [{ profileId: 'abc' }, { profileId, password: 'x' }, { remember: 'yes' }, { profileId, remember: true, server: 'evil' }]) expect(connectContextSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
  })
})
