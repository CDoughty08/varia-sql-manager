import { z } from 'zod'
import type { BigQueryConnectionOptions } from './contracts'
import { bigQueryConnectionOptionsSchema, connectionAutoReconnectSchema } from './connections'
import type { BigQueryAuthenticationMode } from './auth'
import { environmentSchema } from './environments'

/**
 * BigQuery's saved connections (`bigquery-connections.json`, docs/bigquery.md, Saved connections). The file is BigQuery's
 * own, so 0.9.0 never reads it (decision 24). A profile's `keyFile` is the opaque reference the renderer names its key or
 * configuration file by; the path behind it (`keyPath`) is main's only and never reaches the renderer, which sees the
 * file's name (decisions 2 and 47).
 */
export const bigQueryLibraryLimits = { profiles: 200, recent: 30, path: 4096, confirmedSources: 64 } as const
// Absolute on any platform main writes it from (a drive or UNC path on Windows, a rooted path elsewhere): a file with a
// relative path is invalid, so it is quarantined like any other rather than failing every later read.
const absolutePath = z.string().min(1).max(bigQueryLibraryLimits.path).refine(value => !/[\u0000-\u001f]/.test(value), 'A path cannot contain control characters.')
  .refine(value => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value), 'A path must be absolute.')
const savedOptionsSchema = bigQueryConnectionOptionsSchema
export const bigQueryStoredProfileSchema = z.object({
  id: z.uuid(), options: savedOptionsSchema, favorite: z.boolean(), saved: z.boolean().optional(), lastConnected: z.iso.datetime().optional(),
  autoReconnect: connectionAutoReconnectSchema.optional(), keyPath: absolutePath.optional()
}).strict().refine(value => (value.options.keyFile !== undefined) === (value.keyPath !== undefined), 'A saved key file reference needs its path.')
/** A federation configuration's `credential_source.file` the user confirmed in the Connect dialog (decision 49), by the
 *  configuration's path: a changed source path asks again. */
export const confirmedSourceSchema = z.object({ keyPath: absolutePath, source: absolutePath }).strict()
export const bigQueryLibraryFileSchema = z.object({
  version: z.literal(1), profiles: z.array(bigQueryStoredProfileSchema).max(bigQueryLibraryLimits.profiles),
  confirmedSources: z.array(confirmedSourceSchema).max(bigQueryLibraryLimits.confirmedSources).optional()
}).strict().refine(value => new Set(value.profiles.map(profile => profile.id)).size === value.profiles.length, 'Duplicate connection IDs.')
export type BigQueryStoredProfile = z.infer<typeof bigQueryStoredProfileSchema>
export type BigQueryLibraryFile = z.infer<typeof bigQueryLibraryFileSchema>

/** A saved BigQuery connection as the renderer sees it: the options with the key file's reference, and only its name. */
export interface BigQueryConnectionProfile {
  readonly id: string
  readonly options: BigQueryConnectionOptions
  readonly favorite: boolean
  readonly saved?: boolean
  readonly lastConnected?: string
  readonly autoReconnect?: 'inherit' | 'on' | 'off'
  readonly keyFileName?: string
}
export interface BigQueryLibraryView { readonly profiles: readonly BigQueryConnectionProfile[] }

/** Save, a favourite star or a connect's history entry for a BigQuery connection. */
export interface BigQueryProfileInput { id?: string; options: BigQueryConnectionOptions; favorite?: boolean; saved?: boolean; autoReconnect?: 'inherit' | 'on' | 'off' }
export const bigQueryProfileInputSchema = z.object({
  id: z.uuid().optional(), options: savedOptionsSchema, favorite: z.boolean().optional(), saved: z.boolean().optional(), autoReconnect: connectionAutoReconnectSchema.optional()
}).strict()
export const bigQueryEnvironmentInputSchema = z.object({ options: savedOptionsSchema, environment: environmentSchema.optional() }).strict()

/** connections.pickKeyFile's answer: the reference to name the file by from now on, its name, and for a federation
 *  configuration with a file source, the source's resolved path and whether the user already confirmed it (decision 49). */
export interface PickedKeyFile { readonly keyFile: string; readonly name: string; readonly source?: string; readonly sourceConfirmed?: boolean }
export const pickKeyFileParamsSchema = z.object({ authentication: z.enum(['serviceAccountKey', 'externalAccount']) }).strict()
export const confirmSourceParamsSchema = z.object({ keyFile: z.uuid(), source: absolutePath }).strict()

/** What the dialog names each mode and its file by. */
export const bigQueryAuthenticationLabels: Readonly<Record<BigQueryAuthenticationMode, string>> = {
  gcloud: 'gcloud credentials (ADC)', serviceAccountKey: 'Service account key file', externalAccount: 'Workload identity federation'
}
export const bigQueryKeyFileLabels: Readonly<Record<Exclude<BigQueryAuthenticationMode, 'gcloud'>, string>> = {
  serviceAccountKey: 'Key file', externalAccount: 'Configuration file'
}
