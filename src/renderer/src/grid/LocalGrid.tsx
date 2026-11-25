import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { maxClipboardText } from '../../../shared/contracts'
import { gridTarget } from './anchor'
import { boundTable, LocalCopyTooLarge, localCopyText, localTableLimits, type LocalTableData } from '../../../shared/results/local-table'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import { registerLiveOutput, type LiveOutput } from '../menus/targets'
import type { GridViewState } from '../results/ResultsService'
import { formatCount, plural } from '../results/status'
import { gridLimits as g } from './constants'
import GridShell, { GridErrorBoundary, instanceKey, type GridFunnels, type GridShellApi, type GridSpec } from './GridShell'
import type { GridView, HeaderSortKey } from './GridView'
import { keptRows, localFilterSource, noFilters, withFilter, type LocalFilters } from './local-filter'
import { localDescriptor, LocalSource, sortOrder, type LocalSortKey } from './local-source'
import { beginCopy, latestCopy } from './copy-generation'
import { scrollbarSize } from './scrollbar'
import { copyPlan } from './selection'
import { remapSelection } from './swap'
import { cycleSortKeys, sortKeysBy } from './sort-keys'

/**
 * `card`: a short list inside a card or panel (hover Peek, Session Details): as tall as its rows up to `maxRows`, then
 * it scrolls; no Save. `page`: a table that fills its area on a document page (Properties, a Peek tab); Save Results As.
 */
export type LocalGridPreset = 'card' | 'page'

export interface LocalGridProps {
  /** The rows as the surface shows them (display text: a masked value stays masked). A new object is a new table. */
  readonly table: LocalTableData
  /** The grid's accessible name ("Columns"), which its label starts with ("Columns, 7 rows, 6 columns"); a new one remounts the grid. */
  readonly label: string
  readonly preset: LocalGridPreset
  /** What the frame says when the table has no rows: the surface's own words ("No security predicates apply."). */
  readonly empty?: string
  /** Save Results As's suggested file name (a page's), without an extension. */
  readonly suggestedName?: string
  /** False for a table whose order is its meaning (a report's rows): no header sort, no Sort items. */
  readonly sortable?: boolean
  /** A card's tallest height in rows (12 by default), and a fitted page's. */
  readonly maxRows?: number
  /** A page as tall as its rows up to `maxRows`, as a card is, with room for its strip and a wide grid's scroll bar: a
   *  list among other content in a scrolling column (an SSIS properties list), where there is no area to fill. Keeps Save. */
  readonly fit?: boolean
  /** A card grid that owns a full-height panel (Peek Card's list tabs): fills its flex parent instead of sizing to its rows. */
  readonly fill?: boolean
  /** Scroll, widths and selection, kept by the owner across remounts; the grid keeps its own otherwise. */
  readonly state?: GridViewState
  /** Header funnels over the table's own values (a results grid's popover), filtering the rows in memory; Copy and Save
   *  write the rows the filters keep. Off by default: most local tables are a handful of rows. */
  readonly filterable?: boolean
  /** Called when the grid's active row changes (mapped to the table's own row index, or undefined). */
  readonly onActiveRow?: (row: number | undefined) => void
  /** Called when the user activates a row (Enter or double-click on a cell); returns true if handled. */
  readonly onActivateRow?: (row: number, column: number) => boolean | void
}

/** The most keys a local table sorts by, as a results view's. */
const maxSortKeys = 4
const cardRows = 12
/** An empty card's room under its header for the overlay that says so: `.rg-overlay`'s padding and a line of text. */
const cardEmpty = 48
/** Between a large copy's pages: the renderer paints and takes input while it formats. */
const yieldToEvents = () => new Promise<void>(resolve => setTimeout(resolve, 0))
/** The most a local copy writes, in UTF-8 bytes (never fewer than its characters): what the clipboard takes and a results
 *  grid's copy may be, whichever is less. Overlapping parts copy their rows again, past what the table holds. */
