// The React shell of a live chart: it mounts the canvas, the legend and "View as table", and hands everything else to
// ChartView, which draws from the probe's ring and redraws on the view's ticks. The table is a results grid (LocalGrid,
// card) in the plot's place, as many rows tall as the plot has room for, so neither the card nor the canvas changes size
// when it shows; each tick swaps in a newly sampled table. Sparklines (a tile's trace) have
// no legend, labels, crosshair or table, and take no focus; the tile around them says the value.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { LocalTableData } from '../../../shared/results/local-table'
import type { ChartSurface } from '../../../shared/theme/charts'
import { cssVariable } from '../../../shared/theme/registry'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import { gridLimits } from '../grid/constants'
import { LocalGrid } from '../grid/LocalGrid'
import { scrollbarSize } from '../grid/scrollbar'
import type { GridViewState } from '../results/ResultsService'
import { bindChart, ChartView, chartLimits, forcedColorsDashes, probeCurrent, type ChartLabels, type ChartLink, type ChartScale, type ChartSeries, type ChartSource, type ChartWindow, chartColumnsWiden, chartTable } from './ChartView'

export interface LiveChartProps {
  readonly handle: ChartSource
  readonly probe: LiveProbeId
  readonly title: string
  /** At most chartLimits.series (12); the rest are left out of the plot, the legend and the table alike. */
  readonly series: readonly ChartSeries[]
  readonly scale: ChartScale
  readonly window: ChartWindow
  readonly variant?: 'chart' | 'sparkline'
  readonly labels?: ChartLabels
  readonly surface?: ChartSurface
  readonly link?: ChartLink
  /** Rows "View as table" shows at most (up to 120). */
  readonly tableRows?: number
  /** Whether the table shows instead of the plot; the chart keeps this itself unless it is given. */
  readonly tableShown?: boolean
  readonly onTableShownChange?: (shown: boolean) => void
  /** The "View as table" button under the plot; true by default. A document that offers the command from its catalogue
   *  instead passes false, and drives the table with `tableShown`. */
  readonly tableToggle?: boolean
  readonly className?: string
  /** The chart's view once it exists, and undefined when it goes: for a tile's headline value, or tests. */
  readonly onView?: (view: ChartView | undefined) => void
}

