import { z } from 'zod'

/** A unary acquisition, independent of query summaries, result cells, and live plan events. Mirrored in EstimatedPlanCapture. */
export const estimatedPlanLimits = { documents: 64, characters: 2_097_152, budgetMs: 30_000, deadlineMs: 35_000 } as const
/** Across query tabs, independent of the incoming response and the existing parsed-view caches. */
export const estimatedPlanCacheCharacters = 16_777_216
export const estimatedPlanRequestSchema = z.object({
  connectionId: z.uuid(), sessionId: z.uuid(), requestId: z.uuid(), database: z.string().min(1).max(128).refine(value => !!value.trim()),
  sql: z.string().min(1).max(1_000_000), startLine: z.number().int().min(1).max(1_000_000).optional()
}).strict()
export const estimatedPlanResultSchema = z.object({
  plans: z.array(z.object({ xml: z.string().min(1).max(estimatedPlanLimits.characters), batchNumber: z.number().int().positive(), iteration: z.number().int().positive() }).strict()).max(estimatedPlanLimits.documents),
  database: z.string().min(1).max(128)
}).strict().refine(value => value.plans.reduce((sum, plan) => sum + plan.xml.length, 0) <= estimatedPlanLimits.characters)
export type EstimatedPlanRequest = z.infer<typeof estimatedPlanRequestSchema>
export type EstimatedPlanResult = z.infer<typeof estimatedPlanResultSchema>
