export type ChartSeries = 1 | 2 | 3 | 4 | 5

export interface RatioSegment {
  readonly id: string
  readonly label: string
  /** Numeric share (bytes, count, etc.); non-finite or non-positive values count as 0. */
  readonly value: number
  /** Formatted display value shown in the legend ("124 MB", "96%"). */
  readonly displayValue?: string
  /** Chart series token 1..5 (--varia-charts-blue, orange, green, yellow, purple); defaults by position. */
  readonly series?: ChartSeries
}

export interface RatioBarProps {
  readonly title?: string
  readonly totalLabel?: string
  readonly segments: readonly RatioSegment[]
  /** Flat layout for Vitals rail / nested cards: removes outer box border, padding and background. */
  readonly flat?: boolean
  /** Inline compact proportion bar for Hero KPI strips: renders the track only, without header or legend. */
  readonly mini?: boolean
  readonly ariaLabel?: string
  readonly className?: string
}

/** Computes each segment's percentage share (0..100), clamping invalid or negative inputs to 0. */
export function ratioShares(segments: readonly Pick<RatioSegment, 'value'>[]): number[] {
  const safe = segments.map(segment => Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0)
  const total = safe.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return safe.map(() => 0)
  return safe.map(value => (value / total) * 100)
}

function seriesOf(segment: RatioSegment, index: number): ChartSeries {
  return segment.series ?? (((index % 5) + 1) as ChartSeries)
}

/**
 * Proportion meter using Varia's five chart series theme tokens (`--varia-charts-blue`, `orange`, `green`, `yellow`,
 * `purple`). Renders as a bordered block in flow views, `flat` inside Vitals rails (no box-in-box chrome), or `mini`
 * inline inside a Hero KPI strip.
 */
export default function RatioBar({ title, totalLabel, segments, flat = false, mini = false, ariaLabel, className }: RatioBarProps) {
  const shares = ratioShares(segments)
  const summary = ariaLabel ?? [
    title,
    totalLabel,
    segments.map((segment, index) => `${segment.label} ${segment.displayValue ?? `${Math.round(shares[index])}%`}`).join(', ')
  ].filter(Boolean).join(': ')

  if (mini) {
    return <span className={['ratio-bar-mini', className].filter(Boolean).join(' ')} role="img" aria-label={summary}>
      {segments.map((segment, index) => shares[index] > 0 && (
        <span key={segment.id} className="ratio-bar-seg" data-series={seriesOf(segment, index)} style={{ width: `${shares[index]}%` }} />
      ))}
    </span>
  }

  return <div className={['ratio-bar', flat && 'flat', className].filter(Boolean).join(' ')} role="group" aria-label={summary}>
    {(title || totalLabel) && <div className="ratio-bar-top">
      {title && <span className="ratio-bar-title">{title}</span>}
      {totalLabel && <span className="ratio-bar-total">{totalLabel}</span>}
    </div>}
    <div className="ratio-bar-track" aria-hidden="true">
      {segments.map((segment, index) => shares[index] > 0 && (
        <span key={segment.id} className="ratio-bar-seg" data-series={seriesOf(segment, index)} style={{ width: `${shares[index]}%` }} />
      ))}
    </div>
    {segments.length > 0 && <div className="ratio-bar-legend">
      {segments.map((segment, index) => (
        <span key={segment.id} className="ratio-bar-legend-item">
          <span className="ratio-bar-swatch" data-series={seriesOf(segment, index)} aria-hidden="true" />
          <span className="ratio-bar-legend-label">{segment.label}</span>
          <strong className="ratio-bar-legend-value">{segment.displayValue ?? `${Math.round(shares[index])}%`}</strong>
        </span>
      ))}
    </div>}
  </div>
}
