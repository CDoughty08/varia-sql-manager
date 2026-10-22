// The results port (docs/ipc.md): one MessagePort per renderer load between main and the results worker. The worker's
// requests are validated with portRequestSchema; backend payloads main forwards are validated with the schemas below.
import { z } from 'zod'
import type { BackendStatus, QueryEvent, ResultsCloseResult, ResultsReadResult } from '../contracts'
import { liveSubscribeParamsSchema, liveUpdateParamsSchema, testLiveSubscribeParamsSchema, testLiveUpdateParamsSchema, type LiveEnd, type LiveEvent, type LiveSubscribeParams, type LiveUpdateParams, type LiveUpdateResult } from '../live/schema'
import { backendDescriptorSchema } from './descriptors'
import { limits, type ErrorCode } from './wire/protocol'

export { backendDescriptorSchema }

const u31 = z.number().int().min(1).max(2 ** 31 - 1)
const u32 = z.number().int().min(1).max(0xffffffff)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const generation = u31

/** The port schema around a set of live schemas (buildLiveSchemas): the shipped ones, or a test catalogue's. */
export const buildPortRequestSchema = (live: { subscribe: z.ZodType<LiveSubscribeParams>; update: z.ZodType<LiveUpdateParams> }) => z.discriminatedUnion('t', [
  z.object({ t: z.literal('read'), rid: u31, generation, resultId: u32, firstRow: count, maxRows: z.number().int().min(1).max(65_536), credit: z.number().int().min(limits.credit.min).max(limits.credit.max) }).strict(),
  z.object({ t: z.literal('credit'), rid: u31, bytes: z.number().int().min(1).max(limits.credit.max) }).strict(),
  z.object({ t: z.literal('cancel'), rid: u31 }).strict(),
  z.object({ t: z.literal('close'), rid: u31, generation, resultIds: z.array(u32).min(1).max(1024) }).strict(),
  // Live subscriptions (docs/ipc.md): a stream acknowledged with `credit`, ended with `cancel`, changed with liveUpdate.
  z.object({ t: z.literal('live'), rid: u31, generation, params: live.subscribe }).strict(),
  z.object({ t: z.literal('liveUpdate'), rid: u31, generation, params: live.update }).strict()
])
/** Worker → main. `rid` names the request in the worker; every request ends with one `end` message. */
export const portRequestSchema = buildPortRequestSchema({ subscribe: liveSubscribeParamsSchema, update: liveUpdateParamsSchema })
/** The same for unpackaged smoke runs: live requests may also name test-only sources (debug.synthetic). */
export const testPortRequestSchema = buildPortRequestSchema({ subscribe: testLiveSubscribeParamsSchema, update: testLiveUpdateParamsSchema })
export type PortRequest = z.infer<typeof portRequestSchema>

/** Main → worker. Page bodies are exact-size ArrayBuffers, never decoded by main. A live event carries the EVENT body's
 *  length, which the worker grants back once the page has applied it. */
export type PortMessage =
  | { t: 'backend'; generation: number; status: BackendStatus }
  | { t: 'page'; rid: number; seq: number; body: ArrayBuffer }
  | { t: 'end'; rid: number; ok: true; result: PortEndResult }
  | { t: 'end'; rid: number; ok: false; code: ErrorCode; message: string }
  | { t: 'query'; queryId: string; event: QueryEvent }
  | { t: 'memory'; usedBytes: number; globalBytes: number; generation: number; seq: number }
  | { t: 'live'; rid: number; bytes: number; event: LiveEvent }
export type PortEndResult = ResultsReadResult | ResultsCloseResult | LiveEnd | LiveUpdateResult

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
  recordsAffected: z.number().int().min(-1), elapsedMs: count, status: z.enum(['completed', 'completedWithErrors', 'failed', 'cancelled', 'timedOut']),
  error: z.object({ code: z.string().max(64), message: z.string().max(limits.messages.errorCharacters + 1), batchNumber: count, iteration: count }).strict().optional(),
  completedBatches: count, totalBatches: count, database: z.string().max(256), messagesTruncated: z.boolean(),
  budget: z.object({ usedBytes: count, globalBytes: count, queryBytes: count, seq: count }).strict(), completedAt: z.string().max(40),
  // The session's @@SPID (a smallint) and SUSER_SNAME(), read when it opened.
  spid: z.number().int().min(0).max(32767).optional(), login: z.string().max(128).optional()
}).strict()
/** EVENT bodies for a results.copy or results.export request; droppable, the latest wins. */
export const jobProgressSchema = z.object({ type: z.literal('job.progress'), rowsDone: count, rowsTotal: count, bytes: count }).strict()
export type JobProgressEvent = z.infer<typeof jobProgressSchema>
/** The global EVENT (id 0) for result memory; `seq` orders it with the summaries' budgets (QueryResult). */
export const memoryEventSchema = z.object({ type: z.literal('results.memory'), usedBytes: count, globalBytes: count, seq: count }).strict()
