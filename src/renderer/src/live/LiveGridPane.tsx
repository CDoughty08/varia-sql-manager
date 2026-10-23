import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { LiveProbeId, LiveTone } from '../../../shared/live/catalog'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import { GridView, type GridStatus } from '../grid/GridView'
import type { GridViewState } from '../results/ResultsService'
import { formatCount, plural } from '../results/status'
import { LiveGrid, type LiveGridSnapshot } from './LiveGrid'
import type { LiveHandle } from './LiveService'

export interface LiveGridPaneProps {
  readonly live: LiveHandle
  readonly probe: LiveProbeId
  /** The table's index in the probe's catalogue entry. */
  readonly table?: number
  /** The grid's accessible name ("Processes"). */
  readonly label: string
  /** What a screen reader hears for a toned row ("blocked"). */
  readonly toneLabel?: (tone: LiveTone) => string | undefined
  /** Scroll, widths and selection, kept by the owner across remounts; the pane keeps its own otherwise. */
  readonly state?: GridViewState
  /** The LiveGrid, for the owner's commands (sort, copy, save) and its snapshot (the selection and the active row's key);
   *  undefined once the pane unmounts. */
  onGrid?(grid: LiveGrid | undefined): void
}

const lostText = 'This live view lost its rows because the SQL backend restarted.'

/**
 * A live table in a grid: the React shell of a LiveGrid (root, scroller, strips and the "n new rows" button). GridView
 * renders and handles everything inside, as in a results grid; until the view's first sample the grid area is empty.
 */
export function LiveGridPane({ live, probe, table = 0, label, toneLabel, state, onGrid }: LiveGridPaneProps) {
  const { resultClient, platform } = useWorkbench()
  const rootRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null), viewRef = useRef<GridView | undefined>(undefined)
  const [grid, setGrid] = useState<LiveGrid>()
  const [status, setStatus] = useState<GridStatus>({})
  const [notice, setNotice] = useState<string>()
  const toneLabelRef = useRef(toneLabel)
  toneLabelRef.current = toneLabel
  const onGridRef = useRef(onGrid)
  onGridRef.current = onGrid
  useLayoutEffect(() => {
    const own: GridViewState = state ?? { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    const created: LiveGrid = new LiveGrid({
      live, probe, table, api: window.varia,
      createView: (first, hooks) => {
        const view = new GridView({
          root: rootRef.current!, scroller: scrollRef.current!, handle: first.handle, client: resultClient, descriptor: first.descriptor, state: own,
          resultIndex: 0, resultCount: 1, platform, followTail: first.mode === 'append',
          onSelection: hooks.onSelection, onViewport: hooks.onViewport,
          onCopy: () => { void created.copy(false).then(result => setNotice(result && !result.ok && result.code !== 'CANCELLED' ? 'Could not copy the rows: ' + result.error : undefined), onUnexpectedError) },
          onEscape: () => false,
          onStatus: setStatus,
          onError: onUnexpectedError,
          toneLabel: tone => toneLabelRef.current?.(tone)
        })
        viewRef.current = view
        return view
      }
    })
    setGrid(created)
    onGridRef.current?.(created)
    return () => {
      onGridRef.current?.(undefined)
      created.dispose()
      viewRef.current = undefined
    }
  }, [live, probe, table, state, resultClient, platform])
  const snapshot = useSyncExternalStore(grid?.subscribe ?? noSubscribe, grid?.getSnapshot ?? noSnapshot)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest('button')) return
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  const lost = snapshot.lost
  const retry = () => viewRef.current?.retry()
  return <div className="rg-frame live-grid" data-live-probe={probe} data-live-table={table}>
    <div ref={rootRef} className="results-grid rg" role="grid" tabIndex={0} aria-label={label} aria-multiselectable="true" aria-readonly="true" onKeyDown={keyDown}>
      <div ref={scrollRef} className="rg-scroll" tabIndex={-1} />
    </div>
    {snapshot.newRows > 0 && <button className="live-grid-new-rows" onClick={() => grid?.jumpToEnd()}>
      {formatCount(snapshot.newRows)} new {plural(snapshot.newRows, 'row')} · Jump to latest
    </button>}
    {lost && <div className="rg-overlay" role="status">{lostText}</div>}
    {!lost && status.renderError ? <div className="rg-strip error" role="status">These rows could not be displayed. <button onClick={retry}>Retry</button></div>
      : !lost && status.tileError ? <div className="rg-strip error" role="status">Some rows could not be loaded: {status.tileError} <button onClick={retry}>Retry</button></div>
        : notice ? <div className="rg-strip error" role="status">{notice}</div> : null}
  </div>
}

const noSubscribe = () => () => {}
const empty: LiveGridSnapshot = { newRows: 0, following: true, lost: false }
const noSnapshot = () => empty
