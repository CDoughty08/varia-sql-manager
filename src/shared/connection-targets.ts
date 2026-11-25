import { z } from 'zod'
import type { BigQueryConnectionOptions, ConnectionOptions, ProviderConnectionOptions } from './contracts'
import { requiresUser, showsIdentity, usesPassword } from './auth'
import { advancedConnectionSchema, bigQueryConnectionOptionsSchema, bigQueryLimits, connectionOptionsSchema, connectionPrincipalSchema, savedConnection } from './connections'
import { providerIds } from './providers'
import { environmentSchema } from './environments'

/** `explorerExpanded*`: Object Explorer's expanded nodes kept per server for the next start, bounded so the session file
 *  stays small (`explorerExpandedChars` across every server). */
export const connectionTargetLimits = { targets: 200, principalChars: 256, databaseChars: 128, bigQueryDatasetChars: bigQueryLimits.dataset, explorerExpanded: 128, explorerKeyChars: 1024, explorerExpandedChars: 262_144 } as const
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const uuid = z.uuid()
const optionalText = (schema: z.ZodType<string>) => z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, schema.optional())

export const autoReconnectPreferenceSchema = z.enum(['inherit', 'on', 'off'])
export type AutoReconnectPreference = z.infer<typeof autoReconnectPreferenceSchema>
export const connectionDetailsSchema = z.object({
  displayName: optionalText(z.string().trim().min(1).max(128).refine(value => !hidden.test(value), 'A connection name cannot contain control or formatting characters.')),
  color: optionalText(z.string().regex(/^#[\da-f]{6}$/i).transform(value => value.toLowerCase())),
  environment: optionalText(environmentSchema),
  autoReconnect: autoReconnectPreferenceSchema.default('inherit')
}).strict().readonly()
export type ConnectionDetails = z.infer<typeof connectionDetailsSchema>

const connectionShape = connectionOptionsSchema.shape
/** These settings describe the target. Its labels and credential references each have their own single home. SQL Server's
 *  branch; a missing `provider` (every 0.9.0 record) is SQL Server. */
export const sqlServerTargetOptionsSchema = z.object({
  provider: connectionShape.provider,
  server: connectionShape.server, database: connectionShape.database, authentication: connectionShape.authentication,
  username: connectionShape.username, trustServerCertificate: connectionShape.trustServerCertificate,
  encrypt: connectionShape.encrypt, hostNameInCertificate: connectionShape.hostNameInCertificate,
  advanced: advancedConnectionSchema.readonly().optional()
}).strict().refine(value => !requiresUser(value.authentication) || !!value.username?.trim(), 'This authentication requires a user name.')
  .refine(value => !showsIdentity(value.authentication) || value.username === undefined, 'The integrated account belongs in the expected principal, not the connection options.').readonly()
const bigQueryShape = bigQueryConnectionOptionsSchema.shape
/** BigQuery's branch: what the connection is, without its labels. `keyFile` stays an opaque reference here too. */
export const bigQueryTargetOptionsSchema = z.object({
  provider: bigQueryShape.provider, project: bigQueryShape.project, location: bigQueryShape.location, dataset: bigQueryShape.dataset,
  extraProjects: z.array(bigQueryShape.project).max(bigQueryLimits.extraProjects).readonly().optional(), authentication: bigQueryShape.authentication,
  keyFile: bigQueryShape.keyFile, impersonateServiceAccount: bigQueryShape.impersonateServiceAccount, maximumBytesBilled: bigQueryShape.maximumBytesBilled
}).strict().readonly()
/** The target's settings, discriminated on `provider`. A union has no `.shape`: schemas that need fields use a branch. */
export const connectionTargetOptionsSchema = z.union([sqlServerTargetOptionsSchema, bigQueryTargetOptionsSchema])
export type SqlServerTargetOptions = z.infer<typeof sqlServerTargetOptionsSchema>
export type BigQueryTargetOptions = z.infer<typeof bigQueryTargetOptionsSchema>
export type ConnectionTargetOptions = z.infer<typeof connectionTargetOptionsSchema>
export const isBigQueryTarget = (options: ConnectionTargetOptions): options is BigQueryTargetOptions => options.provider === 'bigquery'
/** Whether the target's authentication can use a remembered password: SQL Server's password modes only. */
export const targetUsesPassword = (options: ConnectionTargetOptions): boolean => !isBigQueryTarget(options) && usesPassword(options.authentication)
/** What a server-keyed display (a caption, a prompt) names the target by: SQL Server's server, BigQuery's project. */
export const targetServerName = (options: ConnectionTargetOptions): string => isBigQueryTarget(options) ? options.project : options.server
/** A target of SQL Server's: the only kind the workbench opens until the BigQuery lanes. Others stay in the workspace untouched. */
export const isSqlServerTarget = <T extends { readonly options: ConnectionTargetOptions }>(target: T): target is T & { readonly options: SqlServerTargetOptions } => !isBigQueryTarget(target.options)

/** The live request may carry a password. The snapshot never does, and validation rejects unknown connection fields. */
export function connectionTargetOptions(options: ConnectionOptions): SqlServerTargetOptions {
  const { displayName: _displayName, color: _color, environment: _environment, ...snapshot } = savedConnection(options)
  return sqlServerTargetOptionsSchema.parse(snapshot)
}
/** BigQuery's target settings: the options without their labels, in the schema's key order (so two equal ones encode alike). */
export function bigQueryTargetOptions(options: BigQueryConnectionOptions): BigQueryTargetOptions {
  const { displayName: _displayName, color: _color, environment: _environment, costPrompt: _costPrompt, costThreshold: _costThreshold, ...snapshot } = bigQueryConnectionOptionsSchema.parse(options)
  return bigQueryTargetOptionsSchema.parse(snapshot)
}
/** Either provider's target settings. */
export function targetOptionsOf(options: ProviderConnectionOptions): ConnectionTargetOptions {
  return options.provider === 'bigquery' ? bigQueryTargetOptions(options) : connectionTargetOptions(options)
}

export const connectionCredentialReferenceSchema = z.object({ profileId: uuid, revision: uuid }).strict().readonly()
export type ConnectionCredentialReference = z.infer<typeof connectionCredentialReferenceSchema>
/** A verified account identifier, never an access token or a password-derived fingerprint: SQL Server's mode and principal
 *  id, or BigQuery's project and pinned identity (connections.ts). The 0.9.0 spelling `sqlServer` reads as `sqlserver`. */
export const expectedConnectionPrincipalSchema = connectionPrincipalSchema.readonly()
export type ExpectedConnectionPrincipal = z.infer<typeof expectedConnectionPrincipalSchema>
export type SqlServerPrincipal = Extract<ExpectedConnectionPrincipal, { readonly provider: 'sqlserver' }>

/** Only main supplies this after authentication or verified live equivalence. Parsing does not establish that trust.
 *  Omission preserves the credential reference; null requests forgetting it under an explicit update operation. */
export const connectionAuthenticationSchema = z.object({
  principal: expectedConnectionPrincipalSchema, credential: connectionCredentialReferenceSchema.nullable().optional()
}).strict().readonly()
export type ConnectionAuthentication = z.infer<typeof connectionAuthenticationSchema>

/** A principal belongs to its own provider's target: SQL Server's to the same authentication mode, BigQuery's to the same project. */
export function principalFits(principal: ExpectedConnectionPrincipal, options: ConnectionTargetOptions): boolean {
  if (principal.provider === 'bigquery') return isBigQueryTarget(options) && principal.project === options.project
  return !isBigQueryTarget(options) && principal.authentication === options.authentication
}

/** Whether two verified accounts are the same: same provider, and the same mode and id, or the same project and identity. */
export function samePrincipal(left: ExpectedConnectionPrincipal, right: ExpectedConnectionPrincipal): boolean {
  if (left.provider === 'bigquery') return right.provider === 'bigquery' && left.project === right.project && left.principal === right.principal
  return right.provider === 'sqlserver' && left.authentication === right.authentication && left.id === right.id
}

export const persistedConnectionTargetSchema = z.object({
  id: uuid, options: connectionTargetOptionsSchema, details: connectionDetailsSchema,
  inExplorer: z.boolean(), resumeWanted: z.boolean(), profileId: uuid.optional(),
  credential: connectionCredentialReferenceSchema.optional(), expectedPrincipal: expectedConnectionPrincipalSchema.optional(),
  /** Object Explorer's expanded nodes below this server at the last close (connection-free ref keys, outermost first):
   *  a hint the tree restores as far as it still finds the nodes. */
  explorerExpanded: z.array(z.string().min(1).max(connectionTargetLimits.explorerKeyChars)).max(connectionTargetLimits.explorerExpanded).readonly().optional()
}).strict().refine(value => !value.expectedPrincipal || principalFits(value.expectedPrincipal, value.options), 'The expected account must use the target authentication mode.')
  .refine(value => !value.credential || targetUsesPassword(value.options), 'This authentication does not use a remembered password.').readonly()
export type PersistedConnectionTarget = z.infer<typeof persistedConnectionTargetSchema>

export const connectionWorkspaceSchema = z.object({
  version: z.literal(1), targets: z.array(persistedConnectionTargetSchema).max(connectionTargetLimits.targets).readonly(),
  /** Written with Object Explorer's expansion: a target without `explorerExpanded` then had none to keep, not an older file. */
  explorerExpansion: z.literal(true).optional()
}).strict().refine(value => new Set(value.targets.map(target => target.id)).size === value.targets.length, 'Duplicate connection target IDs.').readonly()
export type ConnectionWorkspace = z.infer<typeof connectionWorkspaceSchema>

/**
 * The workspace with Object Explorer's expanded nodes for the servers `expansion` names; the others keep what they had (a
 * server not connected this run). Keys past the per-key, per-server or total bounds are left out, outermost kept first.
 */
export function withExplorerExpansion(workspace: ConnectionWorkspace, expansion: ReadonlyMap<string, readonly string[] | null>): ConnectionWorkspace {
  let budget: number = connectionTargetLimits.explorerExpandedChars
  const bounded = (keys: readonly string[]) => {
    const kept: string[] = []
    for (const key of keys) {
      if (kept.length >= connectionTargetLimits.explorerExpanded) break
      if (!key || key.length > connectionTargetLimits.explorerKeyChars || key.length > budget) continue
      budget -= key.length
      kept.push(key)
    }
    return kept
  }
  const targets = workspace.targets.map(target => {
    // null: the tree dropped what it had for this server; absent: keep the last close's.
    const given = expansion.get(target.id), keys = given === null ? undefined : given ?? target.explorerExpanded
    const { explorerExpanded: _old, ...rest } = target
    return keys === undefined ? rest : { ...rest, explorerExpanded: bounded(keys) }
  })
  return connectionWorkspaceSchema.parse({ ...workspace, explorerExpansion: true, targets })
}

/** attachWanted distinguishes an attached query from a query deliberately disconnected while retaining its target.
 *  `provider` is the target's (absent in a 0.9.0 record: SQL Server); `database` is a dataset for BigQuery, with
 *  BigQuery's length, and has SQL Server's 128 characters otherwise. */
export const queryConnectionAssociationSchema = z.object({
  targetId: uuid, provider: z.enum(providerIds).optional(), database: z.string().max(connectionTargetLimits.bigQueryDatasetChars), attachWanted: z.boolean()
}).strict().refine(value => value.provider === 'bigquery' || value.database.length <= connectionTargetLimits.databaseChars, 'A database name has at most 128 characters.').readonly()
export type QueryConnectionAssociation = z.infer<typeof queryConnectionAssociationSchema>

/** Backend IDs are valid only within the generation that returned them. Neither field is a persistent target ID. */
export const backendConnectionHandleSchema = z.object({ id: uuid, generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().readonly()
export type BackendConnectionHandle = z.infer<typeof backendConnectionHandleSchema>
export const connectionFailureReasonSchema = z.enum([
  'credentials-required', 'sign-in-required', 'secret-storage-unavailable', 'network', 'certificate',
  'database-unavailable', 'identity-changed', 'cancelled', 'backend-lost', 'unknown'
])
export type ConnectionFailureReason = z.infer<typeof connectionFailureReasonSchema>
export const connectionLifecycleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disconnected'), reason: connectionFailureReasonSchema.optional() }).strict(),
  z.object({ state: z.literal('connecting'), attemptId: uuid }).strict(),
  z.object({ state: z.literal('connected'), handle: backendConnectionHandleSchema }).strict(),
  z.object({ state: z.literal('disconnecting'), handle: backendConnectionHandleSchema, attemptId: uuid }).strict(),
  z.object({ state: z.literal('lost'), reason: connectionFailureReasonSchema.default('backend-lost') }).strict()
]).readonly()
export type ConnectionLifecycle = z.infer<typeof connectionLifecycleSchema>
export type ConnectionTarget = PersistedConnectionTarget & { readonly lifecycle: ConnectionLifecycle }

export function isConnectedTarget(target: Pick<ConnectionTarget, 'lifecycle'>): boolean {
  return target.lifecycle.state === 'connected'
}

export function effectiveAutoReconnect(preference: AutoReconnectPreference, globalDefault = true): boolean {
  return preference === 'inherit' ? globalDefault : preference === 'on'
}
/** An override enables resuming a connection, never undoing an explicit Disconnect or Explorer removal. */
export function shouldAutoReconnect(target: Pick<PersistedConnectionTarget, 'details' | 'inExplorer' | 'resumeWanted'>, globalDefault = true): boolean {
  return target.inExplorer && target.resumeWanted && effectiveAutoReconnect(target.details.autoReconnect, globalDefault)
}

export const connectionDetailFields = ['displayName', 'color', 'environment', 'autoReconnect'] as const
export type ConnectionDetailField = typeof connectionDetailFields[number]
export const connectionDetailLabels: Readonly<Record<ConnectionDetailField, string>> = {
  displayName: 'Name', color: 'Color', environment: 'Environment', autoReconnect: 'Startup reconnect'
}
export const connectionDetailsConfirmation = {
  title: 'Use selected connection details?',
  useSelected: 'Use Selected Details', keepCurrent: 'Keep Current Details', cancel: 'Cancel'
} as const
/** Favorites belong to profiles. Every differing Explorer detail receives the same explicit confirmation. */
export function changedConnectionDetails(current: ConnectionDetails, selected: ConnectionDetails): ConnectionDetailField[] {
  const before = connectionDetailsSchema.parse(current), after = connectionDetailsSchema.parse(selected)
  return connectionDetailFields.filter(field => before[field] !== after[field])
}
