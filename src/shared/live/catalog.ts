// Live data (docs/ipc.md, Live subscriptions): the sources a `live.subscribe` names, the probes each one runs, and what
// every probe emits (series, tables, status values). It is the only declaration of them: the port schemas
// (src/shared/live/schema.ts), docs/live.md and the backend read it, the backend through liveCatalogJson() embedded as
// Live/live-catalog.json (a vitest file snapshot keeps that copy in sync). Erasable TypeScript (no enums), so Node's
// type stripping can load it as well.
import {
  activityBands, activityEditions, activityLiveProbes, activityStatuses, liveColumnId, liveColumnTypes, pendingProbes, probeSeries, probeSpecs, seriesSpecs, tableSpecs, waitCategories
} from '../activity/catalog.ts'
import { limits } from '../ipc/wire/protocol.ts'
import { catalogFingerprintStatus } from '../ssis/catalog.ts'
import type { ProviderId } from '../providers.ts'
import { agentLimits } from '../agent/catalog.ts'
import { agentTreeStatus } from '../agent/tree.ts'
import { jobHistoryColumns, jobHistoryLimits, jobHistoryProbe, jobHistorySource, jobHistoryStatus } from '../bigquery/history-catalog.ts'

/** Where a source reads: server DMVs, the SSISDB catalog, BigQuery's REST API (a BigQuery connection), or nothing (a test
 *  source that touches no server). */
export type LiveScope = 'server' | 'ssisdb' | 'bigquery' | 'none'
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
/** A row's tone (LiveGrid): one class per pooled row, coloured by the resultsGrid.row* theme keys. A table's tone column
 *  holds one of these names, or NULL for none; the grid also mutes a departed row. */
export const liveTones = ['error', 'warning', 'running', 'muted'] as const
export type LiveTone = typeof liveTones[number]
/** `id` names the column in requests (sort, filter); `name` and `dataType` are what the stored result's columns carry.
 *  `role: 'tone'` marks the row's tone (one of liveTones, or NULL): the table's last column, an nvarchar, never a key. The
 *  grid hides it, and Copy and Save leave it out (ResultTextWriter), so it colours rows and is never data. */
export interface LiveColumnSpec { readonly id: string; readonly name: string; readonly dataType: string; readonly role?: 'tone' }
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
  /** Append, and a snapshot the backend builds from ids it reads above a settled one (the Operations window): an id counts
   *  as settled once it was first seen at least this many ticks and milliseconds ago (defaultSettle). Ids are assigned at
   *  insert, not commit, so a lower id can appear after a higher one; until the ids around it settle, every tick reads them
   *  again and appends (or keeps) only the ones it has not seen. */
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
  /** The interval while the probe's last sample held nothing open (BigQuery's Job History: no pending or running job): the
   *  backend then samples at the larger of this and the asked interval, and at the asked one again once something opens. The
   *  load guard applies to whichever is in force, which samples report as effectiveIntervalMs. Absent: always the asked one. */
  readonly idleIntervalMs?: number
  /** False: the load guard leaves the probe alone. A REST listing's cost (BigQuery's Job History) is network and quota waits,
   *  which a longer interval would not ease. Absent: guarded by maxDutyCycle. */
  readonly loadGuard?: false
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
  /** The engines this source samples: main and the backend refuse a live.subscribe on another engine's connection
   *  (UNSUPPORTED_PROVIDER). Absent, SQL Server only (src/shared/providers.ts). tests/providers-catalog.test.ts checks it. */
  readonly providers?: readonly ProviderId[]
  readonly label: string
  readonly description: string
  readonly scope: LiveScope
  /** Only main's test schemas (unpackaged smoke runs) and a backend with VARIA_BACKEND_TEST_HOOKS=1 accept it. */
  readonly testOnly: boolean
  readonly probes: readonly string[]
  /** What a hidden view of this source does: pause every probe (the default), or, for a view that asks for it with
   *  `whileHidden`, keep only its probes without tables, sampled at most every limits.live.hiddenIntervalMs, so a completion
   *  is still seen (an execution this window started; at most 4 such views a window). The renderer's LiveService applies
   *  it through live.update; the backend's JSON carries it but the backend does not act on it. */
  readonly hidden?: 'pause' | 'statusOnly'
}

const column = (id: string, dataType: string): LiveColumnSpec => ({ id, name: id, dataType })
const toneColumn: LiveColumnSpec = { id: 'tone', name: 'tone', dataType: 'nvarchar', role: 'tone' }
/** The types debug.synthetic.wide's columns cycle through. */
const wideTypes = ['nvarchar', 'bigint', 'datetime2', 'float', 'bit', 'int']
const anyInterval = { default: 1000, min: limits.live.intervalMs.min, max: limits.live.intervalMs.max }
/** SQL Server on a box (Personal, Standard, Enterprise, Express) and Managed Instance. */
const boxAndManaged = [1, 2, 3, 4, 8]
/** A probe's statement budget and load guard when its entry names none. */
export const defaultBudgetMs = { min: limits.live.budgetMs.min, max: 5000 } as const
export const defaultDutyCycle = 0.25
/** A snapshot table's row cap, and an append table's settle window and rows per tick, when its entry names none. */
export const defaultSnapshotRows = 5000
export const defaultSettle = { ticks: 2, ms: 5000 } as const
export const defaultBatchRows = 5000
/** The Operations window's settle window: its ids, like an append table's, are assigned before their rows commit. */
const operationsSettle = defaultSettle
/** Job Activity Monitor's view chips besides All (docs/sql-server-agent.md). */
export const agentJobViews = ['running', 'failed', 'disabled'] as const
/** What each watched job slot carries, in order (agent.jobs.watched): job0Status … job2LastRun. */
export const agentWatchedFields = ['Status', 'Step', 'Steps', 'Started', 'LastOutcome', 'LastRun'] as const
const agentWatchedSeries: readonly LiveSeriesSpec[] = [
  ...Array.from({ length: agentLimits.watchedJobs }, (_, slot) => agentWatchedFields.map((field): LiveSeriesSpec => ({ id: `job${slot}${field}`, unit: 'count', label: `Watched job ${slot + 1}: ${field}`, counter: 'gauge' }))).flat(),
  { id: 'serverNow', unit: 'count', label: 'Server time (yyyymmddhhmmss)', counter: 'gauge' }
]

