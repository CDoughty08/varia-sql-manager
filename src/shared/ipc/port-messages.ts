// The results port (docs/ipc.md): one MessagePort per renderer load between main and the results worker. The worker's
// requests are validated with portRequestSchema; backend payloads main forwards are validated with the schemas below.
import { z } from 'zod'
import { clientStatisticsSchema } from '../client-statistics'
import type { BackendStatus, MemoryOrder, QueryEvent, ResultMemoryDetail, ResultsCloseResult, ResultsDiffResult, ResultsDistinctCloseResult, ResultsDistinctReadResult, ResultsDistinctResult, ResultsDistinctTickResult, ResultsFindRowsResult, ResultsIdentifyResult, ResultsPivotResult, ResultsProfileResult, ResultsReadResult, ResultsRowBytesResult, ResultsRowIdsResult, ResultsSearchResult, ResultsViewCloseResult, ResultsViewResult } from '../contracts'
import { maxQueryPlanDocuments } from '../plans'
import { liveSubscribeParamsSchema, liveUpdateParamsSchema, testLiveSubscribeParamsSchema, testLiveUpdateParamsSchema, type LiveEnd, type LiveEvent, type LiveSubscribeParams, type LiveUpdateParams, type LiveUpdateResult } from '../live/schema'
import { backendDescriptorSchema, truncationSchema } from './descriptors'
import { limits, type ErrorCode } from './wire/protocol'

export { backendDescriptorSchema }

const u31 = z.number().int().min(1).max(2 ** 31 - 1)
const u32 = z.number().int().min(1).max(0xffffffff)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const generation = u31
/** A row identity (results.identify): a hash below 2^53. */
const identityId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const viewSortKeySchema = z.object({ column: z.number().int().min(0).max(limits.page.maxColumns - 1), descending: z.boolean(), mode: z.enum(['value', 'chars', 'bytes']) }).strict()
const column = z.number().int().min(0).max(limits.page.maxColumns - 1)
/** A base row a filter names (rows are below 2^31). */
const filterRow = z.number().int().min(0).max(2 ** 31 - 1)
const filterRows = z.array(filterRow).max(limits.views.maxFilterValues)
const filterOp = z.enum(['in', 'notIn', 'between'])
const distinctColumns = z.array(column).min(1).max(limits.page.maxColumns).refine(columns => new Set(columns).size === columns.length, 'Columns must be distinct.')
/** Selected cells: [first, count] ranges of positions in a view, or in the result. */
const filterCells = z.object({ ranges: z.array(z.tuple([count, z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)])).min(1).max(limits.views.maxFilterRanges), viewId: u32.optional() }).strict()
/** The base rows a keepRows filter keeps (ViewSorter.MaxKeepRows in C#). */
const keptRows = z.array(filterRow).min(1).max(limits.transpose.maxRows)
export const viewFilterSchema = z.union([
  z.object({ op: filterOp, column, rows: filterRows, nulls: z.boolean().optional() }).strict(),
  z.object({ op: filterOp, column, cells: filterCells }).strict(),
  z.object({ op: z.literal('duplicates'), columns: distinctColumns }).strict(),
  z.object({ op: z.literal('groups'), column, snapshotId: u32 }).strict(),
  z.object({ op: z.literal('keepRows'), rows: keptRows }).strict(),
  z.object({ op: z.literal('keepRows'), cells: filterCells }).strict()
])
/** A group: a value's place in a snapshot's value order (below 2^31, as rows are). */
const group = filterRow
const resolvedFilterSchema = z.union([
  z.object({ op: filterOp, column, rows: filterRows, nulls: z.boolean() }).strict(),
  z.object({ op: z.literal('duplicates'), columns: distinctColumns }).strict(),
  z.object({ op: z.literal('groups'), column, snapshotId: u32, keep: z.boolean(), values: group, nulls: z.boolean(), row: filterRow.optional() }).strict()
    .refine(filter => filter.row === undefined || filter.values === 1, 'A row names the one value.'),
  z.object({ op: z.literal('keepRows'), rows: keptRows }).strict()
])

/** One pivot value: an aggregate of a column; only count may leave the column out (it then counts rows). */
export const pivotValueSchema = z.union([
  z.object({ aggregate: z.enum(['count', 'countDistinct', 'sum', 'avg', 'min', 'max']), column }).strict(),
  z.object({ aggregate: z.literal('count') }).strict()
])

