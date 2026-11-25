import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { canRememberPassword, connectionKey, connectContextSchema, credentialBinding, type ConnectContext, type ConnectionLibrary } from '../shared/connections'
import { connectionAuthenticationSchema, samePrincipal, type ConnectionCredentialReference, type ConnectionFailureReason } from '../shared/connection-targets'
import type { BigQueryConnectionOptions, ConnectionInfo, ConnectionOptions, ProviderConnectionOptions } from '../shared/contracts'
import { BackendError } from './backend/errors'
import type { ConnectionHistory } from './connection-history'
import type { SavedPasswordStore } from './saved-passwords'
import type { ConnectionAuthenticationGuard } from './connection-authentication'
import { verifiedBigQueryAuthentication, verifiedConnectionAuthentication } from './connection-principal'

/** The requests that may use a remembered password: they open a connection with the dialog's options. */
const connectMethods = new Set(['connections.connect', 'connections.databases'])
const maxPassword = 1024
export interface ConnectionRequestDeps {
  authentication: ConnectionAuthenticationGuard
  savedPasswords: Pick<SavedPasswordStore, 'get' | 'set' | 'forget' | 'forgetCredentials' | 'reconcile' | 'reference' | 'getReferenced' | 'forgetRejected' | 'storageAvailable'>
  connections: ConnectionHistory
  disconnect?: (connectionId: string) => Promise<unknown>
}
/**
 * A validated request about to be sent. `params` is what the backend gets: the validated options, with the remembered
 * password when main injected one. `validated` never holds that password, so nothing that stores or echoes it can.
 */
export interface PreparedRequest { method: string; validated: unknown; params: unknown; context?: ConnectContext; injected: boolean; injectedCredential?: ConnectionCredentialReference; requireFreshAuthentication?: boolean; release?: () => void }
export type Settled = { ok: true; value: unknown } | { ok: false; error: unknown; passwordForgotten?: true; credentialRejected?: true; connectionFailure?: ConnectionFailureReason }
export class ConnectionPreparationError extends Error {
  constructor(readonly reason: ConnectionFailureReason, message: string) { super(message) }
}

interface CredentialGate { readonly waiters: Set<() => void> }
const gates = new WeakMap<object, Map<string, CredentialGate>>()
const rejectionKey = randomBytes(32)
const rejectedSecret = (password: string) => createHmac('sha256', rejectionKey).update(password).digest('base64url')
const rejected = new WeakMap<object, Map<string, { binding: string; secret?: string }>>()
const pending = new WeakMap<object, number>()
const attempts = new WeakMap<object, number>()
/** Includes cancelled callers whose authenticated storage settlement is still draining under its owned lease. */
export const hasPendingCredentialRequests = (store: object): boolean => (attempts.get(store) ?? 0) > 0
export function rejectCredentialReference(store: object, reference: ConnectionCredentialReference, options: ConnectionOptions): void {
  let revisions = rejected.get(store)
  if (!revisions) { revisions = new Map(); rejected.set(store, revisions) }
  revisions.set(reference.revision, { binding: credentialBinding(options), ...options.password ? { secret: rejectedSecret(options.password) } : {} })
  if (revisions.size > 512) revisions.delete(revisions.keys().next().value!)
}
/**
 * Passwords a connections.databases request with `remember` just signed in with, kept as keyed hashes (never the password)
 * by credential binding for a minute: Save may then remember that password, and no other (takeVerifiedPassword).
 */
const verified = new WeakMap<object, Map<string, { secret: string; expires: number }>>()
const verifiedLifetime = 60_000
function admitVerifiedPassword(store: object, options: ConnectionOptions): void {
  let entries = verified.get(store)
  if (!entries) { entries = new Map(); verified.set(store, entries) }
  const now = Date.now()
  for (const [binding, entry] of entries) if (entry.expires <= now) entries.delete(binding)
  entries.delete(credentialBinding(options))
  entries.set(credentialBinding(options), { secret: rejectedSecret(options.password!), expires: now + verifiedLifetime })
  if (entries.size > 64) entries.delete(entries.keys().next().value!)
}
/**
 * Save's remembered password, under the same per-binding gate as a connect's credential write. The caller has proved it
 * with takeVerifiedPassword. Resolves whether it replaced the password (see SavedPasswordStore.set).
 */
