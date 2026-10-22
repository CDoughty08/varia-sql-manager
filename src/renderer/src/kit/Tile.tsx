import type { ReactNode } from 'react'
import type { TileTone } from '../../../shared/theme/tones'

interface Props {
  /** What the number is, as SSMS names it ("% Processor Time", "Waiting Tasks"). */
  readonly caption: string
  /** The headline value, already formatted; undefined before the first sample. */
  readonly value?: string
  readonly unit?: string
  /** One line of context under the value ("avg 18 % · peak 63 %"). */
  readonly context?: string
  /** Set when the value crossed a threshold: the outline takes the tone and the caption a glyph. */
  readonly tone?: TileTone
  /** The sparkline or chart slot (L4's ChartView). */
  readonly children?: ReactNode
}

const toneGlyphs: Readonly<Record<TileTone, string>> = { warning: 'warning', critical: 'error' }
const toneWords: Readonly<Record<TileTone, string>> = { warning: 'above its warning threshold', critical: 'above its critical threshold' }

/** The accessible name: "Waiting Tasks: 12, avg 4, above its warning threshold", or "…: no data yet". */
export function tileName({ caption, value, unit, context, tone }: Omit<Props, 'children'>): string {
  const reading = value === undefined ? 'no data yet' : unit ? `${value} ${unit}` : value
  return [`${caption}: ${reading}`, context, tone && toneWords[tone]].filter(Boolean).join(', ')
}

/** A metric tile: caption, headline value and unit, a context line and a chart slot, outlined in its tone past a threshold. */
export default function Tile(props: Props) {
  const { caption, value, unit, context, tone, children } = props
  return <div className="tile" role="group" aria-label={tileName(props)} data-tone={tone}>
    <div className="tile-caption" aria-hidden="true">
      {tone && <span className={`codicon codicon-${toneGlyphs[tone]}`} />}
      <span className="tile-caption-text">{caption}</span>
    </div>
    <p className="tile-value" aria-hidden="true">{value ?? '—'}{value !== undefined && unit && <span className="tile-unit">{unit}</span>}</p>
    {context && <div className="tile-context" aria-hidden="true">{context}</div>}
    {children && <div className="tile-chart">{children}</div>}
  </div>
}
