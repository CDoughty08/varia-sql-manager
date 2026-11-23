import { z } from 'zod'
import { planParseSchema, planDocumentSchema } from '../shared/plans'
import { estimatedPlanRequestSchema, estimatedPlanResultSchema } from '../shared/estimated-plans'
import type { RpcMethod } from '../shared/contracts'
import { bigQueryDryRunRequestSchema, bigQueryDryRunResultSchema } from '../shared/bigquery/dry-run'
import { resultsRemoteQuerySchema } from '../shared/bigquery/remote-view'
import { bigQueryPreviewTargetSchema, bigQueryPropertiesRequestSchema, bigQueryPropertiesSchema } from '../shared/bigquery/objects'
import { jobKeySchema, queryAttachParamsSchema } from '../shared/bigquery/jobs'
import { bigQueryAccountSchema, bigQueryDatasetSchema, bigQueryCredentialParamsSchema, bigQueryProjectListSchema, bigQueryProjectsParamsSchema, connectionOptionsSchema, providerConnectionOptionsSchema } from '../shared/connections'
import { providerIds } from '../shared/providers'
import { connectionPrincipalIdSchema } from './connection-principal'
import { limits } from '../shared/ipc/wire/protocol'
import { localTableLimits } from '../shared/results/local-table'
import { dependenciesParamsSchema, explorerChildrenParamsSchema, peekDefinitionParamsSchema, peekDependenciesParamsSchema, peekParamsSchema } from '../shared/explorer/schema.ts'
import { bigQueryIndexEstimateRequestSchema, bigQueryIndexEstimateResultSchema, objectIndexParamsSchema, objectSearchParamsSchema } from '../shared/explorer/search.ts'
import { scriptRequestSchema } from '../shared/scripting/schema.ts'
import { actionDescribeSchema, actionExecuteRequestSchema, actionExecuteResultSchema, actionScriptRequestSchema } from '../shared/actions/schema.ts'
import { ssisCatalogSetupSchema, ssisDescribeSchema, ssisExecuteSchema } from '../shared/ssis/schema.ts'
import { activityDetailsRequestSchema, activityKillRequestSchema } from '../shared/activity/schema.ts'
import { agentProfileResultSchema, agentProfileSchema } from '../shared/agent/profile.ts'
import { agentHistoryMessageResultSchema, agentHistoryMessageSchema } from '../shared/agent/history.ts'
import { agentCounterValuesResultSchema, agentCounterValuesSchema } from '../shared/actions/agent-alert.ts'
import { agentErrorLogsResultSchema, agentErrorLogsSchema } from '../shared/agent/error-log.ts'
import { languageParseResultSchema, languageParseSchema } from '../shared/agent/parse.ts'
import { languageCloseSchema, languageRequestSchema, languageCompletionsSchema, languageHoverSchema, languageStatusSchema, languageRefreshRequestSchema, languageRefreshResultSchema, languageDiagnosticResultSchema, languageDefinitionSchema } from '../shared/language-service'

