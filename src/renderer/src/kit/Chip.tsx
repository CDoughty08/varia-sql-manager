import type { ReactNode } from 'react'
import { formatCount } from '../results/status'

interface ChipProps {
  readonly label: string
  readonly pressed: boolean
  readonly onToggle: () => void
  /** How many rows the filter matches, drawn after the label and part of its name ("Blocked 3"). */
  readonly count?: number
  /** A codicon name shown before the label, such as `lock` for Blocked. */
  readonly icon?: string
  readonly disabled?: boolean
  readonly title?: string
}

/** A filter toggle (`aria-pressed`): on, it is filled, outlined in the accent and checked, so the state is not color alone. */
export function Chip({ label, pressed, onToggle, count, icon, disabled, title }: ChipProps) {
  return <button type="button" className="chip" aria-pressed={pressed} disabled={disabled} title={title} onClick={onToggle}>
    {pressed && <span className="codicon codicon-check" aria-hidden="true" />}
    {icon && <span className={`codicon codicon-${icon}`} aria-hidden="true" />}
    <span>{label}</span>
    {count !== undefined && <span className="chip-count">{formatCount(count)}</span>}
  </button>
}

/** A labelled row of chips; each chip is its own button and tab stop, as a row of toggle buttons is. */
export function ChipGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div className="chip-group" role="group" aria-label={label}>{children}</div>
}
