import { describe, expect, it, vi } from 'vitest'
import type { ConnectionWorkspace, PersistedConnectionTarget } from '../src/shared/connection-targets'
import { ConnectionWorkspaceSealer } from '../src/main/connection-workspace-seal'
import { lockedCipher, testCipher } from '../src/main/secret-cipher'
import { encodeSession, type SessionInput } from '../src/main/session-store'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const windows = (value: number, server = 'sql-prod'): PersistedConnectionTarget => ({
  id: id(value), options: { server, database: 'Sales', authentication: 'windows', trustServerCertificate: false },
  details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  expectedPrincipal: { provider: 'sqlServer', authentication: 'windows', id: 'sid:0105' }
})
const sql = (value: number): PersistedConnectionTarget => ({
  id: id(value), options: { server: 'sql-prod', database: 'Sales', authentication: 'sql', username: 'alex', trustServerCertificate: false },
  details: { autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true,
  credential: { profileId: id(90), revision: id(91) }, expectedPrincipal: { provider: 'sqlServer', authentication: 'sql', id: 'sid:0106' }
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

  it('needs no seal for password-only workspaces and trusts unsealed files when the OS cannot protect one', async () => {
    const locked = new ConnectionWorkspaceSealer(lockedCipher())
    expect(await new ConnectionWorkspaceSealer(testCipher()).seal(workspace(sql(2)))).toBeUndefined()
    expect(await locked.seal(workspace(windows(1)))).toBeUndefined()
    expect(await locked.trusted(workspace(windows(1)), undefined)).toEqual(workspace(windows(1)))
    // A seal that cannot be checked now fails closed rather than trusting the file.
    const seal = await new ConnectionWorkspaceSealer(testCipher()).seal(workspace(windows(1)))
    expect((await locked.trusted(workspace(windows(1)), seal)).targets[0].expectedPrincipal).toBeUndefined()
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
})
