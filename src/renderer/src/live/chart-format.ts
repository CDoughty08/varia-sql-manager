// The words and numbers a chart shows (ChartView): values with their units, nice scale maxima, times on the crosshair,
// and the sentence its accessible name carries. Pure, so the tests pin every string.
import type { LiveUnit } from '../../../shared/live/catalog'

const grouped = (value: number, digits: number) => value.toLocaleString('en-US', { maximumFractionDigits: digits })
/** Large numbers whole and grouped, small ones with one or two decimals: "1,234", "12.5", "0.25". */
export function formatNumber(value: number): string {
  const size = Math.abs(value)
  return grouped(value, size >= 100 ? 0 : size >= 1 ? 1 : 2)
}

const byteUnits = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']
/** Bytes a second in powers of 1,024 (the status bar's megabytes): "13.1 MB/s". */
function formatRate(bytes: number): string {
  let value = bytes, unit = 0
  while (Math.abs(value) >= 1024 && unit < byteUnits.length - 1) { value /= 1024; unit++ }
  return `${formatNumber(value)} ${byteUnits[unit]}`
}

/** A value as a chart labels it: "93 %", "1,234/s", "12 ms", "2,840 ms/s", "13.1 MB/s", "84". Missing values say so. */
export function formatChartValue(value: number, unit: LiveUnit): string {
  if (!Number.isFinite(value)) return 'no value'
  switch (unit) {
    case 'percent': return `${formatNumber(value)} %`
    case 'perSecond': return `${formatNumber(value)}/s`
    case 'ms': return `${formatNumber(value)} ms`
    case 'msPerSecond': return `${formatNumber(value)} ms/s`
    case 'bytesPerSecond': return formatRate(value)
    case 'count': return formatNumber(value)
  }
}

/** The smallest of 1, 2, 2.5, 5 times a power of ten at or above `value`, so a scale's top line reads as a round number;
 *  1 for nothing to show. */
export function niceCeiling(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value * (1 - 1e-12)) return step * power
  return 10 * power
}

/** How long ago a sample was, as the crosshair says it: "now", "0:45 ago", "4:10 ago", "1:02:05 ago". */
export function formatAgo(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000)
  if (seconds === 0) return 'now'
  const pad = (part: number) => String(part).padStart(2, '0')
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)} ago` : `${minutes}:${pad(seconds % 60)} ago`
}

/** A sample's local clock time: "22:41:07". */
export function formatClock(time: number): string {
  const date = new Date(time), pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** A window's length in words: "45 seconds", "1 minute", "15 minutes", "1 hour", "1.5 hours". */
export function formatSpan(ms: number): string {
  const unit = (value: number, noun: string) => `${formatNumber(value)} ${noun}${value === 1 ? '' : 's'}`
  if (ms < 60_000) return unit(Math.round(ms / 1000), 'second')
  if (ms < 3_600_000) return unit(Math.round(ms / 6000) / 10, 'minute')
  return unit(Math.round(ms / 360_000) / 10, 'hour')
}

/** A short span for an axis: "45 s", "15 min", "1 h", "1.5 h". */
export function formatSpanShort(ms: number): string {
  if (ms < 60_000) return `${formatNumber(Math.round(ms / 1000))} s`
  if (ms < 3_600_000) return `${formatNumber(Math.round(ms / 6000) / 10)} min`
  return `${formatNumber(Math.round(ms / 360_000) / 10)} h`
}

export interface SeriesSummary { readonly label: string; readonly latest: number; readonly min: number; readonly max: number }
/** The chart's accessible name: "SQL Server CPU: 12 %, 3 % to 40 % over the last 5 minutes", one clause per series. */
export function chartLabel(title: string, unit: LiveUnit, spanMs: number, series: readonly SeriesSummary[]): string {
  const known = series.filter(entry => Number.isFinite(entry.min))
  if (!known.length) return `${title}: no data yet`
  const over = ` over the last ${formatSpan(spanMs)}`
  const clause = (entry: SeriesSummary) => {
    const now = Number.isFinite(entry.latest) ? formatChartValue(entry.latest, unit) : 'no current value'
    const range = entry.min === entry.max ? `steady at ${formatChartValue(entry.min, unit)}` : `${formatChartValue(entry.min, unit)} to ${formatChartValue(entry.max, unit)}`
    return `${series.length > 1 ? entry.label + ' ' : ''}${now}, ${range}`
  }
  return `${title}: ${known.map(clause).join('; ')}${over}`
}
