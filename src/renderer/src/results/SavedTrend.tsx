// The Nerd metrics heading's sparkline: the share of rows compression gave back, one sample per results.memory event
// that brought a new detail. It draws through ChartView like every chart, from the memory service's ring rather than a
// probe's, and redraws when the service publishes: no timer of its own.
import { useLayoutEffect, useRef } from 'react'
import { useWorkbench } from '../core/WorkbenchContext'
import { ChartView, type ChartSeries } from '../live/ChartView'
import { chartCategorical } from '../../../shared/theme/charts'
import type { MemoryUsageService } from './memory'

/** Green, the categorical hue that matches the Saved tile's success tone. */
const saved = chartCategorical[2]
const series: readonly ChartSeries[] = [{ index: 0, label: 'Saved', color: saved, style: 'area' }]
/** The last ten minutes of events, up to the newest. */
const spanMs = 10 * 60_000

export function SavedTrend({ memory }: { memory: MemoryUsageService }) {
  const { theme, live } = useWorkbench()
  const rootRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const view = new ChartView({
      canvas: canvasRef.current!, root: rootRef.current!, ring: () => memory.history, title: 'Share of rows compression gave back', series,
      scale: { unit: 'percent', min: 0, max: 'auto' }, window: { spanMs, end: 'live' }, colors: theme.getSnapshot().active.colors,
      variant: 'sparkline', labels: 'none', surface: 'menu.background', page: live.page
    })
    const redraw = memory.subscribe(() => view.invalidate())
    const themed = theme.subscribe(() => view.setTheme(theme.getSnapshot().active.colors))
    return () => { redraw(); themed(); view.dispose() }
  }, [memory, theme, live])
  return <div ref={rootRef} className="live-chart memory-trend" data-variant="sparkline"><canvas ref={canvasRef} className="live-chart-canvas" /></div>
}
