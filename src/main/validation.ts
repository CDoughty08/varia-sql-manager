import { z } from 'zod'
import type { RpcMethod } from '../shared/contracts'
import { connectionOptionsSchema } from '../shared/connections'
import { limits } from '../shared/ipc/wire/protocol'
import { explorerChildrenParamsSchema } from '../shared/explorer/schema.ts'
import { scriptRequestSchema } from '../shared/scripting/schema.ts'
import { actionDescribeSchema, actionRequestSchema } from '../shared/actions/schema.ts'

// Identifiers are used verbatim by the backend, so they are never trimmed here (a database may be named ' x').
const name = z.string().min(1).max(128).refine(value => value.trim().length > 0)
export const maxScriptCharacters = 1_000_000
const tooLargeScript = 'The script is too large to execute (limit: 1,000,000 characters). Execute a smaller selection.'
const connectionId = z.uuid()
const database = name
export const requestSchemas = {
  'system.health': z.object({}).strict(),
  'connections.connect': connectionOptionsSchema,
  'connections.databases': connectionOptionsSchema,
  'connections.preview': connectionOptionsSchema,
  'connections.discover': z.object({ scope: z.enum(['local', 'network']) }).strict(),
  'connections.disconnect': z.object({ connectionId }).strict(),
  'connections.identity': z.object({}).strict(),
  'databases.list': z.object({ connectionId }).strict(),
  'tables.columns': z.object({ connectionId, database, schema: name, name }).strict(),
  'query.execute': z.object({
    connectionId, sessionId: z.uuid(), database, sql: z.string().min(1).max(maxScriptCharacters, tooLargeScript), queryId: z.uuid(),
    startLine: z.number().int().min(1).max(1_000_000).optional(),
    maxRows: z.number().int().min(0).max(limits.maxRows), maxResultSets: z.number().int().min(limits.maxResultSets.min).max(limits.maxResultSets.max).optional(),
    timeoutSeconds: z.number().int().min(0).max(86400), stopOnError: z.boolean().optional()
  }).strict(),
  'query.cancel': z.object({ queryId: z.uuid() }).strict(),
  'query.session.close': z.object({ sessionId: z.uuid(), transaction: z.enum(['commit', 'rollback']).optional() }).strict(),
  'query.session.state': z.object({ sessionId: z.uuid() }).strict(),
  'explorer.children': explorerChildrenParamsSchema,
  'scripting.script': scriptRequestSchema,
  'actions.describe': actionDescribeSchema,
  'actions.script': actionRequestSchema,
  'actions.execute': actionRequestSchema
} satisfies Record<RpcMethod, z.ZodType>

// Shown as the dialog's User name: one line of at most 256 characters without control or formatting characters (C#: KerberosProbe.Bounded).
const principal = z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u)
/** Answers main checks before the renderer sees them: the backend is trusted, but these come from native code. */
export const resultSchemas: Partial<Record<RpcMethod, z.ZodType>> = {
  'connections.identity': z.object({ principal: principal.optional() }).strict()
}

export function validateResult(method: RpcMethod, value: unknown): unknown {
  const schema = resultSchemas[method]
  if (!schema) return value
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error('The backend sent an invalid answer.')
  return parsed.data
}

export function validateRequest(method: string, params: unknown): unknown {
  if (typeof method !== 'string' || !Object.hasOwn(requestSchemas, method)) throw new Error('Unsupported backend method.')
  const parsed = requestSchemas[method as RpcMethod].safeParse(params)
  if (!parsed.success) throw new Error(parsed.error.issues.some(issue => issue.message === tooLargeScript) ? tooLargeScript : 'Invalid request. Check the connection or query settings.')
  return parsed.data
}

/** varia:connections-cancel: the Connect dialog's Stop, by the ids its connect and Load databases carried. */
export const connectionCancelSchema = z.object({ requestIds: z.array(z.uuid()).min(1).max(16) }).strict()

const u31 = z.number().int().min(1).max(2 ** 31 - 1)
const u32 = z.number().int().min(1).max(0xffffffff)
/** 1–64 inclusive [first, last] pairs, ascending and disjoint. */
const rangesSchema = (max: number) => z.array(z.tuple([z.number().int().min(0).max(max), z.number().int().min(0).max(max)])).min(1).max(64)
  .refine(ranges => ranges.every(([first, last], index) => first <= last && (index === 0 || first > ranges[index - 1][1])), 'Ranges must be ascending and disjoint.')
export const copyPartSchema = z.object({ rows: rangesSchema(Number.MAX_SAFE_INTEGER), columns: rangesSchema(limits.page.maxColumns - 1) }).strict()
/** varia:results-copy. Ownership and the generation are checked against the results port before anything runs. */
export const resultsCopyRequestSchema = z.object({ jobId: z.uuid(), generation: u31, resultId: u32, headers: z.boolean(), parts: z.array(copyPartSchema).min(1).max(64) }).strict()
/** varia:results-save. The name only suggests the file; the path comes from main's save dialog. */
export const resultsSaveRequestSchema = z.object({ jobId: z.uuid(), generation: u31, resultId: u32, format: z.enum(['csv', 'tsv', 'json']).optional(), suggestedName: z.string().min(1).max(limits.jobs.suggestedName) }).strict()
