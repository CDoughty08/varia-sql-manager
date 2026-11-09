import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { explorerLimits } from '../../../shared/explorer/catalog.ts'
import { ssisDefaultVerb, ssisVerbSpecs } from '../../../shared/ssis/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import { observeResize, requestFrame } from '../core/windows'
import { useMenuTarget } from '../menus/useMenuTarget'
import { explorerDragType, maxDropText } from './drop'
import type { Announcement } from './ExplorerService'
import { focusLost } from './ExplorerErrorBoundary'
import ExplorerPinnedBand from './ExplorerPinnedBand'
import ExplorerRow, { PinnedServerRow, type RowActions } from './ExplorerRow'
import { rowStatus } from './ExplorerStatusService'
import { layoutWindow, pinnedServerBands, renderedIndices, revealPinnedScroll, rowIndex, RowKind, rowLayout, swallowedKey, treeKey, treeKeyOf, TypeAheadBuffer, typeAhead, type TreeAction, type VisibleRows } from './tree-model'

const { rowHeight } = explorerLimits
/** The live region speaks the latest announcement once things settle, as a screen reader cannot keep up with every page. */
const announceDelayMs = 500
interface FollowedQuery {
  readonly query: string
  readonly connection: string
  anchor?: { readonly rowTop: number; readonly top: number; readonly height: number }
}

/**
 * Object Explorer's tree: one focusable element with `aria-activedescendant` over windowed rows (the selected row is
 * always rendered), so a folder of 100,000 items renders about 60 rows. Its keys follow the Windows tree SSMS uses:
 * arrows, Home and End, Page Up and Down, Enter, `*`, Numpad plus and minus, and type-ahead.
 */
