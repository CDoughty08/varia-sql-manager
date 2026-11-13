import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ConnectionAuthenticationGuard } from '../src/main/connection-authentication'
import { connectionTargetOptions, type ConnectionWorkspace } from '../src/shared/connection-targets'
import type { ConnectionOptions } from '../src/shared/contracts'

const options: ConnectionOptions = { server: 'server', database: 'Sales', authentication: 'sql', username: 'reader', trustServerCertificate: false }
const principal = { provider: 'sqlServer', authentication: 'sql', id: 'actual-reader' } as const
function fixture() {
  const id = randomUUID(), credential = { profileId: randomUUID(), revision: randomUUID() }
  const target = { id, options: connectionTargetOptions(options), details: { autoReconnect: 'inherit' as const }, expectedPrincipal: principal, credential, inExplorer: true, resumeWanted: true }
  const workspace: ConnectionWorkspace = { version: 1, targets: [target] }
  const guard = new ConnectionAuthenticationGuard()
  guard.restore(workspace)
  return { id, credential, target, workspace, guard }
}

describe('main-owned target authentication evidence', () => {
  it('compares effective defaults consistently without normalizing meaningful routing or explicit timeout intent', () => {
    const { guard, id } = fixture()
    expect(guard.prepare({ ...options, encrypt: 'mandatory', advanced: { packetSize: 8000, connectRetryCount: 1 } }, { targetId: id })).toMatchObject({ expectedPrincipal: principal })
    expect(() => guard.prepare({ ...options, advanced: { commandTimeout: 0 } }, { targetId: id })).toThrow('identity changed')
    expect(() => guard.prepare({ ...options, server: 'SERVER' }, { targetId: id })).toThrow('identity changed')
  })
  it('uses its prior account and credential when a renderer omits them, and rejects substituted evidence or destination', () => {
    const { guard, id, credential } = fixture()
    expect(guard.prepare(options, { targetId: id, mode: 'background' })).toMatchObject({ expectedPrincipal: principal, credential })
    for (const context of [
      { expectedPrincipal: { ...principal, id: 'different' } },
      { credential: { ...credential, revision: randomUUID() } },
      { credential: { ...credential, profileId: randomUUID() } }
    ]) expect(() => guard.prepare(options, { targetId: id, ...context })).toThrow('identity changed')
    for (const changed of [{ server: 'another' }, { database: 'sales' }, { username: 'admin' }, { trustServerCertificate: true }])
      expect(() => guard.prepare({ ...options, ...changed }, { targetId: id })).toThrow('identity changed')
    expect(() => guard.prepare(options, { targetId: randomUUID(), mode: 'background', expectedPrincipal: principal, credential })).toThrow('Choose this target explicitly')
  })
  it('prevents renderer checkpoint poisoning and keeps evidence after restore/checkpoint acknowledgement', () => {
    const { guard, target, credential, id } = fixture()
    const malicious = { ...target, options: connectionTargetOptions({ ...options, server: 'another' }), expectedPrincipal: { ...principal, id: 'admin' }, credential: { ...credential, revision: randomUUID() }, details: { autoReconnect: 'off' as const } }
    const unknown = { ...malicious, id: randomUUID() }
    expect(guard.project({ version: 1, targets: [malicious, unknown] }).targets).toEqual([
      { ...target, details: malicious.details },
      { id: unknown.id, options: unknown.options, details: unknown.details, inExplorer: true, resumeWanted: true }
    ])
    guard.restore({ version: 1, targets: [malicious] })
    expect(guard.prepare(options, { targetId: id }).expectedPrincipal).toEqual(principal)
  })
  it('revises credentials only under explicit same-account updates', () => {
    const { guard, id, credential } = fixture()
    const replacement = { ...credential, revision: randomUUID() }
    expect(() => guard.remember(id, options, { principal, credential: replacement })).toThrow('identity changed')
    expect(guard.resolve(id)?.credential).toEqual(credential)
    guard.remember(id, options, { principal, credential: replacement }, 'update-credentials')
    expect(guard.resolve(id)?.credential).toEqual(replacement)
    expect(() => guard.remember(id, options, { principal: { ...principal, id: 'admin' }, credential: replacement }, 'update-credentials')).toThrow('identity changed')
    guard.remember(id, options, { principal, credential: null }, 'update-credentials')
    expect(guard.resolve(id)?.credential).toBeUndefined()
    expect(() => guard.remember(id, options, { principal, credential: replacement })).toThrow('identity changed')
    expect(() => guard.prepare({ ...options, password: 'typed' }, { targetId: id })).toThrow('Update Credentials')
    guard.forget(id)
    expect(guard.resolve(id)).toBeUndefined()
  })
  it('uses the current pin for explicit typed interactive recovery without relaxing saved-reference or principal checks', () => {
    const { guard, id, credential } = fixture()
    const stale = { ...credential, revision: randomUUID() }, typed = { ...options, password: 'corrected-secret' }
    const update = { targetId: id, credential: stale, expectedPrincipal: principal, credentialIntent: 'update-credentials' as const }
    expect(guard.prepare(typed, update)).toMatchObject({ credential, expectedPrincipal: principal })
    expect(guard.prepare(typed, { ...update, mode: 'interactive' })).toMatchObject({ credential, expectedPrincipal: principal })
    for (const context of [{ ...update, mode: 'background' as const }, { ...update, credentialIntent: 'preserve' as const }])
      expect(() => guard.prepare(typed, context)).toThrow('identity changed')
    expect(() => guard.prepare(options, update)).toThrow('identity changed')
    expect(() => guard.prepare({ ...typed, server: 'another' }, update)).toThrow('identity changed')
    expect(() => guard.prepare(typed, { ...update, expectedPrincipal: { ...principal, id: 'another-account' } })).toThrow('identity changed')
  })
})
