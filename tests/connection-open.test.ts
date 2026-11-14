import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectionOpenService, validateOpenedConnection } from '../src/main/connection-open'
import { ConnectionSessionCheckpoint } from '../src/main/connection-session-checkpoint'
import { hasPendingCredentialRequests } from '../src/main/connection-requests'
import type { SessionInput } from '../src/main/session-store'
import { ConnectionAuthenticationGuard } from '../src/main/connection-authentication'
import { ConnectionStore } from '../src/main/connection-store'
import { SavedPasswordStore } from '../src/main/saved-passwords'
import { BackendError } from '../src/main/backend/errors'
import { testCipher } from '../src/main/secret-cipher'
import { connectionTargetOptions, type BackendConnectionHandle } from '../src/shared/connection-targets'
import type { ConnectionInfo, ConnectionOptions } from '../src/shared/contracts'
import type { ConnectionBindingsChanged } from '../src/shared/connection-bindings'
import type { ActionExecuteRequest, ActionExecuteResult } from '../src/shared/actions/schema'

const options: ConnectionOptions = { server: 'server', database: 'Sales', authentication: 'sql', username: 'reader', password: 'test-secret', trustServerCertificate: false }
const principalId = 'sid:01020304'
const principal = { provider: 'sqlServer', authentication: 'sql', id: principalId } as const
const directories: string[] = []
const services: ConnectionOpenService[] = []
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const info = (generation = 1): ConnectionInfo => ({ id: randomUUID(), generation, server: 'server', database: 'Sales', serverVersion: '17', login: 'reader', principalId })
const passwordMutation = (connectionId: string, password = 'new-secret'): ActionExecuteRequest => ({ action: 'loginProperties', connectionId, requestId: randomUUID(), target: { kind: 'login', name: 'reader' }, loginChanges: { password: { oldPassword: false, unlock: false, mustChange: false } }, secrets: { password } })
const mutationResult = (connectionId: string, bindingRevision: number, delta: { newDatabase?: string; passwordChanged?: true }): ActionExecuteResult => ({ steps: [], messages: [], elapsedMs: 1, bindingChanges: [{ connectionId, bindingRevision, ...delta }], bindingChangesComplete: true })
afterEach(async () => {
  services.splice(0).forEach(service => service.reset())
  for (const directory of directories.splice(0)) {
    expect(relative(tmpdir(), directory)).not.toMatch(/^\.\./)
    await rm(directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varia-main-open-'))
  directories.push(directory)
  const authentication = new ConnectionAuthenticationGuard(), savedPasswords = new SavedPasswordStore(join(directory, 'saved.json'), testCipher()), connections = new ConnectionStore(join(directory, 'connections.json'))
  const open = vi.fn(async (_params: unknown, generation: number, _signal: AbortSignal) => info(generation))
  const close = vi.fn(async (_handle: BackendConnectionHandle) => ({ disconnected: true }))
  const bindingEvents: ConnectionBindingsChanged[] = []
  let generation: number | undefined = 1
  const service = new ConnectionOpenService({ authentication, savedPasswords, connections, open, close, generation: () => generation, bindingsChanged: event => { bindingEvents.push(event) } })
  services.push(service)
  const request = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), targetId: randomUUID(), credentialPolicy: 'preserve', ...extra })
  return { service, open, close, authentication, savedPasswords, connections, directory, request, bindingEvents, generation: (value: number | undefined) => { generation = value } }
}

