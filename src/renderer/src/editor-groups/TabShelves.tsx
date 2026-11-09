import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { OVERFLOW_WRAP_TABS_CLASS, type DockviewGroupPanel } from 'dockview-react'
import { useWorkbench } from '../core/WorkbenchContext'
import type { Workbench } from '../core/workbench'
import type { QueryTab } from '../documents'
import Icon from '../Icon'

const tabWidth = 232
const controlsWidth = 106
const wheelGestureMs = 220

export interface ShelfState {
  readonly pinned: boolean
  readonly compact: boolean
  readonly top: number
  readonly height: number
  readonly rows: number
  readonly limit: number
  readonly hidden: readonly QueryTab[]
}

/**
 * Two shelves over the group's original native tab elements. Keeping their parent and Dockview's wrapped-tab hit
 * testing preserves roving focus, dragging between rows and groups, splitting, and floating.
 */
export class TabShelfLayout {
  readonly list: HTMLElement
  private readonly header: HTMLElement
  private readonly rows = { pinned: 1, unpinned: 1 }
  private shelves: ShelfState[] = []
  private signature = ''
  private frame = 0
  private disposed = false
  private gesture?: { pinned: boolean; x: number; y: number; last: number; total: number; control?: number }
  private readonly disposables: { dispose(): void }[] = []

  constructor(private readonly group: DockviewGroupPanel, private readonly workbench: Workbench, private readonly changed: (shelves: ShelfState[]) => void) {
    this.list = group.model.tabsListElement
    this.header = this.list.closest<HTMLElement>('.dv-tabs-and-actions-container')!
    this.list.classList.add('query-shelves', OVERFLOW_WRAP_TABS_CLASS)
    this.header.classList.add('query-shelves-header')
    const resize = new ResizeObserver(() => this.schedule())
    resize.observe(this.list)
    resize.observe(group.element)
    // A new tab's React content can arrive after the group's panel list changes.
    const mutations = new MutationObserver(() => this.schedule())
    mutations.observe(this.list, { childList: true, subtree: true })
    group.element.addEventListener('wheel', this.wheel, { passive: false, capture: true })
    this.list.addEventListener('scroll', this.resetScroll)
    this.list.addEventListener('focusin', this.refresh)
    this.disposables.push(
      group.api.onDidActivePanelChange(() => this.refresh()),
      { dispose: workbench.documents.subscribe(() => this.schedule()) },
      { dispose: workbench.tabRename.subscribe(() => this.refresh()) },
      { dispose: workbench.theme.subscribe(() => this.schedule()) },
      { dispose: () => { resize.disconnect(); mutations.disconnect() } }
    )
    this.refresh()
  }

