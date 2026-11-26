import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { displayText } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled, useCommandsEnabled, useKeybindingLabel } from '../core/useCommand'
import type { CommandArgs, CommandId } from '../core/types'
import type { IconId } from '../../../shared/icons'
import { useMenuTarget } from '../menus/useMenuTarget'
import Icon from '../Icon'
import EmptyState from '../kit/EmptyState'
import { StaleBadge } from '../kit/LivePill'
import SearchPanel from '../search/SearchPanel'
import { explorerSearchId } from '../search/ObjectSearchService'
import ExplorerErrorBoundary, { FaultProbe, focusLost } from './ExplorerErrorBoundary'
import ExplorerTree from './ExplorerTree'
import PeekCard from './PeekCard'
import { isLiveConnection } from '../services/connection-availability'

/** `pressed`: a toggle button's state (aria-pressed). */
interface Tool { readonly id: CommandId; readonly icon: IconId; readonly label: string; readonly hint?: string; readonly args?: CommandArgs; readonly pressed?: boolean }

function ToolbarButton({ tool, enabled, tabbable, buttonRef, onFocus, onBlur }: {
  tool: Tool; enabled: boolean; tabbable: boolean; buttonRef: Ref<HTMLButtonElement>; onFocus: () => void; onBlur: (event: FocusEvent<HTMLButtonElement>) => void
}) {
  const { commands } = useWorkbench()
  const key = useKeybindingLabel(tool.id)
  const state = tool.pressed === undefined ? '' : `: ${tool.pressed ? 'On' : 'Off'}`
  const title = `${tool.label}${state}${key ? ` (${key.text})` : ''}${tool.hint ? `. ${tool.hint}` : ''}`
  return <button ref={buttonRef} className="icon-button" aria-label={tool.label} title={title} disabled={!enabled} tabIndex={tabbable ? 0 : -1} onFocus={onFocus} onBlur={onBlur}
    {...(tool.pressed !== undefined ? { 'aria-pressed': tool.pressed } : {})}
    onClick={() => void commands.execute(tool.id, tool.args, 'toolbar')}>
    <Icon name={tool.icon} />
  </button>
}

/** Focuses the tree in the window `near` is in: Object Explorer may be in a popout window (docs/popout-windows.md). */
const focusTree = (near: Element | null | undefined) => (near?.ownerDocument ?? document).querySelector<HTMLElement>('[data-explorer-tree]')?.focus()

/**
 * SSMS's toolbar as an ARIA toolbar: one tab stop (the button used last, or the first enabled one), and the arrow keys,
 * Home and End move between the enabled buttons. A focused button that turns disabled (Stop once loading ends,
 * Disconnect while it runs) would drop focus to the page, so focus moves on to the next enabled button, or the tree.
 */