/** The port schema around a set of live schemas (buildLiveSchemas): the shipped ones, or a test catalogue's. */
export const buildPortRequestSchema = (live: { subscribe: z.ZodType<LiveSubscribeParams>; update: z.ZodType<LiveUpdateParams> }) => z.discriminatedUnion('t', [
  z.object({ t: z.literal('read'), rid: u31, generation, resultId: u32, firstRow: count, maxRows: z.number().int().min(1).max(65_536), credit: z.number().int().min(limits.credit.min).max(limits.credit.max), viewId: u32.optional() }).strict(),
  z.object({ t: z.literal('credit'), rid: u31, bytes: z.number().int().min(1).max(limits.credit.max) }).strict(),
  z.object({ t: z.literal('cancel'), rid: u31 }).strict(),
  z.object({ t: z.literal('close'), rid: u31, generation, resultIds: z.array(u32).min(1).max(1024) }).strict(),
  z.object({ t: z.literal('rowBytes'), rid: u31, generation, resultId: u32, firstRow: count, count: z.number().int().min(1).max(limits.rowSizes.maxRows), viewId: u32.optional() }).strict(),
  // Views (results.view): a result's rows sorted in the backend, read with `read` and `rowBytes` by viewId.
  z.object({ t: z.literal('view'), rid: u31, generation, resultId: u32, sort: z.array(viewSortKeySchema).max(limits.views.maxKeys), filters: z.array(viewFilterSchema).min(1).max(limits.views.maxFilters).optional(), replaces: u32.optional() }).strict()
    .refine(request => request.sort.length > 0 || request.filters !== undefined, 'A view needs a sort key or a filter.'),
  z.object({ t: z.literal('viewClose'), rid: u31, generation, resultId: u32, viewIds: z.array(u32).min(1).max(limits.views.maxClose) }).strict(),
  // Row identities (results.identify, rowIds, findRows): highlights find their rows by them after a sort or a re-run.
  z.object({ t: z.literal('identify'), rid: u31, generation, resultId: u32, by: z.enum(['auto', 'column', 'row']), column: z.number().int().min(0).max(limits.page.maxColumns - 1).optional() }).strict()
    .refine(request => (request.by === 'column') === (request.column !== undefined), 'A column goes with by: column only.'),
  z.object({ t: z.literal('rowIds'), rid: u31, generation, resultId: u32, firstRow: count, count: z.number().int().min(1).max(limits.identity.maxRows), viewId: u32.optional() }).strict(),
  z.object({ t: z.literal('findRows'), rid: u31, generation, resultId: u32, ids: z.array(identityId).min(1).max(limits.identity.maxFind), viewId: u32.optional() }).strict(),
  // A unified diff of two results of one query (results.diff), stored as a new result the port then owns.
  z.object({ t: z.literal('diff'), rid: u31, generation, resultId: u32, right: u32, exact: z.boolean(), context: z.number().int().min(-1).max(limits.diff.maxContext) }).strict()
    .refine(request => request.resultId !== request.right, 'A result is not compared with itself.'),
  // Search (results.search): the cells containing a text, through a view when one is named; `cancel` stops it.
  z.object({
    t: z.literal('search'), rid: u31, generation, resultId: u32, text: z.string().min(1).max(limits.search.maxText), fromRow: count,
    maxMatches: z.number().int().min(1).max(limits.search.maxMatches), backward: z.boolean().optional(), viewId: u32.optional()
  }).strict(),
  // Column profiles (results.profile): aggregates over a result's rows or a view's; `cancel` stops one.
  z.object({ t: z.literal('profile'), rid: u31, generation, resultId: u32, columns: z.array(z.number().int().min(0).max(limits.page.maxColumns - 1)).max(limits.profile.maxColumns).refine(columns => new Set(columns).size === columns.length, 'Columns must be distinct.'), viewId: u32.optional() }).strict(),
  // A pivot (results.pivot) of a result's rows or a view's, stored as a new result the port then owns; `cancel` stops one.
  z.object({
    t: z.literal('pivot'), rid: u31, generation, resultId: u32, rows: z.array(column).max(limits.pivot.maxRowFields).refine(columns => new Set(columns).size === columns.length, 'Columns must be distinct.'),
    column: column.optional(), values: z.array(pivotValueSchema).min(1).max(limits.pivot.maxValues), viewId: u32.optional()
  }).strict().refine(request => request.column === undefined || !request.rows.includes(request.column), 'The column group is not a row column.'),
  // Distinct snapshots (results.distinct and its windows, ticks and close): a column's values and counts over a result's rows
  // or a view's, kept in the backend for the funnel's checklist; `cancel` stops building one, or a read.
  z.object({ t: z.literal('distinct'), rid: u31, generation, resultId: u32, column, viewId: u32.optional(), keptViewId: u32.optional() }).strict(),
  z.object({
    t: z.literal('distinctRead'), rid: u31, generation, resultId: u32, snapshotId: u32, order: z.enum(['count', 'value']), offset: group,
    count: z.number().int().min(1).max(limits.distinct.maxWindow), search: z.string().min(1).max(limits.search.maxText).optional()
  }).strict(),
  z.object({
    t: z.literal('distinctTick'), rid: u31, generation, resultId: u32, snapshotId: u32, checked: z.boolean(), groups: z.array(group).min(1).max(limits.distinct.maxWindow).optional(),
    all: z.literal(true).optional(), search: z.string().min(1).max(limits.search.maxText).optional(), nulls: z.boolean().optional()
  }).strict().refine(request => !(request.all && request.groups) && (request.search === undefined || request.all === true) && (request.all || request.groups || request.nulls !== undefined),
    'Tick some values, every value (a search\'s with one), or NULL.'),
  z.object({ t: z.literal('distinctClose'), rid: u31, generation, resultId: u32, snapshotIds: z.array(u32).min(1).max(limits.distinct.maxClose) }).strict(),
  // Live subscriptions (docs/ipc.md): a stream acknowledged with `credit`, ended with `cancel`, changed with liveUpdate.
  z.object({ t: z.literal('live'), rid: u31, generation, params: live.subscribe }).strict(),
  z.object({ t: z.literal('liveUpdate'), rid: u31, generation, params: live.update }).strict()
])
/** Worker → main. `rid` names the request in the worker; every request ends with one `end` message. */
export const portRequestSchema = buildPortRequestSchema({ subscribe: liveSubscribeParamsSchema, update: liveUpdateParamsSchema })
/** The same for unpackaged smoke runs: live requests may also name test-only sources (debug.synthetic). */
export const testPortRequestSchema = buildPortRequestSchema({ subscribe: testLiveSubscribeParamsSchema, update: testLiveUpdateParamsSchema })
export type PortRequest = z.infer<typeof portRequestSchema>