  private schedule(): void {
    if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh() })
  }

  private resetScroll = () => { this.list.scrollLeft = 0; this.list.scrollTop = 0 }

  readonly refresh = (): void => {
    if (this.disposed || !this.list.clientWidth) return
    const width = this.list.clientWidth
    const rowHeight = parseFloat(getComputedStyle(this.list).getPropertyValue('--varia-bar')) || 36
    const tabs = this.group.panels.map(panel => this.workbench.documents.get(panel.id)).filter(tab => tab !== undefined)
    const pinned = tabs.filter(tab => tab.pinned), unpinned = tabs.filter(tab => !tab.pinned)
    const count = Number(pinned.length > 0) + Number(unpinned.length > 0)
    const availableRows = Math.max(count, Math.floor(this.group.element.clientHeight / (2 * rowHeight)))
    const compact = width < tabWidth + controlsWidth, reserved = compact ? 32 : controlsWidth
    const columns = Math.max(1, Math.floor(Math.max(1, width - reserved) / tabWidth))
    const cellWidth = Math.max(1, Math.floor((width - reserved) / columns))
    const focused = document.activeElement?.closest('.dv-tab')?.querySelector<HTMLElement>('[data-tab-id]')?.dataset.tabId
    const priorities = [this.workbench.tabRename.getSnapshot().id, this.group.activePanel?.id, focused]
    const nodes = new Map(Array.from(this.list.querySelectorAll<HTMLElement>(':scope > .dv-tab')).map(node => [node.querySelector<HTMLElement>('[data-tab-id]')?.dataset.tabId, node]))
    let top = 0
    const shelves: ShelfState[] = []
    for (const section of [pinned, unpinned]) {
      if (!section.length) continue
      const isPinned = !!section[0].pinned, key = isPinned ? 'pinned' : 'unpinned'
      const limit = Math.max(1, Math.min(Math.floor(availableRows / count), Math.ceil(section.length / columns)))
      const rows = Math.min(this.rows[key], limit), slots = columns * rows
      const visible = section.slice(0, slots)
      const priority = [...new Set(priorities.map(id => section.find(tab => tab.id === id)).filter(tab => tab !== undefined))].slice(0, slots)
      for (const tab of priority) {
        if (visible.includes(tab)) continue
        const replace = visible.findLastIndex(candidate => !priority.includes(candidate))
        if (replace >= 0) visible[replace] = tab
      }
      const shown = new Set(visible), hidden = section.filter(tab => !shown.has(tab))
      for (const [index, tab] of section.entries()) {
        const node = nodes.get(tab.id)
        if (!node) continue
        const slot = visible.indexOf(tab), overflow = slot < 0
        // Overflow tabs keep real boxes below the group. Keyboard focus can reach and promote them, while native
        // 2-D drag hit testing keeps them out of the visible rows' insertion slots.
        node.dataset.tabShelf = key
        node.toggleAttribute('data-tab-overflow', overflow)
        node.style.left = `${overflow ? width + (index + 1) * cellWidth : (slot % columns) * cellWidth}px`
        node.style.top = `${overflow ? this.group.element.clientHeight + rowHeight : top + Math.floor(slot / columns) * rowHeight}px`
        node.style.width = `${cellWidth}px`
        node.style.height = `${rowHeight}px`
      }
      shelves.push({ pinned: isPinned, compact, top, height: rows * rowHeight, rows, limit, hidden })
      top += rows * rowHeight
    }
    const height = Math.max(rowHeight, top)
    this.list.style.height = `${height}px`
    this.header.style.height = `${height}px`
    this.resetScroll()
    this.shelves = shelves
    const signature = JSON.stringify([width, shelves.map(shelf => [shelf.pinned, shelf.top, shelf.height, shelf.rows, shelf.limit, shelf.hidden.map(tab => [tab.id, tab.name])])])
    if (signature !== this.signature) {
      this.signature = signature
      this.group.relayout()
      this.changed(shelves)
    }
  }

  setRows(pinned: boolean, rows: number): void {
    const shelf = this.shelves.find(value => value.pinned === pinned)
    if (!shelf) return
    this.rows[pinned ? 'pinned' : 'unpinned'] = Math.max(1, Math.min(rows, shelf.limit))
    this.refresh()
  }

  private wheel = (event: WheelEvent): void => {
    if (!this.workbench.gestures.matches('documentTabs.rows', event) || !event.deltaY) { this.gesture = undefined; return }
    const now = performance.now(), control = this.workbench.keybindings.controlWheelGesture
    let gesture = this.gesture
    if (!gesture || gesture.x !== event.clientX || gesture.y !== event.clientY || gesture.control !== control || (control === undefined && now - gesture.last > wheelGestureMs)) {
      this.gesture = undefined
      const rect = this.list.getBoundingClientRect(), y = event.clientY - rect.top
      const shelf = event.clientX >= rect.left && event.clientX < rect.right && this.shelves.find(value => y >= value.top && y < value.top + value.height)
      if (!shelf) return
      gesture = this.gesture = { pinned: shelf.pinned, x: event.clientX, y: event.clientY, last: now, total: 0, control }
    }
    const original = this.shelves.find(value => value.pinned === gesture.pinned)
    if (!original) { this.gesture = undefined; return }
    event.preventDefault()
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1)
    if (now - gesture.last > wheelGestureMs || Math.sign(delta) !== Math.sign(gesture.total)) gesture.total = 0
    gesture.last = now
    gesture.total += delta
    if (Math.abs(gesture.total) < 32) return
    this.setRows(gesture.pinned, original.rows + Math.sign(gesture.total))
    gesture.total = 0
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.disposables.forEach(value => value.dispose())
    this.group.element.removeEventListener('wheel', this.wheel, true)
    this.list.removeEventListener('scroll', this.resetScroll)
    this.list.removeEventListener('focusin', this.refresh)
  }
}

