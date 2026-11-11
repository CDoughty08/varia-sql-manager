import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { OVERFLOW_WRAP_TABS_CLASS, type DockviewGroupPanel } from 'dockview-react'
import type { EditorTabRows } from '../../../shared/editor-groups'
import { defaultDensity, densities } from '../../../shared/theme/metrics'
import { useWorkbench } from '../core/WorkbenchContext'
import type { Workbench } from '../core/workbench'
import type { QueryTab } from '../documents'
import { afterPointer } from './pointer'

const tabWidth = 232
const wheelGestureMs = 220
const feedbackMs = 1400

export interface ShelfFeedback {
  readonly pinned: boolean
  readonly message: string
  readonly top: number
}

export interface ShelfState {
  readonly pinned: boolean
  readonly top: number
  readonly height: number
  readonly rows: number
  readonly limit: number
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly cellWidth: number
  readonly overflowLeft: number
  readonly overflowTop: number
  readonly hidden: readonly QueryTab[]
}

/**
 * Two shelves over the group's original native tab elements. Keeping their parent and Dockview's wrapped-tab hit
 * testing preserves roving focus, dragging between rows and groups, splitting, and floating.
 */
export class TabShelfLayout {
  readonly list: HTMLElement
  private readonly header: HTMLElement
  private rows: EditorTabRows
  private readonly offsets = { pinned: 0, unpinned: 0 }
  private scrollTop = 0
  private contentHeight = 0
  private viewportHeight = 0
  private verticalReveal?: { key: string; active?: string; focused?: string; focusedIndex: number }
  private feedbackTimer?: ReturnType<typeof setTimeout>
  private readonly reveal = new Map<boolean, string>()
  private membership = ''
  private shelves: ShelfState[] = []
  private signature = ''
  private frame = 0
  private disposed = false
  private readonly visible = new Map<boolean, readonly string[]>()
  private frozen?: ReadonlyMap<boolean, readonly string[]>
  private readonly pointer: ReturnType<typeof afterPointer>
  private gesture?: { pinned: boolean; x: number; y: number; last: number; total: number; control?: number }
  private readonly disposables: { dispose(): void }[] = []

  constructor(private readonly group: DockviewGroupPanel, private readonly workbench: Workbench, private readonly changed: (shelves: ShelfState[]) => void, private readonly feedback: (feedback: ShelfFeedback | undefined) => void = () => {}) {
    this.rows = { ...workbench.editorGroups.getTabRows(group.id) }
    this.list = group.model.tabsListElement
    this.header = this.list.closest<HTMLElement>('.dv-tabs-and-actions-container')!
    this.list.classList.add('query-shelves', OVERFLOW_WRAP_TABS_CLASS)
    this.header.classList.add('query-shelves-header')
    this.pointer = afterPointer(this.list.ownerDocument.defaultView!)
    const resize = new ResizeObserver(() => this.schedule())
    resize.observe(this.list)
    resize.observe(group.element)
    // A new tab's React content can arrive after the group's panel list changes.
    const mutations = new MutationObserver(() => this.schedule())
    mutations.observe(this.list, { childList: true, subtree: true })
    group.element.addEventListener('wheel', this.wheel, { passive: false, capture: true })
    this.list.addEventListener('pointerdown', this.freeze, true)
    this.list.addEventListener('scroll', this.resetScroll)
    this.list.addEventListener('focusin', this.refresh)
    this.disposables.push(
      group.api.onDidActivePanelChange(() => this.refresh()),
      { dispose: workbench.documents.subscribe(() => this.schedule()) },
      { dispose: workbench.tabRename.subscribe(() => this.refresh()) },
      { dispose: workbench.theme.subscribe(() => this.schedule()) },
      { dispose: workbench.editorGroups.subscribe(() => {
        const rows = workbench.editorGroups.getTabRows(group.id)
        if (rows.pinned === this.rows.pinned && rows.unpinned === this.rows.unpinned) return
        this.rows = { ...rows }
        this.refresh()
      }) },
      workbench.editorGroups.registerTabRows(group.id, (pinned, delta) => {
        const shelf = this.shelves.find(value => value.pinned === pinned)
        if (shelf) this.setRows(pinned, shelf.rows + delta)
      }, (pinned, delta) => {
        const shelf = this.shelves.find(value => value.pinned === pinned)
        return !!shelf && (delta > 0 ? shelf.rows < shelf.limit : shelf.rows > 1)
      }),
      { dispose: () => { resize.disconnect(); mutations.disconnect() } }
    )
    this.refresh()
  }

