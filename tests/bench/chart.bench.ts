import { expect, it } from 'vitest'
import { resolveBuiltin } from '../../src/shared/theme/resolve'
import { ChartView, chartColor, type ChartSeries } from '../../src/renderer/src/live/ChartView'
import { MetricRing, ringMaxCapacity } from '../../src/renderer/src/live/ring'
import { FakeCanvas, FakeChartEnvironment, FakeContext, fakeOwner } from '../fixtures/fake-canvas'
import { rate, record } from './harness'

// A live chart's whole draw (ChartView) in one thread, into a context that only counts: a full ring (7,200 samples, two
// hours at 1 s) of six series over a 1,600 px chart, each series bucketed into pixel columns and stroked.

it('draws a full ring of six series at 1,600 px', () => {
  const series = 6, owner = fakeOwner(), env = new FakeChartEnvironment(), context = new FakeContext(false)
  const ring = new MetricRing(ringMaxCapacity, series)
  for (let index = 0; index < ringMaxCapacity; index++) ring.push(index * 1000, Array.from({ length: series }, (_, at) => 50 + 40 * Math.sin(index / (5 + at)) + (index * 7919 % 13)))
  const lines: ChartSeries[] = Array.from({ length: series }, (_, at) => ({ index: at, label: `Series ${at + 1}`, color: chartColor(at), style: at === 0 ? 'area' : 'line' }))
  const canvas = new FakeCanvas(owner, 1600, 160, context)
  const view = new ChartView({
    canvas: canvas as unknown as HTMLCanvasElement, root: owner.createElement('div') as unknown as HTMLElement, ring: () => ring, title: 'Bench',
    series: lines, scale: { unit: 'percent', max: 'auto' }, window: { spanMs: ringMaxCapacity * 1000, end: 'live' }, colors: resolveBuiltin('dark').colors, env, labels: 'axes'
  })
  let span = ringMaxCapacity * 1000
  const draw = () => {
    // A new window each time, so every frame draws.
    span = span === ringMaxCapacity * 1000 ? ringMaxCapacity * 1000 - 1 : ringMaxCapacity * 1000
    view.setWindow({ spanMs: span, end: 'live' })
    context.reset()
    env.flush()
  }
  draw()
  expect(view.stats.draws).toBe(1)
  expect(context.strokes.filter(stroke => stroke.width === 1.75).every(stroke => stroke.vertices <= 2 * 1600)).toBe(true)
  const ops = rate(draw, { batch: 5 })
  expect(view.stats.draws).toBe(view.stats.frames)
  record({ id: 'node.chart.drawOpsPerSecond', value: ops, unit: 'ops/s', detail: `${ringMaxCapacity} samples × ${series} series at 1600 px` })
  view.dispose()
})