export const liveSourceIds = ['debug.synthetic', 'activity', 'explorer', 'ssis.catalog', 'ssis.operations', 'query.plan', 'agent.jobs', 'agent.history', 'agent.errorLog', 'bigquery.jobs', 'agent.tree'] as const
export type LiveSourceId = typeof liveSourceIds[number]
export const liveProbeIds = [
  'debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status', 'debug.synthetic.grid', 'debug.synthetic.log', 'debug.synthetic.wide', ...activityLiveProbes,
  'explorer.databases', 'explorer.progress', 'explorer.agent', 'explorer.availability', 'ssis.catalogProbe', 'ssis.operations.list', 'query.plan.operators',
  'explorer.agentService', 'agent.jobs.list', 'agent.jobs.service', 'agent.jobs.watched', 'agent.history.list', 'agent.errorLog.read', 'bigquery.jobs.list', 'agent.treeProbe'
] as const
export type LiveProbeId = typeof liveProbeIds[number]

export const liveSources: { readonly [S in LiveSourceId]: LiveSourceSpec } = {
  'query.plan': {
    id: 'query.plan', label: 'Live Execution Plan', scope: 'server', testOnly: false, probes: ['query.plan.operators'], hidden: 'pause',
    description: 'Transient operator statistics for a query executed in Varia. Args: queryId. Reads sys.dm_exec_query_statistics_xml on a separate observer, at most once a second, only after the previous frame is acknowledged. Hidden views pause. The query session and batch repetition must still match.'
  },
  'debug.synthetic': {
    id: 'debug.synthetic', label: 'Synthetic', scope: 'none', testOnly: true, probes: ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status', 'debug.synthetic.grid', 'debug.synthetic.log', 'debug.synthetic.wide'],
    description: 'Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it.'
  },
  activity: {
    id: 'activity', label: 'Activity Monitor', scope: 'server', testOnly: false, probes: activityLiveProbes,
    description: 'SQL Server\'s own activity, read from server DMVs on the connection\'s " - Activity Monitor" pool (READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW), opened in master on box servers and Managed Instance so it never holds the database a connection opened in (except for a contained database user, or when the connect could not read the server\'s profile: then it keeps the connection\'s database). Its probes, tables, columns and series come from the Activity Monitor\'s catalogue (docs/activity-monitor.md). Each probe runs several statements (Activity/ActivitySql.cs), and one the login may not run fails alone, naming what it feeds. Args: one filter per table (Sessions\' view chip and toggles, the filter box, column value filters, Hide benign waits) and the Details flyout\'s session (focusSession).'
  },
  explorer: {
    id: 'explorer', label: 'Object Explorer status', scope: 'server', testOnly: false, probes: ['explorer.databases', 'explorer.progress', 'explorer.agent', 'explorer.availability', 'explorer.agentService'],
    description: 'The states Object Explorer shows as chips on its nodes (docs/object-explorer.md, Live status): one view per connected server and login while Object Explorer shows, on the server pool (" - Activity Monitor": READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW) opened in master on box servers and Managed Instance, so it never holds the database a connection opened in (except for a contained database user, or when the connect could not read the server\'s profile: then it keeps the connection\'s database). It never reloads the tree.'
  },
  'ssis.catalog': {
    id: 'ssis.catalog', label: 'SSIS Catalog', scope: 'ssisdb', testOnly: false, probes: ['ssis.catalogProbe'],
    description: 'The SSIS Catalog\'s views, read on the connection\'s " - Integration Services" pool in the catalog\'s database, SSISDB (READ UNCOMMITTED, or READ COMMITTED when the catalog has READ_COMMITTED_SNAPSHOT on; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). Object Explorer holds one per connection while an SSISDB node is open. A catalog that no longer exists ends it (CATALOG_MISSING).'
  },
  'ssis.operations': {
    id: 'ssis.operations', label: 'SSIS Operations', scope: 'ssisdb', testOnly: false, probes: ['ssis.operations.list'],
    description: 'The SSIS Catalog\'s operations (executions, validations, deployments and the rest) in a window of the last hours, read on the connection\'s " - Integration Services" pool in the catalog\'s database, SSISDB (READ UNCOMMITTED, or READ COMMITTED when the catalog has READ_COMMITTED_SNAPSHOT on; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). Its args are the Operations document\'s filters (kinds, statuses, folder, project, package, caller, the window and its row limit); new args read the window again. A catalog that no longer exists ends it (CATALOG_MISSING).'
  },
  'agent.jobs': {
    id: 'agent.jobs', label: 'SQL Server Agent jobs', scope: 'server', testOnly: false, probes: ['agent.jobs.list', 'agent.jobs.service', 'agent.jobs.watched'], hidden: 'statusOnly',
    description: 'SQL Server Agent\'s jobs as the login may see them (docs/sql-server-agent.md, Job Activity Monitor), read on the server pool (" - Activity Monitor": READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW) opened in master, through msdb\'s own procedures (AgentReader, linted by AgentSql.LintRead), so every Agent role sees the jobs msdb shows it. Job Activity Monitor opens a view of the list and service probes; the status bar opens one of the watched and service probes with whileHidden statusOnly, so a job this window started is still followed while the window is hidden. Args: the job whose last run the list probe reads (expand), the jobs the watched probe follows (watch, at most agentLimits.watchedJobs), and column value filters on the list (filters).'
  },
  'agent.history': {
    id: 'agent.history', label: 'SQL Server Agent job history', scope: 'server', testOnly: false, probes: ['agent.history.list'], hidden: 'pause',
    description: `SQL Server Agent's job history as the login may see it (docs/sql-server-agent.md, Log File Viewer), read on the server pool (" - Activity Monitor": READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW) opened in master, through msdb's own procedures (AgentReader, linted by AgentSql.LintRead), so every Agent role reads the history msdb shows it. The Log File Viewer opens one view per document; hidden views pause. Args: the checked jobs (jobs; absent every job, empty none), the date window in days, a run outcome, a message text, a step id, and the selected run whose steps the second table lists (run); the job document's History (AG-6d) checks its one job and asks for its usual durations (usual).`
  },
  'agent.errorLog': {
    id: 'agent.errorLog', label: 'SQL Server Agent error logs', scope: 'server', testOnly: false, probes: ['agent.errorLog.read'], hidden: 'pause',
    description: `SQL Server Agent's error logs (docs/sql-server-agent.md, Log File Viewer), sysadmin only, read on the server pool (" - Activity Monitor": READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW) opened in master through master's own error log readers (AgentReader, linted by AgentSql.LintRead). The Log File Viewer opens one view per document while a log is checked; hidden views pause. Args: the checked logs by archive number (logs), the date window in days and a message text.`
  },
  'agent.tree': {
    id: 'agent.tree', label: 'SQL Server Agent tree', scope: 'server', testOnly: false, probes: ['agent.treeProbe'],
    description: 'What SQL Server Agent\'s Object Explorer node lists (docs/sql-server-agent.md, Object Explorer), read on the server pool (" - Activity Monitor": READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW) opened in master. Object Explorer holds one per connection while a SQL Server Agent node is open and shown, and re-lists only what changed, keeping expansion and selection: the node when Agent XPs or the service state changed, a folder when its fingerprint did. Hidden views pause.'
  },
  [jobHistorySource]: {
    id: jobHistorySource, label: 'BigQuery job history', scope: 'bigquery', providers: ['bigquery'], testOnly: false, probes: [jobHistoryProbe], hidden: 'pause',
    description: 'A BigQuery connection\'s jobs in its billing project (docs/bigquery.md, Job History), read through BigQuery\'s REST API with jobs.list and jobs.get, which are free API calls, never a query and never the INFORMATION_SCHEMA.JOBS views; every call goes through the connection principal\'s shared rate limiter. The Job History document opens one view per connection; hidden views pause. Args: the scope (the principal\'s jobs, or the project\'s with allUsers), the time range, state, job type, statement type and Started from Varia filters, pinned jobs, the scripts whose children show under them (expand), and whether the Cost column is written (prices).'
  }
}