describe('main connection ownership', () => {
  it('rejects a Connect baseline changed after backend registration but before its reply', async () => {
    const { service, open, close, request, authentication } = await fixture(), registered = deferred<void>(), reply = deferred<void>()
    const handle = info()
    let bindingRevision = 0
    open.mockImplementationOnce(async () => { registered.resolve(); await reply.promise; return { ...handle, bindingRevision } })
    const context = request(), pending = service.connect(options, context)
    await registered.promise
    bindingRevision = 1
    reply.resolve()
    expect(await pending).toMatchObject({ ok: false, connectionFailure: 'identity-changed' })
    expect(close).toHaveBeenCalledExactlyOnceWith({ ...handle, bindingRevision: 1 })
    expect(authentication.resolve(context.targetId)).toBeUndefined()
  })

  it('fences binding mutators until a delivered Connect receipt has been acknowledged', async () => {
    const { service, request, open } = await fixture()
    const context = request(), connected = await service.connect(options, context)
    if (!connected.ok) throw connected.error
    const connection = connected.value as ConnectionInfo
    expect(() => service.beginBindingMutation(passwordMutation(connection.id))).toThrow('current connection operation')
    await service.accept(context.requestId)
    const ticket = service.beginBindingMutation(passwordMutation(connection.id))!
    expect(() => service.beginBindingMutation(passwordMutation(connection.id))).toThrow('current connection operation')
    expect(await service.connect(options, request())).toMatchObject({ ok: false })
    expect(open).toHaveBeenCalledTimes(1)
    await service.finishBindingMutation(ticket, { steps: [], messages: [], elapsedMs: 1, bindingChanges: [], bindingChangesComplete: true })
    const again = request()
    expect(await service.connect(options, again)).toMatchObject({ ok: true, value: { id: connection.id } })
    await service.accept(again.requestId)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('refuses a password mutator during an in-flight disconnect and safely rekeys after that close fails', async () => {
    const { service, request, open, close } = await fixture()
    const first = request(), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const connection = connected.value as ConnectionInfo
    await service.accept(first.requestId)
    const other = request(), connectedOther = await service.connect({ ...options, server: 'other-server' }, other)
    if (!connectedOther.ok) throw connectedOther.error
    await service.accept(other.requestId)
    const ending = deferred<void>()
    close.mockImplementationOnce(async () => { await ending.promise; throw new Error('Close failed.') })
    const disconnect = service.disconnect(connection.id)
    const mutation = passwordMutation((connectedOther.value as ConnectionInfo).id)
    expect(() => service.beginBindingMutation(mutation)).toThrow('current connection operation')
    ending.resolve()
    await expect(disconnect).rejects.toThrow('Close failed.')
    const retained = request()
    expect(await service.connect(options, retained)).toMatchObject({ ok: true, value: { id: connection.id } })
    await service.accept(retained.requestId)
    const ticket = service.beginBindingMutation(mutation)!
    await service.finishBindingMutation(ticket, mutationResult(connection.id, 1, { passwordChanged: true }))
    open.mockRejectedValueOnce(new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 8 }))
    expect(await service.connect(options, request())).toMatchObject({ ok: false })
    const current = request()
    expect(await service.connect({ ...options, password: 'new-secret' }, current)).toMatchObject({ ok: true, value: { id: connection.id } })
    await service.accept(current.requestId)
    expect(open).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('rekeys confirmed password changes while preserving remembered intent=%s and later-step failures', async remember => {
    const { service, request, open, authentication, savedPasswords, bindingEvents } = await fixture()
    const first = request({ credentialPolicy: remember ? 'remember' : 'preserve' }), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo, oldReference = before.authentication!.credential
    await service.accept(first.requestId)
    const ticket = service.beginBindingMutation(passwordMutation(before.id))!
    await service.finishBindingMutation(ticket, { ...mutationResult(before.id, 1, { passwordChanged: true }), error: { code: 'SQL_ERROR', message: 'A later step failed.', retryable: true } })
    expect(bindingEvents).toHaveLength(1)
    expect(bindingEvents[0].changes[0]).toMatchObject({ targetId: first.targetId, handle: { id: before.id, generation: 1 }, revision: 1, authentication: { principal } })
    expect(JSON.stringify(bindingEvents)).not.toContain('new-secret')
    const pin = authentication.resolve(first.targetId)!
    expect(pin.expectedPrincipal).toEqual(principal)
    if (remember) {
      expect(pin.credential!.revision).not.toBe(oldReference!.revision)
      expect(await savedPasswords.getReferenced(pin.credential!, options)).toBe('new-secret')
      expect(await savedPasswords.getReferenced(oldReference!, options)).toBeUndefined()
    } else expect((await savedPasswords.load()).ids).toEqual([])
    const current = request()
    expect(await service.connect({ ...options, password: 'new-secret' }, current)).toMatchObject({ ok: true, value: { id: before.id, targetId: first.targetId } })
    await service.accept(current.requestId)
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRejectedValueOnce(new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 8 }))
    expect(await service.connect(options, request())).toMatchObject({ ok: false })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('readmits a verified saved revision when a confirmed password change kept exactly the same secret', async () => {
    const { service, request, open, savedPasswords, bindingEvents } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo, previous = before.authentication!.credential!
    await service.accept(first.requestId)
    await service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id, options.password))!, mutationResult(before.id, 1, { passwordChanged: true }))
    const published = bindingEvents[0].changes[0].authentication.credential!
    expect(published).toEqual(previous)
    expect(await savedPasswords.getReferenced(published, options)).toBe(options.password)
    await service.disconnect(before.id)
    const background = request({ targetId: first.targetId, mode: 'background', expectedPrincipal: principal, credential: published })
    expect(await service.connect({ ...options, password: undefined }, background)).toMatchObject({ ok: true, value: { targetId: first.targetId, authentication: { credential: published } } })
    await service.accept(background.requestId)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('preserves the resolved default database through password rotation and later reuse', async () => {
    const { service, request, open, authentication } = await fixture()
    const defaultDatabase = { ...options, database: '' }, first = request()
    const connected = await service.connect(defaultDatabase, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo
    expect(before.database).toBe('Sales')
    await service.accept(first.requestId)
    await service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id))!, mutationResult(before.id, 1, { passwordChanged: true }))
    expect(authentication.resolve(first.targetId)?.options.database).toBe('')
    const current = request()
    expect(await service.connect({ ...defaultDatabase, password: 'new-secret' }, current)).toMatchObject({ ok: true, value: { id: before.id, database: 'Sales' } })
    await service.accept(current.requestId)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('rekeys an initial database rename without retaining the original password and publishes the updated pin', async () => {
    const { service, request, open, authentication, bindingEvents } = await fixture()
    const first = request(), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo
    await service.accept(first.requestId)
    const ticket = service.beginBindingMutation({ action: 'rename', connectionId: before.id, requestId: randomUUID(), target: { kind: 'database', name: 'Sales' }, newName: 'RenamedSales' })!
    await service.finishBindingMutation(ticket, mutationResult(before.id, 1, { newDatabase: 'RenamedSales' }))
    expect(authentication.resolve(first.targetId)?.options.database).toBe('RenamedSales')
    expect(bindingEvents[0].changes[0].options).toEqual(connectionTargetOptions({ ...options, database: 'RenamedSales' }))
    const current = request()
    expect(await service.connect({ ...options, database: 'RenamedSales' }, current)).toMatchObject({ ok: true, value: { id: before.id, targetId: first.targetId, database: 'RenamedSales' } })
    await service.accept(current.requestId)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('ignores old mutation revisions and leaves unknown outcomes unkeyed without closing accepted sessions', async () => {
    const { service, request, open, close, bindingEvents } = await fixture()
    const first = request(), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo
    await service.accept(first.requestId)
    await service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id))!, mutationResult(before.id, 2, { passwordChanged: true }))
    await service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id, 'stale-secret'))!, mutationResult(before.id, 1, { passwordChanged: true }))
    expect(bindingEvents).toHaveLength(1)
    const current = request()
    expect(await service.connect({ ...options, password: 'new-secret' }, current)).toMatchObject({ ok: true, value: { id: before.id } })
    await service.accept(current.requestId)
    await service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id, 'unknown-secret'))!)
    open.mockRejectedValueOnce(new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 8 }))
    expect(await service.connect({ ...options, password: 'new-secret' }, request())).toMatchObject({ ok: false })
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).not.toHaveBeenCalled()
    expect(bindingEvents).toHaveLength(1)
  })

  it('clears an obsolete saved revision and warns if confirmed password continuity cannot be saved', async () => {
    const { service, request, authentication, savedPasswords, bindingEvents } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo, oldReference = before.authentication!.credential!
    await service.accept(first.requestId)
    vi.spyOn(savedPasswords, 'set').mockRejectedValueOnce(new Error('unavailable'))
    await service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id))!, mutationResult(before.id, 1, { passwordChanged: true }))
    expect(authentication.resolve(first.targetId)?.credential).toBeUndefined()
    expect(bindingEvents[0]).toMatchObject({ warning: expect.stringContaining('could not be updated'), changes: [{ authentication: { principal, credential: null } }] })
    expect(await savedPasswords.getReferenced(oldReference, options)).toBeUndefined()
  })

  it('holds the close guard through the mutator credential settlement and preserves the last remembered principal', async () => {
    const { service, request, authentication, savedPasswords } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo
    await service.accept(first.requestId)
    let kept: number | undefined
    const checkpoint = new ConnectionSessionCheckpoint(authentication, { write: async (_session, generation) => { kept = generation }, keptBy: generation => kept === generation }, () => service.mutationPending)
    const session: SessionInput = { documents: [], activeIndex: -1, workspace: { version: 1, targets: [{ id: first.targetId, options: connectionTargetOptions(options), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal: principal, credential: before.authentication!.credential! }] } }
    await checkpoint.write(session, 7)
    const writing = deferred<void>(), entered = deferred<void>(), save = savedPasswords.set.bind(savedPasswords)
    vi.spyOn(savedPasswords, 'set').mockImplementationOnce(async (...args) => { entered.resolve(); await writing.promise; await save(...args) })
    const ticket = service.beginBindingMutation(passwordMutation(before.id))!
    const settling = service.finishBindingMutation(ticket, mutationResult(before.id, 1, { passwordChanged: true }))
    await entered.promise
    expect(service.mutationPending).toBe(true)
    expect(() => checkpoint.assertCurrent(7)).toThrow('current connection attempt')
    expect(authentication.resolve(first.targetId)?.expectedPrincipal).toEqual(principal)
    writing.resolve()
    await settling
    expect(service.mutationPending).toBe(false)
    expect(() => checkpoint.assertCurrent(7)).toThrow('connection target changed')
  })

  it.each([undefined, 'CONNECTION_LOST', 'CANCELLED'] as const)('keeps unreported handles unkeyed after an incomplete binding acknowledgement (%s)', async code => {
    const { service, request, open, close } = await fixture()
    const first = request(), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    await service.accept(first.requestId)
    const ticket = service.beginBindingMutation(passwordMutation((connected.value as ConnectionInfo).id))!
    await service.finishBindingMutation(ticket, { steps: [], messages: [], elapsedMs: 1, bindingChanges: [], bindingChangesComplete: false,
      ...code ? { error: { code, message: 'The change may have completed.', retryable: false } } : {} })
    open.mockRejectedValueOnce(new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 8 }))
    expect(await service.connect(options, request())).toMatchObject({ ok: false })
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps a mutator storage settlement guarded through generation loss and finishes only its durable same-principal pin', async () => {
    const { service, request, authentication, savedPasswords, bindingEvents, generation } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), connected = await service.connect(options, first)
    if (!connected.ok) throw connected.error
    const before = connected.value as ConnectionInfo, previous = before.authentication!.credential!
    await service.accept(first.requestId)
    const writing = deferred<void>(), entered = deferred<void>(), save = savedPasswords.set.bind(savedPasswords)
    vi.spyOn(savedPasswords, 'set').mockImplementationOnce(async (...args) => { entered.resolve(); await writing.promise; await save(...args) })
    const settling = service.finishBindingMutation(service.beginBindingMutation(passwordMutation(before.id))!, mutationResult(before.id, 1, { passwordChanged: true }))
    await entered.promise
    expect(authentication.resolve(first.targetId)?.credential).toBeUndefined()
    service.reset()
    generation(2)
    service.backendState({ status: 'starting', generation: 2 })
    expect(service.mutationPending).toBe(true)
    expect(await service.connect(options, request())).toMatchObject({ ok: false })
    writing.resolve()
    await settling
    expect(service.mutationPending).toBe(false)
    const pin = authentication.resolve(first.targetId)!
    expect(pin.expectedPrincipal).toEqual(principal)
    expect(pin.credential!.revision).not.toBe(previous.revision)
    expect(await savedPasswords.getReferenced(pin.credential!, options)).toBe('new-secret')
    expect(bindingEvents).toEqual([])
    const stale = { targetId: first.targetId, expectedPrincipal: principal, credential: previous }
    expect(await service.connect({ ...options, password: undefined }, request({ ...stale, mode: 'background' }))).toMatchObject({ ok: false, connectionFailure: 'identity-changed' })
    expect(await service.connect({ ...options, password: 'new-secret' }, request({ ...stale, credentialIntent: 'preserve' }))).toMatchObject({ ok: false, connectionFailure: 'identity-changed' })
    const recovery = request({ ...stale, mode: 'interactive', credentialIntent: 'update-credentials', credentialPolicy: 'remember' })
    expect(await service.connect({ ...options, password: 'new-secret' }, recovery)).toMatchObject({ ok: true, value: { targetId: first.targetId, authentication: { principal, credential: pin.credential } } })
    await service.accept(recovery.requestId)
  })
  it('cleans a valid current handle when native response validation rejects malformed account proof', async () => {
    const close = vi.fn(async () => {})
    const malformed = { ...info(), principalId: 'not stable proof' }
    await expect(validateOpenedConnection(malformed, 1, close)).rejects.toThrow()
    expect(close).toHaveBeenCalledExactlyOnceWith({ id: malformed.id, generation: 1 })
    await expect(validateOpenedConnection({ ...malformed, generation: 0 }, 1, close)).rejects.toThrow()
    await expect(validateOpenedConnection({ ...malformed, id: 'untrusted handle' }, 1, close)).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
    expect(await validateOpenedConnection(info(), 1, close)).toMatchObject({ principalId })
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('reuses authenticated exact connections while preserving different settings and details-only changes', async () => {
    const { service, open, request } = await fixture()
    const firstContext = request(), first = await service.connect(options, firstContext)
    expect(first).toMatchObject({ ok: true, value: { targetId: firstContext.targetId, authentication: { principal } } })
    expect(await service.accept(firstContext.requestId)).toEqual({ accepted: true, retained: true })
    const secondContext = request(), reused = await service.connect({ ...options, displayName: 'Another label', environment: 'Production', advanced: { packetSize: 8000 } }, secondContext)
    expect(reused).toMatchObject({ ok: true, value: { targetId: firstContext.targetId } })
    expect(open).toHaveBeenCalledTimes(1)
    expect(await service.accept(secondContext.requestId)).toEqual({ accepted: true, retained: true })
    const different = await service.connect({ ...options, database: 'sales' }, request())
    expect(different.ok).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('accepts blank SQL only after authentication and keeps nonblank credentials and different actual accounts separate', async () => {
    const { service, open, close, request } = await fixture()
    const blank = { ...options, password: '' }, first = request()
    expect(await service.connect(blank, first)).toMatchObject({ ok: true, value: { targetId: first.targetId, authentication: { principal } } })
    await service.accept(first.requestId)
    const second = request(), duplicate = await service.connect({ ...options, password: undefined }, second)
    expect(duplicate).toMatchObject({ ok: true, value: { targetId: first.targetId } })
    await service.accept(second.requestId)
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
    const nonblank = request()
    expect(await service.connect(options, nonblank)).toMatchObject({ ok: true, value: { targetId: nonblank.targetId } })
    await service.accept(nonblank.requestId)
    open.mockResolvedValueOnce({ ...info(), login: 'reader', principalId: 'sid:05060708' })
    const otherAccount = request()
    expect(await service.connect(blank, otherAccount)).toMatchObject({ ok: true, value: { targetId: otherAccount.targetId, authentication: { principal: { id: 'sid:05060708' } } } })
    expect(open).toHaveBeenCalledTimes(4)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('authenticates both concurrent blank SQL callers before coalescing their shared receipt', async () => {
    const { service, request, open, close } = await fixture(), firstOpen = deferred<ConnectionInfo>(), secondOpen = deferred<ConnectionInfo>(), firstEntered = deferred<void>(), secondEntered = deferred<void>()
    open.mockImplementationOnce(async () => { firstEntered.resolve(); return firstOpen.promise })
      .mockImplementationOnce(async () => { secondEntered.resolve(); return secondOpen.promise })
    const first = request(), one = service.connect({ ...options, password: '' }, first)
    await firstEntered.promise
    const second = request(), two = service.connect({ ...options, password: undefined }, second)
    let delivered = false
    void two.then(() => { delivered = true })
    firstOpen.resolve(info())
    expect((await one).ok).toBe(true)
    await secondEntered.promise
    expect(delivered).toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
    secondOpen.resolve(info())
    expect(await two).toMatchObject({ ok: true, value: { targetId: first.targetId } })
    await service.accept(second.requestId)
    service.cancel([first.requestId])
    expect(await service.accept(first.requestId)).toEqual({ accepted: false, retained: true })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reconnects an offline blank SQL target only after another successful same-account authentication', async () => {
    const { service, request, open, savedPasswords } = await fixture()
    const first = request(), connected = await service.connect({ ...options, password: '' }, first)
    if (!connected.ok) throw connected.error
    await service.accept(first.requestId)
    await service.disconnect((connected.value as ConnectionInfo).id)
    const second = request()
    expect(await service.connect({ ...options, password: undefined }, second)).toMatchObject({ ok: true, value: { targetId: first.targetId } })
    await service.accept(second.requestId)
    expect(open).toHaveBeenCalledTimes(2)
    expect((await savedPasswords.load()).ids).toEqual([])
    const background = request({ targetId: first.targetId, mode: 'background', expectedPrincipal: principal })
    expect(await service.connect({ ...options, password: undefined }, background)).toMatchObject({ ok: false, connectionFailure: 'credentials-required' })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('never sends a late blank-password handle from a lost generation into the replacement backend', async () => {
    const { service, request, open, close, generation } = await fixture(), late = deferred<ConnectionInfo>(), entered = deferred<void>()
    open.mockImplementationOnce(async () => { entered.resolve(); return late.promise })
    const pending = service.connect({ ...options, password: '' }, request())
    await entered.promise
    generation(2)
    service.backendState({ status: 'starting', generation: 2 })
    expect(await pending).toMatchObject({ ok: false, connectionFailure: 'cancelled' })
    late.resolve(info(1))
    const current = request(), connected = await service.connect({ ...options, password: '' }, current)
    if (!connected.ok) throw connected.error
    await service.accept(current.requestId)
    const duplicate = request()
    expect(await service.connect({ ...options, password: undefined }, duplicate)).toMatchObject({ ok: true, value: { targetId: current.targetId } })
    await service.accept(duplicate.requestId)
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toMatchObject({ generation: 2 })
  })

  it('does not inject a referenced profile password into a different host or weaker TLS while accepting authenticated blank SQL', async () => {
    const { service, request, open, connections, savedPasswords } = await fixture()
    const first = request({ credentialPolicy: 'remember' })
    expect((await service.connect(options, first)).ok).toBe(true)
    await service.accept(first.requestId)
    const profileId = (await connections.load()).library.profiles[0].id
    const { password: _password, ...withoutPassword } = options
    open.mockImplementationOnce(async params => { expect(params).not.toHaveProperty('password'); return info() })
    const evil = request({ profileId, remember: true })
    expect((await service.connect({ ...withoutPassword, server: 'evil-server' }, evil)).ok).toBe(true)
    await service.accept(evil.requestId)
    open.mockImplementationOnce(async params => {
      expect(params).not.toHaveProperty('password')
      throw new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state: 8 })
    })
    expect(await service.connect({ ...withoutPassword, trustServerCertificate: true }, request({ profileId, remember: true }))).toMatchObject({ ok: false, connectionFailure: 'credentials-required' })
    expect(await savedPasswords.get(profileId, options)).toBe(options.password)
    expect(open).toHaveBeenCalledTimes(3)
  })

  it.each([1, 8])('recovers the same target through a typed update after saved SQL credentials fail with state %s', async state => {
    const { service, request, open, authentication, savedPasswords } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), initial = await service.connect(options, first)
    if (!initial.ok) throw initial.error
    const connected = initial.value as ConnectionInfo, credential = connected.authentication!.credential!
    await service.accept(first.requestId)
    await service.disconnect(connected.id)
    open.mockRejectedValueOnce(new BackendError('SQL_ERROR', 'Login failed.', { number: 18456, state }))
    const prior = { targetId: first.targetId, credential, expectedPrincipal: principal }
    const saved = request(prior)
    expect(await service.connect({ ...options, password: undefined }, saved)).toMatchObject({ ok: false, credentialRejected: true })
    expect(authentication.resolve(first.targetId)?.expectedPrincipal).toEqual(principal)
    const update = request({ ...prior, credentialIntent: 'update-credentials', credentialPolicy: 'remember' })
    const recovered = await service.connect({ ...options, password: 'corrected-secret' }, update)
    expect(recovered).toMatchObject({ ok: true, value: { targetId: first.targetId, authentication: { principal } } })
    if (!recovered.ok) throw recovered.error
    await service.accept(update.requestId)
    const replacement = (recovered.value as ConnectionInfo).authentication!.credential!
    expect(replacement.revision).not.toBe(credential.revision)
    expect(await savedPasswords.getReferenced(replacement, options)).toBe('corrected-secret')
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('refuses a final checkpoint when a cancelled credential settlement replaces its pin during the write', async () => {
    const { service, request, authentication } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), initial = await service.connect(options, first)
    if (!initial.ok) throw initial.error
    const connected = initial.value as ConnectionInfo, credential = connected.authentication!.credential!
    await service.accept(first.requestId)
    await service.disconnect(connected.id)
    const writing = deferred<void>(), entered = deferred<void>(), writes: SessionInput[] = []
    let kept: number | undefined
    const checkpoint = new ConnectionSessionCheckpoint(authentication, {
      write: async (session, generation) => { writes.push(structuredClone(session)); entered.resolve(); await writing.promise; kept = generation },
      keptBy: generation => kept === generation
    })
    const session: SessionInput = { documents: [], activeIndex: -1, workspace: { version: 1, targets: [{ id: first.targetId, options: connectionTargetOptions(options), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal: principal, credential }] } }
    const pending = checkpoint.write(session, 7)
    await entered.promise
    const update = request({ targetId: first.targetId, expectedPrincipal: principal, credential, credentialIntent: 'update-credentials', credentialPolicy: 'remember' })
    const settled = await service.connect({ ...options, password: 'new-secret' }, update)
    if (!settled.ok) throw settled.error
    const replacement = (settled.value as ConnectionInfo).authentication!.credential!
    expect(replacement.revision).not.toBe(credential.revision)
    // A busy renderer rejects the completed attempt; its authenticated atomic vault action has already finished.
    service.cancel([update.requestId])
    expect(await service.accept(update.requestId)).toEqual({ accepted: false, retained: false })
    writing.resolve()
    await expect(pending).rejects.toThrow('connection target changed')
    expect(writes[0].workspace!.targets[0].credential).toEqual(credential)
    expect(() => checkpoint.assertCurrent(7)).toThrow('connection target changed')
    await checkpoint.write(session, 7)
    expect(writes[1].workspace!.targets[0].credential).toEqual(replacement)
    expect(() => checkpoint.assertCurrent(7)).not.toThrow()
    authentication.remember(first.targetId, options, { principal, credential: null }, 'update-credentials')
    expect(() => checkpoint.assertCurrent(7)).toThrow('connection target changed')
  })

  it('blocks a final close while an already-started credential write can still replace the captured pin', async () => {
    const { service, request, authentication, savedPasswords } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), initial = await service.connect(options, first)
    if (!initial.ok) throw initial.error
    const connected = initial.value as ConnectionInfo, credential = connected.authentication!.credential!
    await service.accept(first.requestId)
    await service.disconnect(connected.id)
    let kept: number | undefined
    const checkpoint = new ConnectionSessionCheckpoint(authentication, {
      write: async (_session, generation) => { kept = generation }, keptBy: generation => kept === generation
    }, () => hasPendingCredentialRequests(savedPasswords))
    const session: SessionInput = { documents: [], activeIndex: -1, workspace: { version: 1, targets: [{ id: first.targetId, options: connectionTargetOptions(options), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal: principal, credential }] } }
    await checkpoint.write(session, 7)
    const writing = deferred<void>(), entered = deferred<void>(), save = savedPasswords.set.bind(savedPasswords)
    vi.spyOn(savedPasswords, 'set').mockImplementationOnce(async (...args) => { entered.resolve(); await writing.promise; await save(...args) })
    const update = request({ targetId: first.targetId, expectedPrincipal: principal, credential, credentialIntent: 'update-credentials', credentialPolicy: 'remember' })
    const pending = service.connect({ ...options, password: 'new-secret' }, update)
    await entered.promise
    expect(authentication.resolve(first.targetId)?.credential).toEqual(credential)
    expect(() => checkpoint.assertCurrent(7)).toThrow('current connection attempt')
    await expect(checkpoint.write(session, 7)).rejects.toThrow('current connection attempt')
    service.cancel([update.requestId])
    writing.resolve()
    expect(await pending).toMatchObject({ ok: false, connectionFailure: 'cancelled' })
    await service.accept(update.requestId)
    expect(hasPendingCredentialRequests(savedPasswords)).toBe(false)
    expect(() => checkpoint.assertCurrent(7)).toThrow('connection target changed')
  })

  it('releases an unaccepted delivery, but a cancelled reused caller never closes an accepted shared handle', async () => {
    const { service, request, close } = await fixture()
    const abandoned = request()
    expect((await service.connect(options, abandoned)).ok).toBe(true)
    expect(service.cancel([abandoned.requestId])).toBe(1)
    expect(await service.accept(abandoned.requestId)).toEqual({ accepted: false, retained: false })
    expect(close).toHaveBeenCalledTimes(1)
    const accepted = request()
    await service.connect(options, accepted)
    expect(await service.accept(accepted.requestId)).toEqual({ accepted: true, retained: true })
    expect(await service.accept(accepted.requestId)).toEqual({ accepted: true, retained: true })
    const duplicate = request()
    await service.connect(options, duplicate)
    service.cancel([duplicate.requestId])
    expect(await service.accept(duplicate.requestId)).toEqual({ accepted: false, retained: true })
    expect(service.cancel([accepted.requestId])).toBe(0)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('honors explicit remember and forget on reused live credentials without opening another transport', async () => {
    const { service, request, open, savedPasswords, connections, directory } = await fixture()
    const first = request()
    const connected = await service.connect(options, first)
    expect(connected.ok).toBe(true)
    await service.accept(first.requestId)
    const remember = request({ remember: true, credentialPolicy: 'remember' })
    const remembered = await service.connect(options, remember)
    expect(remembered).toMatchObject({ ok: true, value: { credentialUpdated: true, authentication: { credential: { revision: expect.any(String) } } } })
    await service.accept(remember.requestId)
    const library = (await connections.load()).library
    expect(await savedPasswords.get(library.profiles[0].id, options)).toBe(options.password)
    const before = await readFile(join(directory, 'saved.json'), 'utf8')
    const preserved = request()
    await service.connect(options, preserved)
    await service.accept(preserved.requestId)
    expect(await readFile(join(directory, 'saved.json'), 'utf8')).toBe(before)
    const forget = request({ remember: false, credentialPolicy: 'forget' })
    expect(await service.connect(options, forget)).toMatchObject({ ok: true, value: { credentialUpdated: true, authentication: { credential: null } } })
    await service.accept(forget.requestId)
    expect(await savedPasswords.get(library.profiles[0].id, options)).toBeUndefined()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('saves the selected profile reconnect preference on reuse without changing aliases, recency or transport identity', async () => {
    const { service, request, open, connections } = await fixture()
    const first = request({ autoReconnect: 'on' })
    expect((await service.connect(options, first)).ok).toBe(true)
    await service.accept(first.requestId)
    const originalId = (await connections.load()).library.profiles[0].id
    const added = await connections.save({ options: { ...options, server: 'other-alias' }, favorite: true, autoReconnect: 'on' })
    const aliasId = added.profiles.find(profile => profile.id !== originalId)!.id
    await connections.save({ id: aliasId, options: { ...options, displayName: 'Saved alias' }, autoReconnect: 'on' })
    const before = (await connections.load()).library.profiles
    const selected = request({ profileId: aliasId, selectedProfileId: aliasId, autoReconnect: 'off' })
    expect(await service.connect({ ...options, displayName: 'Picker draft' }, selected)).toMatchObject({ ok: true, value: { targetId: first.targetId } })
    await service.accept(selected.requestId)
    const after = (await connections.load()).library.profiles
    expect(after.find(profile => profile.id === originalId)).toEqual(before.find(profile => profile.id === originalId))
    expect(after.find(profile => profile.id === aliasId)).toEqual({ ...before.find(profile => profile.id === aliasId), autoReconnect: 'off' })
    const absent = request({ profileId: aliasId, selectedProfileId: aliasId })
    expect((await service.connect(options, absent)).ok).toBe(true)
    await service.accept(absent.requestId)
    expect((await connections.load()).library.profiles).toEqual(after)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('keeps a selected Windows alias separate from the credential-source hint during physical history and live policy updates', async () => {
    const { service, request, open, close, connections } = await fixture()
    const windows: ConnectionOptions = { ...options, authentication: 'windows', username: undefined, password: undefined, displayName: 'First alias' }
    const firstSaved = await connections.save({ options: windows, favorite: true, autoReconnect: 'off' })
    const firstId = firstSaved.profiles[0].id
    const added = await connections.save({ options: { ...windows, server: 'temporary-other' }, favorite: true, autoReconnect: 'on' })
    const secondId = added.profiles.find(profile => profile.id !== firstId)!.id
    await connections.save({ id: secondId, options: { ...windows, displayName: 'Second alias' }, autoReconnect: 'on' })
    const originalFirst = (await connections.load()).library.profiles.find(profile => profile.id === firstId)
    const physical = request({ selectedProfileId: secondId, autoReconnect: 'on' })
    const connected = await service.connect({ ...windows, displayName: 'Second alias' }, physical)
    if (!connected.ok) throw connected.error
    await service.accept(physical.requestId)
    const beforeReuse = (await connections.load()).library.profiles
    expect(beforeReuse.find(profile => profile.id === firstId)).toEqual(originalFirst)
    expect(beforeReuse.find(profile => profile.id === secondId)).toMatchObject({ autoReconnect: 'on', lastConnected: expect.any(String) })
    const reuse = request({ selectedProfileId: secondId, profileId: firstId, autoReconnect: 'inherit' })
    expect(await service.connect({ ...windows, displayName: 'Unsaved draft' }, reuse)).toMatchObject({ ok: true, value: { id: (connected.value as ConnectionInfo).id, targetId: physical.targetId } })
    await service.accept(reuse.requestId)
    const after = (await connections.load()).library.profiles
    expect(after.find(profile => profile.id === firstId)).toEqual(originalFirst)
    expect(after.find(profile => profile.id === secondId)).toEqual({ ...beforeReuse.find(profile => profile.id === secondId), autoReconnect: 'inherit' })
    // The unresolved OS identity authenticates independently, then the actual same principal reuses its accepted handle.
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('cancels a caller while it waits for a credential lease, before sending another backend request', async () => {
    const { service, request, open } = await fixture(), held = deferred<ConnectionInfo>(), entered = deferred<void>()
    open.mockImplementationOnce(async () => { entered.resolve(); return held.promise })
    const first = request(), pending = service.connect(options, first)
    await entered.promise
    const second = request(), queued = service.connect(options, second)
    service.cancel([second.requestId])
    expect(await queued).toMatchObject({ ok: false, connectionFailure: 'cancelled' })
    held.resolve(info())
    expect((await pending).ok).toBe(true)
    await service.accept(first.requestId)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('background reuse preserves the exact credential revision and sends no interactive request', async () => {
    const { service, request, savedPasswords, connections, authentication, open, directory } = await fixture()
    const first = request({ credentialPolicy: 'remember', remember: true, autoReconnect: 'on' })
    const initial = await service.connect(options, first)
    if (!initial.ok) throw initial.error
    await service.accept(first.requestId)
    const receipt = initial.value as ConnectionInfo
    const reference = receipt.authentication!.credential!
    const otherId = randomUUID()
    authentication.restore({ version: 1, targets: [{ id: otherId, options: connectionTargetOptions(options), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal: principal, credential: reference }] })
    const before = await readFile(join(directory, 'saved.json'), 'utf8')
    const background = request({ targetId: otherId, mode: 'background', credentialPolicy: 'preserve', credential: reference, expectedPrincipal: principal, autoReconnect: 'off' })
    const restored = await service.connect({ ...options, password: undefined }, background)
    expect(restored).toMatchObject({ ok: true, value: { targetId: receipt.targetId, authentication: { credential: reference } } })
    await service.accept(background.requestId)
    expect(await readFile(join(directory, 'saved.json'), 'utf8')).toBe(before)
    expect(await savedPasswords.get((await connections.load()).library.profiles[0].id, options)).toBe(options.password)
    expect((await connections.load()).library.profiles[0].autoReconnect).toBe('on')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('requires stable backend account proof and never substitutes a matching display login', async () => {
    const { service, request, open, close } = await fixture()
    open.mockResolvedValueOnce({ ...info(), principalId: undefined })
    expect(await service.connect(options, request())).toMatchObject({ ok: false })
    expect(close).toHaveBeenCalledTimes(1)
    const first = request(), firstInfo = { ...info(), principalId: 'entra:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222' }
    open.mockResolvedValueOnce(firstInfo)
    const dynamic: ConnectionOptions = { ...options, authentication: 'entraMfa', password: undefined }
    expect((await service.connect(dynamic, first)).ok).toBe(true)
    await service.accept(first.requestId)
    const second = request()
    open.mockResolvedValueOnce({ ...info(), principalId: 'entra:11111111-1111-1111-1111-111111111111:33333333-3333-3333-3333-333333333333' })
    const changed = await service.connect(dynamic, second)
    expect(changed).toMatchObject({ ok: true, value: { targetId: second.targetId } })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('settles a queued manual credential choice after silent background authentication without a second open', async () => {
    const { service, request, savedPasswords, open } = await fixture()
    const first = request({ credentialPolicy: 'remember' }), initial = await service.connect(options, first)
    if (!initial.ok) throw initial.error
    const connected = initial.value as ConnectionInfo
    await service.accept(first.requestId)
    await service.disconnect(connected.id)
    const opened = deferred<void>(), backend = deferred<ConnectionInfo>()
    open.mockImplementationOnce(async params => { expect(params).toMatchObject({ nonInteractive: true }); opened.resolve(); return backend.promise })
    const background = request({ targetId: connected.targetId, mode: 'background', expectedPrincipal: principal, credential: connected.authentication!.credential }), pending = service.connect({ ...options, password: undefined }, background)
    await opened.promise
    const manual = request({ credentialPolicy: 'forget' }), queued = service.connect(options, manual)
    backend.resolve(info())
    expect(await pending).toMatchObject({ ok: true, value: { targetId: connected.targetId } })
    expect(await queued).toMatchObject({ ok: true, value: { targetId: connected.targetId, credentialUpdated: true, authentication: { credential: null } } })
    await service.accept(background.requestId)
    await service.accept(manual.requestId)
    expect(await savedPasswords.getReferenced(connected.authentication!.credential!, options)).toBeUndefined()
    expect(open).toHaveBeenCalledTimes(2)
    const preserve = request(), preserved = await service.connect(options, preserve)
    expect(preserved.ok && (preserved.value as ConnectionInfo).credentialUpdated).toBeUndefined()
  })

  it('does not claim a shared handle disappeared when disposal fails, and fences explicit disconnects', async () => {
    const { service, request, close, open } = await fixture()
    const abandoned = request()
    const initial = await service.connect(options, abandoned)
    if (!initial.ok) throw initial.error
    close.mockRejectedValueOnce(new Error('closed outcome unknown'))
    service.cancel([abandoned.requestId])
    expect(await service.accept(abandoned.requestId)).toEqual({ accepted: false, retained: true })
    const retry = request(), resumed = await service.connect(options, retry)
    expect(resumed.ok).toBe(true)
    await service.accept(retry.requestId)
    const ending = deferred<{ disconnected: boolean }>()
    close.mockImplementationOnce(() => ending.promise)
    const handle = (resumed as { ok: true; value: ConnectionInfo }).value
    const disconnect = service.disconnect(handle.id)
    expect((await service.connect(options, request({ targetId: handle.targetId }))).ok).toBe(false)
    ending.resolve({ disconnected: true })
    expect(await disconnect).toEqual({ disconnected: true })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('authenticates again after disconnect and reconnects the exact offline target with the same unremembered secret', async () => {
    const { service, request, open } = await fixture()
    const first = request(), one = await service.connect(options, first)
    if (!one.ok) throw one.error
    const original = one.value as ConnectionInfo
    await service.accept(first.requestId)
    expect(await service.disconnect(original.id)).toEqual({ disconnected: true })
    const second = request(), two = await service.connect({ ...options, displayName: 'Selected label' }, second)
    expect(two).toMatchObject({ ok: true, value: { targetId: original.targetId } })
    expect(open).toHaveBeenCalledTimes(2)
    await service.accept(second.requestId)
    const again = two.ok && two.value as ConnectionInfo
    if (!again) throw new Error('Expected receipt')
    await service.disconnect(again.id)
    service.pruneTargets([original.targetId!])
    const third = request()
    expect(await service.connect(options, third)).toMatchObject({ ok: true, value: { targetId: third.targetId } })
  })

  it('does not reuse an offline account after its stable SID changes despite the same display login', async () => {
    const { service, request, open } = await fixture()
    const first = request(), one = await service.connect(options, first)
    if (!one.ok) throw one.error
    await service.accept(first.requestId)
    await service.disconnect((one.value as ConnectionInfo).id)
    open.mockResolvedValueOnce({ ...info(), login: 'reader', principalId: 'sid:05060708' })
    const second = request()
    expect(await service.connect(options, second)).toMatchObject({ ok: true, value: { targetId: second.targetId, authentication: { principal: { id: 'sid:05060708' } } } })
  })

  it('drops process-local affinity on backend loss and protects accepted live pins from pruning', async () => {
    const { service, request, authentication, generation } = await fixture()
    const first = request(), one = await service.connect(options, first)
    if (!one.ok) throw one.error
    await service.accept(first.requestId)
    const original = one.value as ConnectionInfo
    expect(service.pruneTargets([original.targetId!])).toBe(0)
    expect(authentication.resolve(original.targetId!)).toBeDefined()
    await service.disconnect(original.id)
    service.backendState({ status: 'starting', generation: 2 })
    generation(2)
    const second = request()
    expect(await service.connect(options, second)).toMatchObject({ ok: true, value: { targetId: second.targetId } })
  })

  it('defers pruning an unaccepted delivery until cancellation cleanup finishes', async () => {
    const { service, request, authentication } = await fixture()
    const context = request(), connected = await service.connect(options, context)
    if (!connected.ok) throw connected.error
    expect(service.pruneTargets([context.targetId])).toBe(0)
    expect(authentication.resolve(context.targetId)).toBeDefined()
    service.cancel([context.requestId])
    expect(await service.accept(context.requestId)).toEqual({ accepted: false, retained: false })
    expect(authentication.resolve(context.targetId)).toBeUndefined()
  })

  it('joins an in-progress explicit close when a delivered receipt is cancelled', async () => {
    const { service, request, close } = await fixture()
    const context = request(), connected = await service.connect(options, context)
    if (!connected.ok) throw connected.error
    const ending = deferred<{ disconnected: boolean }>()
    close.mockImplementationOnce(() => ending.promise)
    const disconnect = service.disconnect((connected.value as ConnectionInfo).id)
    service.cancel([context.requestId])
    ending.resolve({ disconnected: true })
    expect(await disconnect).toEqual({ disconnected: true })
    expect(await service.accept(context.requestId)).toEqual({ accepted: false, retained: false })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
