import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { liveProbes, type LiveProbeId, type LiveTone } from '../../../shared/live/catalog'
import type { LiveFacet } from '../../../shared/live/schema'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import GridShell, { GridErrorBoundary, instanceKey, type GridFunnels, type GridShellApi, type GridSpec } from '../grid/GridShell'
import type { GridView } from '../grid/GridView'
import { registerLiveOutput, type LiveOutput } from '../menus/targets'
import { formatCount, plural } from '../results/status'
import { liveFilterSource, type LiveValueFilter } from './live-filter'
import { LiveGrid, liveGridText, type LiveGridSnapshot, type LiveGridState } from './LiveGrid'
import type { LiveHandle } from './LiveService'

/**
 * Value filters the owner sends to the backend as the source's args (an Activity Monitor pane's ActivityColumnFilter):
 * the headers of `columns` get the results grid's funnel, which opens ColumnFilterPopover over the source's facets.
 */
export interface LiveFilters {
  /** Catalogue column ids the source filters by value. */
  readonly columns: readonly string[]
  /** The filters on, by catalogue column id. */
  readonly filters: readonly ({ readonly column: string } & LiveValueFilter)[]
  /** A column's most frequent values in the last sample. */
  facet(column: string): LiveFacet | undefined
  /** A column's new filter; undefined takes it off. */
  apply(column: string, filter: LiveValueFilter | undefined): void
  /** Takes every column's filter off (Clear Filters). */
  clear(): void
  /** The most values one filter holds. */
  readonly maxValues: number
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
  readonly filters?: LiveFilters
  /**
   * Query Output's context menu and keys (view `live`: Ctrl+C, Ctrl+Shift+C, Ctrl+A, Ctrl+S, Alt+Down and Ctrl+F run the
   * catalogue's output.* commands, remappable in Shortcut Mapping); false for an owner with a menu of its own (SSIS
   * Operations), whose grid serves its own Ctrl+C, Ctrl+Shift+C and Ctrl+A.
   */
  readonly contextMenu?: boolean
  /** False for a table whose order is its meaning (Blocking's chains in tree order): no header sort, no Sort items. */
  readonly sortable?: boolean
  /** Find in Results (Ctrl+F) in this grid: the owner's own filter box, since a live view has no Find. */
  onFind?(): void
}

const defaultNewRows = (count: number) => `${formatCount(count)} new ${plural(count, 'row')} · Jump to latest`
const indexesOf = (ids: readonly string[], columns: readonly { readonly id: string }[]) =>
  new Set(ids.map(id => columns.findIndex(column => column.id === id)).filter(index => index >= 0))

/**
 * A live table in the results grid (GridShell, the shell ResultGrid mounts): the same header with its sort buttons and
 * funnels (ColumnFilterPopover), selection, keys, column sizing, copy and Query Output's menu. Only the source differs: a
 * LiveGrid swaps in each revision (key-stable selection, tones, follow tail), the backend sorts and filters each sample by
 * the source's args, and the grid says so when its rows are gone. This adds the "n new rows" button. Until the view's
 * first sample the grid area is empty.
 */
