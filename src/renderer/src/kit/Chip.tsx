import type { ReactNode } from 'react'
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
 *  pane's toolbar: shorter than its other controls, on one line. */
export function ChipGroup({ label, dense, children }: { readonly label: string; readonly dense?: boolean; readonly children: ReactNode }) {
  return <div className={dense ? 'chip-group dense' : 'chip-group'} role="group" aria-label={label}>{children}</div>
}
