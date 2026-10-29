import { useCallback, useRef } from 'react'
import { paneTitles, type PaneId } from '../../shared/layouts'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useMenuTarget } from './menus/useMenuTarget'
import Icon from './Icon'

/**
 * A panel's ⋯ button, at the right of its own header: it opens the panel's menu (Dock Left… Tab with…, Float or Dock,
 * Close, Panel Tabs), the same menu as its dock tab, which is hidden while the panel is alone in its group.
 */
export default function PaneMenuButton({ pane }: { pane: PaneId }) {
  const { menus, panes } = useWorkbench()
  const button = useRef<HTMLButtonElement | null>(null)
  const register = useMenuTarget<HTMLButtonElement>(() => ({ kind: 'dockTab', pane, floating: panes.location(pane) === 'floating' }))
  const ref = useCallback((element: HTMLButtonElement | null) => { button.current = element; register(element) }, [register])
  const menuFor = useServiceSnapshot(menus.menuFor)
  return <button type="button" ref={ref} className="icon-button pane-menu" aria-label={`${paneTitles[pane]} panel menu`}
    aria-haspopup="menu" aria-expanded={!!menuFor && menuFor === button.current} title="Move, float or close this panel"
    // Enter and Space click with no detail: the menu then opens as the keyboard opens menus, its first item active.
    onClick={event => { menus.openForElement(event.currentTarget, { keyboard: event.detail === 0 }) }}><Icon name="ellipsis" /></button>
}
