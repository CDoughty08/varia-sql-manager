// Live data (docs/ipc.md, Live subscriptions): the sources a `live.subscribe` names, the probes each one runs, and what
// every probe emits (series, tables, status values). It is the only declaration of them: the port schemas
// (src/shared/live/schema.ts), docs/live.md and the backend read it, the backend through liveCatalogJson() embedded as
// Live/live-catalog.json (a vitest file snapshot keeps that copy in sync). Erasable TypeScript (no enums), so Node's
// type stripping can load it as well.
import { limits } from '../ipc/wire/protocol.ts'
import { catalogFingerprintStatus } from '../ssis/catalog.ts'

/** Where a source reads: server DMVs, the SSISDB catalog, or nothing (a test source that touches no SQL Server). */
export type LiveScope = 'server' | 'ssisdb' | 'none'
export const liveUnits = ['perSecond', 'percent', 'ms', 'msPerSecond', 'bytesPerSecond', 'count'] as const
export type LiveUnit = typeof liveUnits[number]
/** A snapshot table is replaced by each sample (a new stored result, two revisions kept); an append table grows. */
export type LiveTableMode = 'snapshot' | 'append'

/** How the backend turns a series' raw value into what a sample carries (Live/LiveDeltas.cs): the value itself
 *  (gauge); a cumulative counter's change per second of the server's own clock (rate, msPerSecond); a counter's change
 *  over its base counter's change (ratio); or the schedulers' summed CPU milliseconds as a percentage of the elapsed
 *  time across them (cpuPercent). Every kind but gauge has no value until a second sample. */
export const liveCounters = ['gauge', 'rate', 'msPerSecond', 'ratio', 'cpuPercent'] as const
export type LiveCounter = typeof liveCounters[number]
export interface LiveSeriesSpec { readonly id: string; readonly unit: LiveUnit; readonly label: string; readonly counter: LiveCounter }
/** `id` names the column in requests (sort, filter); `name` and `dataType` are what the stored result's columns carry. */
export interface LiveColumnSpec { readonly id: string; readonly name: string; readonly dataType: string }
export interface LiveTableSpec {
  readonly id: string
  readonly mode: LiveTableMode
  readonly columns: readonly LiveColumnSpec[]
  /** The column ids whose cell texts, joined with U+001F, identify a row across revisions (tracked selection). */
  readonly key: readonly string[]
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
   *  VIEW SERVER STATE (earlier versions, Managed Instance); without it, it opens unavailable (PERMISSION_DENIED). */
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
  /** What a hidden view of this source does (the renderer's LiveService; the backend never reads it): pause every probe
   *  (the default), or, for a view that asks for it, keep its probes without tables at 30 s or slower so a completion is
   *  still seen (at most 4 such views a window). */
  readonly hidden?: 'pause' | 'statusOnly'
}

const column = (id: string, dataType: string): LiveColumnSpec => ({ id, name: id, dataType })
const anyInterval = { default: 1000, min: limits.live.intervalMs.min, max: limits.live.intervalMs.max }
/** A probe's statement budget and load guard when its entry names none. */
export const defaultBudgetMs = { min: limits.live.budgetMs.min, max: 5000 } as const
export const defaultDutyCycle = 0.25

export const liveSourceIds = ['debug.synthetic', 'activity', 'ssis.catalog'] as const
export type LiveSourceId = typeof liveSourceIds[number]
export const liveProbeIds = ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status', 'activity.overview', 'ssis.catalogProbe'] as const
export type LiveProbeId = typeof liveProbeIds[number]

