// The results port (docs/ipc.md): one MessagePort per renderer load between main and the results worker. The worker's
// requests are validated with portRequestSchema; backend payloads main forwards are validated with the schemas below.
import { z } from 'zod'
import type { BackendStatus, QueryEvent, ResultsCloseResult, ResultsReadResult } from '../contracts'
import { limits, type ErrorCode } from './wire/protocol'

const u31 = z.number().int().min(1).max(2 ** 31 - 1)
const u32 = z.number().int().min(1).max(0xffffffff)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const generation = u31

/** Worker → main. `rid` names the request in the worker; every request ends with one `end` message. */
export const portRequestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('read'), rid: u31, generation, resultId: u32, firstRow: count, maxRows: z.number().int().min(1).max(65_536), credit: z.number().int().min(limits.credit.min).max(limits.credit.max) }).strict(),
  z.object({ t: z.literal('credit'), rid: u31, bytes: z.number().int().min(1).max(limits.credit.max) }).strict(),
  z.object({ t: z.literal('cancel'), rid: u31 }).strict(),
  z.object({ t: z.literal('close'), rid: u31, generation, resultIds: z.array(u32).min(1).max(1024) }).strict()
])
export type PortRequest = z.infer<typeof portRequestSchema>

/** Main → worker. Page bodies are exact-size ArrayBuffers, never decoded by main. */
export type PortMessage =
  | { t: 'backend'; generation: number; status: BackendStatus }
  | { t: 'page'; rid: number; seq: number; body: ArrayBuffer }
  | { t: 'end'; rid: number; ok: true; result: ResultsReadResult | ResultsCloseResult }
  | { t: 'end'; rid: number; ok: false; code: ErrorCode; message: string }
  | { t: 'query'; queryId: string; event: QueryEvent }
  | { t: 'memory'; usedBytes: number; globalBytes: number; generation: number; seq: number }

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
const message = z.object({ text: z.string().max(limits.messages.characters), kind: z.enum(['info', 'error']) }).strict()
/** EVENT bodies for a query.execute request. */
export const queryEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resultSet.opened'), descriptor: backendDescriptorSchema }).strict(),
  z.object({ type: z.literal('resultSet.closed'), descriptor: backendDescriptorSchema }).strict(),
  z.object({
    type: z.literal('progress'), completedBatches: count, totalBatches: count, batchNumber: count, iteration: count,
    results: z.array(z.object({ resultId: u32, rowsRead: count, rowsStored: count, rowsAvailable: count, bytesStored: count }).strict()).max(64)
  }).strict(),
  z.object({ type: z.literal('messages'), messages: z.array(message).min(1).max(limits.messages.count) }).strict()
])
/** The query.execute summary: the stored messages, the errors kept past their cap, and up to 8 notes about truncation. */
export const queryResultSchema = z.object({
  resultSets: z.array(backendDescriptorSchema).max(limits.maxResultSets.max), discardedResultSets: count, messages: z.array(message).max(limits.messages.count + limits.messages.lateErrors + 8),
  recordsAffected: z.number().int().min(-1), elapsedMs: count, status: z.enum(['completed', 'failed', 'cancelled', 'timedOut']),
  error: z.object({ code: z.string().max(64), message: z.string().max(limits.messages.errorCharacters + 1), batchNumber: count, iteration: count }).strict().optional(),
  completedBatches: count, totalBatches: count, database: z.string().max(256), messagesTruncated: z.boolean(),
  budget: z.object({ usedBytes: count, globalBytes: count, queryBytes: count, seq: count }).strict(), completedAt: z.string().max(40)
}).strict()
/** EVENT bodies for a results.copy or results.export request; droppable, the latest wins. */
export const jobProgressSchema = z.object({ type: z.literal('job.progress'), rowsDone: count, rowsTotal: count, bytes: count }).strict()
export type JobProgressEvent = z.infer<typeof jobProgressSchema>
/** The global EVENT (id 0) for result memory; `seq` orders it with the summaries' budgets (QueryResult). */
export const memoryEventSchema = z.object({ type: z.literal('results.memory'), usedBytes: count, globalBytes: count, seq: count }).strict()
