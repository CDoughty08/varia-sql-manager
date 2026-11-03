// Strict zod schemas for object actions, and the shapes of their results. Main validates every request with them before
// the backend re-checks it against the catalogue and the subtype it derives itself in the action's own connection.
import { z } from 'zod'
import { kindSpecs } from '../explorer/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident, objectRefSchema } from '../explorer/schema.ts'
import {
  actionDescribeIds, actionDescribeSpecs, actionDialog, actionErrorCodes, actionLimits, actionOffered, actionVerb, dialogIds, dialogSpecs, isCreateAction, isKindDialogAction, kindDialogActionSpecs, objectActionSpecs,
  type ActionErrorCode, type DialogAction, type DialogId, type ObjectAction
} from './catalog.ts'
import {
  isSystemLoginName, loginDatabaseRolesDescribe, loginLimits, loginMappingChanges, loginMessages, loginPropertiesStatements, newLoginAuths, newLoginStatements, publicRole, tooManyStatementsMessage, unlockModes,
  windowsLoginName, type LoginChanges, type LoginDatabaseRoles, type LoginFacts, type LoginLockFacts, type LoginMappings, type LoginPropertiesFacts, type LoginSecrets, type LoginStatusChoice, type NewLoginGeneral,
  type NewLoginModel, type UnlockMode, type UserMappingChoice
} from './logins.ts'
import { wellFormed } from '../ssis/schema.ts'
import { optionDef, settableOptionKeys, settableScopedKeys, tokenProblem, type FileType, type Growth } from './database.ts'
import { designerDescribeIds } from '../designer/catalog.ts'
import { createTableSchema, type CreateTableRequest, type TableDesignerModel } from '../designer/schema.ts'

/** What actions.describe describes: an object dialog (PR17's catalogue), a designer (src/shared/designer/catalog.ts), one
 *  database's roles and schemas for New Login's User Mapping page (logins.ts loginDatabaseRolesDescribe), or an object's
 *  facts without a dialog (the login actions' loginFacts). */
export const describeIds = [...dialogIds, ...designerDescribeIds, loginDatabaseRolesDescribe, ...actionDescribeIds] as const
export type DescribeId = typeof describeIds[number]

/** `login`: the login whose user User Mapping's read of a database (loginDatabaseRoles) reads too (Login Properties, D2c); no other describe takes it. */
export interface ActionDescribeRequest { readonly connectionId: string; readonly requestId: string; readonly dialog: DescribeId; readonly target: ObjectRef; readonly login?: string }
export interface RenameRequest { readonly action: 'rename'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly newName: string }
/**
 * `closeConnections` (SET SINGLE_USER WITH ROLLBACK IMMEDIATE first) and `deleteHistory` apply to databases only; `dropMappedUsers`
 * (DROP USER in each database first, D4c) and `loginIdentity` (the login Delete Object read) to logins only.
 */
export interface DeleteRequest {
  readonly action: 'delete'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly closeConnections: boolean; readonly deleteHistory: boolean
  readonly dropMappedUsers?: boolean; readonly loginIdentity?: LoginIdentity
}
/** Database Properties' changes, only what differs from the describe: options and scoped configurations by key, as tokens. */
export interface DatabaseChanges {
  readonly owner?: string
  readonly options?: Readonly<Record<string, string>>
  readonly scoped?: Readonly<Record<string, string>>
}
/**
 * The database Database Properties read: its database_id and its create_date as the describe writes it. A document stays
 * open while Object Explorer renames, drops or restores databases, so the preflight refuses a database that has taken the
 * name since rather than change it in place of the one that was read.
 */
export interface DatabaseIdentity { readonly id: number; readonly created: string }
/** Database Properties' OK and Script. `closeConnections` (WITH ROLLBACK IMMEDIATE) only with a change SSMS closes connections for. */
export interface PropertiesRequest {
  readonly action: 'properties'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly closeConnections: boolean; readonly changes: DatabaseChanges
  readonly identity?: DatabaseIdentity
}
/**
 * New Login's OK and Script (D2a, D2b): the General page, the server roles to join (public never: every login is a member), the
 * databases User Mapping maps (each at most once), and the Status page. `secrets` carries the password of a SQL login on actions.execute only; the script schema refuses it.
 * The target is the server.
 */
