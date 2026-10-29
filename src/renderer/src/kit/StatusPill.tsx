import type { IconId } from '../../../shared/icons'
import type { StatusTone } from '../../../shared/theme/tones'
import Icon from '../Icon'

/** The glyph a state pill shows unless told otherwise; `loading` turns (Monaco's codicon rule) and stops under reduced motion. */
export const toneIcons: Readonly<Record<StatusTone, IconId | undefined>> = {
  running: 'loading', success: 'pass', warning: 'warning', critical: 'error', info: 'info', neutral: undefined
}

interface Props {
  readonly tone: StatusTone
  /** The word that says the state ("Running · 3:42", "RESTORING 42 %", "PROD"); the color only repeats it. */
  readonly label: string
  /** The part of the label that must survive a narrow pill (a percentage, a count), at its start or end: it never gives
   *  way, and the rest of the label ends in an ellipsis beside it ("RESTOR… 42 %"). Ignored unless the label starts or
   *  ends with it. */
  readonly value?: string
  /** An icon from the registry, `null` for none; by default a state pill shows its tone's glyph and a tag none. */
  readonly icon?: IconId | null
  /** `tag` is the squarer environment label (PROD, Staging); `pill` a state. */
  readonly variant?: 'pill' | 'tag'
  /** `small` fits 22 px rows, tabs and the status bar. */
  readonly size?: 'regular' | 'small'
  /** A longer explanation, as the tooltip. */
  readonly title?: string
}

/** A state or an environment as a compact chip of color, glyph and word: Object Explorer nodes, tabs, headers, grids. */
export default function StatusPill({ tone, label, value, icon, variant = 'pill', size = 'regular', title }: Props) {
  const glyph = icon === undefined ? variant === 'pill' ? toneIcons[tone] : undefined : icon ?? undefined
  const classes = ['status-pill', variant === 'tag' && 'tag', size === 'small' && 'small'].filter(Boolean).join(' ')
  // The split keeps the label's own spaces, so the pill's text is still the whole label.
  const at = value && value !== label ? label.endsWith(value) ? 'end' : label.startsWith(value) ? 'start' : undefined : undefined
  const rest = at === 'end' ? label.slice(0, label.length - value!.length) : at === 'start' ? label.slice(value!.length) : label
  return <span className={classes} data-tone={tone} title={title}>
    {glyph && <Icon name={glyph} />}
    {at === 'start' && <span className="status-pill-value">{value}</span>}
    <span className="status-pill-label">{rest}</span>
    {at === 'end' && <span className="status-pill-value">{value}</span>}
  </span>
}
