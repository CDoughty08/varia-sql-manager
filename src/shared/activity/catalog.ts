// The Activity Monitor: its probes (one live source, four probes), panes, tables and columns, tiles and the series they
// draw, view chips and filters, Query Store's wait categories with Varia's benign list, the blocking rules and limits. It
// is the only declaration of what the monitor samples and shows: the document, the settings page, the palette and
// docs/activity-monitor.md read it, and the backend embeds activityCatalogJson() as Activity/activity-catalog.json (a
// vitest file snapshot keeps that copy in sync), so C# holds no column list or wait map of its own. Erasable TypeScript
// (no enums), so Node's type stripping can load it too.

/** The live source every probe belongs to: one subscription per monitor (D-live), and its pool's program name suffix. */
export const activitySource = 'activity'
export const activityPoolSuffix = ' - Activity Monitor'

// One entry per line, so later probes, panes and tables append cleanly.
export const activityProbes = [
  'activity.overview',
  'activity.sessions',
  'activity.resources',
  'activity.queries'
] as const
export type ActivityProbe = typeof activityProbes[number]
export const activityTables = [
  'sessions',
  'blocking',
  'activeQueries',
  'waitCategories',
  'waitTypes',
  'files',
  'recentQueries'
] as const
export type ActivityTable = typeof activityTables[number]
/** SSMS's panes in SSMS's order; the ids are the `activityPane` context key's values. */
export const activityPanes = [
  'processes',
  'blocking',
  'waits',
  'fileIo',
  'recentQueries',
  'activeQueries'
] as const
export type ActivityPane = typeof activityPanes[number]

/** The monitor's one refresh interval, in seconds (SSMS's 5, 30 and 60 minute choices are left out: history covers them). */
export const activityIntervalsSeconds = [1, 2, 3, 5, 10, 15, 30, 60] as const
export type ActivityIntervalSeconds = typeof activityIntervalsSeconds[number]

export interface ProbeSpec {
  readonly title: string
  /** `metrics` sends series values; `snapshot` replaces its tables each sample. */
  readonly kind: 'metrics' | 'snapshot'
  readonly tables: readonly ActivityTable[]
  /** Series ids it sends; `wait.*` stands for one series per wait category. */
  readonly series: readonly string[]
  readonly defaultIntervalMs: number
  /** The lowest interval the live layer accepts for it. */
  readonly minIntervalMs: number
  readonly maxIntervalMs: number
  /** The monitor's interval is raised to at least this for the probe (resources sample every 5 s at most). */
  readonly floorMs: number
  /** The statement budget's ceiling; the live layer's own rule (a share of the interval) applies below it. */
  readonly budgetMs: number
  /** Refresh Now never runs it twice within this. */
  readonly minGapMs?: number
  /** The load guard: the interval doubles while a sample costs more than this share of it. */
  readonly maxDutyCycle: number
  /** Statements run with OPTION (MAXDOP 1): the plan cache can be large. */
  readonly maxdop1?: boolean
  /** How filters apply (D-live's per-probe field): in backend memory over the sample. A probe without tables takes none. */
  readonly filterMode?: 'memory'
  /** While no pane shows it, the probe is paused (no SQL); the monitor has no status-only probes. */
  readonly hidden: 'pause'
}
// activity.overview supersedes D-live §15's reference probe of the same id: the live layer runs ActivitySql's statements
// for it and sends these series ids (D-live's runnableTasks is runnablePerScheduler here), so there is one text and one lint.
export const probeSpecs: { readonly [P in ActivityProbe]: ProbeSpec } = {
  'activity.overview': {
    title: 'Overview', kind: 'metrics', tables: [], series: [
      'cpuPercent', 'schedulerDelay', 'waitingTasks', 'ioMegabytes', 'readLatency', 'writeLatency', 'batchRequests', 'compilations', 'recompilations', 'blockedSessions',
      'longestBlock', 'activeRequests', 'userSessions', 'logins', 'runnablePerScheduler', 'workQueue', 'grantsPending', 'grantsOutstanding', 'pageLifeExpectancy', 'deadlocks', 'lockWaits'
    ], defaultIntervalMs: 2_000, minIntervalMs: 1_000, maxIntervalMs: 60_000, floorMs: 1_000, budgetMs: 5_000, maxDutyCycle: 0.2, hidden: 'pause'
  },
  'activity.sessions': {
    title: 'Sessions', kind: 'snapshot', tables: ['sessions', 'blocking', 'activeQueries'], series: ['focus.cpuRate', 'focus.logicalReadsRate'],
    defaultIntervalMs: 2_000, minIntervalMs: 1_000, maxIntervalMs: 60_000, floorMs: 1_000, budgetMs: 5_000, maxDutyCycle: 0.2, filterMode: 'memory', hidden: 'pause'
  },
  'activity.resources': {
    title: 'Resources', kind: 'snapshot', tables: ['waitCategories', 'waitTypes', 'files'], series: ['wait.*', 'wait.signal'],
    defaultIntervalMs: 5_000, minIntervalMs: 2_000, maxIntervalMs: 60_000, floorMs: 5_000, budgetMs: 5_000, maxDutyCycle: 0.2, filterMode: 'memory', hidden: 'pause'
  },
  'activity.queries': {
    title: 'Query statistics', kind: 'snapshot', tables: ['recentQueries'], series: [],
    defaultIntervalMs: 30_000, minIntervalMs: 15_000, maxIntervalMs: 60_000, floorMs: 30_000, budgetMs: 10_000, minGapMs: 15_000, maxDutyCycle: 0.2, maxdop1: true, filterMode: 'memory', hidden: 'pause'
  }
}
/** The load guard's counts (D-live's back-off): a probe's interval doubles, up to its maxIntervalMs, after this many
 *  samples in a row cost more than its maxDutyCycle, and halves back after this many cheap ones. */
export const activityLoadGuard = { slowSamples: 3, cheapSamples: 10 } as const
/** The monitor's default interval (seconds) and the bounds of the query statistics' own interval, which settings take from here. */
export const activityIntervalDefaults = {
  refreshIntervalSeconds: probeSpecs['activity.overview'].defaultIntervalMs / 1_000,
  queriesIntervalSeconds: {
    default: probeSpecs['activity.queries'].defaultIntervalMs / 1_000, min: probeSpecs['activity.queries'].minIntervalMs / 1_000, max: probeSpecs['activity.queries'].maxIntervalMs / 1_000
  }
} as const
/** A probe's interval for the monitor's interval: raised to the probe's floor, and for query statistics to their own setting. */
export function probeIntervalMs(probe: ActivityProbe, intervalSeconds: number, queriesIntervalSeconds: number = activityIntervalDefaults.queriesIntervalSeconds.default): number {
  const spec = probeSpecs[probe], floor = probe === 'activity.queries' ? queriesIntervalSeconds * 1_000 : spec.floorMs
  return Math.min(spec.maxIntervalMs, Math.max(intervalSeconds * 1_000, floor, spec.minIntervalMs))
}

/** Bounds of the monitor's data and requests (D-live's limits apply on top). */
export const activityLimits = {
  monitorsPerConnection: 1, probesPerMonitor: 4,
  /** Rows a table keeps: more set `truncated`. The SQL reads one more to know. */
  sessions: 10_000, blockingEdges: 20_000, blockingRows: 2_000, blockingDepth: 32, activeQueries: 100, waitTypes: 2_000, files: 10_000, queryStatsRows: 20_000,
  queryDeltaKeys: 20_000, shownHashes: 200, textCache: 2_000, textBatch: 50, textBatchesPerTick: 4, leadBlockerBatches: 20,
  statementChars: 4_000, inputBufferChars: 4_000, resourceChars: 512, lastBatchChars: 200,
  facetColumns: 7, facetValues: 100, facetChars: 128,
  filterText: 400, columnFilters: 8, columnFilterValues: 50, columnFilterChars: 256, columnsPerProjection: 64,
  detailsChars: 1_000_000, detailsWaits: 20, detailsTransactions: 50, detailsLocks: 1_000, killSessions: 64,
  sessionId: 32_767
} as const