type ActivityLiveProbe = typeof activityLiveProbes[number]
/** What each Activity Monitor probe is, for docs/live.md. */
const activityDescriptions: { readonly [P in ActivityLiveProbe]: string } = {
  'activity.overview': 'The server at a glance, in seven statements: SQL Server\'s CPU (its schedulers\' non-preemptive time) and scheduler delay, waiting tasks (wait time less signal wait of every type that is not benign), database I/O and its latency (moved only by databases read in both samples, so one dropped or closed takes only its own counts with it), batch requests, compilations and re-compilations, blocked sessions and the longest block, active requests, user sessions and logins, runnable tasks per scheduler and the work queue, memory grants, page life expectancy, deadlocks and lock waits. Rates use the server\'s own clock (ms_ticks), and a restart starts them again; a statement the login may not run leaves only its own series null.',
  'activity.sessions': 'Sessions (one row per session, its MARS requests folded), the blocking chains as rows (built in the backend from task waits, each session once) and Active Expensive Queries, from one sample. Rates are per session and per request between samples, keyed by login time and each request\'s id and start time, so a reused id never gives a rate across two sessions and a MARS session\'s requests never stand in for each other. Varia\'s own sessions are marked, and system sessions and Varia\'s pools are hidden unless the filter shows them. Without server state, Sessions shows only the monitor\'s own session and the other two tables report PERMISSION_DENIED without running SQL. Its two series follow the Details flyout\'s session (focusSession).',
  'activity.resources': 'Resource Waits (by category and by type) and Data File I/O, from one sample. Wait rates are per wait type between samples over the server\'s own clock (ms_ticks), rolled up to Query Store\'s categories plus Varia\'s benign list (Unknown shown, never dropped), with a 1-minute mean per category; a first sample, a restart or cleared statistics have no rate. File rates are per file, keyed by database and file id, with read, write and response latency, toned by the files filter\'s latency thresholds. Names fall back to ids without VIEW ANY DEFINITION. Its series are each category\'s wait time less signal wait, and the signal wait of every type, per second.',
  'activity.queries': 'Recent Expensive Queries: the plan cache\'s statements whose last execution ended since the previous sample (sys.dm_exec_query_stats, MAXDOP 1), each statement\'s change since its kept totals summed per query_hash, rates over the window since the previous sample. A first sample shows the last 10 minutes\' groups by their plans\' totals, without rates. Statement texts and databases come from a cache filled for the shown rows in batches; a row whose text has not arrived says "Loading text…". Rank chips sort in memory: the last sample\'s rows at once, then each sample.'
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
        // A table that tones its rows ends with the tone column, which the backend fills (NULL until it sets one).
        id: table, mode: 'snapshot',
        columns: [...table$.columns.map(item => ({ id: liveColumnId(table, item.id), name: item.caption, dataType: liveColumnTypes[item.type] })), ...table$.tones?.length ? [{ ...toneColumn, id: liveColumnId(table, 'tone') }] : []],
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
  return {
    'activity.overview': entry('activity.overview'), 'activity.sessions': entry('activity.sessions'), 'activity.resources': entry('activity.resources'),
    'activity.queries': entry('activity.queries')
  }
}