function LiveGridBody({ live, probe, table = 0, label, toneLabel, state, newRowsLabel = defaultNewRows, onGrid, filters, contextMenu = true, sortable = true, onFind }: LiveGridPaneProps) {
  const { commands } = useWorkbench()
  const columns = liveProbes[probe]?.tables?.[table]?.columns ?? []
  const [grid, setGrid] = useState<LiveGrid>()
  const [notice, setNotice] = useState<string>()
  const apiRef = useRef<GridShellApi | undefined>(undefined)
  const latest = useRef({ toneLabel, onGrid, filters, label, onFind })
  latest.current = { toneLabel, onGrid, filters, label, onFind }
  const report = useCallback((what: string) => (result: { ok: boolean; error?: string; code?: string } | undefined) =>
    setNotice(result && !result.ok && result.code !== 'CANCELLED' ? `Could not ${what}: ${result.error}` : undefined), [])
  const mount = (create: (spec: GridSpec) => GridView) => {
    const own: LiveGridState = state ?? { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    const created: LiveGrid = new LiveGrid({
      live, probe, table, state: own, api: window.varia,
      createView: (first, hooks) => create({
        handle: first.handle, descriptor: first.descriptor, state: own,
        // No SQL type hints: a live catalogue's columns name a type without its length, so a header would invent one
        // ("nvarchar(max)"), and live views follow SSMS's monitors, whose headers are names alone.
        resultIndex: 0, resultCount: 1, label, followTail: first.mode === 'append', showTypes: false,
        // With Query Output's menu its keys are the catalogue's (outputGridFocus); without, the grid serves its own.
        clipboardKeys: !contextMenu,
        // The header sorts a snapshot table as a results grid's does; the backend sorts each sample (the probe's sort).
        sortable: sortable && first.mode === 'snapshot',
        onSelection: hooks.onSelection, onViewport: hooks.onViewport,
        // Edit › Copy's copy event: output.copy, as in a results grid, or the grid's own copy without the menu.
        onCopy: headers => {
          if (contextMenu) void commands.execute(headers ? 'output.copyWithHeaders' : 'output.copy', undefined, 'keybinding')
          else void created.copy(!!headers).then(report('copy the rows'), onUnexpectedError)
        },
        onEscape: () => false,
        toneLabel: tone => latest.current.toneLabel?.(tone)
      })
    })
    setGrid(created)
    latest.current.onGrid?.(created)
    return () => {
      latest.current.onGrid?.(undefined)
      created.dispose()
      setGrid(undefined)
    }
  }
  const snapshot = useSyncExternalStore(grid?.subscribe ?? noSubscribe, grid?.getSnapshot ?? noSnapshot)
  // The header shows the sort the backend applies (the probe's).
  const headerSort = useMemo(() => grid?.headerSort(snapshot.sort) ?? [], [grid, snapshot.sort])
  const filterKey = filters ? filters.columns.join('\u001f') + '|' + filters.filters.map(item => item.column).join('\u001f') : undefined
  // By content: owners build these lists each render.
  const funnels = useMemo<GridFunnels | undefined>(() => filters && {
    filterable: indexesOf(filters.columns, columns),
    filtered: indexesOf(filters.filters.map(item => item.column), columns),
    columnName: column => columns[column]?.name,
    source: liveFilterSource({
      columnId: column => { const id = columns[column]?.id; return id && latest.current.filters?.columns.includes(id) ? id : undefined },
      facet: id => latest.current.filters?.facet(id),
      filterOf: id => latest.current.filters?.filters.find(item => item.column === id),
      apply: (id, filter) => latest.current.filters?.apply(id, filter),
      maxValues: filters.maxValues
    })
  }, [filterKey, columns])
  // Query Output's menu and commands, in this grid (OutputTarget view `live`).
  const output = useMemo<LiveOutput | undefined>(() => {
    if (!grid) return undefined
    const view = () => apiRef.current?.view()
    const rows = () => !!grid.shown && grid.shown.descriptor.rowsAvailable > 0 && columns.length > 0
    return {
      sortable: sortable && grid.sortable,
      filterable: !!latest.current.filters?.columns.length,
      hasRows: rows,
      hasSelection: () => rows() && !!view()?.currentSelection(),
      activeColumn: () => view()?.currentSelection()?.active.column,
      columnName: column => columns[column]?.name,
      canSort: column => sortable && grid.canSort(column),
      find: () => latest.current.onFind?.(),
      canFind: () => !!latest.current.onFind,
      canFilter: column => !!view()?.canFilter(column),
      sorted: () => (grid.getSnapshot().sort?.length ?? 0) > 0,
      filtered: () => (latest.current.filters?.filters.length ?? 0) > 0,
      copy: headers => { void grid.copy(headers).then(report('copy the rows'), onUnexpectedError) },
      selectAll: () => view()?.selectAll(),
      sort: (column, descending, add) => grid.sortBy(column, descending, add),
      clearSort: () => grid.sortBy(undefined),
      fitColumn: column => view()?.fitColumn(column),
      filterColumn: column => apiRef.current?.openFunnel(column),
      clearFilters: () => latest.current.filters?.clear(),
      save: () => { void grid.save(latest.current.label).then(report('save the rows'), onUnexpectedError) }
    }
  }, [grid, columns, report, sortable])
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEffect(() => output && root && contextMenu ? registerLiveOutput(root, output) : undefined, [output, root, contextMenu])
  const onApi = useCallback((api: GridShellApi | undefined) => { apiRef.current = api }, [])
  // The grid can no longer read its rows: say why, rather than leave cells that read as loading.
  const gone = snapshot.lost ? liveGridText.lost : snapshot.released ? liveGridText[snapshot.released] : undefined
  return <GridShell mountKey={`${probe}|${table}|${instanceKey(live)}|${state ? instanceKey(state) : 0}`} mount={mount} onApi={onApi} contents="rows"
    frameProps={{ className: 'live-grid', 'data-live-probe': probe, 'data-live-table': table }}
    rootProps={{ 'aria-label': label, ...contextMenu ? { 'data-output-view': 'live' } : {} }} rootRef={setRoot}
    sort={headerSort} onSort={(column, add) => grid?.cycleSort(column, add)} {...funnels ? { funnels } : {}}
    gone={gone} strip={notice ? { text: notice, error: true } : undefined} {...contextMenu ? {} : { whitespace: 'none' as const }}>
    {snapshot.newRows > 0 && <button className="live-grid-new-rows" onClick={() => grid?.jumpToEnd()}>{newRowsLabel(snapshot.newRows)}</button>}
  </GridShell>
}

/** A live table's grid: a throw while rendering it stays in its frame (GridErrorBoundary), whose Retry renders it again. */
export function LiveGridPane(props: LiveGridPaneProps) {
  return <GridErrorBoundary contents="rows" frameProps={{ className: 'live-grid', 'data-live-probe': props.probe, 'data-live-table': props.table ?? 0 }}><LiveGridBody {...props} /></GridErrorBoundary>
}

const noSubscribe = () => () => {}
const empty: LiveGridSnapshot = { newRows: 0, following: true, lost: false }
const noSnapshot = () => empty
