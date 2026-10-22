import { z } from 'zod'
import type { AdvancedConnectionOptions, ConnectionOptions } from './contracts'
import { authenticationModes, requiresUser, showsIdentity, usesPassword } from './auth'
import { environmentSchema } from './environments'

export const advancedDefaults: AdvancedConnectionOptions = {
  commandTimeout: 0, connectTimeout: 15, columnEncryption: false, secureEnclaves: false,
  attestationProtocol: 'None', enclaveAttestationUrl: '', multipleActiveResultSets: false,
  networkProtocol: 'default', packetSize: 8000, transactionBinding: 'Implicit Unbind', typeSystemVersion: 'Latest',
  connectRetryCount: 1, connectRetryInterval: 10, applicationName: 'Varia SQL Manager', workstationId: '',
  applicationIntent: 'ReadWrite', currentLanguage: '', replication: false, ipAddressPreference: 'IPv4First',
  serverCertificate: '', attachDbFilename: '', failoverPartner: '', failoverPartnerSpn: '',
  multiSubnetFailover: false, serverSpn: '', userInstance: false
}
/**
 * What OK in Advanced Properties stores: only the fields that differ from their defaults or that the user edited, so
 * the defaults (and Tools › Options' Execution time-out, for a command timeout left empty) keep applying to the rest.
 * A command timeout the profile already had stays, even when it is the default.
 */
export function advancedToStore(draft: Readonly<Record<keyof AdvancedConnectionOptions, unknown>>, edited: ReadonlySet<string>, previous: Partial<AdvancedConnectionOptions> = {}): Partial<AdvancedConnectionOptions> {
  const stored: Record<string, unknown> = {}
  for (const key of Object.keys(advancedDefaults) as (keyof AdvancedConnectionOptions)[]) {
    const value = draft[key]
    if (value === '' && key === 'commandTimeout') continue
    if (edited.has(key) || value !== advancedDefaults[key] || (key === 'commandTimeout' && previous.commandTimeout !== undefined)) stored[key] = value
  }
  return stored as Partial<AdvancedConnectionOptions>
}
/** Windows authentication on Windows, as SSMS opens; elsewhere SQL Server authentication, since integrated authentication
 *  there needs a Kerberos ticket (kinit) that most Linux and macOS machines do not have. Saved profiles keep their own choice. */