export type MemoryFeature = 'results' | 'index'
/** A budget's figures; a results.memory event also carries `detail`, which a query summary's budget does not. */
export type MemoryReport = { readonly usedBytes: number; readonly globalBytes: number; readonly detail?: ResultMemoryDetail } & MemoryOrder

/** Main → worker. Page bodies are exact-size ArrayBuffers, never decoded by main. A live event carries the EVENT body's
 *  length, which the worker grants back once the page has applied it. */
export type PortMessage =
  | { t: 'backend'; generation: number; status: BackendStatus }
  | { t: 'page'; rid: number; seq: number; body: ArrayBuffer }
  | { t: 'end'; rid: number; ok: true; result: PortEndResult }
  | { t: 'end'; rid: number; ok: false; code: ErrorCode; message: string }
  | { t: 'query'; queryId: string; event: QueryEvent }
  | ({ t: 'memory'; feature: MemoryFeature } & MemoryReport)
  | { t: 'live'; rid: number; bytes: number; event: LiveEvent }
/** A results.rowBytes answer as the backend sends it; main also checks it answers the range asked before forwarding it. */
export const rowBytesResultSchema = z.object({ firstRow: count, bytes: z.array(count).max(limits.rowSizes.maxRows), rowsAvailable: count, estimated: z.array(count).max(limits.rowSizes.maxRows) }).strict()
/** A results.view answer as the backend sends it. */
export const viewResultSchema = z.object({ viewId: u32, rows: count, baseRows: count, complete: z.boolean(), approximate: z.boolean(), filters: z.array(resolvedFilterSchema).max(limits.views.maxFilters).optional() }).strict()
export const viewCloseResultSchema = z.object({ closed: z.number().int().min(0).max(limits.views.maxClose) }).strict()
/** Identity answers as the backend sends them; main also checks they answer what was asked before forwarding them. */
export const identifyResultSchema = z.object({ column: z.number().int().min(-1).max(limits.page.maxColumns - 1), unique: z.boolean(), approximate: z.boolean(), rows: count }).strict()
export const rowIdsResultSchema = z.object({ firstRow: count, ids: z.array(z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)).max(limits.identity.maxRows), rows: count }).strict()
export const findRowsResultSchema = z.object({ positions: z.array(count).max(limits.identity.maxMatches), marks: z.array(z.number().int().min(0).max(limits.identity.maxFind - 1)).max(limits.identity.maxMatches), truncated: z.boolean(), rows: count }).strict()
  .refine(result => result.positions.length === result.marks.length && result.positions.every((position, index) => index === 0 || position > result.positions[index - 1]), 'Positions ascend, one mark each.')
