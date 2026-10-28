// Live subscriptions on the results port (docs/ipc.md, Live subscriptions): what the worker may ask (`live.subscribe`,
// `live.update`) and what the backend may send for them (EVENT bodies, the final RESPONSE, the update's answer), all
// strict and checked against the catalogue. The backend re-checks every request (Live/LiveService.cs); main checks every
// frame. The schemas are built from a catalogue, so tests can check the rules against shapes the shipped catalogue does
// not have yet (several sources, multi-table probes).
import { z } from 'zod'
import type { BackendResultDescriptor, ResultDescriptor } from '../contracts'
import { backendDescriptorSchema } from '../ipc/descriptors'
import { errorCodes, limits, type ErrorCode } from '../ipc/wire/protocol'
import { liveProbes, liveSources, type LiveProbeId, type LiveProbeSpec, type LiveSourceId, type LiveTableSpec, type LiveSourceSpec } from './catalog'

const L = limits.live

/** Where an append table starts, for a source whose args take it: at its first row, at the last `tail` rows (a note row
 *  says how many earlier rows are not shown), or at the rows just before an id (older rows than a view already shows; the
 *  table then ends there). */
export const liveStartSchema = z.union([
  z.literal('beginning'),
  z.object({ tail: z.number().int().min(1).max(L.segmentRows) }).strict(),
  z.object({ before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()
])
export type LiveStart = z.infer<typeof liveStartSchema>

/** Per-source `args`: what a source needs beyond its probes. Each member is bounded; unknown members are refused. */
export const liveArgsSchemas = {
  // Test controls: the snapshot's row count, a sampling period below the 1 s minimum so tests run fast, a sample count
  // after which the source ends (sourceEnded, its last tables kept), a probe error value every n-th sample, and the log's
  // messages per sample, lowest level shown, late messages and start.
  'debug.synthetic': z.object({
    rows: z.number().int().min(0).max(10_000).optional(),
    tickMs: z.number().int().min(10).max(60_000).optional(),
    endAfterTicks: z.number().int().min(1).max(10_000).optional(),
    errorEvery: z.number().int().min(1).max(1000).optional(),
    logRows: z.number().int().min(0).max(10_000).optional(),
    logLevel: z.number().int().min(0).max(3).optional(),
    lateEvery: z.number().int().min(1).max(1000).optional(),
    start: liveStartSchema.optional()
  }).strict(),
  // The Activity Monitor's probes take only their own settings (interval, pause) for now: no args.
  activity: z.never()
} as const satisfies { readonly [S in LiveSourceId]: z.ZodType }
export type LiveArgs = z.infer<typeof liveArgsSchemas[LiveSourceId]>

/** A sort key by catalogue column id; `table` (a snapshot table's index) limits it to that table, else it sorts every
 *  snapshot table that has the column. */
export interface LiveSort { column: string; descending: boolean; table?: number }
export interface LiveFilter { text: string; columns?: string[] }
export interface LiveProbeSettings { probe: LiveProbeId; intervalMs: number; paused?: boolean; sort?: LiveSort[]; view?: string; filter?: LiveFilter }
/** Settings an update may drop, since an absent member keeps its setting: back to the source's order, all rows, no filter. */
export const liveClearable = ['sort', 'view', 'filter'] as const
export type LiveClearable = typeof liveClearable[number]
export type LiveProbePatch = Omit<LiveProbeSettings, 'intervalMs'> & { intervalMs?: number; clear?: LiveClearable[] }
export interface LiveSubscribeParams {
  subscriptionId: string
  connectionId: string
  source: LiveSourceId
  probes: LiveProbeSettings[]
  args?: LiveArgs
  resume?: string
}
/** The rows to follow across revisions of one keyed snapshot table: each key is the key columns' cell texts joined with
 *  U+001F, as the worker reads them. `linger`: how many of the first keys stay one revision when they leave (a table
 *  that keeps departed rows); all of them by default. */
export interface LiveTrack { probe: LiveProbeId; table: number; seq: number; keys: string[]; linger?: number }
/** `source` repeats the subscription's, so its probes and args are checked here; main and the backend check it matches. */
export interface LiveUpdateParams {
  subscriptionId: string
  source: LiveSourceId
  paused?: boolean
  probes?: LiveProbePatch[]
  refresh?: true
  track?: LiveTrack[]
  args?: LiveArgs
}

/** Why one probe has no fresh sample: a value, never an exception, so the other probes carry on. */
export const liveErrorCodes = [
  'BLOCKED', 'TIMEOUT', 'PERMISSION_DENIED', 'NOT_SUPPORTED', 'DATABASE_UNAVAILABLE', 'CONNECTION_LOST', 'SQL_ERROR', 'AUTH_KERBEROS', 'AUTH_ENTRA',
  'BUDGET', 'BUSY', 'CATALOG_MISSING', 'NOT_FOUND', 'LOGIN_FAILED'
] as const
export type LiveErrorCode = typeof liveErrorCodes[number]
export interface LiveProbeError {
  probe: LiveProbeId
  code: LiveErrorCode
  /** A complete sentence; never SQL text, names or values. */
  message: string
  number?: number
  retryInMs: number
  /** True: the probe stops until a refresh or a new subscription. */
  terminal: boolean
  /** One statement of a probe's batch failed: the tables (by index) or series (by index) it would have filled. */
  tables?: number[]
  series?: number[]
}
export interface LiveOpenedProbe { probe: LiveProbeId; intervalMs: number; minIntervalMs: number; maxIntervalMs: number; state: 'ok' | 'limited' | 'unavailable'; reason?: LiveErrorCode; note?: string }
/** One column's distinct values with how many rows hold each, most frequent first; `more` when values were left out. */
export interface LiveFacet { column: string; values: { text: string; count: number }[]; more?: true }
export interface LiveSnapshotSample<D = BackendResultDescriptor> {
  /** The table's index in the probe's catalogue entry. */
  table: number
  descriptor: D
  revision: number
  /** Results the backend released with this sample (the revision before the previous one). */
  retired?: number[]
  diff?: { added: number; removed: number; changed: number }
  /** The new row of each tracked key, in the order of the track list with this `seq`; -1 when the row is gone. */
  tracked?: { seq: number; rows: number[] }
  /** Rows of this revision that left the source and stay for this one revision because they were tracked (a table whose
   *  catalogue entry has `departed`). */
  departed?: number[]
  /** The facet columns whose values changed since the last facets this table sent, over every row the source gave
   *  (before the view and filter). */
  facets?: LiveFacet[]
}
/** `restarted`: the table started again (a new filter or args), and `retired` names every segment it had. */
export interface LiveAppendSample<D = BackendResultDescriptor> { table: number; descriptor: D; segment: number; rolledFrom?: number; retired?: number[]; restarted?: true }
export interface LiveSample<D = BackendResultDescriptor> {
  probe: LiveProbeId
  costMs: number
  effectiveIntervalMs: number
  /** The interval measured since the probe's previous sample; absent for the first. */
  elapsedMs?: number
  gap?: 'baseline' | 'reset' | 'resumed' | 'late'
  skipped?: number
  /** Aligned with the catalogue's series; null where there is no value yet. */
  metrics?: (number | null)[]
  tables?: LiveSnapshotSample<D>[]
  append?: LiveAppendSample<D>[]
  status?: { id: string; value: number | string }[]
}
export interface LiveOpenedEvent { type: 'live.opened'; seq: 0; source: LiveSourceId; band?: number; spid?: number; isolation?: 'readUncommitted' | 'readCommitted'; probes: LiveOpenedProbe[] }
export interface LiveTickEvent<D = BackendResultDescriptor> { type: 'live.tick'; seq: number; sampledAt: number; spid?: number; resume?: string; samples: LiveSample<D>[]; errors?: LiveProbeError[] }
/** An EVENT body as the backend sends it. */
export type BackendLiveEvent = LiveOpenedEvent | LiveTickEvent
/** An event as main forwards it: every descriptor stamped with its generation. */
export type LiveEvent = LiveOpenedEvent | LiveTickEvent<ResultDescriptor>
export type LiveTick = LiveTickEvent<ResultDescriptor>
/** The final RESPONSE. Every end but `sourceEnded` releases the subscription's results; `sourceEnded` keeps `kept`
 *  readable until the renderer closes them. `code` and `message` come with `failed` only: a request error, or, when every
 *  probe stopped for good (each terminal, such as PERMISSION_DENIED), the first probe's error code. */
export interface LiveEnd {
  ended: 'cancelled' | 'disconnected' | 'sourceEnded' | 'failed' | 'shutdown'
  code?: ErrorCode | LiveErrorCode
  message?: string
  kept?: number[]
  resume?: string
  ticks: number
  elapsedMs: number
}
export interface LiveUpdateResult { applied: true; probes: { probe: LiveProbeId; intervalMs: number; effectiveIntervalMs: number; paused: boolean }[] }

/** The parts of a catalogue the schemas check against. */
export interface LiveCatalogShape {
  readonly sources: Readonly<Record<string, LiveSourceSpec>>
  readonly probes: Readonly<Record<string, LiveProbeSpec>>
  readonly args: Readonly<Record<string, z.ZodType>>
}

const u31 = z.number().int().min(1).max(2 ** 31 - 1)
const u32 = z.number().int().min(1).max(0xffffffff)
const u53 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const nonNegative31 = z.number().int().min(0).max(2 ** 31 - 1)
const interval = z.number().int().min(L.intervalMs.min).max(L.intervalMs.max)
const tableIndex = z.number().int().min(0).max(L.tablesPerProbe + L.appendPerProbe - 1)
/** Catalogue ids of columns, views and status values: camelCase, at most 32 characters. */
const catalogId = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/)
const resumeToken = z.string().min(1).max(L.resumeCharacters).regex(/^[A-Za-z0-9_-]+$/)
const utf8 = new TextEncoder()
const idEnum = (ids: readonly string[]) => ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never()

/** Every live schema for one catalogue; `test` admits its test-only sources in requests. */
export function buildLiveSchemas(catalog: LiveCatalogShape, o: { test: boolean }) {
  const allSources = Object.keys(catalog.sources)
  const requestSource = idEnum(allSources.filter(id => o.test || !catalog.sources[id].testOnly))
  const probeId = idEnum(Object.keys(catalog.probes))
  // A row's tone column is never data: no sort or filter names it, and a filter's text never matches it.
  const dataColumns = (columns: LiveTableSpec['columns']) => columns.filter(column => column.role !== 'tone')
  const columnsOf = (spec: LiveProbeSpec, mode?: 'snapshot' | 'append') => new Set((spec.tables ?? []).filter(table => mode === undefined || table.mode === mode).flatMap(table => dataColumns(table.columns).map(column => column.id)))

  const sortSchema = z.array(z.object({ column: catalogId, descending: z.boolean(), table: tableIndex.optional() }).strict()).min(1).max(L.sortColumns)
  const filterSchema = z.object({ text: z.string().min(1).max(L.filterCharacters), columns: z.array(catalogId).min(1).max(L.filterColumns).optional() }).strict()
  const probeSettings = z.object({
    probe: probeId,
    /** Clamped by the backend to the probe's own minimum and maximum. */
    intervalMs: interval,
    paused: z.boolean().optional(),
    sort: sortSchema.optional(),
    view: catalogId.optional(),
    filter: filterSchema.optional()
  }).strict()
  const probePatch = probeSettings.partial({ intervalMs: true }).extend({ clear: z.array(z.enum(liveClearable)).min(1).max(liveClearable.length).optional() })

  /** Settings only some probes take: sort by a snapshot column, a declared view, a filter where the probe has a mode. */
  function checkProbe(settings: z.infer<typeof probePatch>, source: string, ctx: z.RefinementCtx, path: (string | number)[]): void {
    const spec = catalog.probes[settings.probe]
    if (spec.source !== source) ctx.addIssue({ code: 'custom', message: 'The probe belongs to another source.', path: [...path, 'probe'] })
    const sortable = columnsOf(spec, 'snapshot')
    const sorted = settings.sort ?? [], table = (index: number) => spec.tables?.[index]
    const unsortable = (key: LiveSort) => key.table === undefined ? !sortable.has(key.column) : table(key.table)?.mode !== 'snapshot' || !dataColumns(table(key.table)!.columns).some(column => column.id === key.column)
    if (sorted.some(unsortable) || new Set(sorted.map(key => (key.table ?? '') + '/' + key.column)).size !== sorted.length) ctx.addIssue({ code: 'custom', message: 'Sort names a column the probe does not sort by.', path: [...path, 'sort'] })
    if (settings.view !== undefined && !(spec.views ?? []).includes(settings.view)) ctx.addIssue({ code: 'custom', message: 'Unknown view.', path: [...path, 'view'] })
    if (settings.filter !== undefined) {
      const filterable = columnsOf(spec)
      if (spec.filterMode === undefined || (settings.filter.columns ?? []).some(column => !filterable.has(column))) ctx.addIssue({ code: 'custom', message: 'The probe does not take this filter.', path: [...path, 'filter'] })
    }
    const clear = settings.clear ?? []
    if (new Set(clear).size !== clear.length || clear.some(setting => settings[setting] !== undefined)) ctx.addIssue({ code: 'custom', message: 'Clear names each setting once, and none the update also sets.', path: [...path, 'clear'] })
  }
  function checkProbes(probes: readonly z.infer<typeof probePatch>[], source: string, ctx: z.RefinementCtx): void {
    if (new Set(probes.map(probe => probe.probe)).size !== probes.length) ctx.addIssue({ code: 'custom', message: 'Each probe may be named once.', path: ['probes'] })
    probes.forEach((probe, index) => checkProbe(probe, source, ctx, ['probes', index]))
  }
  function checkArgs(args: unknown, source: string, ctx: z.RefinementCtx): void {
    const schema = catalog.args[source]
    if (args !== undefined && !(schema?.safeParse(args).success ?? false)) ctx.addIssue({ code: 'custom', message: 'Invalid arguments for this source.', path: ['args'] })
  }

  const subscribe = z.object({
    subscriptionId: z.uuid(),
    connectionId: z.uuid(),
    source: requestSource,
    probes: z.array(probeSettings).min(1).max(L.probes),
    args: z.unknown().optional(),
    resume: resumeToken.optional()
  }).strict().superRefine((value, ctx) => {
    checkProbes(value.probes, value.source, ctx)
    checkArgs(value.args, value.source, ctx)
  })

  const trackSchema = z.object({ probe: probeId, table: tableIndex, seq: u31, keys: z.array(z.string().max(L.keyCharacters)).max(L.trackedKeys), linger: z.number().int().min(0).max(L.trackedKeys).optional() }).strict()
    .refine(track => (track.linger ?? 0) <= track.keys.length, { message: 'A track list lingers at most its own keys.', path: ['linger'] })
  const update = z.object({
    subscriptionId: z.uuid(),
    source: requestSource,
    paused: z.boolean().optional(),
    probes: z.array(probePatch).min(1).max(L.probes).optional(),
    refresh: z.literal(true).optional(),
    track: z.array(trackSchema).min(1).max(L.probes).optional(),
    args: z.unknown().optional()
  }).strict().superRefine((value, ctx) => {
    if (value.paused === undefined && value.probes === undefined && value.refresh === undefined && value.track === undefined && value.args === undefined) ctx.addIssue({ code: 'custom', message: 'The update changes nothing.' })
    checkProbes(value.probes ?? [], value.source, ctx)
    checkArgs(value.args, value.source, ctx)
    const tracked = value.track?.map(track => track.probe + '/' + track.table) ?? []
    if (new Set(tracked).size !== tracked.length) ctx.addIssue({ code: 'custom', message: 'Each table may be tracked once.', path: ['track'] })
    value.track?.forEach((track, index) => {
      const spec = catalog.probes[track.probe], table = spec.tables?.[track.table]
      if (spec.source !== value.source || table?.mode !== 'snapshot' || table.key.length === 0) ctx.addIssue({ code: 'custom', message: 'Only keyed snapshot tables of this source are tracked.', path: ['track', index] })
    })
  })

  const probeError = z.object({
    probe: probeId,
    code: z.enum(liveErrorCodes),
    message: z.string().min(1).max(L.messageCharacters),
    number: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    retryInMs: z.number().int().min(0).max(L.intervalMs.max),
    terminal: z.boolean(),
    tables: z.array(tableIndex).min(1).max(L.tablesPerProbe + L.appendPerProbe).optional(),
    series: z.array(z.number().int().min(0).max(L.series - 1)).min(1).max(L.series).optional()
  }).strict()
  const openedProbe = z.object({
    probe: probeId,
    intervalMs: interval,
    minIntervalMs: interval,
    maxIntervalMs: interval,
    state: z.enum(['ok', 'limited', 'unavailable']),
    reason: z.enum(liveErrorCodes).optional(),
    note: z.string().min(1).max(L.noteCharacters).optional()
  }).strict()
  const status = z.object({ id: catalogId, value: z.union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.string().max(L.statusCharacters)]) }).strict()
  const snapshotSample = z.object({
    table: tableIndex,
    descriptor: backendDescriptorSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    retired: z.array(u32).min(1).max(2).optional(),
    diff: z.object({ added: nonNegative31, removed: nonNegative31, changed: nonNegative31 }).strict().optional(),
    tracked: z.object({ seq: u31, rows: z.array(z.number().int().min(-1).max(2 ** 31 - 1)).max(L.trackedKeys) }).strict().optional(),
    departed: z.array(nonNegative31).min(1).max(L.trackedKeys).optional(),
    facets: z.array(z.object({
      column: catalogId,
      values: z.array(z.object({ text: z.string().max(L.facetCharacters), count: u31 }).strict()).max(L.facetValues),
      more: z.literal(true).optional()
    }).strict()).min(1).max(L.facetColumns).optional()
  }).strict()
  const appendSample = z.object({
    table: tableIndex,
    descriptor: backendDescriptorSchema,
    segment: nonNegative31,
    rolledFrom: u32.optional(),
    retired: z.array(u32).min(1).max(L.segmentResults).optional(),
    restarted: z.literal(true).optional()
  }).strict()
  const sample = z.object({
    probe: probeId,
    costMs: nonNegative31,
    effectiveIntervalMs: interval,
    elapsedMs: u53.optional(),
    gap: z.enum(['baseline', 'reset', 'resumed', 'late']).optional(),
    skipped: nonNegative31.optional(),
    metrics: z.array(z.number().nullable()).min(1).max(L.series).optional(),
    tables: z.array(snapshotSample).min(1).max(L.tablesPerProbe).optional(),
    append: z.array(appendSample).min(1).max(L.appendPerProbe).optional(),
    status: z.array(status).min(1).max(L.statuses).optional()
  }).strict()

  /** What every sample may hold according to its probe's catalogue entry. */
  function checkSamples(samples: readonly z.infer<typeof sample>[], ctx: z.RefinementCtx): void {
    if (new Set(samples.map(item => item.probe)).size !== samples.length) ctx.addIssue({ code: 'custom', message: 'A probe is sampled once per tick.', path: ['samples'] })
    let tables = 0, facetBytes = 0
    samples.forEach((item, index) => {
      const spec = catalog.probes[item.probe]
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['samples', index] })
      if (item.metrics !== undefined && item.metrics.length !== (spec.series?.length ?? 0)) issue('Metrics follow the probe\'s series.')
      for (const [entries, mode] of [[item.tables ?? [], 'snapshot'], [item.append ?? [], 'append']] as const) {
        const indexes = entries.map(entry => entry.table)
        if (new Set(indexes).size !== indexes.length) issue('A table is sampled once per tick.')
        for (const entry of entries) {
          const table = spec.tables?.[entry.table]
          if (table?.mode !== mode || entry.descriptor.columns.length !== table.columns.length || entry.descriptor.columns.some((column, at) => column.name !== table.columns[at].name)) issue('The table is not the probe\'s.')
        }
        tables += entries.length
      }
      for (const entry of item.tables ?? []) {
        const table = spec.tables?.[entry.table]
        if (entry.departed !== undefined && (table?.departed !== true || new Set(entry.departed).size !== entry.departed.length)) issue('Only a table that keeps departed rows lists them, each once.')
        const columns = entry.facets?.map(facet => facet.column) ?? []
        if (columns.some(column => !(table?.facets ?? []).includes(column)) || new Set(columns).size !== columns.length) issue('Facets name the table\'s facet columns, each once.')
        for (const facet of entry.facets ?? []) for (const value of facet.values) facetBytes += utf8.encode(value.text).length
      }
      const ids = item.status?.map(value => value.id) ?? []
      if (ids.some(id => !(spec.status ?? []).includes(id)) || new Set(ids).size !== ids.length) issue('Unknown status value.')
    })
    if (tables > L.tablesPerTick) ctx.addIssue({ code: 'custom', message: 'Too many tables in one tick.', path: ['samples'] })
    if (facetBytes > L.facetBytes) ctx.addIssue({ code: 'custom', message: 'Too much facet text in one tick.', path: ['samples'] })
  }

  const event = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('live.opened'),
      seq: z.literal(0),
      source: idEnum(allSources),
      band: z.number().int().min(0).max(65_535).optional(),
      spid: z.number().int().min(1).max(32_767).optional(),
      isolation: z.enum(['readUncommitted', 'readCommitted']).optional(),
      probes: z.array(openedProbe).min(1).max(L.probes)
    }).strict().superRefine((value, ctx) => {
      if (new Set(value.probes.map(probe => probe.probe)).size !== value.probes.length || value.probes.some(probe => catalog.probes[probe.probe].source !== value.source)) ctx.addIssue({ code: 'custom', message: 'The probes are not the source\'s.', path: ['probes'] })
    }),
    z.object({
      type: z.literal('live.tick'),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      sampledAt: u53,
      spid: z.number().int().min(1).max(32_767).optional(),
      resume: resumeToken.optional(),
      samples: z.array(sample).max(L.probes),
      errors: z.array(probeError).min(1).max(L.errors).optional()
    }).strict().superRefine((value, ctx) => {
      if (value.samples.length === 0 && value.errors === undefined) ctx.addIssue({ code: 'custom', message: 'A tick reports a sample or an error.' })
      checkSamples(value.samples, ctx)
      value.errors?.forEach((error, index) => {
        const spec = catalog.probes[error.probe]
        if ((error.tables ?? []).some(table => table >= (spec.tables?.length ?? 0)) || (error.series ?? []).some(series => series >= (spec.series?.length ?? 0))) ctx.addIssue({ code: 'custom', message: 'The error names a table or series the probe does not have.', path: ['errors', index] })
      })
    })
  ])

  const end = z.object({
    ended: z.enum(['cancelled', 'disconnected', 'sourceEnded', 'failed', 'shutdown']),
    code: z.enum([...new Set<string>([...errorCodes, ...liveErrorCodes])] as [string, ...string[]]).optional(),
    message: z.string().min(1).max(L.messageCharacters).optional(),
    kept: z.array(u32).max(L.kept).optional(),
    resume: resumeToken.optional(),
    ticks: u53,
    elapsedMs: u53
  }).strict().superRefine((value, ctx) => {
    if (value.kept !== undefined && value.ended !== 'sourceEnded') ctx.addIssue({ code: 'custom', message: 'Only a source that ended keeps results.', path: ['kept'] })
    if ((value.code !== undefined) !== (value.ended === 'failed') || (value.message !== undefined) !== (value.ended === 'failed')) ctx.addIssue({ code: 'custom', message: 'A failed end, and only one, carries a code and a message.' })
  })

  const updateResult = z.object({
    applied: z.literal(true),
    probes: z.array(z.object({ probe: probeId, intervalMs: interval, effectiveIntervalMs: interval, paused: z.boolean() }).strict()).max(L.probes)
  }).strict()

  return {
    subscribe: subscribe as unknown as z.ZodType<LiveSubscribeParams>,
    update: update as unknown as z.ZodType<LiveUpdateParams>,
    event: event as unknown as z.ZodType<BackendLiveEvent>,
    end: end as unknown as z.ZodType<LiveEnd>,
    updateResult: updateResult as unknown as z.ZodType<LiveUpdateResult>
  }
}