export interface CreateLoginRequest {
  readonly action: 'createLogin'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef
  readonly login: NewLoginGeneral
  readonly serverRoles: readonly string[]
  readonly mappings: readonly UserMappingChoice[]
  readonly status: LoginStatusChoice
  readonly secrets?: LoginSecrets
}
/**
 * The login the loginFacts describe read: its SID (hexadecimal, at most loginLimits.sidHex characters) and create_date as the
 * describe writes it. The preflight refuses a principal that has taken the name since, whose facts the confirmation never showed.
 */
export interface LoginIdentity { readonly sid: string; readonly created: string }
/** A login's Disable or Enable (D4b): ALTER LOGIN … DISABLE or ENABLE in master, of the login its facts were read from. */
export interface LoginStateRequest { readonly action: 'disable' | 'enable'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly loginIdentity?: LoginIdentity }
/**
 * Unlock Login (D4d): turns the password policy off and on again in one transaction, which unlocks the login and keeps its
 * password. No password crosses for it; the identity is the login Unlock…'s describe read.
 */
export interface UnlockRequest { readonly action: 'unlock'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly mode: UnlockMode; readonly loginIdentity?: LoginIdentity }
/**
 * Login Properties (D2c): only what differs from its describe (`loginChanges`; C#'s Changes and Identity are Database Properties'),
 * the login it read (`loginIdentity`, required on actions.execute), and on actions.execute only the new password and, with Specify
 * old password, the old one.
 */
export interface LoginPropertiesRequest {
  readonly action: 'loginProperties'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef
  readonly loginIdentity?: LoginIdentity; readonly loginChanges: LoginChanges; readonly secrets?: LoginSecrets
}
/** One action: actions.script returns its script, actions.execute runs it. */
export type ActionRequest = RenameRequest | DeleteRequest | PropertiesRequest | CreateTableRequest | CreateLoginRequest | LoginStateRequest | UnlockRequest | LoginPropertiesRequest
export interface ActionCancelRequest { readonly requestIds: readonly string[] }

