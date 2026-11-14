import { describe, expect, it } from 'vitest'
import { connectionTargetOptions, type PersistedConnectionTarget } from '../src/shared/connection-targets'
import { bindStartupReconnect } from '../src/renderer/src/services/connection-startup'
import { deferred } from './fixtures/documents'
import { connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const target = (): PersistedConnectionTarget => ({ id: id(1), options: connectionTargetOptions(connectionOptions), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' }, credential: { profileId: id(200), revision: id(201) } })
function fixture(records: readonly PersistedConnectionTarget[] = [target()]) {
  const value = workbenchFixture(), ready = deferred<void>()
  value.connectionTargets.restore({ version: 1, targets: records })
  value.api.connect.mockImplementation(async (_options, context) => ({ ok: true, value: { id: id(50), targetId: context!.targetId, generation: 1, server: 'server.example', database: 'master', serverVersion: '17', authentication: { principal: target().expectedPrincipal!, credential: target().credential } } }))
  const binding = bindStartupReconnect({ ...value, api: value.api, ready: ready.promise })
  return { ...value, ready, binding, dispose: () => { binding.dispose(); value.dispose() } }
}

describe('workbench startup connection owner', () => {
  it('waits for restore, valid settings and backend-ready, then attaches only wanted queries without execution', async () => {
    const value = fixture()
    try {
      const wanted = value.documents.create('wanted.sql', 'SELECT 1', 'Sales')
      const detached = value.documents.create('detached.sql', 'SELECT 2', 'Archive')
      value.documents.update(wanted.id, { targetId: id(1), attachWanted: true })
      value.documents.update(detached.id, { targetId: id(1), attachWanted: false })
      value.api.push(readyBackend(1))
      await value.settings.load()
      expect(value.api.connect).not.toHaveBeenCalled()
      value.ready.resolve()
      await Promise.resolve()
      await value.binding.scheduler.whenIdle()
      expect(value.api.connect).toHaveBeenCalledTimes(1)
      expect(value.api.connect.mock.calls[0][1]).toMatchObject({ mode: 'background', targetId: id(1), credentialPolicy: 'preserve', credentialIntent: 'preserve' })
      expect(value.documents.get(wanted.id)).toMatchObject({ connectionId: id(50), database: 'Sales', attachWanted: true })
      expect(value.documents.get(detached.id)).toMatchObject({ connectionId: undefined, database: 'Archive', attachWanted: false })
      expect(value.api.execute).not.toHaveBeenCalled()
      value.api.push({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'exit', connections: 1, queries: 0 } })
      value.api.push(readyBackend(2))
      await value.binding.scheduler.whenIdle()
      expect(value.api.connect).toHaveBeenCalledTimes(1)
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(true)
    } finally { value.dispose() }
  })

  it('fails closed for unreadable settings while leaving manual connection readiness independent', async () => {
    const value = fixture()
    try {
      value.api.getSettings.mockResolvedValue({ ok: false, error: 'Settings unavailable.' })
      value.api.push(readyBackend(1))
      value.ready.resolve()
      await value.settings.load()
      await Promise.resolve()
      expect(value.api.connect).not.toHaveBeenCalled()
      expect(value.connectionTargets.get(id(1))?.lifecycle.state).toBe('disconnected')
      const manual = value.binding.scheduler.beginManual()
      expect(value.connections.beginConnect(connectionOptions, 1, id(1))).toBeDefined()
      manual.dispose()
    } finally { value.dispose() }
  })

  it('invalidates a preempted background token synchronously and never accepts its late receipt over manual work', async () => {
    const value = fixture(), pending = deferred<Awaited<ReturnType<typeof value.api.connect>>>()
    try {
      value.api.connect.mockImplementation(() => pending.promise)
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await Promise.resolve()
      const background = value.connectionTargets.operation(id(1))!
      expect(background).toBeDefined()
      const foreground = value.binding.scheduler.beginManual()
      expect(value.connectionTargets.operation(id(1))).toBeUndefined()
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(true)
      const manual = value.connections.beginConnect(connectionOptions, 1, id(1))!
      pending.resolve({ ok: true, value: { id: id(51), targetId: id(1), generation: 1, server: 'server.example', database: 'master', serverVersion: '17', authentication: { principal: target().expectedPrincipal! } } })
      foreground.dispose()
      await value.binding.scheduler.whenIdle()
      expect(value.connectionTargets.operation(id(1))).toBe(manual.operation)
      expect(value.api.acceptConnectionRequest).not.toHaveBeenCalled()
      expect(value.api.cancelConnectionRequests).toHaveBeenCalled()
    } finally { value.dispose() }
  })

  it('defers receipts and queued servers across a busy document task, then attaches every wanted query once', async () => {
    const records = [1, 2, 3, 4, 5].map(index => ({ ...target(), id: id(index), options: { ...target().options, server: `server-${index}.example` } }))
    const value = fixture(records), busy = deferred<void>()
    type ConnectResult = Awaited<ReturnType<typeof value.api.connect>>
    const replies: ReturnType<typeof deferred<ConnectResult>>[] = []
    try {
      const wanted = records.map(record => {
        const document = value.documents.create(`wanted-${record.id}.sql`, 'SELECT 1', 'Sales')
        value.documents.update(document.id, { targetId: record.id, attachWanted: true })
        return document.id
      })
      value.api.connect.mockImplementation(() => {
        const reply = deferred<Awaited<ReturnType<typeof value.api.connect>>>()
        replies.push(reply)
        return reply.promise
      })
      const complete = (index: number) => replies[index].resolve({ ok: true, value: {
        id: id(50 + index), targetId: value.api.connect.mock.calls[index][1]!.targetId, generation: 1,
        server: 'server.example', database: 'master', serverVersion: '17', authentication: { principal: target().expectedPrincipal!, credential: target().credential }
      } })
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await Promise.resolve()
      expect(replies).toHaveLength(2)
      const task = value.documents.runTask(() => busy.promise)
      complete(0)
      complete(1)
      await Promise.resolve()
      await Promise.resolve()
      expect(value.api.acceptConnectionRequest).not.toHaveBeenCalled()
      expect(value.api.connect).toHaveBeenCalledTimes(2)
      expect(wanted.every(document => !value.documents.get(document)?.connectionId)).toBe(true)
      busy.resolve()
      await task
      await expect.poll(() => replies.length).toBe(4)
      complete(2)
      complete(3)
      await expect.poll(() => replies.length).toBe(5)
      complete(4)
      await value.binding.scheduler.whenIdle()
      expect(value.api.connect).toHaveBeenCalledTimes(5)
      expect(value.api.acceptConnectionRequest).toHaveBeenCalledTimes(5)
      expect(wanted.map(document => value.documents.get(document)?.connectionId)).toEqual(records.map(record =>
        id(50 + value.api.connect.mock.calls.findIndex(([_options, context]) => context!.targetId === record.id))))
      expect(value.api.cancelConnectionRequests).not.toHaveBeenCalled()
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { busy.resolve(); value.dispose() }
  })

  it.each(['global policy', 'target policy', 'credential reference'] as const)('completes accepted attachment despite %s changes, manual priority and a busy document task', async change => {
    const value = fixture(), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>(), busy = deferred<void>()
    try {
      const wanted = value.documents.create('wanted.sql', 'SELECT 1', 'Sales')
      value.documents.update(wanted.id, { targetId: id(1), attachWanted: true })
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await expect.poll(() => value.api.acceptConnectionRequest.mock.calls.length).toBe(1)
      expect(value.connectionTargets.get(id(1))?.lifecycle.state).toBe('connected')
      const task = value.documents.runTask(() => busy.promise), foreground = value.binding.scheduler.beginManual()
      if (change === 'global policy') await value.settings.update({ 'environment.connections.autoReconnect': false })
      else if (change === 'target policy') value.connectionTargets.setDetails(id(1), { autoReconnect: 'off' })
      else expect(value.connectionTargets.reconcileAuthentication({ id: id(50), generation: 1 }, { principal: target().expectedPrincipal!, credential: { ...target().credential!, revision: id(202) } })).toBe(true)
      accepted.resolve({ ok: true, value: { accepted: true, retained: true } })
      await Promise.resolve()
      await Promise.resolve()
      expect(value.documents.get(wanted.id)?.connectionId).toBeUndefined()
      expect(value.api.cancelConnectionRequests).not.toHaveBeenCalled()
      busy.resolve()
      await task
      await value.binding.scheduler.whenIdle()
      expect(value.documents.get(wanted.id)).toMatchObject({ connectionId: id(50), database: 'Sales', attachWanted: true })
      foreground.dispose()
      expect(value.api.connect).toHaveBeenCalledTimes(1)
    } finally { accepted.resolve({ ok: true, value: { accepted: true, retained: true } }); busy.resolve(); value.dispose() }
  })

  it.each(['SQL_ERROR', 'CONNECTION_LOST'] as const)('does not retry a completed %s failure whose reply was preempted by manual work', async code => {
    const value = fixture(), reply = deferred<Awaited<ReturnType<typeof value.api.connect>>>()
    try {
      value.api.connect.mockImplementation(() => reply.promise)
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await Promise.resolve()
      reply.resolve({ ok: false, error: 'The database or transport is unavailable.', code, ...code === 'SQL_ERROR' ? { details: { number: 4060, state: 1, class: 11 } } : {} })
      const foreground = value.binding.scheduler.beginManual()
      foreground.dispose()
      await value.binding.scheduler.whenIdle()
      expect(value.api.connect).toHaveBeenCalledTimes(1)
      expect(value.api.acceptConnectionRequest).not.toHaveBeenCalled()
    } finally { reply.resolve({ ok: false, error: 'Cancelled.', code: 'CANCELLED' }); value.dispose() }
  })

  it.each([false, true])('redirects accepted startup work to its canonical target while busy, respecting source removal=%s', async removeSource => {
    const value = fixture([target(), { ...target(), id: id(2) }]), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>(), busy = deferred<void>()
    try {
      const wanted = value.documents.create('source-wanted.sql', 'SELECT 1', 'Sales')
      value.documents.update(wanted.id, { targetId: id(1), attachWanted: true })
      const canonical = { id: id(60), generation: 1, server: 'server.example', database: 'master', serverVersion: '17', targetId: id(2),
        authentication: { principal: target().expectedPrincipal!, credential: target().credential } }
      const manual = value.connections.beginConnect(connectionOptions, 1, id(2))!
      expect(value.connections.accept(canonical, connectionOptions, id(2), canonical.authentication, manual)).toEqual({ status: 'accepted' })
      value.api.connect.mockResolvedValue({ ok: true, value: canonical })
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await expect.poll(() => value.api.acceptConnectionRequest.mock.calls.length).toBe(1)
      expect(value.connectionTargets.get(id(1))?.lifecycle.state).toBe('disconnected')
      expect(value.documents.get(wanted.id)?.targetId).toBe(id(1))
      const task = value.documents.runTask(() => busy.promise)
      if (removeSource) expect(value.connectionTargets.removeFromExplorer(id(1))).toBe(true)
      accepted.resolve({ ok: true, value: { accepted: true, retained: true } })
      await Promise.resolve()
      expect(value.documents.get(wanted.id)?.connectionId).toBeUndefined()
      busy.resolve()
      await task
      await value.binding.scheduler.whenIdle()
      if (removeSource) {
        expect(value.documents.get(wanted.id)).toMatchObject({ targetId: id(1), connectionId: undefined, attachWanted: true })
        expect(value.api.cancelConnectionRequests).toHaveBeenCalledTimes(1)
      } else {
        expect(value.documents.get(wanted.id)).toMatchObject({ targetId: id(2), connectionId: id(60), database: 'Sales', attachWanted: true })
        expect(value.connectionTargets.get(id(1))?.inExplorer).toBeFalsy()
        expect(value.api.cancelConnectionRequests).not.toHaveBeenCalled()
      }
      expect(value.connections.isLive(id(60))).toBe(true)
      expect(value.api.connect).toHaveBeenCalledTimes(1)
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { accepted.resolve({ ok: true, value: { accepted: true, retained: true } }); busy.resolve(); value.dispose() }
  })

  it('respects explicit disconnect while an adopted receipt waits for acceptance', async () => {
    const value = fixture(), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>()
    try {
      const wanted = value.documents.create('wanted.sql', 'SELECT 1', 'Sales')
      value.documents.update(wanted.id, { targetId: id(1), attachWanted: true })
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await expect.poll(() => value.api.acceptConnectionRequest.mock.calls.length).toBe(1)
      const disconnect = value.connectionTargets.beginDisconnect(id(1), id(300))!
      value.connectionTargets.completeDisconnect(disconnect)
      accepted.resolve({ ok: true, value: { accepted: true, retained: true } })
      await value.binding.scheduler.whenIdle()
      expect(value.documents.get(wanted.id)?.connectionId).toBeUndefined()
      expect(value.connectionTargets.get(id(1))).toMatchObject({ resumeWanted: false, lifecycle: { state: 'disconnected' } })
      expect(value.api.cancelConnectionRequests).toHaveBeenCalledTimes(1)
      expect(value.api.connect).toHaveBeenCalledTimes(1)
    } finally { accepted.resolve({ ok: true, value: { accepted: true, retained: true } }); value.dispose() }
  })

  it('lets a failed manual reconnect supersede its exact target while unrelated interrupted servers resume', async () => {
    const records = [1, 2, 3].map(index => ({ ...target(), id: id(index), options: { ...target().options, server: `server-${index}.example` } }))
    const value = fixture(records)
    type ConnectResult = Awaited<ReturnType<typeof value.api.connect>>
    const first = deferred<ConnectResult>(), second = deferred<ConnectResult>()
    try {
      const wanted = records.map(record => {
        const document = value.documents.create(`wanted-${record.id}.sql`, 'SELECT 1', 'Sales')
        value.documents.update(document.id, { targetId: record.id, attachWanted: true })
        return document.id
      })
      const calls = new Map<string, number>()
      const result = (targetId: string, handle: number): ConnectResult => ({ ok: true, value: {
        id: id(handle), targetId, generation: 1, server: 'server.example', database: 'master', serverVersion: '17',
        authentication: { principal: target().expectedPrincipal!, credential: target().credential }
      } })
      value.api.connect.mockImplementation(async (_options, context) => {
        const targetId = context!.targetId!, count = (calls.get(targetId) ?? 0) + 1
        calls.set(targetId, count)
        if (targetId === id(1)) return first.promise
        if (targetId === id(2) && count === 1) return second.promise
        return result(targetId, targetId === id(2) ? 52 : 53)
      })
      value.api.push(readyBackend(1))
      await value.settings.load()
      value.ready.resolve()
      await Promise.resolve()
      expect(calls.get(id(1))).toBe(1)
      expect(calls.get(id(2))).toBe(1)
      const foreground = value.binding.scheduler.beginManual()
      // ConnectDialog hands only the selected exact target to the manual attempt.
      value.binding.scheduler.cancel(id(1))
      const manual = value.connections.beginConnect({ ...connectionOptions, server: records[0].options.server }, 1, id(1))!
      value.connections.failAttempt(manual, 'credentials-required')
      first.resolve(result(id(1), 50))
      second.resolve(result(id(2), 51))
      foreground.dispose()
      await value.binding.scheduler.whenIdle()
      expect(calls).toEqual(new Map([[id(2), 2], [id(1), 1], [id(3), 1]]))
      expect(value.connectionTargets.get(id(1))).toMatchObject({ resumeWanted: true, lifecycle: { state: 'disconnected', reason: 'credentials-required' } })
      expect(value.documents.get(wanted[0])?.connectionId).toBeUndefined()
      expect(value.documents.get(wanted[1])?.connectionId).toBe(id(52))
      expect(value.documents.get(wanted[2])?.connectionId).toBe(id(53))
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { first.resolve({ ok: false, error: 'Cancelled.' }); second.resolve({ ok: false, error: 'Cancelled.' }); value.dispose() }
  })
})