export async function rememberCheckedPassword(store: Pick<SavedPasswordStore, 'set'>, profileId: string, options: ConnectionOptions): Promise<boolean> {
  const release = await acquire(store, `binding:${credentialBinding(options)}`)
  try { return await store.set(profileId, options) } finally { release() }
}
/**
 * Save's Forget: the entry's remembered password and every one for its credentials, under the per-binding gate. Resolves
 * false when secret storage is unavailable, so nothing could be forgotten.
 */
export async function forgetSavedPassword(store: Pick<SavedPasswordStore, 'forget' | 'forgetCredentials' | 'storageAvailable'>, profileId: string, options: ConnectionOptions): Promise<boolean> {
  const release = await acquire(store, `binding:${credentialBinding(options)}`)
  try {
    if (!await store.storageAvailable()) return false
    await store.forget(profileId); await store.forgetCredentials(options)
    return true
  } finally { release() }
}
/** Whether `options.password` is the one a check just verified for these credentials; a match is used up. */
export function takeVerifiedPassword(store: object, options: ConnectionOptions): boolean {
  const entries = verified.get(store), binding = credentialBinding(options), entry = entries?.get(binding)
  if (!entry || !options.password) return false
  entries!.delete(binding)
  const expected = Buffer.from(entry.secret), actual = Buffer.from(rejectedSecret(options.password))
  return entry.expires > Date.now() && expected.length === actual.length && timingSafeEqual(expected, actual)
}
/** Only trusted authentication/storage proof can readmit a revision whose exact saved secret is current again. */
export function admitVerifiedCredentialReference(store: object, reference: ConnectionCredentialReference): void { rejected.get(store)?.delete(reference.revision) }
async function readmitAuthenticatedCredential(prepared: PreparedRequest, reference: ConnectionCredentialReference | undefined, deps: ConnectionRequestDeps): Promise<boolean> {
  const params = prepared.params as ConnectionOptions
  if (!reference || !rejected.get(deps.savedPasswords)?.has(reference.revision)) return true
  if (!params.password) return false
  // Exact authenticated secret and current sealed storage revision must agree; a successful set() alone is not proof.
  try {
    if (await deps.savedPasswords.getReferenced(reference, params) === params.password) { admitVerifiedCredentialReference(deps.savedPasswords, reference); return true }
  } catch { /* Keep the rejection when storage proof is unavailable. */ }
  return false
}
const requireNotCancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new BackendError('CANCELLED', 'The connection request was cancelled.') }
async function acquire(store: object, binding: string, signal?: AbortSignal): Promise<() => void> {
  requireNotCancelled(signal)
  const count = pending.get(store) ?? 0
  if (count >= 16) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending credential requests.')
  pending.set(store, count + 1)
  let bindings = gates.get(store)
  if (!bindings) { bindings = new Map(); gates.set(store, bindings) }
  const previous = bindings.get(binding), gate = previous ?? { waiters: new Set<() => void>() }
  if (!previous) bindings.set(binding, gate)
  return new Promise<() => void>((resolve, reject) => {
    let done = false
    const decrement = () => { pending.set(store, (pending.get(store) ?? 1) - 1) }
    const leave = () => {
      if (done) return
      done = true
      decrement()
      const next = gate.waiters.values().next().value
      if (next) { gate.waiters.delete(next); next() }
      else if (bindings.get(binding) === gate) bindings.delete(binding)
    }
    const grant = () => { signal?.removeEventListener('abort', abort); resolve(leave) }
    const abort = () => {
      if (!gate.waiters.delete(grant)) return
      done = true
      decrement()
      signal?.removeEventListener('abort', abort)
      reject(new BackendError('CANCELLED', 'The connection request was cancelled.'))
    }
    if (!previous) grant()
    else {
      // Remove a cancelled waiter, not the predecessor's gate: later callers remain behind that owner's lease. This
      // keeps cancelled queue entries bounded without leaving a promise chain attached to a long-lived predecessor.
      gate.waiters.add(grant)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    }
  })
}

/** `varia:request`'s fourth argument: a context only for the connect methods, and only of the strict shape. */
export function connectContext(method: string, value: unknown): ConnectContext | undefined {
  if (value === undefined) return undefined
  const parsed = connectContextSchema.safeParse(value)
  if (!connectMethods.has(method) || !parsed.success) throw new Error('Invalid request.')
  return parsed.data
}

