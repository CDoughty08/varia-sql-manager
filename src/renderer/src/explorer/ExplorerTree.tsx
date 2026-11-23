import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { explorerLimits } from '../../../shared/explorer/catalog.ts'
import { ssisDefaultVerb, ssisVerbSpecs } from '../../../shared/ssis/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import { observeResize, requestFrame } from '../core/windows'
import { useMenuTarget } from '../menus/useMenuTarget'
import { explorerDragType, explorerServerDragType, maxDropText, serverDragOf } from './drop'
import { explorerTargetDragType } from '../editor-groups/server-drop'
import type { Announcement } from './ExplorerService'
import { focusLost } from './ExplorerErrorBoundary'
import ExplorerPinnedBand from './ExplorerPinnedBand'
import ExplorerRow, { PinnedServerRow, recoveryLabel, type RowActions } from './ExplorerRow'
import { rowStatus } from './ExplorerStatusService'
import { childrenShown, lastDescendant, layoutWindow, pinnedServerBands, renderedIndices, revealChildrenScroll, revealPinnedScroll, rowIndex, RowKind, rowLayout, swallowedKey, treeKey, treeKeyOf, TypeAheadBuffer, typeAhead, type TreeAction, type VisibleRows } from './tree-model'

const { rowHeight } = explorerLimits
/** The live region speaks the latest announcement once things settle, as a screen reader cannot keep up with every page. */
const announceDelayMs = 500
/** Where a dragged server drops: above or below a server row; `end` (the background) draws the line below the tree's last row. */
interface DropMark { readonly rowId: number; readonly edge: 'before' | 'after'; readonly end?: true }
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
  const { explorer, commands, connections, actions: objectActions, explorerStatus, settings, menuTargets, peek, gestures, serverDrop } = useWorkbench()
  const snapshot = useServiceSnapshot(explorer)
  const { servers: statuses } = useServiceSnapshot(explorerStatus)
  const { explorerLoading } = useServiceSnapshot(explorer.context)
  const servers = useServiceSnapshot(connections)
  const { 'objectExplorer.pinnedServerHeadersTop': topLimit, 'objectExplorer.pinnedServerHeadersBottom': bottomLimit,
    'objectExplorer.followActiveQuery': follow, 'objectExplorer.autoExpandSingleChild': autoExpand } = useServiceSnapshot(settings).values
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
  /** The server row being dragged to a new place, and where it would drop (a ref too, for the drop handler). */
  const dragging = useRef<number | undefined>(undefined)
  const [dropAt, setDropAt] = useState<DropMark | undefined>(undefined)
  const dropMark = useRef<DropMark | undefined>(undefined)
  const setDropMark = useCallback((next: DropMark | undefined | ((mark: DropMark | undefined) => DropMark | undefined)) => {
    const value = typeof next === 'function' ? next(dropMark.current) : next
    if (value === dropMark.current) return
    dropMark.current = value
    setDropAt(value)
  }, [])
  // Peek on Hover's modifier held: the peek cursor over rows Peek describes. An attribute, so a press re-renders nothing.
  useEffect(() => {
    const apply = () => element.current?.toggleAttribute('data-peek-armed', peek.armed.getSnapshot())
    apply()
    const unsubscribe = peek.armed.subscribe(apply)
    // A row that unmounts gets no mouseleave: a pointer resting on the tree as it goes would stay Peek's pointer row.
    return () => { unsubscribe(); peek.pointer(undefined) }
  }, [peek])
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

  // Another query tab is where the user went: an expand still loading neither scrolls the tree back nor reveals its end.
  // Only a switch counts, not the tab's connection dropping or coming back, nor the tree mounting.
  const heldForQuery = useRef(activeQueryId)
  useLayoutEffect(() => {
    if (heldForQuery.current === activeQueryId) return
    heldForQuery.current = activeQueryId
    explorer.holdOpening()
  }, [explorer, activeQueryId])
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
  // After the user's expand, the children come into view as they arrive, as far as they fit below the expanded row (the
  // node an auto-expand reached). Scrolling or clicking elsewhere stops it; so does selecting another row (the service).
  useLayoutEffect(() => {
    const opening = explorer.opening
    if (!opening) return
    const tree = element.current, index = rowIndex(rows, opening.id)
    if (!tree || index < 0) return
    const last = lastDescendant(rows, index)
    const destination = revealChildrenScroll(layout, index, last, tree.scrollTop, tree.clientHeight, topLimit, bottomLimit)
    if (destination !== undefined) { releaseFollow(); tree.scrollTop = destination; measure() }
    // The service is ahead of the rows rendered: its page may be in while the rows still show the loading row. An error
    // row is what the expand shows, and ends it too.
    if (opening.settled && childrenShown(rows, index)) explorer.endOpening()
  })
  const holdOpening = useCallback(() => explorer.holdOpening(), [explorer])
  // A layout effect: the walk stops as the change commits, before a page that arrives after it can walk on.
  useLayoutEffect(() => { if (!autoExpand) explorer.stopChain() }, [explorer, autoExpand])
  const run = useCallback((id: Parameters<typeof commands.execute>[0], rowId: number) => {
    const node = explorer.menuNode(rowId)
    if (node) void commands.execute(id, { target: { kind: 'explorer', node } }, 'toolbar')
  }, [commands, explorer])
  // Enter or a double-click on a node that does not expand runs its kind's default action, as SSMS opens a package's Properties.
  const activate = useCallback((rowId: number) => {
    const node = explorer.menuNode(rowId)
    if (node?.lost && node.kind === 'server') { run('connection.reconnect', rowId); return }
    // Job Activity Monitor's node opens its document (KindSpec.opens); the command is registered only behind agentEnabled.
    if (node?.kind === 'agentJobActivity') { run('agent.jobActivity', rowId); return }
    // A job opens its document (AG-6a), as SSMS opens Job Properties; Properties is refused without the release gate.
    if (node?.kind === 'agentJob') { run('explorer.properties', rowId); return }
    // A proxy and a credential open their documents (AG-8b), behind the same gate.
    if (node?.kind === 'agentProxy' || node?.kind === 'credential') { run('explorer.properties', rowId); return }
    const verb = ssisDefaultVerb(node?.kind)
    if (verb) run(ssisVerbSpecs[verb].command, rowId)
  }, [explorer, run])
  const actions = useMemo<RowActions>(() => ({
    select: rowId => { explorer.endOpen(); explorer.select(rowId); element.current?.focus({ preventScroll: true }) },
    toggle: rowId => explorer.toggleOpen(rowId, autoExpand),
    activate,
    reconnect: rowId => run('connection.reconnect', rowId),
    remove: rowId => run('connection.removeFromExplorer', rowId),
    // The text goes as plain text too, so other apps take it; the query editor accepts only the Varia type. A server row
    // also carries its own type when there are servers to reorder among, and a connected server or database row carries
    // the retarget type: dropped on a query's tab or editor it moves the query there (ServerDropService).
    dragStart: (rowId, transfer) => {
      // A drag whose dragend never arrived (its row unmounted mid-drag) must not carry over into this one.
      dragging.current = undefined
      serverDrop.end()
      const node = explorer.menuNode(rowId), target = node && (node.kind === 'server' || node.kind === 'database') ? explorer.queryTarget(rowId) : undefined
      const connection = target && connections.get(target.connectionId)
      const reorder = (explorer.serverPlace(rowId)?.count ?? 0) > 1
      // A server inserts its name (Ctrl over a query's editor), as its databases insert theirs.
      const text = explorer.insertText(rowId) ?? (node?.kind === 'server' ? connection?.server : undefined), insertable = text !== undefined && text.length <= maxDropText
      if (!reorder && !connection && !insertable) return false
      if (reorder) { dragging.current = rowId; transfer.setData(explorerServerDragType, '') }
      if (connection && target) {
        transfer.setData(explorerTargetDragType, '')
        serverDrop.start({ connectionId: connection.id, ...target.database ? { database: target.database } : {}, label: target.database ?? connection.displayName ?? connection.server, server: connection.displayName ?? connection.server })
      }
      if (reorder || connection) peek.cancelHover()
      if (insertable) { transfer.setData('text/plain', text); transfer.setData(explorerDragType, JSON.stringify({ v: 1, text })) }
      transfer.effectAllowed = reorder || connection ? insertable ? 'copyMove' : 'move' : 'copy'
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
    // The lower half of the tree's last row, of any kind, drops a server last like the background below it: a tree that
    // fills its pane scrolled to the end has no background left.
    dragOver: (rowId, edge, event) => {
      const from = serverDragOf(event, dragging.current), rows = explorer.getSnapshot().rows, last = explorer.rootIds.at(-1)
      const end = edge === 'after' && last !== undefined && rows.count > 0 && rows.ids[rows.count - 1] === rowId
      if (from === undefined || (!end && !explorer.serverPlace(rowId))) { setDropMark(undefined); return }
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      if (end) setDropMark(mark => mark?.end && mark.rowId === last ? mark : { rowId: last, edge: 'after', end: true })
      else setDropMark(mark => mark?.rowId === rowId && mark.edge === edge && !mark.end ? mark : { rowId, edge })
    },
    dragEnd: () => { dragging.current = undefined; setDropMark(undefined); serverDrop.end() },
    // The pointer's row stays known while it rests, so pressing Peek on Hover's modifier peeks it without a move.
    peekHover: (rowId, held) => {
      if (held) peek.pointer(() => explorer.menuNode(rowId), gestures.matches('explorer.peekHover', held))
      else peek.pointer(undefined)
    },
    click: (rowId, event) => {
      if (!gestures.matches('explorer.openPeekTab', event)) return
      // Ctrl resting on the row may have opened the card already: the tab takes its place.
      peek.cancelHover()
      if (peek.getSnapshot().open?.source === 'hover') peek.close()
      run('explorer.openPeekTab', rowId)
    }
  }), [explorer, run, activate, objectActions, peek, gestures, setDropMark, autoExpand, serverDrop, connections])
  // The background below the last row drops a server last, and its line shows that: below the tree's last row, which is
  // the last server's last child when it is expanded. Rows mark themselves (actions.dragOver);
  // an outer drop target (the dock panel) may have called preventDefault already, so a row is told apart by the target.
  // Beside the rows, the tree itself is under the pointer only on its scrollbar, where no line would show: no drop there.
  const dragOverTree = (event: DragEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest?.('[role="treeitem"]')) return
    const from = serverDragOf(event, dragging.current), last = explorer.rootIds.at(-1)
    const rowsEnd = event.currentTarget.firstElementChild?.getBoundingClientRect().bottom ?? -Infinity
    if (from === undefined || last === undefined || event.clientY < rowsEnd) { setDropMark(undefined); return }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setDropMark(mark => mark?.end && mark.rowId === last ? mark : { rowId: last, edge: 'after', end: true })
  }
  // Releasing drops where the line is, whichever element is under the pointer: a row, its edge or the background.
  const dropOnTree = (event: DragEvent<HTMLDivElement>) => {
    const from = serverDragOf(event, dragging.current), mark = dropMark.current
    dragging.current = undefined
    setDropMark(undefined)
    if (from === undefined || !mark) return
    event.preventDefault()
    const others = explorer.rootIds.filter(id => id !== from), at = others.indexOf(mark.rowId)
    if (at >= 0) explorer.moveServer(from, at + (mark.edge === 'after' ? 1 : 0))
  }
  // Rows are menu targets: right-click has selected the row; its menu returns focus to the tree, including from inner actions.
  const rowTarget = useMenuTarget<HTMLDivElement>(row => {
    const node = explorer.menuNode(Number(row.getAttribute('data-row-id')))
    return node ? { kind: 'explorer', node } : null
  }, () => element.current ?? undefined)

  /** Acts on `current`, the rows the action was worked out from. */
  const act = (action: TreeAction, current: VisibleRows) => {
    switch (action.type) {
      case 'select': {
        const id = current.ids[action.index]
        if (explorer.getSnapshot().selected === id) { const now = explorer.getSnapshot().rows; ensureVisible(now, rowIndex(now, id)) }
        else { reveal.current = id; explorer.select(id) }
        return
      }
      case 'expand': explorer.open(action.id, autoExpand); return
      case 'collapse': explorer.close(action.id); return
      case 'toggle': explorer.toggleOpen(action.id, autoExpand); return
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
    onPointerDownCapture={() => { releaseFollow(); holdOpening() }} onWheelCapture={() => { releaseFollow(); holdOpening() }} onKeyDownCapture={releaseFollow}
    onFocusCapture={event => { focusedPin.current = event.target.closest('.explorer-pin-band') ? event.target : undefined }}
    onBlurCapture={event => {
      if (event.relatedTarget && event.relatedTarget !== event.currentTarget.ownerDocument.body) focusedPin.current = undefined
    }}>
    {pinned('top')}
    <div ref={element} className="explorer-tree" style={{ scrollPaddingTop: bands.top.height, scrollPaddingBottom: bands.bottom.height }} role="tree" aria-label="Object Explorer" tabIndex={0} data-explorer-tree data-pane-focus aria-activedescendant={active}
      aria-busy={explorerLoading} onKeyDown={onKeyDown} onCopy={onCopy}
      onDragOver={dragOverTree} onDrop={dropOnTree}
      // A server drag out of the tree leaves no drop line behind.
      onDragLeave={(event: DragEvent) => { if (dropMark.current && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropMark(undefined) }}>
      <div className="explorer-spacer" style={{ height: layout.total }}>
        {indices.map(index => {
          const rowId = rows.ids[index], kind = rows.kinds[index] as RowKind, node = rows.nodes[index]
          const recovery = kind === RowKind.Node ? undefined : treeKey(rows, index, 'enter', 1)
          const label = recovery && recoveryLabel(recovery)
          return <ExplorerRow key={rowId} rowId={rowId} kind={kind} top={layout.top(index)} level={rows.levels[index]} posinset={rows.posinset[index]} setsize={rows.setsize[index]}
            node={node} rev={node?.rev ?? 0} text={kind === RowKind.Node ? '' : explorer.rowText(rowId)} selected={rowId === selected} draggable={kind === RowKind.Node && (explorer.canInsert(rowId) || (explorer.serverPlace(rowId)?.count ?? 0) > 1 || (node?.kind === 'server' && explorer.queryTarget(rowId) !== undefined))}
            active={!!node && node.parent === 0 && node.connectionId === activeConnectionId} color={node?.parent === 0 ? accents.get(node.connectionId) : undefined} environment={node?.parent === 0 ? environments.get(node.connectionId) : undefined}
            actions={actions} menuTarget={rowTarget} renaming={renaming !== undefined && rowId === renaming}
            status={kind === RowKind.Node && node ? rowStatus(statuses.get(node.connectionId), node) : undefined}
            recovery={label && recovery ? { label, run: () => act(recovery, rows) } : undefined} drop={dropAt?.end ? (index === rows.count - 1 ? 'after' : undefined) : dropAt?.rowId === rowId ? dropAt.edge : undefined} />
        })}
      </div>
    </div>
    {/* Keyed by the announcement, so the same sentence again is a new node, which screen readers speak again. */}
    <div className="visually-hidden" role="status">{announcement && <span key={announcement.id}>{announcement.text}</span>}</div>
    {pinned('bottom')}
  </div>
}
