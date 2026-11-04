// Strict zod schemas for object actions, and the shapes of their results. Main validates every request with them before
// the backend re-checks it against the catalogue and the subtype it derives itself in the action's own connection.
import { z } from 'zod'
import { kindSpecs } from '../explorer/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident, objectRefSchema } from '../explorer/schema.ts'
import {
  actionErrorCodes, actionLimits, actionOffered, dialogIds, dialogSpecs, isCreateAction, isServerAction, objectActionSpecs, serverFilePurposes, serverFilesDescribeId, type ActionErrorCode,
  type ObjectAction
} from './catalog.ts'
import {
  loginDatabaseRolesDescribe, loginLimits, newLoginAuths, newLoginStatements, publicRole, tooManyStatementsMessage, windowsLoginName, type LoginDatabaseRoles, type LoginSecrets, type LoginStatusChoice,
  type NewLoginGeneral, type NewLoginModel, type UserMappingChoice
} from './logins.ts'
import { wellFormed } from '../ssis/schema.ts'
import { collationPattern, optionDef, settableOptionKeys, settableScopedKeys, tokenProblem, type FileType, type Growth } from './database.ts'
import { containmentTypes, newDatabaseOptionKeys, newDatabaseProblems, newDatabaseScopedKeys, type NewDatabaseDesign, type NewDatabaseModel } from './new-database.ts'
import { serverPathProblem, type ServerFilesListing, type ServerFilesRequest } from './files.ts'
import { designerDescribeIds } from '../designer/catalog.ts'
import { createTableSchema, type CreateTableRequest, type TableDesignerModel } from '../designer/schema.ts'
import { restoreDescribeId, restoreLimits, type RestoreModel, type RestoreSource } from './restore.ts'
import { restoreFilesRequestSchema, restoreRequestSchema, restoreSourceSchema, type RestoreFilesRequest, type RestoreRequest } from './restore-schema.ts'

/** What actions.describe describes: an object dialog (PR17's catalogue), a designer (src/shared/designer/catalog.ts), the
 *  server's folders for the server file picker, what Restore Database restores from (src/shared/actions/restore.ts), or one
 *  database's roles and schemas for New Login's User Mapping page (logins.ts loginDatabaseRolesDescribe). */
export const describeIds = [...dialogIds, ...designerDescribeIds, serverFilesDescribeId, restoreDescribeId, loginDatabaseRolesDescribe] as const
export type DescribeId = typeof describeIds[number]

/** Attach Databases' Add: the primary data file (.mdf) the backend reads with DBCC CHECKPRIMARYFILE, its path bound as a parameter. */
export interface AttachDescribeRequest { readonly mdf: string }
/** `files` only with `serverFiles` and `restore` only with `restoreDatabase`, whose target is the server; `attach` only with
 *  `attachDatabase` (without it, the describe answers the server's facts the dialog opens with). */