/**
 * Whether the password itself was refused: Login failed (18456) for SQL Server Authentication, or Microsoft Entra's
 * invalid user name or password (AADSTS50126) for Entra Password and invalid client secret (AADSTS7000215) for Service
 * Principal. Other failures (network, timeouts, a database that cannot be opened, TLS) say nothing about the password,
 * and 18456 under Entra means a missing grant or a stale token, not a wrong password.
 */
export function secretRejected(options: ConnectionOptions, error: unknown): boolean {
  if (!(error instanceof BackendError)) return false
  if (options.authentication === 'sql') return error.code === 'SQL_ERROR' && error.details?.number === 18456 && [2, 5, 8].includes(error.details.state ?? 0)
  return (options.authentication === 'entraPassword' || options.authentication === 'entraServicePrincipal') && error.code === 'AUTH_ENTRA'
    && (error.details?.number === 50126 || error.details?.number === 7000215)
}

/**
 * Fills in the remembered password of the entry the dialog named, when the form left Password empty and the request has
 * the credentials it was saved with. A typed password always wins. Call it after validateRequest.
 */
export async function prepare(method: string, validated: unknown, value: unknown, deps: Pick<ConnectionRequestDeps, 'savedPasswords' | 'authentication'>, signal?: AbortSignal): Promise<PreparedRequest> {
  requireNotCancelled(signal)
  let context = connectContext(method, value)
  if (connectMethods.has(method)) {
    try { context = deps.authentication.prepare(validated as ProviderConnectionOptions, context) }
    catch (error) { throw new ConnectionPreparationError('identity-changed', error instanceof Error ? error.message : 'The connection identity changed.') }
  }
  const prepared: PreparedRequest = { method, validated, params: validated, ...(context ? { context } : {}), injected: false }
  if (!connectMethods.has(method)) return prepared
  if ((validated as ProviderConnectionOptions).provider === 'bigquery') return prepareBigQuery(prepared, validated as BigQueryConnectionOptions, deps, signal)
  const options = validated as ConnectionOptions, background = context?.mode === 'background'
  if (context?.expectedPrincipal && (context.expectedPrincipal.provider !== 'sqlserver' || context.expectedPrincipal.authentication !== options.authentication)) throw new ConnectionPreparationError('identity-changed', 'The expected account uses another authentication mode.')
  if (background && (!context?.expectedPrincipal || options.password)) throw new ConnectionPreparationError('credentials-required', 'Reconnect requires the previous account and matching saved credentials.')
  if (context?.credential && options.password && context.credentialIntent !== 'update-credentials') throw new ConnectionPreparationError('credentials-required', 'Use Update Credentials to replace the remembered credential.')
  if (background) prepared.params = { ...options, nonInteractive: true }
  const count = attempts.get(deps.savedPasswords) ?? 0
  if (count >= 8) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending connection attempts.')
  attempts.set(deps.savedPasswords, count + 1)
  const leases: (() => void)[] = []
  let released = false
  prepared.release = () => {
    if (released) return
    released = true
    for (const release of leases.splice(0).reverse()) release()
    attempts.set(deps.savedPasswords, (attempts.get(deps.savedPasswords) ?? 1) - 1)
  }
  try {
    // A first binding is serialized too: its account reservation and later credential write are one owned operation.
    leases.push(await acquire(deps.savedPasswords, `target:${context!.targetId}`, signal))
    leases.push(await acquire(deps.savedPasswords, `binding:${credentialBinding(options)}`, signal))
    requireNotCancelled(signal)
    context = deps.authentication.prepare(options, context)
    prepared.context = context
    const reference = context?.credential
    const profileId = reference?.profileId ?? context?.profileId
    if (!profileId || options.password) {
      if (background && canRememberPassword(options.authentication)) throw new ConnectionPreparationError('credentials-required', 'Enter credentials to reconnect this target.')
      // A live session can survive a password change. A typed retry of a rejected binding must authenticate anew.
      if (options.password) {
        const binding = credentialBinding(options), secret = rejectedSecret(options.password)
        if ([...(rejected.get(deps.savedPasswords)?.values() ?? [])].some(value => value.binding === binding && value.secret === secret)) prepared.requireFreshAuthentication = true
      }
      return prepared
    }
    if (reference && rejected.get(deps.savedPasswords)?.has(reference.revision)) throw new ConnectionPreparationError('credentials-required', 'The saved credential was rejected. Update credentials to reconnect.')
    if (canRememberPassword(options.authentication)) {
      const available = await deps.savedPasswords.storageAvailable()
      requireNotCancelled(signal)
      if (!available) throw new ConnectionPreparationError('secret-storage-unavailable', 'Secret storage is unavailable. Enter credentials to reconnect.')
    }
    let password: string | undefined
    try { password = reference ? await deps.savedPasswords.getReferenced(reference, options) : background ? undefined : await deps.savedPasswords.get(profileId, options) }
    catch { throw new ConnectionPreparationError('secret-storage-unavailable', 'The saved password could not be read. Enter the password.') }
    requireNotCancelled(signal)
    if (password === undefined) {
      if (reference || background && canRememberPassword(options.authentication)) throw new ConnectionPreparationError('credentials-required', 'The saved credential revision is unavailable. Enter credentials to reconnect.')
      return prepared
    }
    if (!password.length || password.length > maxPassword) throw new ConnectionPreparationError('secret-storage-unavailable', 'The saved password could not be read. Enter the password.')
    const injectedCredential = reference ?? await deps.savedPasswords.reference(profileId, options)
    requireNotCancelled(signal)
    if (injectedCredential && rejected.get(deps.savedPasswords)?.has(injectedCredential.revision)) throw new ConnectionPreparationError('credentials-required', 'The saved credential was rejected. Update credentials to reconnect.')
    return { ...prepared, params: { ...prepared.params as ConnectionOptions, password }, injected: true, injectedCredential }
  } catch (error) { prepared.release?.(); throw error }
}

