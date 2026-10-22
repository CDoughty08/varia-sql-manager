import { describe, expect, it } from 'vitest'
import { chartSeriesColors } from '../src/shared/theme/charts'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import { chartLabel, formatAgo, formatChartValue, formatClock, formatSpan, niceCeiling } from '../src/renderer/src/live/chart-format'
import { ChartLink, ChartView, chartColor, chartLimits, forcedColorsDashes, type ChartSeries, type ChartViewOptions } from '../src/renderer/src/live/ChartView'
import type { PageVisibility } from '../src/renderer/src/live/LiveService'
import { MetricRing, ringGap } from '../src/renderer/src/live/ring'
import { FakeCanvas, FakeChartEnvironment, fakeOwner, type FakeElement } from './fixtures/fake-canvas'

const dark = resolveBuiltin('dark').colors, light = resolveBuiltin('light').colors
const start = 1_000_000
/** A ring of `points` samples one second apart, ending at the environment's clock. */
function ringOf(points: number, series: number, value: (index: number, series: number) => number | null, flags: (index: number) => number = () => 0): MetricRing {
  const ring = new MetricRing(points, series)
  for (let index = 0; index < points; index++) ring.push(start - (points - 1 - index) * 1000, Array.from({ length: series }, (_, at) => value(index, at)), flags(index))
  return ring
}
interface Fixture { view: ChartView; canvas: FakeCanvas; env: FakeChartEnvironment; root: FakeElement; ring: { current: MetricRing | undefined } }
function chart(o: Partial<ChartViewOptions> & { ringValue?: MetricRing; width?: number; height?: number; env?: FakeChartEnvironment } = {}): Fixture {
  const owner = fakeOwner(), env = o.env ?? new FakeChartEnvironment()
  env.time = start
  const canvas = new FakeCanvas(owner, o.width ?? 400, o.height ?? 100), root = owner.createElement('div')
  const ring = { current: o.ringValue }
  const view = new ChartView({
    canvas: canvas as unknown as HTMLCanvasElement, root: root as unknown as HTMLElement, ring: () => ring.current, title: 'Wave',
    series: [{ index: 0, label: 'Wave', color: 'charts.blue' }], scale: { unit: 'percent', max: 100 }, window: { spanMs: 60_000, end: 'live' }, colors: dark, env,
    ...o
  })
  return { view, canvas, env, root, ring }
}
const seriesStrokes = (canvas: FakeCanvas, color: string) => canvas.context.strokes.filter(stroke => stroke.style === color && stroke.width > 1.5)

describe('chart text', () => {
  it('formats values with their units', () => {
    expect(formatChartValue(93.4, 'percent')).toBe('93.4 %')
    expect(formatChartValue(100, 'percent')).toBe('100 %')
    expect(formatChartValue(1234.5, 'perSecond')).toBe('1,235/s')
    expect(formatChartValue(12, 'ms')).toBe('12 ms')
    expect(formatChartValue(2840, 'msPerSecond')).toBe('2,840 ms/s')
    expect(formatChartValue(13.1 * 1048576, 'bytesPerSecond')).toBe('13.1 MB/s')
    expect(formatChartValue(512, 'bytesPerSecond')).toBe('512 B/s')
    expect(formatChartValue(0.25, 'count')).toBe('0.25')
    expect(formatChartValue(Number.NaN, 'count')).toBe('no value')
  })
  it('rounds scale tops up to 1, 2, 2.5 or 5 times a power of ten', () => {
    expect([0, -3, Number.NaN, 0.3, 1, 1.01, 2.2, 4, 7, 10, 2840, 3100].map(niceCeiling)).toEqual([1, 1, 1, 0.5, 1, 2, 2.5, 5, 10, 10, 5000, 5000])
  })
  it('says when a sample was', () => {
    expect([0, 400, 45_000, 250_000, 3_725_000].map(formatAgo)).toEqual(['now', 'now', '0:45 ago', '4:10 ago', '1:02:05 ago'])
    expect(formatClock(new Date(2026, 9, 22, 22, 41, 7).getTime())).toBe('22:41:07')
    expect([45_000, 60_000, 900_000, 3_600_000, 5_400_000].map(formatSpan)).toEqual(['45 seconds', '1 minute', '15 minutes', '1 hour', '1.5 hours'])
  })
  it('names a chart by its current value and range over the window', () => {
    expect(chartLabel('SQL Server CPU', 'percent', { spanMs: 300_000 }, [{ label: 'CPU', latest: 12, min: 3, max: 40 }])).toBe('SQL Server CPU: 12 %, 3 % to 40 % over the last 5 minutes')
    expect(chartLabel('Database I/O', 'bytesPerSecond', { spanMs: 60_000 }, [{ label: 'Read', latest: 1048576, min: 0, max: 2097152 }, { label: 'Write', latest: Number.NaN, min: 5, max: 5 }]))
      .toBe('Database I/O: Read 1 MB/s, 0 B/s to 2 MB/s; Write no current value, steady at 5 B/s over the last 1 minute')
    expect(chartLabel('Waits', 'msPerSecond', { spanMs: 60_000 }, [{ label: 'Lock', latest: Number.NaN, min: Number.NaN, max: Number.NaN }])).toBe('Waits: no data yet')
  })
})

