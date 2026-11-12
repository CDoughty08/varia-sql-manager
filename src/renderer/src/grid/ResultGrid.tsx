import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { QueryResult } from '../../../shared/contracts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { ResultHandle } from '../results/ResultClient'
import { capStripText, filteredColumns, setKey, type EntryKey, type GridSort, type ResultSetEntry } from '../results/ResultsService'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { resultsFilterSource } from '../results/ColumnFilterPopover'
import { compareText } from '../results/CompareService'
import { highlightText } from '../results/HighlightsService'
import { pivotStrip } from '../results/pivot'
import { transposeStrip } from '../results/TransposeService'
import { formatBytes, formatCount } from '../results/status'
import GridShell, { GridErrorBoundary, instanceKey, type GridFunnels, type GridShellApi, type GridSpec } from './GridShell'
import type { GridView } from './GridView'
import { describeSelection } from './selection'

export interface ResultGridProps {
  readonly tabId: string
  readonly entry: ResultSetEntry
  /** Result sets in the run, for the grid's name ("Result 2 of 3": the entry's number, of this many). */
  readonly count: number
  /** The grid F6 and the Query Output pane focus first: the one that last had focus. */
  readonly focused: boolean
  readonly budget?: QueryResult['budget']
  /** What the grid shows of its group, for menus and scripts (`data-result-view`): a Table, a Pivot, a comparison, a plan
   *  set or a stored transpose; and the group's ordinal (`data-result-group`), which a comparison lacks. */
  readonly view?: 'table' | 'pivot' | 'comparison' | 'plan' | 'transpose'
  readonly group?: number
  /** A bare stack's grid (Peek): Pivot, Compare and close are off for it (`data-result-bare`). */
  readonly bare?: boolean
  /** The grid's sort, while it has one: the grid shows its view once it is built. */
  readonly sort?: GridSort
  onFocus(key: EntryKey): void
  /** Whether the set's columns are wider than its grid (it needs a horizontal scroll bar), for sizing the stack to its rows. */
  onWide?(key: EntryKey, wide: boolean): void
}

const lostText = 'These results are no longer available because the SQL backend restarted.'
const incompleteText = 'This result is incomplete because an error, cancellation, or timeout stopped it. See Messages.'

/** Why the grid shows fewer rows than the query read, if it does (B8 strips). */
function truncationText(o: { truncated?: string; rowsStored: number; rowsRead: number; budget?: QueryResult['budget'] }): string | undefined {
  const shown = `Only the first ${formatCount(o.rowsStored)} of ${formatCount(o.rowsRead)} rows are shown`
  if (o.truncated === 'systemMemory') return `${shown} because the computer is low on memory. Execution continued.`
  if (o.truncated === 'queryBudget' || o.truncated === 'globalBudget') {
    const bytes = o.truncated === 'queryBudget' ? o.budget?.queryBytes : o.budget?.globalBytes
    return `${shown}: the result memory budget${bytes ? ` (${formatBytes(bytes)})` : ''} is full. Execution continued; close other results to free memory.`
  }
  if (o.truncated === 'rowLimit') return `${shown}: the limit on rows kept per execution was reached (Tools › Options › Query Results › SQL Server › Results to Grid). Execution continued.`
  return undefined
}

/** The sort's keys and filters as a string: a new order or other rows put the grid back at its first row; the same view
 *  built again (once every row is in) keeps its place. */
const keysOf = (sort: GridSort | undefined) => (sort?.keys.map(key => `${key.column}${key.descending ? 'd' : 'a'}`).join(',') ?? '') + '|' + JSON.stringify(sort?.filters.map(item => item.filter) ?? [])

/**
 * A query's result set in the results grid (GridShell): the set's handle and its sorted views, ResultsService's sort and
 * filters for the header, and the strips (truncation, highlights, compare, pivot, transpose). A live view mounts the same
 * shell with its own source (LiveGridPane).
 */