export const liveSources: { readonly [S in LiveSourceId]: LiveSourceSpec } = {
  'debug.synthetic': {
    id: 'debug.synthetic', label: 'Synthetic', scope: 'none', testOnly: true, probes: ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status'],
    description: 'Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it.'
  },
  activity: {
    id: 'activity', label: 'Activity Monitor', scope: 'server', testOnly: false, probes: ['activity.overview'],
    description: 'SQL Server\'s own activity, read from server DMVs on the connection\'s " - Activity Monitor" pool (READ UNCOMMITTED, LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW).'
  },
  'ssis.catalog': {
    id: 'ssis.catalog', label: 'SSIS Catalog', scope: 'ssisdb', testOnly: false, probes: ['ssis.catalogProbe'],
    description: 'The SSIS Catalog\'s views, read on the connection\'s " - Integration Services" pool in the catalog\'s database, SSISDB (READ UNCOMMITTED, or READ COMMITTED when the catalog has READ_COMMITTED_SNAPSHOT on; LOCK_TIMEOUT 1000, DEADLOCK_PRIORITY LOW). Object Explorer holds one per connection while an SSISDB node is open. A catalog that no longer exists ends it (CATALOG_MISSING).'
  }
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
    tables: [{ id: 'rows', mode: 'snapshot', key: ['id'], columns: [column('id', 'int'), column('label', 'nvarchar'), column('value', 'int')] }]
  },
  'debug.synthetic.status': {
    id: 'debug.synthetic.status', source: 'debug.synthetic', label: 'Synthetic status', intervalMs: anyInterval,
    description: 'The phase (even or odd) and the sample count.', status: ['phase', 'samples']
  },
  'activity.overview': {
    id: 'activity.overview', source: 'activity', label: 'Overview', intervalMs: { default: 2000, min: 1000, max: limits.live.intervalMs.max },
    description: 'The server at a glance, in one DMV query: SQL Server\'s CPU (its schedulers\' non-preemptive time), runnable tasks, batch requests, compilations and re-compilations per second, and user sessions. Rates use the server\'s own clock (ms_ticks), and a restart starts them again.',
    maxDutyCycle: 0.2, gates: { minMajor: 13, editions: [1, 2, 3, 4, 8] }, permission: 'serverState',
    series: [
      { id: 'cpuPercent', unit: 'percent', label: 'SQL Server CPU (non-preemptive)', counter: 'cpuPercent' },
      { id: 'runnableTasks', unit: 'count', label: 'Runnable tasks', counter: 'gauge' },
      { id: 'batchRequests', unit: 'perSecond', label: 'Batch requests/sec', counter: 'rate' },
      { id: 'compilations', unit: 'perSecond', label: 'SQL compilations/sec', counter: 'rate' },
      { id: 'recompilations', unit: 'perSecond', label: 'SQL re-compilations/sec', counter: 'rate' },
      { id: 'userSessions', unit: 'count', label: 'User sessions', counter: 'gauge' }
    ]
  },
  'ssis.catalogProbe': {
    id: 'ssis.catalogProbe', source: 'ssis.catalog', label: 'Catalog changes', intervalMs: { default: 30_000, min: 10_000, max: 300_000 }, budgetMs: { min: 500, max: 10_000 },
    description: 'A fingerprint of each catalog view the SSIS tree and its documents show, in one query: its row count and a checksum of the columns they show (catalogFingerprints in src/shared/ssis/catalog.ts), over the rows row-level security lets the login see. Object Explorer reloads only what changed, keeping expansion and selection.',
    status: catalogFingerprintStatus
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

/** The catalogue as the backend embeds it, keys sorted: sources and probes in catalogue order, and the live limits. */
export function liveCatalogJson(): string {
  const probes = liveProbeIds.map(id => {
    const spec = liveProbes[id]
    return {
      ...spec, series: spec.series ?? [], tables: spec.tables ?? [], status: spec.status ?? [], views: spec.views ?? [], filterMode: spec.filterMode ?? 'none',
      budgetMs: spec.budgetMs ?? defaultBudgetMs, minGapMs: spec.minGapMs ?? 0, maxDutyCycle: spec.maxDutyCycle ?? defaultDutyCycle, gates: spec.gates ?? null, permission: spec.permission ?? 'none'
    }
  })
  return [
    '{',
    `  "limits": ${line({ ...limits.live, eventBody: limits.eventBody })},`,
    `  "probes": ${block(probes)},`,
    `  "sources": ${block(liveSourceIds.map(id => { const { hidden: _renderer, ...source } = liveSources[id]; return source }))},`,
    '  "version": 1',
    '}',
    ''
  ].join('\n')
}