export function defaultAuthentication(platform: string): ConnectionOptions['authentication'] { return platform === 'win32' ? 'windows' : 'sql' }
export function connectionDefaults(platform: string): ConnectionOptions {
  return { server: 'localhost', database: '', authentication: defaultAuthentication(platform), trustServerCertificate: false, encrypt: 'mandatory' }
}
const text = z.string().max(128)
const path = z.string().max(1024)
export const advancedConnectionSchema = z.object({
  commandTimeout: z.number().int().min(0).max(86400), connectTimeout: z.number().int().min(0).max(3600),
  columnEncryption: z.boolean(), secureEnclaves: z.boolean(), attestationProtocol: z.enum(['None', 'HGS', 'AAS']), enclaveAttestationUrl: z.string().max(2048),
  multipleActiveResultSets: z.boolean(), networkProtocol: z.enum(['default', 'tcp', 'np', 'lpc']), packetSize: z.number().int().min(512).max(32767),
  transactionBinding: z.enum(['Implicit Unbind', 'Explicit Unbind']), typeSystemVersion: z.enum(['Latest', 'SQL Server 2008', 'SQL Server 2005', 'SQL Server 2000']),
  connectRetryCount: z.number().int().min(0).max(255), connectRetryInterval: z.number().int().min(1).max(60),
  applicationName: text, workstationId: text, applicationIntent: z.enum(['ReadWrite', 'ReadOnly']), currentLanguage: text,
  replication: z.boolean(), ipAddressPreference: z.enum(['IPv4First', 'IPv6First', 'UsePlatformDefault']),
  serverCertificate: path, attachDbFilename: path, failoverPartner: z.string().max(256), failoverPartnerSpn: z.string().max(512),
  multiSubnetFailover: z.boolean(), serverSpn: z.string().max(512), userInstance: z.boolean()
}).partial().strict()
export const connectionOptionsSchema = z.object({
  server: z.string().trim().min(1, 'Enter a server name.').max(256), database: z.string().trim().max(128), authentication: z.enum(authenticationModes),
  username: text.optional(), password: z.string().max(1024).optional(), trustServerCertificate: z.boolean(),
  encrypt: z.enum(['optional', 'mandatory', 'strict']).optional(), hostNameInCertificate: z.string().max(256).optional(),
  displayName: text.optional(), color: z.string().regex(/^#[\da-f]{6}$/i).optional(), environment: environmentSchema.optional(), advanced: advancedConnectionSchema.optional()
}).strict().refine(value => !requiresUser(value.authentication) || !!value.username?.trim(), { error: issue => (issue.input as ConnectionOptions).authentication === 'sql' ? 'SQL authentication requires a username.' : 'This authentication requires a user name.' })

// Persistence is built from a whitelist; neither passwords nor raw connection strings enter the file.
export function savedConnection(options: ConnectionOptions): Omit<ConnectionOptions, 'password'> {
  const { password: _password, ...parsed } = connectionOptionsSchema.parse(options)
  // Windows Authentication and Entra Integrated show the signed-in identity, which is not the profile's to keep.
  if (showsIdentity(parsed.authentication)) delete parsed.username
  return parsed
}
export interface ConnectionProfile { id: string; options: Omit<ConnectionOptions, 'password'>; favorite: boolean; registered: boolean; lastConnected?: string }
export interface ConnectionLibrary { version: 1; profiles: ConnectionProfile[] }
export interface ConnectionProfileInput { id?: string; options: ConnectionOptions; favorite?: boolean; registered?: boolean }
export const connectionProfileInputSchema = z.object({ id: z.uuid().optional(), options: connectionOptionsSchema, favorite: z.boolean().optional(), registered: z.boolean().optional() }).strict()
const savedOptionsSchema = connectionOptionsSchema.refine(value => value.password === undefined, 'Saved connections cannot contain passwords.')
export const connectionLibrarySchema = z.object({
  version: z.literal(1), profiles: z.array(z.object({ id: z.uuid(), options: savedOptionsSchema, favorite: z.boolean(), registered: z.boolean(), lastConnected: z.iso.datetime().optional() }).strict()).max(200)
}).strict().refine(value => new Set(value.profiles.map(profile => profile.id)).size === value.profiles.length, 'Duplicate connection IDs.')
export function connectionKey(options: ConnectionOptions): string {
  const clean = savedConnection(options)
  return JSON.stringify([clean.server.toLowerCase(), clean.database.toLowerCase(), clean.authentication, clean.username ?? '',
    clean.encrypt ?? 'mandatory', clean.trustServerCertificate, clean.hostNameInCertificate ?? '', { ...advancedDefaults, ...clean.advanced }])
}

/** Where the operating system can protect a remembered password; `reason` says why it cannot. */
export interface SecretStorageState { available: boolean; reason?: 'no-keyring' | 'unknown-backend' | 'unavailable' }
/** The authentication types whose password the Connect dialog can remember: those with an editable Password box, as SSMS
 *  (SQL Server Authentication, Microsoft Entra Password, and Service Principal's client secret). */
export function canRememberPassword(authentication: ConnectionOptions['authentication']): boolean { return usesPassword(authentication) }
/**
 * Everything that decides where a password goes and how the server is verified. A remembered password is sent only to
 * a request with the same binding, so changing the database, name, color or environment keeps it, and anything else needs it typed.
 */
export function credentialBinding(options: Omit<ConnectionOptions, 'password'>): string {
  return JSON.stringify([options.server.trim().toLowerCase(), options.authentication, options.username ?? '', options.encrypt ?? 'mandatory',
    options.encrypt !== 'strict' && options.trustServerCertificate, options.hostNameInCertificate ?? '', options.advanced?.serverCertificate ?? '',
    options.advanced?.failoverPartner ?? '', options.advanced?.networkProtocol ?? 'default'])
}
const recency = (profile: ConnectionProfile) => [profile.lastConnected ? 0 : profile.favorite ? 1 : 2, profile.lastConnected ?? ''] as const
/**
 * The saved entry whose remembered password the form would use: the selected entry when it has one for the same
 * credentials, otherwise the most recently connected such entry, then a favorite, then a registered one.
 */
export function rememberedProfile(profiles: readonly ConnectionProfile[], savedIds: ReadonlySet<string>, options: ConnectionOptions, selectedId?: string): ConnectionProfile | undefined {
  if (!canRememberPassword(options.authentication)) return undefined
  const binding = credentialBinding(options)
  const candidates = profiles.filter(profile => savedIds.has(profile.id) && credentialBinding(profile.options) === binding)
  const selected = candidates.find(profile => profile.id === selectedId)
  if (selected) return selected
  return candidates.sort((a, b) => { const [ra, la] = recency(a), [rb, lb] = recency(b); return ra - rb || lb.localeCompare(la) })[0]
}
/** The fourth argument of `varia:request`, for `connections.connect` and `.databases` only. `requestId` is what the
 *  dialog's Stop cancels the request by (varia:connections-cancel). */
export const connectContextSchema = z.object({ profileId: z.uuid().optional(), remember: z.boolean().optional(), requestId: z.uuid().optional() }).strict()
export type ConnectContext = z.infer<typeof connectContextSchema>
/** The library with the ids of the entries that have a remembered password; never the password or its ciphertext. */
export interface ConnectionLibraryView { library: ConnectionLibrary; savedPasswords: string[] }
