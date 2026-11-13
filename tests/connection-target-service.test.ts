import { describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions, type BackendConnectionHandle, type ConnectionAuthentication, type ConnectionWorkspace, type PersistedConnectionTarget } from '../src/shared/connection-targets'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const handle = (value = 50, generation = 1): BackendConnectionHandle => ({ id: id(value), generation })
const authentication: ConnectionAuthentication = { principal: { provider: 'sqlServer', authentication: 'sql', id: 'alex' } }
const record = (value = 1): PersistedConnectionTarget => ({
  id: id(value), options: connectionTargetOptions({ server: 'sql-prod-01', database: 'Sales', authentication: 'sql', username: 'alex', password: 'never-keep', trustServerCertificate: false }),
  details: { displayName: 'Production reporting', environment: 'Production', autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: authentication.principal
})
function fixture(target = record()) {
  const service = new ConnectionTargetService()
  service.markLostBefore(1)
  service.add(target)
  return service
}
function connected() {
  const service = fixture(), operation = service.beginConnect(id(1), 1, id(10))!
  expect(service.completeConnect(operation, handle(), authentication)).toEqual({ status: 'accepted' })
  return service
}

describe('durable connection targets', () => {
  it('restores distinct unresolved targets in order, offline, without persisting runtime state', () => {
    const service = fixture(), workspace: ConnectionWorkspace = { version: 1, targets: [record(2), record(1)] }
    expect(service.restore(workspace)).toBe(true)
    expect(service.getSnapshot().map(target => target.id)).toEqual([id(2), id(1)])
    expect(service.getSnapshot().every(target => target.lifecycle.state === 'disconnected')).toBe(true)
    const operation = service.beginConnect(id(2), 1, id(10))!
    service.completeConnect(operation, handle(), authentication)
    expect(service.exportWorkspace()).toEqual(workspace)
    expect(JSON.stringify(service.exportWorkspace())).not.toMatch(/password|never-keep|lifecycle|attemptId|generation|revision/)
    expect(service.restore(workspace)).toBe(false)
    expect(service.get(id(2))?.lifecycle.state).toBe('connected')
  })

  it('publishes immutable snapshots detached from callers and preserves old snapshots', () => {
    const service = fixture(), before = service.getSnapshot(), original = record(2)
    service.add(original)
    expect(service.get(id(2))).not.toBe(original)
    expect(Object.isFrozen(service.get(id(2)))).toBe(true)
    expect(Object.isFrozen(service.get(id(2))?.options)).toBe(true)
    expect(Object.isFrozen(service.get(id(2))?.details)).toBe(true)
    expect(Object.isFrozen(service.get(id(2))?.lifecycle)).toBe(true)
    expect(Object.isFrozen(service.getSnapshot())).toBe(true)
    expect(before).toHaveLength(1)
    expect(before[0].lifecycle.state).toBe('disconnected')
    expect(service.add(record())).toBe(false)
  })

  it('joins a pending attempt and allows detail changes without invalidating authentication', () => {
    const service = fixture(), operation = service.beginConnect(id(1), 1, id(10))!
    expect(service.beginConnect(id(1), 1, id(11))).toBe(operation)
    service.setDetails(id(1), { displayName: 'Reporting', autoReconnect: 'off' })
    expect(service.completeConnect(operation, handle(), authentication)).toEqual({ status: 'accepted' })
    expect(service.get(id(1))?.details.displayName).toBe('Reporting')
    expect(service.beginConnect(id(1), 1, id(12))).toBeUndefined()
  })

  it('rejects a successful cancelled attempt and keeps explicit disconnect intent through future loss', () => {
    const service = fixture(), operation = service.beginConnect(id(1), 1, id(10))!
    expect(service.cancelConnect(id(1))).toBe(true)
    expect(service.get(id(1))?.resumeWanted).toBe(false)
    expect(service.completeConnect(operation, handle(), authentication)).toEqual({ status: 'stale', dispose: handle() })
    expect(service.failConnect(operation, 'network')).toBe(false)
    service.markLostBefore(2)
    expect(service.get(id(1))?.lifecycle).toEqual({ state: 'disconnected', reason: 'cancelled' })
    expect(service.get(id(1))?.resumeWanted).toBe(false)
  })

  it('uses operation epochs even when the caller reuses an attempt UUID and a target is restored', () => {
    const service = fixture(), old = service.beginConnect(id(1), 1, id(10))!
    service.cancelConnect(id(1))
    service.restore({ version: 1, targets: [record()] })
    const current = service.beginConnect(id(1), 1, id(10))!
    expect(current.revision).toBeGreaterThan(old.revision)
    expect(service.completeConnect(old, handle(), authentication)).toEqual({ status: 'stale', dispose: handle() })
    expect(service.completeConnect(current, handle(51), authentication)).toEqual({ status: 'accepted' })
  })

  it('leaves failed startup targets resumable but cannot accept a handle from another generation', () => {
    const service = fixture(), operation = service.beginConnect(id(1), 1, id(10))!
    expect(service.completeConnect(operation, handle(50, 2), authentication)).toEqual({ status: 'stale', dispose: handle(50, 2) })
    expect(service.failConnect(operation, 'credentials-required')).toBe(true)
    expect(service.get(id(1))?.resumeWanted).toBe(true)
    expect(service.get(id(1))?.lifecycle).toEqual({ state: 'disconnected', reason: 'credentials-required' })
  })

  it('invalidates pending and live handles on backend loss without reviving intentional disconnects', () => {
    const service = connected()
    service.add(record(2))
    const pending = service.beginConnect(id(2), 1, id(20))!
    service.markLostBefore(2)
    expect(service.getSnapshot().every(target => target.lifecycle.state === 'lost' && target.resumeWanted)).toBe(true)
    expect(service.completeConnect(pending, handle(52), authentication)).toEqual({ status: 'stale', dispose: handle(52) })
    expect(service.beginConnect(id(2), 1, id(21))).toBeUndefined()
    service.markLostBefore(1)
    const retry = service.beginConnect(id(2), 2, id(22))!
    expect(service.completeConnect(retry, handle(53, 2), authentication)).toEqual({ status: 'accepted' })
  })

  it('retains a hidden target referenced by a disconnected query and reveals it on explicit reconnect', () => {
    const service = fixture(), pending = service.beginConnect(id(1), 1, id(10))!
    expect(service.removeFromExplorer(id(1))).toBe(true)
    expect(service.get(id(1))).toMatchObject({ inExplorer: false, resumeWanted: false })
    expect(service.completeConnect(pending, handle(), authentication)).toEqual({ status: 'stale', dispose: handle() })
    expect(service.pruneUnreferenced(new Set([id(1)]))).toEqual([])
    expect(service.beginConnect(id(1), 1, id(11))).toBeDefined()
    expect(service.get(id(1))).toMatchObject({ inExplorer: true, resumeWanted: true })
    service.cancelConnect(id(1))
    service.removeFromExplorer(id(1))
    expect(service.pruneUnreferenced(new Set())).toEqual([id(1)])
    expect(service.getSnapshot()).toEqual([])
  })

  it('disconnects only after preflight intent and retains the root, including failure and backend-loss paths', () => {
    const service = connected(), before = service.getSnapshot()
    expect(service.removeFromExplorer(id(1))).toBe(false)
    expect(service.getSnapshot()).toBe(before)
    const first = service.beginDisconnect(id(1), id(30))!
    expect(service.get(id(1))).toMatchObject({ inExplorer: true, resumeWanted: false, lifecycle: { state: 'disconnecting' } })
    expect(service.failDisconnect(first)).toBe(true)
    expect(service.get(id(1))?.lifecycle.state).toBe('connected')
    const second = service.beginDisconnect(id(1), id(31))!
    expect(service.completeDisconnect(first)).toBe(false)
    expect(service.completeDisconnect(second)).toBe(true)
    expect(service.get(id(1))).toMatchObject({ inExplorer: true, resumeWanted: false, lifecycle: { state: 'disconnected' } })
    const reconnect = service.beginConnect(id(1), 1, id(32))!
    service.completeConnect(reconnect, handle(54), authentication)
    const interrupted = service.beginDisconnect(id(1), id(33))!
    service.markLostBefore(2)
    expect(service.completeDisconnect(interrupted)).toBe(false)
    expect(service.get(id(1))).toMatchObject({ resumeWanted: false, lifecycle: { state: 'lost' } })
  })

  it('does not publish unknown targets or invalid backend generations, and rejects invalid snapshot payloads', () => {
    const service = fixture(), listener = vi.fn()
    service.subscribe(listener)
    expect(service.beginConnect(id(99), 1, id(10))).toBeUndefined()
    expect(service.beginConnect(id(1), Infinity, id(10))).toBeUndefined()
    expect(service.reveal(id(99))).toBe(false)
    expect(service.removeFromExplorer(id(99))).toBe(false)
    expect(service.setDetails(id(99), { autoReconnect: 'inherit' })).toBe(false)
    service.markLostBefore(NaN)
    expect(listener).not.toHaveBeenCalled()
    expect(() => service.restore({ version: 1, targets: [{ ...record(), password: 'secret' }] } as unknown as ConnectionWorkspace)).toThrow()
  })

  it('does not dispose a joined completion or a handle another target already owns', () => {
    const service = fixture(), operation = service.beginConnect(id(1), 1, id(10))!
    const joined = service.beginConnect(id(1), 1, id(11))!
    service.completeConnect(operation, handle(), authentication)
    const before = service.getSnapshot()
    expect(service.completeConnect(joined, handle(), authentication)).toEqual({ status: 'already-current' })
    expect(service.getSnapshot()).toBe(before)
    service.add(record(2))
    const other = service.beginConnect(id(2), 1, id(12))!
    expect(service.completeConnect(other, handle(), authentication)).toEqual({ status: 'in-use', targetId: id(1) })
    expect(service.get(id(2))?.lifecycle.state).toBe('connecting')
    const disconnect = service.beginDisconnect(id(1), id(13))!
    expect(service.completeConnect(joined, handle(), authentication)).toEqual({ status: 'already-current' })
    expect(service.completeDisconnect(disconnect)).toBe(true)
  })

  it('binds the first verified principal and rejects changing an existing expected account', () => {
    const { expectedPrincipal: _expected, ...unresolved } = record()
    const service = fixture(unresolved), first = service.beginConnect(id(1), 1, id(10))!
    expect(service.completeConnect(first, handle(), authentication)).toEqual({ status: 'accepted' })
    expect(service.get(id(1))?.expectedPrincipal).toEqual(authentication.principal)
    service.markLostBefore(2)
    const changed = service.beginConnect(id(1), 2, id(11), 'update-credentials')!
    const different: ConnectionAuthentication = { principal: { ...authentication.principal, id: 'different-account' } }
    expect(service.completeConnect(changed, handle(51, 2), different)).toEqual({ status: 'rejected', reason: 'identity-changed', dispose: handle(51, 2) })
    expect(service.get(id(1))).toMatchObject({ expectedPrincipal: authentication.principal, lifecycle: { state: 'disconnected', reason: 'identity-changed' } })
  })

  it('preserves credential revisions unless the operation explicitly updates credentials as the same principal', () => {
    const original = { profileId: id(200), revision: id(201) }, next = { profileId: id(200), revision: id(202) }
    const service = fixture({ ...record(), credential: original })
    const ordinary = service.beginConnect(id(1), 1, id(10))!
    expect(service.beginConnect(id(1), 1, id(11), 'update-credentials')).toBeUndefined()
    expect(service.completeConnect(ordinary, handle(), { ...authentication, credential: next })).toEqual({ status: 'rejected', reason: 'credentials-required', dispose: handle() })
    expect(service.get(id(1))?.credential).toEqual(original)
    const update = service.beginConnect(id(1), 1, id(12), 'update-credentials')!
    expect(service.completeConnect(update, handle(51), { ...authentication, credential: next })).toEqual({ status: 'accepted' })
    expect(service.get(id(1))?.credential).toEqual(next)
    service.markLostBefore(2)
    const keep = service.beginConnect(id(1), 2, id(13))!
    expect(service.completeConnect(keep, handle(52, 2), authentication)).toEqual({ status: 'accepted' })
    expect(service.get(id(1))?.credential).toEqual(next)
    service.markLostBefore(3)
    const clear = service.beginConnect(id(1), 3, id(14), 'update-credentials')!
    expect(service.completeConnect(clear, handle(53, 3), { ...authentication, credential: null })).toEqual({ status: 'accepted' })
    expect(service.get(id(1))?.credential).toBeUndefined()
  })

  it('validates completion and failure data without corrupting pending state or applying stale authentication', () => {
    const service = fixture(), operation = service.beginConnect(id(1), 1, id(10))!
    expect(() => service.failConnect(operation, 'invalid' as never)).toThrow()
    expect(service.operation(id(1))).toBe(operation)
    expect(service.get(id(1))?.lifecycle.state).toBe('connecting')
    service.cancelConnect(id(1))
    expect(service.completeConnect(operation, handle(), { principal: { ...authentication.principal, id: 'other' } })).toEqual({ status: 'stale', dispose: handle() })
    expect(service.get(id(1))?.expectedPrincipal).toEqual(authentication.principal)
    const retry = service.beginConnect(id(1), 1, id(11))!
    expect(service.completeConnect(retry, handle(), { ...authentication, accessToken: 'never-keep' } as ConnectionAuthentication)).toEqual({ status: 'rejected', reason: 'unknown', dispose: handle() })
    expect(service.get(id(1))?.expectedPrincipal).toEqual(authentication.principal)
  })

  it('marks only an authoritatively lost exact handle and preserves its existing resume intent', () => {
    const service = connected()
    service.add(record(2))
    const other = service.beginConnect(id(2), 1, id(20))!
    service.completeConnect(other, handle(51), authentication)
    expect(service.markHandleLost(handle(50, 2))).toBe(false)
    expect(service.get(id(1))?.lifecycle.state).toBe('connected')
    expect(service.markHandleLost(handle(), 'network')).toBe(true)
    expect(service.get(id(1))).toMatchObject({ resumeWanted: true, lifecycle: { state: 'lost', reason: 'network' } })
    expect(service.get(id(2))?.lifecycle.state).toBe('connected')
    const disconnect = service.beginDisconnect(id(2), id(21))!
    expect(service.markHandleLost(handle(51))).toBe(true)
    expect(service.get(id(2))?.resumeWanted).toBe(false)
    expect(service.completeDisconnect(disconnect)).toBe(false)
  })

  it('reconciles only a main-proven credential reference for the same live handle and established principal', () => {
    const service = connected(), reference = { profileId: id(200), revision: id(201) }
    const before = service.getSnapshot()
    expect(service.reconcileAuthentication(handle(50, 2), { ...authentication, credential: reference })).toBe(false)
    expect(service.reconcileAuthentication(handle(), { principal: { ...authentication.principal, id: 'other' }, credential: reference })).toBe(false)
    expect(service.getSnapshot()).toBe(before)
    expect(service.reconcileAuthentication(handle(), { ...authentication, credential: reference })).toBe(true)
    expect(service.get(id(1))?.credential).toEqual(reference)
    expect(before[0].credential).toBeUndefined()
    expect(service.reconcileAuthentication(handle(), authentication)).toBe(true)
    expect(service.get(id(1))?.credential).toEqual(reference)
    expect(service.reconcileAuthentication(handle(), { ...authentication, credential: null })).toBe(true)
    expect(service.get(id(1))?.credential).toBeUndefined()
    service.beginDisconnect(id(1), id(20))
    expect(service.reconcileAuthentication(handle(), { ...authentication, credential: reference })).toBe(false)
  })
})