const forcedQuery = '(forced-colors: active)'
function subscribeForced(listener: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const query = matchMedia(forcedQuery)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
const forcedNow = () => typeof matchMedia === 'function' && matchMedia(forcedQuery).matches
/** Whether forced colours are on: a drawing that fills with theme colours leaves its fills to the forced-colours CSS then. */
export const useForcedColors = (): boolean => useSyncExternalStore(subscribeForced, forcedNow)

const noTable = { data: chartTable([], []), shown: 0, total: 0 }

export function LiveChart(props: LiveChartProps) {
  const { handle, probe, title, scale, window, variant = 'chart', labels, surface, link, tableRows, className, onView, onTableShownChange, tableToggle = true } = props
  const { theme, live } = useWorkbench()
  const series = useMemo(() => props.series.slice(0, chartLimits.series), [props.series])
  const rootRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), viewRef = useRef<ChartView | undefined>(undefined)
  const [view, setView] = useState<ChartView>()
  const [ownTableShown, setOwnTableShown] = useState(false)
  const tableShown = props.tableShown ?? ownTableShown
  const toggleTable = () => { const next = !tableShown; if (props.tableShown === undefined) setOwnTableShown(next); onTableShownChange?.(next) }
  const [table, setTable] = useState<{ data: LocalTableData; shown: number; total: number }>(noTable)
  const forced = useForcedColors()
  const onViewRef = useRef(onView)
  onViewRef.current = onView
  const first = useRef({ title, series, scale, window })
  first.current = { title, series, scale, window }
  // Settings that change what is drawn go to the view; changing the probe, handle or kind of chart builds a new one.
  useLayoutEffect(() => {
    const initial = first.current
    const view = new ChartView({
      canvas: canvasRef.current!, root: rootRef.current!, ring: () => handle.ring(probe), title: initial.title, series: initial.series, scale: initial.scale,
      window: initial.window, colors: theme.getSnapshot().active.colors, current: probeCurrent(handle.getSnapshot(), probe, Date.now()), variant, labels, surface, page: live.page, link
    })
    viewRef.current = view
    setView(view)
    onViewRef.current?.(view)
    const bound = bindChart(view, handle, probe)
    const themed = theme.subscribe(() => view.setTheme(theme.getSnapshot().active.colors))
    return () => {
      bound.dispose()
      themed()
      view.dispose()
      if (viewRef.current === view) viewRef.current = undefined
      setView(current => current === view ? undefined : current)
      try { onViewRef.current?.(undefined) } catch (error) { onUnexpectedError(error) }
    }
  }, [handle, probe, theme, live, variant, labels, surface, link])
  const seriesKey = JSON.stringify([series, scale]), windowKey = JSON.stringify(window)
  useEffect(() => { viewRef.current?.setSeries(series, scale) }, [seriesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewRef.current?.setWindow(window) }, [windowKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewRef.current?.setTitle(title) }, [title])
  // The table follows the ticks only while it shows, and what changes it without a tick: the probe stopping or starting,
  // a ring resized.
  const limit = Math.max(1, Math.min(tableRows ?? chartLimits.tableRows, chartLimits.tableRows))
  useEffect(() => {
    if (!tableShown || !view) return
    // Each sample is a new table object, which the grid takes in place of the last (LocalGrid), keeping its state.
    const refresh = () => { const sampled = view.table(limit); setTable({ data: chartTable(series, sampled.rows), shown: sampled.rows.length, total: sampled.total }) }
    refresh()
    const ticks = handle.onTick(refresh), stale = view.subscribe(refresh)
    return () => { ticks.dispose(); stale.dispose() }
  }, [tableShown, view, handle, limit, seriesKey, windowKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Scroll, widths and the selection (where it is on screen) last while the table shows with the same series: each tick swaps
  // its table into the same view. Not sortable: its rows run newest first, and its values carry units, which sort as text.
  const gridState = useMemo<GridViewState>(() => ({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }), [tableShown, seriesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // The grid sizes its columns from its first table; a value longer than any before (0/s becoming 12,345/s) has the columns the
  // user has not sized measured again. This runs after the grid's own effect has swapped the table in, before its next frame.
  // While a measure is pending (sized is false: not yet drawn, hidden, or asked for here), the grid will size from the latest
  // table, so the lengths follow it until the grid has sized.
  const widest = useRef<{ state?: GridViewState; lengths: number[] }>({ lengths: [] })
  useEffect(() => {
    if (widest.current.state !== gridState) widest.current = { state: gridState, lengths: [] }
    if (!table.data.rows.length) return
    const next = chartColumnsWiden(gridState.sized ? widest.current.lengths : [], table.data)
    widest.current.lengths = next.widest
    if (next.grew) gridState.sized = false
  }, [table, gridState])
  // As many rows as the plot's place holds under the header (and a scroll bar, should the columns be wider).
  const [room, setRoom] = useState<HTMLDivElement | null>(null)
  const [roomHeight, setRoomHeight] = useState<number>()
  useLayoutEffect(() => {
    if (!room) return
    if (typeof ResizeObserver !== 'function') { setRoomHeight(room.clientHeight); return }
    const observer = new ResizeObserver(() => setRoomHeight(room.clientHeight))
    observer.observe(room)
    return () => observer.disconnect()
  }, [room])
  const maxRows = roomHeight ? Math.max(1, Math.floor((roomHeight - gridLimits.headerHeight - 2 - scrollbarSize()) / gridLimits.rowHeight)) : undefined
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  const chart = variant === 'chart'
  const legend = useMemo(() => series.map((entry, at) => ({ ...entry, at })), [series])
  const tableOn = chart && tableShown
  return <div ref={rootRef} className={`live-chart${className ? ' ' + className : ''}`} data-variant={variant} data-table={tableOn ? '' : undefined}>
    {chart && series.length > 1 && <ul className="live-chart-legend" aria-label={`${title} series`}>
      {legend.map(entry => <li key={entry.index}>
        <svg className="live-chart-swatch" viewBox="0 0 16 8" aria-hidden="true">
          <line x1="0" y1="4" x2="16" y2="4" strokeWidth={entry.style === 'stacked' ? 6 : 2} strokeDasharray={forced ? forcedColorsDashes[entry.at % forcedColorsDashes.length].join(' ') || undefined : undefined}
            style={forced ? undefined : { stroke: `var(${cssVariable(entry.color)})` }} />
        </svg>{entry.label}
      </li>)}
    </ul>}
    <canvas ref={canvasRef} className="live-chart-canvas" tabIndex={chart ? 0 : undefined} onKeyDown={chart ? keyDown : undefined} />
    {tableOn && <div className="live-chart-table-wrap">
      <p className="live-chart-table-caption">{table.total === 0 ? `${title}: no samples yet` : `${title}: ${table.shown < table.total ? `${table.shown} of ${table.total}` : table.total} samples, newest first`}</p>
      <div ref={setRoom} className="live-chart-table-room">
        {(roomHeight !== undefined || typeof ResizeObserver !== 'function') && <LocalGrid table={table.data} label={`${title} table`} preset="card" sortable={false} maxRows={maxRows} state={gridState} empty="No samples yet." />}
      </div>
    </div>}
    {chart && tableToggle && <button type="button" className="live-chart-toggle" aria-pressed={tableShown} onClick={toggleTable}>View as table</button>}
  </div>
}