export type ColumnType = 'int' | 'bigint' | 'decimal' | 'text' | 'datetime' | 'bool'
/** A column's unit; '' only for text, times and flags. `id` is an identifier, `count` a number of things. */
export type ColumnUnit = '' | 'id' | 'count' | 'ms' | 'ms/s' | 's' | 'KB' | 'MB' | 'MB/s' | '/s' | '/min' | '%'
/** `ssms`: SSMS has it. `new`: Varia adds it. `fix`: SSMS has it, and Varia corrects what it shows (docs list why). */
export type Parity = 'ssms' | 'new' | 'fix'
export interface ColumnSpec {
  readonly id: string
  readonly caption: string
  readonly type: ColumnType
  readonly unit: ColumnUnit
  /** Shown by default. */
  readonly visible: boolean
  readonly parity: Parity
  /** What the value is and where it comes from; for `fix`, what SSMS shows instead. */
  readonly note: string
  /** Only when the server has the capability (spills from SQL Server 2016 SP2 and 2017 CU3). */
  readonly capability?: Capability
}
export interface TableSpec {
  readonly probe: ActivityProbe
  readonly title: string
  /** Key columns: rows keep their selection across samples by these. */
  readonly key: readonly string[]
  /** Columns that also identify a row for keyed deltas, so a reused session id never yields a rate across two sessions. */
  readonly identity?: readonly string[]
  readonly rowCap: number
  readonly columns: readonly ColumnSpec[]
  readonly defaultSort: readonly { readonly column: string; readonly descending: boolean }[]
  /** Columns the filter box matches. */
  readonly textColumns?: readonly string[]
  /** Columns that offer a value filter (SSMS's column filter) and the backend sends facets for. */
  readonly facetColumns?: readonly string[]
  /** Row tones the table can set (L5's hidden tone column). */
  readonly tones?: readonly RowTone[]
  /** A selected row that left the snapshot stays one more revision, toned `departed`. */
  readonly departedLinger?: boolean
}
const number = (value: number) => value.toLocaleString('en-US')
const c = (id: string, caption: string, type: ColumnType, unit: ColumnUnit, visible: boolean, parity: Parity, note: string, capability?: Capability): ColumnSpec =>
  capability ? { id, caption, type, unit, visible, parity, note, capability } : { id, caption, type, unit, visible, parity, note }

/** Row tones and the generic grid tone each uses (L5's `resultsGrid.row*` keys). */
export const rowTones = {
  blocked: 'error',
  blocking: 'warning',
  rollback: 'running',
  departed: 'muted',
  system: 'muted',
  latencyWarning: 'warning',
  latencyError: 'error'
} as const
export type RowTone = keyof typeof rowTones

export type Capability = 'totalSpills'
/** Server facts the capability probe reads once per subscription; the permission flags pick what the monitor offers. */
export const activityCapabilities = ['totalSpills'] as const satisfies readonly Capability[]
export const activityPermissions = ['viewServerState', 'viewServerPerformanceState', 'alterAnyConnection', 'viewAnyDefinition', 'viewDatabaseState', 'killDatabaseConnection'] as const

