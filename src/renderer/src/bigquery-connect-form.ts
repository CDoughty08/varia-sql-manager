import type { BigQueryConnectionOptions, BigQueryProject, ProviderConnectionOptions } from '../../shared/contracts'
import { bigQueryConnectionOptionsSchema, bigQueryLimits, bigQueryProjectSchema } from '../../shared/connections'
import { usesKeyFile, type BigQueryAuthenticationMode } from '../../shared/auth'
import type { ProviderId } from '../../shared/providers'
import { bigQueryAuthenticationLabels, type BigQueryConnectionProfile } from '../../shared/bigquery-connections'

/**
 * The Connect dialog's Server type (docs/bigquery.md, Connect dialog). Switching keeps each type's fields, so switching
 * back restores them; `previous` is what Undo goes back to, and it lasts until Undo or the next switch.
 */
export interface ServerTypeState { readonly type: ProviderId; readonly previous?: ProviderId }
export function switchServerType(state: ServerTypeState, next: ProviderId): ServerTypeState {
  return next === state.type ? state : { type: next, previous: state.type }
}
export function undoServerType(state: ServerTypeState): ServerTypeState {
  return state.previous ? { type: state.previous } : state
}
export const serverTypeLabels: Readonly<Record<ProviderId, string>> = { sqlserver: 'SQL Server', bigquery: 'BigQuery' }

/** The type a fresh dialog opens with: the type of the connection used last (the latest History entry of either engine),
 *  so SQL Server users see no difference. */
export function lastServerType(sqlServer: readonly { readonly lastConnected?: string }[], bigQuery: readonly { readonly lastConnected?: string }[]): ProviderId {
  const latest = (profiles: readonly { readonly lastConnected?: string }[]) => profiles.reduce((max, profile) => profile.lastConnected && profile.lastConnected > max ? profile.lastConnected : max, '')
  const big = latest(bigQuery)
  return big && big > latest(sqlServer) ? 'bigquery' : 'sqlserver'
}

/** A new BigQuery form: gcloud credentials, the default sign-in, and no project yet. */
export function bigQueryDefaults(): BigQueryConnectionOptions { return { provider: 'bigquery', project: '', authentication: 'gcloud' } }

/** Changing the authentication forgets the key file: another mode's file is not this one's. */
export function withAuthentication(options: BigQueryConnectionOptions, authentication: BigQueryAuthenticationMode): BigQueryConnectionOptions {
  if (authentication === options.authentication) return options
  const { keyFile: _keyFile, ...rest } = options
  return { ...rest, authentication }
}

/** Whether the options can sign in: the mode's key file is chosen. */
export function bigQueryCredentialReady(options: BigQueryConnectionOptions): boolean { return !usesKeyFile(options.authentication) || !!options.keyFile }

/** The project field's problem, or undefined when it holds a valid project id. */
export function projectError(project: string): string | undefined {
  const value = project.trim()
  if (!value) return 'Enter a project.'
  const parsed = bigQueryProjectSchema.safeParse(value)
  return parsed.success ? undefined : parsed.error.issues[0]?.message ?? 'Enter a Google Cloud project id.'
}

/** Whether Connect, Test Connection and Save can go ahead. */
export function bigQueryReady(options: BigQueryConnectionOptions): boolean { return bigQueryCredentialReady(options) && !projectError(options.project) }

/**
 * The form's options as main takes them: trimmed, and with empty optional fields left out (a cleared Location is
 * Automatic, a cleared dataset is none). Throws with the schema's message when a field is still invalid.
 */
export function bigQueryFormOptions(form: BigQueryConnectionOptions): BigQueryConnectionOptions {
  const location = form.location?.trim(), dataset = form.dataset?.trim(), impersonate = form.impersonateServiceAccount?.trim()
  const extraProjects = form.extraProjects?.map(value => value.trim()).filter(Boolean)
  const value: BigQueryConnectionOptions = {
    provider: 'bigquery', project: form.project.trim(), authentication: form.authentication,
    ...location ? { location } : {}, ...dataset ? { dataset } : {}, ...extraProjects?.length ? { extraProjects } : {},
    ...usesKeyFile(form.authentication) && form.keyFile ? { keyFile: form.keyFile } : {},
    ...impersonate ? { impersonateServiceAccount: impersonate } : {}, ...form.maximumBytesBilled ? { maximumBytesBilled: form.maximumBytesBilled } : {},
    ...form.displayName?.trim() ? { displayName: form.displayName } : {}, ...form.color ? { color: form.color } : {}, ...form.environment ? { environment: form.environment } : {}
  }
  const parsed = bigQueryConnectionOptionsSchema.safeParse(value)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the connection settings.')
  return value
}

