// Strict zod schemas for object actions, and the shapes of their results. Main validates every request with them before
// the backend re-checks it against the catalogue and the subtype it derives itself in the action's own connection.
import { z } from 'zod'
import { kindSpecs } from '../explorer/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident, objectRefSchema } from '../explorer/schema.ts'
import { actionErrorCodes, actionLimits, actionOffered, dialogIds, dialogSpecs, objectActionSpecs, serverFilePurposes, serverFilesDescribeId, type ActionErrorCode, type ObjectAction } from './catalog.ts'
import { loginLimits } from './logins.ts'
import { optionDef, settableOptionKeys, settableScopedKeys, tokenProblem, type FileType, type Growth } from './database.ts'
import { serverPathProblem, type ServerFilesListing, type ServerFilesRequest } from './files.ts'
import { designerDescribeIds } from '../designer/catalog.ts'
import { createTableSchema, type CreateTableRequest, type TableDesignerModel } from '../designer/schema.ts'
import { restoreDescribeId, restoreLimits, type RestoreModel, type RestoreSource } from './restore.ts'
import { restoreFilesRequestSchema, restoreRequestSchema, restoreSourceSchema, type RestoreFilesRequest, type RestoreRequest } from './restore-schema.ts'

/** What actions.describe describes: an object dialog (PR17's catalogue), a designer (src/shared/designer/catalog.ts), the
 *  server's folders for the server file picker, or what Restore Database restores from (src/shared/actions/restore.ts). */
export const describeIds = [...dialogIds, ...designerDescribeIds, serverFilesDescribeId, restoreDescribeId] as const
export type DescribeId = typeof describeIds[number]

/** `files` only with `serverFiles` and `restore` only with `restoreDatabase`, whose target is the server. */
export interface ActionDescribeRequest {
  readonly connectionId: string; readonly requestId: string; readonly dialog: DescribeId; readonly target: ObjectRef; readonly files?: ServerFilesRequest; readonly restore?: RestoreSource
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
/** One action: actions.script returns its script, actions.execute runs it. */
export type ActionRequest = RenameRequest | DeleteRequest | PropertiesRequest | CreateTableRequest
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
  /** Sessions in the database; absent without VIEW SERVER STATE. */
  readonly sessions?: number
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
  readonly serverFiles?: ServerFilesListing
  readonly restore?: RestoreModel
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
export interface ActionExecuteResult {
  /** One per statement, in order: the first failure stops the rest, which are 'skipped'. */
  readonly steps: readonly ActionStep[]
  /** SQL Server's informational messages (sp_rename's caution), at most 32 of 512 characters. */
  readonly messages: readonly string[]
  readonly elapsedMs: number
  readonly error?: ActionError
  /** A restore's destination after the run. */
  readonly restored?: RestoredDatabase
}

// Objects in these schemas, and these databases, are SQL Server's own; the backend re-checks by catalog (is_ms_shipped,
// database_id), so this only stops an obviously wrong request early.
const systemSchemas: ReadonlySet<string> = new Set(['sys', 'INFORMATION_SCHEMA'])
const systemDatabases: ReadonlySet<string> = new Set(['master', 'model', 'msdb', 'tempdb'])
const verbs: Readonly<Record<ObjectAction, string>> = { selectTop: 'selected from', rename: 'renamed', delete: 'deleted', properties: 'shown in Properties', restore: 'restored', restoreFiles: 'restored' }
/** Why `action` cannot act on `ref` whatever its subtype: a kind that never offers it, or one of SQL Server's own objects
 *  (unless the action serves them, as Properties does). */
export function actionTargetProblems(ref: ObjectRef, action: ObjectAction): string[] {
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

export const actionDescribeSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), dialog: z.enum(describeIds), target: objectRefSchema, files: serverFilesRequestSchema.optional(), restore: restoreSourceSchema.optional()
}).strict()
  .superRefine((request, context) => {
    if ((request.dialog === serverFilesDescribeId) !== (request.files !== undefined)) issue(context, 'files', 'Only the server file picker lists files, and it needs what to list.')
    if ((request.dialog === restoreDescribeId) !== (request.restore !== undefined)) issue(context, 'restore', 'Only Restore Database reads backups, and it needs what to read.')
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
      default:
        targetIssues(context, request.target, dialogSpecs[request.dialog].action)
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
export const actionRequestSchema = z.discriminatedUnion('action', [
  renameSchema,
  deleteSchema,
  propertiesSchema,
  createTableSchema
]).superRefine((request, context) => {
  // A new table is not an object row's action: its target is the database, SQL Server's own included.
  if (request.action !== 'createTable') targetIssues(context, request.target, request.action)
  switch (request.action) {
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
  }
}) satisfies z.ZodType<ActionRequest>
/** actions.execute: an object action, a restore (critic A17: it runs from D1f, with the menu items that open it), or a file restore (D1g). */
export const actionExecuteRequestSchema = z.union([actionRequestSchema, restoreRequestSchema, restoreFilesRequestSchema]) satisfies z.ZodType<ActionExecuteRequest>
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
/** The most steps a reply lists: one per planned statement (a restore plans one per backup set), the commit, and compensation and cleanup steps. */
export const actionStepLimit = Math.max(actionLimits.statements, restoreLimits.planSets) + 8
/** actions.execute's answer, which main checks before the renderer sees it: at most actionStepLimit steps; bounded messages. */
export const actionExecuteResultSchema = z.object({
  steps: z.array(actionStepSchema).max(actionStepLimit), messages: z.array(z.string().max(actionLimits.infoMessageChars)).max(actionLimits.infoMessages),
  elapsedMs: z.number().int().min(0), error: actionErrorSchema.optional(),
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
