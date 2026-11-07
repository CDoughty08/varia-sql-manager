import { z } from 'zod'

/** Independent of ordinary XML cell limits. The original XML stays in its document/result; parsed graphs live only while viewed. */
export const planLimits = { characters: 8_388_608, compressedBytes: 2_097_152, nodes: 10_000, statements: 512, depth: 256, properties: 64, text: 1_048_576, replyBytes: 12_582_912 } as const
export const maxQueryPlanDocuments = 64
const text = z.string().max(16_384)
const number = z.number().finite().nonnegative().nullable().default(null)
export const planNodeSchema = z.object({
  id: z.string().max(64), parentId: z.string().max(64).nullable().default(null), nodeId: z.string().max(64), physicalOp: text, logicalOp: text, object: text,
  estimatedRows: number, estimatedCost: number, actualRows: number, elapsedMs: number, cpuMs: number, executions: number,
  warnings: z.array(text).max(32), properties: z.array(z.object({ name: text, value: text }).strict()).max(planLimits.properties)
}).strict()
export const planStatementSchema = z.object({
  id: z.string().max(64), text, type: text, estimatedCost: number, warnings: z.array(text).max(32), nodes: z.array(planNodeSchema).max(planLimits.nodes)
}).strict()
export const planDocumentSchema = z.object({ version: text, build: text, statements: z.array(planStatementSchema).max(planLimits.statements), notices: z.array(text).max(8) }).strict()
export const planParseSchema = z.object({ xml: z.string().min(1).max(planLimits.characters) }).strict()
export type PlanDocument = z.infer<typeof planDocumentSchema>
export type PlanStatement = z.infer<typeof planStatementSchema>
export type PlanNode = z.infer<typeof planNodeSchema>