const columnNames = z.array(z.string().max(512)).max(limits.diff.maxColumnNames)
/** A results.diff answer as the backend sends it (its descriptor without the generation, which main adds). */
export const diffResultSchema = z.object({
  descriptor: backendDescriptorSchema.extend({ kind: z.literal('diff') }), key: z.string().max(512).nullable(), same: count, changed: count, added: count, removed: count, soft: count,
  approximate: z.boolean(), leftOnly: columnNames, rightOnly: columnNames
}).strict()
/** A results.search answer as the backend sends it: a run of at most maxMatches plus one row's columns. Main also checks
 *  its matches are in order and inside the rows searched before forwarding it. */
const maxRun = limits.search.maxMatches + limits.page.maxColumns
export const searchResultSchema = z.object({
  rows: count, total: count, first: count, matchRows: z.array(count).max(maxRun), matchColumns: z.array(z.number().int().min(0).max(limits.page.maxColumns - 1)).max(maxRun),
  complete: z.boolean(), approximate: z.boolean()
}).strict()
const lengths = z.object({ min: count, max: count, average: z.number().min(0).max(Number.MAX_SAFE_INTEGER), exact: z.boolean() }).strict()
const profileValue = z.string().max(limits.profile.valueChars + 1).optional()
/** A results.profile answer as the backend sends it; main also checks it answers the columns asked, in order. */
export const profileResultSchema = z.object({
  rows: count, complete: z.boolean(), rowBytes: lengths.optional(),
  columns: z.array(z.object({
    column: z.number().int().min(0).max(limits.page.maxColumns - 1), values: count, nulls: count, distinct: count, distinctExact: z.boolean(), min: profileValue, max: profileValue,
    approximate: z.boolean(), chars: lengths.optional(), bytes: lengths.optional(),
    histogram: z.object({ basis: z.enum(['value', 'time', 'chars', 'bytes']), low: z.number(), high: z.number(), counts: z.array(count).length(limits.profile.bins) }).strict().optional()
  }).strict()).max(limits.profile.maxColumns)
}).strict()
/** A results.pivot answer as the backend sends it (its descriptor without the generation, which main adds). */
export const pivotResultSchema = z.object({
  descriptor: backendDescriptorSchema.extend({ kind: z.literal('pivot') }), rows: count, rowGroups: z.number().int().min(0).max(limits.pivot.maxRowGroups),
  columnGroups: z.number().int().min(0).max(limits.pivot.maxColumnGroups), approximate: z.boolean()
}).strict().refine(result => result.descriptor.rowsStored === result.rowGroups, 'A pivot stores a row per row group.')
/** A results.distinct answer as the backend sends it: its ticks within its values. */
export const distinctResultSchema = z.object({
  snapshotId: u32, rows: count, complete: z.boolean(), nulls: count, distinct: count, approximate: z.boolean(), checked: count, nullsChecked: z.boolean()
}).strict().refine(result => result.checked <= result.distinct && result.distinct + result.nulls <= result.rows, 'The ticks and counts fit the rows.')
/** A results.distinctRead answer: each value its group, a filter's row, text cut as the limits say and a count of at least
 *  one row; main also checks the window against the request. */
export const distinctReadResultSchema = z.object({
  total: count, offset: count, checked: count, nullsChecked: z.boolean(),
  values: z.array(z.object({ group, row: filterRow, text: z.string().max(limits.distinct.valueChars + 1), count: count.min(1), checked: z.boolean() }).strict()).max(limits.distinct.maxWindow)
}).strict().refine(result => result.offset + result.values.length <= Math.max(result.total, result.offset), 'The window lies in the values.')
export const distinctTickResultSchema = z.object({ checked: count, nullsChecked: z.boolean() }).strict()
export const distinctCloseResultSchema = z.object({ closed: z.number().int().min(0).max(limits.distinct.maxClose) }).strict()
export type PortEndResult = ResultsPivotResult | ResultsDistinctResult | ResultsDistinctReadResult | ResultsDistinctTickResult | ResultsDistinctCloseResult | ResultsDiffResult | ResultsReadResult | ResultsCloseResult | ResultsRowBytesResult | ResultsViewResult | ResultsViewCloseResult | ResultsIdentifyResult | ResultsRowIdsResult | ResultsFindRowsResult | ResultsSearchResult | ResultsProfileResult | LiveEnd | LiveUpdateResult

