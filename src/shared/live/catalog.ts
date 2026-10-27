// Live data (docs/ipc.md, Live subscriptions): the sources a `live.subscribe` names, the probes each one runs, and what
// every probe emits (series, tables, status values). It is the only declaration of them: the port schemas
// (src/shared/live/schema.ts), docs/live.md and the backend read it, the backend through liveCatalogJson() embedded as
// Live/live-catalog.json (a vitest file snapshot keeps that copy in sync). Erasable TypeScript (no enums), so Node's
// type stripping can load it as well.
import {
  activityBands, activityEditions, activityLiveProbes, activityStatuses, liveColumnId, liveColumnTypes, pendingProbes, probeSeries, probeSpecs, seriesSpecs, tableSpecs, waitCategories
} from '../activity/catalog.ts'
import { limits } from '../ipc/wire/protocol.ts'

/** Where a source reads: server DMVs, the SSISDB catalog, or nothing (a test source that touches no SQL Server). */
export type LiveScope = 'server' | 'ssisdb' | 'none'
export const liveUnits = ['perSecond', 'percent', 'ms', 'msPerSecond', 'bytesPerSecond', 'count', 'seconds'] as const
export type LiveUnit = typeof liveUnits[number]
/** A snapshot table is replaced by each sample (a new stored result, two revisions kept); an append table grows. */
export type LiveTableMode = 'snapshot' | 'append'

/** How the backend turns a series' raw value into what a sample carries (Live/LiveDeltas.cs): the value itself
 *  (gauge); a cumulative counter's change per second of the server's own clock (rate, msPerSecond); a counter's change
 *  over its base counter's change (ratio); or the schedulers' summed CPU milliseconds as a percentage of the elapsed
 *  time across them (cpuPercent). Every kind but gauge has no value until a second sample. */
export const liveCounters = ['gauge', 'rate', 'msPerSecond', 'ratio', 'cpuPercent'] as const
export type LiveCounter = typeof liveCounters[number]
/** The SQL types a live table stores (Live/LiveTables.cs, LiveCells): each cell is the display text a query of it shows. */
export const liveDataTypes = ['tinyint', 'smallint', 'int', 'bigint', 'nvarchar', 'varchar', 'nchar', 'char', 'sysname', 'bit', 'float', 'real', 'decimal', 'numeric', 'datetime', 'datetime2', 'datetimeoffset', 'uniqueidentifier'] as const
export interface LiveSeriesSpec { readonly id: string; readonly unit: LiveUnit; readonly label: string; readonly counter: LiveCounter }
/** `id` names the column in requests (sort, filter); `name` and `dataType` are what the stored result's columns carry. */
export interface LiveColumnSpec { readonly id: string; readonly name: string; readonly dataType: string }
export interface LiveTableSpec {
  readonly id: string
  readonly mode: LiveTableMode
  readonly columns: readonly LiveColumnSpec[]
  /** The column ids whose cell texts, joined with U+001F, identify a row across revisions (tracked selection; a NULL cell
   *  counts as empty text). An append table has exactly one: its keyset id, an integer that grows with every row, by which
   *  the table reads only rows above the id it has settled. */
  readonly key: readonly string[]
  /** Snapshot: the most rows a revision stores (defaultSnapshotRows, at most limits.live.snapshotRows); the rest are cut,
   *  and the descriptor says rowLimit. */
  readonly rowCap?: number
  /** Snapshot, keyed: a tracked row that left the source stays in one more revision, listed in the sample's `departed`,
   *  so a selection on a session that just ended still has its row. */
  readonly departed?: boolean
  /** Snapshot: columns whose distinct values, with their counts, samples carry whenever they change (column value
   *  filters), at most limits.live.facetColumns. */
  readonly facets?: readonly string[]
  /** Append: an id counts as settled once it was first seen at least this many ticks and milliseconds ago
   *  (defaultSettle). Ids are assigned at insert, not commit, so a lower id can appear after a higher one; until the ids
   *  around it settle, every tick reads them again and appends only the ones it has not seen. */
  readonly settle?: { readonly ticks: number; readonly ms: number }
  /** Append: the most new rows one tick reads (defaultBatchRows, at most limits.live.batchRows), so a catch-up never runs
   *  one huge read; twice as many unsettled ids are remembered to skip repeats. */
  readonly batchRows?: number
}
export interface LiveProbeSpec {
  readonly id: string
  readonly source: string
  readonly label: string
  readonly description: string
  readonly intervalMs: { readonly default: number; readonly min: number; readonly max: number }
  readonly series?: readonly LiveSeriesSpec[]
  /** At most 4 snapshot and 4 append tables, in the order samples name them by index. */
  readonly tables?: readonly LiveTableSpec[]
  readonly status?: readonly string[]
  /** Row views a request may choose (none yet). */
  readonly views?: readonly string[]
  /** How a text filter applies: to stored cells in backend memory, or by restarting an append table under a predicate.
   *  A probe without one refuses filters. */
  readonly filterMode?: 'memory' | 'restart'
  /** A statement's budget: 0.8 × the probe's interval, clamped to this range (within limits.live.budgetMs). Defaults to
   *  500 to 5,000 ms, the range for cheap DMV reads; an expensive probe may raise it. */
  readonly budgetMs?: { readonly min: number; readonly max: number }
  /** `refresh` never runs the probe again within this many ms of its last sample (0: no gap). */
  readonly minGapMs?: number
  /** The load guard: when the probe's smoothed cost passes this share of its effective interval for 3 samples in a row,
   *  the interval doubles (up to the back-off cap); under 10 % for 10 samples, it halves back toward the requested one.
   *  Defaults to 0.25. */
  readonly maxDutyCycle?: number
  /** Where the probe runs: from this SQL Server major version, on these EngineEdition values. Elsewhere it opens
   *  unavailable (NOT_SUPPORTED) and never runs. Absent: everywhere its source runs. */
  readonly gates?: { readonly minMajor: number; readonly editions: readonly number[] }
  /** serverState: the probe reads server DMVs, so it needs VIEW SERVER PERFORMANCE STATE (SQL Server 2022 and later) or
   *  VIEW SERVER STATE (earlier versions, Managed Instance); without it, it opens unavailable (PERMISSION_DENIED), or, when
   *  the source could not ask as it opened, stops at its first tick with that error. */
  readonly permission?: 'serverState'
}
export interface LiveSourceSpec {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly scope: LiveScope
  /** Only main's test schemas (unpackaged smoke runs) and a backend with VARIA_BACKEND_TEST_HOOKS=1 accept it. */
  readonly testOnly: boolean
  readonly probes: readonly string[]
  /** While its view is hidden: pause every probe (the default), or keep only its probes without tables, sampled at most
   *  every limits.live.hiddenIntervalMs (an execution this window started, for its completion notice). The renderer
   *  applies it through live.update. */
  readonly hidden?: 'pause' | 'statusOnly'
}