export interface ActionError { readonly code: ActionErrorCode; readonly message: string; readonly retryable: boolean }
/** Something that stops or affects the DROP; `blocking` ones make it fail until they are dealt with. */
export interface ActionWarning { readonly text: string; readonly blocking: boolean }
/** The Delete Object dialog's row: SSMS's Object Name, Object Type and Owner, and what it found in the way. */
export interface DeleteTarget {
  readonly name: string
  readonly type: string
  readonly owner?: string
  readonly warnings: readonly ActionWarning[]
  /** More dependents exist than the 100 per kind listed. */
  readonly dependentsTruncated: boolean
  readonly isSnapshot?: boolean
  /** Sessions in the database or with a transaction in it; absent without VIEW SERVER STATE. */
  readonly sessions?: number
  /** Those with an open transaction, which Close existing connections rolls back; absent without VIEW SERVER STATE. */
  readonly withTransaction?: number
  /** The sessions a DROP waits for, at most `actionLimits.blockers` (never Varia's own pooled sessions); absent without VIEW SERVER STATE. */
  readonly blockers?: readonly DatabaseBlocker[]
  /** More sessions exist than `blockers` lists. */
  readonly blockersTruncated?: boolean
  /** Why Close existing connections is unavailable (Managed Instance cannot set SINGLE_USER; an offline database has no connections). */
  readonly closeConnectionsNote?: string
  /** Varia's query tabs (their session ids) whose session holds an open transaction in the database or while in it, whatever database the tab is in (A7). */
  readonly transactionTabs?: readonly string[]
  /** A login (D4c): its facts with what it owns (the warnings say what blocks the DROP), and the database users mapped to it. */
  readonly login?: LoginFacts
  readonly mappings?: LoginMappings
}
/** A session in a database that Delete Object lists; program and host are clipped to `actionLimits.blockerChars`. */
export interface DatabaseBlocker {
  readonly sessionId: number
  readonly program?: string
  readonly host?: string
  readonly openTransaction: boolean
}
/** Database Properties' General page. Sizes in MB; dates in ISO 8601. A backup date of 'None' means no history; absent is unknown. */
export interface DatabaseGeneral {
  readonly name: string
  /** sys.databases state_desc (ONLINE, RESTORING, …); databaseStatusText words it as SMO does. */
  readonly status: string
  readonly standby?: boolean
  readonly owner?: string
  readonly created: string
  readonly sizeMb: number
  readonly spaceAvailableMb?: number
  readonly users?: number
  readonly lastBackup?: string
  readonly lastLogBackup?: string
  readonly collation?: string
  readonly memoryAllocatedMb?: number
  readonly memoryUsedMb?: number
  /** sys.databases database_id: with `created`, which database was read (DatabaseIdentity). */
  readonly id?: number
}
export interface DatabaseFile {
  readonly name: string
  readonly type: FileType
  readonly filegroup?: string
  readonly sizeMb: number
  readonly growth: Growth
  readonly path: string
  readonly fileName: string
  readonly isPrimary: boolean
}
export interface DatabaseFilegroup {
  readonly name: string
  readonly type: 'rows' | 'filestream' | 'memoryOptimized'
  readonly files: number
  readonly readOnly: boolean
  readonly isDefault: boolean
  /** Band 13 and later. */
  readonly autogrowAllFiles?: boolean
}
export interface DatabaseServerFacts {
  /** The version band (13 = SQL Server 2016 … 17 = 2025). */
  readonly level: number
  readonly sysadmin: boolean
  /** SERVERPROPERTY('FilestreamEffectiveLevel'): 0 off … 3. */
  readonly filestreamLevel: number
  readonly pathSeparator: '\\' | '/'
  readonly edition: number
  /** sp_configure 'contained database authentication': Partial containment needs it. */
  readonly containedAuthentication: boolean
}
/** What Database Properties shows: the facts, every option as a token, and the choices its lists offer. */
export interface DatabasePropertiesModel {
  readonly general: DatabaseGeneral
  readonly options: Readonly<Record<string, string>>
  readonly scoped: Readonly<Record<string, string>>
  readonly compatibilityLevels: readonly number[]
  readonly collations: readonly string[]
  readonly logins: readonly string[]
  readonly files: readonly DatabaseFile[]
  readonly filesTruncated: boolean
  readonly filegroups: readonly DatabaseFilegroup[]
  readonly filegroupsTruncated: boolean
  readonly server: DatabaseServerFacts
  /** Sessions in the database; absent without VIEW SERVER STATE. */
  readonly sessions?: number
  /** Why nothing can change: a snapshot, a database that is not online or not accessible, or Managed Instance. */
  readonly readOnlyReason?: string
}
export interface ActionDescribeResult {
  readonly deleteTarget?: DeleteTarget; readonly elapsedMs: number; readonly error?: ActionError; readonly databaseProperties?: DatabasePropertiesModel; readonly tableDesigner?: TableDesignerModel
  readonly newLogin?: NewLoginModel
  readonly loginDatabaseRoles?: LoginDatabaseRoles
  /** loginFacts and unlockLogin: what the login preflight read, which the renderer checks against logins.ts' rules before it asks or runs. */
  readonly login?: LoginFacts
  /** unlockLogin and loginProperties: the login's lock-out state (ActionSql.LoginLock; a SQL Server login's only, for loginProperties). */
  readonly lock?: LoginLockFacts
  /** loginProperties (with newLogin's lists and login): the login's defaults, server roles and mapped users. */
  readonly loginProperties?: LoginPropertiesFacts
}
export interface ActionScriptResult {
  /** Absent with `error`; at most `actionLimits.scriptChars` characters. */
  readonly text?: string
  /** The database a new query window should use: `master` for database actions, else the object's. */
  readonly database: string
  readonly warnings: readonly string[]
  readonly error?: ActionError
}
/** A step's status. 'rolledBack': it completed in a transaction that a later failure or Stop rolled back (runner v2's transaction mode). */
export const actionStepStatuses = ['done', 'failed', 'skipped', 'cancelled', 'rolledBack'] as const
export type ActionStepStatus = typeof actionStepStatuses[number]
/**
 * One step of an action's reply. `title` says what it does (constant text); `message` is SQL Server's text for a failed
 * step; `detail` names what it acts on (a role, database or credential, never a secret); `compensates` marks a step that
 * undid an earlier one's change, or cleaned up, after a failure or Stop; `progress` is a long step's percent done.
 */
