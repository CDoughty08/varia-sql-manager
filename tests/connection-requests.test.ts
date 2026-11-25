import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectContext, prepare, secretRejected, settle, settleReused, type ConnectionRequestDeps, type Settled } from '../src/main/connection-requests'
import { BackendError } from '../src/main/backend/errors'
import { ConnectionStore } from '../src/main/connection-store'
import { ConnectionAuthenticationGuard } from '../src/main/connection-authentication'
import { connectionLibrary } from '../src/main/connection-library'
import { SavedPasswordStore } from '../src/main/saved-passwords'
import { testCipher, type SecretCipher } from '../src/main/secret-cipher'
import { validateRequest } from '../src/main/validation'
import type { ConnectionInfo, ConnectionOptions } from '../src/shared/contracts'
import { connectionTargetOptions, type ConnectionCredentialReference } from '../src/shared/connection-targets'

const marker = 'correct-horse-marker'
const stablePrincipal = 'sid:01020304'
const options: ConnectionOptions = { server: 'password-check', database: 'master', authentication: 'sql', username: 'reader', password: marker, trustServerCertificate: false, encrypt: 'mandatory' }
const empty: ConnectionOptions = { ...options, password: '' }
const info = (): ConnectionInfo => ({ id: randomUUID(), server: options.server, database: 'master', serverVersion: '17.0', generation: 1, principalId: stablePrincipal })
const loginFailed = () => new BackendError('SQL_ERROR', "Login failed for user 'reader'.", { number: 18456, state: 8, class: 14, server: 'password-check' })
const directories: string[] = []
function backgroundTarget(deps: ConnectionRequestDeps, credential: ConnectionCredentialReference) {
  const targetId = randomUUID(), expectedPrincipal = { provider: 'sqlserver', authentication: 'sql', id: stablePrincipal } as const
  deps.authentication.restore({ version: 1, targets: [{ id: targetId, options: connectionTargetOptions(empty), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal, credential }] })
  return { mode: 'background', targetId, expectedPrincipal, credential, credentialPolicy: 'preserve' } as const
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup(cipher: SecretCipher = testCipher()) {
  const directory = await mkdtemp(join(tmpdir(), 'varia-connection-requests-'))
  directories.push(directory)
  const connections = new ConnectionStore(join(directory, 'connections.json'))
  const savedPasswords = new SavedPasswordStore(join(directory, 'saved-passwords.json'), cipher)
  const deps: ConnectionRequestDeps = { connections, savedPasswords, authentication: new ConnectionAuthenticationGuard() }
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
  it('bounds attempts before they await keyring or target gates and releases capacity exactly once', async () => {
    const { deps } = await setup()
    const held = await Promise.all(Array.from({ length: 8 }, (_, index) => prepare('connections.connect', { ...options, server: `server-${index}` }, undefined, deps)))
    await expect(prepare('connections.connect', options, undefined, deps)).rejects.toThrow('Too many pending connection attempts')
    held[0].release?.()
    held[0].release?.()
    const admitted = await prepare('connections.connect', options, undefined, deps)
    admitted.release?.()
    held.forEach(value => value.release?.())
  })
  it('cancels a queued credential waiter without letting a later request leapfrog its predecessor', async () => {
    const { deps } = await setup()
    const predecessor = await prepare('connections.connect', options, { targetId: randomUUID() }, deps)
    const controller = new AbortController()
    const cancelled = prepare('connections.connect', options, { targetId: randomUUID() }, deps, controller.signal)
    // An independent binding can finish while the same-binding waiter remains queued.
    const independent = await prepare('connections.connect', { ...options, server: 'independent' }, { targetId: randomUUID() }, deps)
    independent.release?.()
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    let admitted = false
    const later = prepare('connections.connect', options, { targetId: randomUUID() }, deps).then(value => { admitted = true; return value })
    const probe = await prepare('connections.connect', { ...options, server: 'probe' }, { targetId: randomUUID() }, deps)
    probe.release?.()
    expect(admitted).toBe(false)
    predecessor.release?.()
    const prepared = await later
    expect(admitted).toBe(true)
    prepared.release?.()
  })
  it('background reconnect requires the exact revision, preserves credentials and pins the actual account', async () => {
    const { request, remembered, savedPasswords, deps, directory } = await setup()
    const id = await remembered()
    const credential = await savedPasswords.reference(id, empty)
    const principal = { provider: 'sqlserver', authentication: 'sql', id: stablePrincipal } as const
    const context = backgroundTarget(deps, credential!)
    const before = await readFile(join(directory, 'saved-passwords.json'), 'utf8')
    const connected = await request('connections.connect', empty, context, sent => {
      expect(sent).toMatchObject({ password: marker, nonInteractive: true })
      return { ok: true, value: { ...info(), login: 'reader' } }
    })
    expect(connected.settled).toMatchObject({ ok: true, value: { authentication: { principal, credential } } })
    expect(await readFile(join(directory, 'saved-passwords.json'), 'utf8')).toBe(before)
    let disposed = ''
    const prepared = await prepare('connections.connect', empty, context, deps)
    const changed = info()
    const rejected = await settle(prepared, { ok: true, value: { ...changed, login: 'reader', principalId: 'sid:05060708' } }, { ...deps, disconnect: async value => { disposed = value } })
    expect(rejected.ok).toBe(false)
    expect(disposed).toBe(changed.id)
    expect(await savedPasswords.get(id, empty)).toBe(marker)
    await savedPasswords.set(id, { ...options, password: 'replacement' })
    await expect(prepare('connections.connect', empty, context, deps)).rejects.toThrow('revision is unavailable')
    await expect(prepare('connections.connect', empty, { ...context, remember: false }, deps)).rejects.toThrow('Invalid request')
  })
  it('gates background requests sharing a saved binding and blocks the next one after actual rejection', async () => {
    const { remembered, savedPasswords, deps } = await setup()
    const id = await remembered()
    const credential = await savedPasswords.reference(id, empty)
    const context = backgroundTarget(deps, credential!)
    const first = await prepare('connections.connect', empty, context, deps)
    let secondEntered = false
    const next = prepare('connections.connect', empty, context, deps).then(() => { secondEntered = true })
    await Promise.resolve()
    expect(secondEntered).toBe(false)
    expect(await settle(first, { ok: false, error: loginFailed() }, deps)).toMatchObject({ ok: false, credentialRejected: true })
    await expect(next).rejects.toThrow('was rejected')
    expect(secondEntered).toBe(false)
  })
  it('preserve-credential mode never treats an absent Remember choice as forgetting', async () => {
    const { request, remembered, savedPasswords } = await setup()
    const id = await remembered()
    await request('connections.connect', empty, { profileId: id, credentialPolicy: 'preserve' }, () => ({ ok: true, value: { ...info(), login: 'reader' } }))
    expect(await savedPasswords.get(id, empty)).toBe(marker)
  })
  it('an ordinary Remember reconnect keeps the credential revision and an explicit update pins the same account', async () => {
    const { request, remembered, savedPasswords } = await setup()
    const id = await remembered()
    const credential = await savedPasswords.reference(id, empty)
    await request('connections.connect', empty, { profileId: id, remember: true }, () => ({ ok: true, value: { ...info(), login: 'reader' } }))
    expect(await savedPasswords.reference(id, empty)).toEqual(credential)
    const expectedPrincipal = { provider: 'sqlserver', authentication: 'sql', id: stablePrincipal }
    const replaced = await request('connections.connect', { ...options, password: 'replacement' }, { credential, expectedPrincipal, credentialIntent: 'update-credentials', credentialPolicy: 'remember' }, () => ({ ok: true, value: { ...info(), login: 'reader' } }))
    expect(replaced.settled).toMatchObject({ ok: true, value: { authentication: { principal: expectedPrincipal, credential: { profileId: id } } } })
    const revision = replaced.settled.ok && (replaced.settled.value as ConnectionInfo).authentication?.credential?.revision
    expect(revision).not.toBe(credential!.revision)
  })
  it('keeps inaccessible ciphertext but never claims it represents a newly typed password', async () => {
    const cipher = testCipher()
    let available = true
    const { request, savedPasswords, deps, directory } = await setup({ ...cipher, state: async () => ({ available }) })
    const initial = await request('connections.connect', options, { credentialPolicy: 'remember' }, () => ({ ok: true, value: info() }))
    if (!initial.settled.ok) throw initial.settled.error
    const connected = initial.settled.value as ConnectionInfo, credential = connected.authentication!.credential!
    const before = await readFile(join(directory, 'saved-passwords.json'), 'utf8')
    available = false
    const updated = await request('connections.connect', { ...options, password: 'replacement' }, { targetId: connected.targetId, credential, expectedPrincipal: connected.authentication!.principal, credentialIntent: 'update-credentials', credentialPolicy: 'preserve' }, () => ({ ok: true, value: info() }))
    expect(updated.settled).toMatchObject({ ok: true, value: { authentication: { credential: null } } })
    expect(deps.authentication.resolve(connected.targetId!)?.credential).toBeUndefined()
    expect(await readFile(join(directory, 'saved-passwords.json'), 'utf8')).toBe(before)
    available = true
    expect(await savedPasswords.getReferenced(credential, empty)).toBe(marker)
  })
  it('finishes the first remembered credential binding under the same owned authentication operation', async () => {
    const { request, deps } = await setup()
    const first = await request('connections.connect', options, { remember: true }, () => ({ ok: true, value: { ...info(), login: 'reader' } }))
    expect(first.settled.ok).toBe(true)
    const connected = first.settled.ok && first.settled.value as ConnectionInfo
    expect(connected && connected.authentication?.credential?.revision).toBeTruthy()
    expect(connected && deps.authentication.resolve(connected.targetId!)?.credential).toEqual(connected && connected.authentication?.credential)
  })
  it('serializes a first binding and a concurrent credential update for the same target', async () => {
    const { deps } = await setup()
    const targetId = randomUUID()
    const first = await prepare('connections.connect', options, { targetId, remember: true }, deps)
    let updatePrepared = false
    const updating = prepare('connections.connect', { ...options, password: 'replacement' }, { targetId, credentialIntent: 'update-credentials', credentialPolicy: 'remember' }, deps).then(value => { updatePrepared = true; return value })
    await Promise.resolve()
    expect(updatePrepared).toBe(false)
    const initial = await settle(first, { ok: true, value: { ...info(), login: 'reader' } }, deps)
    expect(initial.ok).toBe(true)
    const update = await updating
    const replaced = await settle(update, { ok: true, value: { ...info(), login: 'reader' } }, deps)
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) throw replaced.error
    const current = (replaced.value as ConnectionInfo).authentication?.credential
    expect(deps.authentication.resolve(targetId)?.credential).toEqual(current)
    expect(await deps.savedPasswords.getReferenced(current!, empty)).toBe('replacement')
  })
  it('prevents two first-time different destinations from authenticating under the same target id', async () => {
    const { deps } = await setup()
    const targetId = randomUUID()
    const first = await prepare('connections.connect', options, { targetId, remember: true }, deps)
    const next = prepare('connections.connect', { ...options, server: 'different-server', username: 'another' }, { targetId, remember: true }, deps)
    expect(await settle(first, { ok: true, value: { ...info(), login: 'reader' } }, deps)).toMatchObject({ ok: true })
    await expect(next).rejects.toThrow('identity changed')
  })
  it('keeps an ambiguous SQL login failure ciphertext and stops another background replay', async () => {
    const { remembered, deps, savedPasswords, directory } = await setup()
    const id = await remembered(), credential = (await savedPasswords.reference(id, empty))!
    const context = backgroundTarget(deps, credential)
    const before = await readFile(join(directory, 'saved-passwords.json'), 'utf8')
    const prepared = await prepare('connections.connect', empty, context, deps)
    const outcome = await settle(prepared, { ok: false, error: new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 1 }) }, deps)
    expect(outcome).toMatchObject({ ok: false, credentialRejected: true })
    expect(outcome.ok || outcome.passwordForgotten).toBeFalsy()
    expect(await readFile(join(directory, 'saved-passwords.json'), 'utf8')).toBe(before)
    await expect(prepare('connections.connect', empty, context, deps)).rejects.toThrow('was rejected')
  })
  it('readmits an unchanged rejected revision only after fresh same-account authentication and exact saved-secret proof', async () => {
    const { remembered, deps, savedPasswords } = await setup()
    const id = await remembered(), credential = (await savedPasswords.reference(id, empty))!
    const context = backgroundTarget(deps, credential)
    const reject = async () => {
      const prepared = await prepare('connections.connect', empty, context, deps)
      expect(await settle(prepared, { ok: false, error: new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 1 }) }, deps)).toMatchObject({ ok: false, credentialRejected: true })
    }
    await reject()
    const retryContext = { ...context, mode: 'interactive', credentialIntent: 'update-credentials', credentialPolicy: 'remember' }
    const typed = await prepare('connections.connect', options, retryContext, deps)
    expect(typed.requireFreshAuthentication).toBe(true)
    expect(await settle(typed, { ok: true, value: info() }, deps)).toMatchObject({ ok: true })
    expect(await savedPasswords.reference(id, empty)).toEqual(credential)
    const resumed = await prepare('connections.connect', empty, context, deps)
    expect((resumed.params as ConnectionOptions).password).toBe(marker)
    resumed.release?.()
    await reject()
    const changedAccount = await prepare('connections.connect', options, retryContext, deps)
    expect(await settle(changedAccount, { ok: true, value: { ...info(), principalId: 'sid:05060708' } }, deps)).toMatchObject({ ok: false })
    await expect(prepare('connections.connect', empty, context, deps)).rejects.toThrow('was rejected')
  })
  it('keeps a rejection and reports unavailable sealed-secret proof even after a successful typed Remember write', async () => {
    const { remembered, deps, savedPasswords } = await setup()
    const id = await remembered(), credential = (await savedPasswords.reference(id, empty))!
    const context = backgroundTarget(deps, credential)
    const saved = await prepare('connections.connect', empty, context, deps)
    await settle(saved, { ok: false, error: new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 1 }) }, deps)
    const typed = await prepare('connections.connect', options, { ...context, mode: 'interactive', credentialIntent: 'update-credentials', credentialPolicy: 'remember' }, deps)
    vi.spyOn(savedPasswords, 'getReferenced').mockRejectedValueOnce(new Error('Keyring locked.'))
    expect(await settle(typed, { ok: true, value: info() }, deps)).toMatchObject({ ok: true, value: { historyWarning: expect.stringContaining('saved credential could not be verified') } })
    expect(await savedPasswords.reference(id, empty)).toEqual(credential)
    await expect(prepare('connections.connect', empty, context, deps)).rejects.toThrow('was rejected')
  })
  it("saves the cost-prompt choice Advanced Properties named when Connect reuses a live BigQuery connection", async () => {
    const setBigQueryCostPrompt = vi.fn(async () => true)
    const principal = { provider: 'bigquery', project: 'varia-alpha', principal: 'bigquery:user:ada@example.com' } as const
    const deps = {
      connections: { setBigQueryCostPrompt },
      authentication: { resolve: () => ({ expectedPrincipal: principal }), prepare: () => {} },
      savedPasswords: {}
    } as unknown as ConnectionRequestDeps
    const bigQuery = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', costPrompt: true } as const
    const prepared = (context: object, params: object = bigQuery) => ({ method: 'connections.connect', validated: params, params, context, injected: false })
    const connected = { ...info(), targetId: randomUUID(), authentication: { principal } } as ConnectionInfo
    expect(await settleReused(prepared({ mode: 'interactive' }), connected, deps)).toMatchObject({ ok: true })
    expect(setBigQueryCostPrompt).toHaveBeenCalledWith(bigQuery, true)
    // A background reconnect, or a dialog that named no choice, leaves the saved one alone.
    setBigQueryCostPrompt.mockClear()
    await settleReused(prepared({ mode: 'background' }), connected, deps)
    const { costPrompt: _costPrompt, ...unnamed } = bigQuery
    await settleReused(prepared({ mode: 'interactive' }, unnamed), connected, deps)
    expect(setBigQueryCostPrompt).not.toHaveBeenCalled()
    // A failed write still connects, with a warning.
    setBigQueryCostPrompt.mockResolvedValueOnce(false)
    expect(await settleReused(prepared({ mode: 'interactive' }), connected, deps)).toMatchObject({ ok: true, value: { historyWarning: expect.stringContaining('cost prompt') } })
  })
  it("saves the threshold Advanced Properties named when Connect reuses a live BigQuery connection", async () => {
    const setBigQueryCostThreshold = vi.fn(async () => true)
    const principal = { provider: 'bigquery', project: 'varia-alpha', principal: 'bigquery:user:ada@example.com' } as const
    const deps = {
      connections: { setBigQueryCostThreshold },
      authentication: { resolve: () => ({ expectedPrincipal: principal }), prepare: () => {} },
      savedPasswords: {}
    } as unknown as ConnectionRequestDeps
    const bigQuery = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', costThreshold: 50 } as const
    const prepared = (context: object, params: object = bigQuery) => ({ method: 'connections.connect', validated: params, params, context, injected: false })
    const connected = { ...info(), targetId: randomUUID(), authentication: { principal } } as ConnectionInfo
    expect(await settleReused(prepared({ mode: 'interactive' }), connected, deps)).toMatchObject({ ok: true })
    expect(setBigQueryCostThreshold).toHaveBeenCalledWith(bigQuery, 50)
    // 0 goes back to Options' threshold.
    await settleReused(prepared({ mode: 'interactive' }, { ...bigQuery, costThreshold: 0 }), connected, deps)
    expect(setBigQueryCostThreshold).toHaveBeenLastCalledWith({ ...bigQuery, costThreshold: 0 }, 0)
    // A background reconnect, or a dialog that named none, leaves the saved one alone.
    setBigQueryCostThreshold.mockClear()
    await settleReused(prepared({ mode: 'background' }), connected, deps)
    const { costThreshold: _costThreshold, ...unnamed } = bigQuery
    await settleReused(prepared({ mode: 'interactive' }, unnamed), connected, deps)
    expect(setBigQueryCostThreshold).not.toHaveBeenCalled()
    // A failed write still connects, with a warning.
    setBigQueryCostThreshold.mockResolvedValueOnce(false)
    expect(await settleReused(prepared({ mode: 'interactive' }), connected, deps)).toMatchObject({ ok: true, value: { historyWarning: expect.stringContaining('cost threshold') } })
  })
  it('does not readmit a rejected revision from ordinary live-session equality without fresh password proof', async () => {
    const { remembered, deps, savedPasswords } = await setup()
    const id = await remembered(), credential = (await savedPasswords.reference(id, empty))!
    const context = backgroundTarget(deps, credential)
    const saved = await prepare('connections.connect', empty, context, deps)
    await settle(saved, { ok: false, error: new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 1 }) }, deps)
    const typed = await prepare('connections.connect', options, { ...context, mode: 'interactive', credentialIntent: 'update-credentials', credentialPolicy: 'remember' }, deps)
    expect(typed.requireFreshAuthentication).toBe(true)
    expect(await settleReused(typed, { ...info(), targetId: context.targetId, authentication: { principal: context.expectedPrincipal, credential } }, deps)).toMatchObject({ ok: true })
    await expect(prepare('connections.connect', empty, context, deps)).rejects.toThrow('was rejected')
  })
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
    expect(connectContext('connections.connect', { targetId: id })).toEqual({ targetId: id })
    expect(() => connectContext('connections.connect', { targetId: 'forged' })).toThrow('Invalid request.')
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
    for (const state of [undefined, 1, 11, 12, 38]) expect(secretRejected(options, new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state }))).toBe(false)
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
      const savedPasswords = Object.assign(Object.create(deps.savedPasswords), { get: async () => stored })
      await expect(prepare('connections.connect', validateRequest('connections.connect', empty), { profileId: randomUUID() }, { savedPasswords, authentication: deps.authentication }), String(stored.length)).rejects.toThrow('The saved password could not be read. Enter the password.')
    }
    const savedPasswords = Object.assign(Object.create(deps.savedPasswords), { get: async () => 'x'.repeat(1024) })
    expect((await prepare('connections.connect', validateRequest('connections.connect', empty), { profileId: randomUUID() }, { savedPasswords, authentication: deps.authentication })).injected).toBe(true)
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