// Identifiers are used verbatim by the backend, so they are never trimmed here (a database may be named ' x').
const name = z.string().min(1).max(128).refine(value => value.trim().length > 0)
export const maxScriptCharacters = 1_000_000
const tooLargeScript = 'The script is too large to execute (limit: 1,000,000 characters). Execute a smaller selection.'
const connectionId = z.uuid()
const database = name
// A BigQuery dataset id (src/shared/connections.ts); SQL Server refuses one (methods.ts, queryOptionsAllow).
const dataset = bigQueryDatasetSchema
export const requestSchemas = {
  'language.status': z.object({}).strict(),
  'language.complete': languageRequestSchema,
  'language.hover': languageRequestSchema,
  'language.diagnostics': languageRefreshRequestSchema,
  'language.refresh': languageRefreshRequestSchema,
  'language.close': languageCloseSchema,
  'language.definition': languageRequestSchema,
  'plans.parse': planParseSchema,
  'plans.estimate': estimatedPlanRequestSchema,
  'system.health': z.object({}).strict(),
  // Either engine's options; main adds BigQuery's credential material before sending (never from the renderer).
  'connections.connect': providerConnectionOptionsSchema,
  'connections.databases': providerConnectionOptionsSchema,
  'connections.preview': connectionOptionsSchema,
  'connections.discover': z.object({ scope: z.enum(['local', 'network']) }).strict(),
  'connections.disconnect': z.object({ connectionId }).strict(),
  'bigquery.account': bigQueryCredentialParamsSchema,
  'bigquery.projects': bigQueryProjectsParamsSchema,
  'bigquery.dryRun': bigQueryDryRunRequestSchema,
  'bigquery.properties': bigQueryPropertiesRequestSchema,
  'bigquery.indexEstimate': bigQueryIndexEstimateRequestSchema,
  'connections.identity': z.object({}).strict(),
  'databases.list': z.object({ connectionId }).strict(),
  'tables.columns': z.object({ connectionId, database, schema: name, name }).strict(),
  'query.execute': z.object({
    connectionId, sessionId: z.uuid(), database: database.optional(), dataset: dataset.optional(), sql: z.string().min(1).max(maxScriptCharacters, tooLargeScript), queryId: z.uuid(),
    startLine: z.number().int().min(1).max(1_000_000).optional(), startColumn: z.number().int().min(1).max(1_000_000).optional(),
    maxRows: z.number().int().min(0).max(limits.maxRows), maxResultSets: z.number().int().min(limits.maxResultSets.min).max(limits.maxResultSets.max).optional(),
    timeoutSeconds: z.number().int().min(0).max(86400), stopOnError: z.boolean().optional(), includeActualPlan: z.boolean().optional(), includeClientStatistics: z.boolean().optional(), includeLivePlan: z.boolean().optional(), discardResults: z.boolean().optional(),
    maximumBytesBilled: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), prices: z.boolean().optional(), preview: bigQueryPreviewTargetSchema.optional(),
    residence: z.enum(['automatic', 'memory', 'windowed']).optional(), windowCacheMiB: z.number().int().min(16).max(4096).optional(), jobKey: jobKeySchema.optional()
  }).strict(),
  'query.cancel': z.object({ queryId: z.uuid(), detach: z.literal(true).optional() }).strict(),
  // A BigQuery job by its reference (docs/bigquery.md, Re-attaching to jobs); C# checks the bounds again.
  'query.attach': queryAttachParamsSchema.refine(params => params.maxRows <= limits.maxRows && params.maxResultSets >= limits.maxResultSets.min && params.maxResultSets <= limits.maxResultSets.max, 'Row limits are out of range.'),
  // A tab holding a job gets a job answer (keepJob or cancelJob) only, never with a transaction.
  'query.session.close': z.object({ sessionId: z.uuid(), transaction: z.enum(['commit', 'rollback']).optional(), abortOnRefusedCommit: z.boolean().optional(), keepJob: z.literal(true).optional(), cancelJob: z.literal(true).optional() }).strict()
    .refine(params => !(params.keepJob && params.cancelJob) && !((params.keepJob || params.cancelJob) && params.transaction), 'A job is left running or cancelled, and its transaction is not asked about.'),
  // Main checks the renderer owns the result, and every value list its filters name, in that generation before sending it.
  'results.remoteQuery': resultsRemoteQuerySchema,
  'query.session.state': z.object({ sessionId: z.uuid() }).strict(),
  // Distinct, as C# checks (SqlService.SetVisibility); an empty set says no result is shown.
  'results.visibility': z.object({ source: z.uuid(), seq: z.number().int().min(1).max(2 ** 31 - 1), visible: z.array(z.number().int().min(1).max(0xffffffff)).max(limits.visibility.maxResults).refine(ids => new Set(ids).size === ids.length, 'Result ids must be distinct.') }).strict(),
  'explorer.children': explorerChildrenParamsSchema,
  'explorer.index': objectIndexParamsSchema,
  'explorer.search': objectSearchParamsSchema,
  'explorer.peek': peekParamsSchema,
  'explorer.peekDependencies': peekDependenciesParamsSchema,
  'explorer.peekDefinition': peekDefinitionParamsSchema,
  'explorer.dependencies': dependenciesParamsSchema,
  'scripting.script': scriptRequestSchema,
  'actions.describe': actionDescribeSchema,
  'actions.script': actionScriptRequestSchema,
  'actions.execute': actionExecuteRequestSchema,
  'ssis.describe': ssisDescribeSchema,
  'ssis.execute': ssisExecuteSchema,
  'ssis.catalogSetup': ssisCatalogSetupSchema,
  'activity.details': activityDetailsRequestSchema,
  'activity.kill': activityKillRequestSchema,
  'agent.profile': agentProfileSchema,
  'agent.historyMessage': agentHistoryMessageSchema,
  'agent.counterValues': agentCounterValuesSchema,
  'agent.errorLogs': agentErrorLogsSchema,
  'language.parse': languageParseSchema
} satisfies Record<RpcMethod, z.ZodType>

