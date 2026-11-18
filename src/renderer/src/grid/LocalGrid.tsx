import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { boundTable, localCopyText, type LocalTableData } from '../../../shared/results/local-table'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import { registerLiveOutput, type LiveOutput } from '../menus/targets'
import type { GridViewState } from '../results/ResultsService'
import { formatCount, plural } from '../results/status'
import { gridLimits as g } from './constants'
import GridShell, { GridErrorBoundary, instanceKey, type GridShellApi, type GridSpec } from './GridShell'
import type { GridView, HeaderSortKey } from './GridView'
import { localDescriptor, LocalSource, sortOrder, type LocalSortKey } from './local-source'
import { copyPlan } from './selection'
import { cycleSortKeys, sortKeysBy } from './sort-keys'

/**
 * `card`: a short list inside a card or panel (hover Peek, Session Details): as tall as its rows up to `maxRows`, then
 * it scrolls; no Save. `page`: a table that fills its area on a document page (Properties, a Peek tab); Save Results As.
 */
export type LocalGridPreset = 'card' | 'page'

export interface LocalGridProps {
  /** The rows as the surface shows them (display text: a masked value stays masked). A new object is a new table. */
  readonly table: LocalTableData
  /** The grid's accessible name ("Columns"), which its label starts with ("Columns, 7 rows, 6 columns"). */
  readonly label: string
  readonly preset: LocalGridPreset
  /** What the frame says when the table has no rows: the surface's own words ("No security predicates apply."). */
  readonly empty?: string
  /** Save Results As's suggested file name (a page's), without an extension. */
  readonly suggestedName?: string
  /** False for a table whose order is its meaning (a report's rows): no header sort, no Sort items. */
  readonly sortable?: boolean
  /** A card's tallest height in rows (12 by default). */
  readonly maxRows?: number
  /** Scroll, widths and selection, kept by the owner across remounts; the grid keeps its own otherwise. */
  readonly state?: GridViewState
}

/** The most keys a local table sorts by, as a results view's. */
const maxSortKeys = 4
const cardRows = 12
/** A horizontal scroll bar's allowance under a card's rows, when its columns are wider than the card. */
const cardScrollbar = 12

/**
 * A local table in the results grid (GridShell over GridView): rows the renderer already holds, never a backend result
 * (docs/architecture.md, Grid). Selection, keys, column sizing and Fit, header sort and Query Output's menu and commands
 * work as in a results grid; Copy and Save write the same text through the TypeScript twin of ResultTextWriter (copy
 * here, a save in main). The menu reaches it as a grid with its own source (OutputTarget view `live`, LiveOutput).
 */
