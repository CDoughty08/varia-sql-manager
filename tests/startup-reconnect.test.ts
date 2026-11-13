import { describe, expect, it } from 'vitest'
import type { ConnectionTarget, PersistedConnectionTarget } from '../src/shared/connection-targets'
import { defaultSettings, settingDef } from '../src/shared/settings/catalog'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { StartupReconnectService, type StartupReconnectAttempt, type StartupReconnectResult } from '../src/renderer/src/services/startup-reconnect'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const record = (value: number, patch: Partial<PersistedConnectionTarget> = {}): PersistedConnectionTarget => ({
  id: id(value), options: { server: 'sql-prod', database: 'Sales', authentication: 'windows', trustServerCertificate: false },
  details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true, ...patch
})
const credential = { profileId: id(90), revision: id(91) }
const saved = (value: number) => record(value, {
  options: { server: 'sql-prod', database: 'Sales', authentication: 'sql', username: 'alex', trustServerCertificate: false }, credential
})
function fixture(records: readonly PersistedConnectionTarget[], globalDefault = () => true) {
  const registry = new ConnectionTargetService()
  registry.restore({ version: 1, targets: records })
  const attempts: { target: ConnectionTarget; request: StartupReconnectAttempt; resolve: (result: StartupReconnectResult) => void; reject: (error: Error) => void }[] = []
  const started = new Map<string, (() => void)[]>()
  const service = new StartupReconnectService(registry, (target, request) => new Promise((resolve, reject) => {
    attempts.push({ target, request, resolve, reject })
    for (const notify of started.get(target.id) ?? []) notify()
  }), globalDefault)
  const next = (value: number) => attempts.some(attempt => attempt.target.id === id(value)) ? Promise.resolve() : new Promise<void>(resolve => started.set(id(value), [...started.get(id(value)) ?? [], resolve]))
  return { registry, service, attempts, next }
}