export interface ActionStep {
  readonly status: ActionStepStatus
  readonly title: string
  readonly message?: string
  readonly detail?: string
  readonly compensates?: boolean
  readonly progress?: number
}
/** The title of a database Delete's DROP step (ActionService.StepTitle in the backend; tests/delete-database.test.ts keeps them equal):
 *  a reply in which it is 'done' removed the database, even when a later step failed. */
export const dropDatabaseStepTitle = 'Drop the database'
/** The title of a login Delete's step per mapped user (ActionService.StepTitle; tests/delete-login.test.ts keeps them equal): its
 *  `detail` is "database: user", and a done one changed that database's Users folder. */
export const dropUserStepTitle = 'Drop the database user'
export interface ActionExecuteResult {
  /** One per statement, in order: the first failure stops the rest, which are 'skipped'. */
  readonly steps: readonly ActionStep[]
  /** SQL Server's informational messages (sp_rename's caution), at most 32 of 512 characters. */
  readonly messages: readonly string[]
  readonly elapsedMs: number
  readonly error?: ActionError
  /** A login action's target: the sessions connected as the login when it ran, which a Disable leaves connected; absent
   *  without VIEW SERVER STATE. */
  readonly sessions?: number
}

// Objects in these schemas, and these databases, are SQL Server's own; the backend re-checks by catalog (is_ms_shipped,
// database_id), so this only stops an obviously wrong request early.
const systemSchemas: ReadonlySet<string> = new Set(['sys', 'INFORMATION_SCHEMA'])
const systemDatabases: ReadonlySet<string> = new Set(['master', 'model', 'msdb', 'tempdb'])
/** A server ref: what a create action on a server object (a login) names as its target. */
const isServer = (ref: ObjectRef) => ref.kind === 'server' && Object.keys(ref).length === 1
const verbs: Readonly<Record<ObjectAction, string>> = { selectTop: 'selected from', rename: 'renamed', delete: 'deleted', properties: 'shown in Properties', disable: 'disabled', enable: 'enabled', unlock: 'unlocked' }
/** Why a dialog cannot open on `ref`, or run its action there: a kind dialog action (Login Properties) on another kind, or a verb's
 *  own dialog (Database Properties) on a kind with its own; then the verb's target rules. */
export function dialogTargetProblems(ref: ObjectRef, action: DialogAction, dialog?: DialogId): string[] {
  const verb = actionVerb(action)
  if (!verb) return []
  if (isKindDialogAction(action) ? ref.kind !== kindDialogActionSpecs[action].kind : actionOffered(ref.kind, verb) && actionDialog(ref.kind, verb) !== (dialog ?? objectActionSpecs[verb].dialog))
    return [`A ${ref.kind} has its own ${objectActionSpecs[verb].title}.`]
  return actionTargetProblems(ref, verb)
}
const systemLogin = (ref: ObjectRef) => ref.kind === 'login' && isSystemLoginName(ref.name ?? '')
/** Why `action` cannot act on `ref` whatever its subtype: a kind that never offers it, or one of SQL Server's own objects
 *  (unless the action serves them, as Properties does). */
export function actionTargetProblems(ref: ObjectRef, action: ObjectAction): string[] {
  if (!actionOffered(ref.kind, action)) return [`A ${ref.kind} cannot be ${verbs[action]}.`]
  if (objectActionSpecs[action].systemObjects) return []
  // SQL Server's own logins by name, as the Logins folder tells them; the backend re-derives the subtype in its preflight.
  if (systemLogin(ref)) return ['This login belongs to SQL Server and cannot be changed.']
  if (ref.kind === 'database' ? systemDatabases.has(ref.name ?? '') : ref.schema !== undefined && systemSchemas.has(ref.schema)) return ['System objects cannot be changed.']
  return []
}

