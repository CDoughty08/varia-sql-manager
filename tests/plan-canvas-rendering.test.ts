// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { layoutPlans } from '../src/renderer/src/plans/layout'
import { largePlan } from './fixtures/plans/large'
import type { PlanStatement } from '../src/shared/plans'

const measured = vi.hoisted(() => ({ text: vi.fn((value: string) => ({ width: value.length * 7 })), number: vi.fn((value: number | null | undefined) => value == null ? 'Unavailable' : String(value)) }))
vi.mock('../src/renderer/src/plans/diagnostics', async original => ({ ...await original<typeof import('../src/renderer/src/plans/diagnostics')>(), formatPlanMetric: measured.number }))
vi.mock('pixi.js/unsafe-eval', () => ({}))
vi.mock('pixi.js', () => {
  class Container { position = { set() {} }; scale = { set() {} }; addChild() {} }
  class Graphics extends Container {
    context = this; visible = true
    clear() { return this } rect() { return this } roundRect() { return this } fill() { return this } stroke() { return this }
    moveTo() { return this } lineTo() { return this } save() { return this } translate() { return this } path() { return this } restore() { return this }
  }
  class TextStyle { fill = ''; constructor(_options: unknown) {} destroy() {} }
  class Text extends Container { text = ''; style: unknown; visible = true; constructor(options: { style: unknown }) { super(); this.style = options.style } destroy() {} }
  class Application { stage = new Container(); renderer = { resize() {} }; canvas = document.createElement('canvas'); async init() {} render() {} destroy() {} }
  return { Application, Container, Graphics, GraphicsPath: class {}, Text, TextStyle, CanvasTextMetrics: { measureText: measured.text }, TexturePool: { clear() {} } }
})

vi.mock('../src/renderer/src/core/windows', () => ({ observeResize: () => ({ dispose() {} }), observeIntersection: () => ({ dispose() {} }),
  windowOf: () => window, windows: { onDidAdopt: () => ({ dispose() {} }) } }))
import { PlanCanvas } from '../src/renderer/src/plans/PlanCanvas'

it('allocates and measures row-flow labels only for visible label bounds, including counter updates', async () => {
  const input = largePlan(10_000, 'wide'), layout = layoutPlans([input]), root = document.createElement('div')
  Object.defineProperty(root, 'clientWidth', { value: 600 }); Object.defineProperty(root, 'clientHeight', { value: 400 })
  document.body.append(root)
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const statement: PlanStatement = { id: input.id, text: '', type: 'SELECT', estimatedCost: null, warnings: [], nodes: input.nodes.map((node, i) => ({ ...node,
    nodeId: String(i), physicalOp: 'Constant Scan', logicalOp: 'Constant Scan', object: '', warnings: [], properties: [], estimatedRows: i + 1,
    actualRows: null, estimatedCost: null, elapsedMs: null, cpuMs: null, executions: null })) }
  const canvas = new PlanCanvas({ root, statements: [statement], layout, camera: { x: 0, y: 200 - layout.nodes[0].y, scale: 1 },
    colors: { background: '#000000', card: '#000000', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', warning: '#ffff00' },
    rowFlow: true, minimap: true, select() {}, cameraChanged() {}, hover() {}, failed: () => { throw new Error('Canvas initialization failed') } })
  const rendering = canvas as unknown as { draw(): void; pool: { stats: { active: number }; active: Map<string, unknown> } }
  try {
    await Promise.resolve()
    rendering.draw()
    expect(rendering.pool.stats.active).toBeLessThan(64)
    expect(measured.text.mock.calls.length).toBeLessThan(200)
    expect(measured.number.mock.calls.length).toBeLessThan(64)
    measured.text.mockClear()
    measured.number.mockClear()
    canvas.update([{ ...statement, nodes: statement.nodes.map((node, i) => ({ ...node, actualRows: i * 3 })) }])
    rendering.draw()
    expect(rendering.pool.stats.active).toBeLessThan(64)
    expect(measured.text.mock.calls.length).toBeLessThan(200)
    expect(measured.number.mock.calls.length).toBeLessThan(64)
    // An edge just below the viewport can still have a visible label above it.
    const end = layout.edges[0].points.at(-1)!
    canvas.setCamera({ x: 0, y: 400 - end.y + 6, scale: 1 })
    rendering.draw()
    expect(rendering.pool.active.has('flow:' + layout.edges[0].childId)).toBe(true)
  } finally { canvas.dispose(); root.remove(); frames.mockRestore() }
})
