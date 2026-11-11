import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { liveProbes, type LiveProbeId, type LiveTone } from '../../../shared/live/catalog'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { GridView, type GridStatus } from '../grid/GridView'
import type { LiveGridControls } from '../menus/targets'
import { useMenuTarget } from '../menus/useMenuTarget'
import { formatCount, plural } from '../results/status'
import { LiveGrid, liveGridText, type LiveGridSnapshot, type LiveGridState } from './LiveGrid'
import type { LiveHandle } from './LiveService'

/** Where a header funnel's popover opens, and for which column (its catalogue id and caption). */
export interface LiveColumnFilterTarget {
  readonly column: string
  readonly caption: string
  readonly anchor: DOMRect
  /** The grid it filters: the popover opens in that grid's window. */
  readonly grid: HTMLElement
  onClose(refocus?: boolean): void
}
/**
 * Value filters the owner sends to the backend as the source's args: the headers of `columns` get a funnel (filled for
 * `filtered`), and a funnel, Alt+Down or Filter Column Values… opens `popover` (LiveColumnFilterPopover, as a results
 * grid's funnel opens ColumnFilterPopover).
 */
export interface LiveColumnFilter {
  /** Catalogue column ids the source filters by value. */
  readonly columns: readonly string[]
  /** Catalogue column ids with a filter on. */
  readonly filtered: readonly string[]
  popover(target: LiveColumnFilterTarget): ReactNode
}

export interface LiveGridPaneProps {
  readonly live: LiveHandle
  readonly probe: LiveProbeId
  /** The table's index in the probe's catalogue entry. */
  readonly table?: number
  /** The grid's accessible name ("Sessions"), which its label starts with ("Sessions, 12 rows, 9 columns"); read when the grid is built. */
  readonly label: string
  /** What a screen reader hears for a toned row ("blocked"). */
  readonly toneLabel?: (tone: LiveTone) => string | undefined
  /** Scroll, widths and selection, and where the live grid was (follow tail, rows seen, the selected rows' keys), kept by
   *  the owner across remounts; the pane keeps its own otherwise. */
  readonly state?: LiveGridState
  /** The new-rows button's text for a count; "n new rows · Jump to latest" by default (an SSIS log names messages). */
  newRowsLabel?(count: number): string
  /** The LiveGrid, for the owner's commands (sort, copy, save) and its snapshot (the selection and the active row's key);
   *  undefined once the pane unmounts. */
  onGrid?(grid: LiveGrid | undefined): void
  /** Header funnels for the columns the source filters; none without it. Its presence is read when the grid is built. */
  readonly columnFilter?: LiveColumnFilter
  /** The live grid's context menu (liveGrid.context); false for an owner with a menu of its own (SSIS Operations). */
  readonly contextMenu?: boolean
}

const defaultNewRows = (count: number) => `${formatCount(count)} new ${plural(count, 'row')} · Jump to latest`
const indexesOf = (ids: readonly string[] | undefined, columns: readonly { readonly id: string }[]) =>
  new Set((ids ?? []).map(id => columns.findIndex(column => column.id === id)).filter(index => index >= 0))

/**
 * A live table in a grid: the React shell of a LiveGrid (root, scroller, strips, the "n new rows" button and the funnel's
 * popover). GridView renders and handles everything inside, as in a results grid (ResultGrid): the same header with its
 * sort buttons and funnels, selection, keys, column sizing and copy; the backend sorts and filters each sample. Until the
 * view's first sample the grid area is empty.
 */
