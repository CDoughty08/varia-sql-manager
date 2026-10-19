import { z } from 'zod'
import type { AdvancedConnectionOptions, ConnectionOptions } from './contracts'

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
  server: z.string().trim().min(1, 'Enter a server name.').max(256), database: z.string().trim().max(128), authentication: z.enum(['windows', 'sql']),
  username: text.optional(), password: z.string().max(1024).optional(), trustServerCertificate: z.boolean(),
  encrypt: z.enum(['optional', 'mandatory', 'strict']).optional(), hostNameInCertificate: z.string().max(256).optional(),
  displayName: text.optional(), color: z.string().regex(/^#[\da-f]{6}$/i).optional(), advanced: advancedConnectionSchema.optional()
}).strict().refine(value => value.authentication !== 'sql' || !!value.username?.trim(), 'SQL authentication requires a username.')

// Persistence is built from a whitelist; neither passwords nor raw connection strings enter the file.
export function savedConnection(options: ConnectionOptions): Omit<ConnectionOptions, 'password'> {
  const { password: _password, ...parsed } = connectionOptionsSchema.parse(options)
  if (parsed.authentication === 'windows') delete parsed.username
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
