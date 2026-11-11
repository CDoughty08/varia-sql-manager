import type { ReactNode, WheelEvent } from 'react'
import type { IconId } from '../../../shared/icons'
import Icon from '../Icon'
import { formatCount } from '../results/status'

interface ChipProps {
  readonly label: string
  readonly pressed: boolean
  readonly onToggle: () => void
  /** How many rows the filter matches, drawn after the label and part of its name ("Blocked 3"). */
  readonly count?: number
  /** An icon shown before the label, such as `lock` for Blocked. */
  readonly icon?: IconId
  readonly disabled?: boolean
  readonly title?: string
}

/** A filter toggle (`aria-pressed`): on, it is filled, outlined in the accent and checked, so the state is not color alone. */
export function Chip({ label, pressed, onToggle, count, icon, disabled, title }: ChipProps) {
  return <button type="button" className="chip" aria-pressed={pressed} disabled={disabled} title={title} onClick={onToggle}>
    {pressed && <Icon name="check" />}
    {icon && <Icon name={icon} />}
    <span>{label}</span>
    {count !== undefined && <span className="chip-count">{formatCount(count)}</span>}
  </button>
}

/** A labelled row of chips; each chip is its own button and tab stop, as a row of toggle buttons is. `dense` chips fit a
 *  pane's toolbar: shorter than its other controls, on one line. A `scroll` row gives way in a narrow toolbar rather than
 *  wrapping it: it scrolls sideways (the wheel too), its last chip cut at the edge, and a focused chip scrolls into view. */
export function ChipGroup({ label, dense, scroll, children }: { readonly label: string; readonly dense?: boolean; readonly scroll?: boolean; readonly children: ReactNode }) {
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    const row = event.currentTarget
    if (row.scrollWidth > row.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) row.scrollLeft += event.deltaY
  }
  return <div className={'chip-group' + (dense ? ' dense' : '') + (scroll ? ' scroll' : '')} role="group" aria-label={label} onWheel={scroll ? wheel : undefined}>{children}</div>
}