  private schedule(): void {
    if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh() })
  }

  private resetScroll = () => { this.list.scrollLeft = 0; this.list.scrollTop = 0 }

  private freeze = (event: PointerEvent): void => {
    const target = event.target
    if (this.frozen || event.button !== 0 || !(target instanceof Element) || target.closest('.tab-pin, .tab-close, .tab-rename') || !target.closest('.dv-tab')) return
    const id = target.closest('.dv-tab')?.querySelector<HTMLElement>('[data-tab-id]')?.dataset.tabId
    // Dockview activates a tab on pointerdown, before its drag starts. Keep the other visible targets in place.
    const frozen = this.frozen = new Map(this.visible)
    // Use the shared release helper so native drop handlers finish before the next layout, including cross-group moves.
    this.pointer.then(() => {
      if (this.frozen !== frozen) return
      this.frozen = undefined
      // A click on the already-active tab must also reveal actions clipped by manual scrolling.
      const tab = id && this.group.panels.some(panel => panel.id === id) && this.workbench.documents.get(id)
      if (tab) this.reveal.delete(!!tab.pinned)
      this.verticalReveal = undefined
      this.refresh()
    })
  }

  readonly refresh = (): void => {
    if (this.disposed || !this.list.clientWidth) return
    const width = this.list.clientWidth
    const rowHeight = parseFloat(getComputedStyle(this.list).getPropertyValue('--varia-documentTab')) || densities[defaultDensity].documentTab
    const tabs = this.group.panels.map(panel => this.workbench.documents.get(panel.id)).filter(tab => tab !== undefined)
    const pinned = tabs.filter(tab => tab.pinned), unpinned = tabs.filter(tab => !tab.pinned)
    const membership = JSON.stringify([pinned.map(tab => tab.id), unpinned.map(tab => tab.id)])
    if (membership !== this.membership) { this.membership = membership; this.gesture = undefined }
    const columns = Math.max(1, Math.floor(width / tabWidth))
    const cellWidth = Math.max(1, Math.floor(width / columns))
    const sections = [pinned, unpinned]
    const allocated = sections.map((section, index) => Math.min(section.length ? this.rows[index ? 'unpinned' : 'pinned'] : 0, Math.ceil(section.length / columns)))
    this.contentHeight = Math.max(rowHeight, allocated.reduce((sum, rows) => sum + rows, 0) * rowHeight)
    this.viewportHeight = Math.min(this.contentHeight, Math.max(rowHeight, this.group.element.clientHeight - this.header.offsetTop))
    const focused = document.activeElement?.closest('.dv-tab')?.querySelector<HTMLElement>('[data-tab-id]')?.dataset.tabId
    const priorities = [this.workbench.tabRename.getSnapshot().id, this.group.activePanel?.id, focused]
    const nodes = new Map(Array.from(this.list.querySelectorAll<HTMLElement>(':scope > .dv-tab')).map(node => [node.querySelector<HTMLElement>('[data-tab-id]')?.dataset.tabId, node]))
    const positions = new Map<string, number>()
    let top = 0
    const shelves: ShelfState[] = []
    for (const [sectionIndex, section] of sections.entries()) {
      if (!section.length) continue
      const isPinned = !!section[0].pinned, key = isPinned ? 'pinned' : 'unpinned'
      const rows = allocated[sectionIndex]
      const limit = Math.ceil(section.length / columns)
      const slots = columns * rows
      const capacity = rows === 1 ? section.length : section.length > slots ? slots - 1 : slots
      const frozen = this.frozen?.get(isPinned)
      const visible = rows === 1 ? [...section] : frozen ? frozen.map(id => section.find(tab => tab.id === id)).filter(tab => tab !== undefined).slice(0, capacity) : section.slice(0, capacity)
      const priority = this.frozen || rows === 1 ? [] : [...new Set(priorities.map(id => section.find(tab => tab.id === id)).filter(tab => tab !== undefined))].slice(0, capacity)
      for (const tab of priority) {
        if (visible.includes(tab)) continue
        const replace = visible.findLastIndex(candidate => !priority.includes(candidate))
        if (replace >= 0) visible[replace] = tab
      }
      const shown = new Set(visible), hidden = section.filter(tab => !shown.has(tab))
      // Keep scrolling local to each shelf; the native tabs retain their shared parent for Dockview's drag resolver.
      const focusedIndex = section.findIndex(tab => tab.id === focused)
      const localPriorities = priorities.map(id => id !== undefined && section.some(tab => tab.id === id) ? id : null)
      const reveal = JSON.stringify([...localPriorities, width, rows, section.findIndex(tab => tab.id === priorities[1]), focusedIndex])
      let offset = rows === 1 ? Math.min(this.offsets[key], Math.max(0, section.length * cellWidth - width)) : 0
      if (rows === 1 && !this.frozen && reveal !== this.reveal.get(isPinned)) {
        const previous = JSON.parse(this.reveal.get(isPinned) ?? '[]') as (string | number | null)[]
        const selected = previous[1] !== localPriorities[1] ? localPriorities[1] : previous[2] !== localPriorities[2] || previous[6] !== focusedIndex ? localPriorities[2] : localPriorities[1]
        const target = section.find(tab => tab.id === priorities[0]) ?? section.find(tab => tab.id === selected) ?? section.find(tab => tab.id === this.group.activePanel?.id) ?? section.find(tab => tab.id === focused)
        const index = target ? section.indexOf(target) : -1
        if (index >= 0) offset = Math.max(index * cellWidth + cellWidth - width, Math.min(offset, index * cellWidth))
      }
      if (!this.frozen) this.reveal.set(isPinned, reveal)
      this.offsets[key] = offset
      this.visible.set(isPinned, visible.map(tab => tab.id))
      for (const [index, tab] of section.entries()) {
        const node = nodes.get(tab.id)
        if (!node) continue
        const slot = visible.indexOf(tab), overflow = slot < 0
        // Overflow tabs keep real boxes below the group. Keyboard focus can reach and promote them, while native
        // 2-D drag hit testing keeps them out of the visible rows' insertion slots.
        node.dataset.tabShelf = key
        node.toggleAttribute('data-tab-overflow', overflow)
        node.style.left = `${overflow ? width + (index + 1) * cellWidth : rows === 1 ? index * cellWidth - offset : (slot % columns) * cellWidth}px`
        node.style.top = `${overflow ? this.group.element.clientHeight + rowHeight : top + (rows === 1 ? 0 : Math.floor(slot / columns) * rowHeight)}px`
        if (!overflow) positions.set(tab.id, top + (rows === 1 ? 0 : Math.floor(slot / columns) * rowHeight))
        node.style.width = `${cellWidth}px`
        node.style.height = `${rowHeight}px`
      }
      shelves.push({ pinned: isPinned, top, height: rows * rowHeight, rows, limit, scrollTop: 0, viewportHeight: this.viewportHeight, cellWidth, overflowLeft: ((slots - 1) % columns) * cellWidth, overflowTop: (rows - 1) * rowHeight, hidden })
      top += rows * rowHeight
    }
    const focusedIndex = tabs.findIndex(tab => tab.id === focused)
    const verticalKey = JSON.stringify([priorities, width, this.viewportHeight, allocated, tabs.findIndex(tab => tab.id === priorities[1]), focusedIndex])
    this.scrollTop = Math.min(this.scrollTop, Math.max(0, this.contentHeight - this.viewportHeight))
    if (!this.frozen && verticalKey !== this.verticalReveal?.key) {
      const selected = this.verticalReveal?.active !== priorities[1] ? priorities[1] : this.verticalReveal?.focused !== focused || this.verticalReveal?.focusedIndex !== focusedIndex ? focused : priorities[1]
      const id = [priorities[0], selected, priorities[1]].find(id => id !== undefined && positions.has(id))
      const position = id === undefined ? undefined : positions.get(id)
      if (position !== undefined) this.scrollTop = Math.max(position + rowHeight - this.viewportHeight, Math.min(this.scrollTop, position))
      this.verticalReveal = { key: verticalKey, active: priorities[1], focused, focusedIndex }
    }
    for (const [id, node] of nodes) {
      const position = id === undefined ? undefined : positions.get(id)
      node.style.top = `${position === undefined ? Math.max(this.group.element.clientHeight, this.contentHeight) + rowHeight : position - this.scrollTop}px`
    }
    const heightChanged = this.header.style.height !== `${this.viewportHeight}px`
    this.list.style.height = `${this.viewportHeight}px`
    this.header.style.height = `${this.viewportHeight}px`
    this.list.style.setProperty('--tab-stack-scroll-top', `${this.scrollTop}px`)
    this.resetScroll()
    this.shelves = shelves.map(shelf => ({ ...shelf, scrollTop: this.scrollTop }))
    const signature = JSON.stringify([width, this.viewportHeight, this.scrollTop, shelves.map(shelf => [shelf.pinned, shelf.top, shelf.height, shelf.rows, shelf.limit, shelf.hidden.map(tab => [tab.id, tab.name])])])
    if (signature !== this.signature) {
      this.signature = signature
      if (heightChanged) this.group.relayout()
      this.changed(this.shelves)
    }
  }

  setRows(pinned: boolean, rows: number): void {
    const shelf = this.shelves.find(value => value.pinned === pinned)
    if (!shelf) return
    const next = Math.max(1, Math.min(rows, shelf.limit))
    if (next !== shelf.rows) {
      this.rows = { ...this.rows, [pinned ? 'pinned' : 'unpinned']: next }
      this.workbench.editorGroups.setTabRows(this.group.id, this.rows)
      this.refresh()
    }
    const message = next === shelf.rows ? rows < 1 ? 'Minimum stack height · 1 row' : shelf.limit === 1 ? 'All tabs fit in one row' : `All tabs fit · ${shelf.limit} rows` : `${next} ${next === 1 ? 'row' : 'rows'}`
    this.showFeedback(pinned, message)
  }

  private showFeedback(pinned: boolean, message: string): void {
    const shelf = this.shelves.find(value => value.pinned === pinned)
    if (!shelf) return
    const rowHeight = shelf.height / shelf.rows
    const top = Math.max(0, Math.min(this.group.element.clientHeight - rowHeight, this.list.getBoundingClientRect().top - this.group.element.getBoundingClientRect().top + shelf.top + shelf.height - this.scrollTop + 4))
    clearTimeout(this.feedbackTimer)
    this.feedback({ pinned, message, top })
    this.feedbackTimer = setTimeout(() => { this.feedbackTimer = undefined; this.feedback(undefined) }, feedbackMs)
  }

  private wheel = (event: WheelEvent): void => {
    if (event.target instanceof Element && event.target.closest('.query-shelf-overflow')) { this.gesture = undefined; return }
    const rect = this.list.getBoundingClientRect(), y = event.clientY - rect.top
    const pointed = event.clientX >= rect.left && event.clientX < rect.right && y >= 0 && y < rect.height && this.shelves.find(value => y + this.scrollTop >= value.top && y + this.scrollTop < value.top + value.height)
    if (!this.workbench.gestures.matches('documentTabs.rows', event)) {
      this.gesture = undefined
      if (!this.workbench.gestures.matches('documentTabs.scroll', event) || !pointed) return
      const horizontal = pointed.rows === 1 && Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (event.deltaY && this.contentHeight > this.viewportHeight && !horizontal) {
        event.preventDefault()
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewportHeight : 1)
        this.scrollTop = Math.max(0, Math.min(this.contentHeight - this.viewportHeight, this.scrollTop + delta))
        this.refresh()
        return
      }
      if (pointed.rows !== 1) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      const key = pointed.pinned ? 'pinned' : 'unpinned'
      const count = this.visible.get(pointed.pinned)?.length ?? 0
      const maximum = Math.max(0, count * pointed.cellWidth - this.list.clientWidth)
      if (!maximum) return
      event.preventDefault()
      this.offsets[key] = Math.max(0, Math.min(maximum, this.offsets[key] + delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.list.clientWidth : 1)))
      this.refresh()
      return
    }
    if (!event.deltaY) return
    const now = performance.now(), control = this.workbench.keybindings.controlWheelGesture
    let gesture = this.gesture
    if (!gesture || gesture.x !== event.clientX || gesture.y !== event.clientY || gesture.control !== control || (control === undefined && now - gesture.last > wheelGestureMs)) {
      this.gesture = undefined
      const shelf = pointed
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
    clearTimeout(this.feedbackTimer)
    this.disposables.forEach(value => value.dispose())
    this.group.element.removeEventListener('wheel', this.wheel, true)
    this.list.removeEventListener('pointerdown', this.freeze, true)
    this.pointer.dispose()
    this.list.removeEventListener('scroll', this.resetScroll)
    this.list.removeEventListener('focusin', this.refresh)
  }
}