export const tableSpecs: { readonly [T in ActivityTable]: TableSpec } = {
  sessions: {
    probe: 'activity.sessions', title: 'Processes', key: ['sessionId'], identity: ['loginTime'], rowCap: 10_000, departedLinger: true,
    tones: ['blocked', 'blocking', 'rollback', 'departed', 'system'],
    defaultSort: [{ column: 'sessionId', descending: false }],
    textColumns: ['login', 'database', 'application', 'hostName', 'command', 'waitType', 'status'],
    facetColumns: ['login', 'database', 'application', 'hostName', 'waitType', 'command', 'status'],
    columns: [
      c('sessionId', 'Session ID', 'int', 'id', true, 'ssms', 'session_id; one row per session. Of its MARS requests a blocked one, else the lowest, fills the request columns, and CPU and reads add them all.'),
      c('status', 'Status', 'text', '', true, 'fix', 'The request\'s status, else the session\'s; "rolling back 42 %" during KILLED/ROLLBACK and "sleeping · 1 open tran" for an idle session with an open transaction. SSMS\'s Task State shows neither.'),
      c('login', 'Login', 'text', '', true, 'ssms', 'login_name.'),
      c('database', 'Database', 'text', '', true, 'ssms', 'The request\'s database, else the session\'s.'),
      c('command', 'Command', 'text', '', true, 'ssms', 'The request\'s command.'),
      c('application', 'Application', 'text', '', true, 'ssms', 'program_name.'),
      c('waitType', 'Wait Type', 'text', '', true, 'ssms', 'The request\'s wait type; for a parallel request, the longest blocking wait of its tasks.'),
      c('waitTimeMs', 'Wait Time (ms)', 'bigint', 'ms', true, 'ssms', 'The request\'s current wait.'),
      c('waitResource', 'Wait Resource', 'text', '', true, 'ssms', `wait_resource, else the blocking task's resource description (${number(activityLimits.resourceChars)} characters).`),
      c('blockedBy', 'Blocked By', 'int', 'id', true, 'fix', 'The session it waits on (its longest blocking wait); negative ids show their meaning. SSMS lists a session once per session it blocks.'),
      c('headBlocker', 'Head Blocker', 'bool', '', true, 'fix', 'Blocks another session and waits on none. SSMS marks it on each duplicate row.'),
      c('blocking', 'Blocking', 'int', 'count', true, 'new', 'Sessions downstream of it in its blocking chain.'),
      c('cpuRate', 'CPU (ms/s)', 'decimal', 'ms/s', true, 'new', 'CPU used per second over the interval: the session\'s CPU plus its running requests\'.'),
      c('totalCpuMs', 'Total CPU (ms)', 'bigint', 'ms', true, 'ssms', 'The session\'s CPU since login.'),
      c('physicalIoMb', 'Physical I/O (MB)', 'decimal', 'MB', true, 'ssms', 'Pages read and written since login, in MB (cumulative).'),
      c('logicalReadsRate', 'Logical Reads/s', 'decimal', '/s', true, 'new', 'Logical reads per second over the interval.'),
      c('memoryKb', 'Memory Use (KB)', 'bigint', 'KB', true, 'ssms', 'memory_usage pages, in KB.'),
      c('openTransactions', 'Open Transactions', 'int', 'count', true, 'fix', 'The session\'s open transactions. SSMS reads the request\'s count, so an idle session holding a transaction shows 0.'),
      c('elapsedSeconds', 'Elapsed (s)', 'decimal', 's', true, 'new', 'How long the current request has run.'),
      c('hostName', 'Host Name', 'text', '', true, 'ssms', 'host_name.'),
      c('netAddress', 'Net Address', 'text', '', false, 'ssms', 'client_net_address.'),
      c('loginTime', 'Login Time', 'datetime', '', false, 'ssms', 'login_time; with the session id it identifies the session.'),
      c('lastRequestStart', 'Last Request Start Time', 'datetime', '', false, 'ssms', 'last_request_start_time.'),
      c('requestId', 'Request ID', 'text', '', false, 'ssms', 'The lowest request id, with "+n" for more MARS requests.'),
      c('dop', 'DOP', 'int', 'count', false, 'new', 'The request\'s degree of parallelism; replaces SSMS\'s one row per task (Execution Context ID).'),
      c('workloadGroup', 'Workload Group', 'text', '', false, 'ssms', 'The Resource Governor workload group.'),
      c('originalLogin', 'Original Login', 'text', '', false, 'new', 'original_login_name.'),
      c('interface', 'Interface', 'text', '', false, 'new', 'client_interface_name.'),
      c('isolationLevel', 'Isolation Level', 'text', '', false, 'new', 'The session\'s transaction isolation level.'),
      c('encrypted', 'Encrypted', 'bool', '', false, 'new', 'The connection is encrypted.'),
      c('authScheme', 'Auth Scheme', 'text', '', false, 'new', 'SQL, NTLM or KERBEROS.'),
      c('hostProcessId', 'Host PID', 'int', 'id', false, 'new', 'host_process_id.'),
      c('queryHash', 'Query Hash', 'text', '', false, 'new', 'The current request\'s query_hash.'),
      c('varia', 'Varia', 'text', '', false, 'new', 'What a Varia session is: this window\'s query tab, or one of its pools.')
    ]
  },
  blocking: {
    probe: 'activity.sessions', title: 'Blocking', key: ['sessionId'], rowCap: 2_000, departedLinger: true, tones: ['blocked', 'blocking', 'departed'],
    defaultSort: [],
    textColumns: ['login', 'database', 'application', 'hostName', 'waitType', 'status'],
    columns: [
      c('session', 'Session', 'text', '', true, 'new', 'The session id indented by its depth in the chain; lead blockers at depth 0.'),
      c('sessionId', 'Session ID', 'int', 'id', false, 'new', 'session_id.'),
      c('depth', 'Depth', 'int', 'count', false, 'new', 'Depth in the chain (0 for a lead blocker).'),
      c('status', 'Status', 'text', '', true, 'new', 'As in Processes.'),
      c('blockedSessions', 'Blocked Sessions', 'int', 'count', true, 'new', 'Sessions downstream of it.'),
      c('waitType', 'Wait Type', 'text', '', true, 'new', 'The wait on its parent in the chain.'),
      c('waitTimeMs', 'Wait (ms)', 'bigint', 'ms', true, 'new', 'How long it has waited on its parent.'),
      c('waitResource', 'Wait Resource', 'text', '', true, 'new', 'What it waits for.'),
      c('login', 'Login', 'text', '', true, 'new', 'login_name.'),
      c('hostName', 'Host', 'text', '', true, 'new', 'host_name.'),
      c('application', 'Application', 'text', '', true, 'new', 'program_name.'),
      c('database', 'Database', 'text', '', true, 'new', 'The request\'s database, else the session\'s.'),
      c('openTransactions', 'Open Transactions', 'int', 'count', true, 'new', 'The session\'s open transactions.'),
      c('cycle', 'Cycle', 'bool', '', true, 'new', 'Part of a cycle (a deadlock SQL Server has not resolved yet); the chain is cut at its lowest session id.'),
      c('lastBatch', 'Last Batch', 'text', '', true, 'new', 'Lead blockers only: the start of the last batch it sent (sys.dm_exec_input_buffer).')
    ]
  },
  activeQueries: {
    probe: 'activity.sessions', title: 'Active Expensive Queries', key: ['sessionId', 'requestId'], identity: ['startTime'], rowCap: 100, departedLinger: true,
    tones: ['blocked', 'rollback', 'departed'],
    defaultSort: [{ column: 'cpuMs', descending: true }],
    textColumns: ['query', 'database', 'waitType', 'status'],
    columns: [
      c('query', 'Query', 'text', '', true, 'ssms', `The running statement, one line, ${number(activityLimits.statementChars)} characters.`),
      c('sessionId', 'Session ID', 'int', 'id', true, 'ssms', 'session_id.'),
      c('requestId', 'Request ID', 'int', 'id', false, 'new', 'request_id.'),
      c('startTime', 'Start Time', 'datetime', '', false, 'new', 'When the request started; with the ids it identifies the request.'),
      c('status', 'Status', 'text', '', true, 'ssms', 'The request\'s status.'),
      c('database', 'Database', 'text', '', true, 'ssms', 'The request\'s database.'),
      c('cpuMs', 'CPU (ms)', 'bigint', 'ms', true, 'fix', 'The request\'s CPU so far. SSMS captions this total "CPU (ms/sec)".'),
      c('cpuRate', 'CPU (ms/s)', 'decimal', 'ms/s', true, 'new', 'CPU per second over the interval.'),
      c('elapsedMs', 'Elapsed (ms)', 'bigint', 'ms', true, 'ssms', 'total_elapsed_time.'),
      c('physicalReads', 'Physical Reads', 'bigint', 'count', true, 'fix', 'Reads so far. SSMS captions this total "Physical Reads/sec".'),
      c('logicalReads', 'Logical Reads', 'bigint', 'count', true, 'fix', 'Logical reads so far. SSMS captions this total "Logical Reads/sec".'),
      c('writes', 'Writes', 'bigint', 'count', true, 'fix', 'Writes so far. SSMS captions this total "Logical Writes/sec".'),
      c('rowCount', 'Row Count', 'bigint', 'count', true, 'ssms', 'Rows returned so far.'),
      c('dop', 'DOP', 'int', 'count', true, 'new', 'Degree of parallelism.'),
      c('requestedMemoryKb', 'Requested Memory (KB)', 'bigint', 'KB', false, 'new', 'The memory grant requested.'),
      c('grantedMemoryKb', 'Granted Memory (KB)', 'bigint', 'KB', true, 'ssms', 'The memory grant (SSMS: Allocated Memory).'),
      c('requiredMemoryKb', 'Required Memory (KB)', 'bigint', 'KB', true, 'ssms', 'The minimum grant the query needs.'),
      c('usedMemoryKb', 'Used Memory (KB)', 'bigint', 'KB', true, 'ssms', 'Grant memory in use now.'),
      c('maxUsedMemoryKb', 'Max Used Memory (KB)', 'bigint', 'KB', false, 'new', 'The most grant memory used so far.'),
      c('grantWaitMs', 'Grant Wait (ms)', 'bigint', 'ms', true, 'new', 'How long it waited for its grant (RESOURCE_SEMAPHORE).'),
      c('waitType', 'Wait Type', 'text', '', true, 'new', 'The request\'s wait type.'),
      c('blockedBy', 'Blocked By', 'int', 'id', true, 'new', 'The session it waits on.'),
      c('percentComplete', '% Complete', 'decimal', '%', false, 'new', 'For commands that report progress (BACKUP, RESTORE, DBCC, rollback).'),
      c('queryHash', 'Query Hash', 'text', '', false, 'new', 'query_hash.')
    ]
  },
  waitCategories: {
    probe: 'activity.resources', title: 'Wait categories', key: ['categoryId'], rowCap: 24,
    defaultSort: [{ column: 'waitRate', descending: true }],
    textColumns: ['category', 'topWaitType'],
    columns: [
      c('categoryId', 'Category ID', 'text', '', false, 'new', 'The category\'s id in this catalogue.'),
      c('category', 'Wait Category', 'text', '', true, 'fix', 'Query Store\'s documented categories plus Varia\'s benign list, so every wait type counts. SSMS\'s 2008 table knows 241 of SQL Server 2025\'s 1,546 types and drops the rest.'),
      c('waitRate', 'Wait Time (ms/sec)', 'decimal', 'ms/s', true, 'ssms', 'Wait time less signal wait, per second over the interval.'),
      c('signalRate', 'Signal Wait (ms/sec)', 'decimal', 'ms/s', true, 'new', 'Time runnable tasks waited for a CPU, per second (SSMS computes it but does not show it).'),
      c('minuteAverage', '1-Minute Average (ms/sec)', 'decimal', 'ms/s', true, 'fix', 'The mean of the last 60 s. SSMS\'s Recent Wait Time is a weighted average over an unstated window.'),
      c('averageWaiters', 'Average Waiter Count', 'decimal', 'count', true, 'ssms', 'Wait time per second divided by 1,000.'),
      c('currentWaiters', 'Current Waiters', 'int', 'count', true, 'new', 'Tasks waiting in the category now.'),
      c('cumulativeSeconds', 'Cumulative Wait Time (sec)', 'decimal', 's', true, 'ssms', 'Since SQL Server started or the statistics were cleared.'),
      c('topWaitType', 'Top Wait Type', 'text', '', true, 'new', 'The category\'s largest wait type in the interval.')
    ]
  },
  waitTypes: {
    probe: 'activity.resources', title: 'Wait types', key: ['waitType'], rowCap: 2_000,
    defaultSort: [{ column: 'waitRate', descending: true }],
    textColumns: ['waitType', 'category'],
    columns: [
      c('waitType', 'Wait Type', 'text', '', true, 'new', 'Types with time in the interval or a task waiting now.'),
      c('category', 'Category', 'text', '', true, 'new', 'Its wait category.'),
      c('waitRate', 'Wait Time (ms/sec)', 'decimal', 'ms/s', true, 'new', 'Wait time less signal wait, per second.'),
      c('signalRate', 'Signal (ms/sec)', 'decimal', 'ms/s', true, 'new', 'Signal wait per second.'),
      c('waitsRate', 'Waits/sec', 'decimal', '/s', true, 'new', 'Waits that ended per second.'),
      c('averageWaitMs', 'Average Wait (ms)', 'decimal', 'ms', true, 'new', 'Wait time per wait in the interval.'),
      c('maxWaitMs', 'Max Wait (ms)', 'bigint', 'ms', true, 'new', 'The longest wait since SQL Server started.'),
      c('currentWaiters', 'Current Waiters', 'int', 'count', true, 'new', 'Tasks waiting on it now.'),
      c('cumulativeSeconds', 'Cumulative (sec)', 'decimal', 's', true, 'new', 'Since SQL Server started or the statistics were cleared.'),
      c('benign', 'Benign', 'bool', '', true, 'new', 'A wait for work: on Varia\'s benign list or in Query Store\'s Idle category. It never counts in Waiting Tasks, and Hide benign waits hides it.')
    ]
  },
  files: {
    probe: 'activity.resources', title: 'Data File I/O', key: ['databaseId', 'fileId'], rowCap: 10_000, tones: ['latencyWarning', 'latencyError'],
    defaultSort: [{ column: 'totalMbRate', descending: true }],
    textColumns: ['database', 'file', 'fileName'],
    columns: [
      c('databaseId', 'Database ID', 'int', 'id', false, 'new', 'database_id.'),
      c('fileId', 'File ID', 'int', 'id', false, 'new', 'file_id.'),
      c('database', 'Database', 'text', '', true, 'ssms', 'The database\'s name, else "database 7" (names need VIEW ANY DEFINITION).'),
      c('file', 'File', 'text', '', true, 'new', 'The logical file name, else "file 2".'),
      c('type', 'Type', 'text', '', true, 'new', 'Rows, Log, FILESTREAM or Full-text.'),
      c('fileName', 'File Name', 'text', '', true, 'ssms', 'physical_name.'),
      c('readMbRate', 'MB/sec Read', 'decimal', 'MB/s', true, 'ssms', 'Bytes read per second, in MB.'),
      c('writeMbRate', 'MB/sec Written', 'decimal', 'MB/s', true, 'ssms', 'Bytes written per second, in MB.'),
      c('totalMbRate', 'MB/sec Total', 'decimal', 'MB/s', false, 'new', 'Read and written per second, in MB: the default order.'),
      c('readsRate', 'Reads/sec', 'decimal', '/s', true, 'new', 'Reads per second.'),
      c('writesRate', 'Writes/sec', 'decimal', '/s', true, 'new', 'Writes per second.'),
      c('readLatencyMs', 'Read Latency (ms)', 'decimal', 'ms', true, 'new', 'Read stall per read in the interval (blank with no reads).'),
      c('writeLatencyMs', 'Write Latency (ms)', 'decimal', 'ms', true, 'new', 'Write stall per write in the interval (blank with no writes).'),
      c('responseTimeMs', 'Response Time (ms)', 'decimal', 'ms', true, 'fix', 'Stall per I/O, reads and writes together, in the interval (SSMS parity); the latency columns keep them apart.'),
      c('throttledRate', 'Throttled (ms/s)', 'decimal', 'ms/s', false, 'new', 'Resource Governor I/O queueing per second.'),
      c('sizeMb', 'Size (MB)', 'decimal', 'MB', true, 'new', 'size_on_disk_bytes, in MB.')
    ]
  },
  recentQueries: {
    probe: 'activity.queries', title: 'Recent Expensive Queries', key: ['queryHash'], rowCap: 200,
    defaultSort: [{ column: 'cpuRate', descending: true }],
    textColumns: ['query', 'database'],
    columns: [
      c('query', 'Query', 'text', '', true, 'ssms', `A statement of the group (its most recent execution), ${number(activityLimits.statementChars)} characters.`),
      c('executionsPerMinute', 'Executions/min', 'decimal', '/min', true, 'ssms', 'Executions per minute over the sample window.'),
      c('cpuRate', 'CPU (ms/sec)', 'decimal', 'ms/s', true, 'ssms', 'Worker time per second over the sample window.'),
      c('avgCpuMs', 'Avg CPU (ms)', 'decimal', 'ms', true, 'new', 'Worker time per execution.'),
      c('physicalReadsRate', 'Physical Reads/sec', 'decimal', '/s', true, 'ssms', 'Per second over the sample window.'),
      c('logicalReadsRate', 'Logical Reads/sec', 'decimal', '/s', true, 'ssms', 'Per second over the sample window.'),
      c('logicalWritesRate', 'Logical Writes/sec', 'decimal', '/s', true, 'ssms', 'Per second over the sample window.'),
      c('averageDurationMs', 'Average Duration (ms)', 'decimal', 'ms', true, 'ssms', 'Elapsed time per execution in the sample window.'),
      c('maxDurationMs', 'Max Duration (ms)', 'decimal', 'ms', true, 'new', 'The longest execution since the plan was cached.'),
      c('rowsPerExecution', 'Rows/Execution', 'decimal', 'count', true, 'new', 'Rows per execution.'),
      c('avgGrantKb', 'Avg Grant (KB)', 'decimal', 'KB', false, 'new', 'Memory grant per execution.'),
      c('spills', 'Spills', 'bigint', 'count', false, 'new', 'Pages spilled in the window.', 'totalSpills'),
      c('planCount', 'Plan Count', 'int', 'count', true, 'ssms', 'Distinct plans (query_plan_hash) in the group.'),
      c('database', 'Database', 'text', '', true, 'ssms', 'The plan\'s database.'),
      c('lastExecution', 'Last Execution', 'datetime', '', true, 'new', 'The group\'s latest execution (server time).'),
      c('cachedSince', 'Cached Since', 'datetime', '', false, 'new', 'The oldest plan\'s creation time.'),
      c('queryHash', 'Query Hash', 'text', '', false, 'new', 'query_hash, which groups the statements.')
    ]
  }
}

