import { canRememberPassword, connectionKey, connectContextSchema, credentialBinding, type ConnectContext, type ConnectionLibrary } from '../shared/connections'
import { connectionAuthenticationSchema, type ConnectionCredentialReference, type ConnectionFailureReason } from '../shared/connection-targets'
import type { ConnectionInfo, ConnectionOptions } from '../shared/contracts'
import { BackendError } from './backend/errors'
import type { ConnectionStore } from './connection-store'
import type { SavedPasswordStore } from './saved-passwords'
import type { ConnectionAuthenticationGuard } from './connection-authentication'
import { verifiedConnectionAuthentication } from './connection-principal'

/** The requests that may use a remembered password: they open a connection with the dialog's options. */
const connectMethods = new Set(['connections.connect', 'connections.databases'])
const maxPassword = 1024
export interface ConnectionRequestDeps {
  authentication: ConnectionAuthenticationGuard
  savedPasswords: Pick<SavedPasswordStore, 'get' | 'set' | 'forget' | 'forgetCredentials' | 'reconcile' | 'reference' | 'getReferenced' | 'forgetRejected' | 'storageAvailable'>
  connections: Pick<ConnectionStore, 'rememberEntry' | 'load'>
  disconnect?: (connectionId: string) => Promise<unknown>
}
/**
 * A validated request about to be sent. `params` is what the backend gets: the validated options, with the remembered
 * password when main injected one. `validated` never holds that password, so nothing that stores or echoes it can.
 */
export interface PreparedRequest { method: string; validated: unknown; params: unknown; context?: ConnectContext; injected: boolean; injectedCredential?: ConnectionCredentialReference; release?: () => void }
export type Settled = { ok: true; value: unknown } | { ok: false; error: unknown; passwordForgotten?: true; credentialRejected?: true; connectionFailure?: ConnectionFailureReason }
export class ConnectionPreparationError extends Error {
  constructor(readonly reason: ConnectionFailureReason, message: string) { super(message) }
}

const gates = new WeakMap<object, Map<string, Promise<void>>>()
const rejected = new WeakMap<object, Set<string>>()
const pending = new WeakMap<object, number>()
const attempts = new WeakMap<object, number>()
async function acquire(store: object, binding: string): Promise<() => void> {
  const count = pending.get(store) ?? 0
  if (count >= 16) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending credential requests.')
  pending.set(store, count + 1)
  let bindings = gates.get(store)
  if (!bindings) { bindings = new Map(); gates.set(store, bindings) }
  const previous = bindings.get(binding) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const current = previous.then(() => held)
  bindings.set(binding, current)
  await previous
  let done = false
  return () => { if (done) return; done = true; pending.set(store, (pending.get(store) ?? 1) - 1); release(); if (bindings.get(binding) === current) bindings.delete(binding) }
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
export async function prepare(method: string, validated: unknown, value: unknown, deps: Pick<ConnectionRequestDeps, 'savedPasswords' | 'authentication'>): Promise<PreparedRequest> {
  let context = connectContext(method, value)
  if (connectMethods.has(method)) {
    try { context = deps.authentication.prepare(validated as ConnectionOptions, context) }
    catch (error) { throw new ConnectionPreparationError('identity-changed', error instanceof Error ? error.message : 'The connection identity changed.') }
  }
  const prepared: PreparedRequest = { method, validated, params: validated, ...(context ? { context } : {}), injected: false }
  if (!connectMethods.has(method)) return prepared
  const options = validated as ConnectionOptions, background = context?.mode === 'background'
  if (context?.expectedPrincipal && context.expectedPrincipal.authentication !== options.authentication) throw new ConnectionPreparationError('identity-changed', 'The expected account uses another authentication mode.')
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
    leases.push(await acquire(deps.savedPasswords, `target:${context!.targetId}`))
    leases.push(await acquire(deps.savedPasswords, `binding:${credentialBinding(options)}`))
    context = deps.authentication.prepare(options, context)
    prepared.context = context
    const reference = context?.credential
    if (reference && rejected.get(deps.savedPasswords)?.has(reference.revision)) throw new ConnectionPreparationError('credentials-required', 'The saved credential was rejected. Update credentials to reconnect.')
    const profileId = reference?.profileId ?? context?.profileId
    if (!profileId || options.password) {
      if (background && canRememberPassword(options.authentication)) throw new ConnectionPreparationError('credentials-required', 'Enter credentials to reconnect this target.')
      return prepared
    }
    if (canRememberPassword(options.authentication) && !await deps.savedPasswords.storageAvailable()) throw new ConnectionPreparationError('secret-storage-unavailable', 'Secret storage is unavailable. Enter credentials to reconnect.')
    let password: string | undefined
    try { password = reference ? await deps.savedPasswords.getReferenced(reference, options) : background ? undefined : await deps.savedPasswords.get(profileId, options) }
    catch { throw new ConnectionPreparationError('secret-storage-unavailable', 'The saved password could not be read. Enter the password.') }
    if (password === undefined) {
      if (reference || background && canRememberPassword(options.authentication)) throw new ConnectionPreparationError('credentials-required', 'The saved credential revision is unavailable. Enter credentials to reconnect.')
      return prepared
    }
    if (!password.length || password.length > maxPassword) throw new ConnectionPreparationError('secret-storage-unavailable', 'The saved password could not be read. Enter the password.')
    const injectedCredential = reference ?? await deps.savedPasswords.reference(profileId, options)
    if (injectedCredential && rejected.get(deps.savedPasswords)?.has(injectedCredential.revision)) throw new ConnectionPreparationError('credentials-required', 'The saved credential was rejected. Update credentials to reconnect.')
    return { ...prepared, params: { ...prepared.params as ConnectionOptions, password }, injected: true, injectedCredential }
  } catch (error) { prepared.release?.(); throw error }
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
  const params = prepared.params as ConnectionOptions
  let context = prepared.context
  if (!outcome.ok) {
    const profileId = prepared.injectedCredential?.profileId ?? context?.profileId
    const erase = secretRejected(params, outcome.error)
    const ambiguousLogin = params.authentication === 'sql' && outcome.error instanceof BackendError && outcome.error.code === 'SQL_ERROR'
      && outcome.error.details?.number === 18456 && (outcome.error.details.state === undefined || outcome.error.details.state === 1)
    if (!prepared.injected || !profileId || !erase && !ambiguousLogin) return outcome
    if (prepared.injectedCredential) {
      let revisions = rejected.get(deps.savedPasswords)
      if (!revisions) { revisions = new Set(); rejected.set(deps.savedPasswords, revisions) }
      revisions.add(prepared.injectedCredential.revision)
      if (revisions.size > 512) revisions.delete(revisions.values().next().value!)
    }
    // A redacted SQL login failure does not prove a bad password; keep its ciphertext while stopping queued replays.
    if (!erase) return { ...outcome, credentialRejected: true }
    try {
      if (prepared.injectedCredential) await deps.savedPasswords.forgetRejected(prepared.injectedCredential, params)
      else { await deps.savedPasswords.forget(profileId); await deps.savedPasswords.forgetCredentials(params) }
      return { ...outcome, passwordForgotten: true, credentialRejected: true }
    } catch { return { ...outcome, credentialRejected: true } }
  }
  if (prepared.method !== 'connections.connect') return outcome
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
    const entry = await deps.connections.rememberEntry(validated, !context?.setsEnvironment)
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
  }
  return outcome
}
const libraryOf = async (deps: Pick<ConnectionRequestDeps, 'connections'>): Promise<ConnectionLibrary | null> => {
  const read = await deps.connections.load()
  return read.trusted === false ? null : read.library
}