const issue = (context: z.RefinementCtx, path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
const targetIssues = (context: z.RefinementCtx, target: ObjectRef, action: ObjectAction) => { for (const message of actionTargetProblems(target, action)) issue(context, 'target', message) }

export const actionDescribeSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid(), dialog: z.enum(describeIds), target: objectRefSchema, login: ident.optional() }).strict()
  .superRefine((request, context) => {
    if (request.login !== undefined && request.dialog !== loginDatabaseRolesDescribe) issue(context, 'login', 'Only User Mapping\'s read of a database names a login.')
    switch (request.dialog) {
      // A new table goes in any database, SQL Server's own included, as in SSMS.
      case 'tableDesigner':
        if (request.target.kind !== 'database' || request.target.parent) issue(context, 'target', 'The table designer opens on a database.')
        break
      case 'newLogin':
        if (!isServer(request.target)) issue(context, 'target', 'New Login opens on a server.')
        break
      // Any database, SQL Server's own included: a login may be mapped to master or msdb, as in SSMS.
      case loginDatabaseRolesDescribe:
        if (request.target.kind !== 'database' || request.target.parent) issue(context, 'target', 'User Mapping reads a database.')
        break
      case 'loginFacts':
        if (request.target.kind !== actionDescribeSpecs.loginFacts.kind) issue(context, 'target', 'Login facts describe a login.')
        targetIssues(context, request.target, actionDescribeSpecs.loginFacts.action)
        break
      default:
        for (const message of dialogTargetProblems(request.target, dialogSpecs[request.dialog].action, request.dialog)) issue(context, 'target', message)
    }
  }) satisfies z.ZodType<ActionDescribeRequest>

/** Option and scoped-configuration changes: known settable keys, each with a token of that option. */
const tokens = (keys: readonly string[]) => z.record(z.string().max(64), z.string().min(1).max(128)).superRefine((record, context) => {
  for (const [key, token] of Object.entries(record)) {
    const def = keys.includes(key) ? optionDef(key) : undefined
    const problem = def ? tokenProblem(def, token) : 'Unknown option.'
    if (problem) context.addIssue({ code: 'custom', path: [key], message: problem })
  }
})
const changesSchema = z.object({ owner: ident.optional(), options: tokens(settableOptionKeys).optional(), scoped: tokens(settableScopedKeys).optional() }).strict()
const exclusiveChange = (changes: DatabaseChanges) => Object.keys(changes.options ?? {}).some(key => optionDef(key)?.exclusive)
/** How many statements a change set plans at most: one per option (incremental statistics shares one) and scoped configuration, and the owner. */
export const plannedStatements = (changes: DatabaseChanges) => Object.keys(changes.options ?? {}).length + Object.keys(changes.scoped ?? {}).length + (changes.owner === undefined ? 0 : 1)