/** Row controls live beside the native tab elements, without consuming a section heading. */
export default function TabShelves({ group }: { readonly group: DockviewGroupPanel }) {
  const workbench = useWorkbench()
  const layout = useRef<TabShelfLayout | null>(null)
  const [shelves, setShelves] = useState<ShelfState[]>([])
  useLayoutEffect(() => {
    const current = new TabShelfLayout(group, workbench, setShelves)
    layout.current = current
    return () => { current.dispose(); layout.current = null }
  }, [group, workbench])
  const list = group.model.tabsListElement
  return createPortal(shelves.map(shelf => <ShelfControls key={String(shelf.pinned)} group={group} shelf={shelf} layout={layout.current!} />), list)
}

function ShelfControls({ group, shelf, layout }: { readonly group: DockviewGroupPanel; readonly shelf: ShelfState; readonly layout: TabShelfLayout }) {
  const overflow = useRef<HTMLDivElement>(null)
  const name = shelf.pinned ? 'pinned' : 'query', id = `tab-overflow-${group.id}-${name}`
  const label = `Show ${shelf.hidden.length} more ${name} ${shelf.hidden.length === 1 ? 'tab' : 'tabs'}`
  const changeRows = (rows: number) => { overflow.current?.hidePopover(); layout.setRows(shelf.pinned, rows) }
  const rowControls = <>
    <button type="button" className="icon-button" aria-label={`Fewer ${name} rows`} disabled={shelf.rows === 1} onClick={() => changeRows(shelf.rows - 1)}><Icon name="remove" /></button>
    <span className="query-shelf-rows" aria-live="polite">{shelf.rows}</span>
    <button type="button" className="icon-button" aria-label={`More ${name} rows`} disabled={shelf.rows === shelf.limit} onClick={() => changeRows(shelf.rows + 1)}><Icon name="add" /></button>
  </>
  useLayoutEffect(() => { overflow.current?.hidePopover() }, [shelf])
  return <div className="query-shelf" data-shelf-controls={shelf.pinned ? 'pinned' : 'unpinned'} style={{ top: shelf.top, height: shelf.height, '--shelf-controls-width': `${shelf.compact ? 32 : controlsWidth}px` } as CSSProperties}>
    <div className="query-shelf-controls" role="group" aria-label={`${shelf.pinned ? 'Pinned' : 'Unpinned'} tab rows`}
      onPointerDown={event => event.stopPropagation()}>
      {!shelf.compact && rowControls}
      <button type="button" className="icon-button query-shelf-more" aria-label={shelf.compact ? `${shelf.pinned ? 'Pinned' : 'Query'} tab options` : label} title={label} disabled={!shelf.hidden.length && (!shelf.compact || shelf.limit === 1)} popoverTarget={id}><Icon name="chevron-down" /></button>
    </div>
    <div className="query-shelf-overflow" id={id} popover="auto" ref={overflow} role="group" aria-label={`More ${name} tabs`}>
      {shelf.compact && <div className="query-shelf-row-options">{rowControls}</div>}
      {shelf.hidden.map(tab => <button type="button" key={tab.id} title={tab.file?.path ?? tab.name} onClick={() => {
        overflow.current?.hidePopover()
        group.panels.find(panel => panel.id === tab.id)?.api.setActive()
        layout.refresh()
        group.model.tabsListElement.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab.id)}"]`)?.closest<HTMLElement>('.dv-tab')?.focus({ preventScroll: true })
      }}>{tab.name}</button>)}
    </div>
  </div>
}
