import { paneTitles, type PaneId } from '../../shared/layouts'
import { useWorkbench } from './core/WorkbenchContext'
import { useMenuTarget } from './menus/useMenuTarget'
import Icon from './Icon'

/**
 * A panel's ⋯ button, at the right of its own header: it opens the panel's menu (Dock Left… Tab with…, Float or Dock,
 * Close, Panel Tabs), the same menu as its dock tab, which is hidden while the panel is alone in its group.
 */
export default function PaneMenuButton({ pane }: { pane: PaneId }) {
  const { menus, panes } = useWorkbench()
  const target = useMenuTarget<HTMLButtonElement>(() => ({ kind: 'dockTab', pane, floating: panes.location(pane) === 'floating' }))
  return <button type="button" ref={target} className="icon-button pane-menu" aria-label={`${paneTitles[pane]} panel menu`} aria-haspopup="menu" title="Move, float or close this panel"
    onClick={event => { menus.openForElement(event.currentTarget, { keyboard: true }) }}><Icon name="ellipsis" /></button>
}
