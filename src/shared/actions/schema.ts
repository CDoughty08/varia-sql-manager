// Strict zod schemas for object actions, and the shapes of their results. Main validates every request with them before
// the backend re-checks it against the catalogue and the subtype it derives itself in the action's own connection.
import { z } from 'zod'
import { kindSpecs } from '../explorer/catalog.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { ident, objectRefSchema } from '../explorer/schema.ts'
import { actionLimits, actionOffered, dialogIds, objectActionSpecs, type ActionErrorCode, type DialogId, type ObjectAction } from './catalog.ts'

export interface ActionDescribeRequest { readonly connectionId: string; readonly requestId: string; readonly dialog: DialogId; readonly target: ObjectRef }
export interface RenameRequest { readonly action: 'rename'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly newName: string }
/** `closeConnections` (SET SINGLE_USER WITH ROLLBACK IMMEDIATE first) and `deleteHistory` apply to databases only. */
export interface DeleteRequest {
  readonly action: 'delete'; readonly connectionId: string; readonly requestId: string; readonly target: ObjectRef; readonly closeConnections: boolean; readonly deleteHistory: boolean
}
/** One action: actions.script returns its script, actions.execute runs it. */
export type ActionRequest = RenameRequest | DeleteRequest
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
export interface ActionDescribeResult { readonly deleteTarget?: DeleteTarget; readonly elapsedMs: number; readonly error?: ActionError }
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
/** Why `action` cannot act on `ref` whatever its subtype: a kind that never offers it, or one of SQL Server's own objects. */
export function actionTargetProblems(ref: ObjectRef, action: ObjectAction): string[] {
  if (!actionOffered(ref.kind, action)) return [`A ${ref.kind} cannot be ${action === 'rename' ? 'renamed' : action === 'delete' ? 'deleted' : 'selected from'}.`]
  if (ref.kind === 'database' ? systemDatabases.has(ref.name ?? '') : ref.schema !== undefined && systemSchemas.has(ref.schema)) return ['System objects cannot be changed.']
  return []
}

const issue = (context: z.RefinementCtx, path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
const targetIssues = (context: z.RefinementCtx, target: ObjectRef, action: ObjectAction) => { for (const message of actionTargetProblems(target, action)) issue(context, 'target', message) }

export const actionDescribeSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid(), dialog: z.enum(dialogIds), target: objectRefSchema }).strict()
  .superRefine((request, context) => {
    const action = (Object.keys(objectActionSpecs) as ObjectAction[]).find(item => objectActionSpecs[item].dialog === request.dialog)!
    targetIssues(context, request.target, action)
  }) satisfies z.ZodType<ActionDescribeRequest>

const renameSchema = z.object({ action: z.literal('rename'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, newName: ident }).strict()
const deleteSchema = z.object({ action: z.literal('delete'), connectionId: z.uuid(), requestId: z.uuid(), target: objectRefSchema, closeConnections: z.boolean(), deleteHistory: z.boolean() }).strict()
export const actionRequestSchema = z.discriminatedUnion('action', [renameSchema, deleteSchema]).superRefine((request, context) => {
  targetIssues(context, request.target, request.action)
  if (request.action === 'rename' && request.newName === request.target.name) issue(context, 'newName', 'The new name is the current name.')
  if (request.action === 'delete' && kindSpecs[request.target.kind].scope !== 'database' && (request.closeConnections || request.deleteHistory)) {
    issue(context, 'closeConnections', 'Only a database has connections to close and backup history to delete.')
  }
}) satisfies z.ZodType<ActionRequest>

export const actionCancelSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(actionLimits.cancelIds).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<ActionCancelRequest>
