// Test mode's `window.__variaLive` (scripts/live-smoke.mjs, scripts/chart-smoke.mjs): live views on the backend's
// debug.synthetic source, owned by a tab, charts of them in a box over the workbench, and the window's visibility, which
// smoke runs cannot change for real (their windows keep background throttling off, so the page always counts as visible).
// Main enables test mode only in unpackaged smoke runs, and only its test schemas accept the synthetic source.
import { liveProbes, liveSources, type LiveProbeId, type LiveUnit } from '../../../shared/live/catalog'
import type { ChartSeriesColor } from '../../../shared/theme/charts'
import { cssVariable } from '../../../shared/theme/registry'
import type { DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import { chartColor, type ChartLabels, type ChartStyle, type ChartView } from './ChartView'
import type { LiveChartProps } from './LiveChart'
import { documentOwner, type LiveHandle, type LiveService } from './LiveService'

export interface SyntheticOptions {
  /** The owner tab; the active one by default. */
  readonly tabId?: string
  /** The view's connection; the tab's own by default (or a new id: the synthetic source runs no SQL). */
  readonly connectionId?: string
  readonly probes?: readonly LiveProbeId[]
  readonly intervalMs?: number
  readonly rows?: number
  readonly tickMs?: number
  readonly endAfterTicks?: number
}

export interface ChartOptions {
  readonly probe?: LiveProbeId
  /** Series indexes in the probe's catalogue order; the wave (1) by default. */
  readonly series?: readonly number[]
  readonly style?: ChartStyle
  readonly variant?: 'chart' | 'sparkline'
  readonly labels?: ChartLabels
  readonly unit?: LiveUnit
  readonly max?: number
  readonly spanMs?: number
  readonly width?: number
  readonly height?: number
}
/** Renders a LiveChart into a container (start.tsx, inside the workbench's provider) and returns how to unmount it. */
export type RenderChart = (props: LiveChartProps, container: HTMLElement) => () => void

/** How many of the canvas's pixels are exactly each chart color of the active theme, and how many are drawn at all. */
function pixelsOf(canvas: HTMLCanvasElement, colors: readonly ChartSeriesColor[]): { drawn: number; colors: Record<string, number> } {
  const style = getComputedStyle(document.documentElement)
  const wanted = colors.map(color => [color, Number.parseInt(style.getPropertyValue(cssVariable(color)).trim().slice(1, 7), 16)] as const)
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const counts = Object.fromEntries(colors.map(color => [color, 0]))
  let drawn = 0
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) continue
    drawn++
    if (data[at + 3] !== 255) continue
    const rgb = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2]
    for (const [color, value] of wanted) if (rgb === value) counts[color]++
  }
  return { drawn, colors: counts }
}

export function liveTestHooks(live: LiveService, documents: DocumentService, panes: PaneService, renderChart?: RenderChart) {
  const handles = new Map<string, LiveHandle>()
  const handle = (id: string) => handles.get(id)
  const charts = new Map<string, { container: HTMLElement; unmount: () => void; view?: ChartView; colors: ChartSeriesColor[] }>()
  return {
    snapshot: (id?: string) => id === undefined ? live.getSnapshot() : handle(id)?.getSnapshot(),
    frames: (id: string) => live.frames(id),
    setPageHidden: (hidden?: boolean) => live.setPageHidden(hidden),
    subscribeSynthetic: (o: SyntheticOptions = {}): string => {
      const tabId = o.tabId ?? documents.getSnapshot().activeId
      const connectionId = o.connectionId ?? documents.get(tabId)?.connectionId ?? crypto.randomUUID()
      const probes = o.probes ?? liveSources['debug.synthetic'].probes as readonly LiveProbeId[]
      const created = live.open({
        connectionId, source: 'debug.synthetic', probes: probes.map(probe => ({ probe, ...o.intervalMs ? { intervalMs: o.intervalMs } : {} })),
        args: { ...o.rows !== undefined ? { rows: o.rows } : {}, ...o.tickMs !== undefined ? { tickMs: o.tickMs } : {}, ...o.endAfterTicks !== undefined ? { endAfterTicks: o.endAfterTicks } : {} }
      }, documentOwner(tabId, documents, panes))
      handles.set(created.id, created)
      return created.id
    },
    setUserPaused: (id: string, paused: boolean) => handle(id)?.setUserPaused(paused),
    refresh: (id: string) => handle(id)?.refresh(),
    dispose: (id: string) => { handle(id)?.dispose(); handles.delete(id) },
    ring: (id: string, probe: LiveProbeId) => { const ring = handle(id)?.ring(probe); return ring && { length: ring.length, capacity: ring.capacity, lastTime: ring.lastTime, gaps: Array.from({ length: ring.length }, (_, index) => ring.flags(index)).filter(flags => flags & 1).length } },
    table: (id: string, probe: LiveProbeId) => { const table = handle(id)?.table(probe); return table && { descriptor: table.descriptor, revision: table.revision, state: table.handle.getSnapshot().state } },
    /** Shows a chart of a view's probe in a fixed box over the workbench; returns its key. */
    mountChart: (id: string, o: ChartOptions = {}): string | undefined => {
      const owner = handle(id)
      if (!owner || !renderChart) return undefined
      const probe = o.probe ?? 'debug.synthetic.metrics', specs = liveProbes[probe].series ?? []
      const indexes = o.series ?? [1], key = crypto.randomUUID()
      const container = document.createElement('div')
      container.dataset.chartTest = key
      container.style.cssText = `position: fixed; left: 40px; top: 80px; width: ${o.width ?? 480}px; height: ${o.height ?? 200}px; z-index: 20000; display: grid; padding: 8px; background: var(${cssVariable('panel.background')})`
      document.body.append(container)
      const colors = indexes.map((_, at) => chartColor(at))
      const entry: { container: HTMLElement; unmount: () => void; view?: ChartView; colors: ChartSeriesColor[] } = { container, unmount: () => {}, colors }
      charts.set(key, entry)
      entry.unmount = renderChart({
        handle: owner, probe, title: liveProbes[probe].label, variant: o.variant, labels: o.labels, onView: view => { entry.view = view },
        series: indexes.map((index, at) => ({ index, label: specs[index]?.label ?? String(index), color: colors[at], style: o.style })),
        scale: { unit: o.unit ?? specs[indexes[0]]?.unit ?? 'count', ...o.max !== undefined ? { max: o.max } : {} }, window: { spanMs: o.spanMs ?? 60_000, end: 'live' }
      }, container)
      return key
    },
    /** A mounted chart's draws, accessible name, latest values, newest table rows and canvas pixels. */
    chart: (key: string) => {
      const entry = charts.get(key), view = entry?.view
      const canvas = entry?.container.querySelector('canvas')
      return view && canvas ? { ...view.stats, label: view.ariaLabel, latest: view.latest(), rows: view.table(5).rows, width: canvas.width, height: canvas.height, pixels: pixelsOf(canvas, entry.colors) } : undefined
    },
    unmountChart: (key: string) => { const entry = charts.get(key); entry?.unmount(); entry?.container.remove(); charts.delete(key) }
  }
}