describe('Save with a checked password', () => {
  it('keeps a saved entry that never connected, until it is removed', async () => {
    const { connections, savedPasswords } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    const plain = await library.save({ options: { ...empty, server: 'not-saved' } })
    expect(plain.library.profiles).toEqual([])
    const saved = await library.save({ options: { ...empty, server: 'saved-only' }, saved: true })
    expect(saved.library.profiles).toMatchObject([{ saved: true, options: { server: 'saved-only' } }])
    expect(saved.library.profiles[0].lastConnected).toBeUndefined()
    expect((await library.remove(saved.library.profiles[0].id)).library.profiles).toEqual([])
  })
  it('stops marking an entry saved once it connects, and never marks a recent one', async () => {
    const { connections, savedPasswords, request } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    const server = { ...options, server: 'saved-then-connected' }
    expect((await library.save({ options: server, saved: true })).library.profiles[0].saved).toBe(true)
    await request('connections.connect', server, {}, () => ({ ok: true, value: info() }))
    let profile = (await connections.load()).library.profiles.find(item => item.options.server === server.server)!
    expect(profile).toMatchObject({ lastConnected: expect.any(String) })
    expect(profile.saved).toBeUndefined()
    // Saving the recent entry again does not pin it: it ages out of the 30 recent ones like any other.
    await library.save({ id: profile.id, options: server, saved: true })
    profile = (await connections.load()).library.profiles.find(item => item.id === profile.id)!
    expect(profile.saved).toBeUndefined()
  })
  it('remembers only the password a check just signed in with, once', async () => {
    const { directory, connections, savedPasswords, request } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    // Unchecked: nothing is saved, so settings and password cannot disagree.
    await expect(library.save({ options, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    expect((await connections.load()).library.profiles).toEqual([])
    // A failed check verifies nothing.
    await request('connections.databases', options, { remember: true }, () => ({ ok: false, error: loginFailed() }))
    await expect(library.save({ options, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    // A check without `remember` (Test Connection) verifies nothing either.
    await request('connections.databases', options, undefined, () => ({ ok: true, value: [{ name: 'master' }] }))
    await expect(library.save({ options, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    await request('connections.databases', options, { remember: true }, () => ({ ok: true, value: [{ name: 'master' }] }))
    // Another password than the one checked is refused, and the check is used up.
    await expect(library.save({ options: { ...options, password: 'other' }, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    await request('connections.databases', options, { remember: true }, () => ({ ok: true, value: [{ name: 'master' }] }))
    const saved = await library.save({ options, saved: true, rememberPassword: true })
    const id = saved.library.profiles[0].id
    expect(saved).toMatchObject({ passwordSaved: true, passwordReplaced: true, savedPasswords: [id] })
    expect(await savedPasswords.get(id, empty)).toBe(marker)
    expect(await readFile(join(directory, 'connections.json'), 'utf8')).not.toContain(marker)
    await expect(library.save({ options, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    // Saving the same password again keeps its revision, so Object Explorer targets holding it are not told to re-enter it.
    const before = await savedPasswords.reference(id, options)
    await request('connections.databases', options, { remember: true }, () => ({ ok: true, value: [{ name: 'master' }] }))
    expect(await library.save({ id, options, saved: true, rememberPassword: true })).toMatchObject({ passwordSaved: true, passwordReplaced: false })
    expect(await savedPasswords.reference(id, options)).toEqual(before)
  })
  it('refuses a check for other login settings, an expired check, and reports a password it could not store', async () => {
    const { connections, savedPasswords, request } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    const ok = () => ({ ok: true as const, value: [{ name: 'master' }] })
    // The same password checked for another server or login is not proof for these.
    await request('connections.databases', { ...options, server: 'elsewhere' }, { remember: true }, ok)
    await request('connections.databases', { ...options, username: 'someone-else' }, { remember: true }, ok)
    await expect(library.save({ options, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    // A check older than a minute has expired.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await request('connections.databases', options, { remember: true }, ok)
      vi.setSystemTime(Date.now() + 61_000)
      await expect(library.save({ options, saved: true, rememberPassword: true })).rejects.toThrow('not checked')
    } finally { vi.useRealTimers() }
    // Storage that fails keeps the saved settings and says the password was not remembered.
    await request('connections.databases', options, { remember: true }, ok)
    vi.spyOn(savedPasswords, 'set').mockRejectedValueOnce(new Error('no keyring'))
    const kept = await library.save({ options, saved: true, rememberPassword: true })
    expect(kept).toMatchObject({ passwordSaved: false, savedPasswords: [] })
    expect(kept.library.profiles).toMatchObject([{ saved: true, options: { server: options.server } }])
  })
  it('forgets the remembered password when Save is asked to', async () => {
    const { connections, savedPasswords, remembered } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    const id = await remembered()
    expect(await savedPasswords.get(id, empty)).toBe(marker)
    const saved = await library.save({ id, options: empty, saved: true, forgetPassword: true })
    expect(saved).toMatchObject({ passwordForgotten: true, savedPasswords: [] })
    expect(await savedPasswords.get(id, empty)).toBeUndefined()
    await expect(library.save({ options, rememberPassword: true, forgetPassword: true })).rejects.toThrow()
  })
  it('reports a Forget that unavailable secret storage could not do, keeping the password', async () => {
    const { connections, savedPasswords, remembered } = await setup()
    const library = connectionLibrary({ connections, savedPasswords })
    const id = await remembered()
    vi.spyOn(savedPasswords, 'storageAvailable').mockResolvedValueOnce(false)
    const saved = await library.save({ id, options: empty, saved: true, forgetPassword: true })
    expect(saved).toMatchObject({ passwordForgotten: false })
    expect(await savedPasswords.get(id, empty)).toBe(marker)
  })
})
