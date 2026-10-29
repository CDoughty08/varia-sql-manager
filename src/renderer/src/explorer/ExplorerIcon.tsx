import { memo } from 'react'
import { statusBadges, type ExplorerIcon as IconName } from '../../../shared/explorer/catalog.ts'
import { codiconClass, type CodiconId } from '../../../shared/icons'
import Icon from '../Icon'

/** The mark at an icon's bottom right: a node's status, a failed or slow load, or a lost connection. */
export type BadgeName = keyof typeof statusBadges | 'lost'
const badgeIcons: Readonly<Record<BadgeName, CodiconId>> = { ...statusBadges, lost: 'debug-disconnect' }

/** A node's icon from the registry; folders take the folder colour. */
function ExplorerIcon({ name, folder, badge }: { name: IconName; folder?: boolean; badge?: BadgeName }) {
  const mark = badge && badgeIcons[badge]
  return <span className={`oe-icon${folder ? ' folder' : ''}`} aria-hidden="true">
    <Icon name={name} />{mark && <span className={`oe-badge ${codiconClass(mark)}`} data-badge={badge} />}
  </span>
}

export default memo(ExplorerIcon)
