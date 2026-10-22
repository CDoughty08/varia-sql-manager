// The React shell of a live chart: it mounts the canvas, the legend and "View as table", and hands everything else to
// ChartView, which draws from the probe's ring and redraws on the view's ticks. Sparklines (a tile's trace) have no
// legend, labels, crosshair or table; the tile around them says the value.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { ChartSurface } from '../../../shared/theme/charts'
import { cssVariable } from '../../../shared/theme/registry'
import { onUnexpectedError } from '../core/errors'
import { useWorkbench } from '../core/WorkbenchContext'
import { ChartView, chartLimits, forcedColorsDashes, type ChartLabels, type ChartLink, type ChartScale, type ChartSeries, type ChartTableRow, type ChartWindow } from './ChartView'
import type { LiveHandle } from './LiveService'

export interface LiveChartProps {
  readonly handle: Pick<LiveHandle, 'ring' | 'onTick'>
  readonly probe: LiveProbeId
  readonly title: string
  readonly series: readonly ChartSeries[]
  readonly scale: ChartScale
  readonly window: ChartWindow
  readonly variant?: 'chart' | 'sparkline'
  readonly labels?: ChartLabels
  readonly surface?: ChartSurface
  readonly link?: ChartLink
  /** Rows "View as table" shows at most (up to 120). */
  readonly tableRows?: number
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

export function LiveChart(props: LiveChartProps) {
  const { handle, probe, title, series, scale, window, variant = 'chart', labels, surface, link, tableRows, className, onView } = props
  const { theme, live } = useWorkbench()
  const rootRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), viewRef = useRef<ChartView | undefined>(undefined)
  const [tableShown, setTableShown] = useState(false)
  const [table, setTable] = useState<{ rows: readonly ChartTableRow[]; total: number }>({ rows: [], total: 0 })
  const forced = useSyncExternalStore(subscribeForced, forcedNow)
  const onViewRef = useRef(onView)
  onViewRef.current = onView
  const first = useRef({ title, series, scale, window })
  first.current = { title, series, scale, window }
  // Settings that change what is drawn go to the view; changing the probe, handle or kind of chart builds a new one.
  useLayoutEffect(() => {
    const initial = first.current
    const view = new ChartView({
      canvas: canvasRef.current!, root: rootRef.current!, ring: () => handle.ring(probe), title: initial.title, series: initial.series, scale: initial.scale,
      window: initial.window, colors: theme.getSnapshot().active.colors, variant, labels, surface, page: live.page, link
    })
    viewRef.current = view
    onViewRef.current?.(view)
    const ticks = handle.onTick(() => view.invalidate())
    const themed = theme.subscribe(() => view.setTheme(theme.getSnapshot().active.colors))
    return () => {
      ticks.dispose()
      themed()
      view.dispose()
      if (viewRef.current === view) viewRef.current = undefined
      try { onViewRef.current?.(undefined) } catch (error) { onUnexpectedError(error) }
    }
  }, [handle, probe, theme, live, variant, labels, surface, link])
  const seriesKey = JSON.stringify([series, scale]), windowKey = JSON.stringify(window)
  useEffect(() => { viewRef.current?.setSeries(series, scale) }, [seriesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewRef.current?.setWindow(window) }, [windowKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewRef.current?.setTitle(title) }, [title])
  // The table follows the ticks only while it shows.
  const limit = Math.min(tableRows ?? chartLimits.tableRows, chartLimits.tableRows)
  useEffect(() => {
    if (!tableShown) return
    const refresh = () => { const view = viewRef.current; if (view) setTable(view.table(limit)) }
    refresh()
    const ticks = handle.onTick(refresh)
    return () => ticks.dispose()
  }, [tableShown, handle, limit, seriesKey, windowKey])
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  const chart = variant === 'chart'
  const legend = useMemo(() => series.map((entry, at) => ({ ...entry, at })), [series])
  return <div ref={rootRef} className={`live-chart${className ? ' ' + className : ''}`} data-variant={variant}>
    {chart && series.length > 1 && <ul className="live-chart-legend" aria-label={`${title} series`}>
      {legend.map(entry => <li key={entry.index}>
        <svg className="live-chart-swatch" viewBox="0 0 16 8" aria-hidden="true">
          <line x1="0" y1="4" x2="16" y2="4" strokeWidth={entry.style === 'stacked' ? 6 : 2} strokeDasharray={forced ? forcedColorsDashes[entry.at % forcedColorsDashes.length].join(' ') || undefined : undefined}
            style={forced ? undefined : { stroke: `var(${cssVariable(entry.color)})` }} />
        </svg>{entry.label}
      </li>)}
    </ul>}
    <canvas ref={canvasRef} className="live-chart-canvas" tabIndex={chart ? 0 : -1} onKeyDown={chart ? keyDown : undefined} />
    {chart && <button type="button" className="live-chart-toggle" aria-pressed={tableShown} onClick={() => setTableShown(shown => !shown)}>View as table</button>}
    {chart && tableShown && <table className="live-chart-table">
      <caption>{table.total === 0 ? `${title}: no samples yet` : `${title}: ${table.rows.length < table.total ? `${table.rows.length} of ${table.total}` : table.total} samples, newest first`}</caption>
      <thead><tr><th scope="col">Time</th>{series.map(entry => <th key={entry.index} scope="col">{entry.label}</th>)}</tr></thead>
      <tbody>{table.rows.map((row, at) => <tr key={at}><th scope="row">{row.gapBefore ? `${row.time} (after a gap)` : row.time}</th>{row.values.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody>
    </table>}
  </div>
}
