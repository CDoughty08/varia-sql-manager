import { describe, expect, it, vi } from 'vitest'
import type { ConnectionWorkspace, PersistedConnectionTarget } from '../src/shared/connection-targets'
import { ConnectionAuthenticationGuard } from '../src/main/connection-authentication'
import { ConnectionWorkspaceSealer, unprovenWithoutAccount } from '../src/main/connection-workspace-seal'
import { lockedCipher, testCipher, type SecretCipher } from '../src/main/secret-cipher'
import { encodeSession, type SessionInput } from '../src/main/session-store'
import type { SqlServerTargetOptions } from '../src/shared/connection-targets'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const windows = (value: number, server = 'sql-prod'): PersistedConnectionTarget => ({
  id: id(value), options: { server, database: 'Sales', authentication: 'windows', trustServerCertificate: false },
  details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: { provider: 'sqlserver', authentication: 'windows', id: 'sid:0105' }
})
const sql = (value: number): PersistedConnectionTarget => ({
  id: id(value), options: { server: 'sql-prod', database: 'Sales', authentication: 'sql', username: 'alex', trustServerCertificate: false },
  details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  credential: { profileId: id(90), revision: id(91) }, expectedPrincipal: { provider: 'sqlserver', authentication: 'sql', id: 'sid:0106' }
})
const workspace = (...targets: PersistedConnectionTarget[]): ConnectionWorkspace => ({ version: 1, targets })