const shipped: LiveCatalogShape = { sources: liveSources, probes: liveProbes, args: liveArgsSchemas }
const production = buildLiveSchemas(shipped, { test: false })
const test = buildLiveSchemas(shipped, { test: true })
/** The production request schemas; the test ones (unpackaged smoke runs) also admit test-only sources. */
export const liveSubscribeParamsSchema = production.subscribe
export const liveUpdateParamsSchema = production.update
export const testLiveSubscribeParamsSchema = test.subscribe
export const testLiveUpdateParamsSchema = test.update
/** EVENT bodies of a `live.subscribe` request: `live.opened` first (seq 0), then one `live.tick` per scheduler wake
 *  (seq 1, 2, …). Main stamps the generation on every descriptor. */
export const liveEventSchema = production.event
export const liveEndSchema = production.end
export const liveUpdateResultSchema = production.updateResult

/** Whether an event (already valid for the catalogue) belongs to the subscription it arrived on: `live.opened` names its
 *  source and reports each subscribed probe once, and a tick samples or fails only subscribed probes. The catalogue
 *  schema alone would accept another source's or an unsubscribed probe's tables, which main would then own. */
export function liveEventFits(event: BackendLiveEvent, subscription: Pick<LiveSubscribeParams, 'source' | 'probes'>): boolean {
  const subscribed = new Set<string>(subscription.probes.map(probe => probe.probe))
  if (event.type === 'live.opened') return event.source === subscription.source && event.probes.length === subscribed.size && event.probes.every(probe => subscribed.has(probe.probe))
  return event.samples.every(sample => subscribed.has(sample.probe)) && (event.errors ?? []).every(error => subscribed.has(error.probe))
}