export function LiveGridPane({ live, probe, table = 0, label, toneLabel, state, newRowsLabel = defaultNewRows, onGrid, columnFilter, contextMenu = true }: LiveGridPaneProps) {
  const { resultClient, platform, settings } = useWorkbench()
  const whitespace = useServiceSnapshot(settings).values['queryResults.grid.whitespace']
  const columns = liveProbes[probe]?.tables?.[table]?.columns ?? []
  const rootRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null), viewRef = useRef<GridView | undefined>(undefined)
  const [grid, setGrid] = useState<LiveGrid>()
  const [status, setStatus] = useState<GridStatus>({})
  const [notice, setNotice] = useState<string>()
  // The header funnel's popover, while open: its column and where it opens.
  const [funnel, setFunnel] = useState<{ readonly column: number; readonly anchor: DOMRect }>()
  const filterKey = columnFilter ? columnFilter.columns.join('\u001f') + '|' + columnFilter.filtered.join('\u001f') : ''
  // By content: owners build these lists each render.
  const filterable = useMemo(() => indexesOf(columnFilter?.columns, columns), [filterKey, columns])
  const filtered = useMemo(() => indexesOf(columnFilter?.filtered, columns), [filterKey, columns])
  const latest = useRef({ toneLabel, onGrid, whitespace, filterable, filtered, hasFilter: !!columnFilter })
  latest.current = { toneLabel, onGrid, whitespace, filterable, filtered, hasFilter: !!columnFilter }
  const report = (what: string) => (result: { ok: boolean; error?: string; code?: string } | undefined) =>
    setNotice(result && !result.ok && result.code !== 'CANCELLED' ? `Could not ${what}: ${result.error}` : undefined)
  useLayoutEffect(() => {
    const own: LiveGridState = state ?? { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    const created: LiveGrid = new LiveGrid({
      live, probe, table, state: own, api: window.varia,
      createView: (first, hooks) => {
        const now = latest.current
        const view = new GridView({
          root: rootRef.current!, scroller: scrollRef.current!, handle: first.handle, client: resultClient, descriptor: first.descriptor, state: own,
          // No SQL type hints: a live catalogue's columns name a type without its length, so a header would invent one
          // ("nvarchar(max)"), and live views follow SSMS's monitors, whose headers are names alone.
          resultIndex: 0, resultCount: 1, label, platform, followTail: first.mode === 'append', showTypes: false, clipboardKeys: true, whitespace: now.whitespace,
          onSelection: hooks.onSelection, onViewport: hooks.onViewport,
          onCopy: headers => { void created.copy(!!headers).then(report('copy the rows'), onUnexpectedError) },
          onEscape: () => false,
          onStatus: setStatus,
          onError: onUnexpectedError,
          toneLabel: tone => latest.current.toneLabel?.(tone),
          // The header sorts a snapshot table as a results grid's does; the backend sorts each sample (the probe's sort).
          ...first.mode === 'snapshot' ? { onSort: (column: number, add: boolean) => created.cycleSort(column, add) } : {},
          ...now.hasFilter ? {
            filterable: now.filterable, filtered: now.filtered,
            // A press on the open column's funnel closes its popover, as pressing a menu's button again does.
            onFilter: (column: number, anchor: DOMRect) => setFunnel(current => current?.column === column ? undefined : { column, anchor })
          } : {}
        })
        viewRef.current = view
        return view
      }
    })
    setGrid(created)
    latest.current.onGrid?.(created)
    return () => {
      latest.current.onGrid?.(undefined)
      created.dispose()
      viewRef.current = undefined
      setFunnel(undefined)
    }
  }, [live, probe, table, state, resultClient, platform])
  const snapshot = useSyncExternalStore(grid?.subscribe ?? noSubscribe, grid?.getSnapshot ?? noSnapshot)
  // The header shows the sort the backend applies (the probe's), the funnels the owner's filters, the cells the setting's
  // white space; a view built after a change starts from them, and this keeps it current.
  const headerSort = useMemo(() => grid?.headerSort(snapshot.sort) ?? [], [grid, snapshot.sort])
  useEffect(() => { viewRef.current?.update({ resultCount: 1, sort: headerSort, whitespace, ...columnFilter ? { filterable, filtered } : {} }) }, [snapshot.table, headerSort, whitespace, filterable, filtered, !!columnFilter])
  const closeFunnel = useCallback((refocus = true) => {
    setFunnel(undefined)
    if (refocus) rootRef.current?.focus({ preventScroll: true })
  }, [])
  const openFunnel = (column: number) => {
    const view = viewRef.current
    if (view?.canFilter(column)) setFunnel({ column, anchor: view.filterAnchor(column) })
  }
  const activeColumn = () => viewRef.current?.currentSelection()?.active.column
  const controls: LiveGridControls = {
    label, sortable: !!grid?.sortable,
    activeColumn,
    canFilter: column => !!viewRef.current?.canFilter(column),
    copy: headers => { void grid?.copy(headers).then(report('copy the rows'), onUnexpectedError) },
    selectAll: () => viewRef.current?.selectAll(),
    sort: (column, descending) => grid?.sortBy(column, descending),
    fitColumn: column => viewRef.current?.fitColumn(column),
    filterColumn: openFunnel,
    save: () => { void grid?.save(label).then(report('save the rows'), onUnexpectedError) }
  }
  const menuRef = useMenuTarget<HTMLDivElement>(() => contextMenu && grid ? { kind: 'liveGrid', grid: controls } : null)
  const rootCallback = useCallback((element: HTMLDivElement | null) => { rootRef.current = element; if (contextMenu) menuRef(element) }, [menuRef, contextMenu])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest('button')) return
    // Alt+Down opens the active column's funnel, as output.filterColumnValues does in a results grid.
    if (event.key === 'ArrowDown' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && columnFilter) {
      const column = activeColumn()
      if (column !== undefined && viewRef.current?.canFilter(column)) { event.preventDefault(); event.stopPropagation(); openFunnel(column) }
      return
    }
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  // The grid can no longer read its rows: say why, rather than leave cells that read as loading.
  const gone = snapshot.lost ? liveGridText.lost : snapshot.released ? liveGridText[snapshot.released] : undefined
  const retry = () => viewRef.current?.retry()
  const funnelColumn = funnel && !gone ? columns[funnel.column] : undefined
  return <div className="rg-frame live-grid" data-live-probe={probe} data-live-table={table}>
    <div ref={rootCallback} className="results-grid rg" role="grid" tabIndex={0} aria-label={label} aria-multiselectable="true" aria-readonly="true" onKeyDown={keyDown}>
      <div ref={scrollRef} className="rg-scroll" tabIndex={-1} />
    </div>
    {snapshot.newRows > 0 && <button className="live-grid-new-rows" onClick={() => grid?.jumpToEnd()}>
      {newRowsLabel(snapshot.newRows)}
    </button>}
    {gone && <div className="rg-overlay" role="status">{gone}</div>}
    {!gone && status.renderError ? <div className="rg-strip error" role="status">These rows could not be displayed. <button onClick={retry}>Retry</button></div>
      : !gone && status.tileError ? <div className="rg-strip error" role="status">Some rows could not be loaded: {status.tileError} <button onClick={retry}>Retry</button></div>
        : notice ? <div className="rg-strip error" role="status">{notice}</div> : null}
    {funnel && funnelColumn && columnFilter && rootRef.current && <FunnelHost key={funnel.column}>
      {columnFilter.popover({ column: funnelColumn.id, caption: funnelColumn.name, anchor: funnel.anchor, grid: rootRef.current, onClose: closeFunnel })}
    </FunnelHost>}
  </div>
}

function FunnelHost({ children }: { readonly children: ReactNode }) { return <>{children}</> }

const noSubscribe = () => () => {}
const empty: LiveGridSnapshot = { newRows: 0, following: true, lost: false }
const noSnapshot = () => empty