export interface PaneSpec {
  readonly title: string
  readonly probe: ActivityProbe
  /** The table the grid shows; `waits` toggles between categories and types. */
  readonly tables: readonly ActivityTable[]
  /** What the tab's count badge counts. */
  readonly badge: 'rows' | 'blocked'
}
export const paneSpecs: { readonly [P in ActivityPane]: PaneSpec } = {
  processes: { title: 'Processes', probe: 'activity.sessions', tables: ['sessions'], badge: 'rows' },
  blocking: { title: 'Blocking', probe: 'activity.sessions', tables: ['blocking'], badge: 'blocked' },
  waits: { title: 'Resource Waits', probe: 'activity.resources', tables: ['waitCategories', 'waitTypes'], badge: 'rows' },
  fileIo: { title: 'Data File I/O', probe: 'activity.resources', tables: ['files'], badge: 'rows' },
  recentQueries: { title: 'Recent Expensive Queries', probe: 'activity.queries', tables: ['recentQueries'], badge: 'rows' },
  activeQueries: { title: 'Active Expensive Queries', probe: 'activity.sessions', tables: ['activeQueries'], badge: 'rows' }
}
/** Split view's panes on first open: Processes beside Resource Waits. */
export const defaultPanes = { primary: 'processes', secondary: 'waits' } as const satisfies { readonly primary: ActivityPane; readonly secondary: ActivityPane | 'none' }