const message = z.object({ text: z.string().max(limits.messages.characters), kind: z.enum(['info', 'server', 'print', 'error']), line: z.number().int().min(1).max(2_147_483_647).optional() }).strict()
const session = { spid: z.number().int().min(0).max(32767), login: z.string().max(128).optional() }
/** EVENT bodies for a query.execute request. */
export const queryEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.opened'), ...session }).strict(),
  z.object({ type: z.literal('resultSet.opened'), descriptor: backendDescriptorSchema }).strict(),
  z.object({ type: z.literal('resultSet.closed'), descriptor: backendDescriptorSchema }).strict(),
  z.object({
    type: z.literal('progress'), completedBatches: count, totalBatches: count, batchNumber: count, iteration: count,
    results: z.array(z.object({ resultId: u32, rowsRead: count, rowsStored: count, rowsAvailable: count, bytesStored: count, truncated: truncationSchema.optional() }).strict()).max(64)
  }).strict(),
  z.object({ type: z.literal('messages'), messages: z.array(message).min(1).max(limits.messages.count) }).strict()
])
/** The query.execute summary: the stored messages, the errors kept past their cap, and up to 8 notes about truncation. */
export const queryResultSchema = z.object({
  clientStatistics: clientStatisticsSchema.optional(),
  resultSets: z.array(backendDescriptorSchema).max(limits.maxResultSets.max), discardedResultSets: count, messages: z.array(message).max(limits.messages.count + limits.messages.lateErrors + 8),
  planSets: z.array(backendDescriptorSchema.extend({ kind: z.literal('executionPlan') })).max(maxQueryPlanDocuments).optional(),
  planOrder: z.array(u32).max(limits.maxResultSets.max + maxQueryPlanDocuments).optional(),
  recordsAffected: z.number().int().min(-1), elapsedMs: count, status: z.enum(['completed', 'completedWithErrors', 'failed', 'cancelled', 'timedOut']),
  error: z.object({ code: z.string().max(64), message: z.string().max(limits.messages.errorCharacters + 1), batchNumber: count, iteration: count }).strict().optional(),
  completedBatches: count, totalBatches: count, database: z.string().max(256), messagesTruncated: z.boolean(),
  budget: z.object({ usedBytes: count, globalBytes: count, queryBytes: count, seq: count, stoppedBytes: count.min(1).optional() }).strict(), completedAt: z.string().max(40),
  // The session's @@SPID (a smallint) and SUSER_SNAME(), read when it opened.
  ...session, spid: session.spid.optional()
}).strict()
/** EVENT bodies for a results.copy or results.export request; droppable, the latest wins. */
export const jobProgressSchema = z.object({ type: z.literal('job.progress'), rowsDone: count, rowsTotal: count, bytes: count }).strict()
export type JobProgressEvent = z.infer<typeof jobProgressSchema>
/** The most results a results.memory event names (the backend's ResultStore.MaxLargest). */
export const maxLargestResults = 8
const codecCounters = z.object({
  name: z.string().min(1).max(16).optional(), level: z.number().int().min(-131072).max(22).optional(), pagesPacked: count, pagesUnpacked: count, packInputBytes: count, packMicroseconds: count,
  unpackOutputBytes: count, unpackMicroseconds: count, cacheHits: count, cacheLookups: count, lastUnpackMicroseconds: count
}).strict()
export const resultMemoryDetailSchema = z.object({
  logicalBytes: count, storedBytes: count, compressedBytes: count, packedLogicalBytes: count, cacheBytes: count,
  largest: z.array(z.object({
    resultId: u32, logicalBytes: count, storedBytes: count, state: z.enum(['raw', 'packed', 'unpacking']), progress: z.number().int().min(0).max(100).optional(), live: z.literal(true).optional()
  }).strict()).max(maxLargestResults),
  codec: codecCounters, heap: z.object({ committedBytes: count, freeBytes: count }).strict()
}).strict() satisfies z.ZodType<ResultMemoryDetail>
/** Global memory EVENTs (id 0). Each feature has its own sequence. Results shares its sequence with query summaries, and its
 *  events carry what the store holds (`detail`, the Memory panel's Nerd metrics). */
export const memoryEventSchema = z.union([
  z.object({ type: z.literal('results.memory'), usedBytes: count, globalBytes: count.min(1), seq: count.min(1), detail: resultMemoryDetailSchema.optional() }).strict(),
  z.object({ type: z.literal('explorer.index.memory'), usedBytes: count, globalBytes: count.min(1), seq: count.min(1) }).strict()
])
