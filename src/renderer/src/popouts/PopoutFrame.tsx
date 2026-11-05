import { useCallback, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { isOutputPane, paneTitles, type PaneId, type PopoutPaneId } from '../../../shared/layouts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useMenuTarget } from '../menus/useMenuTarget'
import Icon from '../Icon'
import { paneDrag } from './drag'
import { placeHost } from './place'

export interface PopoutView { readonly id: string; readonly panes: readonly PopoutPaneId[]; readonly active: PopoutPaneId }
export interface PopoutCommands {
  select(windowId: string, pane: PopoutPaneId): void
  /** Docks a panel back in the main window, where it was before it popped out. */
  moveToMain(pane: PopoutPaneId): void
  close(pane: PopoutPaneId): void
  /** A tab's drag ended (dropped anywhere, or cancelled): the main window's compass goes. */
  dragEnded(): void
}

/** A panel's slot in its popout window: its content (the pane host) moves in while the slot is mounted. */
function PopoutSlot({ host, parking, hidden }: { host: HTMLElement; parking: HTMLElement | null; hidden: boolean }) {
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = slot.current
    if (!element) return
    placeHost(host, element)
    // Back to the main window's parking only if it is still here: it may already be docked again.
    return () => { if (host.parentElement === element && parking) placeHost(host, parking) }
  }, [host, parking])
  return <div className="popout-slot dock-slot" ref={slot} hidden={hidden} />
}

function PopoutTab({ view, pane, commands }: { view: PopoutView; pane: PopoutPaneId; commands: PopoutCommands }) {
  const { results, documents, menus } = useWorkbench()
  const menuFor = useServiceSnapshot(menus.menuFor)
  const element = useRef<HTMLDivElement | null>(null)
  const register = useMenuTarget<HTMLDivElement>(() => ({ kind: 'dockTab', pane, floating: false, popout: true }))
  const ref = useCallback((node: HTMLDivElement | null) => { element.current = node; register(node) }, [register])
  const selected = view.active === pane
  // An output panel's tab chosen by the user is the active query's view, as its dock tab is.
  const choose = () => {
    commands.select(view.id, pane)
    const tabId = documents.getSnapshot().activeId
    if (isOutputPane(pane) && tabId) results.setView(tabId, pane)
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const at = view.panes.indexOf(pane)
    const next = event.key === 'ArrowRight' ? view.panes[(at + 1) % view.panes.length] : event.key === 'ArrowLeft' ? view.panes[(at + view.panes.length - 1) % view.panes.length]
      : event.key === 'Home' ? view.panes[0] : event.key === 'End' ? view.panes.at(-1) : undefined
    if (next) {
      event.preventDefault()
      commands.select(view.id, next)
      element.current?.parentElement?.querySelector<HTMLElement>(`[data-popout-tab="${next}"]`)?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose() }
  }
  return <div ref={ref} className={`popout-tab${selected ? ' active' : ''}`} role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} data-popout-tab={pane}
    aria-haspopup="menu" aria-expanded={!!menuFor && menuFor === element.current} draggable title="Drag onto the main window to dock it there"
    onClick={event => { if (!(event.target as Element).closest('button')) choose() }} onKeyDown={key}
    onDoubleClick={event => { if (event.ctrlKey && !(event.target as Element).closest('button')) commands.moveToMain(pane) }}
    onDragStart={event => paneDrag.start(pane, event.dataTransfer)} onDragEnd={() => { paneDrag.end(); commands.dragEnded() }}>
    <span className="popout-tab-title">{paneTitles[pane]}</span>
    <button type="button" className="icon-button popout-tab-close" tabIndex={-1} aria-label={'Close ' + paneTitles[pane]} title="Close"
      onClick={() => commands.close(pane)}><Icon name="close" /></button>
  </div>
}

/**
 * A popout window's frame: its panels' tabs (dragged onto the main window, they dock there), the button that moves them
 * all back, and the panels themselves, the selected one showing. The OS draws the window's title bar.
 */
export default function PopoutFrame({ view, hosts, parking, commands }: { view: PopoutView; hosts: Record<PaneId, HTMLElement>; parking: HTMLElement | null; commands: PopoutCommands }) {
  const label = view.panes.map(pane => paneTitles[pane]).join(', ')
  return <div className="popout-window" data-popout={view.id}>
    <div className="popout-header">
      <div className="popout-tabs" role="tablist" aria-label={'Panels in this window: ' + label}>
        {view.panes.map(pane => <PopoutTab key={pane} view={view} pane={pane} commands={commands} />)}
      </div>
      <button type="button" className="icon-button popout-dock" aria-label="Move back into main window" title="Move back into main window"
        onClick={() => view.panes.forEach(pane => commands.moveToMain(pane))}><Icon name="window" /></button>
    </div>
    <div className="popout-content">
      {view.panes.map(pane => <PopoutSlot key={pane} host={hosts[pane]} parking={parking} hidden={pane !== view.active} />)}
    </div>
  </div>
}