/** How many projects Load projects keeps across its pages. */
export const maxListedProjects = 10_000
/** Adds a projects.list page to what is listed: each project once (the first spelling wins), sorted by id, at most
 *  `maxListedProjects`. */
export function mergeProjects(current: readonly BigQueryProject[], page: readonly BigQueryProject[]): BigQueryProject[] {
  const byId = new Map(current.map(project => [project.id, project]))
  for (const project of page) if (!byId.has(project.id)) byId.set(project.id, project)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, maxListedProjects)
}

/** Maximum bytes billed's units: binary, as BigQuery bills (a TiB). */
export const byteUnits = [['MiB', 2 ** 20], ['GiB', 2 ** 30], ['TiB', 2 ** 40]] as const
export type ByteUnit = typeof byteUnits[number][0]
/** A byte count as the largest unit it is a whole number of (500 GiB, not 0.49 TiB); MiB at least. */
export function splitBytes(bytes: number | undefined): { amount: string; unit: ByteUnit } {
  if (!bytes) return { amount: '', unit: 'GiB' }
  for (const [unit, size] of [...byteUnits].reverse()) if (bytes % size === 0) return { amount: String(bytes / size), unit }
  return { amount: String(Math.max(1, Math.round(bytes / 2 ** 20))), unit: 'MiB' }
}
/** The amount typed in a unit as bytes, undefined for an empty field, or an error for anything else. */
export function joinBytes(amount: string, unit: ByteUnit): { ok: true; bytes?: number } | { ok: false; error: string } {
  const text = amount.trim()
  if (!text) return { ok: true }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return { ok: false, error: 'Enter Maximum bytes billed as a number, or leave it empty for no limit.' }
  const bytes = Math.round(Number(text) * byteUnits.find(([name]) => name === unit)![1])
  if (bytes < 1 || !Number.isSafeInteger(bytes)) return { ok: false, error: 'Maximum bytes billed is out of range.' }
  return { ok: true, bytes }
}

/** Extra projects as typed (commas, spaces or new lines between them): each once, in order, or the first invalid one. */
export function parseExtraProjects(text: string, billing: string): { ok: true; projects: string[] } | { ok: false; error: string } {
  const projects: string[] = []
  for (const value of text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean)) {
    if (!bigQueryProjectSchema.safeParse(value).success) return { ok: false, error: `${value.slice(0, 64)} is not a Google Cloud project id.` }
    if (value !== billing.trim() && !projects.includes(value)) projects.push(value)
  }
  if (projects.length > bigQueryLimits.extraProjects) return { ok: false, error: `List at most ${bigQueryLimits.extraProjects} extra projects.` }
  return { ok: true, projects }
}

/** A History row's second line: the engine, default dataset and sign-in. */
export function bigQueryRowDetail(profile: Pick<BigQueryConnectionProfile, 'options' | 'keyFileName'>): string {
  const { options } = profile
  return ['BigQuery', options.dataset || '<no default dataset>', bigQueryAuthenticationLabels[options.authentication] + (profile.keyFileName ? ` (${profile.keyFileName})` : '')].join(' · ')
}

/** What a history filter matches for a BigQuery entry. */
export function bigQueryRowText(profile: Pick<BigQueryConnectionProfile, 'options' | 'keyFileName'>): string {
  return [profile.options.displayName, profile.options.project, profile.options.dataset, 'BigQuery', profile.keyFileName].filter(Boolean).join(' ')
}

/** The project or server the options name, for captions and prompts. */
export function serverOf(options: ProviderConnectionOptions): string { return options.provider === 'bigquery' ? options.project : options.server }
