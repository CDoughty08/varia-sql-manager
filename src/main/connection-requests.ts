import { canRememberPassword, connectContextSchema, type ConnectContext, type ConnectionLibrary } from '../shared/connections'
import type { ConnectionInfo, ConnectionOptions } from '../shared/contracts'
import { BackendError } from './backend/errors'
import type { ConnectionStore } from './connection-store'
import type { SavedPasswordStore } from './saved-passwords'

/** The requests that may use a remembered password: they open a connection with the dialog's options. */
const connectMethods = new Set(['connections.connect', 'connections.databases'])
const maxPassword = 1024
export interface ConnectionRequestDeps {
  savedPasswords: Pick<SavedPasswordStore, 'get' | 'set' | 'forget' | 'forgetCredentials' | 'reconcile'>
  connections: Pick<ConnectionStore, 'rememberEntry' | 'load'>
}
/**
 * A validated request about to be sent. `params` is what the backend gets: the validated options, with the remembered
 * password when main injected one. `validated` never holds that password, so nothing that stores or echoes it can.
 */
export interface PreparedRequest { method: string; validated: unknown; params: unknown; context?: ConnectContext; injected: boolean }
export type Settled = { ok: true; value: unknown } | { ok: false; error: unknown; passwordForgotten?: true }

/** `varia:request`'s fourth argument: a context only for the connect methods, and only of the strict shape. */
export function connectContext(method: string, value: unknown): ConnectContext | undefined {
  if (value === undefined) return undefined
  const parsed = connectContextSchema.safeParse(value)
  if (!connectMethods.has(method) || !parsed.success) throw new Error('Invalid request.')
  return parsed.data
}

/**
 * Whether SQL Server refused the password itself: Login failed (18456) for SQL Server Authentication. Other failures
 * (network, timeouts, a database that cannot be opened, TLS) say nothing about the password.
 */
export function secretRejected(options: ConnectionOptions, error: unknown): boolean {
  return options.authentication === 'sql' && error instanceof BackendError && error.code === 'SQL_ERROR' && error.details?.number === 18456
}

/**
 * Fills in the remembered password of the entry the dialog named, when the form left Password empty and the request has
 * the credentials it was saved with. A typed password always wins. Call it after validateRequest.
 */
export async function prepare(method: string, validated: unknown, value: unknown, deps: Pick<ConnectionRequestDeps, 'savedPasswords'>): Promise<PreparedRequest> {
  const context = connectContext(method, value)
  const prepared: PreparedRequest = { method, validated, params: validated, ...(context ? { context } : {}), injected: false }
  const options = validated as ConnectionOptions
  if (!context?.profileId || options.password) return prepared
  const password = await deps.savedPasswords.get(context.profileId, options)
  if (password === undefined) return prepared
  if (!password.length || password.length > maxPassword) throw new Error('The saved password could not be read. Enter the password.')
  return { ...prepared, params: { ...options, password }, injected: true }
}

/**
 * After the backend answered. A connection enters history, and its password is remembered under that entry when the
 * dialog asked for it (or forgotten when it did not). A remembered password SQL Server rejected is forgotten, so the
 * next attempt cannot repeat it into a lockout policy.
 */
export async function settle(prepared: PreparedRequest, outcome: Settled, deps: ConnectionRequestDeps): Promise<Settled> {
  if (!connectMethods.has(prepared.method)) return outcome
  const params = prepared.params as ConnectionOptions, context = prepared.context
  if (!outcome.ok) {
    if (!prepared.injected || !context?.profileId || !secretRejected(params, outcome.error)) return outcome
    try {
      await deps.savedPasswords.forget(context.profileId)
      await deps.savedPasswords.forgetCredentials(params)
      return { ...outcome, passwordForgotten: true }
    } catch { return outcome }
  }
  if (prepared.method !== 'connections.connect') return outcome
  const info = outcome.value as ConnectionInfo
  let id: string
  try { id = (await deps.connections.rememberEntry(prepared.validated as ConnectionOptions)).id }
  catch { info.historyWarning = 'Connected successfully, but recent connections could not be saved.'; return outcome }
  if (context?.remember && canRememberPassword(params.authentication) && params.password) {
    // set() gives every other entry with these credentials (the one used among them) this password, so none keeps an
    // older one to replay.
    try { await deps.savedPasswords.set(id, params) } catch { info.historyWarning = 'Connected successfully, but the password could not be saved.' }
  } else if (!context?.remember) {
    // Any entry with these credentials would offer its password again, so unchecking forgets them all.
    try {
      await deps.savedPasswords.forget(id, ...context?.profileId ? [context.profileId] : [])
      await deps.savedPasswords.forgetCredentials(params)
    } catch { info.historyWarning = 'Connected successfully, but the saved password could not be removed.' }
  }
  await deps.savedPasswords.reconcile(() => libraryOf(deps)).catch(() => {})
  return outcome
}
const libraryOf = async (deps: Pick<ConnectionRequestDeps, 'connections'>): Promise<ConnectionLibrary> => (await deps.connections.load()).library