const column = (id: string, dataType: string): LiveColumnSpec => ({ id, name: id, dataType })
/** The types debug.synthetic.wide's columns cycle through. */
const wideTypes = ['nvarchar', 'bigint', 'datetime2', 'float', 'bit', 'int']
const anyInterval = { default: 1000, min: limits.live.intervalMs.min, max: limits.live.intervalMs.max }
/** A probe's statement budget and load guard when its entry names none. */
export const defaultBudgetMs = { min: limits.live.budgetMs.min, max: 5000 } as const
export const defaultDutyCycle = 0.25
/** A snapshot table's row cap, and an append table's settle window and rows per tick, when its entry names none. */
export const defaultSnapshotRows = 5000
export const defaultSettle = { ticks: 2, ms: 5000 } as const
export const defaultBatchRows = 5000

export const liveSourceIds = ['debug.synthetic', 'activity'] as const
export type LiveSourceId = typeof liveSourceIds[number]
export const liveProbeIds = [
  'debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status', 'debug.synthetic.grid', 'debug.synthetic.log', 'debug.synthetic.wide', ...activityLiveProbes
] as const
export type LiveProbeId = typeof liveProbeIds[number]

export const liveSources: { readonly [S in LiveSourceId]: LiveSourceSpec } = {
  'debug.synthetic': {
    id: 'debug.synthetic', label: 'Synthetic', scope: 'none', testOnly: true, probes: ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status', 'debug.synthetic.grid', 'debug.synthetic.log', 'debug.synthetic.wide'],
    description: 'Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it.'
  },
  activity: {
    id: 'activity', label: 'Activity Monitor', scope: 'server', testOnly: false, probes: activityLiveProbes,
    description: 'SQL Server\'s own activity, read from server DMVs on the connection\'s " - Activity Monitor" pool (READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). Its probes, tables, columns and series come from the Activity Monitor\'s catalogue (docs/activity-monitor.md). Each probe runs several statements (Activity/ActivitySql.cs), and one the login may not run fails alone, naming what it feeds. Args: one filter per table (Processes\' view chip and toggles, the filter box, column value filters, Hide benign waits) and the Details flyout\'s session (focusSession).'
  }
}

