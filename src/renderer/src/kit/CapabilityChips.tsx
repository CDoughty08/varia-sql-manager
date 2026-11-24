import { useState } from 'react'

export interface CapabilityItem {
  readonly id: string
  readonly label: string
  readonly value?: string
  /** Notable capabilities show by default; remaining items appear when expanded to All. */
  readonly notable: boolean
  readonly tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'error'
  readonly title?: string
}

export interface CapabilityChipsProps {
  readonly items: readonly CapabilityItem[]
  readonly label?: string
  readonly empty?: string
  readonly showAll?: boolean
  readonly onShowAllChange?: (showAll: boolean) => void
  readonly className?: string
}

/**
 * Signal-first capability pills: displays notable flags by default with a `Notable (n/m) ↔ All` toggle button to reveal
 * every capability without overwhelming the Overview tab.
 */
export default function CapabilityChips({ items, label = 'Capabilities', empty = 'No notable capabilities.', showAll, onShowAllChange, className }: CapabilityChipsProps) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const expanded = showAll ?? uncontrolled
  const notable = items.filter(item => item.notable)
  const hasToggle = items.length > notable.length
  const shown = expanded ? items : notable

  const toggle = () => {
    const next = !expanded
    if (showAll === undefined) setUncontrolled(next)
    onShowAllChange?.(next)
  }

  return <div className={['cap-chips-block', className].filter(Boolean).join(' ')}>
    <div className="cap-chips-row">
      {shown.length > 0 ? <ul className="cap-chips" aria-label={label}>
        {shown.map(item => (
          <li key={item.id} className={item.notable ? 'cap-chip on' : 'cap-chip'} data-tone={item.tone} title={item.title}>
            <span className="cap-chip-label">{item.label}</span>
            {item.value !== undefined && <span className="cap-chip-value">{item.value}</span>}
          </li>
        ))}
      </ul> : <span className="cap-chips-empty">{empty}</span>}
      {hasToggle && <button type="button" className="cap-chips-toggle" aria-pressed={expanded}
        aria-label={expanded ? `Showing all ${items.length} capabilities; switch to ${notable.length} notable` : `Showing ${notable.length} of ${items.length} notable capabilities; show all`}
        title={expanded ? 'Show notable capabilities only' : 'Show all capabilities'}
        onClick={toggle}>
        {expanded ? `All (${items.length})` : `Notable (${notable.length}/${items.length})`}
      </button>}
    </div>
  </div>
}