export function ExplorerToolbar({ tools, ariaLabel = 'Object Explorer toolbar', className = 'explorer-toolbar' }: {
  tools: readonly Tool[]; ariaLabel?: string; className?: string
}) {
  const enabled = useCommandsEnabled(tools)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [current, setCurrent] = useState(0)
  const stop = enabled[current] ? current : enabled.indexOf(true)
  const focused = useRef(-1)
  const rescue = () => {
    const index = focused.current, button = buttons.current[index]
    if (!button || (button.ownerDocument.activeElement !== button && !focusLost(button.ownerDocument))) return
    // Reconnect and Disconnect share a toolbar slot. Replacing its command also replaces the focused DOM button.
    if (!button.disabled) { if (button.ownerDocument.activeElement !== button) button.focus(); return }
    focused.current = -1
    const count = buttons.current.length
    const next = Array.from({ length: count - 1 }, (_, step) => buttons.current[(index + 1 + step) % count]).find(candidate => candidate && !candidate.disabled)
    if (next) next.focus()
    else focusTree(button)
  }
  useLayoutEffect(rescue)
  // Chromium can also blur the button after this render; that blur has no related target.
  const blurred = (index: number, event: FocusEvent<HTMLButtonElement>) => {
    if (event.currentTarget.disabled && !event.relatedTarget) queueMicrotask(rescue)
    else if (focused.current === index) focused.current = -1
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const order = tools.map((_, index) => index).filter(index => enabled[index])
    const at = order.indexOf(buttons.current.findIndex(button => !!button && button === button.ownerDocument.activeElement))
    if (at < 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const next = event.key === 'ArrowRight' ? order[(at + 1) % order.length] : event.key === 'ArrowLeft' ? order[(at - 1 + order.length) % order.length]
      : event.key === 'Home' ? order[0] : event.key === 'End' ? order[order.length - 1] : undefined
    if (next === undefined) return
    event.preventDefault()
    setCurrent(next)
    buttons.current[next]?.focus()
  }
  return <div className={className} role="toolbar" aria-label={ariaLabel} onKeyDown={onKeyDown}>
    {tools.map((tool, index) => <ToolbarButton key={index} tool={tool} enabled={enabled[index]} tabbable={index === stop}
      buttonRef={button => { buttons.current[index] = button }} onFocus={() => { focused.current = index; setCurrent(index) }} onBlur={event => blurred(index, event)} />)}
  </div>
}

/**
 * Object Explorer's ⋯ button: keeps the header on one row while retaining Disconnect, Remove, Stop, Filter, Group by
 * Schema, Refresh, Collapse All, and the panel docking menu (Dock Left…, Float, Move into New Window, Close).
 */
function ExplorerMenuButton() {
  const { explorer, menus, panes } = useWorkbench()
  const button = useRef<HTMLButtonElement | null>(null)
  const register = useMenuTarget<HTMLButtonElement>(() => {
    const selected = explorer.getSnapshot().selected
    const selectedServer = explorer.menuNode(selected)?.connectionId
    const node = selectedServer === undefined ? undefined : explorer.menuNode(explorer.rootIds.find(id => explorer.node(id)?.connectionId === selectedServer))
    return { kind: 'explorerTools', pane: 'explorer', floating: panes.location('explorer') === 'floating', popout: panes.location('explorer') === 'window', ...(node ? { node } : {}) }
  })
  const ref = useCallback((element: HTMLButtonElement | null) => { button.current = element; register(element) }, [register])
  const menuFor = useServiceSnapshot(menus.menuFor)
  return <button type="button" ref={ref} className="icon-button pane-menu" aria-label="Object Explorer panel menu"
    aria-haspopup="menu" aria-expanded={!!menuFor && menuFor === button.current} title="More Object Explorer actions and panel menu"
    onClick={event => { menus.openForElement(event.currentTarget, { keyboard: event.detail === 0 }) }}><Icon name="ellipsis" /></button>
}

/**
 * Object Explorer's search box: the object index search the Search Objects tab runs (Match Case, Whole Word, Regex, names
 * and definitions), on the server of the tree's selection, or the first connected one. Its hits show in a band above the
 * tree while there is text, and reveal their object in it. Escape clears the text, or, when there is none, returns to the
 * tree; so does ↓ or Enter in an empty box.
 */
function ExplorerSearch({ connectionId, inlineTools }: { readonly connectionId: string | undefined; readonly inlineTools: ReactNode }) {
  const { objectSearch } = useWorkbench()
  const { paneFocus } = useServiceSnapshot(objectSearch)
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => objectSearch.followExplorer(connectionId), [objectSearch, connectionId])
  // Search in Object Explorer asks for focus, perhaps before this pane was shown.
  useLayoutEffect(() => { if (objectSearch.takePaneFocus()) { input.current?.focus(); input.current?.select() } }, [objectSearch, paneFocus])
  return <SearchPanel searchId={explorerSearchId} layout="pane" inputRef={input} onLeave={() => focusTree(input.current)} inlineTools={inlineTools} />
}

/**
 * The footer: how fresh the listing that shows the selected row is ("Tables · Updated 4 s ago", or "Stale since …" after
 * a refresh failed and kept the old rows), and how many servers are connected.
 */
function ExplorerFooter({ servers, live }: { readonly servers: number; readonly live: number }) {
  const { explorer } = useWorkbench()
  const { selected } = useServiceSnapshot(explorer)
  const fresh = explorer.listingFreshness(selected)
  return <div className="explorer-footer">
    {fresh && <span className="explorer-freshness">
      <bdi className="explorer-freshness-scope">{displayText(fresh.label)}</bdi>
      <span aria-hidden="true">·</span>
      <StaleBadge updatedAt={fresh.updatedAt} {...(fresh.staleSince !== undefined ? { stale: { since: fresh.staleSince } } : {})} />
    </span>}
    <span className="explorer-servers">{live ? `${live} connected server${live === 1 ? '' : 's'}` : servers ? 'No connected servers' : 'Windows & SQL authentication'}</span>
  </div>
}

/**
 * Object Explorer: 1-row header (Connect, Refresh, Collapse All, and ⋯ for Disconnect, Remove, Stop and panel actions),
 * inline search row with Filter Settings and Group by Schema (falling back cleanly when disconnected/empty), over the
 * tree of connected servers or a prompt to connect. Filter shows a filled funnel while the selected folder has a filter.
 */
