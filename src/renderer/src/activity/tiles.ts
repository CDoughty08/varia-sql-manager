// What the Activity Monitor's tiles and charts show, from the overview probe's ring (docs/activity-monitor.md, Tiles):
// each tile's value in its own unit, its secondary figures, and the threshold it has crossed. Pure, so the words and
// tones are tested once; the view only draws them.
import { activityEditions, seriesSpecs, tileSpecs, unavailableMessage, type SeriesSpec, type ThresholdSpec, type TileSpec } from '../../../shared/activity/catalog'
import { liveProbes, type LiveUnit } from '../../../shared/live/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { TileTone } from '../../../shared/theme/tones'
import type { ChartScale } from '../live/ChartView'
import { formatNumber } from '../live/chart-format'
import type { LiveSnapshot } from '../live/LiveService'
import type { RingReader } from '../live/ring'

export const overviewProbe = 'activity.overview' as const
const overviewIds: readonly string[] = (liveProbes[overviewProbe].series ?? []).map(series => series.id)
/** A series' place in the overview's ring (the live catalogue's order), or -1. */
export const seriesIndex = (id: string): number => overviewIds.indexOf(id)

/** The newest sample's value of a series, times its scale (bytes a second as MB/s); NaN without one (a rate's first sample). */
export function latestValue(ring: RingReader | undefined, id: string): number {
  const index = seriesIndex(id)
  if (!ring || ring.length === 0 || index < 0) return Number.NaN
  return ring.value(ring.length - 1, index) * (seriesSpecs[id]?.scale ?? 1)
}

// A unit as it follows a number: "34 %", "12 ms", "950/s"; counts and tasks need no word.
const unitText: Readonly<Record<SeriesSpec['unit'], string>> = {
  '': '', id: '', count: '', tasks: 'tasks', 'per scheduler': 'per scheduler', ms: 'ms', 'ms/s': 'ms/s', s: 's', KB: 'KB', MB: 'MB', 'MB/s': 'MB/s', '/s': '/s', '/min': '/min', '%': '%'
}
/** A value as a tile shows it, NaN as undefined (the tile then shows a dash). */
export function formatTileValue(value: number): string | undefined {
  return Number.isFinite(value) ? formatNumber(value) : undefined
}
const withUnit = (value: string, unit: string) => !unit ? value : unit.startsWith('/') ? value + unit : `${value} ${unit}`