/**
 * BigQuery's preparation: no password to fill in (main adds the credential material when it sends), but the same target
 * and binding leases as SQL Server's, so a connect and its pin are one owned operation. A background reconnect needs the
 * pinned account, and BigQuery has no remembered credential to name.
 */
async function prepareBigQuery(prepared: PreparedRequest, options: BigQueryConnectionOptions, deps: Pick<ConnectionRequestDeps, 'savedPasswords' | 'authentication'>, signal?: AbortSignal): Promise<PreparedRequest> {
  let context = prepared.context
  const background = context?.mode === 'background'
  if (context?.expectedPrincipal && (context.expectedPrincipal.provider !== 'bigquery' || context.expectedPrincipal.project !== options.project)) throw new ConnectionPreparationError('identity-changed', 'The expected account belongs to another project or engine.')
  if (background && !context?.expectedPrincipal) throw new ConnectionPreparationError('credentials-required', 'Reconnect requires the previous account.')
  if (context?.credential || context?.credentialPolicy === 'remember' || context?.remember) throw new ConnectionPreparationError('credentials-required', 'BigQuery connections keep no remembered password.')
  if (background) prepared.params = { ...options, nonInteractive: true }
  const count = attempts.get(deps.savedPasswords) ?? 0
  if (count >= 8) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending connection attempts.')
  attempts.set(deps.savedPasswords, count + 1)
  const leases: (() => void)[] = []
  let released = false
  prepared.release = () => {
    if (released) return
    released = true
    for (const release of leases.splice(0).reverse()) release()
    attempts.set(deps.savedPasswords, (attempts.get(deps.savedPasswords) ?? 1) - 1)
  }
  try {
    leases.push(await acquire(deps.savedPasswords, `target:${context!.targetId}`, signal))
    leases.push(await acquire(deps.savedPasswords, `binding:${credentialBinding(options, { keyPath: options.keyFile })}`, signal))
    requireNotCancelled(signal)
    context = deps.authentication.prepare(options, context)
    prepared.context = context
    return prepared
  } catch (error) { prepared.release(); throw error }
}

/**
 * BigQuery's settlement: the account Google verified becomes the target's pin (or must equal it), and a foreground
 * connect enters BigQuery's history. No password is remembered or forgotten: BigQuery keeps none.
 */