describe('startup reconnect scheduling', () => {
  it('defaults on and describes the global preference in Options', () => {
    expect(defaultSettings['environment.connections.autoReconnect']).toBe(true)
    expect(settingDef('environment.connections.autoReconnect')).toMatchObject({ page: 'environment.connections', type: 'boolean' })
  })

  it('starts two at a time, retains target order and never retries within one generation', async () => {
    const { service, attempts, next } = fixture([record(1), record(2), record(3), record(4)])
    expect(service.start(1)).toBe(true)
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(1), id(2)])
    expect(attempts[0].request).toMatchObject({ generation: 1, mode: 'background', credentialIntent: 'preserve' })
    attempts[0].reject(new Error('Network unavailable'))
    await next(3)
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(1), id(2), id(3)])
    attempts[1].resolve({})
    await next(4)
    attempts[2].resolve({})
    attempts[3].resolve({})
    await service.whenIdle()
    expect(service.start(1)).toBe(false)
    expect(service.start(0)).toBe(false)
    expect(attempts).toHaveLength(4)
    service.dispose()
  })

  it('applies global and per-target policy without reviving explicit disconnect or removed roots', async () => {
    const { service, attempts } = fixture([
      record(1), record(2, { details: { autoReconnect: 'on' } }), record(3, { details: { autoReconnect: 'off' } }),
      record(4, { resumeWanted: false, details: { autoReconnect: 'on' } }), record(5, { inExplorer: false })
    ], () => false)
    service.start(1)
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(2)])
    attempts[0].resolve({})
    await service.whenIdle()
    service.dispose()
  })

  it('drops removed queued targets and aborts removed active targets immediately', async () => {
    const { registry, service, attempts } = fixture([record(1), record(2), record(3)])
    service.start(1)
    registry.removeFromExplorer(id(1))
    registry.removeFromExplorer(id(3))
    expect(attempts[0].request.signal.aborted).toBe(true)
    expect(attempts[1].request.signal.aborted).toBe(false)
    attempts.forEach(attempt => attempt.resolve({}))
    await service.whenIdle()
    expect(attempts).toHaveLength(2)
    service.dispose()
  })

  it('gives manual attempts priority and resumes only unattempted queued targets', async () => {
    const { service, attempts, next } = fixture([record(1), record(2), record(3)])
    service.start(1)
    const manual = service.beginManual()
    expect(attempts.every(attempt => attempt.request.signal.aborted)).toBe(true)
    attempts.forEach(attempt => attempt.resolve({}))
    // A second manual attempt keeps the queue paused until both have ended.
    const secondManual = service.beginManual()
    manual.dispose()
    expect(attempts).toHaveLength(2)
    secondManual.dispose()
    await next(3)
    attempts[2].resolve({})
    await service.whenIdle()
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(1), id(2), id(3)])
    service.dispose()
  })

  it('blocks a rejected saved-secret revision, cancels its active sibling and continues other credentials', async () => {
    const { service, attempts, next } = fixture([saved(1), saved(2), saved(3), record(4)])
    service.start(1)
    attempts[0].resolve({ credentialRejected: true })
    await next(4)
    expect(attempts[1].request.signal.aborted).toBe(true)
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(1), id(2), id(4)])
    attempts[1].resolve({})
    attempts[2].resolve({})
    await service.whenIdle()
    expect(service.start(2)).toBe(true)
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(1), id(2), id(4), id(4)])
    attempts[3].resolve({})
    await service.whenIdle()
    service.dispose()
  })

  it('does not treat network, storage or TLS failures as saved-secret rejection', async () => {
    const { service, attempts, next } = fixture([saved(1), saved(2), saved(3)])
    service.start(1)
    attempts[0].reject(new Error('Keyring unavailable'))
    await next(3)
    expect(attempts[1].request.signal.aborted).toBe(false)
    attempts[1].resolve({})
    attempts[2].resolve({})
    await service.whenIdle()
    service.dispose()
  })

  it('permits a newly replaced saved-secret revision in a later restore generation', async () => {
    const { registry, service, attempts } = fixture([saved(1)])
    service.start(1)
    attempts[0].resolve({ credentialRejected: true })
    await service.whenIdle()
    registry.restore({ version: 1, targets: [{ ...saved(1), credential: { ...credential, revision: id(92) } }] })
    service.start(2)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].target.credential?.revision).toBe(id(92))
    attempts[1].resolve({})
    await service.whenIdle()
    service.dispose()
  })

  it('skips live or already-pending targets but permits unexpected lost targets', async () => {
    const { registry, service, attempts } = fixture([record(1), record(2)])
    const operation = registry.beginConnect(id(1), 0, id(100))!
    registry.completeConnect(operation, { id: id(101), generation: 0 }, { principal: { provider: 'sqlServer', authentication: 'windows', id: 'DOMAIN\\alex' } })
    registry.beginConnect(id(2), 0, id(102))
    service.start(0)
    expect(attempts).toHaveLength(0)
    registry.markLostBefore(1)
    service.start(1)
    expect(attempts.map(attempt => attempt.target.id)).toEqual([id(1), id(2)])
    attempts.forEach(attempt => attempt.resolve({}))
    await service.whenIdle()
    service.dispose()
  })

  it('cancels a queued target without affecting another target or allowing another pass', async () => {
    const { service, attempts } = fixture([record(1), record(2), record(3)])
    service.start(1)
    service.cancel(id(1))
    service.cancel(id(3))
    expect(attempts[0].request.signal.aborted).toBe(true)
    expect(attempts[1].request.signal.aborted).toBe(false)
    attempts.forEach(attempt => attempt.resolve({}))
    await service.whenIdle()
    expect(service.start(1)).toBe(false)
    expect(attempts).toHaveLength(2)
    service.dispose()
  })

  it('observes global setting changes during an attempt and before starting queued targets', async () => {
    let enabled = true
    const { service, attempts } = fixture([record(1), record(2), record(3)], () => enabled)
    service.start(1)
    enabled = false
    service.refresh()
    expect(attempts.every(attempt => attempt.request.signal.aborted)).toBe(true)
    attempts.forEach(attempt => attempt.resolve({}))
    await service.whenIdle()
    expect(attempts).toHaveLength(2)
    service.dispose()
  })

  it('waits for old canceled attempts before starting the same target in a newer generation', async () => {
    const { service, attempts } = fixture([record(1)])
    service.start(1)
    service.start(2)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].request.signal.aborted).toBe(true)
    const done = service.whenIdle()
    attempts[0].resolve({})
    // Await the actual second invocation, rather than relying on a timer.
    await Promise.resolve()
    expect(attempts).toHaveLength(2)
    expect(attempts[1].request.generation).toBe(2)
    attempts[1].resolve({})
    await done
    service.dispose()
  })

  it('disposes without waiting on providers and cannot start or resume more work', async () => {
    const { service, attempts } = fixture([record(1), record(2), record(3)])
    service.start(1)
    const done = service.whenIdle()
    service.dispose()
    await done
    await service.whenIdle()
    expect(attempts.every(attempt => attempt.request.signal.aborted)).toBe(true)
    expect(service.start(2)).toBe(false)
    service.beginManual().dispose()
    attempts.forEach(attempt => attempt.resolve({}))
    expect(attempts).toHaveLength(2)
  })
})
