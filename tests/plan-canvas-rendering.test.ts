// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { Window as HappyWindow } from 'happy-dom'
import { layoutPlans } from '../src/renderer/src/plans/layout'
import { largePlan } from './fixtures/plans/large'
import type { PlanStatement } from '../src/shared/plans'
import { windows } from '../src/renderer/src/core/windows'

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
  class Text extends Container {
    text = ''; style: unknown; visible = true; private rasterResolution: number | null = null; roundPixels: boolean
    get resolution() { return this.rasterResolution }
    set resolution(value: number | null) { this.rasterResolution = value }
    constructor(options: { style: unknown; roundPixels: boolean }) { super(); this.style = options.style; this.roundPixels = options.roundPixels }
    destroy() {}
  }
  class Application {
    stage = new Container(); renderer = { resolution: 1, resize(_width: number, _height: number, resolution: number) { this.resolution = resolution } }
    canvas = document.createElement('canvas'); async init() {} render() {} destroy() {}
  }
  return { Application, Container, Graphics, GraphicsPath: class {}, Text, TextStyle, CanvasTextMetrics: { measureText: measured.text }, TexturePool: { clear() {} } }
})

vi.mock('../src/renderer/src/core/windows', () => ({ observeResize: () => ({ dispose() {} }), observeIntersection: () => ({ dispose() {} }),
  windowOf: (node: Node) => node.ownerDocument?.defaultView ?? window, windows: { onDidAdopt: vi.fn(() => ({ dispose() {} })) } }))
import { PlanCanvas } from '../src/renderer/src/plans/PlanCanvas'

