// A stored result's descriptor as the backend sends it, before main stamps the generation: query events and summaries
// (port-messages.ts) and live ticks (src/shared/live/schema.ts) carry it.
import { z } from 'zod'
import { limits } from './wire/protocol'

const u32 = z.number().int().min(1).max(0xffffffff)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

// SqlCompareOptions' bits: IgnoreCase, IgnoreNonSpace, IgnoreKanaType, IgnoreWidth, BinarySort2 and BinarySort.
const compareOptions = 1 | 2 | 8 | 16 | 16384 | 32768
const collationSchema = z.object({
  lcid: z.number().int().min(0).max(0xfffff), sortId: z.number().int().min(0).max(255), codePage: z.number().int().min(0).max(65535), utf8: z.boolean(),
  options: z.number().int().min(0).max(65535).refine(value => (value & ~compareOptions) === 0)
}).strict()
const columnSchema = z.object({
  name: z.string().max(512), dataType: z.string().max(256), wire: z.enum(['text', 'binary']), role: z.enum(['xml', 'json', 'plan', 'udt', 'vector', 'tone']).optional(),
  maxLength: count.optional(), precision: count.optional(), scale: count.optional(), nullable: z.boolean(), collation: collationSchema.optional()
}).strict()
export const truncationSchema = z.enum(['rowLimit', 'queryBudget', 'globalBudget', 'systemMemory'])
/** A descriptor as the backend sends it, before main adds the generation. */
export const backendDescriptorSchema = z.object({
  resultId: u32, index: z.number().int().min(0).max(limits.maxResultSets.max), batchNumber: count, iteration: count, kind: z.enum(['rows', 'executionPlan', 'diff', 'pivot', 'transpose']),
  columns: z.array(columnSchema).min(1).max(limits.page.maxColumns), rowsRead: count, rowsStored: count, rowsAvailable: count, bytesStored: count, truncatedCells: count,
  state: z.enum(['open', 'complete', 'released']), truncated: truncationSchema.optional(), incomplete: z.boolean()
}).strict()
