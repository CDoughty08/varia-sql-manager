import { Component, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ErrorInfo, type KeyboardEvent, type ReactNode } from 'react'
import type { QueryResult } from '../../../shared/contracts'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import type { ResultSetEntry } from '../results/ResultsService'
import { formatBytes, formatCount, plural } from '../results/status'
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
  onFocus(index: number): void
}

const lostText = 'These results are no longer available because the SQL backend restarted.'

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
function ResultGridShell({ tabId, entry, count, focused, budget, onFocus }: ResultGridProps) {
  const { results, resultClient, commands, platform, gridStats, panes } = useWorkbench()
  const rootRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null), viewRef = useRef<GridView | undefined>(undefined)
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  const [status, setStatus] = useState<GridStatus>({})
  const index = entry.index
  const countRef = useRef(count)
  countRef.current = count
  // Before the shell paints: the view draws its first frame as it is built, so the grid never paints empty first.
  useLayoutEffect(() => {
    const view = new GridView({
      root: rootRef.current!, scroller: scrollRef.current!, handle: entry.handle, client: resultClient, descriptor: entry.descriptor, state: results.gridState(tabId, index),
      resultIndex: index, resultCount: countRef.current, platform, stats: gridStats,
      onSelection: selection => {
        const current = entry.handle.getSnapshot()
        results.announceSelection(tabId, describeSelection(selection, current.rowsAvailable, entry.descriptor.columns.length))
      },
      onCopy: () => { void commands.execute('output.copy', undefined, 'keybinding') },
      onEscape: () => results.cancelTabJob(tabId),
      onStatus: setStatus,
      onError: onUnexpectedError,
      onOpenValue: (row, column) => { void commands.execute('output.openValue', { tabId, cell: { resultIndex: index, row, column } }, 'keybinding') }
    })
    viewRef.current = view
    const registration = results.registerGrid(tabId, index, { selectAll: () => view.selectAll(), repaint: () => view.repaint() })
    // Closing and opening the pane within one frame moves the grid without resizing it, and the move drops the scroller's
    // offsets: the frame this asks for writes them back. It relies on GridView's offsetsDropped: without it, this frame
    // would take the dropped offsets for a scroll to the top.
    const unsubscribe = panes.subscribe(() => view.invalidate())
    return () => {
      unsubscribe()
      registration.dispose()
      view.dispose()
      if (viewRef.current === view) viewRef.current = undefined
    }
  }, [tabId, index, entry, results, resultClient, commands, platform, gridStats, panes])
  useEffect(() => { viewRef.current?.update({ resultCount: count }) }, [count])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest('button')) return
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  const lost = snapshot.state === 'lost'
  const truncation = truncationText({ truncated: snapshot.truncated, rowsStored: snapshot.rowsStored, rowsRead: snapshot.rowsRead, budget })
  const retry = () => viewRef.current?.retry()
  // The grid holds only rows; its strip and the lost overlay are its siblings, outside the table structure.
  return <div className="rg-frame">
    <div ref={rootRef} className="results-grid rg" role="grid" tabIndex={0} data-result-grid="" data-output-view="grid" data-tab-id={tabId} data-result-index={index}
      data-pane-focus={focused ? 'selected' : 'grid'} aria-multiselectable="true" aria-readonly="true" onKeyDown={keyDown} onFocus={() => onFocus(index)}>
      <div ref={scrollRef} className="rg-scroll" tabIndex={-1} />
    </div>
    {lost && <div className="rg-overlay" role="status">{lostText}</div>}
    {!lost && status.renderError ? <div className="rg-strip error" role="status">This result could not be displayed. <button onClick={retry}>Retry</button></div>
      : !lost && status.tileError ? <div className="rg-strip error" role="status">Some rows could not be loaded: {status.tileError} <button onClick={retry}>Retry</button></div>
        : !lost && snapshot.incomplete ? <div className="rg-strip" role="status">This result is incomplete because an error, cancellation, or timeout stopped it. See Messages.</div>
          : !lost && truncation ? <div className="rg-strip" role="status">{truncation}</div> : null}
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

/** "Result 3 · 1,234 rows": a grid still waiting for its turn to mount. */
export function GridPlaceholder({ entry }: { entry: ResultSetEntry }) {
  const snapshot = useSyncExternalStore(entry.handle.subscribe, entry.handle.getSnapshot)
  return <div className="rs-placeholder">Result {entry.index + 1} · {formatCount(snapshot.rowsAvailable)} {plural(snapshot.rowsAvailable, 'row')}</div>
}