async function settleBigQuery(prepared: PreparedRequest, outcome: Settled, deps: ConnectionRequestDeps): Promise<Settled> {
  if (!outcome.ok || prepared.method !== 'connections.connect') return outcome
  const info = outcome.value as ConnectionInfo, validated = prepared.validated as BigQueryConnectionOptions
  const refuse = async (error: unknown): Promise<Settled> => { await deps.disconnect?.(info.id).catch(() => {}); return { ok: false, error } }
  let context = prepared.context
  try { context = deps.authentication.prepare(validated, context) }
  catch (error) { return refuse(error) }
  const verified = verifiedBigQueryAuthentication(info, validated)
  if (!verified) return refuse(new BackendError('AUTH_IDENTITY', 'The authenticated Google account could not be verified. Connect again.'))
  if (context?.expectedPrincipal && !samePrincipal(verified.principal, context.expectedPrincipal)) return refuse(new BackendError('AUTH_IDENTITY', 'The connected Google account differs from the remembered account. Choose a connection explicitly.'))
  info.authentication = verified
  if (context?.targetId) {
    try { deps.authentication.remember(context.targetId, validated, verified, context.credentialIntent) }
    catch (error) { return refuse(error) }
    info.targetId = context.targetId
  }
  if (context?.mode === 'background') return outcome
  try {
    const entry = await deps.connections.rememberEntry(validated, !context?.setsEnvironment, context?.autoReconnect, context?.selectedProfileId)
    if (entry.environment && !validated.environment) info.environment = entry.environment
  } catch { info.historyWarning = 'Connected successfully, but recent connections could not be saved.' }
  return outcome
}

/**
 * After the backend answered. A connection enters history, and its password is remembered under that entry when the
 * dialog asked for it (or forgotten when it did not). Unless the dialog says the user set its Environment, a connect
 * without one keeps the entry's label, and the answer carries it so the connection shows it. A remembered password SQL
 * Server rejected is forgotten, so the next attempt cannot repeat it into a lockout policy.
 */
