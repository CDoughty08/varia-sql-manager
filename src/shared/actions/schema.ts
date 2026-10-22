// Strict zod schemas for object actions, and the shapes of their results. Main validates every request with them before
// the backend re-checks it against the catalogue and the subtype it derives itself in the action's own connection.
import { z } from 'zod'
import { kindSpecs } from '../explorer/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident, objectRefSchema } from '../explorer/schema.ts'
import { actionLimits, actionOffered, dialogIds, dialogSpecs, objectActionSpecs, type ActionErrorCode, type ObjectAction } from './catalog.ts'
import { optionDef, settableOptionKeys, settableScopedKeys, tokenProblem, type FileType, type Growth } from './database.ts'
import { designerDescribeIds } from '../designer/catalog.ts'
import { createTableSchema, type CreateTableRequest, type TableDesignerModel } from '../designer/schema.ts'

/** What actions.describe describes: an object dialog (PR17's catalogue) or a designer (src/shared/designer/catalog.ts). */
export const describeIds = [...dialogIds, ...designerDescribeIds] as const
export type DescribeId = typeof describeIds[number]

export interface ActionDescribeRequest { readonly connectionId: string; readonly requestId: string; readonly dialog: DescribeId; readonly target: ObjectRef }
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
/** Database Properties' OK and Script. `closeConnections` (WITH ROLLBACK IMMEDIATE) only with a change SSMS closes connections for. */
export interface PropertiesRequest {
  readonly action: 'properties'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly closeConnections: boolean; readonly changes: DatabaseChanges
}
/** One action: actions.script returns its script, actions.execute runs it. */
export type ActionRequest = RenameRequest | DeleteRequest | PropertiesRequest | CreateTableRequest
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
}
export interface ActionScriptResult {
  /** Absent with `error`; at most `actionLimits.scriptChars` characters. */
  readonly text?: string
  /** The database a new query window should use: `master` for database actions, else the object's. */
  readonly database: string
  readonly warnings: readonly string[]
  readonly error?: ActionError
}
export type ActionStepStatus = 'done' | 'failed' | 'skipped' | 'cancelled'
export interface ActionStep { readonly status: ActionStepStatus; readonly message?: string }
export interface ActionExecuteResult {
  /** One per statement, in order: the first failure stops the rest, which are 'skipped'. */
  readonly steps: readonly ActionStep[]
  /** SQL Server's informational messages (sp_rename's caution), at most 32 of 512 characters. */
  readonly messages: readonly string[]
  readonly elapsedMs: number
  readonly error?: ActionError
}

// Objects in these schemas, and these databases, are SQL Server's own; the backend re-checks by catalog (is_ms_shipped,
// database_id), so this only stops an obviously wrong request early.
const systemSchemas: ReadonlySet<string> = new Set(['sys', 'INFORMATION_SCHEMA'])
const systemDatabases: ReadonlySet<string> = new Set(['master', 'model', 'msdb', 'tempdb'])
const verbs: Readonly<Record<ObjectAction, string>> = { selectTop: 'selected from', rename: 'renamed', delete: 'deleted', properties: 'shown in Properties' }
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

export const actionDescribeSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid(), dialog: z.enum(describeIds), target: objectRefSchema }).strict()
  .superRefine((request, context) => {
    switch (request.dialog) {
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
const propertiesSchema = z.object({ action: z.literal('properties'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, closeConnections: z.boolean(), changes: changesSchema }).strict()
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

export const actionCancelSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(actionLimits.cancelIds).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<ActionCancelRequest>
