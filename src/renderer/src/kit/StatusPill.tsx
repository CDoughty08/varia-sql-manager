import type { StatusTone } from '../../../shared/theme/tones'

/** The glyph a state pill shows unless told otherwise; `loading` turns (Monaco's codicon rule) and stops under reduced motion. */
export const toneIcons: Readonly<Record<StatusTone, string | undefined>> = {
  running: 'loading', success: 'pass', warning: 'warning', critical: 'error', info: 'info', neutral: undefined
}

interface Props {
  readonly tone: StatusTone
  /** The word that says the state ("Running · 3:42", "RESTORING 42 %", "PROD"); the color only repeats it. */
  readonly label: string
  /** A codicon name, `null` for none; by default a state pill shows its tone's glyph and a tag none. */
  readonly icon?: string | null
  /** `tag` is the squarer environment label (PROD, Staging); `pill` a state. */
  readonly variant?: 'pill' | 'tag'
  /** `small` fits 22 px rows, tabs and the status bar. */
  readonly size?: 'regular' | 'small'
  /** A longer explanation, as the tooltip. */
  readonly title?: string
}

/** A state or an environment as a compact chip of color, glyph and word: Object Explorer nodes, tabs, headers, grids. */
export default function StatusPill({ tone, label, icon, variant = 'pill', size = 'regular', title }: Props) {
  const glyph = icon === undefined ? variant === 'pill' ? toneIcons[tone] : undefined : icon ?? undefined
  const classes = ['status-pill', variant === 'tag' && 'tag', size === 'small' && 'small'].filter(Boolean).join(' ')
  return <span className={classes} data-tone={tone} title={title}>
    {glyph && <span className={`codicon codicon-${glyph}`} aria-hidden="true" />}
    <span className="status-pill-label">{label}</span>
  </span>
}
