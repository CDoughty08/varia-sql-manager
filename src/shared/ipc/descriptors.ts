// A stored result's descriptor as the backend sends it, before main stamps the generation: query events and summaries
// (port-messages.ts) and live ticks (src/shared/live/schema.ts) carry it.
import { z } from 'zod'
import { limits } from './wire/protocol'

const u32 = z.number().int().min(1).max(0xffffffff)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const columnSchema = z.object({
  name: z.string().max(512), dataType: z.string().max(256), wire: z.enum(['text', 'binary']), role: z.enum(['xml', 'json', 'plan', 'udt', 'vector']).optional(),
  maxLength: count.optional(), precision: count.optional(), scale: count.optional(), nullable: z.boolean()
}).strict()
const truncationSchema = z.enum(['rowLimit', 'queryBudget', 'globalBudget', 'systemMemory'])
/** A descriptor as the backend sends it, before main adds the generation. */
export const backendDescriptorSchema = z.object({
  resultId: u32, index: z.number().int().min(0).max(limits.maxResultSets.max), batchNumber: count, iteration: count, kind: z.enum(['rows', 'executionPlan']),
  columns: z.array(columnSchema).min(1).max(limits.page.maxColumns), rowsRead: count, rowsStored: count, rowsAvailable: count, bytesStored: count, truncatedCells: count,
  state: z.enum(['open', 'complete', 'released']), truncated: truncationSchema.optional(), incomplete: z.boolean()
}).strict()