describe('connection workspace seal', () => {
  it('keeps the accounts of a workspace main sealed and encrypts its key once per process', async () => {
    const cipher = testCipher(), encrypt = vi.spyOn(cipher, 'encrypt'), sealer = new ConnectionWorkspaceSealer(cipher)
    const kept = workspace(windows(1), sql(2))
    const seal = await sealer.seal(kept)
    expect(seal).toMatchObject({ mac: expect.stringMatching(/^[0-9a-f]{64}$/) })
    await sealer.seal(workspace(windows(1), windows(3)))
    expect(encrypt).toHaveBeenCalledTimes(1)
    // The next process holds a different key but reads the same OS-protected one from the file.
    expect(await new ConnectionWorkspaceSealer(cipher).trusted(kept, seal)).toEqual(kept)
  })

  it("keeps the accounts of a 0.9.0 session, sealed over the sqlServer spelling, after it is read as sqlserver", async () => {
    const cipher = testCipher()
    // 0.9.0 sealed its targets as it wrote them: the principal's provider spelled sqlServer.
    const as090 = (target: PersistedConnectionTarget) => ({ ...target, expectedPrincipal: { ...target.expectedPrincipal!, provider: 'sqlServer' } }) as unknown as PersistedConnectionTarget
    const seal = await new ConnectionWorkspaceSealer(cipher).seal(workspace(as090(windows(1)), sql(2)))
    const migrated = workspace(windows(1), sql(2))
    expect(await new ConnectionWorkspaceSealer(cipher).trusted(migrated, seal)).toEqual(migrated)
    // The re-spelling proves only the same targets: an edited one still loses its account.
    const trusted = await new ConnectionWorkspaceSealer(cipher).trusted(workspace(windows(1, 'attacker.example'), sql(2)), seal)
    expect(trusted.targets[0].expectedPrincipal).toBeUndefined()
  })

  it('drops silent accounts from a planted or edited target, but leaves password targets to their bound ciphertext', async () => {
    const cipher = testCipher(), sealer = new ConnectionWorkspaceSealer(cipher)
    const kept = workspace(windows(1), sql(2)), seal = await sealer.seal(kept)
    const redirected = workspace(windows(1, 'attacker.example'), sql(2))
    const planted = workspace(windows(1), sql(2), windows(3, 'attacker.example'))
    for (const tampered of [redirected, planted]) {
      const trusted = await sealer.trusted(tampered, seal)
      expect(trusted.targets.filter(target => target.options.authentication === 'windows').every(target => !target.expectedPrincipal)).toBe(true)
      expect(trusted.targets.find(target => target.id === id(2))).toEqual(sql(2))
    }
    // A removed seal, or one whose key was swapped, is no proof either.
    expect((await sealer.trusted(kept, undefined)).targets[0].expectedPrincipal).toBeUndefined()
    expect((await sealer.trusted(kept, { key: Buffer.from('varia-test:garbage').toString('base64'), mac: seal!.mac })).targets[0].expectedPrincipal).toBeUndefined()
  })

  it('needs no seal for password-only workspaces, and trusts an unsealed file only where there is no keyring at all', async () => {
    const without = (reason: 'no-keyring' | 'unknown-backend' | 'unavailable'): SecretCipher => ({ ...lockedCipher(), state: async () => ({ available: false, reason }) })
    expect(await new ConnectionWorkspaceSealer(testCipher()).seal(workspace(sql(2)))).toBeUndefined()
    expect(await new ConnectionWorkspaceSealer(without('no-keyring')).seal(workspace(windows(1)))).toBeUndefined()
    expect(await new ConnectionWorkspaceSealer(without('no-keyring')).trusted(workspace(windows(1)), undefined)).toEqual(workspace(windows(1)))
    // A keyring that is locked, not running yet or not known is not proof that nothing sealed the file, nor is a failed probe.
    for (const reason of ['unavailable', 'unknown-backend'] as const) expect((await new ConnectionWorkspaceSealer(without(reason)).trusted(workspace(windows(1)), undefined)).targets[0].expectedPrincipal, reason).toBeUndefined()
    expect((await new ConnectionWorkspaceSealer({ ...lockedCipher(), state: async () => { throw new Error('dbus') } }).trusted(workspace(windows(1)), undefined)).targets[0].expectedPrincipal).toBeUndefined()
    // A smoke profile turns secret storage off on purpose.
    expect(await new ConnectionWorkspaceSealer(lockedCipher(), { trustUnsealed: true }).trusted(workspace(windows(1)), undefined)).toEqual(workspace(windows(1)))
    // A seal that cannot be checked now fails closed rather than trusting the file.
    const seal = await new ConnectionWorkspaceSealer(testCipher()).seal(workspace(windows(1)))
    expect((await new ConnectionWorkspaceSealer(without('no-keyring')).trusted(workspace(windows(1)), seal)).targets[0].expectedPrincipal).toBeUndefined()
  })

  it('covers resume intent, Explorer membership and labels, and keeps an unproven target without its account', async () => {
    const sealer = new ConnectionWorkspaceSealer(testCipher())
    const disconnected: PersistedConnectionTarget = { ...windows(1), resumeWanted: false, details: { displayName: 'Staging', environment: 'Development', autoReconnect: 'inherit' } }
    const seal = await sealer.seal(workspace(disconnected))
    expect(await sealer.trusted(workspace(disconnected), seal)).toEqual(workspace(disconnected))
    for (const tampered of [{ ...disconnected, resumeWanted: true }, { ...disconnected, details: { ...disconnected.details, autoReconnect: 'on' as const } }, { ...disconnected, details: { ...disconnected.details, displayName: 'Production' } }]) {
      const [target] = (await sealer.trusted(workspace(tampered), seal)).targets
      expect(target.expectedPrincipal).toBeUndefined()
      // A legitimate failure (a refused prompt) must not cost the labels; Reconnect shows the server before it signs in.
      expect(target).toEqual((({ expectedPrincipal: _principal, ...rest }) => rest)(tampered))
    }
  })

  it('gives the page no account for an unproven target even when a reload kept its pin', async () => {
    const guard = new ConnectionAuthenticationGuard(), sealer = new ConnectionWorkspaceSealer(testCipher())
    const disconnected = { ...windows(1), resumeWanted: false }
    guard.restore(workspace(disconnected))
    // A tampered file turns resume back on for a target whose pin the previous page left in main.
    const read = workspace({ ...disconnected, resumeWanted: true }), trusted = await sealer.trusted(read, undefined)
    guard.restore(trusted)
    expect(guard.project(trusted).targets[0].expectedPrincipal).toEqual(disconnected.expectedPrincipal)
    const [target] = unprovenWithoutAccount(trusted, guard.project(trusted)).targets
    expect(target).toMatchObject({ id: id(1), resumeWanted: true })
    expect(target.expectedPrincipal).toBeUndefined()
    // The pin itself stays for any live handle, and a proven workspace passes through unchanged.
    expect(guard.resolve(id(1))?.expectedPrincipal).toEqual(disconnected.expectedPrincipal)
    const sealed = workspace(windows(2)), proven = await sealer.trusted(sealed, await sealer.seal(sealed))
    expect(unprovenWithoutAccount(proven, guard.project(proven))).toEqual(guard.project(proven))
  })

  it('decides on the pin the page would get, not on a file entry edited to hide it from the seal', async () => {
    const guard = new ConnectionAuthenticationGuard(), sealer = new ConnectionWorkspaceSealer(testCipher())
    const disconnected = { ...windows(1), resumeWanted: false }
    guard.restore(workspace(disconnected))
    const { expectedPrincipal: _principal, ...withoutAccount } = disconnected
    const asPassword: PersistedConnectionTarget = { ...disconnected, options: { ...disconnected.options as SqlServerTargetOptions, authentication: 'sql', username: 'alex' }, expectedPrincipal: { provider: 'sqlserver', authentication: 'sql', id: 'sid:0105' } }
    for (const edited of [withoutAccount, asPassword]) {
      const read = workspace({ ...edited, resumeWanted: true }), trusted = await sealer.trusted(read, undefined)
      const [target] = unprovenWithoutAccount(trusted, guard.project(trusted)).targets
      expect(target.options.authentication).toBe('windows')
      expect(target.expectedPrincipal).toBeUndefined()
    }
  })

  it('refuses a key the OS would re-encrypt, and goes on without the OS when it does not answer in time', async () => {
    const cipher = testCipher(), seal = await new ConnectionWorkspaceSealer(cipher).seal(workspace(windows(1)))
    const fallback: SecretCipher = { ...cipher, decrypt: async data => ({ ...await cipher.decrypt(data), reEncrypt: true }) }
    expect((await new ConnectionWorkspaceSealer(fallback).trusted(workspace(windows(1)), seal)).targets[0].expectedPrincipal).toBeUndefined()
    const hung: SecretCipher = { state: async () => ({ available: true }), encrypt: () => new Promise(() => {}), decrypt: () => new Promise(() => {}) }
    const waiting = new ConnectionWorkspaceSealer(hung, { timeoutMs: 5 })
    expect(await waiting.seal(workspace(windows(1)))).toBeUndefined()
    expect((await waiting.trusted(workspace(windows(1)), seal)).targets[0].expectedPrincipal).toBeUndefined()
  })

  it('round-trips through session.json and only beside a workspace', async () => {
    const seal = await new ConnectionWorkspaceSealer(testCipher()).seal(workspace(windows(1)))
    const document = { name: 'Query', kind: 'sql' as const, eol: 'lf' as const, dirty: true, text: 'SELECT 1' }
    expect(encodeSession({ documents: [document], activeIndex: 0, workspace: workspace(windows(1)), seal }).record.seal).toEqual(seal)
    expect(encodeSession({ documents: [document], activeIndex: 0, seal }).record.seal).toBeUndefined()
  })
})