export default function ExplorerPane({ error, activeConnectionId, activeQueryId, onNewMultiServerQuery }: {
  readonly error?: string; readonly activeConnectionId?: string; readonly activeQueryId?: string; readonly onNewMultiServerQuery?: () => void
}) {
  const { explorer, connections, commands } = useWorkbench()
  const { selected, multiSelected } = useServiceSnapshot(explorer)
  const { explorerSelectionFiltered: filtered, explorerGroupBySchema: grouped } = useServiceSnapshot(explorer.context)
  const servers = useServiceSnapshot(connections).filter(connection => connection.inExplorer !== false)
  const connect = useCommandEnabled('connection.connect')
  const selectedServer = explorer.menuNode(selected)?.connectionId
  const multiProvider = explorer.multiSelectProvider
  const multiSelectionLabel = multiProvider === 'bigquery'
    ? `${multiSelected.length} BigQuery Projects selected`
    : `${multiSelected.length} SQL Servers selected`
  // The empty area below the servers: Connect… and Refresh. Rows register their own menus.
  const background = useMenuTarget<HTMLDivElement>(() => ({ kind: 'explorer' }))
  const live = servers.filter(isLiveConnection).length
  const headerTools: Tool[] = [
    { id: 'connection.connect', icon: 'plug', label: 'Connect Object Explorer' },
    { id: 'explorer.refresh', icon: 'refresh', label: 'Refresh' },
    { id: 'explorer.collapseAll', icon: 'collapse-all', label: 'Collapse All' }
  ]
  const filterTools: Tool[] = [
    { id: 'explorer.filter', icon: filtered ? 'filter-filled' : 'filter', label: 'Filter Settings', hint: 'Filter the selected folder\'s contents. Select a folder such as Tables, Views, Databases, or Logins.' },
    { id: 'explorer.groupBySchema', icon: 'symbol-namespace', label: 'Group by Schema', pressed: grouped }
  ]
  const inlineToolbar = <ExplorerToolbar tools={filterTools} ariaLabel="Object Explorer filter and view toolbar" className="explorer-toolbar explorer-inline-toolbar" />
  // When the last server goes, focus the tree held moves to the empty state's Connect button rather than the page; when
  // the first one comes, focus the Connect button or its dialog held moves to the tree, as SSMS focuses Object Explorer.
  const empty = !servers.length, connectButton = useRef<HTMLButtonElement>(null), wasEmpty = useRef(empty)
  const header = useRef<HTMLDivElement>(null)
  const paneDocument = () => header.current?.ownerDocument ?? document
  useLayoutEffect(() => {
    if (empty !== wasEmpty.current && focusLost(paneDocument())) {
      if (empty) connectButton.current?.focus()
      else focusTree(header.current)
    }
    wasEmpty.current = empty
  }, [empty])
  // The box shows while Search in Object Explorer can run (`hasConnection`): a lost server cannot be searched. Focus it
  // held when the last connection went moves to the tree.
  const searchable = live > 0
  useLayoutEffect(() => {
    if (!searchable && !empty && focusLost(paneDocument())) focusTree(header.current)
  }, [searchable, empty])
  return <>
    <div className="explorer-header pane-header" ref={header}><span className="pane-title">Object Explorer</span><ExplorerToolbar tools={headerTools} /><ExplorerMenuButton /></div>
    {searchable ? <ExplorerSearch connectionId={selectedServer} inlineTools={inlineToolbar} /> : <div className="explorer-tools-bar">{inlineToolbar}</div>}
    {multiSelected.length >= 2 && <div className="oe-multi-bar" role="region" aria-label="Multi-server selection"
      style={{ height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 'var(--varia-space-1)', padding: '0 var(--varia-space-2)' }}>
      <span className="oe-multi-bar-label" style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--varia-size-xs)', fontWeight: 600 }}>
        {multiSelectionLabel}
      </span>
      <button type="button" className="primary oe-multi-bar-action"
        style={{ height: 20, padding: '0 var(--varia-space-2)', fontSize: 'var(--varia-size-xs)', lineHeight: 1 }}
        onClick={() => { if (onNewMultiServerQuery) onNewMultiServerQuery(); else void commands.execute('explorer.newMultiServerQuery', undefined, 'toolbar') }}>
        New Query
      </button>
      <button type="button" className="icon-button oe-multi-bar-clear" aria-label="Clear selection" title="Clear selection (Escape)"
        style={{ width: 20, height: 20, padding: 2 }}
        onClick={() => { explorer.clearMultiSelect(); focusTree(header.current) }}>
        <Icon name="close" />
      </button>
    </div>}
    <div className="explorer-body" ref={background}>
      {servers.length ? <ExplorerErrorBoundary onReload={() => explorer.reset()} onReloaded={() => focusTree(header.current)}>
        <FaultProbe /><ExplorerTree activeConnectionId={activeConnectionId} activeQueryId={activeQueryId} /><PeekCard /></ExplorerErrorBoundary>
        : <EmptyState className="explorer-empty" icon="server" detail="Connect to SQL Server to browse databases and objects." actions={[{ label: 'Connect to server', run: () => void commands.execute('connection.connect', undefined, 'toolbar'), disabled: !connect, buttonRef: connectButton, primary: true }]} />}
      {error && <p className="explorer-error" role="alert">{error}</p>}
    </div>
    <ExplorerFooter servers={servers.length} live={live} />
  </>
}
