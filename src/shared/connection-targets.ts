import { z } from 'zod'
import type { ConnectionOptions } from './contracts'
import { authenticationModes, requiresUser, showsIdentity, usesPassword } from './auth'
import { advancedConnectionSchema, connectionOptionsSchema, savedConnection } from './connections'
import { environmentSchema } from './environments'

/** `explorerExpanded*`: Object Explorer's expanded nodes kept per server for the next start, bounded so the session file
 *  stays small (`explorerExpandedChars` across every server). */
export const connectionTargetLimits = { targets: 200, principalChars: 256, databaseChars: 128, explorerExpanded: 128, explorerKeyChars: 1024, explorerExpandedChars: 262_144 } as const
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
/** These settings describe the target. Its labels and credential references each have their own single home. */
export const connectionTargetOptionsSchema = z.object({
  server: connectionShape.server, database: connectionShape.database, authentication: connectionShape.authentication,
  username: connectionShape.username, trustServerCertificate: connectionShape.trustServerCertificate,
  encrypt: connectionShape.encrypt, hostNameInCertificate: connectionShape.hostNameInCertificate,
  advanced: advancedConnectionSchema.readonly().optional()
}).strict().refine(value => !requiresUser(value.authentication) || !!value.username?.trim(), 'This authentication requires a user name.')
  .refine(value => !showsIdentity(value.authentication) || value.username === undefined, 'The integrated account belongs in the expected principal, not the connection options.').readonly()
export type ConnectionTargetOptions = z.infer<typeof connectionTargetOptionsSchema>

/** The live request may carry a password. The snapshot never does, and validation rejects unknown connection fields. */
export function connectionTargetOptions(options: ConnectionOptions): ConnectionTargetOptions {
  const { displayName: _displayName, color: _color, environment: _environment, ...snapshot } = savedConnection(options)
  return connectionTargetOptionsSchema.parse(snapshot)
}

export const connectionCredentialReferenceSchema = z.object({ profileId: uuid, revision: uuid }).strict().readonly()
export type ConnectionCredentialReference = z.infer<typeof connectionCredentialReferenceSchema>
/** A verified account identifier, never an access token or a password-derived fingerprint. */
export const expectedConnectionPrincipalSchema = z.object({
  provider: z.literal('sqlServer'), authentication: z.enum(authenticationModes),
  id: z.string().min(1).max(connectionTargetLimits.principalChars).refine(value => !!value.trim() && !hidden.test(value), 'An account identifier must be a visible single line.')
}).strict().readonly()
export type ExpectedConnectionPrincipal = z.infer<typeof expectedConnectionPrincipalSchema>

/** Only main supplies this after authentication or verified live equivalence. Parsing does not establish that trust.
 *  Omission preserves the credential reference; null requests forgetting it under an explicit update operation. */
export const connectionAuthenticationSchema = z.object({
  principal: expectedConnectionPrincipalSchema, credential: connectionCredentialReferenceSchema.nullable().optional()
}).strict().readonly()
export type ConnectionAuthentication = z.infer<typeof connectionAuthenticationSchema>

export const persistedConnectionTargetSchema = z.object({
  id: uuid, options: connectionTargetOptionsSchema, details: connectionDetailsSchema,
  inExplorer: z.boolean(), resumeWanted: z.boolean(), profileId: uuid.optional(),
  credential: connectionCredentialReferenceSchema.optional(), expectedPrincipal: expectedConnectionPrincipalSchema.optional(),
  /** Object Explorer's expanded nodes below this server at the last close (connection-free ref keys, outermost first):
   *  a hint the tree restores as far as it still finds the nodes. */
  explorerExpanded: z.array(z.string().min(1).max(connectionTargetLimits.explorerKeyChars)).max(connectionTargetLimits.explorerExpanded).readonly().optional()
}).strict().refine(value => !value.expectedPrincipal || value.expectedPrincipal.authentication === value.options.authentication, 'The expected account must use the target authentication mode.')
  .refine(value => !value.credential || usesPassword(value.options.authentication), 'This authentication does not use a remembered password.').readonly()
export type PersistedConnectionTarget = z.infer<typeof persistedConnectionTargetSchema>

export const connectionWorkspaceSchema = z.object({
  version: z.literal(1), targets: z.array(persistedConnectionTargetSchema).max(connectionTargetLimits.targets).readonly()
}).strict().refine(value => new Set(value.targets.map(target => target.id)).size === value.targets.length, 'Duplicate connection target IDs.').readonly()
export type ConnectionWorkspace = z.infer<typeof connectionWorkspaceSchema>

/**
 * The workspace with Object Explorer's expanded nodes for the servers `expansion` names; the others keep what they had (a
 * server not connected this run). Keys past the per-key, per-server or total bounds are left out, outermost kept first.
 */
export function withExplorerExpansion(workspace: ConnectionWorkspace, expansion: ReadonlyMap<string, readonly string[]>): ConnectionWorkspace {
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
    const keys = expansion.get(target.id) ?? target.explorerExpanded
    const { explorerExpanded: _old, ...rest } = target
    return keys === undefined ? rest : { ...rest, explorerExpanded: bounded(keys) }
  })
  return connectionWorkspaceSchema.parse({ ...workspace, targets })
}

/** attachWanted distinguishes an attached query from a query deliberately disconnected while retaining its target. */
export const queryConnectionAssociationSchema = z.object({
  targetId: uuid, database: z.string().max(connectionTargetLimits.databaseChars), attachWanted: z.boolean()
}).strict().readonly()
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