export interface ActionDescribeRequest {
  readonly connectionId: string; readonly requestId: string; readonly dialog: DescribeId; readonly target: ObjectRef; readonly files?: ServerFilesRequest; readonly restore?: RestoreSource
  readonly attach?: AttachDescribeRequest
}
export interface RenameRequest { readonly action: 'rename'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly newName: string }
/** `closeConnections` (SET SINGLE_USER WITH ROLLBACK IMMEDIATE first) and `deleteHistory` apply to databases only. */
export interface DeleteRequest {
  readonly action: 'delete'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly closeConnections: boolean; readonly deleteHistory: boolean
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
/** Tasks › Take Offline's OK: SET OFFLINE, which waits for every other session to leave the database, or with
 *  `dropConnections` (Drop All Active Connections) SET OFFLINE WITH ROLLBACK IMMEDIATE. `identity` is the database the dialog read. */
export interface TakeOfflineRequest {
  readonly action: 'takeOffline'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly dropConnections: boolean; readonly identity?: DatabaseIdentity
}
/** Tasks › Bring Online: SET ONLINE. */
export interface BringOnlineRequest { readonly action: 'bringOnline'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly identity?: DatabaseIdentity }
/**
 * Tasks › Detach…'s OK: sp_detach_db, after SET SINGLE_USER WITH ROLLBACK IMMEDIATE with `dropConnections` (Drop Connections).
 * `updateStatistics` runs UPDATE STATISTICS first (@skipchecks 'false'); cleared, it is skipped ('true'). `detachOffline` (Detach
 * while offline) is the answer to the warning about an offline database on Windows, whose files may not attach again.
 */
export interface DetachRequest {
  readonly action: 'detach'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly dropConnections: boolean; readonly updateStatistics: boolean
  readonly detachOffline?: boolean; readonly identity?: DatabaseIdentity
}
/** New Database's OK and Script: the new database's name as the target, and the design (src/shared/actions/new-database.ts). */
export interface CreateDatabaseRequest {
  readonly action: 'createDatabase'; readonly connectionId: string; readonly requestId: string; readonly target: { readonly kind: 'database'; readonly name: string }; readonly design: NewDatabaseDesign
}
/**
 * One database Attach Databases attaches: Attach As, its owner (absent: the attaching login, SSMS's <default>), every file to
 * attach as the server finds it (the primary data file first), and whether SQL Server rebuilds the log, which `files` then
 * leaves out (FOR ATTACH_REBUILD_LOG).
 */
export interface AttachDatabaseSpec { readonly name: string; readonly owner?: string; readonly files: readonly string[]; readonly rebuildLog: boolean }
/** Attach Databases' OK and Script: the server as the target, and at most `actionLimits.attachDatabases` databases. */
export interface AttachRequest { readonly action: 'attach'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly databases: readonly AttachDatabaseSpec[] }
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
/** One action: actions.script returns its script, actions.execute runs it. */
export type ActionRequest = RenameRequest | DeleteRequest | PropertiesRequest | CreateTableRequest | CreateDatabaseRequest | AttachRequest | CreateLoginRequest | TakeOfflineRequest | BringOnlineRequest | DetachRequest
/** actions.script and actions.execute also take a restore and a file restore, whose requests have shapes of their own (restore-schema.ts). */
export type ActionScriptRequest = ActionRequest | RestoreRequest | RestoreFilesRequest
export type ActionExecuteRequest = ActionRequest | RestoreRequest | RestoreFilesRequest
export type { RestoreFilesRequest, RestoreRequest } from './restore-schema.ts'
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
/** A session in a database, as Take Database Offline lists it (with VIEW SERVER STATE): names clipped to `actionLimits.sessionText`. */
export interface DatabaseSession {
  readonly sessionId: number
  readonly login?: string
  readonly program?: string
  readonly host?: string
  /** sys.dm_exec_sessions.open_transaction_count: work that Drop All Active Connections rolls back. */
  readonly openTransactions: number
}
/**
 * Take Database Offline's and Bring Database Online's row: the database read (its identity), its runtime state from
 * sys.databases, and who is in it. The counts leave out the backend's own pooled connections, which the action closes
 * itself; Varia's query tabs are real sessions and count. Absent counts: no VIEW SERVER STATE.
 */
export interface DatabaseStateModel {
  readonly name: string
  readonly identity: DatabaseIdentity
  readonly state: number
  readonly userAccess: number
  readonly readOnly: boolean
  readonly standby: boolean
  readonly sessions?: number
  /** Of `sessions`, those with an open transaction. */
  readonly withTransaction?: number
  /** At most `actionLimits.sessions`, by session id. */
  readonly sessionList: readonly DatabaseSession[]
  readonly sessionsTruncated: boolean
  /** Facts that make the statement fail or matter (an availability group, mirroring). */
  readonly warnings: readonly ActionWarning[]
  /** Detach: the database's files, which stay on the server (sys.master_files; none without CREATE DATABASE, ALTER ANY DATABASE or VIEW ANY DEFINITION). */
  readonly files?: readonly DatabaseFileRef[]
  readonly filesTruncated?: boolean
  /** Detach: the database is offline on a Windows server, whose files may not attach again once detached offline; OK waits for Detach while offline. */
  readonly confirmOffline?: boolean
}
/** A database file by its id: the logical name, its type and its path on the server (never logged). */
export interface DatabaseFileRef { readonly fileId: number; readonly name: string; readonly type: FileType; readonly path: string }
/** What Attach Databases opens with: the logins its Owner lists (at most `actionLimits.logins`), the server's path separator,
 *  and its default data folder, where Add's picker starts. */
export interface AttachServerFacts { readonly logins: readonly string[]; readonly loginsTruncated: boolean; readonly separator: '\\' | '/'; readonly dataPath?: string }
/** A file of a detached database, as its primary file records it (DBCC CHECKPRIMARYFILE option 3): its path then, its type
 *  (a log by status 0x40), where it is now (the .mdf as added; the others where they were), and whether the server finds a
 *  file there (absent: SQL Server 2016 does not tell a login outside sysadmin). */
export interface AttachFileInfo { readonly original: string; readonly type: 'data' | 'log'; readonly current: string; readonly found?: boolean }
/** Add's answer for one .mdf (DBCC CHECKPRIMARYFILE options 0, 2 and 3): its database's name and version, and its files. */
export interface AttachDatabaseInfo { readonly mdf: string; readonly databaseName: string; readonly version?: number; readonly files: readonly AttachFileInfo[] }
export interface AttachDescribeModel { readonly server: AttachServerFacts; readonly database?: AttachDatabaseInfo }
export interface ActionDescribeResult {
  readonly deleteTarget?: DeleteTarget; readonly elapsedMs: number; readonly error?: ActionError; readonly databaseProperties?: DatabasePropertiesModel; readonly tableDesigner?: TableDesignerModel
  readonly serverFiles?: ServerFilesListing
  readonly restore?: RestoreModel
  readonly newDatabase?: NewDatabaseModel
  readonly attachDatabase?: AttachDescribeModel
  readonly newLogin?: NewLoginModel
  readonly loginDatabaseRoles?: LoginDatabaseRoles
  readonly databaseState?: DatabaseStateModel
}
export interface ActionScriptResult {
  /** Absent with `error`; at most `actionLimits.scriptChars` characters. */
  readonly text?: string
  /** The database a new query window should use: `master` for database actions, else the object's. */
  readonly database: string
  readonly warnings: readonly string[]
  readonly error?: ActionError
}
export const actionStepStatuses = ['done', 'failed', 'skipped', 'cancelled'] as const
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
/**
 * A restored database as the run left it, read after the last step (critic A12): sys.databases' state and user_access (the access
 * comes from the backup, not from the SINGLE_USER Varia set); or `absent` when no database has the name, with the files a dropped
 * partly restored database left on disk (`filesUnknown`: whether they are could not be asked). A reply leaves it out when the
 * database could not be read, so the page never infers a state.
 */
export type RestoredDatabase = { readonly state: number; readonly userAccess: number; readonly absent?: undefined; readonly filesRestoring?: readonly string[] }
  | { readonly absent: true; readonly filesLeft?: readonly string[]; readonly filesUnknown?: true }
/** The most leftover files, or files still restoring after a file restore (`filesRestoring`, by logical name), a reply names (ActionService.MaxFilesLeft). */
export const restoredFilesLimit = 16
/** The title of a database Delete's DROP step (ActionService.StepTitle in the backend; tests/delete-database.test.ts keeps them equal):
 *  a reply in which it is 'done' removed the database, even when a later step failed. */
export const dropDatabaseStepTitle = 'Drop the database'
export interface ActionExecuteResult {
  /** One per statement, in order: the first failure stops the rest, which are 'skipped'. */
  readonly steps: readonly ActionStep[]
  /** SQL Server's informational messages (sp_rename's caution), at most 32 of 512 characters. */
  readonly messages: readonly string[]
  readonly elapsedMs: number
  readonly error?: ActionError
  /** Detach: the files it left on the server, at most `actionLimits.detachFiles`, once the database was detached. */
  readonly filesKept?: readonly DatabaseFileRef[]
  /** A restore's destination after the run. */
  readonly restored?: RestoredDatabase
}

// Objects in these schemas, and these databases, are SQL Server's own; the backend re-checks by catalog (is_ms_shipped,
// database_id), so this only stops an obviously wrong request early.
const systemSchemas: ReadonlySet<string> = new Set(['sys', 'INFORMATION_SCHEMA'])
const systemDatabases: ReadonlySet<string> = new Set(['master', 'model', 'msdb', 'tempdb'])
/** The step sp_detach_db runs as (C#: ActionService.StepTitle): done, the database is gone, whatever came after it. */
export const detachDatabaseStepTitle = 'Detach the database'
const verbs: Readonly<Record<ObjectAction, string>> = {
  selectTop: 'selected from', rename: 'renamed', delete: 'deleted', properties: 'shown in Properties', attach: 'attached', takeOffline: 'taken offline', bringOnline: 'brought online',
  detach: 'detached', restore: 'restored', restoreFiles: 'restored'
}
/** A server ref: what a create action on a server object (a login) names as its target. */
const isServer = (ref: ObjectRef) => ref.kind === 'server' && Object.keys(ref).length === 1
/** Why `action` cannot act on `ref` whatever its subtype: a kind that never offers it, or one of SQL Server's own objects
 *  (unless the action serves them, as Properties does). A folder's action (Attach) acts on the server alone. */
export function actionTargetProblems(ref: ObjectRef, action: ObjectAction): string[] {
  if (objectActionSpecs[action].folder) return ref.kind === 'server' && Object.keys(ref).length === 1 ? [] : [`${objectActionSpecs[action].title.replace('…', '')} acts on a server.`]
  if (!actionOffered(ref.kind, action)) return [`A ${ref.kind} cannot be ${verbs[action]}.`]
  if (objectActionSpecs[action].systemObjects) return []
  if (ref.kind === 'database' ? systemDatabases.has(ref.name ?? '') : ref.schema !== undefined && systemSchemas.has(ref.schema)) return ['System objects cannot be changed.']
  return []
}

const issue = (context: z.RefinementCtx, path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
const targetIssues = (context: z.RefinementCtx, target: ObjectRef, action: ObjectAction) => { for (const message of actionTargetProblems(target, action)) issue(context, 'target', message) }

/** A path on the server (files.ts' rules); New Database, Attach and Restore take paths through it too. */
export const serverPathSchema = z.string().superRefine((path, context) => { const problem = serverPathProblem(path); if (problem) context.addIssue({ code: 'custom', message: problem }) })
export const serverFilesRequestSchema = z.object({ purpose: z.enum(serverFilePurposes), path: serverPathSchema.optional(), allFiles: z.boolean().optional(), exists: z.boolean().optional() }).strict()
  .refine(files => !(files.purpose === 'folder' && files.allFiles), 'A folder picker lists folders only.')
  .refine(files => !(files.exists && (files.path === undefined || files.allFiles !== undefined)), 'A check names one path, with no type filter.') satisfies z.ZodType<ServerFilesRequest>

export const attachDescribeSchema = z.object({ mdf: serverPathSchema }).strict() satisfies z.ZodType<AttachDescribeRequest>
export const actionDescribeSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), dialog: z.enum(describeIds), target: objectRefSchema, files: serverFilesRequestSchema.optional(), restore: restoreSourceSchema.optional(),
  attach: attachDescribeSchema.optional()
}).strict()
  .superRefine((request, context) => {
    if ((request.dialog === serverFilesDescribeId) !== (request.files !== undefined)) issue(context, 'files', 'Only the server file picker lists files, and it needs what to list.')
    if ((request.dialog === restoreDescribeId) !== (request.restore !== undefined)) issue(context, 'restore', 'Only Restore Database reads backups, and it needs what to read.')
    if (request.attach !== undefined && request.dialog !== 'attachDatabase') issue(context, 'attach', 'Only Attach Databases reads a primary data file.')
    switch (request.dialog) {
      case serverFilesDescribeId:
        if (request.target.kind !== 'server') issue(context, 'target', 'The server file picker lists folders on the server.')
        break
      case restoreDescribeId:
        if (request.target.kind !== 'server') issue(context, 'target', 'Restore Database reads backups on the server.')
        break
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
      default: {
        // A server action's document describes the server it makes something on.
        const action = dialogSpecs[request.dialog].action
        if (isServerAction(action)) { if (request.target.kind !== 'server') issue(context, 'target', 'New Database describes the server.') }
        else targetIssues(context, request.target, action as ObjectAction)
      }
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
const deleteSchema = z.object({ action: z.literal('delete'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, closeConnections: z.boolean(), deleteHistory: z.boolean() }).strict()
// create_date as the backend writes it (yyyy-MM-ddTHH:mm:ss.fff); without the m flag, $ refuses a final line break too.
const identitySchema = z.object({ id: z.number().int().min(1).max(2_147_483_647), created: z.string().max(23).regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/) }).strict()
const propertiesSchema = z.object({ action: z.literal('properties'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, closeConnections: z.boolean(), changes: changesSchema, identity: identitySchema.optional() }).strict()
const takeOfflineSchema = z.object({ action: z.literal('takeOffline'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, dropConnections: z.boolean(), identity: identitySchema.optional() }).strict()
const bringOnlineSchema = z.object({ action: z.literal('bringOnline'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, identity: identitySchema.optional() }).strict()
const detachSchema = z.object({
  action: z.literal('detach'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, dropConnections: z.boolean(), updateStatistics: z.boolean(), detachOffline: z.boolean().optional(),
  identity: identitySchema.optional()
}).strict()
// New Database's design; the rules that need the server (Linux, FILESTREAM, the version) wait for the backend's preflight.
const growthSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), unit: z.enum(['mb', 'percent']), by: z.number().int().min(1).max(actionLimits.growthMb), maxMb: z.number().int().min(1).max(actionLimits.dataFileMb).optional() }).strict()
])
const newFileSchema = z.object({
  name: ident, type: z.enum(['rows', 'log', 'filestream']), filegroup: ident.optional(), sizeMb: z.number().int().min(1).max(actionLimits.dataFileMb).optional(), growth: growthSchema,
  path: serverPathSchema, fileName: z.string().min(1).max(actionLimits.serverPath)
}).strict()
const newFilegroupSchema = z.object({
  name: ident, type: z.enum(['rows', 'filestream', 'memoryOptimized']), readOnly: z.boolean().optional(), isDefault: z.boolean().optional(), autogrowAllFiles: z.boolean().optional()
}).strict()
export const newDatabaseDesignSchema = z.object({
  owner: ident.optional(), files: z.array(newFileSchema).min(2).max(actionLimits.newDatabaseFiles), filegroups: z.array(newFilegroupSchema).min(1).max(actionLimits.newDatabaseFilegroups),
  collation: z.string().max(128).regex(collationPattern).optional(), containment: z.enum(containmentTypes), ledger: z.boolean().optional(),
  options: tokens(newDatabaseOptionKeys), scoped: tokens(newDatabaseScopedKeys)
}).strict() satisfies z.ZodType<NewDatabaseDesign>
const createDatabaseSchema = z.object({
  action: z.literal('createDatabase'), connectionId: z.uuid(), requestId: z.uuid(), target: z.object({ kind: z.literal('database'), name: ident }).strict(), design: newDatabaseDesignSchema
}).strict()
export const attachDatabaseSchema = z.object({
  name: ident, owner: ident.optional(), files: z.array(serverPathSchema).min(1).max(actionLimits.attachFiles), rebuildLog: z.boolean()
}).strict() satisfies z.ZodType<AttachDatabaseSpec>
const attachSchema = z.object({
  action: z.literal('attach'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, databases: z.array(attachDatabaseSchema).min(1).max(actionLimits.attachDatabases)
}).strict()
/** Why an attach's databases cannot run as listed (C#: ActionService.Validate's attach case): a name twice, or a file twice in one database. */
export function attachProblems(databases: readonly AttachDatabaseSpec[]): string[] {
  const problems: string[] = []
  if (new Set(databases.map(database => database.name)).size !== databases.length) problems.push('Two databases cannot be attached as the same name.')
  if (databases.some(database => new Set(database.files).size !== database.files.length)) problems.push('A database lists the same file twice.')
  return problems
}
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
  createDatabaseSchema,
  attachSchema,
  createLoginSchema,
  takeOfflineSchema,
  bringOnlineSchema,
  detachSchema
]).superRefine((request, context) => {
  // A new table, database or login is not an object row's action: its target is the database it goes in (SQL Server's own
  // included), the database it makes, or the server.
  if (request.action !== 'createTable' && request.action !== 'createDatabase' && !isCreateAction(request.action)) targetIssues(context, request.target, request.action)
  switch (request.action) {
    case 'createDatabase':
      for (const problem of newDatabaseProblems(request.target.name, request.design)) issue(context, problem.field === 'name' ? 'target' : 'design', problem.message)
      break
    case 'rename':
      if (request.newName === request.target.name) issue(context, 'newName', 'The new name is the current name.')
      break
    case 'delete':
      if (kindSpecs[request.target.kind].scope !== 'database' && (request.closeConnections || request.deleteHistory)) issue(context, 'closeConnections', 'Only a database has connections to close and backup history to delete.')
      break
    case 'properties': {
      const count = plannedStatements(request.changes)
      if (count === 0) issue(context, 'changes', 'There is nothing to change.')
      if (count > actionLimits.statements) issue(context, 'changes', 'Too many changes.')
      if (request.closeConnections && !exclusiveChange(request.changes)) issue(context, 'closeConnections', 'No change needs other connections closed.')
      break
    }
    case 'attach':
      for (const message of attachProblems(request.databases)) issue(context, 'databases', message)
      break
    case 'createLogin':
      createLoginIssues(request, context)
      break
  }
}) satisfies z.ZodType<ActionRequest>
/** actions.execute: the same requests, a restore (critic A17: it runs from D1f, with the menu items that open it), or a file restore (D1g), with
 *  the secrets each needs and no others: New Login's password exactly for a SQL Server login (blank only with the password policy on, which
 *  lets the server decide), and none for a Windows login. */
export const actionExecuteRequestSchema = z.union([actionRequestSchema, restoreRequestSchema, restoreFilesRequestSchema]).superRefine((request, context) => {
  if (request.action !== 'createLogin') return
  if (request.login.auth === 'sql' && request.secrets?.password === undefined) issue(context, 'secrets', 'A SQL Server login needs a password.')
  if (request.login.auth !== 'sql' && request.secrets !== undefined) issue(context, 'secrets', 'Only a SQL Server login takes a password.')
  if (request.login.auth === 'sql' && request.secrets?.password === '' && !request.login.checkPolicy) issue(context, 'secrets', 'A blank password needs Enforce password policy.')
}) satisfies z.ZodType<ActionExecuteRequest>
/** actions.script: the same requests, never with `secrets` (critic A3). Script never needs a password, so none crosses for it
 *  even once an action (New Login) accepts one on actions.execute; C# Validate refuses Secrets on every script too. */
export const actionScriptRequestSchema = z.custom<unknown>(value => !(typeof value === 'object' && value !== null && Object.hasOwn(value, 'secrets')), 'Script never carries secrets.')
  .pipe(z.union([actionRequestSchema, restoreRequestSchema, restoreFilesRequestSchema]))

/** The bounds of a step (C#: ActionSteps.Bound clips to them). */
export const actionStepSchema = z.object({
  status: z.enum(actionStepStatuses), title: z.string().max(loginLimits.stepTitle), message: z.string().max(actionLimits.messageChars).optional(),
  detail: z.string().max(loginLimits.stepDetail).optional(), compensates: z.boolean().optional(), progress: z.number().int().min(0).max(100).optional()
}).strict() satisfies z.ZodType<ActionStep>
const actionErrorSchema = z.object({ code: z.enum(actionErrorCodes), message: z.string().max(actionLimits.messageChars), retryable: z.boolean() }).strict() satisfies z.ZodType<ActionError>
const fileRefSchema = z.object({
  fileId: z.number().int().min(1).max(32_767), name: z.string().max(128), type: z.enum(['rows', 'log', 'filestream']), path: z.string().max(actionLimits.filePath)
}).strict() satisfies z.ZodType<DatabaseFileRef>
/** The most steps a reply lists: one per planned statement (a restore plans one per backup set), the commit, and compensation and cleanup steps. */
export const actionStepLimit = Math.max(actionLimits.statements, restoreLimits.planSets) + 8
/** actions.execute's answer, which main checks before the renderer sees it: at most actionStepLimit steps; bounded messages; Detach's files kept. */
export const actionExecuteResultSchema = z.object({
  steps: z.array(actionStepSchema).max(actionStepLimit), messages: z.array(z.string().max(actionLimits.infoMessageChars)).max(actionLimits.infoMessages),
  elapsedMs: z.number().int().min(0), error: actionErrorSchema.optional(), filesKept: z.array(fileRefSchema).max(actionLimits.detachFiles).optional(),
  restored: z.union([
    z.object({ state: z.number().int().min(0).max(255), userAccess: z.number().int().min(0).max(255), filesRestoring: z.array(z.string().max(128)).max(restoredFilesLimit).optional() }).strict(),
    z.object({ absent: z.literal(true), filesLeft: z.array(z.string().max(actionLimits.serverPath)).max(restoredFilesLimit).optional(), filesUnknown: z.literal(true).optional() }).strict()
  ]).optional()
}).strict() satisfies z.ZodType<ActionExecuteResult>

/** The index a step takes in the reply, or the percent a long step reports. */
const stepIndex = z.number().int().min(0).max(actionStepLimit - 1)
const percent = z.number().int().min(0).max(100)
/** An actions.execute EVENT body (D1c): a long step's progress from SQL Server's STATS messages, droppable, the latest wins. Main
 *  drops the request's other EVENTs (the body is not one of these) without failing the request. */
export const actionProgressEventSchema = z.object({ type: z.literal('action.progress'), step: stepIndex, percent }).strict()
export type ActionProgressEvent = z.infer<typeof actionProgressEventSchema>
/** What main pushes on `varia:actions-progress` to the window that sent the request, at most actionLimits.progressPerSecond a second
 *  per request: the request's id, the step's index in its reply, and the percent. */
export interface ActionProgress { readonly requestId: string; readonly step: number; readonly percent: number }
export const actionProgressSchema = z.object({ requestId: z.uuid(), step: stepIndex, percent }).strict() satisfies z.ZodType<ActionProgress>

export const actionCancelSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(actionLimits.cancelIds).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<ActionCancelRequest>
