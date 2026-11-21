// Strict zod schemas for Script As requests, and the result's shape. Main validates every request before the backend
// re-checks it against the catalogue and the subtype it derives itself.
import { z } from 'zod'
import { objectRefSchema } from '../explorer/schema.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { scriptKindSpecs, scriptLimits, scriptVerbOffered, scriptVerbSpecs, scriptVerbs, type ScriptErrorCode, type ScriptVerb } from './catalog.ts'
import { scriptingOptionsSchema, type ScriptingOptions } from './options.ts'
import type { BigQueryDryRunResult } from '../bigquery/dry-run.ts'

export interface ScriptRequest {
  readonly connectionId: string
  /** The renderer's id for this request, which cancellation names. */
  readonly requestId: string
  /** Exactly one object for Script As; the backend already takes a list. */
  readonly targets: readonly ObjectRef[]
  readonly verb: ScriptVerb
  readonly options: ScriptingOptions
  /** BigQuery CREATE: answer the billed INFORMATION_SCHEMA query's free estimate instead of the script. */
  readonly estimateOnly?: true
  /** BigQuery CREATE: the cap its query runs under when the connection sets none (Options' maximum bytes billed). */
  readonly maximumBytesBilled?: number
}
export interface ScriptCancelRequest { readonly requestIds: readonly string[] }
export interface ScriptError { readonly code: ScriptErrorCode; readonly message: string; readonly retryable: boolean }
export interface ScriptResult {
  /** Absent with `error`; at most `scriptLimits.maxScriptChars` characters. */
  readonly text?: string
  /** The database a new query window should use: the object's, `master` for databases and server objects, or `msdb` for SQL Server Agent's. */
  readonly database: string
  readonly warnings: readonly string[]
  /** SQL commands the job sent, which the backend's performance checks bound. */
  readonly commands: number
  readonly elapsedMs: number
  readonly error?: ScriptError
  /** BigQuery CREATE with `estimateOnly`: the query's estimate, instead of `text`. */
  readonly estimate?: BigQueryDryRunResult
}

/** Why a ref cannot be scripted with `verb` whatever its subtype: deferred or unscriptable kinds, a table type's children, a verb never enabled. */
export function scriptTargetProblems(ref: ObjectRef, verb: ScriptVerb): string[] {
  const spec = scriptKindSpecs[ref.kind]
  if (spec?.phase !== 'pr5') return [`A ${ref.kind} cannot be scripted.`]
  if (spec.parents && (!ref.parent || !spec.parents.includes(ref.parent.kind))) return [`A ${ref.kind} of a ${ref.parent?.kind ?? 'missing parent'} cannot be scripted.`]
  return scriptVerbOffered(ref.kind, verb, ref.parent?.kind) ? [] : [`A ${ref.kind} has no ${scriptVerbSpecs[verb].name} script.`]
}

export const scriptRequestSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), targets: z.array(objectRefSchema).length(1), verb: z.enum(scriptVerbs), options: scriptingOptionsSchema,
  estimateOnly: z.literal(true).optional(), maximumBytesBilled: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
}).strict().superRefine((request, context) => {
  // Only a BigQuery object's CREATE runs a billed query.
  const billed = request.verb === 'create' && request.targets.every(ref => ref.project !== undefined)
  if ((request.estimateOnly !== undefined || request.maximumBytesBilled !== undefined) && !billed) context.addIssue({ code: 'custom', path: ['estimateOnly'], message: 'Only a BigQuery CREATE has an estimate or a cap.' })
  request.targets.forEach((ref, index) => { for (const message of scriptTargetProblems(ref, request.verb)) context.addIssue({ code: 'custom', path: ['targets', index], message }) })
}) satisfies z.ZodType<ScriptRequest>

export const scriptCancelSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(scriptLimits.cancelIds).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<ScriptCancelRequest>