it('restores a linked camera during initialization without emitting camera changes', async () => {
  const root = document.createElement('div'), changed = vi.fn(), frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const canvas = new PlanCanvas({ root, statements: [], layout: layoutPlans([largePlan(2)]),
    colors: { background: '#000000', card: '#000000', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', warning: '#ffff00' },
    select() {}, cameraChanged: changed, hover() {}, failed: () => { throw new Error('Canvas initialization failed') } })
  try {
    // Even a remote camera equal to the initial camera must prevent the default Fit.
    canvas.restoreCamera({ x: 0, y: 0, scale: 1 })
    await Promise.resolve()
    expect(canvas.getCamera()).toEqual({ x: 0, y: 0, scale: 1 })
    const remote = { x: 80, y: -20, scale: 0.7 }
    canvas.restoreCamera(remote)
    remote.x = 100
    expect(canvas.getCamera()).toEqual({ x: 80, y: -20, scale: 0.7 })
    canvas.restoreCamera({ x: NaN, y: 0, scale: 1 })
    expect(canvas.getCamera()).toEqual({ x: 80, y: -20, scale: 0.7 })
    expect(changed).not.toHaveBeenCalled()
    canvas.pan(10, 20)
    expect(changed).toHaveBeenCalledExactlyOnceWith({ x: 90, y: 0, scale: 0.7 })
  } finally { canvas.dispose(); frames.mockRestore() }
})

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

it.each([1, 1.25, 2, 3])('rasterizes visible labels at their displayed pixel size on a %s× display', async ratio => {
  const pixelRatio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(ratio)
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const root = document.createElement('div'), input = largePlan(2), layout = layoutPlans([input])
  Object.defineProperty(root, 'clientWidth', { value: 1200 }); Object.defineProperty(root, 'clientHeight', { value: 800 })
  const statement: PlanStatement = { id: input.id, text: '', type: 'SELECT', estimatedCost: null, warnings: [], nodes: input.nodes.map(node => ({ ...node,
    nodeId: node.id, physicalOp: 'Index Seek', logicalOp: 'Index Seek', object: 'dbo.Orders', warnings: [], properties: [], estimatedRows: 10,
    actualRows: null, estimatedCost: null, elapsedMs: null, cpuMs: null, executions: null })) }
  const canvas = new PlanCanvas({ root, statements: [statement], layout, camera: { x: 0, y: 0, scale: 1 },
    colors: { background: '#000000', card: '#000000', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', warning: '#ffff00' },
    rowFlow: true, select() {}, cameraChanged() {}, hover() {}, failed: () => { throw new Error('Canvas initialization failed') } })
  const rendering = canvas as unknown as {
    draw(): void; app: { renderer: { resolution: number } }
    pool: { active: Map<string, { resolution: number; roundPixels: boolean }> }
  }
  try {
    await Promise.resolve()
    expect(rendering.app.renderer.resolution).toBe(ratio)
    for (const scale of [0.35, 0.55, 0.75, 1, 1.2, 2, 3, 1]) {
      canvas.setCamera({ x: 0.25, y: 0.5, scale })
      rendering.draw()
      const labels = [...rendering.pool.active.values()]
      expect(labels.length).toBeGreaterThan(0)
      for (const label of labels) {
        expect(label.resolution).toBeCloseTo(ratio * scale)
        expect(label.roundPixels).toBe(true)
      }
      // Panning and counter frames must reuse the existing rasters.
      const assignments = vi.spyOn(labels[0], 'resolution', 'set')
      canvas.pan(0.3, 0.6)
      canvas.update([statement])
      rendering.draw()
      expect([...rendering.pool.active.values()]).toContain(labels[0])
      expect(assignments).not.toHaveBeenCalled()
      assignments.mockRestore()
    }
  } finally { canvas.dispose(); frames.mockRestore(); pixelRatio.mockRestore() }
})

it('updates DPI without a size change, moves the watch into a popout, and removes it on disposal', async () => {
  const root = document.createElement('div'), popout = new HappyWindow()
  document.body.append(root)
  const target = popout as unknown as Window, targetDocument = target.document
  const pixelRatio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
  const targetRatio = vi.spyOn(target, 'devicePixelRatio', 'get').mockReturnValue(3)
  const queries: EventTarget[] = [], targetQueries: EventTarget[] = []
  const query = (list: EventTarget[]) => { const value = new EventTarget(); list.push(value); return value as MediaQueryList }
  const media = vi.spyOn(window, 'matchMedia').mockImplementation(() => query(queries))
  const targetMedia = vi.spyOn(target, 'matchMedia').mockImplementation(() => query(targetQueries))
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const targetFrames = vi.spyOn(target, 'requestAnimationFrame').mockReturnValue(2)
  const canvas = new PlanCanvas({ root, statements: [], layout: layoutPlans([]), camera: { x: 0, y: 0, scale: 1 },
    colors: { background: '#000000', card: '#000000', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', warning: '#ffff00' },
    select() {}, cameraChanged() {}, hover() {}, failed: () => { throw new Error('Canvas initialization failed') } })
  const rendering = canvas as unknown as { app: { renderer: { resolution: number } } }
  let disposed = false
  try {
    await Promise.resolve()
    pixelRatio.mockReturnValue(1.5)
    queries[0].dispatchEvent(new Event('change'))
    expect(rendering.app.renderer.resolution).toBe(1.5)
    expect(media).toHaveBeenLastCalledWith('(resolution: 1.5dppx)')
    const oldQuery = queries.at(-1)!
    const removeOld = vi.spyOn(oldQuery, 'removeEventListener')
    targetDocument.body.append(root)
    vi.mocked(windows.onDidAdopt).mock.calls.at(-1)![0]()
    expect(removeOld).toHaveBeenCalledWith('change', expect.any(Function))
    expect(rendering.app.renderer.resolution).toBe(3)
    expect(targetMedia).toHaveBeenLastCalledWith('(resolution: 3dppx)')
    const removeTarget = vi.spyOn(targetQueries.at(-1)!, 'removeEventListener')
    canvas.dispose()
    disposed = true
    expect(removeTarget).toHaveBeenCalledWith('change', expect.any(Function))
  } finally {
    if (!disposed) canvas.dispose()
    root.remove(); await popout.happyDOM.close()
    frames.mockRestore(); targetFrames.mockRestore(); media.mockRestore(); targetMedia.mockRestore(); pixelRatio.mockRestore(); targetRatio.mockRestore()
  }
})
