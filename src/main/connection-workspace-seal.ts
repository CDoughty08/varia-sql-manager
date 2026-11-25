import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { SecretStorageState } from '../shared/connections'
import { targetUsesPassword, type ConnectionWorkspace, type PersistedConnectionTarget } from '../shared/connection-targets'
import type { SecretCipher } from './secret-cipher'

const keyBytes = 32
const keyPrefix = 'varia-workspace-seal:'
/** The OS-protected key and the MAC over every silent target; both bounded so a tampered file cannot grow them. */
export const workspaceSealSchema = z.object({ key: z.base64().max(4096), mac: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
export type WorkspaceSeal = z.infer<typeof workspaceSealSchema>

/** Only where nothing could ever seal a file (Linux's basic_text backend) is it trusted as before. A keyring that is not
 *  reachable, not yet known or answers with Chromium's fallback key may be there at the next close, so it fails closed. */
const structurallyUnprotected = (state: SecretStorageState) => !state.available && state.reason === 'no-keyring'

export interface WorkspaceSealOptions {
  /** How long close or startup waits on the OS (a Keychain or keyring prompt) before going on without the seal. */
  readonly timeoutMs?: number
  /** A run that disables secret storage on purpose (a smoke profile) trusts unsealed files as a keyring-less one does. */
  readonly trustUnsealed?: boolean
}

/**
 * Background reconnect sends Windows (SSPI) or silently acquired Entra credentials to the target's server before the
 * account check can refuse it. A target that uses a remembered password is already safe: its ciphertext is bound to the
 * server and TLS settings (saved-passwords.ts).
 */
const silent = (target: PersistedConnectionTarget) => !!target.expectedPrincipal && !targetUsesPassword(target.options)
/** The whole target: destination, account, Explorer membership, resume intent and labels, so tampering cannot undo a
 *  Disconnect or relabel one sealed server as another. Both sides are the same strict schema's parse, so keys agree. */
const message = (targets: readonly PersistedConnectionTarget[]) => JSON.stringify(targets.filter(silent)
  .map(target => [target.id, target]).sort(([left], [right]) => String(left).localeCompare(String(right))))
const mac = (key: Buffer, workspace: ConnectionWorkspace) => createHmac('sha256', key).update(message(workspace.targets)).digest('hex')
/**
 * The same targets as 0.9.0 spelled them (`provider: 'sqlServer'` in the expected principal), which its seals cover. The
 * migrated session keeps 0.9.0's seal while reading the principal as `sqlserver`, so verifying only today's spelling would
 * drop every silent target's account at the first 0.10.0 start. It is the same content re-spelled, so it proves nothing more.
 */
const legacyMac = (key: Buffer, workspace: ConnectionWorkspace) => createHmac('sha256', key).update(message(workspace.targets.map(target =>
  target.expectedPrincipal?.provider === 'sqlserver' ? { ...target, expectedPrincipal: { ...target.expectedPrincipal, provider: 'sqlServer' } } as unknown as PersistedConnectionTarget : target))).digest('hex')
/**
 * Re-attaches legacy BigQuery `extraProjects` in its pre-upgrade schema field order (after `dataset`, before `authentication`)
 * so seals written before `extraProjects` migrated to Starred Projects verify without stripping `expectedPrincipal`.
 */
function withLegacyExtraProjects(target: PersistedConnectionTarget, extra: readonly string[] | undefined, sqlServerLegacySpelling: boolean): PersistedConnectionTarget {
  const nextPrincipal = sqlServerLegacySpelling && target.expectedPrincipal?.provider === 'sqlserver'
    ? { ...target.expectedPrincipal, provider: 'sqlServer' } as unknown as PersistedConnectionTarget['expectedPrincipal']
    : target.expectedPrincipal
  if (!extra || target.options.provider !== 'bigquery') return nextPrincipal === target.expectedPrincipal ? target : { ...target, expectedPrincipal: nextPrincipal }
  const opts = target.options
  const legacyOptions: Record<string, unknown> = { provider: opts.provider, project: opts.project }
  if (opts.location !== undefined) legacyOptions.location = opts.location
  if (opts.dataset !== undefined) legacyOptions.dataset = opts.dataset
  legacyOptions.extraProjects = [...extra]
  for (const [field, value] of Object.entries(opts)) {
    if (field === 'provider' || field === 'project' || field === 'location' || field === 'dataset') continue
    legacyOptions[field] = value
  }
  return { ...target, options: legacyOptions as unknown as PersistedConnectionTarget['options'], ...nextPrincipal ? { expectedPrincipal: nextPrincipal } : {} }
}
const legacyExtraMac = (key: Buffer, workspace: ConnectionWorkspace, extraByTarget: ReadonlyMap<string, readonly string[]>, sqlServerLegacySpelling: boolean) =>
  createHmac('sha256', key).update(message(workspace.targets.map(target => withLegacyExtraProjects(target, extraByTarget.get(target.id), sqlServerLegacySpelling)))).digest('hex')
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise(resolve => {
  const timer = setTimeout(() => resolve(fallback), ms)
  promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
})

/**
 * Seals the silent targets main writes to session.json, so a process that can write the file but cannot use the OS key
 * cannot add or change a target that startup would sign in to without asking. One random key per process, encrypted
 * once, so a close touches the Keychain at most once and only when a silent target is kept.
 *
 * Without a keyring there is nothing to seal with, and a file without a seal is trusted as before. Otherwise a seal that is
 * missing, wrong or cannot be checked in time fails closed: those targets lose their remembered account and wait for an
 * explicit Reconnect, which shows the account and the server before any credential is sent. Labels and resume intent stay,
 * so a legitimate failure (a refused Keychain prompt) costs only that one automatic reconnect.
 *
 * What it does not stop: a process running as the same user can usually use the OS key too (DPAPI on Windows), and an older
 * file with its own valid seal can be put back. Either way credentials only go to a server and account main once verified.
 */
export class ConnectionWorkspaceSealer {
  private key: Buffer | undefined
  private sealed: Promise<string | undefined> | undefined
  private readonly timeoutMs: number
  constructor(private readonly cipher: SecretCipher, private readonly options: WorkspaceSealOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async seal(workspace: ConnectionWorkspace | undefined): Promise<WorkspaceSeal | undefined> {
    if (!workspace?.targets.some(silent)) return undefined
    this.key ??= randomBytes(keyBytes)
    const key = this.key
    this.sealed ??= this.cipher.encrypt(keyPrefix + key.toString('base64')).then(data => data.toString('base64'), () => { this.sealed = undefined; return undefined })
    // An unanswered prompt must not hold the close: without a seal the next start only asks for an explicit Reconnect.
    const encrypted = await within(this.sealed, this.timeoutMs, undefined)
    return encrypted ? { key: encrypted, mac: mac(key, workspace) } : undefined
  }

  /** The workspace main may pin: unchanged when sealed (or nothing could seal it), else without silent accounts. */
  async trusted(workspace: ConnectionWorkspace, seal: WorkspaceSeal | undefined, legacyExtraByTarget?: ReadonlyMap<string, readonly string[]>): Promise<ConnectionWorkspace> {
    if (!workspace.targets.some(silent)) return workspace
    if (!seal && (this.options.trustUnsealed || await within(this.cipher.state().then(structurallyUnprotected), this.timeoutMs, false))) return workspace
    if (seal && await within(this.verify(workspace, seal, legacyExtraByTarget), this.timeoutMs, false)) return workspace
    return { ...workspace, targets: workspace.targets.map(target => silent(target) ? unproven(target) : target) }
  }

  private async verify(workspace: ConnectionWorkspace, seal: WorkspaceSeal, legacyExtraByTarget?: ReadonlyMap<string, readonly string[]>): Promise<boolean> {
    try {
      const { text, reEncrypt } = await this.cipher.decrypt(Buffer.from(seal.key, 'base64'))
      // A key the OS would re-encrypt is not one this OS key wrote (Linux accepts a public fallback key that way).
      if (reEncrypt || !text.startsWith(keyPrefix)) return false
      const key = Buffer.from(text.slice(keyPrefix.length), 'base64')
      if (key.length !== keyBytes) return false
      const actual = Buffer.from(seal.mac)
      const matches = (expected: Buffer) => expected.length === actual.length && timingSafeEqual(expected, actual)
      // If any silent target had legacy extraProjects stripped on read, the seal MUST cover those extraProjects —
      // never fall back to matching the post-upgrade MAC without them, or an external writer could inject extraProjects.
      const hasSilentLegacyExtra = !!legacyExtraByTarget?.size && workspace.targets.some(target => silent(target) && legacyExtraByTarget.has(target.id))
      if (hasSilentLegacyExtra) {
        return matches(Buffer.from(legacyExtraMac(key, workspace, legacyExtraByTarget!, false)))
          || matches(Buffer.from(legacyExtraMac(key, workspace, legacyExtraByTarget!, true)))
      }
      return matches(Buffer.from(mac(key, workspace))) || matches(Buffer.from(legacyMac(key, workspace)))
    } catch { return false }
  }
}

/** Kept with its documents and labels, but without the account that would let startup sign in to it unasked. */
const unproven = ({ expectedPrincipal: _principal, ...target }: PersistedConnectionTarget): PersistedConnectionTarget => target

/**
 * After a reload main may still hold a pin for a target the seal did not prove, and projecting puts that pin's options and
 * account back, even over a file entry edited to look like a password target or to have no account. So the decision is
 * made on what the page would get: any silent target the seal did not prove as silent loses its account. The pin stays
 * (a live handle may use it); startup just does not reconnect that target unasked.
 */
export function unprovenWithoutAccount(trusted: ConnectionWorkspace, projected: ConnectionWorkspace): ConnectionWorkspace {
  const proven = new Set(trusted.targets.filter(silent).map(target => target.id))
  return projected.targets.some(target => silent(target) && !proven.has(target.id))
    ? { ...projected, targets: projected.targets.map(target => silent(target) && !proven.has(target.id) ? unproven(target) : target) }
    : projected
}