describe('session checkpoint seal and close marks', () => {
  it('writes the seal of the projected workspace beside it', async () => {
    const { ConnectionSessionCheckpoint } = await import('../src/main/connection-session-checkpoint')
    const writes: SessionInput[] = []
    const sealer = new ConnectionWorkspaceSealer(testCipher())
    const checkpoint = new ConnectionSessionCheckpoint({ revision: 0, project: value => value }, { write: async session => { writes.push(session) }, keptBy: () => true }, undefined, undefined, undefined, value => sealer.seal(value))
    await checkpoint.write({ documents: [], activeIndex: -1, workspace: workspace(windows(1)) }, 1)
    expect(await sealer.trusted(workspace(windows(1)), writes[0].seal)).toEqual(workspace(windows(1)))
  })

  it('does not hold a close to a file a later failed write of the same page left behind', async () => {
    const { ConnectionSessionCheckpoint } = await import('../src/main/connection-session-checkpoint')
    let kept: number | undefined, pending = false
    const checkpoint = new ConnectionSessionCheckpoint({ revision: 0, project: value => value }, {
      write: async (_session, generation) => { kept = generation }, keptBy: generation => kept === generation
    }, () => pending)
    await checkpoint.write({ documents: [], activeIndex: -1 }, 7)
    expect(checkpoint.holds(7)).toBe(true)
    pending = true
    await expect(checkpoint.write({ documents: [], activeIndex: -1 }, 7)).rejects.toThrow('current connection attempt')
    pending = false
    // The next close keeps nothing: it must clear the old file and close, not refuse every close from now on.
    expect(checkpoint.holds(7)).toBe(false)
    expect(() => checkpoint.assertCurrent(7)).not.toThrow()
  })

  it('stops holding a close the page cancelled after it kept the session', async () => {
    const { ConnectionSessionCheckpoint } = await import('../src/main/connection-session-checkpoint')
    let kept: number | undefined
    const checkpoint = new ConnectionSessionCheckpoint({ revision: 0, project: value => value }, {
      write: async (_session, generation) => { kept = generation }, keptBy: generation => kept === generation
    })
    await checkpoint.write({ documents: [], activeIndex: -1 }, 7)
    checkpoint.release(6)
    expect(checkpoint.holds(7)).toBe(true)
    // A refused final check or a prompt cancelled the close: the next one that keeps nothing must delete this file.
    checkpoint.release(7)
    expect(checkpoint.holds(7)).toBe(false)
    await checkpoint.write({ documents: [], activeIndex: -1 }, 7)
    expect(checkpoint.holds(7)).toBe(true)
  })
})
