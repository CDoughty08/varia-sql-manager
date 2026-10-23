// A live view's chart (docs/ipc.md, Live subscriptions, Charts): one canvas drawn from a MetricRing, imperative like
// GridView, so nothing in React runs per point. It draws at most once an animation frame, only when the ring, the window,
// the size, the pixel ratio, the theme or the crosshair changed, and only while the canvas is on screen and the page is
// visible. Each series is reduced to the smallest and largest value in each device pixel column, so a draw strokes at
// most two vertices a column whatever the history holds; a gap in the history (a pause, a reset, missed samples) or a
// missing value breaks the line. Colors come only from the active theme's charts.* keys, or the system colors under
// forced colors. Text on the canvas is drawn with fillText; the tooltip and the crosshair's announcement are Text nodes.
import type { LiveUnit } from '../../../shared/live/catalog'
import { chartCategorical, type ChartSeriesColor, type ChartSurface } from '../../../shared/theme/charts'
import { typeScale } from '../../../shared/theme/metrics'
import type { ColorKey } from '../../../shared/theme/registry'
import type { Disposable } from '../core/types'
import { uiFontFamily } from '../fonts'
import { chartLabel, formatAgo, formatChartValue, formatClock, formatSpanShort, niceCeiling, type SeriesSummary } from './chart-format'
import type { PageVisibility } from './LiveService'
import { ringGap, type MetricRing } from './ring'

/** A line; a line over a faint fill (one series); or a band stacked on the series before it (waits by category). */
export type ChartStyle = 'line' | 'area' | 'stacked'
export interface ChartSeries {
  /** The series' index in the ring (the catalogue's order). */
  readonly index: number
  readonly label: string
  readonly color: ChartSeriesColor
  readonly style?: ChartStyle
}
/** The value axis: `unit` labels values; `min` defaults to 0, `max` to a round number above the window's largest value. */
export interface ChartScale { readonly unit: LiveUnit; readonly min?: number; readonly max?: number | 'auto' }
/** The time axis: the last `spanMs` up to the newest sample (`live`), or up to a fixed time (a scrubbed window). */
export interface ChartWindow { readonly spanMs: number; readonly end: 'live' | number }
/** No text (sparklines), the scale's top value (cards), or value and time labels (expanded charts). */
export type ChartLabels = 'none' | 'max' | 'axes'
export type ChartColors = Readonly<Record<ColorKey, string>>

