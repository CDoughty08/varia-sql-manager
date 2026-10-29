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

export const liveSourceIds = ['debug.synthetic', 'activity', 'explorer', 'ssis.catalog', 'ssis.operations'] as const
export type LiveSourceId = typeof liveSourceIds[number]
export const liveProbeIds = [
  'debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status', 'debug.synthetic.grid', 'debug.synthetic.log', 'debug.synthetic.wide', ...activityLiveProbes,
  'explorer.databases', 'explorer.progress', 'explorer.agent', 'explorer.availability', 'ssis.catalogProbe', 'ssis.operations.list'
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
  },
  explorer: {
    id: 'explorer', label: 'Object Explorer status', scope: 'server', testOnly: false, probes: ['explorer.databases', 'explorer.progress', 'explorer.agent', 'explorer.availability'],
    description: 'The states Object Explorer shows as chips on its nodes (docs/object-explorer.md, Live status): one view per connected server and login while Object Explorer shows, on the server pool (" - Activity Monitor": READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW) opened in master on box servers and Managed Instance, so it never holds the database a connection opened in. It never reloads the tree.'
  },
  'ssis.catalog': {
    id: 'ssis.catalog', label: 'SSIS Catalog', scope: 'ssisdb', testOnly: false, probes: ['ssis.catalogProbe'],
    description: 'The SSIS Catalog\'s views, read on the connection\'s " - Integration Services" pool in the catalog\'s database, SSISDB (READ UNCOMMITTED, or READ COMMITTED when the catalog has READ_COMMITTED_SNAPSHOT on; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). Object Explorer holds one per connection while an SSISDB node is open. A catalog that no longer exists ends it (CATALOG_MISSING).'
  },
  'ssis.operations': {
    id: 'ssis.operations', label: 'SSIS Operations', scope: 'ssisdb', testOnly: false, probes: ['ssis.operations.list'],
    description: 'The SSIS Catalog\'s operations (executions, validations, deployments and the rest) in a window of the last hours, read on the connection\'s " - Integration Services" pool in the catalog\'s database, SSISDB (READ UNCOMMITTED, or READ COMMITTED when the catalog has READ_COMMITTED_SNAPSHOT on; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). Its args are the Operations document\'s filters (kinds, statuses, folder, project, package, caller, the window and its row limit); new args read the window again. A catalog that no longer exists ends it (CATALOG_MISSING).'
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
    description: `The window's operations, newest first, as the backend keeps them. A new window (the first sample, new args) reads the newest operations that pass the filters and, apart, every open one in their scope whatever its age; each later sample reads the operations above the newest id it has settled (an id settles ${operationsSettle.ticks} samples and ${operationsSettle.ms / 1000} s after it was first seen, since an id is assigned before its row commits) and the open ones it holds again (at most 256 a sample, in turn), and drops what left the window or the status filter. Within the limit, open operations come first. Folder and Project match an execution's or a validation's names, and Project a deployment's project too. The tiles ignore the filters and the limit: each sample counts the running and pending operations, and every 30 s those created in the last 24 hours by status, over every operation the login may see (row-level security shows a login only the operations it may read).`,
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