/** Each shelf's final cell offers the tabs that do not fit its stacked rows. */
export default function TabShelves({ group }: { readonly group: DockviewGroupPanel }) {
  const workbench = useWorkbench()
  const layout = useRef<TabShelfLayout | null>(null)
  const [shelves, setShelves] = useState<ShelfState[]>([])
  const [feedback, setFeedback] = useState<ShelfFeedback>()
  useLayoutEffect(() => {
    const current = new TabShelfLayout(group, workbench, setShelves, setFeedback)
    layout.current = current
    return () => { current.dispose(); layout.current = null }
  }, [group, workbench])
  const list = group.model.tabsListElement
  return <>{createPortal(shelves.map(shelf => <ShelfControls key={String(shelf.pinned)} group={group} shelf={shelf} layout={layout.current!} />), list)}
    {createPortal(<div className="query-shelf-feedback" role="status" aria-label="Tab stack height" aria-live="polite" aria-atomic="true" hidden={!feedback} style={{ top: feedback?.top ?? 0 }}>{feedback?.message}</div>, group.element)}
  </>
}

function ShelfControls({ group, shelf, layout }: { readonly group: DockviewGroupPanel; readonly shelf: ShelfState; readonly layout: TabShelfLayout }) {
  const overflow = useRef<HTMLDivElement>(null)
  const { gestures } = useWorkbench()
  const name = shelf.pinned ? 'pinned' : 'query', id = `tab-overflow-${group.id}-${name}`
  const label = `Show ${shelf.hidden.length} more ${name} ${shelf.hidden.length === 1 ? 'tab' : 'tabs'}`
  useLayoutEffect(() => {
    const popup = overflow.current!
    // Dockview's native tab-list listener cancels wheel events before React's delegated handlers can stop them.
    const stop = (event: WheelEvent) => event.stopPropagation()
    popup.addEventListener('wheel', stop, { passive: true })
    return () => popup.removeEventListener('wheel', stop)
  }, [])
  useLayoutEffect(() => { overflow.current?.hidePopover() }, [shelf])
  return <div className="query-shelf" data-shelf-controls={shelf.pinned ? 'pinned' : 'unpinned'} data-rows={shelf.rows} style={{ top: `calc(${shelf.top}px - var(--tab-stack-scroll-top, 0px))`, height: shelf.height } as CSSProperties}>
    {shelf.hidden.length > 0 && <button type="button" className="query-shelf-more" aria-label={label} title={`${label}\n${gestures.phrase('documentTabs.rows')} to change stack height`} popoverTarget={id}
      style={{ left: shelf.overflowLeft, top: shelf.overflowTop, width: shelf.cellWidth }} onPointerDown={event => event.stopPropagation()}>… {shelf.hidden.length} more</button>}
    <div className="query-shelf-overflow" id={id} popover="auto" ref={overflow} role="group" aria-label={`More ${name} tabs`}>
      {shelf.hidden.map(tab => <button type="button" key={tab.id} title={tab.file?.path ?? tab.name} onClick={() => {
        overflow.current?.hidePopover()
        group.panels.find(panel => panel.id === tab.id)?.api.setActive()
        layout.refresh()
        group.model.tabsListElement.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab.id)}"]`)?.closest<HTMLElement>('.dv-tab')?.focus({ preventScroll: true })
      }}>{tab.name}</button>)}
    </div>
  </div>
}
