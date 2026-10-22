import type { ConnectionLibraryView, ConnectionProfileInput } from '../../../shared/connections'
import type { ApiResult } from '../../../shared/contracts'
import { environmentPreset, environmentSchema } from '../../../shared/environments'
import type { ConnectionService } from './connections'

export interface EnvironmentDeps {
  readonly connections: Pick<ConnectionService, 'get' | 'relabel'>
  /** `window.varia.saveConnectionProfile`: main validates the profile again and writes connections.json atomically. */
  save(profile: ConnectionProfileInput): Promise<ApiResult<ConnectionLibraryView>>
}
export type EnvironmentOutcome = { readonly ok: true; readonly environment?: string } | { readonly ok: false; readonly error: string }

/** The label as stored: undefined for None, a preset by its own name in any case typed, else the trimmed label, or why
 *  it cannot be one (a Custom label left blank). */
export function parseEnvironment(value: string | undefined): EnvironmentOutcome {
  if (value === undefined) return { ok: true }
  const parsed = environmentSchema.safeParse(value)
  return parsed.success ? { ok: true, environment: environmentPreset(parsed.data) ?? parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter an environment label.' }
}

/**
 * Set Environment for a connected server, as Object Explorer's server menu offers it. The label is saved with the
 * connection's entry in connections.json first (main finds the entry by its server, database, login and settings, as
 * a connect does), so a failure changes nothing on screen; then every connection to that entry shows it.
 */
export async function applyEnvironment(deps: EnvironmentDeps, connectionId: string, value: string | undefined): Promise<EnvironmentOutcome> {
  const connection = deps.connections.get(connectionId)
  if (!connection) return { ok: false, error: 'This server is no longer connected.' }
  const parsed = parseEnvironment(value)
  if (!parsed.ok) return parsed
  const options = { ...connection.options }
  if (parsed.environment) options.environment = parsed.environment
  else delete options.environment
  try {
    const result = await deps.save({ options })
    if (!result.ok) return { ok: false, error: result.error }
  } catch (error) { return { ok: false, error: error instanceof Error && error.message ? error.message : 'The environment could not be saved.' } }
  deps.connections.relabel(connectionId, parsed.environment)
  return parsed
}
