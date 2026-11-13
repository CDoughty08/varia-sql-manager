import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectionOpenService, validateOpenedConnection } from '../src/main/connection-open'
import { ConnectionAuthenticationGuard } from '../src/main/connection-authentication'
import { ConnectionStore } from '../src/main/connection-store'
import { SavedPasswordStore } from '../src/main/saved-passwords'
import { testCipher } from '../src/main/secret-cipher'
import { connectionTargetOptions } from '../src/shared/connection-targets'
import type { ConnectionInfo, ConnectionOptions } from '../src/shared/contracts'

const options: ConnectionOptions = { server: 'server', database: 'Sales', authentication: 'sql', username: 'reader', password: 'test-secret', trustServerCertificate: false }
const principalId = 'sid:01020304'
const principal = { provider: 'sqlServer', authentication: 'sql', id: principalId } as const
const directories: string[] = []
const services: ConnectionOpenService[] = []
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const info = (generation = 1): ConnectionInfo => ({ id: randomUUID(), generation, server: 'server', database: 'Sales', serverVersion: '17', login: 'reader', principalId })
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
  const close = vi.fn(async () => ({ disconnected: true }))
  let generation: number | undefined = 1
  const service = new ConnectionOpenService({ authentication, savedPasswords, connections, open, close, generation: () => generation })
  services.push(service)
  const request = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), targetId: randomUUID(), credentialPolicy: 'preserve', ...extra })
  return { service, open, close, authentication, savedPasswords, connections, directory, request, generation: (value: number | undefined) => { generation = value } }
}

describe('main connection ownership', () => {
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
    const first = request({ credentialPolicy: 'remember', remember: true })
    const initial = await service.connect(options, first)
    if (!initial.ok) throw initial.error
    await service.accept(first.requestId)
    const receipt = initial.value as ConnectionInfo
    const reference = receipt.authentication!.credential!
    const otherId = randomUUID()
    authentication.restore({ version: 1, targets: [{ id: otherId, options: connectionTargetOptions(options), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, expectedPrincipal: principal, credential: reference }] })
    const before = await readFile(join(directory, 'saved.json'), 'utf8')
    const background = request({ targetId: otherId, mode: 'background', credentialPolicy: 'preserve', credential: reference, expectedPrincipal: principal })
    const restored = await service.connect({ ...options, password: undefined }, background)
    expect(restored).toMatchObject({ ok: true, value: { targetId: receipt.targetId, authentication: { credential: reference } } })
    await service.accept(background.requestId)
    expect(await readFile(join(directory, 'saved.json'), 'utf8')).toBe(before)
    expect(await savedPasswords.get((await connections.load()).library.profiles[0].id, options)).toBe(options.password)
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