function ResultGridBody({ tabId, entry, count, focused, budget, sort, view, group, bare, onFocus, onWide }: ResultGridProps) {
  const { results, commands, gridStats, panes, settings, resultsSearch, highlights, compare, pivot, transpose } = useWorkbench()
  const marked = useSyncExternalStore(highlights.subscribe, () => highlights.getSnapshot()[tabId]?.get(entry.key))
  const compared = useSyncExternalStore(compare.subscribe, () => compare.getSnapshot().get(setKey(entry.descriptor)))
  const pivoted = useSyncExternalStore(pivot.subscribe, () => pivot.getSnapshot().info.get(setKey(entry.descriptor)))
  const transposed = useSyncExternalStore(transpose.subscribe, () => transpose.getSnapshot().get(setKey(entry.descriptor)))
  const values = useServiceSnapshot(settings).values
  const showTypes = values['queryResults.grid.showColumnTypes'], rowSize = values['queryResults.grid.rowSize']
  const viewRef = useRef<GridView | undefined>(undefined), apiRef = useRef<GridShellApi | undefined>(undefined)
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  // Search in results: this grid's marks, and the tab's reveal of the active match.
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const marks = search?.marks.get(entry.key)
  // Bumped by each swap, so a reveal waiting for the sorted rows runs once they show.
  const [swaps, setSwaps] = useState(0)
  const filtered = useMemo(() => filteredColumns(sort), [sort])
  const key = entry.key
  // The view's orientation is part of its grid state, so it follows the entry and outlives the grid. The transpose commands
  // set it (ResultsService.setOrientation, which publishes); a change builds the grid again, as a tab switch does. A
  // comparison is never drawn transposed (transposedView, the rule Copy and Save follow too). Read as a string, so the grid renders again only
  // when its own orientation changed.
  const oriented = useSyncExternalStore(results.subscribe, () => { const now = results.orientation(tabId, key); return now.transposed ? `t${now.headerColumn ?? ''}` : '' })
  const turnedView = oriented !== '', headerColumn = turnedView && oriented.length > 1 ? Number(oriented.slice(1)) : undefined
  const latest = useRef({ count, onWide, sort, marks, showTypes, rowSize, turnedView, headerColumn })
  latest.current = { count, onWide, sort, marks, showTypes, rowSize, turnedView, headerColumn }
  /** The handle the view shows, and the keys it was sorted by. */
  const shownRef = useRef<{ handle: ResultHandle; keys: string }>({ handle: entry.handle, keys: '' })
  const mount = (create: (spec: GridSpec) => GridView) => {
    const now = latest.current
    // A grid mounted again (a tab switch) shows its sorted view from the start.
    const sorted = now.sort?.view
    shownRef.current = { handle: sorted ?? entry.handle, keys: sorted ? keysOf(now.sort) : '' }
    results.viewShown(tabId, key, sorted)
    const view = create({
      handle: shownRef.current.handle, descriptor: entry.descriptor, state: results.gridState(tabId, key),
      entry: key, resultNumber: entry.number, resultCount: now.count, stats: gridStats, showTypes: now.showTypes, rowSize: now.rowSize,
      ...now.turnedView ? { transposed: true, ...now.headerColumn === undefined ? {} : { headerColumn: now.headerColumn } } : {},
      onSelection: selection => {
        const current = entry.handle.getSnapshot()
        results.announceSelection(tabId, describeSelection(selection, current.rowsAvailable, entry.descriptor.columns.length))
      },
      // Edit › Copy's copy event; Ctrl+C and Ctrl+A are the catalogue's output.copy and output.selectAll.
      onCopy: () => { void commands.execute('output.copy', undefined, 'keybinding') },
      onEscape: () => results.cancelTabJob(tabId),
      onWide: wide => latest.current.onWide?.(key, wide),
      onOpenValue: (row, column) => { void commands.execute('output.openValue', { tabId, cell: { entry: key, row, column } }, 'keybinding') },
      // Find Next onto a match in a row the transposed grid does not draw: the toolbar says so.
      onBeyondCap: row => results.beyondCap(tabId, row)
    })
    viewRef.current = view
    view.setMarks(now.marks)
    const registration = results.registerGrid(tabId, key, {
      selectAll: () => view.selectAll(), repaint: () => view.repaint(), fitColumn: column => view.fitColumn(column),
      fitDrawn: row => { if (row === undefined) view.fitNames(); else view.fitRow(row) },
      filterColumn: column => apiRef.current?.openFunnel(column)
    })
    // Closing and opening the pane within one frame moves the grid without resizing it, and the move drops the scroller's
    // offsets: the frame this asks for writes them back (GridView's offsetsDropped), and a press before it keeps them.
    const unsubscribe = panes.subscribe(() => view.panesChanged())
    return () => {
      unsubscribe()
      registration.dispose()
      view.dispose()
      if (viewRef.current === view) viewRef.current = undefined
    }
  }
  // The grid draws the highlighted rows of the handle it shows, and switches with its swaps.
  const highlightRows = marked?.rows
  // A grid built again for another orientation takes them again: this runs after the shell has built it.
  useLayoutEffect(() => { viewRef.current?.setHighlights(highlightRows ?? []) }, [highlightRows, tabId, entry, turnedView])
  // The active match scrolls into view once, in the grid that holds it: at once, or when this grid mounts (the stack
  // scrolled to it) or has swapped to the order the matches number.
  const reveal = search?.reveal ?? 0, revealSelect = search?.revealSelect ?? false
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.setMarks(marks)
    if (resultsSearch.pendingReveal(tabId, key) && view.revealMark(revealSelect)) resultsSearch.revealed(tabId)
  }, [marks, reveal, revealSelect, swaps, resultsSearch, tabId, key, turnedView])
  // A built view replaces what the grid shows: its first rows are read before the swap, so it paints whole rows at once,
  // unless what it shows is already gone (its result released or lost). While a first sort runs the grid keeps the rows in
  // their order; the views it showed close once it has swapped (ResultsService.viewShown).
  const target = sort?.view ?? (sort ? undefined : entry.handle)
  useEffect(() => {
    const view = viewRef.current, shown = shownRef.current
    if (!view || !target || target === shown.handle) return
    const keys = target === entry.handle ? '' : keysOf(latest.current.sort), top = keys !== shown.keys ? 0 : undefined
    const abort = new AbortController()
    const swap = () => {
      if (abort.signal.aborted || viewRef.current !== view) return
      shownRef.current = { handle: target, keys }
      view.swap(target, entry.descriptor, row => row, top === undefined ? {} : { top })
      setSwaps(value => value + 1)
      // The views it showed before can close now.
      results.viewShown(tabId, key, target === entry.handle ? undefined : target)
    }
    const state = shown.handle.getSnapshot().state
    if (state === 'released' || state === 'lost') swap()
    else void view.prepare(target, 0, abort.signal).then(swap)
    return () => abort.abort()
  }, [target, entry])
  const source = useMemo(() => resultsFilterSource(results, tabId, key), [results, tabId, key])
  const funnels = useMemo<GridFunnels>(() => ({ source, filtered, columnName: column => entry.descriptor.columns[column]?.name }), [source, filtered, entry])
  const onApi = useCallback((api: GridShellApi | undefined) => { apiRef.current = api }, [])
  const lost = snapshot.state === 'lost'
  const truncation = truncationText({ truncated: snapshot.truncated, rowsStored: snapshot.rowsStored, rowsRead: snapshot.rowsRead, budget })
  const highlightNote = !lost && snapshot.state === 'complete' ? compared ? compareText(compared) : pivoted ? pivotStrip(pivoted, highlightText(marked)) : transposed ? transposeStrip(transposed, highlightText(marked)) : highlightText(marked) : undefined
  // Transposed, the first rows of the view (the sorted and filtered one, when the grid shows one) are drawn as columns:
  // past them the strip says so first, since no scrolling reaches the rest.
  const shownRows = useSyncExternalStore((target ?? entry.handle).subscribe, () => (target ?? entry.handle).getSnapshot().rowsAvailable)
  const cap = turnedView && !lost && shownRows > wire.transpose.maxRows ? capStripText(shownRows, entry.descriptor.kind === 'pivot') : undefined
  const other = lost ? undefined : snapshot.incomplete ? incompleteText : truncation ?? highlightNote
  const note = cap && other ? `${cap} ${other}` : cap ?? other
  // The entry's key names the grid for commands and menus; the generation and result id say which stored result it showed
  // when a target was read from it, so a target read before a re-run is told from the new one.
  return <GridShell mountKey={`${tabId}|${key}|${instanceKey(entry)}${turnedView ? '|transposed' : ''}`} mount={mount} onApi={onApi}
    rootProps={{
      'data-result-grid': '', 'data-output-view': 'grid', 'data-tab-id': tabId, 'data-result-entry': key, 'data-result-generation': entry.descriptor.generation,
      'data-result-id': entry.descriptor.resultId, 'data-result-kind': entry.descriptor.kind, ...view ? { 'data-result-view': view } : {}, ...group === undefined ? {} : { 'data-result-group': group },
      ...bare ? { 'data-result-bare': '' } : {}, 'data-pane-focus': focused ? 'selected' : 'grid',
      // The stack keeps the focused entry for its own drawing and tells the service (`focusEntry`), so the toolbar, the
      // menus' toggle and the pivot builder follow.
      onFocus: () => onFocus(key)
    }}
    sort={sort?.keys} onSort={(column, add) => results.cycleSort(tabId, key, column, add)} funnels={funnels}
    update={{ resultCount: count, showTypes, rowSize, ...turnedView ? { headerColumn: headerColumn ?? null } : {} }} gone={lost ? lostText : undefined}
    strip={note ? { text: note } : undefined} />
}

/** A result set's grid: a throw while rendering it stays in its frame (GridErrorBoundary), whose Retry renders it again. */
export default function ResultGrid(props: ResultGridProps) {
  return <GridErrorBoundary frameProps={{ 'data-result-entry': props.entry.key }}><ResultGridBody {...props} /></GridErrorBoundary>
}
