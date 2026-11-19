import { createHmac, randomBytes } from 'node:crypto'
import type { AuthenticationMode, BigQueryAuthenticationMode } from '../shared/auth'
import { showsIdentity, usesPassword } from '../shared/auth'
import type { AdvancedConnectionOptions, BigQueryConnectionOptions, ConnectionOptions, ProviderConnectionOptions } from '../shared/contracts'
import { advancedDefaults, bigQueryConnectionOptionsSchema, connectionOptionsSchema } from '../shared/connections'
import { bigQueryTargetOptions } from '../shared/connection-targets'

declare const connectionIdentityKey: unique symbol
/** Main-owned, process-local comparison material. Never include it in IPC, persisted state, logs or errors. */
export type ConnectionIdentityKey = string & { readonly [connectionIdentityKey]: true }
declare const connectionCredentialKey: unique symbol
/** Ephemeral credential component permits nonsecret setting changes without retaining the supplied password. */
export type ConnectionCredentialKey = string & { readonly [connectionCredentialKey]: true }
export interface ConnectionIdentityMaterial { readonly key: ConnectionIdentityKey; readonly credential: ConnectionCredentialKey }

/** The stable account identity established by trusted authentication, never a requested account or a token value. */
export interface ConnectionPrincipalEvidence {
  readonly authentication: AuthenticationMode | BigQueryAuthenticationMode
  readonly id: string
}

// Sorted schema-owned keys keep object insertion order out of equality and include future advanced defaults.
const advancedKeys = Object.keys(advancedDefaults).sort() as (keyof AdvancedConnectionOptions)[]

/**
 * One registry belongs to main's live connection owner. It does not authenticate or find connections: callers compare
 * only against a successfully authenticated live handle, and must resolve dynamic accounts before asking for a key.
 * Retain keys only for that live generation. Disposal invalidates the registry and erases its HMAC key.
 */
export class ConnectionIdentityRegistry {
  readonly #secret = randomBytes(32)
  #disposed = false

  key(options: ProviderConnectionOptions, principal?: ConnectionPrincipalEvidence): ConnectionIdentityKey | undefined {
    return options.provider === 'bigquery' ? this.#bigQuery(options, principal)?.key : this.#material(options, principal, false)?.key
  }

  /** Only an authenticated backend answer may prove that SQL Server accepted an empty supplied password. */
  authenticatedKey(options: ProviderConnectionOptions, principal: ConnectionPrincipalEvidence): ConnectionIdentityKey | undefined {
    return this.authenticatedMaterial(options, principal)?.key
  }

  authenticatedMaterial(options: ProviderConnectionOptions, principal: ConnectionPrincipalEvidence): ConnectionIdentityMaterial | undefined {
    return options.provider === 'bigquery' ? this.#bigQuery(options, principal) : this.#material(options, principal, true)
  }

  /**
   * BigQuery has no password to compare before opening: a key's or federation configuration's account is known only once
   * Google verified it, so only that pinned principal (with the mode and key file reference) identifies the credential.
   */
  #bigQuery(options: BigQueryConnectionOptions, principal: ConnectionPrincipalEvidence | undefined): ConnectionIdentityMaterial | undefined {
    if (this.#disposed || !principal) return undefined
    const parsed = bigQueryConnectionOptionsSchema.safeParse(options)
    if (!parsed.success || principal.authentication !== parsed.data.authentication || !principal.id.startsWith('bigquery:') || principal.id.length > 1024) return undefined
    const value = parsed.data
    const credential = createHmac('sha256', this.#secret).update(JSON.stringify(['credential', 'bigquery', value.authentication, value.keyFile ?? '', value.impersonateServiceAccount?.toLowerCase() ?? '', principal.id])).digest('hex') as ConnectionCredentialKey
    const key = createHmac('sha256', this.#secret).update(JSON.stringify(['bigquery', bigQueryTargetOptions(value)])).update('\0').update(credential).digest('hex') as ConnectionIdentityKey
    return Object.freeze({ key, credential })
  }

  rekey(options: ConnectionOptions, credential: ConnectionCredentialKey): ConnectionIdentityKey | undefined {
    const parsed = connectionOptionsSchema.safeParse(options)
    return !this.#disposed && parsed.success ? this.#settingsKey(parsed.data, credential) : undefined
  }

  #material(options: ConnectionOptions, principal: ConnectionPrincipalEvidence | undefined, authenticated: boolean): ConnectionIdentityMaterial | undefined {
    if (this.#disposed) return undefined
    const parsed = connectionOptionsSchema.safeParse(options)
    if (!parsed.success) return undefined
    const value = parsed.data
    const password = usesPassword(value.authentication) ? value.password : undefined
    if (principal && (principal.authentication !== value.authentication || typeof principal.id !== 'string' || !principal.id.trim() || principal.id.length > 1024)) return undefined
    if (authenticated && !principal) return undefined
    if (usesPassword(value.authentication) && !password && !(authenticated && value.authentication === 'sql')) return undefined
    // SQL's requested login plus its password identifies a candidate. OS identities and Entra account selection can
    // change independently of form values, so even an entered Entra user/client id is not sufficient evidence.
    // Nonempty SQL keeps its candidate key after authentication; blank SQL has no candidate key and includes its
    // verified principal, so an absent password cannot guess an unresolved account or stand in for a saved revision.
    const account = authenticated && value.authentication === 'sql' && password ? value.username : principal?.id ?? (value.authentication === 'sql' ? value.username : undefined)
    if (!account) return undefined
    const credential = createHmac('sha256', this.#secret).update(JSON.stringify(['credential', value.authentication, account])).update('\0').update(password ?? '').digest('hex') as ConnectionCredentialKey
    return Object.freeze({ key: this.#settingsKey(value, credential), credential })
  }

  #settingsKey(value: ConnectionOptions, credential: ConnectionCredentialKey): ConnectionIdentityKey {
    const canonical = [
      'sqlserver', value.server, value.database, value.authentication, showsIdentity(value.authentication) ? '' : value.username ?? '',
      value.encrypt ?? 'mandatory', value.trustServerCertificate, value.hostNameInCertificate ?? '',
      advancedKeys.map(key => [key, value.advanced?.[key] ?? advancedDefaults[key]]),
      value.advanced?.commandTimeout === undefined ? ['inherit'] : ['explicit', value.advanced.commandTimeout]
    ]
    // Both components need this registry's random salt, remain main-only, and are erased with their generation.
    return createHmac('sha256', this.#secret).update(JSON.stringify(canonical)).update('\0').update(credential).digest('hex') as ConnectionIdentityKey
  }

  dispose(): void {
    this.#disposed = true
    this.#secret.fill(0)
  }
}