/** How a series turns samples into values (D-live's counter kinds); `scale` multiplies the result. */
export type SeriesKind = 'gauge' | 'rate' | 'msPerSecond' | 'ratio' | 'cpuPercent'
/** The live catalogue's series units (liveUnits in src/shared/live/catalog.ts) plus `seconds`, which the monitor's probes
 *  add to it for page life expectancy. A series sends its kind's value in its live unit; the monitor shows it times `scale`
 *  in `unit` (bytes per second as MB/s, wait ms per second as tasks). */
export const activityLiveUnits = ['perSecond', 'percent', 'ms', 'msPerSecond', 'bytesPerSecond', 'count', 'seconds'] as const
export type ActivityLiveUnit = typeof activityLiveUnits[number]
export interface SeriesSpec {
  readonly label: string
  readonly unit: ColumnUnit | 'tasks' | 'per scheduler'
  readonly liveUnit: ActivityLiveUnit
  readonly kind: SeriesKind
  readonly scale?: number
  readonly note: string
}
export const seriesSpecs: { readonly [id: string]: SeriesSpec } = {
  cpuPercent: { label: 'SQL Server CPU', unit: '%', liveUnit: 'percent', kind: 'cpuPercent', note: 'CPU used by SQL Server\'s schedulers (non-preemptive work), from sys.dm_os_schedulers; no WMI.' },
  schedulerDelay: { label: 'Scheduler delay', unit: 'ms/s', liveUnit: 'msPerSecond', kind: 'msPerSecond', note: 'Time tasks waited to be scheduled, per second.' },
  waitingTasks: { label: 'Waiting tasks', unit: 'tasks', liveUnit: 'msPerSecond', kind: 'msPerSecond', scale: 0.001, note: 'Average tasks waiting: wait time less signal wait of every type that counts as waiting (not benign: neither Varia\'s benign list nor Query Store\'s Idle category), per second, divided by 1,000.' },
  ioMegabytes: { label: 'Database I/O', unit: 'MB/s', liveUnit: 'bytesPerSecond', kind: 'rate', scale: 1 / 1_048_576, note: 'Bytes read and written by every database file, per second.' },
  readLatency: { label: 'Read latency', unit: 'ms', liveUnit: 'ms', kind: 'ratio', note: 'Read stall per read in the interval.' },
  writeLatency: { label: 'Write latency', unit: 'ms', liveUnit: 'ms', kind: 'ratio', note: 'Write stall per write in the interval.' },
  batchRequests: { label: 'Batch requests', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'Batch Requests/sec, a cumulative counter.' },
  compilations: { label: 'Compilations', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'SQL Compilations/sec.' },
  recompilations: { label: 'Recompilations', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'SQL Re-Compilations/sec.' },
  blockedSessions: { label: 'Blocked sessions', unit: 'count', liveUnit: 'count', kind: 'gauge', note: 'Sessions waiting on another session now.' },
  longestBlock: { label: 'Longest block', unit: 'ms', liveUnit: 'ms', kind: 'gauge', note: 'The longest of those waits.' },
  activeRequests: { label: 'Active requests', unit: 'count', liveUnit: 'count', kind: 'gauge', note: 'User sessions with a request now (the monitor\'s own left out).' },
  userSessions: { label: 'User sessions', unit: 'count', liveUnit: 'count', kind: 'gauge', note: 'User sessions now (the monitor\'s own left out).' },
  logins: { label: 'Logins', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'Logins/sec.' },
  runnablePerScheduler: { label: 'Runnable tasks', unit: 'per scheduler', liveUnit: 'count', kind: 'gauge', note: 'Tasks waiting for a CPU, per visible online scheduler.' },
  workQueue: { label: 'Work queue', unit: 'count', liveUnit: 'count', kind: 'gauge', note: 'Tasks waiting for a worker thread (THREADPOOL risk).' },
  grantsPending: { label: 'Memory grants pending', unit: 'count', liveUnit: 'count', kind: 'gauge', note: 'Queries waiting for a memory grant.' },
  grantsOutstanding: { label: 'Memory grants outstanding', unit: 'count', liveUnit: 'count', kind: 'gauge', note: 'Queries holding a memory grant.' },
  pageLifeExpectancy: { label: 'Page life expectancy', unit: 's', liveUnit: 'seconds', kind: 'gauge', note: 'Buffer Manager\'s page life expectancy.' },
  deadlocks: { label: 'Deadlocks', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'Number of Deadlocks/sec.' },
  lockWaits: { label: 'Lock waits', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'Lock Waits/sec.' },
  'focus.cpuRate': { label: 'Session CPU', unit: 'ms/s', liveUnit: 'msPerSecond', kind: 'msPerSecond', note: 'The Details flyout\'s session: its CPU per second.' },
  'focus.logicalReadsRate': { label: 'Session logical reads', unit: '/s', liveUnit: 'perSecond', kind: 'rate', note: 'The Details flyout\'s session: its logical reads per second.' },
  'wait.signal': { label: 'Signal wait', unit: 'ms/s', liveUnit: 'msPerSecond', kind: 'msPerSecond', note: 'Signal wait of every type, per second (CPU pressure).' }
}
/** The series a probe sends, with `wait.*` expanded to one per wait category. */
export const probeSeries = (probe: ActivityProbe): string[] => probeSpecs[probe].series.flatMap(id => id === 'wait.*' ? waitCategoryIds.map(category => `wait.${category}`) : [id])

export interface ThresholdSpec {
  readonly series: string
  readonly warning?: number
  readonly error?: number
  /** The settings that change the bounds (Activity Monitor's settings page). */
  readonly settings?: { readonly warning?: string; readonly error?: string }
  /** The settings' unit in the series' unit (seconds of blocking against a series in ms). */
  readonly settingScale?: number
  /** The tint applies only while this series is above zero (blocked sessions for the longest block). */
  readonly while?: string
}
export interface TileSpec {
  readonly caption: string
  readonly series: string
  /** `rate` over the interval, or an `instant` value. */
  readonly value: 'rate' | 'instant'
  readonly secondary: readonly string[]
  readonly thresholds: readonly ThresholdSpec[]
  readonly parity: Parity
  /** Its chart is expanded on the first open, so SSMS's view is recognisable at once. */
  readonly defaultExpanded?: boolean
}
// The first four are SSMS's four charts with SSMS's names.
export const tileSpecs: readonly TileSpec[] = [
  { caption: '% Processor Time', series: 'cpuPercent', value: 'rate', secondary: ['schedulerDelay'], parity: 'fix', defaultExpanded: true,
    thresholds: [{ series: 'cpuPercent', warning: 80, error: 95, settings: { warning: 'activityMonitor.cpuWarningPercent' } }] },
  { caption: 'Waiting Tasks', series: 'waitingTasks', value: 'rate', secondary: [], parity: 'fix', defaultExpanded: true, thresholds: [] },
  { caption: 'Database I/O', series: 'ioMegabytes', value: 'rate', secondary: ['readLatency', 'writeLatency'], parity: 'ssms',
    thresholds: ['readLatency', 'writeLatency'].map(series => ({ series, warning: 20, error: 50, settings: { warning: 'activityMonitor.fileLatencyWarningMs', error: 'activityMonitor.fileLatencyErrorMs' } })) },
  { caption: 'Batch Requests/sec', series: 'batchRequests', value: 'rate', secondary: ['compilations', 'recompilations'], parity: 'ssms', thresholds: [] },
  { caption: 'Blocked Sessions', series: 'blockedSessions', value: 'instant', secondary: ['longestBlock'], parity: 'new',
    thresholds: [{ series: 'longestBlock', warning: 5_000, error: 30_000, while: 'blockedSessions', settingScale: 1_000, settings: { warning: 'activityMonitor.blockedWarningSeconds', error: 'activityMonitor.blockedErrorSeconds' } }] },
  { caption: 'Active Requests', series: 'activeRequests', value: 'instant', secondary: ['userSessions', 'logins'], parity: 'new', thresholds: [] },
  { caption: 'CPU Pressure', series: 'runnablePerScheduler', value: 'instant', secondary: ['workQueue'], parity: 'new',
    thresholds: [{ series: 'runnablePerScheduler', warning: 1 }, { series: 'workQueue', error: 1 }] },
  { caption: 'Memory Grants Pending', series: 'grantsPending', value: 'instant', secondary: ['pageLifeExpectancy', 'deadlocks'], parity: 'new', thresholds: [{ series: 'grantsPending', warning: 1 }] }
]
/** At most this many tiles have their chart expanded at once. */
export const maxExpandedTiles = 2
/** The Resource Waits chart: the five largest categories, each a categorical hue, and the rest as Other (gray). Benign
 *  categories (Idle) are never charted: their time is threads waiting for work. */
