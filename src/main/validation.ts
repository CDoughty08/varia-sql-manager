import { z } from 'zod'
import type { RpcMethod } from '../shared/contracts'
import { serverObjectKinds } from '../shared/contracts'
import { connectionOptionsSchema } from '../shared/connections'
import { limits } from '../shared/ipc/wire/protocol'
import { explorerChildrenParamsSchema } from '../shared/explorer/schema.ts'

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
  'databases.list': z.object({ connectionId }).strict(),
  'server.objects.list': z.object({ connectionId, kind: z.enum(serverObjectKinds) }).strict(),
  'tables.list': z.object({ connectionId, database }).strict(),
  'tables.script': z.object({ connectionId, database, schema: name, name }).strict(),
  'tables.columns': z.object({ connectionId, database, schema: name, name }).strict(),
  'query.execute': z.object({
    connectionId, sessionId: z.uuid(), database, sql: z.string().min(1).max(maxScriptCharacters, tooLargeScript), queryId: z.uuid(),
    startLine: z.number().int().min(1).max(1_000_000).optional(),
    maxRows: z.number().int().min(0).max(limits.maxRows), maxResultSets: z.number().int().min(limits.maxResultSets.min).max(limits.maxResultSets.max).optional(),
    timeoutSeconds: z.number().int().min(0).max(86400)
  }).strict(),
  'query.cancel': z.object({ queryId: z.uuid() }).strict(),
  'query.session.close': z.object({ sessionId: z.uuid() }).strict(),
  'explorer.children': explorerChildrenParamsSchema
} satisfies Record<RpcMethod, z.ZodType>

export function validateRequest(method: string, params: unknown): unknown {
  if (typeof method !== 'string' || !Object.hasOwn(requestSchemas, method)) throw new Error('Unsupported backend method.')
  const parsed = requestSchemas[method as RpcMethod].safeParse(params)
  if (!parsed.success) throw new Error(parsed.error.issues.some(issue => issue.message === tooLargeScript) ? tooLargeScript : 'Invalid request. Check the connection or query settings.')
  return parsed.data
}
