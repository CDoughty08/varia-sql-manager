import { connectionKey, type ConnectionEnvironmentInput, type ConnectionLibraryView, type ConnectionProfile } from '../../../shared/connections'
import type { ApiResult, ConnectionOptions } from '../../../shared/contracts'
import { environmentPreset, environmentSchema } from '../../../shared/environments'
import type { ConnectionService } from './connections'

export interface EnvironmentDeps {
  readonly connections: Pick<ConnectionService, 'get' | 'relabel'>
  /** `window.varia.setConnectionEnvironment`: main validates the input again, changes only the entry's label and writes
   *  connections.json atomically. */
  setEnvironment(input: ConnectionEnvironmentInput): Promise<ApiResult<ConnectionLibraryView>>
}
export type EnvironmentOutcome = { readonly ok: true; readonly environment?: string } | { readonly ok: false; readonly error: string }

/** The label as stored: undefined for None, a preset by its own name in any case typed, else the trimmed label, or why
 *  it cannot be one (a Custom label left blank). */
export function parseEnvironment(value: string | undefined): EnvironmentOutcome {
  if (value === undefined) return { ok: true }
  const parsed = environmentSchema.safeParse(value)
  return parsed.success ? { ok: true, environment: environmentPreset(parsed.data) ?? parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter an environment label.' }
}

/** The key of the entry a form or connection names; undefined while the options are incomplete or invalid. */
export function entryKey(options: ConnectionOptions): string | undefined { try { return connectionKey(options) } catch { return undefined } }

/**
 * The saved entry the Connect dialog's options name (the same server in any case, database, login and settings), whose
 * environment the form shows until the user sets one: typing a production server's name shows its PROD tag before
 * connecting, as choosing it from history does. `keys` maps each profile id to its entryKey.
 */
export function savedEntry(profiles: readonly ConnectionProfile[], keys: ReadonlyMap<string, string | undefined>, options: ConnectionOptions): ConnectionProfile | undefined {
  const key = entryKey(options)
  return key === undefined ? undefined : profiles.find(profile => keys.get(profile.id) === key)
}

const notSaved = 'The environment could not be saved with this connection.'

/**
 * Set Environment for a connected server, as Object Explorer's server menu offers it. Main changes the label of the
 * connection's entry in connections.json (found by its server, database, login and settings, as a connect finds it)
 * and nothing else; only when the library it wrote holds that label does every connection to the entry show it, so a
 * failure, or a write that lost the entry, changes nothing on screen.
 */
export async function applyEnvironment(deps: EnvironmentDeps, connectionId: string, value: string | undefined): Promise<EnvironmentOutcome> {
  const connection = deps.connections.get(connectionId)
  if (!connection) return { ok: false, error: 'This server is no longer connected.' }
  const parsed = parseEnvironment(value)
  if (!parsed.ok) return parsed
  const { environment: _previous, ...options } = connection.options
  try {
    const result = await deps.setEnvironment({ options, ...parsed.environment ? { environment: parsed.environment } : {} })
    if (!result.ok) return { ok: false, error: result.error }
    const key = connectionKey(options)
    if (!result.value.library.profiles.some(profile => connectionKey(profile.options) === key && profile.options.environment === parsed.environment)) return { ok: false, error: notSaved }
  } catch (error) { return { ok: false, error: error instanceof Error && error.message ? error.message : notSaved } }
  deps.connections.relabel(connectionId, parsed.environment)
  return parsed
}