export const waitsChartSeries = 5

/** Processes' view chips (one at a time) and toggles. */
export const viewChips = ['all', 'active', 'blocked', 'blocking', 'idleOpenTransaction', 'rollingBack'] as const
export type ViewChip = typeof viewChips[number]
export const viewChipTitles: { readonly [V in ViewChip]: string } = {
  all: 'All', active: 'Active', blocked: 'Blocked', blocking: 'Blocking', idleOpenTransaction: 'Idle with open transaction', rollingBack: 'Rolling back'
}
export const viewChipNotes: { readonly [V in ViewChip]: string } = {
  all: 'Every session the toggles allow.',
  active: 'Sessions with a request.',
  blocked: 'Sessions waiting on another session (a wait on a negative id, such as a latch owner, is not one).',
  blocking: 'Sessions another session waits on.',
  idleOpenTransaction: 'Sessions with no request and an open transaction: the classic forgotten transaction.',
  rollingBack: 'Sessions rolling back after KILL.'
}
export const sessionToggles = {
  showSystem: { title: 'System sessions', setting: 'activityMonitor.showSystemSessions', default: false },
  showVaria: { title: 'Varia\'s own', setting: 'activityMonitor.showVariaSessions', default: false }
} as const
/** Resource Waits' toggle (both of its tables): leaves out benign rows, the Idle category and its wait types. */
export const waitToggles = {
  hideBenign: { title: 'Hide benign waits', tables: ['waitCategories', 'waitTypes'], default: true }
} as const satisfies { readonly [toggle: string]: { readonly title: string; readonly tables: readonly ActivityTable[]; readonly default: boolean } }

/** Recent Expensive Queries' rank chips and the column each sorts by. */
export const rankChips = {
  cpu: { title: 'CPU', column: 'cpuRate' },
  duration: { title: 'Duration', column: 'averageDurationMs' },
  logicalReads: { title: 'Logical Reads', column: 'logicalReadsRate' },
  physicalReads: { title: 'Physical Reads', column: 'physicalReadsRate' },
  writes: { title: 'Writes', column: 'logicalWritesRate' },
  executions: { title: 'Executions', column: 'executionsPerMinute' }
} as const
export type RankChip = keyof typeof rankChips

/** What a negative blocking session id means (sys.dm_exec_requests). */
export const blockerLabels: { readonly [id: string]: string } = {
  '-2': 'Orphaned DTC',
  '-3': 'Deferred recovery',
  '-4': 'Latch owner unknown',
  '-5': 'Latch owner not tracked'
}

/** Varia's own sessions, by the program name's suffix after the connection's Application Name. `queryTab` sessions are
 *  this window's query tabs and always show; `pool` sessions are hidden unless Varia's own is on. */
export const variaSessionKinds: readonly { readonly suffix: string; readonly kind: 'queryTab' | 'pool'; readonly label: string }[] = [
  { suffix: '', kind: 'queryTab', label: 'Query tab' },
  { suffix: ' - Object Explorer', kind: 'pool', label: 'Varia Object Explorer' },
  { suffix: ' - Scripting', kind: 'pool', label: 'Varia Scripting' },
  { suffix: ' - Object Actions', kind: 'pool', label: 'Varia Object Actions' },
  { suffix: activityPoolSuffix, kind: 'pool', label: 'Varia Activity Monitor' },
  { suffix: ' - Integration Services', kind: 'pool', label: 'Varia Integration Services' },
  { suffix: ' - Integration Services Actions', kind: 'pool', label: 'Varia Integration Services Actions' }
]

/** SERVERPROPERTY('EngineEdition') values. Azure SQL Database is database-scoped and arrives later (AM6). */
export const activityEditions = {
  box: { editions: [1, 2, 3, 4], label: 'SQL Server (Windows, Linux and containers)', available: true },
  managedInstance: { editions: [8], label: 'Azure SQL Managed Instance', available: true },
  azureSqlDatabase: { editions: [5], label: 'Azure SQL Database', available: false }
} as const
export type ActivityEdition = keyof typeof activityEditions
/** Version bands the SQL is written for: 13 = SQL Server 2016 (the floor) to 17 = 2025. */
export const activityBands = { min: 13, max: 17 } as const
export const unavailableMessage = 'Activity Monitor isn\'t available for this kind of server.'

// --- Wait categories --------------------------------------------------------------------------------------------------

export interface WaitCategorySpec {
  readonly id: string
  /** sys.query_store_wait_stats.wait_category. */
  readonly value: number
  readonly label: string
  /** Exact wait type names. */
  readonly names: readonly string[]
  /** Prefixes written as Query Store writes them, with one trailing %. */
  readonly patterns: readonly string[]
}
/**
 * Query Store's documented map (sys.query_store_wait_stats), in its order. Learn lists EXTERNAL_SCRIPT_NETWORK_IOF, a
 * typo: SQL Server's type is EXTERNAL_SCRIPT_NETWORK_IO.
 */
