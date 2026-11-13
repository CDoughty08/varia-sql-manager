import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionBindingsChanged } from '../src/shared/connection-bindings'
import { keptSession } from '../src/renderer/src/services/session'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const principal = { provider: 'sqlServer' as const, authentication: 'sql' as const, id: 'sid:reader' }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture() {
  const f = workbenchFixture(), targetId = id(1), handle = id(50)
  cleanups.push(f.dispose)
  f.api.push(readyBackend(1))
  const accept = (target: string, connection: string, account = principal) => {
    const attempt = f.connections.beginConnect(connectionOptions, 1, target)!
    expect(f.connections.accept(connectionInfo(connection), connectionOptions, target, { principal: account }, attempt).status).toBe('accepted')
  }
  accept(targetId, handle)
  const change = (revision: number, database = 'Renamed'): ConnectionBindingsChanged['changes'][number] => ({ targetId, handle: { id: handle, generation: 1 }, revision,
    options: { ...f.connectionTargets.get(targetId)!.options, database }, authentication: { principal, credential: { profileId: id(200), revision: id(201) } } })
  const push = (...changes: ConnectionBindingsChanged['changes']) => f.api.pushConnectionBindings({ generation: 1, changes })
  return { ...f, targetId, handle, accept, change, push }
}

describe('authoritative runtime connection bindings', () => {
  it('updates only the current target settings and credential reference atomically, without changing query/database associations', () => {
    const f = fixture()
    f.accept(id(2), id(51), { ...principal, id: 'sid:other-account' })
    f.connectionTargets.setDetails(f.targetId, { displayName: 'Kept label', autoReconnect: 'off' })
    const query = f.documents.create('Kept.sql', 'SELECT 1', 'Archive', f.handle)
    const documents = f.documents.getSnapshot(), other = f.connectionTargets.get(id(2))
    const checkpoint = keptSession(f.documents, connection => f.connections.get(connection)?.server, { connectionTargets: f.connectionTargets })
    const published: unknown[] = []
    const stop = f.connectionTargets.subscribe(() => published.push(f.connectionTargets.get(f.targetId)))
    f.push(f.change(2))
    stop()
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ options: { database: 'Renamed' }, credential: { profileId: id(200), revision: id(201) }, details: { displayName: 'Kept label', autoReconnect: 'off' }, lifecycle: { state: 'connected', handle: { id: f.handle, generation: 1 } } })
    expect(f.connectionTargets.get(id(2))).toBe(other)
    expect(f.connections.get(f.targetId)).toMatchObject({ id: f.handle, database: 'Renamed', options: { database: 'Renamed' } })
    expect(f.documents.getSnapshot()).toBe(documents)
    expect(f.documents.get(query.id)).toMatchObject({ connectionId: f.handle, targetId: f.targetId, database: 'Archive' })
    expect(checkpoint.checkpointCurrent()).toBe(false)
    const saved = f.connectionTargets.exportWorkspace()
    expect(saved.targets[0]).toMatchObject({ options: { database: 'Renamed' }, credential: { profileId: id(200), revision: id(201) } })
    expect(JSON.stringify(saved)).not.toMatch(/password|bindingRevision|lifecycle|never-keep/)
    expect(f.api.execute).not.toHaveBeenCalled()
  })

  it('ignores older revisions, wrong accounts, handles, generations and transport settings, while a valid higher null reference clears storage intent', () => {
    const f = fixture()
    f.push(f.change(2))
    const before = f.connectionTargets.getSnapshot()
    f.push(f.change(1, 'Old'), { ...f.change(3), authentication: { principal: { ...principal, id: 'sid:another' }, credential: null } }, { ...f.change(3), targetId: id(2) }, { ...f.change(3), handle: { id: id(99), generation: 1 } }, { ...f.change(3), options: { ...f.change(3).options, server: 'different-endpoint' } })
    f.api.pushConnectionBindings({ generation: 2, changes: [{ ...f.change(3), handle: { id: f.handle, generation: 2 } }] })
    expect(f.connectionTargets.getSnapshot()).toBe(before)
    f.push({ ...f.change(3), authentication: { principal, credential: null } })
    expect(f.connectionTargets.get(f.targetId)?.credential).toBeUndefined()
    expect(f.connectionTargets.get(f.targetId)?.options.database).toBe('Renamed')
  })

  it('preserves disconnect operations and resets ordering for a fresh handle, never applying the old handle late', () => {
    const f = fixture()
    f.push(f.change(50))
    const disconnect = f.connectionTargets.beginDisconnect(f.targetId, id(60))!
    f.push({ ...f.change(51, 'Confirmed rename'), authentication: { principal, credential: null } })
    expect(f.connectionTargets.operation(f.targetId)).toBe(disconnect)
    expect(f.connectionTargets.completeDisconnect(disconnect)).toBe(true)
    expect(f.connectionTargets.get(f.targetId)).toMatchObject({ resumeWanted: false, options: { database: 'Confirmed rename' }, lifecycle: { state: 'disconnected' } })
    f.accept(f.targetId, id(52))
    const fresh = { ...f.change(1, 'Fresh'), handle: { id: id(52), generation: 1 }, authentication: { principal, credential: null } }
    f.push(fresh)
    expect(f.connectionTargets.get(f.targetId)?.options.database).toBe('Fresh')
    f.push(f.change(999, 'Stale'))
    expect(f.connectionTargets.get(f.targetId)?.options.database).toBe('Fresh')
  })

  it('rejects invalid event payloads and releases the single workbench subscription on dispose', () => {
    const f = fixture(), before = f.connectionTargets.getSnapshot()
    f.api.pushConnectionBindings({ generation: 1, changes: [{ ...f.change(1), password: 'must-not-enter-renderer-state' }] } as unknown as ConnectionBindingsChanged)
    expect(f.connectionTargets.getSnapshot()).toBe(before)
    expect(f.api.onConnectionBindingsChanged).toHaveBeenCalledOnce()
    const receive = vi.spyOn(f.connections, 'bindingsChanged')
    const update = { generation: 1, changes: [f.change(1)] }
    f.dispose()
    f.api.pushConnectionBindings(update)
    expect(receive).not.toHaveBeenCalled()
  })

  it('shows a confirmed credential-storage warning through the existing banner, and ignores stale warning events', () => {
    const f = fixture(), warning = 'The password changed, but its remembered copy could not be updated. Enter the new password when reconnecting.'
    const update = { generation: 1, warning, changes: [{ ...f.change(1), authentication: { principal, credential: null } }] }
    f.api.pushConnectionBindings(update)
    expect(f.commands.getSnapshot()).toEqual({ error: warning, kind: 'warning' })
    expect(f.connectionTargets.get(f.targetId)?.credential).toBeUndefined()
    f.commands.clearError()
    f.api.pushConnectionBindings(update)
    expect(f.commands.getSnapshot().error).toBe('')
  })
})