const localCopyBytes = Math.min(maxClipboardText, wire.jobs.copyBytes)
class CopySuperseded extends Error {}
const unsorted: readonly LocalSortKey[] = []
/** The sort an owner-kept state was saved with, so its selection and scroll come back over the rows they were in. */
const keptSorts = new WeakMap<GridViewState, { readonly columns: string; readonly keys: readonly LocalSortKey[] }>()
/** The filters an owner-kept state was saved with, as its sort. */
const keptFilters = new WeakMap<GridViewState, { readonly columns: string; readonly filters: LocalFilters }>()
type BoundTable = ReturnType<typeof boundTable>
/** The rows the filters keep, with their cut cells renumbered to the rows they are now; the table itself when none filter. */
function filteredTable(bound: BoundTable, filters: LocalFilters): BoundTable {
  const kept = keptRows(bound, filters)
  if (!kept) return bound
  const columns = bound.columns.length, cut = new Set<number>()
  if (bound.cut.size) kept.forEach((row, at) => { for (let column = 0; column < columns; column++) if (bound.cut.has(row * columns + column)) cut.add(at * columns + column) })
  const shown = { ...bound, rows: kept.map(row => bound.rows[row]), cut, cutCells: cut.size }
  keptOf.set(shown, kept)
  return shown
}
/** A filtered table's rows in the table it was cut from, so a row callback names the owner's own row. */
const keptOf = new WeakMap<object, readonly number[]>()
/** The owner's row of a source's drawn row (its sort, then its filters). */
const tableRow = (source: LocalSource, row: number): number => { const at = source.rowOf(row); return keptOf.get(source.table)?.[at] ?? at }
/** A table's columns, which its sort keys name: a table with other columns starts unsorted. */
const columnsOf = (table: LocalTableData) => table.columns.map(column => `${column.kind ?? ''}:${column.name}`).join('\u0000')

/**
 * A local table in the results grid (GridShell over GridView): rows the renderer already holds, never a backend result
 * (docs/architecture.md, Grid). Selection, keys, column sizing and Fit, header sort and Query Output's menu and commands
 * work as in a results grid; Copy and Save write the same text through the TypeScript twin of ResultTextWriter (copy
 * here, a save in main). The menu reaches it as a grid with its own source (OutputTarget view `live`, LiveOutput).
 */
