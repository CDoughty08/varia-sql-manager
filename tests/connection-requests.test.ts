import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepare, secretRejected, settle, type ConnectionRequestDeps, type Settled } from '../src/main/connection-requests'
import { BackendError } from '../src/main/backend/errors'
import { ConnectionStore } from '../src/main/connection-store'
import { connectionLibrary } from '../src/main/connection-library'
import { SavedPasswordStore } from '../src/main/saved-passwords'
import { testCipher, type SecretCipher } from '../src/main/secret-cipher'
import { validateRequest } from '../src/main/validation'
import type { ConnectionInfo, ConnectionOptions } from '../src/shared/contracts'

const marker = 'correct-horse-marker'
const options: ConnectionOptions = { server: 'password-check', database: 'master', authentication: 'sql', username: 'reader', password: marker, trustServerCertificate: false, encrypt: 'mandatory' }
const empty: ConnectionOptions = { ...options, password: '' }
const info = (): ConnectionInfo => ({ id: randomUUID(), server: options.server, database: 'master', serverVersion: '17.0', generation: 1 })
const loginFailed = () => new BackendError('SQL_ERROR', "Login failed for user 'reader'.", { number: 18456, state: 1, class: 14, server: 'password-check' })
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup(cipher: SecretCipher = testCipher()) {
  const directory = await mkdtemp(join(tmpdir(), 'varia-connection-requests-'))
  directories.push(directory)
  const connections = new ConnectionStore(join(directory, 'connections.json'))
  const savedPasswords = new SavedPasswordStore(join(directory, 'saved-passwords.json'), cipher)
  const deps: ConnectionRequestDeps = { connections, savedPasswords }
  /** One request as main's varia:request handler runs it, with `answer` standing in for the backend. */
  const request = async (method: string, params: ConnectionOptions, context: unknown, answer: (sent: ConnectionOptions) => Settled) => {
    const prepared = await prepare(method, validateRequest(method, params), context, deps)
    return { prepared, settled: await settle(prepared, answer(prepared.params as ConnectionOptions), deps) }
  }
  /** Connects with `password` and Remember password checked, as the dialog does; returns the history entry's id. */
  const remembered = async (value: ConnectionOptions = options) => {
    await request('connections.connect', value, { remember: true }, () => ({ ok: true, value: info() }))
    const { library } = await connections.load()
    return library.profiles.find(profile => profile.options.database === value.database && profile.options.server === value.server && profile.options.username === value.username)!.id
  }
  return { directory, connections, savedPasswords, deps, request, remembered }
}

