import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore } from '../src/main/connection-store'
import { validateRequest } from '../src/main/validation'
import { connectionDefaults, connectionKey, connectionLibrarySchema, connectionOptionsSchema, credentialBinding, savedConnection } from '../src/shared/connections'
import type { ConnectionInfo, ConnectionOptions } from '../src/shared/contracts'
import { environmentPreset, environmentPresets, environmentSchema, environmentTag, maxEnvironmentLength } from '../src/shared/environments'
import { statusTones } from '../src/shared/theme/tones'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { applyEnvironment, entryKey, parseEnvironment, savedEntry } from '../src/renderer/src/services/environments'
import { connectionLibrary } from '../src/main/connection-library'
import { prepare, settle, type ConnectionRequestDeps } from '../src/main/connection-requests'
import { connectionInfo } from './fixtures/workbench'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const base: ConnectionOptions = { ...connectionDefaults('win32'), server: 'sql-prod-01', database: 'Sales' }
async function tempStore() {
  const directory = await mkdtemp(join(tmpdir(), 'varia-environments-'))
  directories.push(directory)
  const path = join(directory, 'connections.json')
  return { path, store: new ConnectionStore(path) }
}

describe('environment tags', () => {
  it('shows Production as the red PROD tag, Staging in the info tone, and the rest without a state colour', () => {
    expect(environmentPresets).toEqual(['Production', 'Staging', 'Test', 'Development'])
    expect(environmentTag('Production')).toEqual({ tone: 'critical', text: 'PROD', description: 'Production environment' })
    expect(environmentTag('Staging')).toEqual({ tone: 'info', text: 'STAGING', description: 'Staging environment' })
    expect(environmentTag('Test')).toEqual({ tone: 'neutral', text: 'TEST', description: 'Test environment' })
    expect(environmentTag('Development')).toEqual({ tone: 'neutral', text: 'DEV', description: 'Development environment' })
    // A custom label shows as typed; one that spells a preset in another case is that preset, so "production" is red too.
    expect(environmentTag(' UAT-EU ')).toEqual({ tone: 'neutral', text: 'UAT-EU', description: 'UAT-EU environment' })
    expect(environmentTag('production')).toMatchObject({ tone: 'critical', text: 'PROD' })
    expect(environmentPreset('STAGING')).toBe('Staging')
    expect(environmentPreset('Prod')).toBeUndefined()
    for (const none of [undefined, '', '   ']) expect(environmentTag(none)).toBeUndefined()
    for (const preset of environmentPresets) expect(statusTones).toContain(environmentTag(preset)!.tone)
  })
  it('bounds a label to 32 visible characters, without control, format or line separator characters', () => {
    expect(environmentSchema.parse('  Production  ')).toBe('Production')
    expect(environmentSchema.safeParse('P'.repeat(maxEnvironmentLength)).success).toBe(true)
    for (const bad of ['', '   ', 'P'.repeat(maxEnvironmentLength + 1), 'PROD\u0007', 'PR\u202eOD', 'PR\u2028OD', 'PR\nOD', 'PR\u200bOD']) expect(environmentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
})

describe('environment in the connection options', () => {
  it('is validated at the IPC boundary with the other options, and is optional', () => {
    for (const method of ['connections.connect', 'connections.databases', 'connections.preview']) {
      expect(validateRequest(method, { ...base, environment: 'Production' })).toMatchObject({ environment: 'Production' })
      expect(validateRequest(method, base)).not.toHaveProperty('environment')
      expect(() => validateRequest(method, { ...base, environment: 'x'.repeat(33) }), method).toThrow()
      expect(() => validateRequest(method, { ...base, environment: 42 }), method).toThrow()
    }
    expect(connectionOptionsSchema.safeParse({ ...base, environment: '\u0000' }).success).toBe(false)
  })
  it('is saved with the profile and read back, and a hand-edited file with a bad label is refused', () => {
    expect(savedConnection({ ...base, environment: 'Staging', password: 'x' })).toEqual({ ...base, environment: 'Staging' })
    const profile = { id: crypto.randomUUID(), options: { ...base, environment: 'Production' }, favorite: true, registered: false }
    expect(connectionLibrarySchema.safeParse({ version: 1, profiles: [profile] }).success).toBe(true)
    expect(connectionLibrarySchema.safeParse({ version: 1, profiles: [{ ...profile, options: { ...base, environment: 'P'.repeat(40) } }] }).success).toBe(false)
  })
  it('labels the entry without making it another one or moving its remembered password', () => {
    expect(connectionKey({ ...base, environment: 'Production' })).toBe(connectionKey(base))
    expect(credentialBinding({ ...base, environment: 'Production' })).toBe(credentialBinding(base))
  })
  it('updates the history entry a connection made, keeping it recent and a favorite', async () => {
    const { path, store } = await tempStore()
    const { id } = await store.rememberEntry({ ...base, environment: 'Production' })
    await store.save({ id, options: { ...base, environment: 'Production' }, favorite: true })
    const library = await store.save({ options: { ...base, environment: 'Staging' } })
    expect(library.profiles).toHaveLength(1)
    expect(library.profiles[0]).toMatchObject({ id, favorite: true, options: { environment: 'Staging' }, lastConnected: expect.any(String) })
    await store.save({ options: base })
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0].options).not.toHaveProperty('environment')
  })
  it('keeps a saved label when a connect does not carry one, unless the user set the form\'s Environment', async () => {
    const { path, store } = await tempStore()
    await store.save({ options: { ...base, environment: 'Production' }, favorite: true })
    const deps: ConnectionRequestDeps = { connections: store, savedPasswords: { get: async () => undefined, set: async () => {}, forget: async () => {}, forgetCredentials: async () => {}, reconcile: async () => ({ ids: [] }) } }
    const connect = async (options: ConnectionOptions, context?: unknown) => {
      const info: ConnectionInfo = { id: crypto.randomUUID(), server: options.server, database: options.database, serverVersion: '17.0', generation: 1 }
      const settled = await settle(await prepare('connections.connect', validateRequest('connections.connect', options), context, deps), { ok: true, value: info }, deps)
      return settled.ok ? settled.value as ConnectionInfo : undefined
    }
    const saved = async () => JSON.parse(await readFile(path, 'utf8')).profiles.map((profile: { options: ConnectionOptions }) => profile.options.environment)
    // The server typed by hand, in another case, before the dialog showed the entry's label: the label stays, and the
    // answer says so, so the connection shows PROD.
    expect(await connect({ ...base, server: 'SQL-PROD-01' }, { remember: false })).toMatchObject({ environment: 'Production' })
    expect(await saved()).toEqual(['Production'])
    // A connect that carries the label changes nothing and needs no correction.
    expect(await connect({ ...base, environment: 'Production' }, { remember: false })).not.toHaveProperty('environment')
    // The user set another label, or cleared it, in the form.
    expect(await connect({ ...base, environment: 'Staging' }, { remember: false })).not.toHaveProperty('environment')
    expect(await saved()).toEqual(['Staging'])
    expect(await connect(base, { remember: false, setsEnvironment: true })).not.toHaveProperty('environment')
    expect(await saved()).toEqual([undefined])
    expect(() => validateRequest('connections.connect', base)).not.toThrow()
    await expect(prepare('connections.connect', base, { setsEnvironment: 'yes' }, deps)).rejects.toThrow('Invalid request.')
  })
  it('finds the saved entry a typed form names, so the dialog shows its label before connecting', () => {
    const production = { id: crypto.randomUUID(), options: { ...base, environment: 'Production' }, favorite: true, registered: false }
    const staging = { id: crypto.randomUUID(), options: { ...base, database: 'master', environment: 'Staging' }, favorite: true, registered: false }
    const profiles = [staging, production], keys = new Map(profiles.map(profile => [profile.id, entryKey(profile.options)]))
    expect(savedEntry(profiles, keys, { ...base, server: ' SQL-PROD-01 ', database: 'SALES' })).toBe(production)
    expect(savedEntry(profiles, keys, { ...base, database: 'master', displayName: 'Other name', environment: 'Test' })).toBe(staging)
    expect(savedEntry(profiles, keys, { ...base, database: 'Other' })).toBeUndefined()
    // An incomplete form names none.
    expect(savedEntry(profiles, keys, { ...base, server: '' })).toBeUndefined()
    expect(savedEntry(profiles, keys, { ...base, authentication: 'sql' })).toBeUndefined()
  })
})

describe('Set Connection Environment', () => {
  function service() {
    const connections = new ConnectionService()
    connections.add(connectionInfo('a'), { ...base, password: 'never-keep-this' })
    // Another connection to the same entry (a second Object Explorer connection), and one to another database.
    connections.add(connectionInfo('b'), base)
    connections.add(connectionInfo('c'), { ...base, database: 'master' })
    return connections
  }
  /** main's side as `window.varia.setConnectionEnvironment` reaches it, over a real connections.json. */
  async function mainSide() {
    const store = await tempStore()
    const library = connectionLibrary({ connections: store.store, savedPasswords: { reconcile: async () => ({ ids: [] }), forget: async () => {}, state: async () => ({ available: true }) } })
    const setEnvironment = vi.fn(async (input: unknown) => { try { return { ok: true as const, value: await library.setEnvironment(input) } } catch (error) { return { ok: false as const, error: (error as Error).message } } })
    return { ...store, setEnvironment }
  }
  it('changes only the label of the entry in connections.json, then shows it on every connection to that entry', async () => {
    const connections = service(), { store, path, setEnvironment } = await mainSide()
    const { id } = await store.rememberEntry(base)
    // Edited after connecting (Save changes): the label must not revert the name or colour to the connect-time options.
    await store.save({ id, options: { ...base, displayName: 'Sales (prod)', color: '#3366cc' }, favorite: true })
    expect(await applyEnvironment({ connections, setEnvironment }, 'a', 'production')).toEqual({ ok: true, environment: 'Production' })
    expect(setEnvironment.mock.calls).toEqual([[{ options: base, environment: 'Production' }]])
    expect(connections.getSnapshot().map(connection => connection.options.environment)).toEqual(['Production', 'Production', undefined])
    expect(JSON.stringify(setEnvironment.mock.calls)).not.toContain('never-keep-this')
    const saved = JSON.parse(await readFile(path, 'utf8')).profiles
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ id, favorite: true, lastConnected: expect.any(String), options: { ...base, displayName: 'Sales (prod)', color: '#3366cc', environment: 'Production' } })
    // None removes it, and only it.
    expect(await applyEnvironment({ connections, setEnvironment }, 'b', undefined)).toEqual({ ok: true })
    expect(setEnvironment.mock.calls[1]).toEqual([{ options: base }])
    expect(connections.getSnapshot().map(connection => 'environment' in connection.options)).toEqual([false, false, false])
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0].options).toEqual({ ...base, displayName: 'Sales (prod)', color: '#3366cc' })
  })
  it('saves the label for a connected server whose entry was removed from history or pushed out of it', async () => {
    const connections = service(), { store, path, setEnvironment } = await mainSide()
    const { id } = await store.rememberEntry(base)
    await store.remove(id)
    expect(await applyEnvironment({ connections, setEnvironment }, 'a', 'Production')).toEqual({ ok: true, environment: 'Production' })
    let saved = JSON.parse(await readFile(path, 'utf8')).profiles
    expect(saved).toEqual([expect.objectContaining({ favorite: false, registered: false, lastConnected: expect.any(String), options: { ...base, environment: 'Production' } })])
    // Thirty newer connections push it out of the recent list; relabelling saves it again, as the most recent.
    for (let index = 0; index < 30; index++) await store.rememberEntry({ ...base, database: `db${index}` })
    expect((await store.load()).library.profiles.some(profile => profile.options.database === base.database)).toBe(false)
    expect(await applyEnvironment({ connections, setEnvironment }, 'a', 'Staging')).toEqual({ ok: true, environment: 'Staging' })
    saved = JSON.parse(await readFile(path, 'utf8')).profiles
    expect(saved).toHaveLength(30)
    expect(saved.filter((profile: { options: ConnectionOptions }) => profile.options.database === base.database)).toEqual([expect.objectContaining({ options: { ...base, environment: 'Staging' } })])
  })
  it('changes nothing on screen when the label is invalid, the server has gone, saving fails, or the library written lacks the label', async () => {
    const connections = service()
    const setEnvironment = vi.fn(async () => ({ ok: false as const, error: 'The saved connection library could not be written.' }))
    expect(await applyEnvironment({ connections, setEnvironment }, 'a', '')).toEqual({ ok: false, error: 'Enter an environment label.' })
    expect(await applyEnvironment({ connections, setEnvironment }, 'gone', 'Test')).toEqual({ ok: false, error: 'This server is no longer connected.' })
    expect(setEnvironment).not.toHaveBeenCalled()
    expect(await applyEnvironment({ connections, setEnvironment }, 'a', 'Test')).toEqual({ ok: false, error: 'The saved connection library could not be written.' })
    const thrown = vi.fn(async () => { throw new Error('IPC failed.') })
    expect(await applyEnvironment({ connections, setEnvironment: thrown }, 'a', 'Test')).toEqual({ ok: false, error: 'IPC failed.' })
    // main answered ok, but the library it wrote has no entry for this connection, or one without the label.
    const without = vi.fn(async () => ({ ok: true as const, value: { library: { version: 1 as const, profiles: [] }, savedPasswords: [] } }))
    expect(await applyEnvironment({ connections, setEnvironment: without }, 'a', 'Production')).toEqual({ ok: false, error: 'The environment could not be saved with this connection.' })
    const unlabelled = vi.fn(async () => ({ ok: true as const, value: { library: { version: 1 as const, profiles: [{ id: crypto.randomUUID(), options: base, favorite: true, registered: false }] }, savedPasswords: [] } }))
    expect(await applyEnvironment({ connections, setEnvironment: unlabelled }, 'a', 'Production')).toEqual({ ok: false, error: 'The environment could not be saved with this connection.' })
    expect(connections.getSnapshot().some(connection => connection.options.environment)).toBe(false)
  })
  it('refuses a bad label or unknown member at main, writing nothing', async () => {
    const { path, setEnvironment } = await mainSide()
    for (const input of [{ options: base, environment: 'P'.repeat(33) }, { options: base, environment: 'PR\u202eOD' }, { options: base, environment: 'Production', id: crypto.randomUUID() }, { options: { ...base, server: '' }, environment: 'Production' }])
      expect(await setEnvironment(input), JSON.stringify(input)).toMatchObject({ ok: false })
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })
  it('parses the field: None, a preset by its own name, a custom label, or a Custom label left blank', () => {
    expect(parseEnvironment(undefined)).toEqual({ ok: true })
    expect(parseEnvironment('STAGING')).toEqual({ ok: true, environment: 'Staging' })
    expect(parseEnvironment(' UAT ')).toEqual({ ok: true, environment: 'UAT' })
    expect(parseEnvironment(' ')).toEqual({ ok: false, error: 'Enter an environment label.' })
    expect(parseEnvironment('x'.repeat(33))).toEqual({ ok: false, error: 'An environment label has at most 32 characters.' })
  })
  it('keeps the label on a lost connection, so Reconnect fills it in', () => {
    const connections = service()
    connections.markLostBefore(2)
    expect(connections.relabel('a', 'Production')).toEqual({ ...base, environment: 'Production' })
    expect(connections.get('b')).toMatchObject({ lost: true, options: { environment: 'Production' } })
    expect(connections.relabel('gone', 'Production')).toBeUndefined()
  })
})