function LocalGridBody({ table, label, preset, empty, suggestedName, sortable = true, maxRows = cardRows, state }: LocalGridProps) {
  const { commands, platform } = useWorkbench()
  const bound = useMemo(() => boundTable(table), [table])
  const [keys, setKeys] = useState<readonly LocalSortKey[]>([])
  const [notice, setNotice] = useState<{ readonly text: string; readonly error?: boolean }>()
  const [wide, setWide] = useState(false)
  const apiRef = useRef<GridShellApi | undefined>(undefined)
  const sourceRef = useRef<LocalSource | undefined>(undefined)
  const own = useMemo<GridViewState>(() => state ?? { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }, [state, bound])
  // A new table starts unsorted: its columns may differ.
  useEffect(() => { setKeys([]) }, [bound])
  const latest = useRef({ label, suggestedName })
  latest.current = { label, suggestedName }
  const rows = bound.rows.length, columns = bound.columns.length
  const mount = (create: (spec: GridSpec) => GridView) => {
    const source = sourceRef.current = new LocalSource(bound, sortOrder(bound, keys), bound.cutCells)
    create({
      handle: source, descriptor: localDescriptor(bound, bound.cutCells), state: own, entry: 'local', resultNumber: 1, resultCount: 1, label: latest.current.label,
      showTypes: false, clipboardKeys: false, sortable, onWide: setWide,
      onSelection: () => {},
      // Edit › Copy's copy event: output.copy, as in a results grid.
      onCopy: headers => { void commands.execute(headers ? 'output.copyWithHeaders' : 'output.copy', undefined, 'keybinding') },
      onEscape: () => false
    })
    return () => { sourceRef.current = undefined }
  }
  // A new sort swaps a source in the new order into the view, so the selection follows its rows.
  useEffect(() => {
    const view = apiRef.current?.view(), old = sourceRef.current
    if (!view || !old) return
    const order = sortOrder(bound, keys)
    if (order === old.order || (!order && !old.order)) return
    const next = new LocalSource(bound, order, bound.cutCells), place = new Int32Array(rows)
    for (let row = 0; row < rows; row++) place[next.rowOf(row)] = row
    sourceRef.current = next
    view.swap(next, localDescriptor(bound, bound.cutCells), row => row >= 0 && row < rows ? place[old.rowOf(row)] : -1)
  }, [bound, keys, rows])
  const sortBy = useCallback((column: number | undefined, descending = false, add = false) =>
    setKeys(current => column === undefined ? [] : sortKeysBy(current, column, descending ? 'descending' : 'ascending', add, maxSortKeys, desc => ({ column, descending: desc }))), [])
  const report = useCallback((what: string, error: unknown) => setNotice({ text: `Could not ${what}: ${error instanceof Error ? error.message : String(error)}`, error: true }), [])
  const output = useMemo<LiveOutput>(() => {
    const view = () => apiRef.current?.view()
    const hasRows = () => rows > 0 && columns > 0
    return {
      sortable, filterable: false,
      hasRows, hasSelection: () => hasRows() && !!view()?.currentSelection(),
      activeColumn: () => view()?.currentSelection()?.active.column,
      columnName: column => bound.columns[column]?.name,
      canSort: column => sortable && column >= 0 && column < columns,
      canFilter: () => false, sorted: () => keys.length > 0, filtered: () => false,
      copy: headers => {
        const selection = view()?.currentSelection(), parts = selection ? copyPlan(selection, columns) : []
        if (!parts.length) return
        setNotice(undefined)
        void localCopyText(bound, parts, { headers, crlf: platform === 'win32', ...sourceRef.current?.order ? { order: sourceRef.current.order } : {} })
          .then(async copied => { const written = await window.varia.writeClipboardText(copied.text); if (!written.ok) report('copy the rows', written.error) })
          .catch(error => report('copy the rows', error))
      },
      selectAll: () => view()?.selectAll(),
      sort: (column, descending, add) => sortBy(column, descending, add),
      clearSort: () => sortBy(undefined),
      fitColumn: column => view()?.fitColumn(column),
      filterColumn: () => {}, clearFilters: () => {},
      canSave: () => preset === 'page',
      save: () => {
        if (preset !== 'page' || !hasRows()) return
        const order = sourceRef.current?.order
        setNotice(undefined)
        void window.varia.saveLocalResults({ suggestedName: latest.current.suggestedName ?? latest.current.label, columns: bound.columns.map(column => ({ name: column.name, ...column.kind ? { kind: column.kind } : {} })), rows: (order ?? bound.rows.map((_, index) => index)).map(index => [...bound.rows[index]]) })
          .then(saved => {
            if (!saved.ok) report('save the rows', saved.error)
            else if (saved.value) setNotice({ text: `Saved ${formatCount(saved.value.rows)} ${plural(saved.value.rows, 'row')} to ${saved.value.fileName}.` })
          }, onUnexpectedError)
      },
      canFind: () => false, find: () => {}
    }
  }, [bound, rows, columns, keys, sortable, preset, platform, sortBy, report])
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEffect(() => root ? registerLiveOutput(root, output) : undefined, [output, root])
  const onApi = useCallback((api: GridShellApi | undefined) => { apiRef.current = api }, [])
  const headerSort = useMemo<HeaderSortKey[]>(() => keys.map(key => ({ column: key.column, descending: key.descending })), [keys])
  const truncated = bound.truncatedRows > 0 ? `Showing the first ${formatCount(rows)} ${plural(rows, 'row')}.` : undefined
  // A card is as tall as its header and rows, up to `maxRows`, with room for a scroll bar under columns wider than it.
  const height = preset === 'card' ? g.headerHeight + Math.max(1, Math.min(rows, maxRows)) * g.rowHeight + (wide ? cardScrollbar : 0) + 2 : undefined
  return <GridShell mountKey={`local|${instanceKey(bound)}|${instanceKey(own)}`} mount={mount} onApi={onApi} contents="rows"
    frameProps={{ className: 'local-grid', 'data-local-grid': preset, ...height !== undefined ? { style: { height, flex: 'none' } } : {} }}
    rootProps={{ 'aria-label': label, 'data-output-view': 'live' }} rootRef={setRoot}
    sort={headerSort} onSort={(column, add) => setKeys(current => cycleSortKeys(current, column, add, maxSortKeys, descending => ({ column, descending })))}
    // An empty table says so in the surface's words over the header, where a results grid says why its rows are gone.
    gone={rows === 0 ? empty ?? 'No rows.' : undefined}
    strip={notice ?? (truncated ? { text: truncated } : undefined)} />
}

/** A local table's grid: a throw while rendering it stays in its frame (GridErrorBoundary), whose Retry renders it again. */
export function LocalGrid(props: LocalGridProps) {
  return <GridErrorBoundary contents="rows" frameProps={{ className: 'local-grid', 'data-local-grid': props.preset }}><LocalGridBody {...props} /></GridErrorBoundary>
}