export default function ExplorerTree({ activeConnectionId, activeQueryId }: { readonly activeConnectionId?: string; readonly activeQueryId?: string }) {
  const { explorer, commands, connections, actions: objectActions, explorerStatus, settings, menuTargets, peek, gestures } = useWorkbench()
  const snapshot = useServiceSnapshot(explorer)
  const { servers: statuses } = useServiceSnapshot(explorerStatus)
  const { explorerLoading } = useServiceSnapshot(explorer.context)
  const servers = useServiceSnapshot(connections)
  const { 'objectExplorer.pinnedServerHeadersTop': topLimit, 'objectExplorer.pinnedServerHeadersBottom': bottomLimit,
    'objectExplorer.followActiveQuery': follow } = useServiceSnapshot(settings).values
  const renaming = useServiceSnapshot(explorer.renaming)
  const element = useRef<HTMLDivElement | null>(null)
  const frame = useRef<HTMLDivElement | null>(null)
  const focusedPin = useRef<Element | undefined>(undefined)
  const followed = useRef<FollowedQuery | undefined>(undefined)
  const releaseFollow = useCallback(() => { if (followed.current) followed.current.anchor = undefined }, [])
  const [view, setView] = useState({ top: 0, height: 0, width: 0, scrollbar: 0 })
  const [announcement, setAnnouncement] = useState<Announcement | undefined>(undefined)
  // A sentence from before this tree mounted (a server since removed, or before a Reload) is not news.
  const heard = useRef(snapshot.announcement?.id)
  /** A row a key selected, scrolled into view once the rows it is among have rendered. */
  const reveal = useRef<number | undefined>(undefined)
  const typing = useMemo(() => new TypeAheadBuffer(), [])
  // While type-ahead collects a name the tree carries data-type-ahead (explorerTypeAhead), so Space types a space rather
  // than running Peek's catalogue key, until the buffer would start over.
  const typeAheadTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const markTypeAhead = () => {
    const tree = element.current
    clearTimeout(typeAheadTimer.current)
    if (!tree) return
    if (!typing.value) { tree.removeAttribute('data-type-ahead'); return }
    tree.setAttribute('data-type-ahead', '')
    typeAheadTimer.current = setTimeout(() => tree.removeAttribute('data-type-ahead'), explorerLimits.typeAheadMs)
  }
  useEffect(() => () => clearTimeout(typeAheadTimer.current), [])
  const { rows, selected } = snapshot
  const selectedIndex = rowIndex(rows, selected)
  const layout = useMemo(() => rowLayout(rows), [rows])
  const latest = useRef({ rows, layout })
  latest.current = { rows, layout }
  const bands = pinnedServerBands(layout, view.top, view.height, topLimit, bottomLimit)

  const measure = useCallback(() => {
    const tree = element.current
    if (!tree) return
    const top = tree.scrollTop, height = tree.clientHeight, width = tree.clientWidth, scrollbar = tree.offsetHeight - height
    setView(current => current.top === top && current.height === height && current.width === width && current.scrollbar === scrollbar ? current : { top, height, width, scrollbar })
  }, [])
  const scrollPinnedBand = useCallback((event: WheelEvent) => {
    const tree = element.current
    if (!tree || (event.target as Element).closest?.('.explorer-pin-menu') || gestures.matches('global.wheelZoom', event) || !event.deltaY) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? pinnedServerBands(latest.current.layout, tree.scrollTop, tree.clientHeight, topLimit, bottomLimit).height : 1
    tree.scrollTop += event.deltaY * unit
  }, [gestures, topLimit, bottomLimit])

  // Scroll events already run once per painted frame. Commit before that paint so the overlay and native rows move
  // together, including during a scrollbar drag. Resize observers defer their updates out of layout.
  useLayoutEffect(() => {
    const tree = element.current
    if (!tree) return
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      const flush = () => { if (pending) { pending = false; measure() } }
      requestFrame(flush)
      setTimeout(flush, 50)
    }
    const scrolled = () => flushSync(measure)
    measure()
    tree.addEventListener('scroll', scrolled, { passive: true })
    const observer = observeResize(tree, schedule)
    return () => { pending = false; tree.removeEventListener('scroll', scrolled); observer.dispose() }
  }, [measure])
  useLayoutEffect(() => {
    const tree = element.current
    if (!tree) return
    // A collapse or resize can clamp the native offset or change which scrollbars are present.
    measure()
  }, [layout.total, measure, view])
  useLayoutEffect(() => {
    if (!focusedPin.current || focusedPin.current.isConnected) return
    focusedPin.current = undefined
    const tree = element.current
    if (!tree || !focusLost(tree.ownerDocument)) return
    // Scrolling can remove a focused shortcut or overflow item. Keep focus in the explorer.
    frame.current?.querySelector<HTMLElement>('.explorer-pin-menu:popover-open')?.hidePopover()
    if (focusLost(tree.ownerDocument)) tree.focus({ preventScroll: true })
  })
  useEffect(() => {
    const next = snapshot.announcement
    if (!next || next.id === heard.current) return
    const timer = setTimeout(() => { heard.current = next.id; setAnnouncement(next) }, announceDelayMs)
    return () => clearTimeout(timer)
  }, [snapshot.announcement])

  /** Scrolls row `index` of `rows` into view; rows published since the last render are laid out on the spot. */
  const ensureVisible = useCallback((rows: VisibleRows, index: number, alignTop = false) => {
    const tree = element.current, height = tree?.clientHeight ?? 0
    if (!tree || !height || index < 0) return
    const at = latest.current.rows === rows ? latest.current.layout : rowLayout(rows)
    const destination = revealPinnedScroll(at, index, tree.scrollTop, height, topLimit, bottomLimit, alignTop)
    if (destination === undefined) return
    tree.scrollTop = destination
    measure()
  }, [bottomLimit, topLimit, measure])

  useLayoutEffect(() => {
    const tree = element.current
    if (!tree) return
    return menuTargets.registerReveal(tree, item => {
      releaseFollow()
      const { rows } = latest.current
      // Commit the destination's overlay before MenuService reads the row's screen rectangle.
      flushSync(() => {
        measure()
        ensureVisible(rows, rowIndex(rows, Number(item.getAttribute('data-row-id'))))
      })
    })
  }, [ensureVisible, measure, menuTargets, releaseFollow])

  useLayoutEffect(() => {
    if (!activeQueryId || !activeConnectionId) { followed.current = undefined; return }
    if (!follow) { followed.current = { query: activeQueryId, connection: activeConnectionId }; return }
    const previous = followed.current
    const same = previous?.query === activeQueryId && previous.connection === activeConnectionId
    const anchor = same ? previous.anchor : undefined
    if (same && !anchor) return
    const tree = element.current
    if (!tree || !tree.clientHeight) return
    const index = layout.serverIndices.find(index => rows.nodes[index]?.connectionId === activeConnectionId)
    if (index === undefined) return
    const next = { rowTop: layout.top(index), top: tree.scrollTop, height: tree.clientHeight }
    // Pages streaming in above the server move its offset. Follow it only while its old header was in view and the user has stayed there.
    if (anchor && anchor.rowTop !== next.rowTop) {
      const wasVisible = anchor.rowTop >= anchor.top && anchor.rowTop + layout.height(index) <= anchor.top + anchor.height
      if (!wasVisible || anchor.top !== next.top) { previous!.anchor = undefined; return }
      ensureVisible(rows, index, true)
    } else if (!same) ensureVisible(rows, index, true)
    followed.current = { query: activeQueryId, connection: activeConnectionId, anchor: next }
  }, [activeQueryId, activeConnectionId, follow, layout, rows, ensureVisible, view, bands.height])
  // Selecting can publish rows that arrived since the last render, which moves the row: its index is read from them. A
  // selection made outside the tree (Filter Settings closing) asks for the same through the snapshot's `reveal`.
  const revealed = useRef(snapshot.reveal)
  useLayoutEffect(() => {
    const requested = snapshot.reveal !== revealed.current
    revealed.current = snapshot.reveal
    const id = reveal.current ?? (requested ? selected : undefined)
    reveal.current = undefined
    if (id !== undefined) { releaseFollow(); ensureVisible(rows, rowIndex(rows, id)) }
  })
  const run = useCallback((id: Parameters<typeof commands.execute>[0], rowId: number) => {
    const node = explorer.menuNode(rowId)
    if (node) void commands.execute(id, { target: { kind: 'explorer', node } }, 'toolbar')
  }, [commands, explorer])
  // Enter or a double-click on a node that does not expand runs its kind's default action, as SSMS opens a package's Properties.
  const activate = useCallback((rowId: number) => {
    const verb = ssisDefaultVerb(explorer.menuNode(rowId)?.kind)
    if (verb) run(ssisVerbSpecs[verb].command, rowId)
  }, [explorer, run])
  const actions = useMemo<RowActions>(() => ({
    select: rowId => { explorer.select(rowId); element.current?.focus({ preventScroll: true }) },
    toggle: rowId => explorer.toggle(rowId),
    activate,
    reconnect: rowId => run('connection.reconnect', rowId),
    remove: rowId => run('connection.removeLost', rowId),
    // The text goes as plain text too, so other apps take it; the query editor accepts only the Varia type.
    dragStart: (rowId, transfer) => {
      const text = explorer.insertText(rowId)
      if (text === undefined || text.length > maxDropText) return false
      transfer.effectAllowed = 'copy'
      transfer.setData('text/plain', text)
      transfer.setData(explorerDragType, JSON.stringify({ v: 1, text }))
      return true
    },
    // Enter and Escape return focus to the tree; leaving the box for elsewhere does not take it back.
    commitRename: async (rowId, text, refocus) => {
      const node = explorer.menuNode(rowId)
      if (!node) { objectActions.cancelRename(); return true }
      if (refocus) element.current?.focus({ preventScroll: true })
      return objectActions.commitRename(node, text)
    },
    cancelRename: refocus => {
      objectActions.cancelRename()
      if (refocus) element.current?.focus({ preventScroll: true })
    },
    peekHover: (rowId, held) => {
      if (held && gestures.matches('explorer.peekHover', held)) peek.hover(explorer.menuNode(rowId))
      else peek.cancelHover()
    },
    click: (rowId, event) => {
      if (!gestures.matches('explorer.openPeekTab', event)) return
      // Ctrl resting on the row may have opened the card already: the tab takes its place.
      peek.cancelHover()
      if (peek.getSnapshot().open?.source === 'hover') peek.close()
      run('explorer.openPeekTab', rowId)
    }
  }), [explorer, run, activate, objectActions, peek, gestures])
  // Rows are menu targets: right-click has selected the row; Shift+F10 asks for the active descendant's menu.
  const rowTarget = useMenuTarget<HTMLDivElement>(row => {
    const node = explorer.menuNode(Number(row.getAttribute('data-row-id')))
    return node ? { kind: 'explorer', node } : null
  })

  /** Acts on `current`, the rows the action was worked out from. */
  const act = (action: TreeAction, current: VisibleRows) => {
    switch (action.type) {
      case 'select': {
        const id = current.ids[action.index]
        if (explorer.getSnapshot().selected === id) { const now = explorer.getSnapshot().rows; ensureVisible(now, rowIndex(now, id)) }
        else { reveal.current = id; explorer.select(id) }
        return
      }
      case 'expand': explorer.expand(action.id); return
      case 'collapse': explorer.collapse(action.id); return
      case 'toggle': explorer.toggle(action.id); return
      case 'expandSiblings': explorer.expandSiblings(action.id); return
      case 'retry': explorer.retry(action.id); return
      case 'continue': explorer.continueLoading(action.id); return
      case 'filter': run('explorer.filter', action.id); return
      case 'activate': activate(action.id); return
      default: return
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    try {
      // Rows the previous key changed may not have rendered yet: the service publishes them now, so Right, Right expands
      // a folder and then enters it rather than asking to expand it twice.
      const now = explorer.settle(), current = now.rows, index = rowIndex(current, now.selected)
      const key = treeKeyOf(event.nativeEvent)
      if (key) {
        event.preventDefault()
        typing.clear(); markTypeAhead()
        const node = index >= 0 ? current.nodes[index] : undefined
        // Enter on a lost server reconnects it, as its button does.
        if (key === 'enter' && node?.lost) { run('connection.reconnect', node.id); return }
        act(treeKey(current, index, key, Math.max(1, Math.floor(bands.height / rowHeight))), current)
        return
      }
      if (event.key === 'Escape' && typing.value) { typing.clear(); markTypeAhead(); event.preventDefault(); return }
      if (event.key === 'Escape' && peek.getSnapshot().open) { peek.close(); event.preventDefault(); return }
      const text = typing.accept(event.nativeEvent)
      if (text === undefined) {
        // Space is Peek's catalogue key (explorer.peek); the tree swallows the Space it leaves, Shift+Space included.
        if (swallowedKey(event.nativeEvent)) event.preventDefault()
        return
      }
      markTypeAhead()
      event.preventDefault()
      const found = typeAhead(current, index, text)
      if (found >= 0) act({ type: 'select', index: found }, current)
    } catch (error) { onUnexpectedError(error) }
  }

  // Ctrl+C, ⌘C and Edit › Copy reach the focused tree as a copy event: the selected node's name, as Copy Name copies it.
  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    try {
      const { selected: id } = explorer.getSnapshot()
      const text = id === undefined ? undefined : explorer.copyText(id)
      if (text === undefined) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', text)
    } catch (error) { onUnexpectedError(error) }
  }

  const accents = useMemo(() => new Map(servers.map(server => [server.id, server.color])), [servers])
  const environments = useMemo(() => new Map(servers.map(server => [server.id, server.options.environment])), [servers])
  const indices = renderedIndices(layoutWindow(view.top, view.height, layout), selectedIndex)
  const active = selected !== undefined && selectedIndex >= 0 ? `oe-${selected}` : undefined
  const pinned = (edge: 'top' | 'bottom') => {
    const { height } = bands[edge]
    if (!height) return null
    return <ExplorerPinnedBand edge={edge} band={bands[edge]} onWheel={scrollPinnedBand} renderServer={(index, menu, top) => {
      const node = rows.nodes[index]!
      return <PinnedServerRow key={node.id} node={node} edge={edge} current={edge === 'top' && bands.current === index} menu={menu} top={top}
        active={node.connectionId === activeConnectionId} color={accents.get(node.connectionId)} environment={environments.get(node.connectionId)}
        status={rowStatus(statuses.get(node.connectionId), node)} jump={() => {
          actions.select(node.id)
          const now = explorer.getSnapshot().rows
          ensureVisible(now, rowIndex(now, node.id), true)
        }} />
    }} />
  }
  return <div ref={frame} className="explorer-tree-frame" style={{ '--explorer-tree-height': `${bands.height}px`, '--explorer-tree-width': `${view.width}px`, '--explorer-scrollbar-height': `${view.scrollbar}px` } as CSSProperties}
    onPointerDownCapture={releaseFollow} onWheelCapture={releaseFollow} onKeyDownCapture={releaseFollow}
    onFocusCapture={event => { focusedPin.current = event.target.closest('.explorer-pin-band') ? event.target : undefined }}
    onBlurCapture={event => {
      if (event.relatedTarget && event.relatedTarget !== event.currentTarget.ownerDocument.body) focusedPin.current = undefined
    }}>
    {pinned('top')}
    <div ref={element} className="explorer-tree" style={{ scrollPaddingTop: bands.top.height, scrollPaddingBottom: bands.bottom.height }} role="tree" aria-label="Object Explorer" tabIndex={0} data-explorer-tree data-pane-focus aria-activedescendant={active}
      aria-busy={explorerLoading} onKeyDown={onKeyDown} onCopy={onCopy}>
      <div className="explorer-spacer" style={{ height: layout.total }}>
        {indices.map(index => {
          const rowId = rows.ids[index], kind = rows.kinds[index] as RowKind, node = rows.nodes[index]
          return <ExplorerRow key={rowId} rowId={rowId} kind={kind} top={layout.top(index)} level={rows.levels[index]} posinset={rows.posinset[index]} setsize={rows.setsize[index]}
            node={node} rev={node?.rev ?? 0} text={kind === RowKind.Node ? '' : explorer.rowText(rowId)} selected={rowId === selected} draggable={kind === RowKind.Node && explorer.canInsert(rowId)}
            active={!!node && node.parent === 0 && node.connectionId === activeConnectionId} color={node?.parent === 0 ? accents.get(node.connectionId) : undefined} environment={node?.parent === 0 ? environments.get(node.connectionId) : undefined}
            actions={actions} menuTarget={rowTarget} renaming={renaming !== undefined && rowId === renaming}
            status={kind === RowKind.Node && node ? rowStatus(statuses.get(node.connectionId), node) : undefined} />
        })}
      </div>
    </div>
    {/* Keyed by the announcement, so the same sentence again is a new node, which screen readers speak again. */}
    <div className="visually-hidden" role="status">{announcement && <span key={announcement.id}>{announcement.text}</span>}</div>
    {pinned('bottom')}
  </div>
}