/** Main calls this only after the reuse coordinator proved identical live credentials/settings. No new history/open. */
export async function settleReused(prepared: PreparedRequest, connected: ConnectionInfo, deps: ConnectionRequestDeps): Promise<Settled> {
  try {
    if (!connected.targetId) throw new Error('The live connection has no authenticated target.')
    const pin = deps.authentication.resolve(connected.targetId)
    if (!pin?.expectedPrincipal || !connected.authentication) throw new Error('The live connection identity is unavailable.')
    const { password: _password, ...options } = prepared.validated as ConnectionOptions
    deps.authentication.prepare(options, { targetId: connected.targetId, expectedPrincipal: connected.authentication.principal })
    const { credentialUpdated: _credentialUpdated, ...base } = connected
    const info: ConnectionInfo = { ...base, authentication: connectionAuthenticationSchema.parse({ principal: pin.expectedPrincipal, ...(pin.credential ? { credential: pin.credential } : {}) }) }
    const context = prepared.context, params = prepared.params as ConnectionOptions
    const policy = context?.mode === 'background' ? 'preserve' : context?.credentialPolicy ?? (context?.remember === undefined ? 'preserve' : context.remember ? 'remember' : 'forget')
    if (policy === 'preserve' || !canRememberPassword(params.authentication)) return { ok: true, value: info }
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
        const profileId = matching?.id ?? (await deps.connections.rememberEntry(options, !context?.setsEnvironment)).id
        await deps.savedPasswords.set(profileId, params)
        const reference = await deps.savedPasswords.reference(profileId, params)
        if (!reference) throw new Error('The saved credential revision is unavailable.')
        info.authentication = connectionAuthenticationSchema.parse({ principal: pin.expectedPrincipal, credential: reference })
      }
      deps.authentication.remember(connected.targetId, options, info.authentication, 'update-credentials')
      info.credentialUpdated = true
    } catch {
      info.historyWarning = policy === 'forget' ? 'Connected successfully, but the saved password could not be removed.' : 'Connected successfully, but the password could not be saved.'
    }
    return { ok: true, value: info }
  } catch (error) { return { ok: false, error } }
  finally { prepared.release?.() }
}
