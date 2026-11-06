import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { environmentTag } from '../../shared/environments'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { documentKind, isQueryDocument, isTextDocument, kindInfo, type QueryTab } from './documents'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import { useMenuTarget } from './menus/useMenuTarget'
import PaneMenuButton from './PaneMenuButton'
import { liveQuerySession } from './services/queries'
import { useTabDrag, type TabDragHandlers } from './tab-drag'
import TabRenameBox from './TabRenameBox'

const tabWidth = 172
const wheelGestureMs = 220
const shelfRowLimit = (count: number, columns: number, maxRows: number) => Math.max(1, Math.min(maxRows, Math.ceil(count / columns)))

/** A tab's file (or original name), its unsaved state, and where a reopened query was. */
function tabTooltip(tab: QueryTab): string {
  const what = tab.file?.path ?? tab.baseName ?? tab.name
  return `${what}${tab.file?.readOnly ? ' (read-only)' : ''}${tab.dirty ? ' (unsaved changes)' : ''}${tab.lastServer ? `\nLast connected to ${tab.lastServer}` : ''}`
}

export default function DocumentTabs() {
  const workbench = useWorkbench()
  const { documents, commands, queries, tabRename, keybindings } = workbench
  const { documents: tabs, activeId, busy } = useServiceSnapshot(documents)
  const connections = useServiceSnapshot(workbench.connections)
  const queryState = useServiceSnapshot(queries)
  const { id: renamingId } = useServiceSnapshot(tabRename)
  const strip = useRef<HTMLDivElement>(null)
  const focusAfterRender = useRef<string>(undefined)
  const wheelGesture = useRef<{ pinned: boolean; x: number; y: number; last: number; total: number; control?: number }>(undefined)
  const [space, setSpace] = useState({ columns: 4, rows: 4 })
  const [pinnedRows, setPinnedRows] = useState(1), [queryRows, setQueryRows] = useState(1)
  const pinned = tabs.filter(tab => tab.pinned), unpinned = tabs.filter(tab => !tab.pinned)
  const rowsPerShelf = Math.max(1, Math.floor(space.rows / (pinned.length && unpinned.length ? 2 : 1)))
  const tabTarget = useMenuTarget<HTMLDivElement>(element => {
    const tabId = element.dataset.tabId
    return tabId && documents.get(tabId) ? { kind: 'documentTab', tabId } : null
  })

  useLayoutEffect(() => {
    const element = strip.current, pane = element?.closest('.workspace')
    if (!element || !pane) return
    const measure = () => {
      if (!element.clientWidth || !pane.clientHeight) return
      const columns = Math.max(1, Math.floor(element.clientWidth / tabWidth))
      const height = parseFloat(getComputedStyle(element).getPropertyValue('--varia-bar')) || 36
      // Keep room for the editor and its own toolbar. Both shelves can always show at least one row.
      const rows = Math.max(2, Math.floor(pane.clientHeight / (2 * height)))
      setSpace(current => current.columns === columns && current.rows === rows ? current : { columns, rows })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  const pinnedLimit = shelfRowLimit(pinned.length, space.columns, rowsPerShelf)
  const queryLimit = shelfRowLimit(unpinned.length, space.columns, rowsPerShelf)
  useEffect(() => {
    const element = strip.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const shelf = (event.target as Element | null)?.closest('[data-tab-shelf]')
      if (!event.ctrlKey || !shelf || !event.deltaY) return
      event.preventDefault()
      const now = performance.now(), control = keybindings.controlWheelGesture
      const { clientX: x, clientY: y, deltaMode, deltaY } = event
      // A shrinking shelf can move out from under a stationary pointer. Keep the original target until the
      // pointer moves or Ctrl is released. Pinch events also carry ctrlKey, but have no keyup to end the gesture.
      let gesture = wheelGesture.current
      if (!gesture || gesture.x !== x || gesture.y !== y || gesture.control !== control || (control === undefined && now - gesture.last > wheelGestureMs))
        gesture = wheelGesture.current = { pinned: shelf.getAttribute('data-tab-shelf') === 'pinned', x, y, last: now, total: 0, control }
      const delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 120 : 1)
      if (now - gesture.last > wheelGestureMs || Math.sign(delta) !== Math.sign(gesture.total)) gesture.total = 0
      gesture.last = now
      gesture.total += delta
      if (Math.abs(gesture.total) < 32) return
      const step = Math.sign(gesture.total), limit = gesture.pinned ? pinnedLimit : queryLimit
      gesture.total = 0
      element.querySelector<HTMLElement>('[popover]:popover-open')?.hidePopover()
      const setRows = gesture.pinned ? setPinnedRows : setQueryRows
      setRows(value => Math.max(1, Math.min(limit, Math.min(value, limit) + step)))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [keybindings, pinnedLimit, queryLimit])

  function focusTab(id: string) {
    const button = document.getElementById(`tab-${id}`)
    if (!button?.closest('[popover]')) button?.focus({ preventScroll: true })
    else document.getElementById(`tab-${activeId}`)?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    const id = focusAfterRender.current
    if (!id) return
    focusAfterRender.current = undefined
    focusTab(id)
  }, [tabs, activeId])

  function activate(id: string, focus = false) {
    if (focus) {
      if (id === activeId) focusTab(id)
      else focusAfterRender.current = id
    }
    documents.activate(id)
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const index = tabs.findIndex(tab => tab.id === id)
    const destination = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
    if (destination === undefined) return
    event.preventDefault()
    activate(tabs[destination].id, true)
  }

  function renderTab(tab: QueryTab, drag?: TabDragHandlers, selectHidden?: () => void) {
    const connection = connections.find(value => value.id === tab.connectionId), environment = connection?.options.environment
    const state = queryState[tab.id], kind = kindInfo[documentKind(tab)], isQuery = isQueryDocument(tab)
    const spid = isQuery ? liveQuerySession(state, connection)?.spid : undefined
    const session = spid === undefined ? 'No live SQL session' : `SQL session ID ${spid}`
    const sid = isQuery && <span className="tab-sid" title={session} aria-hidden="true">{spid === undefined ? '—' : `SID ${spid}`}</span>
    const description = [environmentTag(environment)?.description, tab.pinned && 'Pinned', spid !== undefined && session].filter(Boolean).join('. ') || undefined
    const active = activeId === tab.id, renaming = renamingId === tab.id
    const pin = `${tab.pinned ? 'Unpin' : 'Pin'} ${tab.name}`
    return <div className={`query-tab${active ? ' active' : ''}`} style={{ borderTopColor: workbench.theme.accent(connection?.color) }}
      role="presentation" key={tab.id} ref={selectHidden ? undefined : tabTarget} data-tab-id={tab.id} data-dirty={tab.dirty || undefined} {...renaming ? {} : drag}>
      {renaming ? <div className="tab-select tab-renaming"><Icon name={kind.icon} className="tab-icon" label={kind.label} /><TabRenameBox tabId={tab.id} name={tab.name} service={tabRename} />{sid}</div>
        : <button type="button" id={`tab-${tab.id}`} className="tab-select" role={selectHidden ? undefined : 'tab'} aria-label={tab.name} aria-description={description}
          aria-selected={selectHidden ? undefined : active} tabIndex={selectHidden ? undefined : active ? 0 : -1} title={tabTooltip(tab)}
          onClick={selectHidden ?? (() => activate(tab.id))} onKeyDown={selectHidden ? undefined : event => tabKey(event, tab.id)}
          onDoubleClick={selectHidden ? undefined : () => tabRename.start(tab.id)} data-document-tab>
          <Icon name={kind.icon} className="tab-icon" label={kind.label} /><span className="tab-name">{tab.name}</span>
          <EnvironmentTag environment={environment} place="tab" />
          {tab.file?.readOnly && <Icon name="lock" className="tab-readonly" label="Read-only" />}
          {state?.running && <Icon name="loading" spin className="tab-running" label="Executing" />}{sid}
          {tab.dirty && <span className="dirty-dot" role="img" aria-label="Unsaved changes" />}
        </button>}
      {isTextDocument(tab) && <button type="button" className="tab-pin" aria-label={pin} title={pin} disabled={busy || documents.isFilling(tab.id)}
        onClick={() => { if (documents.setPinned(tab.id, !tab.pinned)) focusAfterRender.current = tab.id }}>
        <Icon name={tab.pinned ? 'pinned' : 'pin'} />
      </button>}
      <button type="button" className="tab-close" aria-label={`Close ${tab.name}`}
        title={state?.running ? `Close ${tab.name} (its query is executing)` : `Close ${tab.name}`} disabled={busy}
        onClick={() => void commands.execute('file.close', { tabId: tab.id }, 'toolbar')}><Icon name="close" /></button>
    </div>
  }

  return <div className="document-strip pane-header">
    <div className="query-tabs" role="tablist" aria-label="Query documents" ref={strip}>
      <TabShelf pinned tabs={pinned} columns={space.columns} rows={Math.min(pinnedRows, pinnedLimit)} limit={pinnedLimit} setRows={setPinnedRows}
        activeId={activeId} renamingId={renamingId} renderTab={renderTab} activate={activate} />
      <TabShelf tabs={unpinned} columns={space.columns} rows={Math.min(queryRows, queryLimit)} limit={queryLimit} setRows={setQueryRows}
        activeId={activeId} renamingId={renamingId} renderTab={renderTab} activate={activate} />
    </div>
    <PaneMenuButton pane="editor" />
  </div>
}

interface ShelfProps {
  readonly pinned?: boolean
  readonly tabs: readonly QueryTab[]
  readonly columns: number
  readonly rows: number
  readonly limit: number
  readonly setRows: (rows: number) => void
  readonly activeId: string
  readonly renamingId: string
  readonly renderTab: (tab: QueryTab, drag?: TabDragHandlers, selectHidden?: () => void) => ReactNode
  readonly activate: (id: string, focus?: boolean) => void
}

function TabShelf({ pinned = false, tabs, columns, rows, limit, setRows, activeId, renamingId, renderTab, activate }: ShelfProps) {
  const { documents } = useWorkbench()
  const overflow = useRef<HTMLDivElement>(null)
  const slots = rows * columns
  // Leave the order intact and use the last visible slot for a selected tab that would be hidden. While renaming,
  // the edit box takes priority so changing the pane's size does not dismiss it.
  const names = [renamingId, activeId]
  const visible = tabs.slice(0, slots)
  const priority = names.map(id => tabs.find(tab => tab.id === id)).filter(tab => tab !== undefined)
  for (const tab of priority) {
    if (visible.includes(tab)) continue
    const replace = visible.findLastIndex(candidate => !priority.includes(candidate))
    if (replace >= 0) visible[replace] = tab
  }
  const shown = new Set(visible), hidden = tabs.filter(tab => !shown.has(tab))
  const name = pinned ? 'pinned' : 'query'
  const overflowId = `tab-overflow-${name}`
  const drag = useTabDrag(() => documents.getSnapshot().documents.filter(tab => !!tab.pinned === pinned).map(tab => tab.id), (id, index) => {
    const all = documents.getSnapshot().documents, target = all.filter(tab => !!tab.pinned === pinned)[index]
    if (target) documents.move(id, all.indexOf(target))
  })

  useLayoutEffect(() => { overflow.current?.hidePopover() }, [activeId, renamingId])

  if (!tabs.length) return null
  const overflowLabel = `Show ${hidden.length} more ${name} ${hidden.length === 1 ? 'tab' : 'tabs'}`
  return <div className="query-shelf" data-tab-shelf={pinned ? 'pinned' : 'unpinned'} role="group" aria-label={pinned ? 'Pinned tabs' : 'Unpinned tabs'} {...drag.strip}>
    <div className="query-shelf-tabs" style={{ '--tab-columns': columns } as CSSProperties}>
      {visible.map(tab => renderTab(tab, drag.tab(tab.id)))}
    </div>
    {tabs.length > columns && <div className="query-shelf-controls" aria-label={`${pinned ? 'Pinned' : 'Unpinned'} tab rows`}>
      <button type="button" className="icon-button" aria-label={`Fewer ${name} rows`} title={`Fewer ${name} rows (Ctrl+scroll up)`}
        disabled={rows === 1} onClick={() => { overflow.current?.hidePopover(); setRows(rows - 1) }}><Icon name="remove" /></button>
      <span className="query-shelf-rows" aria-live="polite">{rows} {rows === 1 ? 'row' : 'rows'}</span>
      <button type="button" className="icon-button" aria-label={`More ${name} rows`} title={`More ${name} rows (Ctrl+scroll down)`}
        disabled={rows === limit} onClick={() => { overflow.current?.hidePopover(); setRows(rows + 1) }}><Icon name="add" /></button>
      <button type="button" className="icon-button query-shelf-more" aria-label={overflowLabel} title={overflowLabel} disabled={!hidden.length} popoverTarget={overflowId}>
        +{hidden.length}<Icon name="chevron-down" />
      </button>
    </div>}
    {hidden.length > 0 && <div className="query-shelf-overflow" id={overflowId} popover="auto" ref={overflow} role="group" aria-label={`More ${name} tabs`}>
      {hidden.map(tab => renderTab(tab, undefined, () => { overflow.current?.hidePopover(); activate(tab.id, true) }))}
    </div>}
  </div>
}
