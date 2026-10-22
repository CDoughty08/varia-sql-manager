// Live data (docs/ipc.md, Live subscriptions): the sources a `live.subscribe` names, the probes each one runs, and what
// every probe emits (series, tables, status values). It is the only declaration of them: the port schemas
// (src/shared/live/schema.ts), docs/live.md and the backend read it, the backend through liveCatalogJson() embedded as
// Live/live-catalog.json (a vitest file snapshot keeps that copy in sync). Erasable TypeScript (no enums), so Node's
// type stripping can load it as well.
import { limits } from '../ipc/wire/protocol.ts'

/** Where a source reads: server DMVs, the SSISDB catalog, or nothing (a test source that touches no SQL Server). */
export type LiveScope = 'server' | 'ssisdb' | 'none'
export const liveUnits = ['perSecond', 'percent', 'ms', 'msPerSecond', 'bytesPerSecond', 'count'] as const
export type LiveUnit = typeof liveUnits[number]
/** A snapshot table is replaced by each sample (a new stored result, two revisions kept); an append table grows. */
export type LiveTableMode = 'snapshot' | 'append'

export interface LiveSeriesSpec { readonly id: string; readonly unit: LiveUnit; readonly label: string }
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

export const liveSourceIds = ['debug.synthetic'] as const
export type LiveSourceId = typeof liveSourceIds[number]
export const liveProbeIds = ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status'] as const
export type LiveProbeId = typeof liveProbeIds[number]

export const liveSources: { readonly [S in LiveSourceId]: LiveSourceSpec } = {
  'debug.synthetic': {
    id: 'debug.synthetic', label: 'Synthetic', scope: 'none', testOnly: true, probes: ['debug.synthetic.metrics', 'debug.synthetic.table', 'debug.synthetic.status'],
    description: 'Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it.'
  }
}

export const liveProbes: { readonly [P in LiveProbeId]: LiveProbeSpec } = {
  'debug.synthetic.metrics': {
    id: 'debug.synthetic.metrics', source: 'debug.synthetic', label: 'Synthetic metrics', intervalMs: anyInterval,
    description: 'Three series: the sample number, a wave between 0 and 100, and a rate that follows it.',
    series: [{ id: 'counter', unit: 'count', label: 'Samples' }, { id: 'wave', unit: 'percent', label: 'Wave' }, { id: 'rate', unit: 'perSecond', label: 'Rate' }]
  },
  'debug.synthetic.table': {
    id: 'debug.synthetic.table', source: 'debug.synthetic', label: 'Synthetic rows', intervalMs: anyInterval,
    description: 'A snapshot table whose rows move on by one id per sample, so rows leave at the top and arrive at the bottom.',
    tables: [{ id: 'rows', mode: 'snapshot', key: ['id'], columns: [column('id', 'int'), column('label', 'nvarchar'), column('value', 'int')] }]
  },
  'debug.synthetic.status': {
    id: 'debug.synthetic.status', source: 'debug.synthetic', label: 'Synthetic status', intervalMs: anyInterval,
    description: 'The phase (even or odd) and the sample count.', status: ['phase', 'samples']
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
    return { ...spec, series: spec.series ?? [], tables: spec.tables ?? [], status: spec.status ?? [], views: spec.views ?? [], filterMode: spec.filterMode ?? 'none' }
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