function LocalGridBody({ table, label, preset, empty, suggestedName, sortable = true, maxRows = cardRows, fit = false, fill = false, state, filterable = false, onActiveRow, onActivateRow }: LocalGridProps) {
  const { commands, platform } = useWorkbench()
  const bound = useMemo(() => boundTable(table), [table])
  const columnsKey = useMemo(() => columnsOf(bound), [bound])
  // The keys belong to the columns they were chosen for: derived in render, so the mount that a new table causes
  // already sees a table with other columns unsorted.
  const [sorted, setSorted] = useState(() => (state && keptSorts.get(state)) ?? { columns: columnsKey, keys: unsorted })
  // A table with other columns starts unsorted, and one shown unsortable (a report's rows, in order) drops any sort: reset
  // there in render, so the sort does not come back with the old columns, nor with sorting, unchosen.
  if ((!sortable || sorted.columns !== columnsKey) && sorted.keys !== unsorted) setSorted({ columns: columnsKey, keys: unsorted })
  const keys = sortable && sorted.columns === columnsKey ? sorted.keys : unsorted
  const setKeys = useCallback((next: (current: readonly LocalSortKey[]) => readonly LocalSortKey[]) => setSorted(current => ({ columns: columnsKey, keys: next(current.columns === columnsKey ? current.keys : unsorted) })), [columnsKey])
  useEffect(() => { if (state) keptSorts.set(state, sorted) }, [state, sorted])
  // The column filters, kept as the sort is: they belong to the columns they were chosen for.
  const [filtering, setFiltering] = useState(() => (state && keptFilters.get(state)) ?? { columns: columnsKey, filters: noFilters })
  if ((!filterable || filtering.columns !== columnsKey) && filtering.filters !== noFilters) setFiltering({ columns: columnsKey, filters: noFilters })
  const filters = filterable && filtering.columns === columnsKey ? filtering.filters : noFilters
  useEffect(() => { if (state) keptFilters.set(state, filtering) }, [state, filtering])
  const setFilter = useCallback((column: number | undefined, filter?: Parameters<typeof withFilter>[2]) =>
    setFiltering(current => ({ columns: columnsKey, filters: column === undefined ? noFilters : withFilter(current.columns === columnsKey ? current.filters : noFilters, column, filter) })), [columnsKey])
  // What the grid shows: the rows the filters keep. The table itself still decides the grid's identity (its mount and kept state).
  const shown = useMemo(() => filteredTable(bound, filters), [bound, filters])
  // A copy's or save's notice belongs to the grid it was for: a new table shows its own strip (its truncation) again, except
  // under an owner-kept state, where a table with the same columns is the same grid's next sample.
  const noticeOwner: unknown = state ? columnsKey : bound
  const [noticed, setNoticed] = useState<{ readonly owner: unknown; readonly text: string; readonly error?: boolean }>()
  const notice = noticed?.owner === noticeOwner ? noticed : undefined
  const setNotice = useCallback((next?: { readonly text: string; readonly error?: boolean }) => setNoticed(next && { ...next, owner: noticeOwner }), [noticeOwner])
  const [wide, setWide] = useState(false)
  const apiRef = useRef<GridShellApi | undefined>(undefined)
  const sourceRef = useRef<LocalSource | undefined>(undefined)
  const own = useMemo<GridViewState>(() => state ?? { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }, [state, bound])
  const latest = useRef({ label, suggestedName, onActiveRow, onActivateRow })
  latest.current = { label, suggestedName, onActiveRow, onActivateRow }
  const rows = shown.rows.length, columns = shown.columns.length
  /** The keys the current source was sorted by. */
  const sourceKeys = useRef(keys)
  const reportActiveRow = (source: LocalSource | undefined, selection: { readonly active: { readonly row: number } } | undefined) => {
    const row = source && selection && selection.active.row >= 0 && selection.active.row < source.table.rows.length
      ? tableRow(source, selection.active.row)
      : undefined
    latest.current.onActiveRow?.(row)
  }
  const mount = (create: (spec: GridSpec) => GridView) => {
    // A kept state can come back over a table with fewer rows or columns (remounted after an owner's Refresh, or a table
    // with other columns; one with the same columns swaps in below): its selection is held to them, or Copy would copy
    // rows that are gone and keys would move from there.
    if (own.selection) own.selection = remapSelection(own.selection, row => row, rows, columns)
    const source = sourceRef.current = new LocalSource(shown, sortOrder(shown, keys), shown.cutCells, shown.cut)
    sourceKeys.current = keys
    // The card keeps the last view's width until this one reports its own on its first frame (GridView always does), so a
    // wide card does not shrink and grow back on each new table.
    const view = create({
      handle: source, descriptor: localDescriptor(shown, shown.cutCells), state: own, entry: 'local', resultNumber: 1, resultCount: 1, label: latest.current.label,
      showTypes: false, clipboardKeys: false, sortable, onWide: setWide,
      onSelection: selection => { reportActiveRow(sourceRef.current, selection) },
      // Edit › Copy's copy event: output.copy, as in a results grid.
      onCopy: headers => { void commands.execute(headers ? 'output.copyWithHeaders' : 'output.copy', undefined, 'keybinding') },
      onEscape: () => false
    })
    reportActiveRow(source, view.currentSelection())
    // GridShell leaves the view to its owner: disposed here, or its listeners and subscriptions outlive it.
    return () => { view.dispose(); sourceRef.current = undefined }
  }
  // A new sort swaps a source in the new order into the view, so the selection follows its rows. Under an owner-kept state a
  // new table with the same columns (a live chart's next sample) swaps in too, its selection where it was on screen: the view
  // and a drag, column resize or double-click under way survive it.
  useEffect(() => {
    const view = apiRef.current?.view(), old = sourceRef.current
    if (!view || !old || (sourceKeys.current === keys && old.table === shown)) return
    const order = sortOrder(shown, keys), sameTable = old.table === shown
    sourceKeys.current = keys
    const next = new LocalSource(shown, order, shown.cutCells, shown.cut), place = new Int32Array(rows)
    for (let row = 0; row < rows; row++) place[next.rowOf(row)] = row
    sourceRef.current = next
    // A filter keeps the selection where it was on screen, held to the rows left (remapSelection at the next mount does the same).
    view.swap(next, localDescriptor(shown, shown.cutCells), row => row < 0 || row >= rows ? -1 : sameTable ? place[old.rowOf(row)] : row)
    reportActiveRow(next, view.currentSelection())
  }, [shown, keys, rows])
  const sortBy = useCallback((column: number | undefined, descending = false, add = false) =>
    setKeys(current => column === undefined ? unsorted : sortKeysBy(current, column, descending ? 'descending' : 'ascending', add, maxSortKeys, desc => ({ column, descending: desc }))), [setKeys])
  const report = useCallback((what: string, error: unknown) => setNotice({ text: `Could not ${what}: ${error instanceof Error ? error.message : String(error)}`, error: true }), [setNotice])
  const output = useMemo<LiveOutput>(() => {
    const view = () => apiRef.current?.view()
    const hasRows = () => rows > 0 && columns > 0
    return {
      sortable, filterable,
      hasRows, hasSelection: () => hasRows() && !!view()?.currentSelection(),
      activeColumn: () => view()?.currentSelection()?.active.column,
      columnName: column => bound.columns[column]?.name,
      canSort: column => sortable && column >= 0 && column < columns,
      canFilter: column => filterable && column >= 0 && column < columns, sorted: () => keys.length > 0, filtered: () => filters.size > 0,
      // Copy and Save read the shown source's table and order together, never this render's table with a later order: a
      // menu opened before a new table holds this LiveOutput.
      copy: headers => {
        const source = sourceRef.current, selection = view()?.currentSelection()
        const parts = source && selection ? copyPlan(selection, source.table.columns.length) : []
        if (!source || !parts.length) return
        setNotice(undefined)
        // Only the latest copy, of any grid, writes the clipboard: one still formatting stops at its next page once a later
        // copy begins, and never overwrites it.
        const copy = beginCopy()
        const afterPage = async () => { await yieldToEvents(); if (!latestCopy(copy)) throw new CopySuperseded() }
        void localCopyText(source.table, parts, { headers, crlf: platform === 'win32', ...source.order ? { order: source.order } : {}, maxBytes: localCopyBytes, afterPage })
          .then(async copied => {
            if (!latestCopy(copy)) return
            const written = await window.varia.writeClipboardText(copied.text)
            if (!written.ok) report('copy the rows', written.error)
          })
          .catch(error => {
            if (error instanceof CopySuperseded || !latestCopy(copy)) return
            if (error instanceof LocalCopyTooLarge) setNotice({ text: `The selection is too large to copy (more than ${localCopyBytes / 1024 / 1024} MB).${preset === 'page' ? ' Use Save Results As instead.' : ''}`, error: true })
            else report('copy the rows', error)
          })
      },
      selectAll: () => view()?.selectAll(),
      sort: (column, descending, add) => sortBy(column, descending, add),
      clearSort: () => sortBy(undefined),
      fitColumn: column => view()?.fitColumn(column),
      filterColumn: column => { if (filterable) apiRef.current?.openFunnel(column) }, clearFilters: () => setFilter(undefined),
      canSave: () => preset === 'page',
      save: () => {
        const source = sourceRef.current
        if (preset !== 'page' || !source || source.table.rows.length === 0 || source.table.columns.length === 0) return
        const { table: shown, order } = source
        setNotice(undefined)
        void window.varia.saveLocalResults({ suggestedName: (latest.current.suggestedName || latest.current.label || 'Results').slice(0, wire.jobs.suggestedName), columns: shown.columns.map(column => ({ name: column.name, ...column.kind ? { kind: column.kind } : {} })), rows: (order ?? shown.rows.map((_, index) => index)).map(index => [...shown.rows[index]]) })
          .then(saved => {
            if (!saved.ok) report('save the rows', saved.error)
            else if (saved.value) setNotice({ text: `Saved ${formatCount(saved.value.rows)} ${plural(saved.value.rows, 'row')} to ${saved.value.fileName}.` })
          }, onUnexpectedError)
      },
      canFind: () => false, find: () => {}
    }
  }, [bound, rows, columns, keys, sortable, filterable, filters, setFilter, preset, platform, sortBy, report, setNotice])
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEffect(() => root ? registerLiveOutput(root, output) : undefined, [output, root])
  const onApi = useCallback((api: GridShellApi | undefined) => { apiRef.current = api }, [])
  const headerSort = useMemo<HeaderSortKey[]>(() => keys.map(key => ({ column: key.column, descending: key.descending })), [keys])
  const filterState = useRef({ bound, filters })
  filterState.current = { bound, filters }
  const funnels = useMemo<GridFunnels | undefined>(() => filterable ? {
    source: localFilterSource({ table: () => filterState.current.bound, filters: () => filterState.current.filters, apply: (column, filter) => setFilter(column, filter) }),
    filtered: new Set(filters.keys()),
    columnName: column => filterState.current.bound.columns[column]?.name
  } : undefined, [filterable, filters, setFilter])
  // What the bounds left out is shown, as a results grid shows truncated values: rows past the first, and cut cells.
  const cut = bound.cutCells > 0 ? `${formatCount(bound.cutCells)} ${bound.cutCells === 1 ? 'value was' : 'values were'} cut to ${formatCount(localTableLimits.cellChars)} characters.` : undefined
  const dropped = bound.droppedColumns > 0 ? `Showing the first ${formatCount(columns)} ${plural(columns, 'column')}.` : undefined
  const truncated = [bound.truncatedRows > 0 ? `Showing the first ${formatCount(rows)} ${plural(rows, 'row')}.` : undefined, dropped, cut].filter(Boolean).join(' ') || undefined
  const strip = notice ? { text: notice.text, ...notice.error ? { error: true } : {} } : truncated ? { text: truncated } : undefined
  // A card (unless `fill` gives it a full-height panel) or fitted page is as tall as its header and rows, up to `maxRows`,
  // with room for the platform's scroll bar under columns wider than it and for its strip.
  const height = (preset === 'card' && !fill) || fit ? g.headerHeight + (rows === 0 ? cardEmpty : Math.min(rows, maxRows) * g.rowHeight + (wide ? scrollbarSize() : 0)) + (strip ? g.stripHeight : 0) + 2 : undefined
  const activateActive = () => {
    const activate = latest.current.onActivateRow
    const source = sourceRef.current
    const selection = apiRef.current?.view()?.currentSelection()
    if (!activate || !source || !selection) return false
    const { row, column } = selection.active
    if (row < 0 || row >= source.table.rows.length) return false
    return activate(tableRow(source, row), column) === true
  }
  return <GridShell mountKey={`local|${state ? columnsKey : instanceKey(bound)}|${instanceKey(own)}|${sortable ? 'sortable' : 'fixed'}|${label}`} mount={mount} onApi={onApi} contents="rows"
    frameProps={{ className: 'local-grid', 'data-local-grid': preset, ...fit ? { 'data-local-fit': '' } : {}, ...height !== undefined ? { style: { height, flex: 'none' } } : {} }}
    rootProps={{
      'aria-label': label, 'data-output-view': 'live',
      ...onActivateRow ? {
        onKeyDown: event => {
          if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== 'Enter') return
          if (activateActive()) { event.preventDefault(); event.stopPropagation() }
        },
        onDoubleClick: event => {
          // Only on a row: GridView's own hit test through its pointer layer (the event's target is that layer, not a cell),
          // never a header, whose border's double-click fits its column.
          const root = event.currentTarget
          if (event.button !== 0 || !root.ownerDocument.elementsFromPoint(event.clientX, event.clientY).some(element => root.contains(element) && gridTarget(root, element).target?.row !== undefined)) return
          if (activateActive()) { event.preventDefault(); event.stopPropagation() }
        }
      } : {}
    }} rootRef={setRoot}
    sort={headerSort} onSort={(column, add) => setKeys(current => cycleSortKeys(current, column, add, maxSortKeys, descending => ({ column, descending })))}
    {...funnels ? { funnels } : {}}
    // An empty table says so in the surface's words over the header, where a results grid says why its rows are gone.
    gone={rows === 0 ? filters.size > 0 ? localGridText.noneMatch : empty ?? 'No rows.' : undefined}
    strip={strip} />
}

export const localGridText = { noneMatch: 'No rows match the column filters. Clear Filters from the grid\'s menu shows them all again.' } as const

/** A local table's grid: a throw while rendering it stays in its frame (GridErrorBoundary), whose Retry renders it again. */
export function LocalGrid(props: LocalGridProps) {
  // Another kept state is another grid: its sort, selection and scroll come back together.
  return <GridErrorBoundary contents="rows" frameProps={{ className: 'local-grid', 'data-local-grid': props.preset }}><LocalGridBody key={props.state ? instanceKey(props.state) : 'own'} {...props} /></GridErrorBoundary>
}
