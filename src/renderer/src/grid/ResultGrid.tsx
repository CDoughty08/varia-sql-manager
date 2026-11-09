import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type KeyboardEvent, type ReactNode } from 'react'
import type { QueryResult } from '../../../shared/contracts'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { ResultHandle } from '../results/ResultClient'
import { filteredColumns, setKey, type GridSort, type ResultSetEntry } from '../results/ResultsService'
import { ColumnFilterPopover, type ColumnFilterTarget } from '../results/ColumnFilterPopover'
import { compareText } from '../results/CompareService'
import { highlightText } from '../results/HighlightsService'
import { formatBytes, formatCount } from '../results/status'
import { GridView, type GridStatus } from './GridView'
import { describeSelection } from './selection'

export interface ResultGridProps {
  readonly tabId: string
  readonly entry: ResultSetEntry
  /** Result sets in the run, for the grid's name ("Result 2 of 3"). */
  readonly count: number
  /** The grid F6 and the Query Output pane focus first: the one that last had focus. */
  readonly focused: boolean
  readonly budget?: QueryResult['budget']
  /** The grid's sort, while it has one: the grid shows its view once it is built. */
  readonly sort?: GridSort
  onFocus(index: number): void
  /** Whether the set's columns are wider than its grid (it needs a horizontal scroll bar), for sizing the stack to its rows. */
  onWide?(index: number, wide: boolean): void
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
  if (o.truncated === 'rowLimit') return `${shown}. Execution continued.`
  return undefined
}

/** The React shell of one grid: its root and scroller, strips and overlay. GridView renders and handles everything inside. */
/** The sort's keys and filters as a string: a new order or other rows put the grid back at its first row; the same view
 *  built again (once every row is in) keeps its place. */
const keysOf = (sort: GridSort | undefined) => (sort?.keys.map(key => `${key.column}${key.descending ? 'd' : 'a'}`).join(',') ?? '') + '|' + JSON.stringify(sort?.filters.map(item => item.filter) ?? [])

