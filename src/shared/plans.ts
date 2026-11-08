import { z } from 'zod'

/** Independent of ordinary XML cell limits. The original XML stays in its document/result; parsed graphs live only while viewed. */
export const planLimits = { characters: 8_388_608, compressedBytes: 2_097_152, nodes: 10_000, statements: 512, depth: 256, properties: 64, text: 1_048_576, replyBytes: 12_582_912 } as const
export const maxQueryPlanDocuments = 64
const text = z.string().max(16_384)
const number = z.number().finite().nonnegative().nullable().default(null)
const properties = z.array(z.object({ name: text, value: text }).strict()).max(planLimits.properties)
const detail = z.object({ kind: text, properties }).strict()
const thread = z.object({ thread: number, rows: number, rowsRead: number, executions: number, cpuMs: number, elapsedMs: number, executionMode: text, properties }).strict()
export const operatorDiagnosticsSchema = z.object({
  estimatedExecutions: number, parallel: z.boolean().nullable().default(null), estimatedExecutionMode: text,
  predicates: z.array(z.object({ kind: text, comparison: text, columns: z.array(text).max(64), expressions: z.array(text).max(64) }).strict()).max(64),
  outputColumns: z.array(text).max(64), warnings: z.array(detail).max(64), spills: z.array(detail).max(64),
  threads: z.array(thread).max(128), runtimeDetailsAvailable: z.boolean()
}).strict()
const statementDiagnosticsSchema = z.object({
  degreeOfParallelism: number, memoryGrant: properties, warnings: z.array(detail).max(64),
  parameters: z.array(z.object({ name: text, dataType: text, compiledValue: text.nullable().default(null), runtimeValue: text.nullable().default(null) }).strict()).max(64),
  missingIndexes: z.array(z.object({ database: text, schema: text, table: text, impact: number,
    columns: z.array(z.object({ usage: text, name: text }).strict()).max(64) }).strict()).max(64)
}).strict()
export const planNodeSchema = z.object({
  id: z.string().max(64), parentId: z.string().max(64).nullable().default(null), nodeId: z.string().max(64), physicalOp: text, logicalOp: text, object: text,
  estimatedRows: number, estimatedCost: number, actualRows: number, elapsedMs: number, cpuMs: number, executions: number,
  warnings: z.array(text).max(32), properties, diagnostics: operatorDiagnosticsSchema.optional(), liveActivity: z.boolean().optional()
}).strict()
export const planStatementSchema = z.object({
  id: z.string().max(64), statementId: z.string().max(64).optional(), queryHash: z.string().max(64).optional(), text, type: text, estimatedCost: number, warnings: z.array(text).max(32), nodes: z.array(planNodeSchema).max(planLimits.nodes), diagnostics: statementDiagnosticsSchema.optional()
}).strict()
export const planDocumentSchema = z.object({ version: text, build: text, statements: z.array(planStatementSchema).max(planLimits.statements), notices: z.array(text).max(8) }).strict()
export const planParseSchema = z.object({ xml: z.string().min(1).max(planLimits.characters) }).strict()
export type PlanDocument = z.infer<typeof planDocumentSchema>
export type PlanStatement = z.infer<typeof planStatementSchema>
export type PlanNode = z.infer<typeof planNodeSchema>

/** Only topology changes carry a document. Counter frames are bounded and replace the previous sample. */
export const livePlanFrameSchema = z.object({
  batch: z.number().int().min(1).max(100_000), iteration: z.number().int().min(1).max(100_000),
  revision: z.number().int().nonnegative(), document: planDocumentSchema.optional(),
  counters: z.array(z.object({ id: z.string().max(64), rows: number, elapsedMs: number, cpuMs: number, executions: number }).strict()).max(planLimits.nodes)
}).strict()
export type LivePlanFrame = z.infer<typeof livePlanFrameSchema>
