import { describe, expect, it } from 'vitest'
import { connectionTargetOptions, type PersistedConnectionTarget } from '../src/shared/connection-targets'
import { bindStartupReconnect } from '../src/renderer/src/services/connection-startup'
import { deferred } from './fixtures/documents'
import { connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const target = (): PersistedConnectionTarget => ({ id: id(1), options: connectionTargetOptions(connectionOptions), details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' }, credential: { profileId: id(200), revision: id(201) } })
function fixture() {
  const value = workbenchFixture(), ready = deferred<void>()
  value.connectionTargets.restore({ version: 1, targets: [target()] })
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
})