export async function settle(prepared: PreparedRequest, outcome: Settled, deps: ConnectionRequestDeps): Promise<Settled> {
  try { return await settleRequest(prepared, outcome, deps) }
  catch (error) {
    if (prepared.method === 'connections.connect' && outcome.ok) await deps.disconnect?.((outcome.value as ConnectionInfo).id).catch(() => {})
    return { ok: false, error }
  }
  finally { prepared.release?.() }
}
async function settleRequest(prepared: PreparedRequest, outcome: Settled, deps: ConnectionRequestDeps): Promise<Settled> {
  if (!connectMethods.has(prepared.method)) return outcome
  if ((prepared.validated as ProviderConnectionOptions).provider === 'bigquery') return settleBigQuery(prepared, outcome, deps)
  const params = prepared.params as ConnectionOptions
  let context = prepared.context
  if (!outcome.ok) {
    const profileId = prepared.injectedCredential?.profileId ?? context?.profileId
    const erase = secretRejected(params, outcome.error)
    const ambiguousLogin = params.authentication === 'sql' && outcome.error instanceof BackendError && outcome.error.code === 'SQL_ERROR'
      && outcome.error.details?.number === 18456 && (outcome.error.details.state === undefined || outcome.error.details.state === 1)
    if (!prepared.injected || !profileId || !erase && !ambiguousLogin) return outcome
    if (prepared.injectedCredential) {
      rejectCredentialReference(deps.savedPasswords, prepared.injectedCredential, params)
    }
    // A redacted SQL login failure does not prove a bad password; keep its ciphertext while stopping queued replays.
    if (!erase) return { ...outcome, credentialRejected: true }
    try {
      if (prepared.injectedCredential) await deps.savedPasswords.forgetRejected(prepared.injectedCredential, params)
      else { await deps.savedPasswords.forget(profileId); await deps.savedPasswords.forgetCredentials(params) }
      return { ...outcome, passwordForgotten: true, credentialRejected: true }
    } catch { return { ...outcome, credentialRejected: true } }
  }
  if (prepared.method !== 'connections.connect') {
    // Save checking a typed password it is to remember (Test Connection sends no `remember`): Save may now remember it.
    if (context?.remember && !prepared.injected && params.password && canRememberPassword(params.authentication)) admitVerifiedPassword(deps.savedPasswords, params)
    return outcome
  }
  const info = outcome.value as ConnectionInfo
  const validated = prepared.validated as ConnectionOptions
  try { context = deps.authentication.prepare(validated, context) }
  catch (error) { await deps.disconnect?.(info.id).catch(() => {}); return { ok: false, error } }
  // Stable proof comes from the authenticated backend, never a display login, requested name or renderer.
  const verified = verifiedConnectionAuthentication(info, validated.authentication)
  if (verified) info.authentication = verified
  if (context?.expectedPrincipal && (!verified || JSON.stringify(verified.principal) !== JSON.stringify(context.expectedPrincipal))) {
    await deps.disconnect?.(info.id).catch(() => {})
    return { ok: false, error: new Error('The connected account differs from the remembered account. Choose a connection explicitly.') }
  }
  let established = false
  if (info.authentication && context.targetId) {
    try { established = deps.authentication.remember(context.targetId, validated, info.authentication, context.credentialIntent).established }
    catch (error) { await deps.disconnect?.(info.id).catch(() => {}); return { ok: false, error } }
    info.targetId = context.targetId
  }
  if (context?.mode === 'background') {
    if (info.authentication && prepared.injectedCredential) info.authentication = connectionAuthenticationSchema.parse({ ...info.authentication, credential: prepared.injectedCredential })
    if (info.authentication && context.targetId) {
      deps.authentication.remember(context.targetId, validated, info.authentication, established ? 'update-credentials' : context.credentialIntent)
      info.targetId = context.targetId
    }
    return outcome
  }
  let id: string
  try {
    const entry = await deps.connections.rememberEntry(validated, !context?.setsEnvironment, context?.autoReconnect, context?.selectedProfileId)
    id = entry.id
    if (entry.environment && !validated.environment) info.environment = entry.environment
  } catch { info.historyWarning = 'Connected successfully, but recent connections could not be saved.'; return outcome }
  const policy = context?.credentialPolicy ?? (context?.remember ? 'remember' : 'forget')
  let passwordSaved = false
  if (policy === 'remember' && canRememberPassword(params.authentication) && params.password) {
    // set() gives every other entry with these credentials (the one used among them) this password, so none keeps an
    // older one to replay.
    try { await deps.savedPasswords.set(id, params); passwordSaved = true } catch { info.historyWarning = 'Connected successfully, but the password could not be saved.' }
  } else if (policy === 'forget') {
    // Any entry with these credentials would offer its password again, so unchecking forgets them all.
    try {
      if (!await deps.savedPasswords.storageAvailable()) throw new Error('Secret storage is unavailable.')
      await deps.savedPasswords.forget(id, ...context?.profileId ? [context.profileId] : [])
      await deps.savedPasswords.forgetCredentials(params)
    } catch { info.historyWarning = 'Connected successfully, but the saved password could not be removed.' }
  }
  await deps.savedPasswords.reconcile(() => libraryOf(deps)).catch(() => {})
  if (info.authentication) {
    const reference = policy === 'preserve' ? prepared.injectedCredential : policy === 'remember' && passwordSaved ? await deps.savedPasswords.reference(id, params).catch(() => undefined) : undefined
    // Established targets accept revision changes only as an explicit credential update.
    const credential = policy === 'forget' ? null : context?.credential && context.credentialIntent !== 'update-credentials' ? context.credential : reference
    if (credential) info.authentication = connectionAuthenticationSchema.parse({ ...info.authentication, credential })
    else if (policy === 'forget' || context?.credentialIntent === 'update-credentials' && !prepared.injected && !!params.password) info.authentication = connectionAuthenticationSchema.parse({ ...info.authentication, credential: null })
    if (context?.targetId) {
      // This operation established the first account and may finish binding its first remembered credential.
      deps.authentication.remember(context.targetId, validated, info.authentication, established || policy === 'forget' ? 'update-credentials' : context.credentialIntent)
      info.targetId = context.targetId
    }
    if (verified && !await readmitAuthenticatedCredential(prepared, reference, deps)) info.historyWarning = 'Connected successfully, but the saved credential could not be verified. Enter credentials to reconnect.'
  }
  return outcome
}
const libraryOf = async (deps: Pick<ConnectionRequestDeps, 'connections'>): Promise<ConnectionLibrary | null> => {
  const read = await deps.connections.load()
  return read.trusted === false ? null : read.library
}