describe('remembered password requests', () => {
  it('fills in the remembered password for an empty Password and a matching entry; a typed one wins; other credentials get none', async () => {
    const { request, remembered } = await setup()
    const id = await remembered()
    let sent: ConnectionOptions | undefined
    const capture = (value: ConnectionOptions): Settled => { sent = value; return { ok: true, value: info() } }
    // Remember password stays checked; a connect without it would forget the password (below).
    const { prepared } = await request('connections.connect', empty, { profileId: id, remember: true }, capture)
    expect(prepared.injected).toBe(true)
    expect(sent?.password).toBe(marker)
    // The validated options never carry it, so what history stores or echoes cannot.
    expect((prepared.validated as ConnectionOptions).password).toBe('')
    const { password: _omitted, ...absent } = options
    await request('connections.databases', absent, { profileId: id }, capture)
    expect(sent?.password).toBe(marker)
    await request('connections.connect', { ...options, password: 'typed-instead' }, { profileId: id, remember: true }, capture)
    expect(sent?.password).toBe('typed-instead')
    for (const forged of [{ server: 'evil-server' }, { trustServerCertificate: true }, { encrypt: 'optional' as const }, { username: 'sa' }, { advanced: { failoverPartner: 'evil' } }]) {
      const result = await request('connections.connect', { ...empty, ...forged }, { profileId: id, remember: true }, capture)
      expect(result.prepared.injected).toBe(false)
      expect(sent?.password).toBe('')
    }
  })
  it('refuses a context on any other method, and one of another shape', async () => {
    const { deps } = await setup()
    const id = randomUUID()
    await expect(prepare('connections.preview', validateRequest('connections.preview', empty), { profileId: id }, deps)).rejects.toThrow('Invalid request.')
    await expect(prepare('query.cancel', { queryId: id }, { remember: false }, deps)).rejects.toThrow('Invalid request.')
    for (const context of [{ profileId: 'not-a-uuid' }, { profileId: id, password: marker }, null, 'x'] as unknown[]) {
      await expect(prepare('connections.connect', validateRequest('connections.connect', empty), context, deps), JSON.stringify(context)).rejects.toThrow('Invalid request.')
    }
    expect((await prepare('connections.preview', validateRequest('connections.preview', empty), undefined, deps)).injected).toBe(false)
  })
  it('remembers under the history entry it connected, forgets when unchecked, and reports a store failure as a warning', async () => {
    const { request, connections, savedPasswords, directory, deps } = await setup()
    const { settled } = await request('connections.connect', options, { remember: true }, () => ({ ok: true, value: info() }))
    expect(settled.ok && (settled.value as ConnectionInfo).historyWarning).toBeUndefined()
    const { library } = await connections.load()
    const id = library.profiles[0].id
    expect((await savedPasswords.load()).ids).toEqual([id])
    expect(await readFile(join(directory, 'connections.json'), 'utf8')).not.toContain(marker)
    // Through another entry with the same credentials (another database): both keep it. History is given the options as
    // the dialog sent them, never with the password main filled in.
    const seen: ConnectionOptions[] = []
    const rememberEntry = connections.rememberEntry.bind(connections)
    connections.rememberEntry = value => { seen.push(structuredClone(value)); return rememberEntry(value) }
    const other = await request('connections.connect', { ...empty, database: 'Sales' }, { profileId: id, remember: true }, () => ({ ok: true, value: info() }))
    expect(other.prepared.injected).toBe(true)
    expect(seen.map(value => value.password)).toEqual([''])
    expect(await readFile(join(directory, 'connections.json'), 'utf8')).not.toContain(marker)
    const salesId = (await connections.load()).library.profiles.find(profile => profile.options.database === 'Sales')!.id
    expect((await savedPasswords.load()).ids.sort()).toEqual([id, salesId].sort())
    // Unchecked: the entry it connected and the one it used both lose theirs.
    await request('connections.connect', { ...empty, database: 'Sales' }, { profileId: id, remember: false }, () => ({ ok: true, value: info() }))
    expect((await savedPasswords.load()).ids).toEqual([])
    // Remember with no password to remember (nothing matched, nothing typed) stores nothing; Windows authentication neither.
    await request('connections.connect', empty, { remember: true }, () => ({ ok: true, value: info() }))
    await request('connections.connect', { ...options, authentication: 'windows' }, { remember: true }, () => ({ ok: true, value: info() }))
    expect((await savedPasswords.load()).ids).toEqual([])
    const failing: ConnectionRequestDeps = { ...deps, savedPasswords: Object.assign(Object.create(savedPasswords), { set: async () => { throw new Error('disk full ' + marker) } }) }
    const prepared = await prepare('connections.connect', validateRequest('connections.connect', options), { remember: true }, failing)
    const warned = await settle(prepared, { ok: true, value: info() }, failing)
    expect(warned.ok && (warned.value as ConnectionInfo).historyWarning).toBe('Connected successfully, but the password could not be saved.')
    // History still failing keeps its own warning, and nothing is remembered without an entry.
    const noHistory: ConnectionRequestDeps = { ...deps, connections: Object.assign(Object.create(connections), { rememberEntry: async () => { throw new Error('locked') } }) }
    const lost = await settle(await prepare('connections.connect', validateRequest('connections.connect', options), { remember: true }, noHistory), { ok: true, value: info() }, noHistory)
    expect(lost.ok && (lost.value as ConnectionInfo).historyWarning).toBe('Connected successfully, but recent connections could not be saved.')
    expect((await savedPasswords.load()).ids).toEqual([])
  })
  it('forgets a remembered password SQL Server rejected, and keeps it after any other failure or a typed password', async () => {
    const { request, remembered, savedPasswords } = await setup()
    const id = await remembered()
    const salesId = await remembered({ ...options, database: 'Sales' })
    for (const error of [
      new BackendError('SQL_ERROR', 'A network-related error occurred.', { number: 53, state: 0, class: 20 }),
      new BackendError('TIMEOUT', 'The SQL backend did not answer within 45 seconds. The request was cancelled.'),
      new BackendError('SQL_ERROR', 'Cannot open database "Sales" requested by the login.', { number: 4060, state: 1, class: 11 }),
      new Error('The SQL backend stopped before answering. The request was not retried.')
    ]) {
      const { settled } = await request('connections.connect', empty, { profileId: id, remember: true }, () => ({ ok: false, error }))
      expect(settled.ok || settled.passwordForgotten).toBeFalsy()
    }
    const typed = await request('connections.connect', { ...options, password: 'wrong' }, { profileId: id, remember: true }, () => ({ ok: false, error: loginFailed() }))
    expect(typed.settled.ok || typed.settled.passwordForgotten).toBeFalsy()
    expect((await savedPasswords.load()).ids.sort()).toEqual([id, salesId].sort())
    const { settled } = await request('connections.databases', empty, { profileId: id }, () => ({ ok: false, error: loginFailed() }))
    expect(settled).toMatchObject({ ok: false, passwordForgotten: true })
    expect(!settled.ok && settled.error).toBeInstanceOf(BackendError)
    // Every entry with those credentials goes, so the next attempt cannot repeat the rejected password.
    expect((await savedPasswords.load()).ids).toEqual([])
  })
  it('limits the rejection rule to a refused password: 18456 for SQL Server Authentication, AADSTS50126 and 7000215 for Entra', () => {
    expect(secretRejected(options, loginFailed())).toBe(true)
    // Under other authentication 18456 means a missing grant or a stale token, not a wrong password.
    expect(secretRejected({ ...options, authentication: 'windows' }, loginFailed())).toBe(false)
    for (const authentication of ['entraPassword', 'entraServicePrincipal', 'entraMfa'] as const) expect(secretRejected({ ...options, authentication }, loginFailed()), authentication).toBe(false)
    const entra = (number: number) => new BackendError('AUTH_ENTRA', 'Microsoft Entra ID rejected it.', { number, state: 0, class: 11 })
    expect(secretRejected({ ...options, authentication: 'entraPassword' }, entra(50126))).toBe(true)
    expect(secretRejected({ ...options, authentication: 'entraServicePrincipal' }, entra(7000215))).toBe(true)
    // A sign-in that was cancelled, timed out or needs MFA says nothing about the password; neither do other types.
    expect(secretRejected({ ...options, authentication: 'entraPassword' }, entra(0))).toBe(false)
    expect(secretRejected({ ...options, authentication: 'entraMfa' }, entra(50126))).toBe(false)
    expect(secretRejected({ ...options, authentication: 'entraPassword' }, new BackendError('SQL_ERROR', 'x', { number: 50126 }))).toBe(false)
    expect(secretRejected(options, new BackendError('AUTH_KERBEROS', 'Login failed.', { number: 18456 }))).toBe(false)
    expect(secretRejected(options, Object.assign(new Error('Login failed.'), { code: 'SQL_ERROR', details: { number: 18456 } }))).toBe(false)
  })
  it('forgets a remembered Entra client secret that Microsoft Entra ID rejected', async () => {
    const { request, remembered, savedPasswords } = await setup()
    const principal: ConnectionOptions = { ...options, authentication: 'entraServicePrincipal', username: '11111111-2222-3333-4444-555555555555' }
    const id = await remembered(principal)
    expect((await savedPasswords.load()).ids).toEqual([id])
    const kept = await request('connections.connect', { ...principal, password: '' }, { profileId: id }, () => ({ ok: false, error: loginFailed() }))
    expect(kept.prepared.injected && !kept.settled.ok && !kept.settled.passwordForgotten).toBe(true)
    const { settled } = await request('connections.connect', { ...principal, password: '' }, { profileId: id }, () => ({ ok: false, error: new BackendError('AUTH_ENTRA', 'The client secret is not valid (AADSTS7000215).', { number: 7000215, state: 0, class: 11 }) }))
    expect(settled).toMatchObject({ ok: false, passwordForgotten: true })
    expect((await savedPasswords.load()).ids).toEqual([])
  })
  it('lets Load databases use a remembered password without entering history or forgetting it', async () => {
    const { request, remembered, savedPasswords, directory } = await setup()
    const id = await remembered()
    const before = await readFile(join(directory, 'connections.json'), 'utf8')
    const { prepared, settled } = await request('connections.databases', empty, { profileId: id }, () => ({ ok: true, value: [{ name: 'master' }] }))
    expect(prepared.injected).toBe(true)
    expect(settled).toEqual({ ok: true, value: [{ name: 'master' }] })
    expect(await readFile(join(directory, 'connections.json'), 'utf8')).toBe(before)
    expect(await savedPasswords.get(id, empty)).toBe(marker)
  })
  it('refuses a remembered password outside the Password bounds before anything is sent', async () => {
    const { deps } = await setup()
    for (const stored of ['x'.repeat(1025), '']) {
      const savedPasswords = { ...deps.savedPasswords, get: async () => stored }
      await expect(prepare('connections.connect', validateRequest('connections.connect', empty), { profileId: randomUUID() }, { savedPasswords }), String(stored.length)).rejects.toThrow('The saved password could not be read. Enter the password.')
    }
    const savedPasswords = { ...deps.savedPasswords, get: async () => 'x'.repeat(1024) }
    expect((await prepare('connections.connect', validateRequest('connections.connect', empty), { profileId: randomUUID() }, { savedPasswords })).injected).toBe(true)
  })
  it('treats the server and login as the unit: unchecking or a new password leaves no other entry with an old one', async () => {
    const { request, remembered, savedPasswords } = await setup()
    const master = await remembered({ ...options, password: 'old-pass' })
    const sales = await remembered({ ...options, database: 'Sales', password: 'old-pass' })
    // The login's password changed: the user picks the master entry, types the new one for Sales, and keeps the box checked.
    await request('connections.connect', { ...options, database: 'Sales', password: 'new-pass' }, { profileId: master, remember: true }, () => ({ ok: true, value: info() }))
    for (const id of [master, sales]) expect(await savedPasswords.get(id, empty)).toBe('new-pass')
    // Choosing the master entry later sends the new password, not one SQL Server would reject into a lockout.
    let sent: ConnectionOptions | undefined
    await request('connections.connect', empty, { profileId: master, remember: true }, value => { sent = value; return { ok: true, value: info() } })
    expect(sent?.password).toBe('new-pass')
    // Unchecked through the master entry: Sales, which the dialog would offer for the same credentials, loses it too.
    const other = await remembered({ ...options, username: 'other-login' })
    await request('connections.connect', empty, { profileId: master, remember: false }, () => ({ ok: true, value: info() }))
    expect((await savedPasswords.load()).ids).toEqual([other])
  })
  it('warns only about a password it was asked and able to remember, and drops the password of an entry history pruned', async () => {
    const { request, remembered, savedPasswords } = await setup()
    const { settled } = await request('connections.connect', { ...options, authentication: 'windows' }, { remember: true }, () => ({ ok: true, value: info() }))
    expect(settled.ok && (settled.value as ConnectionInfo).historyWarning).toBeUndefined()
    const first = await remembered({ ...options, database: 'db0' })
    // 30 newer connections push the first out of Recent Connections.
    for (let index = 1; index <= 30; index++) await remembered({ ...options, database: 'db' + index })
    const ids = (await savedPasswords.load()).ids
    expect(ids).toHaveLength(30)
    expect(ids).not.toContain(first)
  })
  it('keeps a password it cannot decrypt, failing the request as a value', async () => {
    let deny = false
    const real = testCipher()
    const { request, remembered, savedPasswords } = await setup({ ...real, decrypt: async data => { if (deny) throw new Error('Keychain prompt denied'); return real.decrypt(data) } })
    const id = await remembered()
    deny = true
    await expect(request('connections.connect', empty, { profileId: id }, () => ({ ok: true, value: info() }))).rejects.toThrow('The saved password could not be read. Enter the password.')
    expect((await savedPasswords.load()).ids).toEqual([id])
  })
})