export const waitCategories: readonly WaitCategorySpec[] = [
  { id: 'unknown', value: 0, label: 'Unknown', names: [], patterns: [] },
  { id: 'cpu', value: 1, label: 'CPU', names: ['SOS_SCHEDULER_YIELD'], patterns: [] },
  { id: 'workerThread', value: 2, label: 'Worker Thread', names: ['THREADPOOL'], patterns: [] },
  { id: 'lock', value: 3, label: 'Lock', names: [], patterns: ['LCK_M_%'] },
  { id: 'latch', value: 4, label: 'Latch', names: [], patterns: ['LATCH_%'] },
  { id: 'bufferLatch', value: 5, label: 'Buffer Latch', names: [], patterns: ['PAGELATCH_%'] },
  { id: 'bufferIo', value: 6, label: 'Buffer IO', names: [], patterns: ['PAGEIOLATCH_%'] },
  { id: 'compilation', value: 7, label: 'Compilation', names: ['RESOURCE_SEMAPHORE_QUERY_COMPILE'], patterns: [] },
  { id: 'sqlClr', value: 8, label: 'SQL CLR', names: [], patterns: ['CLR%', 'SQLCLR%'] },
  { id: 'mirroring', value: 9, label: 'Mirroring', names: [], patterns: ['DBMIRROR%'] },
  { id: 'transaction', value: 10, label: 'Transaction', names: ['TRANSACTION_MUTEX'], patterns: ['XACT%', 'DTC%', 'TRAN_MARKLATCH_%', 'MSQL_XACT_%'] },
  {
    id: 'idle', value: 11, label: 'Idle', patterns: ['SLEEP_%'], names: [
      'LAZYWRITER_SLEEP', 'SQLTRACE_BUFFER_FLUSH', 'SQLTRACE_INCREMENTAL_FLUSH_SLEEP', 'SQLTRACE_WAIT_ENTRIES', 'FT_IFTS_SCHEDULER_IDLE_WAIT', 'XE_DISPATCHER_WAIT',
      'REQUEST_FOR_DEADLOCK_SEARCH', 'LOGMGR_QUEUE', 'ONDEMAND_TASK_QUEUE', 'CHECKPOINT_QUEUE', 'XE_TIMER_EVENT'
    ]
  },
  { id: 'preemptive', value: 12, label: 'Preemptive', names: [], patterns: ['PREEMPTIVE_%'] },
  { id: 'serviceBroker', value: 13, label: 'Service Broker', names: [], patterns: ['BROKER_%'] },
  { id: 'tranLogIo', value: 14, label: 'Tran Log IO', names: ['LOGMGR', 'LOGBUFFER', 'LOGMGR_RESERVE_APPEND', 'LOGMGR_FLUSH', 'LOGMGR_PMM_LOG', 'CHKPT', 'WRITELOG'], patterns: [] },
  { id: 'networkIo', value: 15, label: 'Network IO', names: ['ASYNC_NETWORK_IO', 'NET_WAITFOR_PACKET', 'PROXY_NETWORK_IO', 'EXTERNAL_SCRIPT_NETWORK_IO'], patterns: [] },
  { id: 'parallelism', value: 16, label: 'Parallelism', names: ['CXCONSUMER', 'CXPACKET', 'CXSYNC_CONSUMER', 'CXSYNC_PORT', 'EXCHANGE'], patterns: ['HT%', 'BMP%', 'BP%'] },
  {
    id: 'memory', value: 17, label: 'Memory', patterns: [],
    names: ['RESOURCE_SEMAPHORE', 'CMEMTHREAD', 'CMEMPARTITIONED', 'EE_PMOLOCK', 'MEMORY_ALLOCATION_EXT', 'RESERVED_MEMORY_ALLOCATION_EXT', 'MEMORY_GRANT_UPDATE']
  },
  { id: 'userWait', value: 18, label: 'User Wait', names: ['WAITFOR', 'WAIT_FOR_RESULTS', 'BROKER_RECEIVE_WAITFOR'], patterns: [] },
  {
    id: 'tracing', value: 19, label: 'Tracing', patterns: [], names: [
      'TRACEWRITE', 'SQLTRACE_LOCK', 'SQLTRACE_FILE_BUFFER', 'SQLTRACE_FILE_WRITE_IO_COMPLETION', 'SQLTRACE_FILE_READ_IO_COMPLETION', 'SQLTRACE_PENDING_BUFFER_WRITERS',
      'SQLTRACE_SHUTDOWN', 'QUERY_TRACEOUT', 'TRACE_EVTNOTIFF'
    ]
  },
  {
    id: 'fullTextSearch', value: 20, label: 'Full Text Search', patterns: [], names: [
      'FT_RESTART_CRAWL', 'FULLTEXT GATHERER', 'MSSEARCH', 'FT_METADATA_MUTEX', 'FT_IFTSHC_MUTEX', 'FT_IFTSISM_MUTEX', 'FT_IFTS_RWLOCK', 'FT_COMPROWSET_RWLOCK', 'FT_MASTER_MERGE',
      'FT_PROPERTYLIST_CACHE', 'FT_MASTER_MERGE_COORDINATOR', 'PWAIT_RESOURCE_SEMAPHORE_FT_PARALLEL_QUERY_SYNC'
    ]
  },
  { id: 'otherDiskIo', value: 21, label: 'Other Disk IO', names: ['ASYNC_IO_COMPLETION', 'IO_COMPLETION', 'BACKUPIO', 'WRITE_COMPLETION', 'IO_QUEUE_LIMIT', 'IO_RETRY'], patterns: [] },
  { id: 'replication', value: 22, label: 'Replication', names: ['REPLICA_WRITES', 'FCB_REPLICA_WRITE', 'FCB_REPLICA_READ', 'PWAIT_HADRSIM'], patterns: ['SE_REPL_%', 'REPL_%', 'HADR_%', 'PWAIT_HADR_%'] },
  { id: 'logRateGovernor', value: 23, label: 'Log Rate Governor', names: ['LOG_RATE_GOVERNOR', 'POOL_LOG_RATE_GOVERNOR', 'HADR_THROTTLE_LOG_RATE_GOVERNOR', 'INSTANCE_LOG_RATE_GOVERNOR'], patterns: ['RBIO_RG_%'] }
]
export const waitCategoryIds = waitCategories.map(category => category.id)
/** Query Store's exceptions to its own patterns: matched before any pattern. */
export const waitExceptions: readonly { readonly name: string; readonly category: string; readonly note: string }[] = [
  { name: 'BROKER_RECEIVE_WAITFOR', category: 'userWait', note: 'Not Service Broker: a RECEIVE waiting for messages.' },
  { name: 'HADR_THROTTLE_LOG_RATE_GOVERNOR', category: 'logRateGovernor', note: 'Not Replication: log rate governance.' }
]
/**
 * Categories every wait type of which is benign: Query Store's Idle (LAZYWRITER_SLEEP, LOGMGR_QUEUE, SLEEP_%, ...), which
 * accrue about 11 s of wait per second on an idle SQL Server 2025. A benign wait never counts in Waiting Tasks, is never
 * charted, and Hide benign waits hides it.
 */
export const benignCategories: readonly string[] = ['idle']
/**
 * Varia's benign list: background and idle waits outside Query Store's Idle names that only say a thread is waiting for
 * work. They count in Idle, and are benign like the rest of it. Matched before everything else; AM3 completes the list with
 * the live coverage check.
 */