// One schema per action, one per line, so later actions append cleanly.
const renameSchema = z.object({ action: z.literal('rename'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, newName: ident }).strict()
// create_date as the backend writes it (yyyy-MM-ddTHH:mm:ss.fff); without the m flag, $ refuses a final line break too.
const identitySchema = z.object({ id: z.number().int().min(1).max(2_147_483_647), created: z.string().max(23).regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/) }).strict()
const loginIdentitySchema = z.object({ sid: z.string().max(loginLimits.sidHex).regex(/^[0-9A-F]{2,172}$/), created: identitySchema.shape.created }).strict()
const deleteSchema = z.object({
  action: z.literal('delete'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, closeConnections: z.boolean(), deleteHistory: z.boolean(),
  dropMappedUsers: z.boolean().optional(), loginIdentity: loginIdentitySchema.optional()
}).strict()
const loginStateSchema = z.object({ action: z.enum(['disable', 'enable']), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, loginIdentity: loginIdentitySchema.optional() }).strict()
const unlockSchema = z.object({ action: z.literal('unlock'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, mode: z.enum(unlockModes), loginIdentity: loginIdentitySchema.optional() }).strict()
const propertiesSchema = z.object({ action: z.literal('properties'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, closeConnections: z.boolean(), changes: changesSchema, identity: identitySchema.optional() }).strict()
/** A password: at most loginLimits.password UTF-16 code units (as C# counts them), no NUL, well formed. A quote is fine
 *  (SQL Server's builder doubles it); blank is allowed where the server's policy decides (newLoginProblem). */
export const loginPassword = z.string().refine(value => value.length <= loginLimits.password, `At most ${loginLimits.password} UTF-16 code units.`)
  .refine(value => !value.includes('\0'), 'The password cannot contain a NUL character.').refine(wellFormed, 'The password holds a broken character (half of a surrogate pair).')
const loginSecretsSchema = z.object({ password: loginPassword.optional(), oldPassword: loginPassword.optional() }).strict() satisfies z.ZodType<LoginSecrets>
const newLoginGeneralSchema = z.object({
  auth: z.enum(newLoginAuths), name: ident, defaultDatabase: ident, defaultLanguage: ident.optional(), checkPolicy: z.boolean().optional(), checkExpiration: z.boolean().optional(),
  mustChange: z.boolean().optional()
}).strict() satisfies z.ZodType<NewLoginGeneral>
const userMappingSchema = z.object({ database: ident, user: ident, defaultSchema: ident.optional(), rolesAdd: z.array(ident).max(loginLimits.roles) }).strict() satisfies z.ZodType<UserMappingChoice>
const createLoginSchema = z.object({
  action: z.literal('createLogin'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, login: newLoginGeneralSchema,
  serverRoles: z.array(ident).max(loginLimits.serverRoles), mappings: z.array(userMappingSchema).max(loginLimits.mappings), status: z.object({ connect: z.enum(['grant', 'deny']), enabled: z.boolean() }).strict(), secrets: loginSecretsSchema.optional()
}).strict()
const roleNames = (limit: number) => z.array(ident).max(limit)
const loginMappingChangeSchema = z.object({
  database: ident, change: z.enum(loginMappingChanges), user: ident, newName: ident.optional(), defaultSchema: ident.optional(), rolesAdd: roleNames(loginLimits.roles).optional(), rolesDrop: roleNames(loginLimits.roles).optional()
}).strict()
const loginChangesSchema = z.object({
  defaultDatabase: ident.optional(), defaultLanguage: ident.optional(), checkPolicy: z.boolean().optional(), checkExpiration: z.boolean().optional(),
  password: z.object({ oldPassword: z.boolean(), unlock: z.boolean(), mustChange: z.boolean() }).strict().optional(),
  rolesAdd: roleNames(loginLimits.serverRoles).optional(), rolesDrop: roleNames(loginLimits.serverRoles).optional(), mappings: z.array(loginMappingChangeSchema).max(loginLimits.mappings).optional(),
  connect: z.enum(['grant', 'deny']).optional(), enabled: z.boolean().optional()
}).strict() satisfies z.ZodType<LoginChanges>
const loginPropertiesSchema = z.object({
  action: z.literal('loginProperties'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, loginIdentity: loginIdentitySchema.optional(), loginChanges: loginChangesSchema,
  secrets: loginSecretsSchema.optional()
}).strict()
const distinct = (values: readonly string[] | undefined) => !values || new Set(values).size === values.length
const overlap = (a: readonly string[] | undefined, b: readonly string[] | undefined) => !!a && !!b && a.some(value => b.includes(value))
/** Login Properties' rules beyond the shapes (C#: ActionService.ValidateLoginProperties): the policy chain where both are sent, the old
 *  password without UNLOCK and MUST_CHANGE, roles that are distinct, not public and never both added and dropped, each database once
 *  with a change of its kind, and between one and actionLimits.statements statements. */
function loginPropertiesIssues(request: z.infer<typeof loginPropertiesSchema>, context: z.RefinementCtx): void {
  const changes = request.loginChanges
  if (changes.checkExpiration === true && changes.checkPolicy === false) issue(context, 'loginChanges', 'Enforce password expiration needs Enforce password policy.')
  if (changes.password?.oldPassword && (changes.password.unlock || changes.password.mustChange)) issue(context, 'loginChanges', 'The old password goes without UNLOCK and MUST_CHANGE.')
  const roles = [changes.rolesAdd, changes.rolesDrop, ...(changes.mappings ?? []).flatMap(mapping => [mapping.rolesAdd, mapping.rolesDrop])]
  if (roles.some(list => list?.includes(publicRole))) issue(context, 'loginChanges', 'Every login and user is a member of public.')
  if (!roles.every(distinct)) issue(context, 'loginChanges', 'Duplicate role.')
  if (overlap(changes.rolesAdd, changes.rolesDrop) || (changes.mappings ?? []).some(mapping => overlap(mapping.rolesAdd, mapping.rolesDrop))) issue(context, 'loginChanges', 'A role is both added and dropped.')
  if (!distinct((changes.mappings ?? []).map(mapping => mapping.database))) issue(context, 'loginChanges', 'A database changes twice.')
  for (const mapping of changes.mappings ?? []) {
    const valid = mapping.change === 'unmap' ? mapping.newName === undefined && mapping.defaultSchema === undefined && mapping.rolesAdd === undefined && mapping.rolesDrop === undefined
      : mapping.change === 'map' ? mapping.newName === undefined && mapping.rolesDrop === undefined
        : mapping.newName !== mapping.user && (mapping.newName !== undefined || mapping.defaultSchema !== undefined || !!mapping.rolesAdd?.length || !!mapping.rolesDrop?.length)
    if (!valid) issue(context, 'loginChanges', `A ${mapping.change} change of a database carries what it does not take.`)
  }
  const count = loginPropertiesStatements(changes)
  if (count === 0) issue(context, 'loginChanges', 'There is nothing to change.')
  if (count > actionLimits.statements) issue(context, 'loginChanges', tooManyStatementsMessage(actionLimits.statements))
}
/** New Login's rules beyond the shapes: the server as its target, the auth's own fields and SQL Server's policy chain, the
 *  login name's backslash rule, roles that are unique and not public, each database mapped once with unique roles other than
 *  public, and a plan of at most actionLimits.statements statements. */
function createLoginIssues(request: z.infer<typeof createLoginSchema>, context: z.RefinementCtx): void {
  const { login } = request
  if (!isServer(request.target)) issue(context, 'target', 'A login is created on a server.')
  if (login.auth === 'sql') {
    if (login.checkPolicy === undefined || login.checkExpiration === undefined || login.mustChange === undefined) issue(context, 'login', 'A SQL Server login states its password policy options.')
    if (login.checkExpiration && !login.checkPolicy) issue(context, 'login', 'Enforce password expiration needs Enforce password policy.')
    if (login.mustChange && !login.checkExpiration) issue(context, 'login', 'User must change password at next login needs Enforce password expiration.')
    if (login.name.includes('\\')) issue(context, 'login', 'A SQL Server login name cannot contain a backslash.')
  } else {
    if (login.checkPolicy !== undefined || login.checkExpiration !== undefined || login.mustChange !== undefined) issue(context, 'login', 'Only a SQL Server login has password policy options.')
    if (!windowsLoginName.test(login.name)) issue(context, 'login', 'A Windows login is named DOMAIN\\name.')
  }
  if (request.secrets?.oldPassword !== undefined) issue(context, 'secrets', 'A new login has no old password.')
  if (request.serverRoles.includes(publicRole)) issue(context, 'serverRoles', 'Every login is a member of public.')
  if (new Set(request.serverRoles).size !== request.serverRoles.length) issue(context, 'serverRoles', 'Duplicate server role.')
  if (new Set(request.mappings.map(mapping => mapping.database)).size !== request.mappings.length) issue(context, 'mappings', 'A database is mapped twice.')
  for (const mapping of request.mappings) {
    if (mapping.rolesAdd.includes(publicRole)) issue(context, 'mappings', 'Every database user is a member of public.')
    if (new Set(mapping.rolesAdd).size !== mapping.rolesAdd.length) issue(context, 'mappings', 'Duplicate database role.')
  }
  if (newLoginStatements(request) > actionLimits.statements) issue(context, 'mappings', tooManyStatementsMessage(actionLimits.statements))
}
export const actionRequestSchema = z.discriminatedUnion('action', [
  renameSchema,
  deleteSchema,
  propertiesSchema,
  createTableSchema,
  createLoginSchema,
  loginStateSchema,
  unlockSchema,
  loginPropertiesSchema
]).superRefine((request, context) => {
  // A new table or login is not an object row's action: its target is the database (SQL Server's own included) or the server.
  if (request.action !== 'createTable' && !isCreateAction(request.action)) for (const message of dialogTargetProblems(request.target, request.action)) issue(context, 'target', message)
  switch (request.action) {
    case 'rename':
      if (request.newName === request.target.name) issue(context, 'newName', 'The new name is the current name.')
      if (request.target.kind === 'login' && isSystemLoginName(request.newName)) issue(context, 'newName', loginMessages.systemName)
      break
    case 'delete':
      if (kindSpecs[request.target.kind].scope !== 'database' && (request.closeConnections || request.deleteHistory)) issue(context, 'closeConnections', 'Only a database has connections to close and backup history to delete.')
      if (request.target.kind !== 'login' && (request.dropMappedUsers !== undefined || request.loginIdentity !== undefined)) issue(context, 'dropMappedUsers', 'Only a login has mapped users and an identity to check.')
      break
    case 'properties': {
      const count = plannedStatements(request.changes)
      if (count === 0) issue(context, 'changes', 'There is nothing to change.')
      if (count > actionLimits.statements) issue(context, 'changes', 'Too many changes.')
      if (request.closeConnections && !exclusiveChange(request.changes)) issue(context, 'closeConnections', 'No change needs other connections closed.')
      break
    }
    case 'createLogin':
      createLoginIssues(request, context)
      break
    case 'loginProperties':
      loginPropertiesIssues(request, context)
      break
  }
}) satisfies z.ZodType<ActionRequest>
/** actions.execute: the same requests, with the secrets each needs and no others: New Login's password exactly for a SQL
 *  Server login (blank only with the password policy on, which lets the server decide), and none for a Windows login. A
 *  login's Delete must name the login Delete Object read (`loginIdentity`), which binds DROP LOGIN and every DROP USER to that
 *  principal; Script runs nothing and may leave it out. C# Validate refuses the same. */
export const actionExecuteRequestSchema = actionRequestSchema.superRefine((request, context) => {
  if (request.action === 'delete' && request.target.kind === 'login' && request.loginIdentity === undefined) issue(context, 'loginIdentity', "A login's Delete needs the identity of the login it read.")
  if (request.action === 'loginProperties') {
    // A new password exactly when the changes set one, never blank (blank keeps the current one); the old one exactly with Specify old password.
    const password = request.loginChanges.password
    if (request.loginIdentity === undefined) issue(context, 'loginIdentity', "Login Properties needs the identity of the login it read.")
    if (password ? !request.secrets?.password : request.secrets !== undefined) issue(context, 'secrets', 'The new password goes exactly with a password change.')
    if (password && (password.oldPassword ? request.secrets?.oldPassword === undefined : request.secrets?.oldPassword !== undefined)) issue(context, 'secrets', 'The old password goes exactly with Specify old password.')
    return
  }
  if (request.action !== 'createLogin') return
  if (request.login.auth === 'sql' && request.secrets?.password === undefined) issue(context, 'secrets', 'A SQL Server login needs a password.')
  if (request.login.auth !== 'sql' && request.secrets !== undefined) issue(context, 'secrets', 'Only a SQL Server login takes a password.')
  if (request.login.auth === 'sql' && request.secrets?.password === '' && !request.login.checkPolicy) issue(context, 'secrets', 'A blank password needs Enforce password policy.')
}) satisfies z.ZodType<ActionRequest>
/** actions.script: the same requests, never with `secrets` (critic A3). Script never needs a password, so none crosses for it
 *  even once an action (New Login) accepts one on actions.execute; C# Validate refuses Secrets on every script too. */
export const actionScriptRequestSchema = z.custom<unknown>(value => !(typeof value === 'object' && value !== null && Object.hasOwn(value, 'secrets')), 'Script never carries secrets.')
  .pipe(actionRequestSchema)

/** The bounds of a step (C#: ActionSteps.Bound clips to them). */
export const actionStepSchema = z.object({
  status: z.enum(actionStepStatuses), title: z.string().max(loginLimits.stepTitle), message: z.string().max(actionLimits.messageChars).optional(),
  detail: z.string().max(loginLimits.stepDetail).optional(), compensates: z.boolean().optional(), progress: z.number().int().min(0).max(100).optional()
}).strict() satisfies z.ZodType<ActionStep>
const actionErrorSchema = z.object({ code: z.enum(actionErrorCodes), message: z.string().max(actionLimits.messageChars), retryable: z.boolean() }).strict() satisfies z.ZodType<ActionError>
/** actions.execute's answer, which main checks before the renderer sees it: one step per planned statement, the commit, and
 *  compensation and cleanup steps, at most statements + 8; bounded messages. */
export const actionExecuteResultSchema = z.object({
  steps: z.array(actionStepSchema).max(actionLimits.statements + 8), messages: z.array(z.string().max(actionLimits.infoMessageChars)).max(actionLimits.infoMessages),
  elapsedMs: z.number().int().min(0), error: actionErrorSchema.optional(), sessions: z.number().int().min(0).max(1_000_000).optional()
}).strict() satisfies z.ZodType<ActionExecuteResult>

export const actionCancelSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(actionLimits.cancelIds).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<ActionCancelRequest>