export const liveProbes: { readonly [P in LiveProbeId]: LiveProbeSpec } = {
  'query.plan.operators': {
    id: 'query.plan.operators', source: 'query.plan', label: 'Live operators', intervalMs: { default: 1000, min: 1000, max: 60_000 },
    status: ['phase'], minGapMs: 1000,
    description: 'One bounded plan topology followed by counter samples. Final actual plans use the query result capture.'
  },
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
    description: 'Two snapshot tables from one sample. Items move on by one id per sample, as the table probe\'s rows do, in five groups, with group facets, departed rows and a row tone (G0 error, G1 warning, G2 running); the even view keeps the items with an even id. Groups count the items of each group, built from the source\'s own state rather than read from SQL Server.',
    tables: [
      { id: 'items', mode: 'snapshot', key: ['itemId'], rowCap: 10_000, departed: true, facets: ['group'], columns: [column('itemId', 'int'), column('group', 'nvarchar'), column('name', 'nvarchar'), column('amount', 'int'), toneColumn] },
      { id: 'groups', mode: 'snapshot', key: ['groupName'], rowCap: 10, columns: [column('groupName', 'nvarchar'), column('items', 'int')] }
    ]
  },
  'debug.synthetic.log': {
    id: 'debug.synthetic.log', source: 'debug.synthetic', label: 'Synthetic log', intervalMs: anyInterval, filterMode: 'restart',
    description: 'An append table that grows by logRows messages a sample (levels 0 to 3; level 3 is toned error and level 2 warning). With lateEvery, one message of every n-th sample becomes visible a sample late, after higher ids, as a slow writer\'s commit would. A filter or a new logLevel (the lowest level shown) starts the table again under the new predicate, and start picks its first row.',
    tables: [{ id: 'messages', mode: 'append', key: ['messageId'], settle: { ticks: 2, ms: 0 }, batchRows: 5000, columns: [column('messageId', 'bigint'), column('level', 'int'), column('text', 'nvarchar'), toneColumn] }]
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
  ...activityLiveEntries(),
  'explorer.databases': {
    id: 'explorer.databases', source: 'explorer', label: 'Database states', intervalMs: { default: 5000, min: 2000, max: 300_000 }, gates: { minMajor: 13, editions: boxAndManaged },
    description: 'The databases that are not plainly online and open to everyone, from sys.databases: their state (sys.databases.state), user access (0 multi, 1 single, 2 restricted), read-only and standby flags. Needs no server permission; a login sees the databases sys.databases shows it.',
    tables: [{
      id: 'databases', mode: 'snapshot', key: ['name'], rowCap: 1000,
      columns: [column('name', 'sysname'), column('state', 'tinyint'), column('userAccess', 'tinyint'), column('readOnly', 'bit'), column('standby', 'bit')]
    }]
  },
  'explorer.progress': {
    id: 'explorer.progress', source: 'explorer', label: 'Restore and recovery progress', intervalMs: { default: 5000, min: 2000, max: 300_000 }, gates: { minMajor: 13, editions: boxAndManaged }, permission: 'serverState',
    description: 'How far each running RESTORE DATABASE or RESTORE LOG, and each database recovery (DB STARTUP), has come (sys.dm_exec_requests.percent_complete, whole percent). A recovery is its request\'s own database; a restore runs in its session\'s database, so the database it restores is the one its request holds an exclusive database lock on (sys.dm_tran_locks, which each read scans whole: read once per RESTORE request, never while none runs).',
    tables: [{ id: 'progress', mode: 'snapshot', key: ['name'], rowCap: 1000, columns: [column('name', 'sysname'), column('command', 'nvarchar'), column('percent', 'int')] }]
  },
  'explorer.agent': {
    id: 'explorer.agent', source: 'explorer', label: 'Running Agent jobs', intervalMs: { default: 10_000, min: 5000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] },
    description: 'How many SQL Server Agent jobs are running: msdb.dbo.sysjobactivity rows of the Agent\'s current session (the newest in msdb.dbo.syssessions) that started and have not stopped, as Job Activity Monitor counts them. A login msdb refuses gets PERMISSION_DENIED as a value.',
    series: [{ id: 'runningJobs', unit: 'count', label: 'Running jobs', counter: 'gauge' }]
  },
  'explorer.agentService': {
    id: 'explorer.agentService', source: 'explorer', label: 'SQL Server Agent state', intervalMs: { default: 10_000, min: 5000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] },
    description: 'SQL Server Agent\'s state for its Object Explorer node: Agent XPs (sys.configurations value_in_use, by configuration_id, which needs no permission), and, only where HAS_PERMS_BY_NAME says the login may (so the probe declares no permission gate and the XPs read always runs), the service\'s state and startup type from sys.dm_server_services (VIEW SERVER STATE before SQL Server 2022, VIEW SERVER SECURITY or PERFORMANCE STATE from it), or, where that DMV has no Agent row, whether an Agent session (program_name SQLAgent - …) is connected (VIEW SERVER STATE before 2022, VIEW SERVER PERFORMANCE STATE from it). Managed Instance always reads running. A value the login may not read is left out: unknown, so no state chip shows.',
    status: ['agentXps', 'serviceState', 'startupType']
  },
  'agent.jobs.list': {
    id: 'agent.jobs.list', source: 'agent.jobs', label: 'Jobs', intervalMs: { default: 5000, min: 2000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] }, budgetMs: { min: 500, max: 10_000 },
    views: agentJobViews, filterMode: 'memory',
    description: `Every job the login may see, one row each, from msdb.dbo.sp_help_job (msdb filters a SQLAgentUserRole login to its own jobs), at most ${agentLimits.listRows} (the rest cut, as rowLimit): SSMS's Job Activity Monitor columns, how long a running job has run (from msdb.dbo.sp_help_jobactivity for the Agent's current session and the server's clock, read only while a job runs; none where no start is readable) and a tone (last run failed error, running accent, between retries warning, disabled muted). Views running, failed and disabled keep those jobs; the filter box and column value filters (args.filters) apply in backend memory. Its series count jobs from the same read: running (execution statuses 1, 2, 3 and 7), last run failed, between retries and disabled. With args.expand, its second table is that job's last run (msdb.dbo.sp_help_jobhistory in FULL mode): the job outcome row and the step rows Agent wrote for that run, messages cut to ${agentLimits.gridMessageChars} characters.`,
    series: [
      { id: 'running', unit: 'count', label: 'Running', counter: 'gauge' },
      { id: 'failed', unit: 'count', label: 'Last run failed', counter: 'gauge' },
      { id: 'betweenRetries', unit: 'count', label: 'Between retries', counter: 'gauge' },
      { id: 'disabled', unit: 'count', label: 'Disabled', counter: 'gauge' }
    ],
    tables: [
      {
        id: 'jobs', mode: 'snapshot', key: ['jobId'], rowCap: agentLimits.listRows, departed: true, facets: ['status', 'lastOutcome', 'category'],
        columns: [
          { id: 'name', name: 'Name', dataType: 'nvarchar' }, { id: 'enabled', name: 'Enabled', dataType: 'nvarchar' }, { id: 'status', name: 'Status', dataType: 'nvarchar' },
          { id: 'step', name: 'Step', dataType: 'nvarchar' }, { id: 'lastOutcome', name: 'Last Run Outcome', dataType: 'nvarchar' }, { id: 'lastRun', name: 'Last Run', dataType: 'datetime2' }, { id: 'elapsed', name: 'Running For', dataType: 'nvarchar' },
          { id: 'nextRun', name: 'Next Run', dataType: 'datetime2' }, { id: 'category', name: 'Category', dataType: 'nvarchar' }, { id: 'runnable', name: 'Runnable', dataType: 'nvarchar' },
          { id: 'scheduled', name: 'Scheduled', dataType: 'nvarchar' }, { id: 'owner', name: 'Owner', dataType: 'nvarchar' }, { id: 'jobId', name: 'Job ID', dataType: 'uniqueidentifier' },
          { id: 'created', name: 'Created', dataType: 'nvarchar' }, toneColumn
        ]
      },
      {
        id: 'lastRun', mode: 'snapshot', key: ['runInstance'], rowCap: agentLimits.stepsPerJob * 4,
        columns: [
          { id: 'runInstance', name: 'Instance', dataType: 'int' }, { id: 'runStep', name: 'Step ID', dataType: 'int' }, { id: 'runStepName', name: 'Step Name', dataType: 'nvarchar' },
          { id: 'runOutcome', name: 'Outcome', dataType: 'nvarchar' }, { id: 'runStarted', name: 'Started', dataType: 'datetime2' }, { id: 'runDuration', name: 'Duration', dataType: 'nvarchar' },
          { id: 'runMessage', name: 'Message', dataType: 'nvarchar' }, { ...toneColumn, id: 'runTone' }
        ]
      }
    ]
  },
  'agent.jobs.service': {
    id: 'agent.jobs.service', source: 'agent.jobs', label: 'SQL Server Agent state', intervalMs: { default: 10_000, min: 5000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] },
    description: 'SQL Server Agent\'s state for the views of its jobs, so they need no Object Explorer open: the same constant text as explorer.agentService (Agent XPs from sys.configurations, which needs no permission; the service\'s state and startup type only where HAS_PERMS_BY_NAME says the login may read them, else left out as unknown).',
    status: ['agentXps', 'serviceState', 'startupType']
  },
  'agent.jobs.watched': {
    id: 'agent.jobs.watched', source: 'agent.jobs', label: 'Watched jobs', intervalMs: { default: 5000, min: 2000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] },
    description: `The jobs this window started (args.watch, at most ${agentLimits.watchedJobs}), each read through msdb.dbo.sp_help_job @job_aspect = N'JOB' into fixed slot series by its place in the args: its execution status, current step, step count, start (yyyymmddhhmmss in server local time, from msdb.dbo.sp_help_jobactivity; none where not readable), last run outcome and last run start (yyyymmddhhmmss). A slot with no job, or whose read was refused this sample, has no values; a job no longer there reads status -1 and nothing else. The last series is the server's clock (yyyymmddhhmmss, server local time), by which the status bar dates a Start in server time. It has no table, so a status bar view of it keeps sampling while the window is hidden (whileHidden statusOnly).`,
    series: agentWatchedSeries
  },
  [jobHistoryProbe]: {
    id: jobHistoryProbe, source: jobHistorySource, label: 'Jobs',
    intervalMs: { default: jobHistoryLimits.intervalMs, min: jobHistoryLimits.minIntervalMs, max: jobHistoryLimits.maxIntervalMs }, idleIntervalMs: jobHistoryLimits.idleIntervalMs,
    loadGuard: false, budgetMs: { min: 1000, max: limits.live.budgetMs.max }, minGapMs: jobHistoryLimits.minIntervalMs, filterMode: 'memory',
    description: `The newest ${jobHistoryLimits.jobs} top-level jobs in the time range, newest first, from jobs.list with projection=full in pages of ${jobHistoryLimits.pageJobs}, each job's SQL cut to a ${jobHistoryLimits.previewChars}-character one-line preview as its page is decoded. A refresh asks for new jobs from ${jobHistoryLimits.overlapMs / 1000} s before the newest job a whole listing read (filtered out or not), at most the newest ${jobHistoryLimits.jobs}, for the open jobs (stateFilter pending and running; an open job is followed whatever the filters say), and, for each held open job missing from that answer, its final state: jobs.get for the principal's own jobs and, where BigQuery allows it, others', else a stateFilter=done listing of each one's creation millisecond. A done job never changes, so it is kept and never read again; new args list from scratch. In All users a second, minimal listing without allUsers marks the principal's own jobs, never an email comparison; another user's job that came back without its configuration is marked details hidden. Failed and cancelled are DONE jobs with an error, cancelled when its reason is stopped. A refresh stops between pages at ${jobHistoryLimits.responseBytes / 1024 / 1024} MiB of responses or three quarters of its budget and goes on from that page at the next one, which comes at the asked interval while the list is loading. Expanded scripts list their children (jobs.list?parentJobId, the newest ${jobHistoryLimits.children}, in statement order) under them, read again only while the script runs. Pinned jobs are read with jobs.get whatever their age and shown whatever the filters say. Its cost is network and quota waits, so no load guard (loadGuard false). Status: jobs held, whether more exist in the range, whether the list is still loading, the locations BigQuery could not read, the open jobs, and whether All users was refused (PERMISSION_DENIED).`,
    status: jobHistoryStatus,
    tables: [{ id: 'jobs', mode: 'snapshot', key: ['job'], rowCap: jobHistoryLimits.jobs + jobHistoryLimits.expanded * jobHistoryLimits.children, columns: jobHistoryColumns }]
  },
  'agent.treeProbe': {
    id: 'agent.treeProbe', source: 'agent.tree', label: 'Agent tree changes', intervalMs: { default: 15_000, min: 5000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] }, budgetMs: { min: 500, max: 10_000 },
    description: 'One query: Agent XPs and the service state as explorer.agentService reads them (the state only where HAS_PERMS_BY_NAME says the login may), then, for each msdb table the Agent node\'s folders list (agentTreeFingerprints in src/shared/agent/tree.ts: sysjobs_view, sysalerts, sysoperators, sysproxies, sysproxysubsystem), its row count and a checksum of the columns the tree shows (the sum of the first 3 bytes of each row\'s SHA-256, exact in JavaScript), read only where HAS_PERMS_BY_NAME says the login may select it, else 0 and 0. sysjobs_view filters a SQLAgentUserRole login to its own jobs, so a fingerprint changes only when something the login may see does. A job created, renamed, enabled, disabled or deleted elsewhere, and the same for alerts, operators and proxies, reloads its folder; Refresh is not needed.',
    status: agentTreeStatus
  },
  'agent.history.list': {
    id: 'agent.history.list', source: 'agent.history', label: 'Job history', intervalMs: { default: 15_000, min: 5000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] }, budgetMs: { min: 1000, max: 10_000 },
    description: `The checked jobs' runs, newest first: msdb.dbo.sp_help_jobhistory in FULL mode (each checked job by @job_id, else every job the login may see; a multi-server job's history from the every-job read, since by @job_id msdb answers its target servers; with a window, from the day before its start), up to ${agentLimits.historyRows} rows a job read (more set the runs table's truncation; once the rows read reach that, checked jobs not yet read are counted in historySkippedJobs; a checked job that no longer exists is skipped), grouped into runs: a job outcome row (step 0) with the step rows Agent wrote after the job's previous outcome row that started at or after it. Step rows with no outcome row are In progress while the job runs (msdb.dbo.sp_help_job, and msdb.dbo.sp_help_jobactivity for its start), In progress or unknown while Agent XPs is off and the service is not read as stopped, and Unknown (no job outcome) otherwise. The window (from the server's clock), outcome, message text and step filters keep whole runs, in backend memory. The second table is the selected run's rows (args.run); the third is every job the login may see (the viewer's sources), with whether it runs now; the fourth, only with args.usual (one checked job), is the job's usual durations: the median of its newest 10 succeeded runs, whatever the filters, for the job (step 0) and each step id (a step's rows in a run added up). Messages are cut to ${agentLimits.gridMessageChars} characters (agent.historyMessage reads one whole). Status: SQL Server Agent's history caps from msdb.dbo.sp_get_sqlagent_properties, where the login may read them, and how many checked jobs the cap left unread.`,
    status: ['historyMaxRows', 'historyMaxRowsPerJob', 'historySkippedJobs'],
    tables: [
      {
        id: 'runs', mode: 'snapshot', key: ['runKey'], rowCap: agentLimits.historyRows,
        columns: [
          { id: 'runDate', name: 'Date', dataType: 'datetime2' }, { id: 'runJob', name: 'Job Name', dataType: 'nvarchar' }, { id: 'runOutcome', name: 'Outcome', dataType: 'nvarchar' },
          { id: 'runDuration', name: 'Duration', dataType: 'nvarchar' }, { id: 'runSteps', name: 'Steps', dataType: 'int' }, { id: 'runMessage', name: 'Message', dataType: 'nvarchar' },
          { id: 'runKey', name: 'Run', dataType: 'nvarchar' }, { id: 'runJobId', name: 'Job ID', dataType: 'uniqueidentifier' }, { ...toneColumn, id: 'runTone' }
        ]
      },
      {
        id: 'steps', mode: 'snapshot', key: ['stepInstance'], rowCap: 1000,
        columns: [
          { id: 'stepId', name: 'Step ID', dataType: 'int' }, { id: 'stepName', name: 'Step Name', dataType: 'nvarchar' }, { id: 'stepOutcome', name: 'Outcome', dataType: 'nvarchar' },
          { id: 'stepStarted', name: 'Started', dataType: 'datetime2' }, { id: 'stepDuration', name: 'Duration', dataType: 'nvarchar' }, { id: 'stepSeverity', name: 'Sql Severity', dataType: 'int' },
          { id: 'stepMessageId', name: 'Sql Message ID', dataType: 'int' }, { id: 'stepRetries', name: 'Retries Attempted', dataType: 'int' }, { id: 'stepMessage', name: 'Message', dataType: 'nvarchar' },
          { id: 'stepInstance', name: 'Instance', dataType: 'int' }, { id: 'stepJobId', name: 'Job ID', dataType: 'uniqueidentifier' }, { ...toneColumn, id: 'stepTone' }
        ]
      },
      {
        id: 'jobs', mode: 'snapshot', key: ['jobId'], rowCap: agentLimits.listRows,
        columns: [
          { id: 'jobId', name: 'Job ID', dataType: 'uniqueidentifier' }, { id: 'jobName', name: 'Name', dataType: 'nvarchar' }, { id: 'jobOwner', name: 'Owner', dataType: 'nvarchar' },
          { id: 'jobRunning', name: 'Running', dataType: 'nvarchar' }, { id: 'jobEnabled', name: 'Enabled', dataType: 'nvarchar' }
        ]
      },
      {
        id: 'usual', mode: 'snapshot', key: ['usualStep'], rowCap: 1001,
        columns: [
          { id: 'usualStep', name: 'Step ID', dataType: 'int' }, { id: 'usualSeconds', name: 'Usual Seconds', dataType: 'int' }, { id: 'usualRuns', name: 'Runs', dataType: 'int' }
        ]
      }
    ]
  },
  'agent.errorLog.read': {
    id: 'agent.errorLog.read', source: 'agent.errorLog', label: 'Agent error log', intervalMs: { default: 30_000, min: 10_000, max: 300_000 }, gates: { minMajor: 13, editions: [1, 2, 3, 8] }, budgetMs: { min: 1000, max: 10_000 },
    description: `The checked SQL Server Agent error logs (args.logs, by archive number; 0 is Current) through master.dbo.xp_readerrorlog <log>, 2 (sysadmin), newest first, with the message text as its search argument (msdb.dbo.sp_readmierrorlog on Managed Instance, which takes no sort argument and reads oldest first: status errorLogOldestFirst). It cannot page, so at most ${agentLimits.logRows} rows are read across the checked logs, in archive order, and the rest are cancelled (the table says it was cut). The date window counts back from the server's clock, in backend memory. Rows are merged newest first; a message keeps at most 4,000 characters. Below sysadmin the read is refused (PERMISSION_DENIED).`,
    status: ['errorLogOldestFirst'],
    tables: [
      {
        id: 'entries', mode: 'snapshot', key: ['logKey'], rowCap: agentLimits.logRows,
        columns: [
          { id: 'logDate', name: 'Date', dataType: 'datetime2' }, { id: 'logSource', name: 'Log', dataType: 'nvarchar' }, { id: 'logType', name: 'Type', dataType: 'nvarchar' },
          { id: 'logMessage', name: 'Message', dataType: 'nvarchar' }, { id: 'logKey', name: 'Entry', dataType: 'nvarchar' }, { id: 'logArchive', name: 'Archive', dataType: 'int' }, { ...toneColumn, id: 'logTone' }
        ]
      }
    ]
  },
  'explorer.availability': {
    id: 'explorer.availability', source: 'explorer', label: 'Availability group health', intervalMs: { default: 10_000, min: 5000, max: 300_000 }, gates: { minMajor: 13, editions: [2, 3] }, permission: 'serverState',
    description: 'Each availability group\'s synchronization health (0 not healthy, 1 partially healthy, 2 healthy) and this replica\'s role (0 resolving, 1 primary, 2 secondary), from sys.dm_hadr_availability_group_states and sys.dm_hadr_availability_replica_states. A server without Always On has no rows.',
    tables: [{ id: 'groups', mode: 'snapshot', key: ['name'], rowCap: 100, columns: [column('name', 'sysname'), column('health', 'tinyint'), column('role', 'tinyint')] }]
  },
  'ssis.catalogProbe': {
    id: 'ssis.catalogProbe', source: 'ssis.catalog', label: 'Catalog changes', intervalMs: { default: 30_000, min: 10_000, max: 300_000 }, budgetMs: { min: 500, max: 10_000 },
    description: 'A fingerprint of each catalog view the SSIS tree and its documents show, in one query: its row count and a checksum of the columns they show (catalogFingerprints in src/shared/ssis/catalog.ts), over the rows row-level security lets the login see; catalog properties only for a sysadmin or ssis_admin, the only ones who may read them. Object Explorer reloads only what changed, keeping expansion and selection.',
    status: catalogFingerprintStatus
  },
  'ssis.operations.list': {
    id: 'ssis.operations.list', source: 'ssis.operations', label: 'Operations', intervalMs: { default: 2000, min: 1000, max: 60_000 }, budgetMs: { min: 500, max: 10_000 },
    description: `The window's operations, newest first, as the backend keeps them. A new window (the first sample, new args) reads the newest operations that pass the filters and, apart, every open one in their scope whatever its age; each later sample reads the operations above the newest id it has settled (an id settles ${operationsSettle.ticks} samples and ${operationsSettle.ms / 1000} s after it was first seen, since an id is assigned before its row commits; the catalog's highest id settles the same way, so the read stays above the newest operations even when the filters match none of them) and the open ones it holds again (at most 256 a sample, in turn), and drops what left the window or the status filter. Within the limit, open operations come first. Folder and Project match an execution's or a validation's names, and Project a deployment's project too. The tiles ignore the filters and the limit: each sample counts the running and pending operations, and every 30 s those created in the last 24 hours by status, over every operation the login may see (row-level security shows a login only the operations it may read), each from a watermark below which nothing can count (the lowest open id, the lowest id of the 24 hours; both 0 on a new window), so a catalog's history costs no read.`,
    series: [
      { id: 'running', unit: 'count', label: 'Running', counter: 'gauge' },
      { id: 'pending', unit: 'count', label: 'Pending', counter: 'gauge' },
      { id: 'failed24h', unit: 'count', label: 'Failed (24 h)', counter: 'gauge' },
      { id: 'succeeded24h', unit: 'count', label: 'Succeeded (24 h)', counter: 'gauge' },
      { id: 'canceled24h', unit: 'count', label: 'Canceled (24 h)', counter: 'gauge' }
    ],
    status: ['newest'],
    tables: [{
      id: 'operations', mode: 'snapshot', key: ['operationId'], rowCap: 10_000, departed: true, settle: operationsSettle,
      columns: [
        { id: 'operationId', name: 'ID', dataType: 'bigint' }, { id: 'type', name: 'Type', dataType: 'nvarchar' }, { id: 'status', name: 'Status', dataType: 'nvarchar' },
        { id: 'folder', name: 'Folder', dataType: 'nvarchar' }, { id: 'project', name: 'Project', dataType: 'nvarchar' }, { id: 'package', name: 'Package', dataType: 'nvarchar' },
        { id: 'object', name: 'Object', dataType: 'nvarchar' }, { id: 'start', name: 'Start', dataType: 'datetimeoffset' }, { id: 'end', name: 'End', dataType: 'datetimeoffset' },
        { id: 'duration', name: 'Duration', dataType: 'nvarchar' }, { id: 'caller', name: 'Caller', dataType: 'nvarchar' }, { id: 'stoppedBy', name: 'Stopped by', dataType: 'nvarchar' },
        { id: 'server', name: 'Server', dataType: 'nvarchar' }, { id: 'machine', name: 'Machine', dataType: 'nvarchar' }, toneColumn
      ]
    }]
  }
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
      ? { id: table.id, mode: table.mode, columns: table.columns, key: table.key, rowCap: table.rowCap ?? defaultSnapshotRows, departed: table.departed ?? false, facets: table.facets ?? [], ...table.settle ? { settle: table.settle } : {} }
      : { id: table.id, mode: table.mode, columns: table.columns, key: table.key, settle: table.settle ?? defaultSettle, batchRows: table.batchRows ?? defaultBatchRows })
    return {
      ...spec, series: spec.series ?? [], tables, status: spec.status ?? [], views: spec.views ?? [], filterMode: spec.filterMode ?? 'none',
      budgetMs: spec.budgetMs ?? defaultBudgetMs, minGapMs: spec.minGapMs ?? 0, maxDutyCycle: spec.maxDutyCycle ?? defaultDutyCycle, loadGuard: spec.loadGuard ?? true, gates: spec.gates ?? null, permission: spec.permission ?? 'none'
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