export const benignWaits: readonly { readonly name: string; readonly reason: string }[] = [
  { name: 'AZURE_IMDS_VERSIONS', reason: 'SQL Server 2022 and later asking the Azure instance metadata service at startup.' },
  { name: 'BROKER_EVENTHANDLER', reason: 'Service Broker\'s event handler waiting for work.' },
  { name: 'BROKER_TASK_STOP', reason: 'An idle Service Broker task waiting to stop.' },
  { name: 'BROKER_TO_FLUSH', reason: 'Service Broker\'s lazy flush of transmission objects.' },
  { name: 'BROKER_TRANSMITTER', reason: 'Service Broker\'s transmitter waiting for messages to send.' },
  { name: 'CLR_AUTO_EVENT', reason: 'A CLR background task waiting on an event.' },
  { name: 'CLR_MANUAL_EVENT', reason: 'A CLR background task waiting on an event.' },
  { name: 'CLR_SEMAPHORE', reason: 'A CLR background task waiting for work.' },
  { name: 'DBMIRRORING_CMD', reason: 'Mirroring waiting for log records to flush.' },
  { name: 'DBMIRROR_DBM_EVENT', reason: 'Database mirroring waiting for an event.' },
  { name: 'DBMIRROR_EVENTS_QUEUE', reason: 'Database mirroring waiting for events to process.' },
  { name: 'DBMIRROR_WORKER_QUEUE', reason: 'A mirroring worker waiting for work.' },
  { name: 'DIRTY_PAGE_POLL', reason: 'The recovery writer polling for dirty pages.' },
  { name: 'DISPATCHER_QUEUE_SEMAPHORE', reason: 'A dispatcher pool thread waiting for work.' },
  { name: 'FSAGENT', reason: 'The FILESTREAM file I/O agent waiting for work.' },
  { name: 'HADR_CLUSAPI_CALL', reason: 'An availability group thread waiting on the cluster API.' },
  { name: 'HADR_FILESTREAM_IOMGR_IOCOMPLETION', reason: 'The FILESTREAM I/O manager waiting for I/O completions.' },
  { name: 'HADR_LOGCAPTURE_WAIT', reason: 'Availability group log capture waiting for log to send.' },
  { name: 'HADR_NOTIFICATION_DEQUEUE', reason: 'An availability group task waiting for notifications.' },
  { name: 'HADR_TIMER_TASK', reason: 'An availability group timer task.' },
  { name: 'HADR_WORK_QUEUE', reason: 'An availability group worker waiting for work.' },
  { name: 'KSOURCE_WAKEUP', reason: 'The service control task waiting for requests.' },
  { name: 'PARALLEL_REDO_DRAIN_WORKER', reason: 'Parallel redo waiting on a secondary replica.' },
  { name: 'PARALLEL_REDO_LOG_CACHE', reason: 'Parallel redo waiting on a secondary replica.' },
  { name: 'PARALLEL_REDO_TRAN_LIST', reason: 'Parallel redo waiting on a secondary replica.' },
  { name: 'PARALLEL_REDO_WORKER_SYNC', reason: 'Parallel redo waiting on a secondary replica.' },
  { name: 'PARALLEL_REDO_WORKER_WAIT_WORK', reason: 'A parallel redo worker waiting for log to redo.' },
  { name: 'PREEMPTIVE_XE_GETTARGETSTATE', reason: 'Extended Events reading a target\'s state.' },
  { name: 'PWAIT_ALL_COMPONENTS_INITIALIZED', reason: 'Startup waiting for its components.' },
  { name: 'PWAIT_DIRECTLOGCONSUMER_GETNEXT', reason: 'A log consumer waiting for log records.' },
  { name: 'PWAIT_EXTENSIBILITY_CLEANUP_TASK', reason: 'The external scripts cleanup task.' },
  { name: 'QDS_ASYNC_QUEUE', reason: 'Query Store\'s background queue waiting for work.' },
  { name: 'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP', reason: 'Query Store\'s cleanup task sleeping.' },
  { name: 'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', reason: 'Query Store\'s flush task sleeping.' },
  { name: 'QDS_SHUTDOWN_QUEUE', reason: 'Query Store\'s shutdown queue.' },
  { name: 'REDO_THREAD_PENDING_WORK', reason: 'A redo thread waiting for log to redo.' },
  { name: 'SERVER_IDLE_CHECK', reason: 'The idle server check.' },
  { name: 'SOS_WORK_DISPATCHER', reason: 'A dispatcher pool thread waiting for work; the largest wait on an idle SQL Server 2019 or later.' },
  { name: 'SP_SERVER_DIAGNOSTICS_SLEEP', reason: 'sp_server_diagnostics sleeping between reports.' },
  { name: 'UCS_SESSION_REGISTRATION', reason: 'A unified communication stack session waiting to register.' },
  { name: 'VDI_CLIENT_OTHER', reason: 'A virtual device interface thread waiting for work (seeding).' },
  { name: 'WAIT_XTP_CKPT_CLOSE', reason: 'In-Memory OLTP waiting for a checkpoint to close.' },
  { name: 'WAIT_XTP_HOST_WAIT', reason: 'An In-Memory OLTP background task waiting.' },
  { name: 'WAIT_XTP_OFFLINE_CKPT_NEW_LOG', reason: 'The In-Memory OLTP offline checkpoint waiting for new log.' },
  { name: 'WAIT_XTP_RECOVERY', reason: 'In-Memory OLTP recovery of a database.' },
  { name: 'XE_DISPATCHER_JOIN', reason: 'An Extended Events dispatcher thread waiting.' },
  { name: 'XE_LIVE_TARGET_TVF', reason: 'An Extended Events live target waiting for events.' }
]
/** Types that may stay Unknown in the live coverage check (AM3); none yet. */
export const unknownAllowed: readonly string[] = []

export interface WaitClass { readonly category: string; readonly benign: boolean }
const byName = new Map<string, string>()
for (const category of waitCategories) for (const name of category.names) byName.set(name, category.id)
for (const exception of waitExceptions) byName.set(exception.name, exception.category)
const benignNames = new Set(benignWaits.map(wait => wait.name))
const prefixes = waitCategories.flatMap(category => category.patterns.map(pattern => ({ prefix: pattern.slice(0, -1), category: category.id })))
/** A wait type's category: benign names (Idle), then the exceptions and exact names, then prefixes in Query Store's order;
 *  anything else is Unknown, which the monitor shows rather than drops. It is benign on Varia's list or in a benign
 *  category. The backend applies the same rules to the embedded copy. */
export function waitCategoryOf(waitType: string): WaitClass {
  if (benignNames.has(waitType)) return { category: 'idle', benign: true }
  const category = byName.get(waitType) ?? prefixes.find(entry => waitType.startsWith(entry.prefix))?.category ?? 'unknown'
  return { category, benign: benignCategories.includes(category) }
}
/** Whether a wait type's time counts in Waiting Tasks (and the Resource Waits chart): every type that is not benign,
 *  Unknown ones too. */
export const countsAsWaiting = (waitType: string): boolean => !waitCategoryOf(waitType).benign

// Compact sorted-key JSON, as in actionsCatalogJson(), so each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'

/** The catalogue as the backend embeds it: what C# needs to build, filter and classify rows, without captions it never shows. */
export function activityCatalogJson(): string {
  return [
    '{',
    `  "bands": ${line(activityBands)},`,
    `  "benign": ${line(benignWaits.map(wait => wait.name))},`,
    `  "benignCategories": ${line(benignCategories)},`,
    `  "blockerLabels": ${line(blockerLabels)},`,
    `  "editions": ${line(Object.fromEntries(Object.entries(activityEditions).map(([id, spec]) => [id, { available: spec.available, editions: spec.editions }])))},`,
    `  "exceptions": ${line(waitExceptions.map(({ name, category }) => ({ name, category })))},`,
    `  "hideBenign": ${line({ default: waitToggles.hideBenign.default, tables: waitToggles.hideBenign.tables })},`,
    `  "limits": ${line(activityLimits)},`,
    `  "loadGuard": ${line(activityLoadGuard)},`,
    `  "poolSuffix": ${line(activityPoolSuffix)},`,
    `  "probes": ${block(activityProbes.map(probe => { const spec = probeSpecs[probe]; return { probe, kind: spec.kind, tables: spec.tables, series: probeSeries(probe), defaultIntervalMs: spec.defaultIntervalMs, minIntervalMs: spec.minIntervalMs, maxIntervalMs: spec.maxIntervalMs, floorMs: spec.floorMs, budgetMs: spec.budgetMs, minGapMs: spec.minGapMs, maxDutyCycle: spec.maxDutyCycle, maxdop1: spec.maxdop1, filterMode: spec.filterMode, hidden: spec.hidden } }))},`,
    `  "source": ${line(activitySource)},`,
    `  "tables": ${block(activityTables.map(table => {
      const spec = tableSpecs[table]
      return { table, probe: spec.probe, key: spec.key, identity: spec.identity, rowCap: spec.rowCap, columns: spec.columns.map(column => column.capability ? `${column.id}:${column.type}:${column.capability}` : `${column.id}:${column.type}`),
        textColumns: spec.textColumns, facetColumns: spec.facetColumns, tones: spec.tones, departedLinger: spec.departedLinger }
    }))},`,
    `  "tones": ${line(rowTones)},`,
    `  "variaSessions": ${line(variaSessionKinds.map(({ suffix, kind }) => ({ suffix, kind })))},`,
    `  "version": 1,`,
    `  "views": ${line(viewChips)},`,
    `  "waits": ${block(waitCategories.map(({ id, value, names, patterns }) => ({ id, value, names, patterns })))}`,
    '}',
    ''
  ].join('\n')
}
