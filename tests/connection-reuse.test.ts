import { describe, expect, it, vi } from 'vitest'
import { ConnectionReuseCoordinator, type AuthenticatedConnection, type ConnectionReuseRequest } from '../src/main/connection-reuse'
import type { BackendConnectionHandle } from '../src/shared/connection-targets'
import type { ConnectionOptions } from '../src/shared/contracts'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const options: ConnectionOptions = { server: 'sql-prod-01', database: 'Sales', authentication: 'sql', username: 'alex', password: 'typed-secret', trustServerCertificate: false }
const request = (target = 1, changes: Partial<ConnectionReuseRequest> = {}): ConnectionReuseRequest => ({ targetId: id(target), generation: 1, options, ...changes })
const answer = (handle = 50, generation = 1, authentication: ConnectionOptions['authentication'] = 'sql', account = 'alex'): AuthenticatedConnection<BackendConnectionHandle> => ({ connection: { id: id(handle), generation }, principal: { authentication, id: account } })
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const fixture = () => {
  const dispose = vi.fn(async (_connection: BackendConnectionHandle) => {}), cleanupFailed = vi.fn()
  return { coordinator: new ConnectionReuseCoordinator({ dispose, cleanupFailed }), dispose, cleanupFailed }
}

describe('authoritative main connection reuse', () => {
  it('coalesces pending SQL connects and gives every caller the same accepted handle without cleanup', async () => {
    const { coordinator, dispose } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const firstOpen = vi.fn(() => pending.promise), secondOpen = vi.fn(async () => answer(51))
    const first = coordinator.connect(request(), firstOpen)
    const second = coordinator.connect(request(2), secondOpen)
    expect(firstOpen).toHaveBeenCalledOnce()
    expect(secondOpen).not.toHaveBeenCalled()
    pending.resolve(answer())
    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual({ status: 'connected', targetId: id(1), ...answer() })
    expect(two).toBe(one)
    expect(Object.isFrozen(one)).toBe(true)
    expect(dispose).not.toHaveBeenCalled()
    expect(JSON.stringify(coordinator)).toBe('{}')
  })

  it('reuses only authenticated live equality while ignoring presentation', async () => {
    const { coordinator, dispose } = fixture(), open = vi.fn(async () => answer())
    await coordinator.connect(request(), open)
    const again = await coordinator.connect(request(2, { options: { ...options, displayName: 'Selected', color: '#123456', environment: 'Test' } }), open)
    expect(again).toEqual({ status: 'reused', targetId: id(1), ...answer() })
    expect(open).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('never matches by profile keys, observed server names, credentials or partial settings', async () => {
    const { coordinator } = fixture()
    await coordinator.connect(request(), async () => answer())
    const variants: ConnectionOptions[] = [
      { ...options, password: 'other-secret' }, { ...options, username: 'Alex' }, { ...options, database: 'sales' },
      { ...options, server: 'tcp:sql-prod-01' }, { ...options, encrypt: 'strict' }, { ...options, trustServerCertificate: true },
      { ...options, advanced: { commandTimeout: 0 } }, { ...options, advanced: { connectRetryCount: 2 } }
    ]
    for (const [index, variant] of variants.entries()) {
      const result = await coordinator.connect(request(index + 2, { options: variant }), async () => answer(index + 51))
      expect(result.status).toBe('connected')
    }
  })

  it('authenticates unresolved dynamic accounts separately and then deduplicates with trusted evidence', async () => {
    const { coordinator, dispose } = fixture(), one = deferred<AuthenticatedConnection<BackendConnectionHandle>>(), two = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const selected = { ...options, authentication: 'entraMfa' as const, password: undefined, username: undefined }
    const first = coordinator.connect(request(1, { options: selected }), () => one.promise)
    const second = coordinator.connect(request(2, { options: selected }), () => two.promise)
    one.resolve(answer(50, 1, 'entraMfa', 'tenant/account'))
    expect((await first).status).toBe('connected')
    two.resolve(answer(51, 1, 'entraMfa', 'tenant/account'))
    expect(await second).toEqual({ status: 'reused', targetId: id(1), ...answer(50, 1, 'entraMfa', 'tenant/account') })
    expect(dispose).toHaveBeenCalledExactlyOnceWith(answer(51).connection)
    const other = await coordinator.connect(request(3, { options: selected }), async () => answer(52, 1, 'entraMfa', 'tenant/other'))
    expect(other.status).toBe('connected')
  })

  it('can join dynamic authentication only when main resolved the candidate account first', async () => {
    const { coordinator } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const selected = { ...options, authentication: 'windows' as const, password: undefined, username: undefined }
    const principal = { authentication: 'windows' as const, id: 'domain/alex' }
    const open = vi.fn(() => pending.promise), ignored = vi.fn(async () => answer())
    const one = coordinator.connect(request(1, { options: selected, principal }), open)
    const two = coordinator.connect(request(2, { options: selected, principal }), ignored)
    expect(ignored).not.toHaveBeenCalled()
    pending.resolve(answer(50, 1, 'windows', principal.id))
    expect(await one).toBe(await two)
  })

  it('rejects changed expected or pre-resolved accounts without replacing a target', async () => {
    const { coordinator, dispose } = fixture()
    const expectedPrincipal = { authentication: 'sql' as const, id: 'alex' }
    expect(await coordinator.connect(request(1, { expectedPrincipal }), async () => answer(50, 1, 'sql', 'other'))).toEqual({ status: 'identity-changed' })
    expect(dispose).toHaveBeenCalledExactlyOnceWith(answer().connection)
    await coordinator.connect(request(1, { expectedPrincipal }), async () => answer(51))
    const open = vi.fn(async () => answer(52))
    expect(await coordinator.connect(request(1, { expectedPrincipal: { ...expectedPrincipal, id: 'other' } }), open)).toEqual({ status: 'identity-changed' })
    expect(await coordinator.connect(request(1, { principal: { ...expectedPrincipal, id: 'other' } }), open)).toEqual({ status: 'identity-changed' })
    expect(open).not.toHaveBeenCalled()
    expect(await coordinator.connect(request(1, { options: { ...options, password: 'changed' }, credentialIntent: 'update-credentials', expectedPrincipal }), open)).toEqual({ status: 'busy' })
  })

  it('keeps credential update intent separate from preserve operations', async () => {
    const { coordinator, dispose } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const first = coordinator.connect(request(), () => pending.promise)
    const open = vi.fn(async () => answer(51))
    const second = await coordinator.connect(request(2, { credentialIntent: 'update-credentials' }), open)
    expect(open).toHaveBeenCalledOnce()
    pending.resolve(answer())
    expect(await first).toEqual({ ...second, status: 'reused' })
    expect(dispose).toHaveBeenCalledExactlyOnceWith(answer().connection)
  })

  it('cancels one joined caller without allowing it to dispose the accepted connection', async () => {
    const { coordinator, dispose } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>(), joinedSignal = new AbortController()
    const owner = coordinator.connect(request(), () => pending.promise)
    const joined = coordinator.connect(request(2, { signal: joinedSignal.signal }), async () => answer(51))
    joinedSignal.abort()
    expect(await joined).toEqual({ status: 'cancelled' })
    pending.resolve(answer())
    expect((await owner).status).toBe('connected')
    expect(dispose).not.toHaveBeenCalled()
  })

  it('invalidates removed pending targets and lets a replacement operation complete independently', async () => {
    const { coordinator, dispose } = fixture(), old = deferred<AuthenticatedConnection<BackendConnectionHandle>>(), current = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    let oldSignal: AbortSignal | undefined
    const first = coordinator.connect(request(), signal => { oldSignal = signal; return old.promise })
    const joined = coordinator.connect(request(2), async () => answer(51))
    expect(coordinator.removeTarget(id(1))).toBe(true)
    expect(oldSignal?.aborted).toBe(true)
    expect(await first).toEqual({ status: 'cancelled' })
    expect(await joined).toEqual({ status: 'cancelled' })
    const replacement = coordinator.connect(request(), () => current.promise)
    current.resolve(answer(52))
    expect((await replacement).status).toBe('connected')
    old.resolve(answer(50))
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledExactlyOnceWith(answer(50).connection))
    const open = vi.fn(async () => answer(53))
    expect(await coordinator.connect(request(), open)).toEqual({ status: 'reused', targetId: id(1), ...answer(52) })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not let cancellation of a joined target cancel the accepted target owner', async () => {
    const { coordinator, dispose } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const first = coordinator.connect(request(), () => pending.promise)
    const joined = coordinator.connect(request(2), async () => answer(51))
    coordinator.cancelTarget(id(2))
    expect(await joined).toEqual({ status: 'cancelled' })
    pending.resolve(answer())
    expect((await first).status).toBe('connected')
    expect(dispose).not.toHaveBeenCalled()
  })

  it('rejects stale generations and cleans a late successful handle without resurrecting it', async () => {
    const { coordinator, dispose } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const first = coordinator.connect(request(), () => pending.promise)
    coordinator.markLostBefore(2)
    expect(await first).toEqual({ status: 'cancelled' })
    pending.resolve(answer())
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    const current = await coordinator.connect(request(1, { generation: 2 }), async () => answer(51, 2))
    expect(current.status).toBe('connected')
    expect(await coordinator.connect(request(), async () => answer())).toEqual({ status: 'cancelled' })
    expect(await coordinator.connect(request(2, { generation: 2, options: { ...options, password: 'other' } }), async () => answer(52, 1))).toEqual({ status: 'cancelled' })
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('fences disconnects, preserves a failed disconnect and refuses removal of live transports', async () => {
    const { coordinator } = fixture(), open = vi.fn(async () => answer())
    await coordinator.connect(request(), open)
    expect(coordinator.removeTarget(id(1))).toBe(false)
    expect(coordinator.beginDisconnect(answer().connection)).toBe(true)
    expect(coordinator.beginDisconnect(answer().connection)).toBe(false)
    expect(await coordinator.connect(request(), open)).toEqual({ status: 'busy' })
    expect(coordinator.finishDisconnect(answer().connection, false)).toBe(true)
    expect((await coordinator.connect(request(), open)).status).toBe('reused')
    expect(coordinator.beginDisconnect(answer().connection)).toBe(true)
    expect(coordinator.finishDisconnect(answer().connection, true)).toBe(true)
    expect(coordinator.removeTarget(id(1))).toBe(true)
    expect(coordinator.finishDisconnect(answer().connection, true)).toBe(false)
    expect((await coordinator.connect(request(), open)).status).toBe('connected')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('never disposes a handle already accepted by another operation', async () => {
    const { coordinator, dispose } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const first = coordinator.connect(request(), () => pending.promise)
    await coordinator.connect(request(2, { options: { ...options, password: 'other' } }), async () => answer())
    coordinator.cancelTarget(id(1))
    pending.resolve(answer())
    expect(await first).toEqual({ status: 'cancelled' })
    await vi.waitFor(() => expect(coordinator.removeTarget(id(2))).toBe(false))
    expect(dispose).not.toHaveBeenCalled()
  })

  it('revalidates equivalent ownership when cleanup overlaps disconnect', async () => {
    const cleaning = deferred<void>(), dispose = vi.fn(() => cleaning.promise)
    const coordinator = new ConnectionReuseCoordinator<BackendConnectionHandle>({ dispose })
    const dynamic = { ...options, authentication: 'entraMfa' as const, username: undefined, password: undefined }
    await coordinator.connect(request(1, { options: dynamic }), async () => answer(50, 1, 'entraMfa'))
    const duplicate = coordinator.connect(request(2, { options: dynamic }), async () => answer(51, 1, 'entraMfa'))
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    coordinator.beginDisconnect(answer().connection)
    coordinator.finishDisconnect(answer().connection, true)
    cleaning.resolve()
    expect(await duplicate).toEqual({ status: 'cancelled' })
  })

  it('returns actual failures to main, reports cleanup failures and releases failed joins', async () => {
    const { coordinator, dispose, cleanupFailed } = fixture(), backendError = new Error('Backend failed')
    expect(await coordinator.connect(request(), async () => { throw backendError })).toEqual({ status: 'failed', error: backendError })
    expect((await coordinator.connect(request(), async () => answer())).status).toBe('connected')
    dispose.mockRejectedValueOnce(backendError)
    const mismatched = await coordinator.connect(request(2, { options: { ...options, password: 'other' }, expectedPrincipal: { authentication: 'sql', id: 'expected' } }), async () => answer(51))
    expect(mismatched).toEqual({ status: 'identity-changed' })
    expect(cleanupFailed).toHaveBeenCalledExactlyOnceWith(backendError)
  })

  it('rejects malformed inputs before calling authentication and remains inert after disposal', async () => {
    const { coordinator, dispose } = fixture(), open = vi.fn(async () => answer())
    for (const invalid of [request(1, { targetId: 'server' }), request(1, { generation: -1 }), request(1, { options: { ...options, password: 'x'.repeat(1025) } }), request(1, { principal: { authentication: 'sql', id: '' } })]) {
      expect(await coordinator.connect(invalid, open)).toEqual({ status: 'invalid' })
    }
    expect(open).not.toHaveBeenCalled()
    coordinator.dispose()
    coordinator.dispose()
    expect(await coordinator.connect(request(), open)).toEqual({ status: 'cancelled' })
    expect(dispose).not.toHaveBeenCalled()
  })

  it('bounds pending operations and joined callers without opening another transport', async () => {
    const { coordinator } = fixture(), pending = deferred<AuthenticatedConnection<BackendConnectionHandle>>()
    const open = vi.fn(() => pending.promise)
    const calls = Array.from({ length: 200 }, (_, index) => coordinator.connect(request(index + 1), open))
    expect(await coordinator.connect(request(201), open)).toEqual({ status: 'busy' })
    expect(open).toHaveBeenCalledOnce()
    coordinator.cancelTarget(id(1))
    expect((await Promise.all(calls)).every(result => result.status === 'cancelled')).toBe(true)
    pending.resolve(answer())
  })
})