describe('ChartView', () => {
  it('strokes at most two vertices a device pixel column, whatever the history holds', () => {
    for (const ratio of [1, 2]) {
      const env = new FakeChartEnvironment()
      env.ratio = ratio
      const ring = ringOf(7200, 6, (index, series) => 50 + 40 * Math.sin(index / (3 + series)) + (index % 7))
      const series: ChartSeries[] = Array.from({ length: 6 }, (_, at) => ({ index: at, label: `S${at}`, color: chartColor(at), style: at === 0 ? 'area' : 'line' }))
      const { canvas } = chart({ ringValue: ring, env, width: 1600, height: 160, series, window: { spanMs: 7_200_000, end: 'live' } })
      expect(env.flush()).toBe(1)
      expect(canvas.width).toBe(1600 * ratio)
      const lines = canvas.context.strokes.filter(stroke => stroke.width === 1.75)
      expect(lines).toHaveLength(6)
      for (const stroke of lines) {
        expect(stroke.vertices).toBeGreaterThan(1600 * ratio)
        expect(stroke.vertices).toBeLessThanOrEqual(2 * 1600 * ratio)
        expect(stroke.moves).toBe(1)
      }
      // The area under the first series is filled faintly, in its own color, and costs the same bound plus its baseline.
      const area = canvas.context.fills.filter(fill => fill.alpha < 1)
      expect(area).toEqual([{ style: dark['charts.blue'], alpha: 0.14, vertices: expect.any(Number) }])
      expect(area[0].vertices).toBeLessThanOrEqual(2 * 1600 * ratio + 2)
    }
  })
  it('keeps each column\'s smallest and largest value, in the order they came', () => {
    // 60 samples over a 30-pixel plot: two a column, rising then falling.
    const ring = ringOf(60, 1, index => index < 30 ? index : 60 - index)
    const { canvas, env } = chart({ ringValue: ring, width: 36, height: 100, labels: 'none', window: { spanMs: 60_000, end: 'live' }, scale: { unit: 'count', max: 60 } })
    env.flush()
    const [line] = seriesStrokes(canvas, dark['charts.blue'])
    const ys = line.points.map(([, y]) => y)
    const top = Math.min(...ys)
    // The peak (30) is drawn even though no column keeps every sample.
    expect(top).toBeCloseTo(4 + (1 - 30 / 60) * (98 - 4), 5)
    expect(line.vertices).toBeLessThanOrEqual(2 * 30)
  })
  it('breaks the line at gaps and missing values, and marks a lone sample', () => {
    const ring = ringOf(40, 2, (index, series) => series === 1 && index === 20 ? null : 10 + index, index => index === 10 ? ringGap : 0)
    const { canvas, env } = chart({ ringValue: ring, series: [{ index: 0, label: 'A', color: 'charts.blue' }, { index: 1, label: 'B', color: 'charts.orange' }], scale: { unit: 'count' } })
    env.flush()
    expect(seriesStrokes(canvas, dark['charts.blue'])[0].moves).toBe(2)
    expect(seriesStrokes(canvas, dark['charts.orange'])[0].moves).toBe(3)
    // A sample alone between two gaps still shows, as a one-pixel tick.
    const lone = ringOf(5, 1, index => index === 2 ? 50 : null)
    const single = chart({ ringValue: lone })
    single.env.flush()
    const [tick] = seriesStrokes(single.canvas, dark['charts.blue'])
    expect(tick.vertices).toBe(2)
    expect(tick.points[1][0] - tick.points[0][0]).toBe(1)
  })
  it('draws only while the canvas is on screen and the page is visible, and only what changed', () => {
    const ring = ringOf(10, 1, index => index)
    const listeners = new Set<() => void>()
    let hidden = false
    const page: PageVisibility = { hidden: () => hidden, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
    const { view, canvas, env } = chart({ ringValue: ring, page })
    // One frame however often it is asked for.
    view.invalidate(); view.invalidate()
    expect(env.frames).toHaveLength(1)
    env.flush()
    expect(view.stats.draws).toBe(1)
    // Nothing changed: the frame draws nothing.
    view.invalidate(); env.flush()
    expect(view.stats).toEqual({ frames: 2, draws: 1 })
    // Off screen, a new sample asks for no frame; back on screen it is drawn once.
    env.visibility!(false)
    ring.push(start + 1000, [11])
    view.invalidate()
    expect(env.frames).toHaveLength(0)
    env.visibility!(true)
    env.flush()
    expect(view.stats.draws).toBe(2)
    // A hidden page: the same.
    hidden = true
    for (const listener of listeners) listener()
    ring.push(start + 2000, [12])
    view.invalidate()
    expect(env.frames).toHaveLength(0)
    hidden = false
    for (const listener of listeners) listener()
    env.flush()
    expect(view.stats.draws).toBe(3)
    // A size, pixel ratio, forced colors or theme change redraws.
    canvas.clientWidth = 500; env.size!(); env.flush()
    env.ratio = 2; env.ratioListener!(); env.flush()
    env.forced = true; env.forcedListener!(); env.flush()
    view.setTheme(light); env.flush()
    expect(view.stats.draws).toBe(7)
  })
  it('takes every color from the theme', () => {
    const ring = ringOf(30, 7, (index, series) => index + series)
    const series = chartSeriesColors.map((color, at): ChartSeries => ({ index: at, label: color, color, style: at < 2 ? 'stacked' : at === 2 ? 'area' : 'line' }))
    for (const colors of [dark, light]) {
      const { view, canvas, env } = chart({ ringValue: ring, series, colors, scale: { unit: 'count' }, labels: 'axes', surface: 'editor.background' })
      env.flush()
      view.key({ key: 'ArrowLeft', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })
      env.flush()
      const allowed = new Set(Object.values(colors))
      expect(canvas.context.styles.filter(style => !allowed.has(style))).toEqual([])
      for (const color of chartSeriesColors) expect(canvas.context.styles).toContain(colors[color])
      for (const key of ['charts.lines', 'charts.foreground', 'editor.background'] as const) expect(canvas.context.styles).toContain(colors[key])
      expect(canvas.context.texts.every(text => text.style === colors['charts.foreground'])).toBe(true)
    }
  })
  it('draws with system colors, strokes only and dashes under forced colors', () => {
    const env = new FakeChartEnvironment()
    env.forced = true
    const ring = ringOf(30, 3, (index, series) => index + series)
    const series: ChartSeries[] = [{ index: 0, label: 'A', color: 'charts.blue', style: 'area' }, { index: 1, label: 'B', color: 'charts.orange' }, { index: 2, label: 'C', color: 'charts.green', style: 'stacked' }]
    const { canvas } = chart({ ringValue: ring, env, series, scale: { unit: 'count' } })
    env.flush()
    expect(new Set(canvas.context.styles)).toEqual(new Set(['CanvasText', 'Canvas', 'GrayText']))
    // No translucent area and no filled band; only the end markers are filled.
    expect(canvas.context.fills.every(fill => fill.alpha === 1 && fill.vertices === 0)).toBe(true)
    // Each series takes the dash of its place in the chart, as the legend shows it: the stacked band (C, third) is
    // stroked first, then the area (A, first) and the line (B, second).
    const lines = canvas.context.strokes.filter(stroke => stroke.width === 1.75)
    expect(lines.map(stroke => stroke.dash)).toEqual([[...forcedColorsDashes[2]], [...forcedColorsDashes[0]], [...forcedColorsDashes[1]]])
  })
  it('stacks bands on each other, parted by the surface', () => {
    const ring = ringOf(20, 3, (index, series) => series === 2 && index === 5 ? null : [100, 50, 25][series])
    const series: ChartSeries[] = [0, 1, 2].map(at => ({ index: at, label: `C${at}`, color: chartColor(at), style: 'stacked' }))
    const { canvas, env } = chart({ ringValue: ring, series, scale: { unit: 'msPerSecond' }, labels: 'max' })
    env.flush()
    // The scale's top is the largest column total, rounded up.
    expect(canvas.context.texts.map(text => text.text)).toEqual(['200 ms/s'])
    const bands = canvas.context.fills.filter(fill => fill.vertices > 0)
    expect(bands.map(band => band.style)).toEqual([dark['charts.blue'], dark['charts.orange'], dark['charts.green']])
    const parts = canvas.context.strokes.filter(stroke => stroke.style === dark['panel.background'])
    expect(parts).toHaveLength(3)
    const y = (value: number) => 15 + (1 - value / 200) * (98 - 15)
    expect(parts[2].points[0][1]).toBeCloseTo(y(175), 5)
    expect(parts[0].points[0][1]).toBeCloseTo(y(100), 5)
  })
  it('keeps its accessible name current, at most once every 5 s', () => {
    const ring = ringOf(10, 1, index => 10 + index)
    const { view, canvas, env } = chart({ ringValue: undefined })
    expect(canvas.getAttribute('role')).toBe('img')
    expect(canvas.getAttribute('aria-label')).toBe('Wave: no data yet')
    env.flush()
    expect(view.ariaLabel).toBe('Wave: no data yet')
    const fixture = chart({ ringValue: ring })
    fixture.env.flush()
    expect(fixture.canvas.getAttribute('aria-label')).toBe('Wave: 19 %, 10 % to 19 % over the last 1 minute')
    ring.push(start + 1000, [42])
    fixture.view.invalidate(); fixture.env.flush()
    expect(fixture.canvas.getAttribute('aria-label')).toBe('Wave: 19 %, 10 % to 19 % over the last 1 minute')
    fixture.env.advance(4999)
    expect(fixture.canvas.getAttribute('aria-label')).toMatch(/: 19 %/)
    fixture.env.advance(1)
    expect(fixture.canvas.getAttribute('aria-label')).toBe('Wave: 42 %, 11 % to 42 % over the last 1 minute')
  })
  it('steps a crosshair through the samples with the keys, announces it, and shows it on linked charts', () => {
    const ring = ringOf(10, 1, index => index * 10)
    const link = new ChartLink()
    const one = chart({ ringValue: ring, link }), two = chart({ ringValue: ringOf(10, 1, index => index), link })
    one.env.flush(); two.env.flush()
    const press = (key: string, modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => one.view.key({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers })
    const status = () => (one.root.children.find(child => (child as FakeElement).attributes?.get('role') === 'status') as FakeElement).text
    const tip = one.root.children[0] as FakeElement
    expect(press('Escape')).toBe(false)
    expect(press('ArrowLeft', { shiftKey: true })).toBe(false)
    expect(press('ArrowLeft')).toBe(true)
    expect(status()).toBe('now · 90 %')
    expect(press('ArrowLeft')).toBe(true)
    expect(status()).toBe('0:01 ago · 80 %')
    expect(press('Home')).toBe(true)
    expect(status()).toBe('0:09 ago · 0 %')
    expect(press('ArrowLeft')).toBe(true)
    expect(status()).toBe('0:09 ago · 0 %')
    expect(press('End')).toBe(true)
    one.env.flush(); two.env.flush()
    expect(tip.hidden).toBe(false)
    expect(tip.text).toBe('now · 90 %')
    // The other chart shows the same moment as a line, without a tooltip of its own.
    const crosshair = (fixture: Fixture) => fixture.canvas.context.strokes.filter(stroke => stroke.dash.join() === '2,2')
    expect(crosshair(two)).toHaveLength(1)
    expect((two.root.children[0] as FakeElement).hidden).toBe(true)
    expect(press('Escape')).toBe(true)
    expect(status()).toBe('')
    one.env.flush(); two.env.flush()
    expect(tip.hidden).toBe(true)
    two.canvas.context.reset(); two.view.invalidate(); two.env.flush()
    expect(crosshair(two)).toHaveLength(0)
  })
  it('follows the pointer with the crosshair and its tooltip', () => {
    const ring = ringOf(61, 1, index => index)
    const { canvas, env, root } = chart({ ringValue: ring, width: 400 })
    env.flush()
    // Halfway across the plot (1 px to 395 px) is 30 s ago.
    canvas.listeners.get('pointermove')!({ clientX: 198 })
    env.flush()
    const tip = root.children[0] as FakeElement
    expect(tip.text).toBe('0:30 ago · 30 %')
    expect(tip.hidden).toBe(false)
    canvas.listeners.get('pointerleave')!({})
    env.flush()
    expect(tip.hidden).toBe(true)
  })
  it('lists the window as a table, newest first, sampled evenly when long', () => {
    const ring = ringOf(300, 1, index => index, index => index === 299 ? ringGap : 0)
    const { view } = chart({ ringValue: ring, window: { spanMs: 600_000, end: 'live' } })
    const { rows, total } = view.table()
    expect(total).toBe(300)
    expect(rows).toHaveLength(chartLimits.tableRows)
    expect(rows[0]).toEqual({ time: 'now', values: ['299 %'], gapBefore: true })
    expect(rows.at(-1)).toEqual({ time: '4:59 ago', values: ['0 %'], gapBefore: false })
    expect(view.table(60).rows).toHaveLength(60)
    expect(view.table(1000).rows).toHaveLength(120)
    // A fixed window names samples by the clock; both of its ends are in it.
    view.setWindow({ spanMs: 10_000, end: start - 100_000 })
    expect(view.table().rows.map(row => row.time)).toEqual(Array.from({ length: 11 }, (_, k) => formatClock(start - 100_000 - k * 1000)))
    expect(chart({ ringValue: undefined }).view.table()).toEqual({ rows: [], total: 0 })
  })
  it('labels expanded charts with values and times', () => {
    const ring = ringOf(30, 1, index => index)
    const live = chart({ ringValue: ring, labels: 'axes', scale: { unit: 'count' }, window: { spanMs: 900_000, end: 'live' } })
    live.env.flush()
    expect(live.canvas.context.texts.map(text => text.text)).toEqual(['50', '25', '0', '15 min ago', 'now'])
    const fixed = chart({ ringValue: ring, labels: 'axes', scale: { unit: 'count' }, window: { spanMs: 20_000, end: start } })
    fixed.env.flush()
    expect(fixed.canvas.context.texts.slice(3).map(text => text.text)).toEqual([formatClock(start - 20_000), formatClock(start)])
  })
  it('draws a sparkline as one trace with its end marker, and nothing to hover', () => {
    const ring = ringOf(30, 1, index => index)
    const { view, canvas, env } = chart({ ringValue: ring, variant: 'sparkline', series: [{ index: 0, label: 'CPU', color: 'charts.blue', style: 'area' }] })
    env.flush()
    expect(canvas.context.texts).toEqual([])
    expect(canvas.context.strokes.filter(stroke => stroke.style === dark['charts.lines'])).toEqual([])
    expect(canvas.context.strokes.filter(stroke => stroke.width === 1.5)).toHaveLength(1)
    expect(canvas.context.arcs).toEqual([{ x: expect.any(Number), y: expect.any(Number), radius: 2 }])
    expect(canvas.listeners.size).toBe(0)
    expect(view.key({ key: 'ArrowLeft', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(false)
  })
  it('reports the latest value of each series', () => {
    const ring = ringOf(5, 2, (index, series) => series === 1 && index === 4 ? null : index * (series + 1))
    const { view } = chart({ ringValue: ring, series: [{ index: 0, label: 'A', color: 'charts.blue' }, { index: 1, label: 'B', color: 'charts.orange' }] })
    expect(view.latest()).toEqual([4, 6])
  })
  it('lists the table and the latest values whatever size the canvas has', () => {
    // A chart whose table took its place (or a tile collapsed in a narrow layout) has no canvas size.
    const ring = ringOf(30, 1, index => index)
    const { view, canvas } = chart({ ringValue: ring, width: 0, height: 0 })
    expect(view.table().total).toBe(30)
    expect(view.table().rows[0]).toEqual({ time: 'now', values: ['29 %'], gapBefore: false })
    expect(view.latest()).toEqual([29])
    expect(view.key({ key: 'Home', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(true)
    canvas.clientWidth = 400; canvas.clientHeight = 100
    expect(view.table().total).toBe(30)
  })
  it('leaves no tooltip behind when the canvas loses its size', () => {
    const ring = ringOf(30, 1, index => index)
    const { canvas, env, root } = chart({ ringValue: ring })
    env.flush()
    canvas.listeners.get('pointermove')!({ clientX: 200 })
    env.flush()
    const tip = root.children[0] as FakeElement
    expect(tip.hidden).toBe(false)
    canvas.clientWidth = 0; canvas.clientHeight = 0; env.size!(); env.flush()
    expect(tip.hidden).toBe(true)
  })
  it('scales to the series that have values when one has none in the window', () => {
    const ring = ringOf(296, 2, (index, series) => series === 0 ? 100 + index : null)
    const series: ChartSeries[] = [{ index: 0, label: 'Read', color: 'charts.blue' }, { index: 1, label: 'Write', color: 'charts.orange' }]
    const { canvas, env } = chart({ ringValue: ring, series, scale: { unit: 'count' }, window: { spanMs: 600_000, end: 'live' } })
    env.flush()
    expect(canvas.context.texts.map(text => text.text)).toEqual(['500'])
    const ys = seriesStrokes(canvas, dark['charts.blue'])[0].points.map(([, y]) => y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40)
  })
  it('marks a table row after a gap that fell between two sampled rows', () => {
    const ring = ringOf(600, 1, index => index, index => index === 301 ? ringGap : 0)
    const { view } = chart({ ringValue: ring, window: { spanMs: 600_000, end: 'live' } })
    const { rows, total } = view.table(120)
    expect(total).toBe(600)
    expect(rows.filter(row => row.gapBefore)).toHaveLength(1)
    // The row that is marked is the oldest sampled one after the gap.
    const marked = rows.findIndex(row => row.gapBefore)
    expect(Number.parseInt(rows[marked].values[0])).toBeGreaterThanOrEqual(301)
    expect(Number.parseInt(rows[marked + 1].values[0])).toBeLessThan(301)
  })
  it('hides the keyboard crosshair, here and on linked charts, when focus leaves the canvas', () => {
    const ring = ringOf(10, 1, index => index)
    const link = new ChartLink()
    const one = chart({ ringValue: ring, link }), two = chart({ ringValue: ring, link })
    one.env.flush(); two.env.flush()
    one.view.key({ key: 'ArrowLeft', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })
    one.env.flush(); two.env.flush()
    const tip = one.root.children[0] as FakeElement
    expect(tip.hidden).toBe(false)
    two.canvas.context.reset()
    one.canvas.listeners.get('blur')!({})
    one.env.flush(); two.env.flush()
    expect(tip.hidden).toBe(true)
    expect(two.view.stats.draws).toBe(3)
    expect(two.canvas.context.strokes.filter(stroke => stroke.dash.join() === '2,2')).toHaveLength(0)
    // A pointer's crosshair stays: the pointer is still over the chart.
    one.canvas.listeners.get('pointermove')!({ clientX: 200 })
    one.env.flush()
    one.canvas.listeners.get('blur')!({})
    one.env.flush()
    expect(tip.hidden).toBe(false)
  })
  it('clears the crosshair it drove on linked charts when disposed', () => {
    const ring = ringOf(10, 1, index => index)
    const link = new ChartLink()
    const one = chart({ ringValue: ring, link }), two = chart({ ringValue: ring, link })
    one.env.flush(); two.env.flush()
    one.view.key({ key: 'Home', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })
    two.env.flush()
    const crosshair = () => two.canvas.context.strokes.filter(stroke => stroke.dash.join() === '2,2')
    expect(crosshair()).toHaveLength(1)
    one.view.dispose()
    two.canvas.context.reset(); two.view.setTitle('Other'); two.env.flush()
    expect(crosshair()).toHaveLength(0)
  })
  it('steps right, clamps at the newest sample, and hides a crosshair whose sample left the live window', () => {
    const ring = ringOf(61, 1, index => index)
    const { view, env, root } = chart({ ringValue: ring })
    env.flush()
    const press = (key: string) => view.key({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })
    const status = () => (root.children.find(child => (child as FakeElement).attributes?.get('role') === 'status') as FakeElement).text
    press('Home')
    expect(status()).toBe('1:00 ago · 0 %')
    press('ArrowRight')
    expect(status()).toBe('0:59 ago · 1 %')
    press('End'); press('ArrowRight')
    expect(status()).toBe('now · 60 %')
    press('Home')
    env.flush()
    const tip = root.children[0] as FakeElement
    expect(tip.hidden).toBe(false)
    // A new sample moves the window on: the oldest sample, under the crosshair, is no longer in it.
    env.time = start + 1000
    ring.push(start + 1000, [61])
    view.invalidate(); env.flush()
    expect(tip.hidden).toBe(true)
  })
  it('maps the pointer to the plot inside the value axis\'s labels', () => {
    const ring = ringOf(61, 1, index => index)
    const { canvas, env, root } = chart({ ringValue: ring, width: 400, labels: 'axes' })
    env.flush()
    // "100 %" is the widest label: 30 px in the fake context, so the plot runs from 36 px to 395 px.
    canvas.listeners.get('pointermove')!({ clientX: 36 + (395 - 36) / 2 })
    env.flush()
    expect((root.children[0] as FakeElement).text).toBe('0:30 ago · 30 %')
  })
  it('places the tooltip inside the plot, beside the crosshair on the side with room', () => {
    const ring = ringOf(61, 1, index => index)
    const { canvas, env, root } = chart({ ringValue: ring, width: 400 })
    env.flush()
    const tip = root.children[0] as FakeElement
    canvas.listeners.get('pointermove')!({ clientX: 100 })
    env.flush()
    const crosshairX = () => canvas.context.strokes.find(stroke => stroke.dash.join() === '2,2')!.points[0][0]
    // The plot's top is the 'max' label's line (11 + 4 px); the tip sits 2 px below it.
    expect(tip.style.top).toBe('17px')
    expect(Number.parseFloat(tip.style.left)).toBeGreaterThan(crosshairX())
    canvas.context.reset()
    canvas.listeners.get('pointermove')!({ clientX: 390 })
    env.flush()
    expect(Number.parseFloat(tip.style.left) + tip.offsetWidth).toBeLessThan(crosshairX())
    expect(Number.parseFloat(tip.style.left)).toBeGreaterThanOrEqual(1)
  })
  it('says when the newest sample is stale instead of calling it now', () => {
    const ring = ringOf(30, 1, index => index)
    const changes: number[] = []
    const { view, canvas, env } = chart({ ringValue: ring, labels: 'axes', scale: { unit: 'count' }, window: { spanMs: 60_000, end: 'live' } })
    view.subscribe(() => changes.push(env.time))
    env.flush()
    expect(canvas.context.texts.slice(3).map(text => text.text)).toEqual(['1 min ago', 'now'])
    expect(view.table().rows[0].time).toBe('now')
    // Collection stopped (a pause, a lost backend): no tick comes, yet within a few seconds the chart stops saying "now".
    canvas.context.reset()
    env.advance(2001)
    expect(changes).toEqual([start + 2001])
    env.flush()
    expect(canvas.context.texts.slice(3).map(text => text.text)).toEqual([formatClock(start - 60_000), formatClock(start)])
    expect(view.table().rows[0].time).toBe(formatClock(start))
    env.advance(5000)
    expect(view.ariaLabel).toBe(`Wave: 29, 0 to 29 from ${formatClock(start - 60_000)} to ${formatClock(start)}`)
    // A new sample makes it current again.
    ring.push(env.time, [30])
    view.invalidate(); env.flush()
    expect(view.table().rows[0].time).toBe('now')
  })
  it('names a fixed window by its clock times', () => {
    expect(chartLabel('SQL Server CPU', 'percent', { from: new Date(2026, 9, 22, 13, 5, 0).getTime(), to: new Date(2026, 9, 22, 13, 10, 0).getTime() }, [{ label: 'CPU', latest: 12, min: 3, max: 40 }]))
      .toBe('SQL Server CPU: 12 %, 3 % to 40 % from 13:05:00 to 13:10:00')
    const ring = ringOf(30, 1, index => index)
    const { view, env } = chart({ ringValue: ring, window: { spanMs: 20_000, end: start - 5000 } })
    env.flush()
    expect(view.ariaLabel).toBe(`Wave: 24 %, 4 % to 24 % from ${formatClock(start - 25_000)} to ${formatClock(start - 5000)}`)
  })
  it('redraws when the pixel ratio alone changes', () => {
    const ring = ringOf(10, 1, index => index)
    const { view, canvas, env } = chart({ ringValue: ring, width: 400 })
    env.flush()
    expect(canvas.width).toBe(400)
    env.ratio = 2
    env.ratioListener!()
    env.flush()
    expect(canvas.width).toBe(800)
    expect(view.stats.draws).toBe(2)
  })
  it('describes its keys to assistive technology', () => {
    const { canvas, root } = chart({ ringValue: ringOf(5, 1, index => index) })
    expect(canvas.getAttribute('aria-roledescription')).toBe('chart')
    const id = canvas.getAttribute('aria-describedby')!
    const described = root.children.find(child => (child as FakeElement).attributes?.get('id') === id) as FakeElement
    expect(described.text).toMatch(/Left and Right .*Home and End .*Escape/)
    const spark = chart({ ringValue: ringOf(5, 1, index => index), variant: 'sparkline' })
    expect(spark.canvas.getAttribute('aria-describedby')).toBeNull()
  })
  it('keeps status colors out of the series colors', () => {
    expect(chartSeriesColors).not.toContain('charts.red')
    // @ts-expect-error charts.red is a status color: charts never use it as a series.
    const red: ChartSeries = { index: 0, label: 'Failed', color: 'charts.red' }
    expect(red.color).toBe('charts.red')
  })
  it('lets go of everything when disposed', () => {
    const ring = ringOf(5, 1, index => index)
    const link = new ChartLink()
    const { view, canvas, env, root } = chart({ ringValue: ring, link })
    const other = chart({ ringValue: ring, link })
    other.env.flush()
    view.dispose()
    expect(env.frames).toHaveLength(0)
    expect(root.children).toHaveLength(0)
    expect(canvas.listeners.size).toBe(0)
    expect([env.visibility, env.size, env.forcedListener, env.ratioListener]).toEqual([undefined, undefined, undefined, undefined])
    expect(env.timers).toEqual([])
    other.view.key({ key: 'End', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })
    view.invalidate()
    expect(env.frames).toHaveLength(0)
  })
})