type ActivityLiveProbe = typeof activityLiveProbes[number]
/** What each Activity Monitor probe is, for docs/live.md. */
const activityDescriptions: { readonly [P in ActivityLiveProbe]: string } = {
  'activity.overview': 'The server at a glance, in seven statements: SQL Server\'s CPU (its schedulers\' non-preemptive time) and scheduler delay, waiting tasks (wait time less signal wait of every type that is not benign), database I/O and its latency (moved only by databases read in both samples, so one dropped or closed takes only its own counts with it), batch requests, compilations and re-compilations, blocked sessions and the longest block, active requests, user sessions and logins, runnable tasks per scheduler and the work queue, memory grants, page life expectancy, deadlocks and lock waits. Rates use the server\'s own clock (ms_ticks), and a restart starts them again; a statement the login may not run leaves only its own series null.',
  'activity.sessions': 'Processes (one row per session, its MARS requests folded), the blocking chains as rows (built in the backend from task waits, each session once) and Active Expensive Queries, from one sample. Rates are per session and per request between samples, keyed by login time and each request\'s id and start time, so a reused id never gives a rate across two sessions and a MARS session\'s requests never stand in for each other. Varia\'s own sessions are marked, and system sessions and Varia\'s pools are hidden unless the filter shows them. Without server state, Processes shows only the monitor\'s own session and the other two tables report PERMISSION_DENIED without running SQL. Its two series follow the Details flyout\'s session (focusSession).',
  'activity.resources': 'Resource Waits (by category and by type) and Data File I/O, declared now so the frame shapes are fixed.'
}

/** The Activity Monitor's probes as live entries, built from its catalogue (src/shared/activity/catalog.ts), so the two never
 *  disagree. A metrics probe's series go through the backend's delta engine by their kind; a snapshot probe works out its
 *  series from per-row baselines itself, so they arrive as gauges. */
function activityLiveEntries(): { readonly [P in ActivityLiveProbe]: LiveProbeSpec } {
  const editions = Object.values(activityEditions).filter(edition => edition.available).flatMap(edition => [...edition.editions])
  const entry = (id: ActivityLiveProbe): LiveProbeSpec => {
    const spec = probeSpecs[id]
    const series = probeSeries(id).map((seriesId): LiveSeriesSpec => {
      const category = waitCategories.find(item => 'wait.' + item.id === seriesId)
      if (category) return { id: seriesId, unit: 'msPerSecond', label: category.label + ' waits', counter: 'gauge' }
      const known = seriesSpecs[seriesId]
      return { id: seriesId, unit: known.liveUnit, label: known.label, counter: spec.kind === 'metrics' ? known.kind : 'gauge' }
    })
    const tables = spec.tables.map((table): LiveTableSpec => {
      const table$ = tableSpecs[table]
      return {
        id: table, mode: 'snapshot', columns: table$.columns.map(item => ({ id: liveColumnId(table, item.id), name: item.caption, dataType: liveColumnTypes[item.type] })),
        key: table$.key.map(item => liveColumnId(table, item)), rowCap: table$.rowCap,
        ...table$.departedLinger ? { departed: true } : {},
        ...table$.facetColumns?.length ? { facets: table$.facetColumns.map(item => liveColumnId(table, item)) } : {}
      }
    })
    const pending = pendingProbes[id]
    return {
      id, source: 'activity', label: spec.title, description: activityDescriptions[id] + (pending ? ' ' + pending : ''),
      intervalMs: { default: spec.defaultIntervalMs, min: spec.minIntervalMs, max: spec.maxIntervalMs },
      budgetMs: { min: limits.live.budgetMs.min, max: spec.budgetMs }, maxDutyCycle: spec.maxDutyCycle, gates: { minMajor: activityBands.min, editions },
      ...spec.minGapMs ? { minGapMs: spec.minGapMs } : {},
      // Without server state the sessions probe still shows the monitor's own session; the others need it.
      ...id === 'activity.sessions' ? { status: Object.keys(activityStatuses) } : { permission: 'serverState' as const },
      ...series.length ? { series } : {},
      ...tables.length ? { tables, filterMode: spec.filterMode } : {}
    }
  }
  return { 'activity.overview': entry('activity.overview'), 'activity.sessions': entry('activity.sessions'), 'activity.resources': entry('activity.resources') }
}