function ResultGridShell({ tabId, entry, count, focused, budget, sort, onFocus, onWide }: ResultGridProps) {
  const { results, resultClient, commands, platform, gridStats, panes, settings, resultsSearch, highlights, compare } = useWorkbench()
  const marked = useSyncExternalStore(highlights.subscribe, () => highlights.getSnapshot()[tabId]?.get(entry.index))
  const compared = useSyncExternalStore(compare.subscribe, () => compare.getSnapshot().get(setKey(entry.descriptor)))
  const values = useServiceSnapshot(settings).values
  const showTypes = values['queryResults.grid.showColumnTypes'], whitespace = values['queryResults.grid.whitespace'], rowSize = values['queryResults.grid.rowSize']
  const showTypesRef = useRef(showTypes), whitespaceRef = useRef(whitespace), rowSizeRef = useRef(rowSize)
  showTypesRef.current = showTypes
  whitespaceRef.current = whitespace
  rowSizeRef.current = rowSize
  const rootRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null), viewRef = useRef<GridView | undefined>(undefined)
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  // Search in results: this grid's marks, and the tab's reveal of the active match.
  const search = useServiceSnapshot(resultsSearch)[tabId]
  const marks = search?.marks.get(entry.index)
  const marksRef = useRef(marks)
  // Bumped by each swap, so a reveal waiting for the sorted rows runs once they show.
  const [swaps, setSwaps] = useState(0)
  marksRef.current = marks
  const [status, setStatus] = useState<GridStatus>({})
  // The header funnel's popover, while open: its column and where it opens.
  const [funnel, setFunnel] = useState<ColumnFilterTarget | undefined>()
  const filtered = useMemo(() => filteredColumns(sort), [sort])
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered
  const index = entry.index
  const countRef = useRef(count)
  countRef.current = count
  const onWideRef = useRef(onWide)
  onWideRef.current = onWide
  const sortRef = useRef(sort)
  sortRef.current = sort
  /** The handle the view shows, and the keys it was sorted by. */
  const shownRef = useRef<{ handle: ResultHandle; keys: string }>({ handle: entry.handle, keys: '' })
  // Before the shell paints: the view draws its first frame as it is built, so the grid never paints empty first.
  useLayoutEffect(() => {
    // A grid mounted again (a tab switch) shows its sorted view from the start.
    const sorted = sortRef.current?.view
    shownRef.current = { handle: sorted ?? entry.handle, keys: sorted ? keysOf(sortRef.current) : '' }
    results.viewShown(tabId, index, sorted)
    const view = new GridView({
      root: rootRef.current!, scroller: scrollRef.current!, handle: shownRef.current.handle, client: resultClient, descriptor: entry.descriptor, state: results.gridState(tabId, index),
      resultIndex: index, resultCount: countRef.current, platform, stats: gridStats, showTypes: showTypesRef.current, whitespace: whitespaceRef.current, rowSize: rowSizeRef.current,
      onSelection: selection => {
        const current = entry.handle.getSnapshot()
        results.announceSelection(tabId, describeSelection(selection, current.rowsAvailable, entry.descriptor.columns.length))
      },
      // Edit › Copy's copy event; Ctrl+C and Ctrl+A are the catalogue's output.copy and output.selectAll.
      onCopy: () => { void commands.execute('output.copy', undefined, 'keybinding') },
      onEscape: () => results.cancelTabJob(tabId),
      onStatus: setStatus,
      onWide: wide => onWideRef.current?.(index, wide),
      onError: onUnexpectedError,
      onOpenValue: (row, column) => { void commands.execute('output.openValue', { tabId, cell: { resultIndex: index, row, column } }, 'keybinding') },
      sort: sortRef.current?.keys,
      onSort: (column, add) => results.cycleSort(tabId, index, column, add),
      filtered: filteredRef.current,
      // A press on the open column's funnel closes its popover, as pressing a menu's button again does.
      onFilter: (column, anchor) => setFunnel(current => current?.column === column ? undefined : { column, anchor })
    })
    viewRef.current = view
    view.setMarks(marksRef.current)
    const registration = results.registerGrid(tabId, index, {
      selectAll: () => view.selectAll(), repaint: () => view.repaint(), fitColumn: column => view.fitColumn(column),
      filterColumn: column => setFunnel({ column, anchor: view.filterAnchor(column) })
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
  }, [tabId, index, entry, results, resultClient, commands, platform, gridStats, panes])
  useEffect(() => { viewRef.current?.update({ resultCount: count, showTypes, whitespace, sort: sort?.keys, rowSize, filtered }) }, [count, showTypes, whitespace, sort?.keys, rowSize, filtered])
  // Closing the popover gives the focus back to the grid, as a menu does, unless a press elsewhere took it.
  const closeFunnel = useCallback((refocus = true) => {
    setFunnel(undefined)
    if (refocus) rootRef.current?.focus({ preventScroll: true })
  }, [])
  // The grid draws the highlighted rows of the handle it shows, and switches with its swaps.
  const highlightRows = marked?.rows
  useLayoutEffect(() => { viewRef.current?.setHighlights(highlightRows ?? []) }, [highlightRows, tabId, index, entry])
  // The active match scrolls into view once, in the grid that holds it: at once, or when this grid mounts (the stack
  // scrolled to it) or has swapped to the order the matches number.
  const reveal = search?.reveal ?? 0, revealSelect = search?.revealSelect ?? false
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.setMarks(marks)
    if (resultsSearch.pendingReveal(tabId, index) && view.revealMark(revealSelect)) resultsSearch.revealed(tabId)
  }, [marks, reveal, revealSelect, swaps, resultsSearch, tabId, index])
  // A built view replaces what the grid shows: its first rows are read before the swap, so it paints whole rows at once,
  // unless what it shows is already gone (its result released or lost). While a first sort runs the grid keeps the rows in
  // their order; the views it showed close once it has swapped (ResultsService.viewShown).
  const target = sort?.view ?? (sort ? undefined : entry.handle)
  useEffect(() => {
    const view = viewRef.current, shown = shownRef.current
    if (!view || !target || target === shown.handle) return
    const keys = target === entry.handle ? '' : keysOf(sortRef.current), top = keys !== shown.keys ? 0 : undefined
    const abort = new AbortController()
    const swap = () => {
      if (abort.signal.aborted || viewRef.current !== view) return
      shownRef.current = { handle: target, keys }
      view.swap(target, entry.descriptor, row => row, top === undefined ? {} : { top })
      setSwaps(value => value + 1)
      // The views it showed before can close now.
      results.viewShown(tabId, index, target === entry.handle ? undefined : target)
    }
    const state = shown.handle.getSnapshot().state
    if (state === 'released' || state === 'lost') swap()
    else void view.prepare(target, 0, abort.signal).then(swap)
    return () => abort.abort()
  }, [target, entry])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest('button')) return
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  const lost = snapshot.state === 'lost'
  const truncation = truncationText({ truncated: snapshot.truncated, rowsStored: snapshot.rowsStored, rowsRead: snapshot.rowsRead, budget })
  const retry = () => viewRef.current?.retry()
  const highlightNote = !lost && snapshot.state === 'complete' ? compared ? compareText(compared) : highlightText(marked) : undefined
  // The grid holds only rows; its strip and the lost overlay are its siblings, outside the table structure.
  return <div className="rg-frame">
    <div ref={rootRef} className="results-grid rg" role="grid" tabIndex={0} data-result-grid="" data-output-view="grid" data-tab-id={tabId} data-result-index={index}
      data-result-generation={entry.descriptor.generation} data-result-id={entry.descriptor.resultId}
      data-pane-focus={focused ? 'selected' : 'grid'} aria-multiselectable="true" aria-readonly="true" onKeyDown={keyDown} onFocus={() => onFocus(index)}>
      <div ref={scrollRef} className="rg-scroll" tabIndex={-1} />
    </div>
    {lost && <div className="rg-overlay" role="status">{lostText}</div>}
    {!lost && status.renderError ? <div className="rg-strip error" role="status">This result could not be displayed. <button onClick={retry}>Retry</button></div>
      : !lost && status.tileError ? <div className="rg-strip error" role="status">Some rows could not be loaded: {status.tileError} <button onClick={retry}>Retry</button></div>
        : !lost && snapshot.incomplete ? <div className="rg-strip" role="status" title={incompleteText}>{incompleteText}</div>
          : !lost && truncation ? <div className="rg-strip" role="status" title={truncation}>{truncation}</div>
            : highlightNote ? <div className="rg-strip" role="status" title={highlightNote}>{highlightNote}</div> : null}
    {funnel && !lost && funnel.column < entry.descriptor.columns.length && <ColumnFilterPopover key={funnel.column} tabId={tabId} index={index} target={funnel}
      columnName={entry.descriptor.columns[funnel.column].name || '(No column name)'} filtered={filtered.has(funnel.column)} grid={rootRef.current!} onClose={closeFunnel} />}
  </div>
}

/** A grid whose shell failed to render shows the render-error strip; Retry renders it again. */
class GridErrorBoundary extends Component<{ children: ReactNode; index: number }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError(): Partial<{ failed: boolean }> { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void { onUnexpectedError(Object.assign(error, { componentStack: info.componentStack })) }
  render(): ReactNode {
    if (this.state.failed) {
      return <div className="rg-frame failed" data-result-index={this.props.index}>
        <div className="rg-strip error" role="status">This result could not be displayed. <button onClick={() => this.setState(state => ({ failed: false, attempt: state.attempt + 1 }))}>Retry</button></div>
      </div>
    }
    return <ErrorBoundaryKey key={this.state.attempt}>{this.props.children}</ErrorBoundaryKey>
  }
}
function ErrorBoundaryKey({ children }: { children: ReactNode }) { return <>{children}</> }

export default function ResultGrid(props: ResultGridProps) {
  return <GridErrorBoundary index={props.entry.index}><ResultGridShell {...props} /></GridErrorBoundary>
}