/** The browser services a chart uses; tests pass fakes. */
export interface ChartEnvironment {
  requestFrame(callback: () => void): number
  cancelFrame(handle: number): void
  /** Calls back with whether the element is on screen (an IntersectionObserver). */
  observeVisibility(element: Element, listener: (visible: boolean) => void): () => void
  observeSize(element: Element, listener: () => void): () => void
  forcedColors(): boolean
  observeForcedColors(listener: () => void): () => void
  /** Calls back when the device pixel ratio changes (the window moved to a display of another scale), which resizes
   *  nothing, so the size observer does not see it. */
  observeDevicePixelRatio(listener: () => void): () => void
  devicePixelRatio(): number
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ChartViewOptions {
  readonly canvas: HTMLCanvasElement
  /** A positioned element around the canvas: it gets the tooltip and the crosshair's announcement. */
  readonly root: HTMLElement
  /** The probe's history; undefined until the view opens. */
  readonly ring: () => MetricRing | undefined
  readonly title: string
  readonly series: readonly ChartSeries[]
  readonly scale: ChartScale
  readonly window: ChartWindow
  readonly colors: ChartColors
  readonly variant?: 'chart' | 'sparkline'
  readonly labels?: ChartLabels
  /** What the chart sits on; 'panel.background' (a card) by default. */
  readonly surface?: ChartSurface
  readonly page?: PageVisibility
  /** Charts that show one crosshair together. */
  readonly link?: ChartLink
  readonly env?: ChartEnvironment
}

export const chartLimits = {
  /** The accessible name changes at most this often, so a screen reader is not interrupted every tick. */
  labelMs: 5000,
  /** Rows "View as table" shows at most; a longer window is sampled evenly, newest first. */
  tableRows: 120,
  /** The most series one chart draws. */
  series: 12,
  /** A live window's newest sample is stale once this long has passed, or twice the step between samples if longer;
   *  times then read as clock times, not as "now" and "ago", since collection has stopped (a pause, a loss). */
  staleMs: 2000
} as const
/** Under forced colors every series is CanvasText: series after the first are told apart by their dashes, as in the legend. */
export const forcedColorsDashes: readonly (readonly number[])[] = [[], [6, 3], [2, 2], [8, 3, 2, 3], [1, 3], [10, 4]]
let chartIds = 0
/** What a chart that is not stacked fills under its single area series. */
const areaAlpha = 0.14

/** The window over the ring as it is now: its times, its samples, and whether its times read as "ago" from the newest
 *  sample (a live window whose newest sample is current) or as clock times. Independent of the canvas's size. */
interface Span { readonly start: number; readonly span: number; readonly first: number; readonly count: number; readonly relative: boolean }
/** A span and the plot area for the canvas's size. */
interface Layout extends Span { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly min: number; readonly max: number }
interface Crosshair { readonly time: number; readonly from: 'pointer' | 'key' | 'link' }
export interface ChartTableRow { readonly time: string; readonly values: readonly string[]; readonly gapBefore: boolean }
export interface ChartStats { frames: number; draws: number }

export function browserChartEnvironment(): ChartEnvironment {
  const forced = typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : undefined
  return {
    requestFrame: callback => requestAnimationFrame(() => callback()),
    cancelFrame: handle => cancelAnimationFrame(handle),
    observeVisibility: (element, listener) => {
      if (typeof IntersectionObserver !== 'function') return () => {}
      const observer = new IntersectionObserver(entries => { const entry = entries.at(-1); if (entry) listener(entry.isIntersecting) })
      observer.observe(element)
      return () => observer.disconnect()
    },
    observeSize: (element, listener) => {
      if (typeof ResizeObserver !== 'function') return () => {}
      const observer = new ResizeObserver(() => listener())
      observer.observe(element)
      return () => observer.disconnect()
    },
    forcedColors: () => forced?.matches ?? false,
    observeForcedColors: listener => { forced?.addEventListener('change', listener); return () => forced?.removeEventListener('change', listener) },
    observeDevicePixelRatio: listener => {
      if (typeof matchMedia !== 'function') return () => {}
      // A resolution query matches only the current ratio, so it is armed again for the new one each time it changes.
      let query: MediaQueryList | undefined
      const changed = () => { query?.removeEventListener('change', changed); arm(); listener() }
      const arm = () => { query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); query.addEventListener('change', changed) }
      arm()
      return () => query?.removeEventListener('change', changed)
    },
    devicePixelRatio: () => (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1),
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** The categorical color of the n-th series: blue, orange, green, yellow, purple, then round again. */
export const chartColor = (index: number): ChartSeriesColor => chartCategorical[((index % chartCategorical.length) + chartCategorical.length) % chartCategorical.length]

/** Charts that move one crosshair together: hovering or stepping through one shows the same moment in the others. */
export class ChartLink {
  private readonly views = new Set<ChartView>()
  join(view: ChartView): Disposable {
    this.views.add(view)
    return { dispose: () => { this.views.delete(view) } }
  }
  /** `time` undefined hides the others' crosshairs. */
  moved(from: ChartView, time: number | undefined): void {
    for (const view of this.views) if (view !== from) view.showLinked(time)
  }
}

/** Per series, per device pixel column: the smallest, largest, first and last value, and whether the line breaks before it. */
class Buckets {
  columns = 0
  values = new Float64Array(0)
  breaks = new Uint8Array(0)
  reset(columns: number, series: number): void {
    if (this.columns !== columns || this.values.length !== columns * series * 4) {
      this.columns = columns
      this.values = new Float64Array(columns * series * 4)
      this.breaks = new Uint8Array(columns * series)
    }
    this.values.fill(Number.NaN)
    this.breaks.fill(0)
  }
}

export class ChartView implements Disposable {
  readonly stats: ChartStats = { frames: 0, draws: 0 }
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D | null
  private readonly env: ChartEnvironment
  private readonly tip: HTMLElement
  private readonly tipText: Text
  private readonly status: HTMLElement
  private readonly statusText: Text
  private readonly keys?: HTMLElement
  private readonly listeners = new Set<() => void>()
  private readonly stops: (() => void)[] = []
  private readonly linked?: Disposable
  private title: string
  private series: readonly ChartSeries[]
  private scale: ChartScale
  private window: ChartWindow
  private colors: ChartColors
  private onScreen = true
  private frameHandle?: number
  private disposed = false
  private configRevision = 0
  private colorsRevision = 0
  private crosshair?: Crosshair
  private layout?: Layout
  /** What the last draw drew; a frame with the same key draws nothing. */
  private drawn = ''
  private lastRing?: MetricRing
  private readonly buckets = new Buckets()
  private stack = { sums: new Float64Array(0), counts: new Float64Array(0), has: new Uint8Array(0), breaks: new Uint8Array(0), tops: new Float64Array(0) }
  private label = ''
  private labelAt = Number.NEGATIVE_INFINITY
  private pendingLabel?: string
  private labelTimer?: unknown
  private staleTimer?: unknown

  constructor(private readonly o: ChartViewOptions) {
    this.canvas = o.canvas
    this.context = o.canvas.getContext('2d')
    this.env = o.env ?? browserChartEnvironment()
    this.title = o.title
    this.series = o.series.slice(0, chartLimits.series)
    this.scale = o.scale
    this.window = o.window
    this.colors = o.colors
    const document = o.root.ownerDocument
    // The tooltip repeats what the crosshair's announcement says, so screen readers hear it once.
    this.tip = document.createElement('div')
    this.tip.className = 'live-chart-tip'
    this.tip.setAttribute('aria-hidden', 'true')
    this.tip.hidden = true
    this.tipText = document.createTextNode('')
    this.tip.append(this.tipText)
    this.status = document.createElement('div')
    this.status.className = 'visually-hidden'
    this.status.setAttribute('role', 'status')
    this.statusText = document.createTextNode('')
    this.status.append(this.statusText)
    o.root.append(this.tip, this.status)
    this.canvas.setAttribute('role', 'img')
    if (this.variant === 'chart') {
      // A screen reader in browse mode keeps the arrow keys for itself on an image, so the canvas says it takes them.
      this.keys = document.createElement('div')
      this.keys.className = 'visually-hidden'
      this.keys.setAttribute('id', `live-chart-keys-${++chartIds}`)
      this.keys.append(document.createTextNode('Left and Right step through the samples, Home and End go to the first and last, Escape hides the crosshair.'))
      o.root.append(this.keys)
      this.canvas.setAttribute('aria-roledescription', 'chart')
      this.canvas.setAttribute('aria-describedby', this.keys.getAttribute('id')!)
    }
    this.showLabel(`${this.title}: no data yet`)
    this.stops.push(this.env.observeVisibility(this.canvas, visible => { this.onScreen = visible; this.invalidate() }))
    this.stops.push(this.env.observeSize(this.canvas, () => this.invalidate()))
    this.stops.push(this.env.observeForcedColors(() => this.invalidate()))
    this.stops.push(this.env.observeDevicePixelRatio(() => this.invalidate()))
    if (o.page) this.stops.push(o.page.subscribe(() => this.invalidate()))
    if (this.variant === 'chart') {
      const move = (event: PointerEvent) => this.pointerMoved(event), leave = () => this.moveCrosshair(undefined)
      // The keyboard's crosshair goes with the focus, or its tooltip and the linked charts' lines would stay behind.
      const blur = () => { if (this.crosshair?.from === 'key') this.moveCrosshair(undefined) }
      this.canvas.addEventListener('pointermove', move)
      this.canvas.addEventListener('pointerleave', leave)
      this.canvas.addEventListener('blur', blur)
      this.stops.push(() => { this.canvas.removeEventListener('pointermove', move); this.canvas.removeEventListener('pointerleave', leave); this.canvas.removeEventListener('blur', blur) })
    }
    this.linked = o.link?.join(this)
    this.invalidate()
  }

  get variant(): 'chart' | 'sparkline' { return this.o.variant ?? 'chart' }
  private get labels(): ChartLabels { return this.o.labels ?? (this.variant === 'sparkline' ? 'none' : 'max') }
  /** The canvas's accessible name as it stands (it changes at most every 5 s). */
  get ariaLabel(): string { return this.label }

  /** Calls back when the window's times stop reading as "now" and "ago" without a tick (its newest sample went stale), so
   *  a table of the window lists it again. */
  subscribe(listener: () => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  /** Something the chart shows may have changed (a tick arrived): it redraws on the next frame if it did. */
  invalidate(): void {
    if (this.disposed) return
    this.watchStale()
    if (this.frameHandle !== undefined || !this.visible()) return
    this.frameHandle = this.env.requestFrame(() => { this.frameHandle = undefined; this.frame() })
  }

  setTheme(colors: ChartColors): void {
    if (colors === this.colors) return
    this.colors = colors
    this.colorsRevision++
    this.invalidate()
  }
  setSeries(series: readonly ChartSeries[], scale: ChartScale = this.scale): void {
    this.series = series.slice(0, chartLimits.series)
    this.scale = scale
    this.configRevision++
    this.invalidate()
  }
  setWindow(window: ChartWindow): void {
    this.window = window
    this.configRevision++
    this.invalidate()
  }
  setTitle(title: string): void {
    this.title = title
    this.configRevision++
    this.invalidate()
  }

  /** Another chart of the link moved its crosshair to `time` (undefined: it went away). */
  showLinked(time: number | undefined): void {
    if (this.variant !== 'chart') return
    if (time === undefined ? this.crosshair?.from !== 'link' : this.crosshair?.time === time) return
    this.crosshair = time === undefined ? undefined : { time, from: 'link' }
    this.invalidate()
  }

  /** The chart's own keys, from its React onKeyDown (they are not workbench commands, as the grid's are not): Left and
   *  Right step the crosshair one sample, Home and End go to the window's first and last, Escape hides it. True when the
   *  key was handled; the caller then prevents its default. */
  key(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
    if (this.variant !== 'chart' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
    if (event.key === 'Escape') {
      if (!this.crosshair) return false
      this.moveCrosshair(undefined)
      return true
    }
    const ring = this.o.ring(), layout = this.spanOf(ring)
    if (!ring || layout.count === 0) return ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    const last = layout.first + layout.count - 1
    const at = this.crosshair ? this.nearest(ring, layout, this.crosshair.time) : last
    const next = event.key === 'ArrowLeft' ? (this.crosshair ? at - 1 : last) : event.key === 'ArrowRight' ? at + 1 : event.key === 'Home' ? layout.first : event.key === 'End' ? last : undefined
    if (next === undefined) return false
    const index = Math.max(layout.first, Math.min(last, next))
    this.moveCrosshair(ring.time(index), 'key')
    this.statusText.nodeValue = this.describe(ring, layout, index)
    return true
  }

  /** The window's latest value of each series, NaN when it has none. */
  latest(): number[] {
    const ring = this.o.ring(), layout = this.spanOf(ring)
    return this.series.map(series => {
      if (!ring) return Number.NaN
      for (let index = layout.first + layout.count - 1; index >= layout.first; index--) {
        const value = ring.value(index, series.index)
        if (Number.isFinite(value)) return value
      }
      return Number.NaN
    })
  }

  /** "View as table": the window's samples, newest first, at most `limit` evenly spaced, with the window's sample count. */
  table(limit: number = chartLimits.tableRows): { readonly rows: readonly ChartTableRow[]; readonly total: number } {
    const ring = this.o.ring(), layout = this.spanOf(ring)
    if (!ring || layout.count === 0) return { rows: [], total: 0 }
    const take = Math.max(1, Math.min(Math.floor(limit), chartLimits.tableRows, layout.count))
    const at = (k: number) => layout.first + layout.count - 1 - (take === 1 ? 0 : Math.round(k * (layout.count - 1) / (take - 1)))
    const rows: ChartTableRow[] = []
    for (let k = 0; k < take; k++) {
      // A row follows a gap if any sample since the previous (older) row's does, listed or not, as the line breaks there.
      const index = at(k), older = k + 1 < take ? at(k + 1) : index - 1
      let gapBefore = false
      for (let from = index; from > older && !gapBefore; from--) gapBefore = (ring.flags(from) & ringGap) !== 0
      rows.push({ time: this.when(ring, layout, index), values: this.series.map(series => formatChartValue(ring.value(index, series.index), this.scale.unit)), gapBefore })
    }
    return { rows, total: layout.count }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameHandle !== undefined) this.env.cancelFrame(this.frameHandle)
    this.frameHandle = undefined
    if (this.labelTimer !== undefined) this.env.clearTimeout(this.labelTimer)
    if (this.staleTimer !== undefined) this.env.clearTimeout(this.staleTimer)
    for (const stop of this.stops.splice(0)) stop()
    // The linked charts drop the crosshair this one drove: nothing else would (a removed element gets no pointerleave).
    if (this.crosshair && this.crosshair.from !== 'link') this.o.link?.moved(this, undefined)
    this.linked?.dispose()
    this.listeners.clear()
    this.tip.remove()
    this.status.remove()
    this.keys?.remove()
  }

  private visible(): boolean { return this.onScreen && !(this.o.page?.hidden() ?? false) }

  private frame(): void {
    this.stats.frames++
    if (this.disposed || !this.visible() || !this.context) return
    const ring = this.o.ring()
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight, ratio = this.env.devicePixelRatio(), forced = this.env.forcedColors()
    const key = [ring ? ring.revision : -1, ring ? ring.capacity : 0, width, height, ratio, forced ? 1 : 0, this.colorsRevision, this.configRevision, this.crosshair?.time ?? '', this.crosshair?.from ?? '', this.stale(ring) ? 1 : 0].join(' ')
    if (key === this.drawn && ring === this.lastRing) return
    this.drawn = key
    this.lastRing = ring
    this.stats.draws++
    this.draw(this.context, ring, width, height, ratio, forced)
  }

  /** The window over the ring as it is now. A live one ends at the newest sample, so history stays in view when collection
   *  stops; its times then read as clock times once that sample is stale. */
  private spanOf(ring: MetricRing | undefined): Span {
    const span = Math.max(1, this.window.spanMs)
    const end = this.window.end === 'live' ? ring?.lastTime ?? this.env.now() : this.window.end
    const start = end - span
    const { first, count } = ring ? ring.range(start, end) : { first: 0, count: 0 }
    return { start, span, first, count, relative: this.window.end === 'live' && !this.stale(ring) }
  }

  /** How long after a live window's newest sample it counts as stale; undefined for a fixed window or an empty ring. */
  private staleAfter(ring: MetricRing | undefined): number | undefined {
    if (this.window.end !== 'live' || !ring || ring.length === 0) return undefined
    // The step between samples, from the last few that did not follow a gap (a resumed view's first step is the pause).
    let step = Number.POSITIVE_INFINITY
    for (let index = ring.length - 1; index > 0 && index >= ring.length - 3; index--) if (!(ring.flags(index) & ringGap)) step = Math.min(step, ring.time(index) - ring.time(index - 1))
    return Math.max(chartLimits.staleMs, Number.isFinite(step) ? 2 * step : 0)
  }

  private stale(ring: MetricRing | undefined): boolean {
    const after = this.staleAfter(ring)
    return after !== undefined && this.env.now() - ring!.lastTime! > after
  }

  /** Wakes the chart when its newest sample goes stale, which no tick announces. */
  private watchStale(): void {
    if (this.staleTimer !== undefined) return
    const ring = this.o.ring(), after = this.staleAfter(ring)
    if (after === undefined || this.stale(ring)) return
    this.staleTimer = this.env.setTimeout(() => {
      this.staleTimer = undefined
      if (this.disposed) return
      const stale = this.stale(this.o.ring())
      this.invalidate()
      if (stale) for (const listener of [...this.listeners]) listener()
    }, ring!.lastTime! + after - this.env.now() + 1)
  }

  /** The window and plot area for the canvas's current size, from the ring as it is now. */
  private measure(ring: MetricRing | undefined, width: number, height: number, context: CanvasRenderingContext2D): Layout | undefined {
    if (!(width > 0) || !(height > 0)) return undefined
    const window = this.spanOf(ring), { first, count } = window
    const { min, max } = this.valueRange(ring, first, count)
    const labels = this.labels, sparkline = this.variant === 'sparkline'
    let left = 1, top = sparkline ? 3 : 4, bottom = height - 2
    const right = width - (sparkline ? 3 : 5)
    if (labels === 'max') top = typeScale.xs.size + 4
    if (labels === 'axes') {
      top = typeScale.xs.size / 2 + 2
      bottom = height - typeScale.xs.line - 2
      left = Math.ceil(Math.max(...[min, (min + max) / 2, max].map(value => context.measureText(formatChartValue(value, this.scale.unit)).width))) + 6
    }
    return { ...window, left, top, right: Math.max(left + 1, right), bottom: Math.max(top + 1, bottom), min, max }
  }

  private valueRange(ring: MetricRing | undefined, first: number, count: number): { min: number; max: number } {
    const min = this.scale.min ?? 0
    if (typeof this.scale.max === 'number' && this.scale.max > min) return { min, max: this.scale.max }
    let top = Number.NEGATIVE_INFINITY
    if (ring && count > 0) {
      const stacked = this.series.filter(series => series.style === 'stacked')
      // A series with no value in the window has no top (NaN), which would poison every Math.max after it.
      for (const series of this.series) {
        if (series.style === 'stacked') continue
        const high = ring.minMax(series.index, first, count)[1]
        if (Number.isFinite(high)) top = Math.max(top, high)
      }
      if (stacked.length) {
        for (let index = first; index < first + count; index++) {
          let total = 0
          for (const series of stacked) { const value = ring.value(index, series.index); if (Number.isFinite(value)) total += value }
          top = Math.max(top, total)
        }
      }
    }
    return { min, max: min + niceCeiling(Number.isFinite(top) ? top - min : 0) }
  }

  private color(key: ColorKey, system: 'CanvasText' | 'Canvas' | 'GrayText', forced: boolean): string {
    return forced ? system : this.colors[key]
  }

  private draw(context: CanvasRenderingContext2D, ring: MetricRing | undefined, width: number, height: number, ratio: number, forced: boolean): void {
    const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio))
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.font = `${typeScale.xs.size}px ${uiFontFamily}`
    const layout = this.measure(ring, width, height, context)
    this.layout = layout
    // No size (the table took the plot's place, or the card collapsed): nothing to draw, and no tooltip to leave behind.
    if (!layout) { this.hideTip(); return }
    const y = (value: number) => layout.bottom - (Math.min(layout.max, Math.max(layout.min, value)) - layout.min) / (layout.max - layout.min) * (layout.bottom - layout.top)
    const snap = (value: number) => (Math.round(value * ratio) + 0.5) / ratio
    const surface = this.color(this.o.surface ?? 'panel.background', 'Canvas', forced)
    if (this.variant === 'chart') this.drawGrid(context, layout, y, snap, forced)
    const columns = Math.max(1, Math.floor((layout.right - layout.left) * ratio))
    const x = (column: number) => layout.left + (column + 0.5) / ratio
    if (ring && layout.count > 0) {
      const stacked = this.series.filter(series => series.style === 'stacked')
      if (stacked.length) this.drawStack(context, ring, layout, stacked, columns, x, y, surface, forced)
      const lines = this.series.filter(series => series.style !== 'stacked')
      this.bucket(ring, layout, lines, columns)
      lines.forEach((series, at) => this.drawLine(context, layout, series, at, this.series.indexOf(series), columns, x, y, forced))
      for (const series of lines) this.drawEnd(context, ring, layout, series, x, y, columns, surface, forced)
      this.drawCrosshair(context, ring, layout, x, y, columns, surface, forced)
    } else this.hideTip()
    if (this.variant === 'chart') this.drawLabels(context, layout, y, forced)
    this.updateLabel(ring, layout)
  }

  private drawGrid(context: CanvasRenderingContext2D, layout: Layout, y: (value: number) => number, snap: (value: number) => number, forced: boolean): void {
    context.strokeStyle = this.color('charts.lines', 'GrayText', forced)
    context.lineWidth = 1
    const line = (at: number, dashes: number[]) => {
      context.setLineDash(dashes)
      context.beginPath()
      context.moveTo(layout.left, snap(at))
      context.lineTo(layout.right, snap(at))
      context.stroke()
    }
    line(layout.bottom, [])
    line(y((layout.min + layout.max) / 2), [])
    // The scale's top is dashed: a reference, not a limit the data reached.
    line(y(layout.max), [2, 3])
    context.setLineDash([])
  }

  private drawLabels(context: CanvasRenderingContext2D, layout: Layout, y: (value: number) => number, forced: boolean): void {
    const labels = this.labels
    if (labels === 'none') return
    context.fillStyle = this.color('charts.foreground', 'CanvasText', forced)
    const value = (amount: number) => formatChartValue(amount, this.scale.unit)
    if (labels === 'max') {
      context.textAlign = 'right'
      context.textBaseline = 'alphabetic'
      context.fillText(value(layout.max), layout.right, y(layout.max) - 3)
      return
    }
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    for (const amount of [layout.max, (layout.min + layout.max) / 2, layout.min]) context.fillText(value(amount), layout.left - 6, y(amount))
    context.textBaseline = 'top'
    const below = layout.bottom + 3
    context.textAlign = 'left'
    context.fillText(layout.relative ? `${formatSpanShort(layout.span)} ago` : formatClock(layout.start), layout.left, below)
    context.textAlign = 'right'
    context.fillText(layout.relative ? 'now' : formatClock(layout.start + layout.span), layout.right, below)
  }

  /** Fills the buckets of the line and area series: min, max, first and last value per column, and the line's breaks. */
  private bucket(ring: MetricRing, layout: Layout, lines: readonly ChartSeries[], columns: number): void {
    this.buckets.reset(columns, lines.length)
    if (!lines.length) return
    const pending = new Uint8Array(lines.length)
    const end = layout.first + layout.count
    for (let index = layout.first; index < end; index++) {
      const column = Math.min(columns - 1, Math.max(0, Math.floor((ring.time(index) - layout.start) / layout.span * columns)))
      const gap = (ring.flags(index) & ringGap) !== 0
      for (let at = 0; at < lines.length; at++) {
        if (gap) pending[at] = 1
        const value = ring.value(index, lines[at].index)
        if (!Number.isFinite(value)) { pending[at] = 1; continue }
        const base = (at * columns + column) * 4, buckets = this.buckets.values
        if (Number.isNaN(buckets[base])) {
          buckets[base] = value; buckets[base + 1] = value; buckets[base + 2] = value
          this.buckets.breaks[at * columns + column] = pending[at]
        } else {
          if (value < buckets[base]) buckets[base] = value
          if (value > buckets[base + 1]) buckets[base + 1] = value
        }
        buckets[base + 3] = value
        pending[at] = 0
      }
    }
  }

  /** `at` is the series' place among the lines (its buckets), `place` its place in the chart (its dash, as in the legend). */
  private drawLine(context: CanvasRenderingContext2D, layout: Layout, series: ChartSeries, at: number, place: number, columns: number, x: (column: number) => number, y: (value: number) => number, forced: boolean): void {
    const values = this.buckets.values, breaks = this.buckets.breaks
    const color = this.color(series.color, 'CanvasText', forced)
    const area = series.style === 'area' && !forced
    // The faint area under the line first, then the line over it, each in at most two vertices a column.
    if (area) {
      context.fillStyle = color
      context.globalAlpha = areaAlpha
      context.beginPath()
      let open = false, lastX = 0
      for (let column = 0; column < columns; column++) {
        const base = (at * columns + column) * 4
        if (Number.isNaN(values[base])) continue
        const [a, b] = values[base + 2] <= values[base + 3] ? [values[base], values[base + 1]] : [values[base + 1], values[base]]
        if (open && breaks[at * columns + column]) { context.lineTo(lastX, layout.bottom); context.closePath(); open = false }
        if (!open) { context.moveTo(x(column), layout.bottom); open = true }
        context.lineTo(x(column), y(a))
        if (b !== a) context.lineTo(x(column), y(b))
        lastX = x(column)
      }
      if (open) { context.lineTo(lastX, layout.bottom); context.closePath() }
      context.fill()
      context.globalAlpha = 1
    }
    context.strokeStyle = color
    context.lineWidth = this.variant === 'sparkline' ? 1.5 : 1.75
    context.lineJoin = 'round'
    context.setLineDash(forced ? [...forcedColorsDashes[place % forcedColorsDashes.length]] : [])
    context.beginPath()
    let vertices = 0, lastX = 0, lastY = 0
    // A segment of one point (a sample between two gaps) gets a one-pixel tick so it shows.
    const close = () => { if (vertices === 1) context.lineTo(lastX + 1, lastY) }
    for (let column = 0; column < columns; column++) {
      const base = (at * columns + column) * 4
      if (Number.isNaN(values[base])) continue
      const [a, b] = values[base + 2] <= values[base + 3] ? [values[base], values[base + 1]] : [values[base + 1], values[base]]
      const left = x(column)
      if (vertices === 0 || breaks[at * columns + column]) { close(); context.moveTo(left, y(a)); vertices = 1 } else { context.lineTo(left, y(a)); vertices++ }
      lastX = left; lastY = y(a)
      if (b !== a) { context.lineTo(left, y(b)); vertices++; lastY = y(b) }
    }
    close()
    context.stroke()
    context.setLineDash([])
  }

  private drawStack(context: CanvasRenderingContext2D, ring: MetricRing, layout: Layout, stacked: readonly ChartSeries[], columns: number, x: (column: number) => number, y: (value: number) => number, surface: string, forced: boolean): void {
    const count = stacked.length
    if (this.stack.has.length !== columns || this.stack.tops.length !== columns * count) {
      this.stack = { sums: new Float64Array(columns * count), counts: new Float64Array(columns * count), has: new Uint8Array(columns), breaks: new Uint8Array(columns), tops: new Float64Array(columns * count) }
    }
    const { sums, counts, has, breaks, tops } = this.stack
    sums.fill(0); counts.fill(0); has.fill(0); breaks.fill(0)
    let pending = 0
    for (let index = layout.first; index < layout.first + layout.count; index++) {
      const column = Math.min(columns - 1, Math.max(0, Math.floor((ring.time(index) - layout.start) / layout.span * columns)))
      if (ring.flags(index) & ringGap) pending = 1
      let any = false
      for (let at = 0; at < count; at++) {
        const value = ring.value(index, stacked[at].index)
        if (Number.isFinite(value)) { sums[column * count + at] += value; counts[column * count + at]++; any = true }
      }
      if (!any) { pending = 1; continue }
      if (!has[column]) { has[column] = 1; breaks[column] = pending }
      pending = 0
    }
    // A column's bands are the means of its samples, each on the ones below; a missing series adds nothing.
    for (let column = 0; column < columns; column++) {
      let total = 0
      for (let at = 0; at < count; at++) {
        const cell = column * count + at
        total += counts[cell] ? sums[cell] / counts[cell] : 0
        tops[cell] = total
      }
    }
    const top = (column: number, at: number) => at < 0 ? layout.min : tops[column * count + at]
    for (let at = 0; at < count; at++) {
      const color = this.color(stacked[at].color, 'CanvasText', forced)
      // Each stretch between gaps is one band: along its top, then back along the band below it.
      for (let start = 0; start < columns;) {
        while (start < columns && !has[start]) start++
        if (start >= columns) break
        let end = start
        for (let column = start + 1; column < columns; column++) {
          if (!has[column]) continue
          if (breaks[column]) break
          end = column
        }
        if (!forced) {
          context.fillStyle = color
          context.beginPath()
          context.moveTo(x(start), y(top(start, at)))
          for (let column = start + 1; column <= end; column++) if (has[column]) context.lineTo(x(column), y(top(column, at)))
          for (let column = end; column >= start; column--) if (has[column]) context.lineTo(x(column), y(top(column, at - 1)))
          context.closePath()
          context.fill()
        }
        // A one-pixel line of the surface parts each band from the next; under forced colors it is the band itself.
        context.strokeStyle = forced ? color : surface
        context.lineWidth = forced ? 1.75 : 1
        context.setLineDash(forced ? [...forcedColorsDashes[this.series.indexOf(stacked[at]) % forcedColorsDashes.length]] : [])
        context.beginPath()
        context.moveTo(x(start), y(top(start, at)))
        for (let column = start + 1; column <= end; column++) if (has[column]) context.lineTo(x(column), y(top(column, at)))
        if (end === start) context.lineTo(x(start) + 1, y(top(start, at)))
        context.stroke()
        start = end + 1
      }
    }
    context.setLineDash([])
  }

  /** The newest sample's marker, ringed in the surface so it stands off the line. */
  private drawEnd(context: CanvasRenderingContext2D, ring: MetricRing, layout: Layout, series: ChartSeries, x: (column: number) => number, y: (value: number) => number, columns: number, surface: string, forced: boolean): void {
    const index = layout.first + layout.count - 1, value = ring.value(index, series.index)
    if (!Number.isFinite(value)) return
    this.dot(context, x(this.column(ring.time(index), layout, columns)), y(value), this.variant === 'sparkline' ? 2 : 3, this.color(series.color, 'CanvasText', forced), surface)
  }

  private dot(context: CanvasRenderingContext2D, left: number, top: number, radius: number, fill: string, ring: string): void {
    context.beginPath()
    context.arc(left, top, radius, 0, Math.PI * 2)
    context.fillStyle = fill
    context.fill()
    context.lineWidth = 2
    context.strokeStyle = ring
    context.stroke()
  }

  private column(time: number, layout: Layout, columns: number): number {
    return Math.min(columns - 1, Math.max(0, Math.floor((time - layout.start) / layout.span * columns)))
  }

  private drawCrosshair(context: CanvasRenderingContext2D, ring: MetricRing, layout: Layout, x: (column: number) => number, y: (value: number) => number, columns: number, surface: string, forced: boolean): void {
    const crosshair = this.crosshair
    if (!crosshair || this.variant !== 'chart' || crosshair.time < layout.start || crosshair.time > layout.start + layout.span) { this.hideTip(); return }
    const index = this.nearest(ring, layout, crosshair.time), left = x(this.column(ring.time(index), layout, columns))
    context.strokeStyle = this.color('charts.foreground', 'CanvasText', forced)
    context.lineWidth = 1
    context.setLineDash([2, 2])
    context.beginPath()
    context.moveTo(left, layout.top)
    context.lineTo(left, layout.bottom)
    context.stroke()
    context.setLineDash([])
    let stackedTotal = 0
    for (const series of this.series) {
      const value = ring.value(index, series.index)
      if (!Number.isFinite(value)) continue
      const at = series.style === 'stacked' ? (stackedTotal += value) : value
      this.dot(context, left, y(at), 3, this.color(series.color, 'CanvasText', forced), surface)
    }
    // Every chart of a link shows the line; only the one under the pointer or the keyboard shows its values.
    if (crosshair.from === 'link') { this.hideTip(); return }
    this.tipText.nodeValue = this.describe(ring, layout, index)
    this.tip.hidden = false
    // Inside the plot, at its top, beside the crosshair on whichever side has room, so it never leaves the chart's box.
    const width = this.tip.offsetWidth, gap = 8
    const beside = left + gap + width <= layout.right ? left + gap : Math.max(layout.left, left - gap - width)
    this.tip.style.left = `${this.canvas.offsetLeft + beside}px`
    this.tip.style.top = `${this.canvas.offsetTop + layout.top + 2}px`
  }

  private hideTip(): void { if (!this.tip.hidden) this.tip.hidden = true }

  /** The crosshair's sentence: "4:10 ago · 93 %", or "now · Read 12 MB/s · Write 5 MB/s". */
  private describe(ring: MetricRing, layout: Span, index: number): string {
    const values = this.series.map(series => {
      const value = formatChartValue(ring.value(index, series.index), this.scale.unit)
      return this.series.length > 1 ? `${series.label} ${value}` : value
    })
    return [this.when(ring, layout, index), ...values].join(' · ')
  }

  private when(ring: MetricRing, layout: Span, index: number): string {
    return layout.relative ? formatAgo(layout.start + layout.span - ring.time(index)) : formatClock(ring.time(index))
  }

  private nearest(ring: MetricRing, layout: Span, time: number): number {
    const last = layout.first + layout.count - 1
    const after = Math.max(layout.first, Math.min(last, ring.indexAt(time)))
    const before = Math.max(layout.first, after - 1)
    return Math.abs(ring.time(before) - time) <= Math.abs(ring.time(after) - time) ? before : after
  }

  private pointerMoved(event: PointerEvent): void {
    const ring = this.o.ring(), layout = this.layout
    if (!ring || !layout || layout.count === 0) return
    const offset = event.clientX - this.canvas.getBoundingClientRect().left
    const time = layout.start + (offset - layout.left) / Math.max(1, layout.right - layout.left) * layout.span
    this.moveCrosshair(ring.time(this.nearest(ring, layout, time)), 'pointer')
  }

  private moveCrosshair(time: number | undefined, from: 'pointer' | 'key' = 'pointer'): void {
    if (time === undefined ? !this.crosshair : this.crosshair?.time === time && this.crosshair.from === from) return
    this.crosshair = time === undefined ? undefined : { time, from }
    if (time === undefined) this.statusText.nodeValue = ''
    this.o.link?.moved(this, time)
    this.invalidate()
  }

  private updateLabel(ring: MetricRing | undefined, layout: Layout): void {
    const summaries: SeriesSummary[] = this.series.map(series => {
      if (!ring || layout.count === 0) return { label: series.label, latest: Number.NaN, min: Number.NaN, max: Number.NaN }
      const [min, max] = ring.minMax(series.index, layout.first, layout.count)
      let latest = Number.NaN
      for (let index = layout.first + layout.count - 1; index >= layout.first && Number.isNaN(latest); index--) {
        const value = ring.value(index, series.index)
        if (Number.isFinite(value)) latest = value
      }
      return { label: series.label, latest, min, max }
    })
    this.setLabel(chartLabel(this.title, this.scale.unit, layout.relative ? { spanMs: layout.span } : { from: layout.start, to: layout.start + layout.span }, summaries))
  }

  private showLabel(label: string): void {
    this.label = label
    this.pendingLabel = undefined
    this.canvas.setAttribute('aria-label', label)
  }

  private setLabel(label: string): void {
    if (label === this.label) { this.pendingLabel = undefined; return }
    const wait = this.labelAt + chartLimits.labelMs - this.env.now()
    if (wait <= 0) {
      this.labelAt = this.env.now()
      this.showLabel(label)
      return
    }
    this.pendingLabel = label
    if (this.labelTimer !== undefined) return
    this.labelTimer = this.env.setTimeout(() => {
      this.labelTimer = undefined
      if (!this.disposed && this.pendingLabel !== undefined) this.setLabel(this.pendingLabel)
    }, wait)
  }
}