/** Databases, or BigQuery's datasets with their locations (BigQueryService.ListDatasetsAsync bounds them the same). */
const databaseListSchema = z.array(z.object({
  name: z.string().min(1).max(1024), isSystem: z.boolean(), isSnapshot: z.boolean(), location: z.string().min(1).max(64).regex(/^[A-Za-z\d-]+$/).optional()
}).strict()).max(32_767)
// Shown as the dialog's User name: one line of at most 256 characters without control or formatting characters (C#: KerberosProbe.Bounded).
const principal = z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u)
/** Answers main checks before the renderer sees them: the backend is trusted, but these come from native code. */
export const resultSchemas: Partial<Record<RpcMethod, z.ZodType>> = {
  'connections.connect': z.object({
    // A BigQuery dataset name may be 1,024 characters; SQL Server's database names stay at 128.
    id: z.uuid(), server: z.string().max(256), database: z.string().max(1024), serverVersion: z.string().max(256), generation: z.number().int().min(0),
    displayName: z.string().max(128).optional(), color: z.string().regex(/^#[\da-f]{6}$/i).optional(), commandTimeout: z.number().int().min(0).max(86400).optional(),
    productVersion: z.string().max(32).optional(), login: principal.optional(), engineEdition: z.number().int().optional(), linux: z.boolean().optional(), providerId: z.enum(providerIds).optional(),
    principalId: connectionPrincipalIdSchema.optional(), bindingRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().refine(value => value.providerId === 'bigquery' ? value.principalId?.startsWith('bigquery:') !== false : value.database.length <= 128 && !value.principalId?.startsWith('bigquery:'),
    'A connection answer must match its provider.'),
  'bigquery.account': bigQueryAccountSchema,
  'bigquery.projects': bigQueryProjectListSchema,
  'bigquery.dryRun': bigQueryDryRunResultSchema,
  'bigquery.properties': bigQueryPropertiesSchema,
  'bigquery.indexEstimate': bigQueryIndexEstimateResultSchema,
  'connections.databases': databaseListSchema,
  'databases.list': databaseListSchema,
  'language.status': languageStatusSchema,
  'language.complete': languageCompletionsSchema,
  'language.hover': languageHoverSchema,
  'language.diagnostics': languageDiagnosticResultSchema,
  'language.refresh': languageRefreshResultSchema,
  'language.close': z.object({ closed: z.boolean() }).strict(),
  'language.definition': languageDefinitionSchema,
  'plans.parse': planDocumentSchema,
  'plans.estimate': estimatedPlanResultSchema,
  'connections.identity': z.object({ principal: principal.optional() }).strict(),
  'connections.disconnect': z.object({ disconnected: z.boolean(), failedAborts: z.number().int().min(0).max(2 ** 31 - 1).optional() }).strict(),
  'query.session.state': z.object({ transactionCount: z.number().int().min(0).max(2 ** 31 - 1), checked: z.boolean(), job: z.enum(['running', 'none']).optional() }).strict(),
  // Steps carry SQL Server's text and names: bounded here as in C# (ActionSteps.Bound).
  'actions.execute': actionExecuteResultSchema,
  'agent.profile': agentProfileResultSchema,
  'agent.historyMessage': agentHistoryMessageResultSchema,
  'agent.counterValues': agentCounterValuesResultSchema,
  'agent.errorLogs': agentErrorLogsResultSchema,
  'language.parse': languageParseResultSchema
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
/** varia:connections-accept acknowledges one delivered authenticated receipt; it never opens or authenticates. */
export const connectionAcceptSchema = z.object({ requestId: z.uuid() }).strict()
export const connectionPruneSchema = z.object({ targetIds: z.array(z.uuid()).min(1).max(200) }).strict()

const u31 = z.number().int().min(1).max(2 ** 31 - 1)
const u32 = z.number().int().min(1).max(0xffffffff)
/** 1–64 inclusive [first, last] pairs, ascending and disjoint. */
const rangesSchema = (max: number) => z.array(z.tuple([z.number().int().min(0).max(max), z.number().int().min(0).max(max)])).min(1).max(64)
  .refine(ranges => ranges.every(([first, last], index) => first <= last && (index === 0 || first > ranges[index - 1][1])), 'Ranges must be ascending and disjoint.')
export const copyPartSchema = z.object({ rows: rangesSchema(Number.MAX_SAFE_INTEGER), columns: rangesSchema(limits.page.maxColumns - 1) }).strict()
/** varia:results-copy. Ownership and the generation are checked against the results port before anything runs. */
/** A grid drawn transposed copies and saves as drawn; only such a request names the column whose values head its fields. */
const turned = { transposed: z.boolean().optional(), headerColumn: z.number().int().min(0).max(limits.page.maxColumns - 1).optional() }
const turnedRule = [(request: { transposed?: boolean; headerColumn?: number }) => request.headerColumn === undefined || request.transposed === true, 'Only a transposed request has a header column.'] as const
export const resultsCopyRequestSchema = z.object({ jobId: z.uuid(), generation: u31, resultId: u32, headers: z.boolean(), parts: z.array(copyPartSchema).min(1).max(64), viewId: u32.optional(), ...turned }).strict().refine(...turnedRule)
/** varia:results-save-local: a local table's rows, held to localTableLimits (rows as wide as the columns, 4 Mi characters in all). */
export const localSaveRequestSchema = z.object({
  suggestedName: z.string().min(1).max(limits.jobs.suggestedName),
  columns: z.array(z.object({ name: z.string().max(localTableLimits.nameChars), kind: z.enum(['text', 'number']).optional() }).strict()).min(1).max(localTableLimits.columns),
  rows: z.array(z.array(z.string().max(localTableLimits.cellChars).nullable()).max(localTableLimits.columns)).max(localTableLimits.rows)
}).strict()
  .refine(request => request.rows.every(row => row.length === request.columns.length), 'Every row has a cell per column.')
  .refine(request => request.rows.reduce((sum, row) => sum + row.reduce((chars, cell) => chars + (cell?.length ?? 0), 0), 0) <= localTableLimits.textChars, 'The table is too large.')
/** results.setMemoryLimit, which only main sends (Tools › Options' result memory limit): whole GiB, 0 automatic, at most
 *  1024 as the setting allows. The backend clamps it as at launch (ResultStore.GlobalBytesFor) and checks the same bounds. */
export const resultsMemoryLimitSchema = z.object({ limitGiB: z.number().int().min(0).max(1024) }).strict()
/** varia:results-save. The name only suggests the file; the path comes from main's save dialog. `suggestedSuffix`, the end
 *  of the name that tells results apart ('-Result2-Pivot'), is kept whole when main shortens the name. */
export const resultsSaveRequestSchema = z.object({ jobId: z.uuid(), generation: u31, resultId: u32, format: z.enum(['csv', 'tsv', 'json']).optional(), suggestedName: z.string().min(1).max(limits.jobs.suggestedName), suggestedSuffix: z.string().min(1).max(limits.jobs.suggestedName).optional(), viewId: u32.optional(), ...turned }).strict().refine(...turnedRule)
  .refine(request => request.suggestedSuffix === undefined || request.suggestedName.endsWith(request.suggestedSuffix), 'The suffix ends the suggested name.')
