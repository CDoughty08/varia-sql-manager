import { memo } from 'react'
import { statusBadges, type ExplorerIcon as IconName } from '../../../shared/explorer/catalog.ts'
import Icon from '../Icon'

/** The 8×8 mark at an icon's bottom right: a node's status, a failed or slow load, or a lost connection. */
export type BadgeName = keyof typeof statusBadges | 'lost'
const badgeIcons: Readonly<Record<BadgeName, string>> = { ...statusBadges, lost: 'debug-disconnect' }

/** A node's icon: `svg:` names are `Icon.tsx`'s stroke icons, the rest codicons; folders take the folder colour. */
function ExplorerIcon({ name, folder, badge }: { name: IconName; folder?: boolean; badge?: BadgeName }) {
  const glyph = name.startsWith('svg:') ? <Icon name={name.slice(4) as Parameters<typeof Icon>[0]['name']} /> : <span className={`codicon codicon-${name}`} />
  const mark = badge && badgeIcons[badge]
  return <span className={`oe-icon${folder ? ' folder' : ''}`} aria-hidden="true">
    {glyph}{mark && <span className={`oe-badge codicon codicon-${mark}`} data-badge={badge} />}
  </span>
}

export default memo(ExplorerIcon)