/** Main calls this only after the reuse coordinator proved identical live credentials/settings. No new history/open. */
export async function settleReused(prepared: PreparedRequest, connected: ConnectionInfo, deps: ConnectionRequestDeps, freshlyAuthenticated = false): Promise<Settled> {
  try {
    if (!connected.targetId) throw new Error('The live connection has no authenticated target.')
    const pin = deps.authentication.resolve(connected.targetId)
    if (!pin?.expectedPrincipal || !connected.authentication) throw new Error('The live connection identity is unavailable.')
    const { password: _password, ...options } = prepared.validated as ConnectionOptions
    deps.authentication.prepare(options, { targetId: connected.targetId, expectedPrincipal: connected.authentication.principal })
    const { credentialUpdated: _credentialUpdated, ...base } = connected
    const info: ConnectionInfo = { ...base, authentication: connectionAuthenticationSchema.parse({ principal: pin.expectedPrincipal, ...(pin.credential ? { credential: pin.credential } : {}) }) }
    const context = prepared.context, params = prepared.params as ConnectionOptions
    if (context?.mode !== 'background' && context?.autoReconnect !== undefined) {
      try {
        if (!await deps.connections.setAutoReconnect(options, context.autoReconnect, context.selectedProfileId)) throw new Error('The saved connection is unavailable.')
      } catch { info.historyWarning ??= 'Connected successfully, but the reconnect preference could not be saved.' }
    }
    // A choice the dialog named (Advanced Properties' cost-prompt box) is saved as a new connection's would be.
    const bigQueryOptions = (params as ProviderConnectionOptions).provider === 'bigquery' ? params as unknown as BigQueryConnectionOptions : undefined
    if (context?.mode !== 'background' && bigQueryOptions?.costPrompt !== undefined) {
      try {
        if (!await deps.connections.setBigQueryCostPrompt?.(bigQueryOptions, bigQueryOptions.costPrompt)) throw new Error('The saved connection is unavailable.')
      } catch { info.historyWarning ??= 'Connected successfully, but the cost prompt choice could not be saved.' }
    }
    // So is the connection's own threshold (0: back to Options').
    if (context?.mode !== 'background' && bigQueryOptions?.costThreshold !== undefined) {
      try {
        if (!await deps.connections.setBigQueryCostThreshold?.(bigQueryOptions, bigQueryOptions.costThreshold)) throw new Error('The saved connection is unavailable.')
      } catch { info.historyWarning ??= 'Connected successfully, but the cost threshold could not be saved.' }
    }
    const policy = context?.mode === 'background' ? 'preserve' : context?.credentialPolicy ?? (context?.remember === undefined ? 'preserve' : context.remember ? 'remember' : 'forget')
    // BigQuery keeps no password: a reused BigQuery connection only records its reconnect preference.
    if (policy === 'preserve' || (params as ProviderConnectionOptions).provider === 'bigquery' || !canRememberPassword(params.authentication)) return { ok: true, value: info }

    if (!await deps.savedPasswords.storageAvailable()) {
      info.historyWarning = policy === 'forget' ? 'Connected successfully, but saved credentials could not be removed while secret storage is unavailable.' : 'Connected successfully, but the password could not be saved.'
      return { ok: true, value: info }
    }
    try {
      if (policy === 'forget') {
        await deps.savedPasswords.forgetCredentials(params)
        info.authentication = connectionAuthenticationSchema.parse({ principal: pin.expectedPrincipal, credential: null })
      } else {
        if (!params.password) throw new Error('Enter a password to remember it.')
        const read = await deps.connections.load()
        if (read.trusted === false) throw new Error('The saved connection library is unavailable.')
        const matching = read.library.profiles.find(profile => profile.id === context?.profileId && credentialBinding(profile.options) === credentialBinding(options))
          ?? read.library.profiles.find(profile => connectionKey(profile.options) === connectionKey(options))
        const profileId = matching?.id ?? (await deps.connections.rememberEntry(options, !context?.setsEnvironment, context?.autoReconnect, context?.selectedProfileId)).id
        await deps.savedPasswords.set(profileId, params)
        const reference = await deps.savedPasswords.reference(profileId, params)
        if (!reference) throw new Error('The saved credential revision is unavailable.')
        info.authentication = connectionAuthenticationSchema.parse({ principal: pin.expectedPrincipal, credential: reference })
      }
      deps.authentication.remember(connected.targetId, options, info.authentication, 'update-credentials')
      if (freshlyAuthenticated && !await readmitAuthenticatedCredential(prepared, info.authentication.credential ?? undefined, deps)) info.historyWarning = 'Connected successfully, but the saved credential could not be verified. Enter credentials to reconnect.'
      info.credentialUpdated = true
    } catch {
      info.historyWarning = policy === 'forget' ? 'Connected successfully, but the saved password could not be removed.' : 'Connected successfully, but the password could not be saved.'
    }
    return { ok: true, value: info }
  } catch (error) { return { ok: false, error } }
  finally { prepared.release?.() }
}