/** A threshold's bounds, from its settings where it has them (in the series' unit), else the catalogue's. */
export function thresholdBounds(spec: ThresholdSpec, settings: Partial<SettingsValues>): { readonly warning?: number; readonly error?: number } {
  const scale = spec.settingScale ?? 1
  const setting = (key: string | undefined, fallback: number | undefined) => {
    const value = key === undefined ? undefined : (settings as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? value * scale : fallback
  }
  return { warning: setting(spec.settings?.warning, spec.warning), error: setting(spec.settings?.error, spec.error) }
}
/** The worst threshold the tile's values cross now: a bound is reached at or above it, and a threshold with `while` counts
 *  only while that series is above zero (the longest block, while sessions are blocked). */
export function tileTone(tile: TileSpec, value: (id: string) => number, settings: Partial<SettingsValues>): TileTone | undefined {
  let tone: TileTone | undefined
  for (const spec of tile.thresholds) {
    if (spec.while !== undefined && !(value(spec.while) > 0)) continue
    const current = value(spec.series), { warning, error } = thresholdBounds(spec, settings)
    if (!Number.isFinite(current)) continue
    if (error !== undefined && current >= error) return 'critical'
    if (warning !== undefined && current >= warning) tone = 'warning'
  }
  return tone
}

export interface TileReading {
  readonly caption: string
  readonly value?: string
  readonly unit: string
  /** The secondary figures: "Scheduler delay 12 ms/s", "Read latency 3 ms · Write latency 5 ms". */
  readonly context?: string
  readonly tone?: TileTone
}
/** A tile as it reads now. */
export function tileReading(tile: TileSpec, ring: RingReader | undefined, settings: Partial<SettingsValues>): TileReading {
  const value = (id: string) => latestValue(ring, id)
  const main = seriesSpecs[tile.series]!
  const secondary = tile.secondary.flatMap(id => {
    const spec = seriesSpecs[id]!, text = formatTileValue(value(id))
    return text === undefined ? [] : [`${spec.label} ${withUnit(text, unitText[spec.unit])}`]
  })
  const reading = formatTileValue(value(tile.series)), tone = tileTone(tile, value, settings)
  return { caption: tile.caption, unit: unitText[main.unit], ...reading !== undefined ? { value: reading } : {}, ...secondary.length ? { context: secondary.join(' · ') } : {}, ...tone ? { tone } : {} }
}
export const tileReadings = (ring: RingReader | undefined, settings: Partial<SettingsValues>): TileReading[] => tileSpecs.map(tile => tileReading(tile, ring, settings))

const toneWords: Readonly<Record<TileTone, string>> = { warning: 'above its warning threshold', critical: 'above its critical threshold' }
/** What the live region says when a tile crosses a threshold upward; nothing when it calms down or stays. */
export function toneAnnouncement(caption: string, before: TileTone | undefined, after: TileTone | undefined): string | undefined {
  const rank = (tone: TileTone | undefined) => tone === 'critical' ? 2 : tone === 'warning' ? 1 : 0
  return after && rank(after) > rank(before) ? `${caption} is ${toneWords[after]}.` : undefined
}
/** What the tiles say when their tones move from `before` to `readings`: each upward crossing, in tile order. */
export function crossings(before: readonly (TileTone | undefined)[], readings: readonly Pick<TileReading, 'caption' | 'tone'>[]): string | undefined {
  const said = readings.flatMap((reading, index) => toneAnnouncement(reading.caption, before[index], reading.tone) ?? [])
  return said.length ? said.join(' ') : undefined
}

/**
 * How a tile's series is charted: the live unit it is sent in, except where the tile shows another unit the chart's labels
 * cannot say (wait milliseconds per second shown as tasks), which charts read through a scaled view of the ring. CPU is
 * a percentage of the schedulers, so its axis stops at 100.
 */
export function chartScaleOf(id: string): { readonly scale: ChartScale; readonly factor: number } {
  const spec = seriesSpecs[id]!
  const unit: LiveUnit = spec.unit === 'tasks' ? 'count' : spec.liveUnit
  const factor = spec.unit === 'tasks' ? spec.scale ?? 1 : 1
  return { scale: { unit, ...spec.unit === '%' ? { max: 100 } : {} }, factor }
}

/**
 * What the document says about the overview, above the tiles (never a modal): the login lacks the server-state permission
 * (the probe opened unavailable, or found out later and stopped for good), the server is of a kind the monitor does not
 * cover, or the last sample failed (the tiles keep the last good values, the probe retries by itself, and this says why).
 * Nothing while the view is not running: the pill and the lost or ended banner speak for it then.
 */
export type OverviewNotice =
  | { readonly kind: 'permission' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'failing'; readonly code: string; readonly message: string }
export function overviewNotice(snapshot: LiveSnapshot): OverviewNotice | undefined {
  const probe = snapshot.probes[overviewProbe]
  if (!probe) return undefined
  if (probe.state === 'unavailable') return probe.reason === 'PERMISSION_DENIED' ? { kind: 'permission' } : { kind: 'unavailable', message: probe.reason === 'NOT_SUPPORTED' ? unavailableMessage : probe.note ?? unavailableMessage }
  if (probe.error?.code === 'PERMISSION_DENIED' && probe.error.terminal) return { kind: 'permission' }
  if (probe.state === 'failing' && probe.error) return { kind: 'failing', code: probe.error.code, message: probe.error.message }
  return undefined
}

/**
 * The one message the document shows above the tiles: the backend went away, the server disconnected, the view ended with
 * an error, or the overview's notice while the view runs. An end whose cause outlasts a Retry reads as the running view
 * would: a server none of whose probes can run (AM1 ends it NOT_SUPPORTED) is not offered a Retry that can never succeed,
 * and a login without the permission gets the permission message, whose Retry helps once the GRANT has been run.
 */
export type MonitorNotice =
  | OverviewNotice
  | { readonly kind: 'lost'; readonly code?: string; readonly message?: string }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'ended'; readonly code: string; readonly message: string }
export function monitorNotice(snapshot: LiveSnapshot): MonitorNotice | undefined {
  if (snapshot.status === 'lost') return { kind: 'lost', ...snapshot.error ? { code: snapshot.error.code, message: snapshot.error.message } : {} }
  if (snapshot.status === 'ended') {
    if (snapshot.ended?.ended === 'disconnected') return { kind: 'disconnected' }
    const error = snapshot.error
    if (!error) return undefined
    if (error.code === 'NOT_SUPPORTED') return { kind: 'unavailable', message: unavailableMessage }
    if (error.code === 'PERMISSION_DENIED') return { kind: 'permission' }
    return { kind: 'ended', code: error.code, message: error.message }
  }
  return snapshot.status === 'live' || snapshot.status === 'connecting' ? overviewNotice(snapshot) : undefined
}

/** A live region's sentence with its own id: the same sentence again is a new node, which screen readers speak again. */
export interface Announcement { readonly id: number; readonly text: string }
export const nextAnnouncement = (previous: Announcement | undefined, text: string): Announcement => ({ id: (previous?.id ?? 0) + 1, text })

/** The header's fact line: what the connection says about the server, and nothing a probe has not produced. */
export function monitorFacts(connection: { readonly server: string; readonly productVersion?: string; readonly serverVersion?: string; readonly engineEdition?: number; readonly login?: string } | undefined): { label: string; value: string }[] {
  if (!connection) return []
  const version = connection.productVersion || connection.serverVersion
  return [
    { label: 'Server', value: connection.server },
    ...version ? [{ label: 'Version', value: version }] : [],
    // A box's engine edition (Enterprise, Developer and Evaluation are one value) says too little to name; Managed Instance's says what it is.
    ...(activityEditions.managedInstance.editions as readonly number[]).includes(connection.engineEdition ?? -1) ? [{ label: 'Kind', value: activityEditions.managedInstance.label }] : [],
    ...connection.login ? [{ label: 'Login', value: connection.login }] : []
  ]
}
