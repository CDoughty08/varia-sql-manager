import type { ReactNode, Ref } from 'react'
import type { IconId } from '../../../shared/icons'
import Icon from '../Icon'

export interface EmptyAction {
  readonly label: string
  readonly run: () => void
  /** The one action most people take next; at most one per empty state. */
  readonly primary?: boolean
  readonly disabled?: boolean
  readonly buttonRef?: Ref<HTMLButtonElement>
}

interface Props {
  /** An icon from the registry, drawn at 16 px as decoration. */
  readonly icon?: IconId
  readonly title?: string
  /** One line saying what fills the view, or why it is empty. */
  readonly detail?: ReactNode
  readonly actions?: readonly EmptyAction[]
  /** An extra class for the surface's own placement. */
  readonly className?: string
}

/** One empty view for every surface: a glyph, a 13 px title, one 12 px line and its actions. */
export default function EmptyState({ icon, title, detail, actions = [], className }: Props) {
  // Only the first action marked primary is filled, so a view never offers two equal calls to action.
  const primary = actions.findIndex(action => action.primary)
  return <div className={className ? `empty-state ${className}` : 'empty-state'}>
    {icon && <Icon name={icon} className="empty-state-icon" />}
    {title && <p className="empty-state-title">{title}</p>}
    {detail !== undefined && <p className="empty-state-detail">{detail}</p>}
    {actions.length > 0 && <div className="empty-state-actions">
      {actions.map((action, index) => <button key={action.label} type="button" ref={action.buttonRef} className={index === primary ? 'primary' : undefined} disabled={action.disabled} onClick={action.run}>{action.label}</button>)}
    </div>}
  </div>
}
