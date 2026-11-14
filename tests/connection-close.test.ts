import { describe, expect, it, vi } from 'vitest'
import { connectionTargetOptions, type PersistedConnectionTarget } from '../src/shared/connection-targets'
import { deferred } from './fixtures/documents'
import { connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const principal = { provider: 'sqlServer' as const, authentication: 'sql' as const, id: 'reader' }
const record = (value: number): PersistedConnectionTarget => ({ id: id(value), options: connectionTargetOptions(connectionOptions), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: principal, credential: { profileId: id(200), revision: id(201) } })

async function fixture(records = [record(1)]) {
  const ready = deferred<void>(), value = workbenchFixture({ startupReady: ready.promise })
  value.api.hotExit = true
  value.connectionTargets.restore({ version: 1, targets: records })
  value.api.connect.mockImplementation(async (_options, context) => ({ ok: true, value: {
    id: id(50), targetId: context!.targetId, generation: 1, server: 'server.example', database: 'master', serverVersion: '17',
    authentication: { principal, credential: record(1).credential }
  } }))
  const query = value.documents.create('restored.sql', 'SELECT 1', 'Sales', undefined, true)
  value.documents.update(query.id, { targetId: id(1), attachWanted: true })
  await value.settings.load()
  const start = () => { value.api.push(readyBackend(1)); ready.resolve() }
  const close = () => value.commands.execute('window.close', undefined, 'menu')
  return { ...value, query, start, close }
}

describe('closing across startup reconnect', () => {
  it('drains cancellation before taking the document lock and holds admission through a shared close and approved exit', async () => {
    const value = await fixture(), reply = deferred<Awaited<ReturnType<typeof value.api.connect>>>()
    const drained = deferred<Awaited<ReturnType<typeof value.api.cancelConnectionRequests>>>()
    const writing = deferred<void>(), written = deferred<void>()
    try {
      value.api.connect.mockImplementationOnce(() => reply.promise)
      value.api.cancelConnectionRequests.mockImplementationOnce(() => drained.promise)
      value.api.keepSession.mockImplementation(async () => { writing.resolve(); await written.promise; return { ok: true, value: undefined } })
      value.start()
      await expect.poll(() => value.api.connect.mock.calls.length).toBe(1)
      const first = value.close(), second = value.close()
      expect(value.api.cancelConnectionRequests).toHaveBeenCalledTimes(1)
      reply.resolve({ ok: false, error: 'Cancelled.', code: 'CANCELLED' })
      await Promise.resolve()
      await Promise.resolve()
      expect(value.documents.getSnapshot().busy).toBe(false)
      expect(value.api.keepSession).not.toHaveBeenCalled()
      drained.resolve({ ok: true, value: { cancelled: 1 } })
      await writing.promise
      expect(value.documents.getSnapshot().busy).toBe(true)
      expect(value.api.connect).toHaveBeenCalledTimes(1)
      expect(value.api.keepSession.mock.calls[0][0]).toMatchObject({ documents: [{ targetId: id(1), attachWanted: true, database: 'Sales' }],
        workspace: { targets: [{ id: id(1), inExplorer: true, resumeWanted: true }] } })
      written.resolve()
      await Promise.all([first, second])
      expect(value.api.keepSession).toHaveBeenCalledTimes(1)
      expect(value.api.closeWindow).toHaveBeenCalledTimes(1)
      expect(value.host.flushLayout).toHaveBeenCalledTimes(1)
      expect(value.files.exiting).toBe(true)
      expect(value.api.connect).toHaveBeenCalledTimes(1)
      expect(value.host.layoutCloseCancelled).not.toHaveBeenCalled()
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { reply.resolve({ ok: false, error: 'Cancelled.', code: 'CANCELLED' }); drained.resolve({ ok: true, value: { cancelled: 1 } }); written.resolve(); value.dispose() }
  })

  it.each(['refusal', 'cancel', 'write-error'] as const)('resumes interrupted reconnect intent when close ends with %s', async outcome => {
    const value = await fixture(), reply = deferred<Awaited<ReturnType<typeof value.api.connect>>>()
    try {
      value.api.connect.mockImplementationOnce(() => reply.promise)
      if (outcome === 'refusal') vi.spyOn(value.longRuns, 'closeRefusal').mockReturnValue('Stop the current operation before closing.')
      if (outcome === 'cancel') { value.api.hotExit = false; value.api.confirmClose.mockResolvedValue({ ok: true, value: 'cancel' }) }
      if (outcome === 'write-error') value.api.keepSession.mockResolvedValue({ ok: false, error: 'Session storage unavailable.' })
      value.start()
      await expect.poll(() => value.api.connect.mock.calls.length).toBe(1)
      const closing = value.close()
      reply.resolve({ ok: false, error: 'Cancelled.', code: 'CANCELLED' })
      await closing
      await value.startupReconnect.whenIdle()
      expect(value.files.exiting).toBe(false)
      expect(value.api.closeWindow).not.toHaveBeenCalled()
      expect(value.api.connect).toHaveBeenCalledTimes(2)
      expect(value.connectionTargets.get(id(1))?.resumeWanted).toBe(true)
      expect(value.documents.get(value.query.id)).toMatchObject({ targetId: id(1), database: 'Sales', attachWanted: true })
      expect(value.host.layoutCloseCancelled).toHaveBeenCalledTimes(1)
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { reply.resolve({ ok: false, error: 'Cancelled.', code: 'CANCELLED' }); value.dispose() }
  })

  it('finishes an accepted canonical handoff outside the close task before keeping its query affinity', async () => {
    const value = await fixture([record(1), record(2)]), accepted = deferred<Awaited<ReturnType<typeof value.api.acceptConnectionRequest>>>()
    try {
      const canonical = { id: id(60), generation: 1, server: 'server.example', database: 'master', serverVersion: '17', targetId: id(2),
        authentication: { principal, credential: record(2).credential } }
      const attempt = value.connections.beginConnect(connectionOptions, 1, id(2))!
      expect(value.connections.accept(canonical, connectionOptions, id(2), canonical.authentication, attempt).status).toBe('accepted')
      value.api.connect.mockResolvedValue({ ok: true, value: canonical })
      value.api.acceptConnectionRequest.mockImplementation(() => accepted.promise)
      value.start()
      await expect.poll(() => value.api.acceptConnectionRequest.mock.calls.length).toBe(1)
      const closing = value.close()
      expect(value.documents.getSnapshot().busy).toBe(false)
      expect(value.api.keepSession).not.toHaveBeenCalled()
      expect(value.api.cancelConnectionRequests).not.toHaveBeenCalled()
      accepted.resolve({ ok: true, value: { accepted: true, retained: true } })
      await closing
      expect(value.documents.get(value.query.id)).toMatchObject({ targetId: id(2), connectionId: id(60), database: 'Sales', attachWanted: true })
      expect(value.api.keepSession.mock.calls[0][0]).toMatchObject({ documents: [{ targetId: id(2), attachWanted: true }],
        workspace: { targets: [{ id: id(2), resumeWanted: true }] } })
      expect(value.api.closeWindow).toHaveBeenCalledTimes(1)
      expect(value.files.getSnapshot().error).toBe('')
      expect(() => value.connections.assertCheckpointReady()).not.toThrow()
      expect(value.api.execute).not.toHaveBeenCalled()
    } finally { accepted.resolve({ ok: true, value: { accepted: true, retained: true } }); value.dispose() }
  })
})