describe('connection library with remembered passwords', () => {
  it('drops the password of an entry Save changes moves to another server or login, and of a removed entry', async () => {
    const { remembered, connections, savedPasswords } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    const id = await remembered()
    const kept = await remembered({ ...options, database: 'Sales' })
    const loaded = await library.load()
    expect(loaded.savedPasswords.sort()).toEqual([id, kept].sort())
    expect(loaded.passwordStorage).toEqual({ available: true })
    // Save changes that keep the credentials keep it.
    const renamed = await library.save({ id, options: { ...options, displayName: 'Renamed' } })
    expect(renamed.savedPasswords.sort()).toEqual([id, kept].sort())
    const moved = await library.save({ id, options: { ...options, server: 'elsewhere' } })
    expect(moved.savedPasswords).toEqual([kept])
    expect(moved.library.profiles.some(profile => profile.id === id)).toBe(true)
    expect(await savedPasswords.get(id, { ...empty, server: 'elsewhere' })).toBeUndefined()
    const removed = await library.remove(kept)
    expect(removed).toEqual({ library: (await connections.load()).library, savedPasswords: [] })
    await expect(library.remove('not-an-id')).rejects.toThrow()
    await expect(library.save({ options: { ...options, password: 'x'.repeat(1025) } })).rejects.toThrow()
  })
})
