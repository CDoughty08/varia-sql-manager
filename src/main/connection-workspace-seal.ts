import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { usesPassword } from '../shared/auth'
import type { ConnectionWorkspace, PersistedConnectionTarget } from '../shared/connection-targets'
import type { SecretCipher } from './secret-cipher'

const keyBytes = 32
const keyPrefix = 'varia-workspace-seal:'
/** The OS-protected key and the MAC over every silent target; both bounded so a tampered file cannot grow them. */
export const workspaceSealSchema = z.object({ key: z.base64().max(4096), mac: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
export type WorkspaceSeal = z.infer<typeof workspaceSealSchema>

/**
 * Background reconnect sends Windows (SSPI) or silently acquired Entra credentials to the target's server before the
 * account check can refuse it. A target that uses a remembered password is already safe: its ciphertext is bound to the
 * server and TLS settings (saved-passwords.ts).
 */
const silent = (target: PersistedConnectionTarget) => !!target.expectedPrincipal && !usesPassword(target.options.authentication)
const message = (targets: readonly PersistedConnectionTarget[]) => JSON.stringify(targets.filter(silent)
  .map(target => [target.id, target.options, target.expectedPrincipal]).sort(([left], [right]) => String(left).localeCompare(String(right))))
const mac = (key: Buffer, workspace: ConnectionWorkspace) => createHmac('sha256', key).update(message(workspace.targets)).digest('hex')

/**
 * Seals the silent targets main writes to session.json, so a process that can write the file but cannot use the OS key
 * cannot add a target that startup would sign in to without asking. One random key per process, encrypted once, so a
 * close touches the Keychain at most once and only when a silent target is kept.
 *
 * Without OS protection (no keyring, smoke profiles) there is nothing to seal with, and a file without a seal is trusted as
 * before. A seal that is present but cannot be checked, or a missing seal while protection is available, fails closed:
 * those targets lose their remembered account and wait for an explicit Reconnect.
 */
export class ConnectionWorkspaceSealer {
  private key: Buffer | undefined
  private sealed: Promise<string | undefined> | undefined
  constructor(private readonly cipher: SecretCipher) {}

  async seal(workspace: ConnectionWorkspace | undefined): Promise<WorkspaceSeal | undefined> {
    if (!workspace?.targets.some(silent)) return undefined
    this.key ??= randomBytes(keyBytes)
    const key = this.key
    this.sealed ??= this.cipher.encrypt(keyPrefix + key.toString('base64')).then(data => data.toString('base64'), () => { this.sealed = undefined; return undefined })
    const encrypted = await this.sealed
    return encrypted ? { key: encrypted, mac: mac(key, workspace) } : undefined
  }

  /** The workspace main may pin: unchanged when sealed (or nothing could seal it), else without silent accounts. */
  async trusted(workspace: ConnectionWorkspace, seal: WorkspaceSeal | undefined): Promise<ConnectionWorkspace> {
    if (!workspace.targets.some(silent)) return workspace
    if (!seal && !(await this.cipher.state().catch(() => ({ available: false }))).available) return workspace
    if (seal && await this.verify(workspace, seal)) return workspace
    return { ...workspace, targets: workspace.targets.map(target => silent(target) ? withoutAccount(target) : target) }
  }

  private async verify(workspace: ConnectionWorkspace, seal: WorkspaceSeal): Promise<boolean> {
    try {
      const { text } = await this.cipher.decrypt(Buffer.from(seal.key, 'base64'))
      if (!text.startsWith(keyPrefix)) return false
      const key = Buffer.from(text.slice(keyPrefix.length), 'base64')
      if (key.length !== keyBytes) return false
      const expected = Buffer.from(mac(key, workspace)), actual = Buffer.from(seal.mac)
      return expected.length === actual.length && timingSafeEqual(expected, actual)
    } catch { return false }
  }
}

const withoutAccount = ({ expectedPrincipal: _principal, ...target }: PersistedConnectionTarget): PersistedConnectionTarget => target