export const liveProbes: { readonly [P in LiveProbeId]: LiveProbeSpec } = {
  'debug.synthetic.metrics': {
    id: 'debug.synthetic.metrics', source: 'debug.synthetic', label: 'Synthetic metrics', intervalMs: anyInterval,
    description: 'Three series: the sample number, a wave between 0 and 100, and a rate that follows it.',
    series: [{ id: 'counter', unit: 'count', label: 'Samples', counter: 'gauge' }, { id: 'wave', unit: 'percent', label: 'Wave', counter: 'gauge' }, { id: 'rate', unit: 'perSecond', label: 'Rate', counter: 'gauge' }]
  },
  'debug.synthetic.table': {
    id: 'debug.synthetic.table', source: 'debug.synthetic', label: 'Synthetic rows', intervalMs: anyInterval,
    description: 'A snapshot table whose rows move on by one id per sample, so rows leave at the top and arrive at the bottom.',
    tables: [{ id: 'rows', mode: 'snapshot', key: ['id'], rowCap: 10_000, columns: [column('id', 'int'), column('label', 'nvarchar'), column('value', 'int')] }]
  },
  'debug.synthetic.status': {
    id: 'debug.synthetic.status', source: 'debug.synthetic', label: 'Synthetic status', intervalMs: anyInterval,
    description: 'The phase (even or odd) and the sample count.', status: ['phase', 'samples']
  },
  'debug.synthetic.grid': {
    id: 'debug.synthetic.grid', source: 'debug.synthetic', label: 'Synthetic grid', intervalMs: anyInterval, views: ['even'], filterMode: 'memory',
    description: 'Two snapshot tables from one sample. Items move on by one id per sample, as the table probe\'s rows do, in five groups, with group facets and departed rows; the even view keeps the items with an even id. Groups count the items of each group, built from the source\'s own state rather than read from SQL Server.',
    tables: [
      { id: 'items', mode: 'snapshot', key: ['itemId'], rowCap: 10_000, departed: true, facets: ['group'], columns: [column('itemId', 'int'), column('group', 'nvarchar'), column('name', 'nvarchar'), column('amount', 'int')] },
      { id: 'groups', mode: 'snapshot', key: ['groupName'], rowCap: 10, columns: [column('groupName', 'nvarchar'), column('items', 'int')] }
    ]
  },
  'debug.synthetic.log': {
    id: 'debug.synthetic.log', source: 'debug.synthetic', label: 'Synthetic log', intervalMs: anyInterval, filterMode: 'restart',
    description: 'An append table that grows by logRows messages a sample (levels 0 to 3). With lateEvery, one message of every n-th sample becomes visible a sample late, after higher ids, as a slow writer\'s commit would. A filter or a new logLevel (the lowest level shown) starts the table again under the new predicate, and start picks its first row.',
    tables: [{ id: 'messages', mode: 'append', key: ['messageId'], settle: { ticks: 2, ms: 0 }, batchRows: 5000, columns: [column('messageId', 'bigint'), column('level', 'int'), column('text', 'nvarchar')] }]
  },
  'debug.synthetic.wide': {
    id: 'debug.synthetic.wide', source: 'debug.synthetic', label: 'Synthetic wide rows', intervalMs: anyInterval,
    description: 'A snapshot of rows rows of 23 columns, the shape of a session list, for the snapshot churn benchmark. Its status reports how many gen2 collections the backend has run.',
    status: ['gen2'],
    tables: [{
      id: 'rows', mode: 'snapshot', key: ['rowId'], rowCap: 10_000,
      columns: [column('rowId', 'int'), ...Array.from({ length: 22 }, (_, index) => column('c' + (index + 1), wideTypes[index % wideTypes.length]))]
    }]
  },
  ...activityLiveEntries()
}

/** Sources the production schemas accept. */
export const productionSourceIds: readonly LiveSourceId[] = liveSourceIds.filter(id => !liveSources[id].testOnly)

export const isLiveSource = (id: string): id is LiveSourceId => Object.hasOwn(liveSources, id)
export const isLiveProbe = (id: string): id is LiveProbeId => Object.hasOwn(liveProbes, id)

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])])) : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'

/** The catalogue as the backend embeds it, keys sorted: sources and probes in catalogue order, the live limits, and the
 *  data types a live table may declare (the backend checks that it stores each of them). */
export function liveCatalogJson(): string {
  const probes = liveProbeIds.map(id => {
    const spec = liveProbes[id]
    const tables = (spec.tables ?? []).map(table => table.mode === 'snapshot'
      ? { id: table.id, mode: table.mode, columns: table.columns, key: table.key, rowCap: table.rowCap ?? defaultSnapshotRows, departed: table.departed ?? false, facets: table.facets ?? [] }
      : { id: table.id, mode: table.mode, columns: table.columns, key: table.key, settle: table.settle ?? defaultSettle, batchRows: table.batchRows ?? defaultBatchRows })
    return {
      ...spec, series: spec.series ?? [], tables, status: spec.status ?? [], views: spec.views ?? [], filterMode: spec.filterMode ?? 'none',
      budgetMs: spec.budgetMs ?? defaultBudgetMs, minGapMs: spec.minGapMs ?? 0, maxDutyCycle: spec.maxDutyCycle ?? defaultDutyCycle, gates: spec.gates ?? null, permission: spec.permission ?? 'none'
    }
  })
  return [
    '{',
    `  "dataTypes": ${line(liveDataTypes)},`,
    `  "limits": ${line({ ...limits.live, eventBody: limits.eventBody })},`,
    `  "probes": ${block(probes)},`,
    `  "sources": ${block(liveSourceIds.map(id => ({ ...liveSources[id], hidden: liveSources[id].hidden ?? 'pause' })))},`,
    '  "version": 1',
    '}',
    ''
  ].join('\n')
}