/** The descriptors a tick carries, in sample order. */
export function liveDescriptors<D>(event: LiveOpenedEvent | LiveTickEvent<D>): D[] {
  return event.type === 'live.tick' ? event.samples.flatMap(sample => [...(sample.tables ?? []), ...(sample.append ?? [])].map(entry => entry.descriptor)) : []
}
/** The results a tick retired, in sample order. */
export function liveRetired<D>(event: LiveOpenedEvent | LiveTickEvent<D>): number[] {
  return event.type === 'live.tick' ? event.samples.flatMap(sample => [...(sample.tables ?? []), ...(sample.append ?? [])].flatMap(entry => entry.retired ?? [])) : []
}

/** Stamps the generation on every descriptor of a validated event. */
export function stampLive(event: BackendLiveEvent, generation: number): LiveEvent {
  if (event.type !== 'live.tick') return event
  return {
    ...event,
    samples: event.samples.map(({ tables, append, ...sample }): LiveSample<ResultDescriptor> => {
      const stamped: LiveSample<ResultDescriptor> = sample
      if (tables) stamped.tables = tables.map(entry => ({ ...entry, descriptor: { ...entry.descriptor, generation } }))
      if (append) stamped.append = append.map(entry => ({ ...entry, descriptor: { ...entry.descriptor, generation } }))
      return stamped
    })
  }
}
