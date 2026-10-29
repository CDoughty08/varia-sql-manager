import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { explorerLimits } from '../../../shared/explorer/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import { useMenuTarget } from '../menus/useMenuTarget'
import { explorerDragType, maxDropText } from './drop'
import type { Announcement } from './ExplorerService'
import ExplorerRow, { type RowActions } from './ExplorerRow'
import { rowStatus } from './ExplorerStatusService'
import { layoutWindow, renderedIndices, revealScroll, rowIndex, RowKind, rowLayout, swallowedKey, treeKey, treeKeyOf, TypeAheadBuffer, typeAhead, type RowLayout, type TreeAction, type VisibleRows } from './tree-model'

const { rowHeight } = explorerLimits
/** The live region speaks the latest announcement once things settle, as a screen reader cannot keep up with every page. */
const announceDelayMs = 500

/**
 * Object Explorer's tree: one focusable element with `aria-activedescendant` over windowed rows (the selected row is
 * always rendered), so a folder of 100,000 items renders about 60 rows. Its keys follow the Windows tree SSMS uses:
 * arrows, Home and End, Page Up and Down, Enter, `*`, Numpad plus and minus, and type-ahead.
 */
export default function ExplorerTree({ activeConnectionId }: { readonly activeConnectionId?: string }) {
  const workbench = useWorkbench(), { explorer, commands, connections, actions: objectActions, explorerStatus } = workbench
  const snapshot = useServiceSnapshot(explorer)
  const { servers: statuses } = useServiceSnapshot(explorerStatus)
  const { explorerLoading } = useServiceSnapshot(explorer.context)
  const servers = useServiceSnapshot(connections)
  const renaming = useServiceSnapshot(explorer.renaming)
  const element = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState({ top: 0, height: 0 })
  const [announcement, setAnnouncement] = useState<Announcement | undefined>(undefined)
  // A sentence from before this tree mounted (a server since removed, or before a Reload) is not news.
  const heard = useRef(snapshot.announcement?.id)
  /** A row a key selected, scrolled into view once the rows it is among have rendered. */
  const reveal = useRef<number | undefined>(undefined)
  const typing = useMemo(() => new TypeAheadBuffer(), [])
  const { rows, selected } = snapshot
  const selectedIndex = rowIndex(rows, selected)
  const layout = useMemo(() => rowLayout(rows), [rows])
  const latest = useRef({ rows, selectedIndex, layout })
  latest.current = { rows, selectedIndex, layout }

  // Scrolling and resizing re-window on the next frame (or soon after, when frames are throttled).
  useLayoutEffect(() => {
    const tree = element.current
    if (!tree) return
    let pending = false
    const measure = () => { pending = false; setView(current => current.top === tree.scrollTop && current.height === tree.clientHeight ? current : { top: tree.scrollTop, height: tree.clientHeight }) }
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { if (pending) measure() })
      setTimeout(() => { if (pending) measure() }, 50)
    }
    measure()
    tree.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(tree)
    return () => { tree.removeEventListener('scroll', schedule); observer.disconnect() }
  }, [])
  useEffect(() => {
    const next = snapshot.announcement
    if (!next || next.id === heard.current) return
    const timer = setTimeout(() => { heard.current = next.id; setAnnouncement(next) }, announceDelayMs)
    return () => clearTimeout(timer)
  }, [snapshot.announcement])

  /** Scrolls row `index` of `rows` into view; rows published since the last render are laid out on the spot. */
  const ensureVisible = useCallback((rows: VisibleRows, index: number) => {
    const tree = element.current
    if (!tree || index < 0) return
    const at: RowLayout = latest.current.rows === rows ? latest.current.layout : rowLayout(rows)
    const scrollTop = revealScroll(at, index, tree.scrollTop, tree.clientHeight)
    if (scrollTop !== undefined) tree.scrollTop = scrollTop
  }, [])
  // Selecting can publish rows that arrived since the last render, which moves the row: its index is read from them. A
  // selection made outside the tree (Filter Settings closing) asks for the same through the snapshot's `reveal`.
  const revealed = useRef(snapshot.reveal)
  useLayoutEffect(() => {
    const requested = snapshot.reveal !== revealed.current
    revealed.current = snapshot.reveal
    const id = reveal.current ?? (requested ? selected : undefined)
    reveal.current = undefined
    if (id !== undefined) ensureVisible(rows, rowIndex(rows, id))
  })
  const run = useCallback((id: Parameters<typeof commands.execute>[0], rowId: number) => {
    const node = explorer.menuNode(rowId)
    if (node) void commands.execute(id, { target: { kind: 'explorer', node } }, 'toolbar')
  }, [commands, explorer])
  const actions = useMemo<RowActions>(() => ({
    select: rowId => { explorer.select(rowId); element.current?.focus({ preventScroll: true }) },
    toggle: rowId => explorer.toggle(rowId),
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
    }
  }), [explorer, run, objectActions])
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
        typing.clear()
        const node = index >= 0 ? current.nodes[index] : undefined
        // Enter on a lost server reconnects it, as its button does.
        if (key === 'enter' && node?.lost) { run('connection.reconnect', node.id); return }
        act(treeKey(current, index, key, Math.max(1, Math.floor((element.current?.clientHeight ?? 0) / rowHeight))), current)
        return
      }
      if (event.key === 'Escape' && typing.value) { typing.clear(); event.preventDefault(); return }
      const text = typing.accept(event.nativeEvent)
      if (text === undefined) {
        if (swallowedKey(event.nativeEvent)) event.preventDefault()
        return
      }
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
  const match = snapshot.filter?.text, partial = snapshot.filter?.partial
  const active = selected !== undefined && selectedIndex >= 0 ? `oe-${selected}` : undefined
  return <><div ref={element} className="explorer-tree" role="tree" aria-label="Object Explorer" tabIndex={0} data-explorer-tree data-pane-focus aria-activedescendant={active}
    aria-busy={explorerLoading} onKeyDown={onKeyDown} onCopy={onCopy}>
    <div className="explorer-spacer" style={{ height: layout.total }}>
      {indices.map(index => {
        const rowId = rows.ids[index], kind = rows.kinds[index] as RowKind, node = rows.nodes[index]
        return <ExplorerRow key={rowId} rowId={rowId} kind={kind} top={layout.top(index)} level={rows.levels[index]} posinset={rows.posinset[index]} setsize={rows.setsize[index]}
          node={node} rev={node?.rev ?? 0} text={kind === RowKind.Node ? '' : explorer.rowText(rowId)} selected={rowId === selected} draggable={kind === RowKind.Node && explorer.canInsert(rowId)}
          active={!!node && node.parent === 0 && node.connectionId === activeConnectionId} color={node?.parent === 0 ? accents.get(node.connectionId) : undefined} environment={node?.parent === 0 ? environments.get(node.connectionId) : undefined}
          actions={actions} menuTarget={rowTarget} renaming={renaming !== undefined && rowId === renaming} match={kind === RowKind.Node ? match : undefined} partial={kind === RowKind.Node && !!partial?.has(rowId)}
          status={kind === RowKind.Node && node ? rowStatus(statuses.get(node.connectionId), node) : undefined} />
      })}
    </div>
  </div>
  {/* Keyed by the announcement, so the same sentence again is a new node, which screen readers speak again. */}
  <div className="visually-hidden" role="status">{announcement && <span key={announcement.id}>{announcement.text}</span>}</div></>
}
