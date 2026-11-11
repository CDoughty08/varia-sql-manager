// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { Window as HappyWindow } from 'happy-dom'
import { layoutPlans } from '../src/renderer/src/plans/layout'
import { largePlan } from './fixtures/plans/large'
import type { PlanStatement } from '../src/shared/plans'
import { windows } from '../src/renderer/src/core/windows'

const measured = vi.hoisted(() => ({ text: vi.fn((value: string) => ({ width: value.length * 7 })), number: vi.fn((value: number | null | undefined) => value == null ? 'Unavailable' : String(value)) }))
vi.mock('../src/renderer/src/plans/diagnostics', async original => ({ ...await original<typeof import('../src/renderer/src/plans/diagnostics')>(), formatPlanMetric: measured.number }))
// init: a pending initialization. limit: the advertised WebGL size limit. allocatable: what the browser really allocates.
const gpu = vi.hoisted(() => ({ init: undefined as Promise<void> | undefined, limit: 0, allocatable: 0, texts: new Set<{ render(): void }>() }))
vi.mock('pixi.js/unsafe-eval', () => ({}))
vi.mock('pixi.js', async original => {
  // The real reference-counted text cache, without rasterizing: happy-dom has no canvas or WebGL.
  const { AbstractTextSystem } = await original<typeof import('pixi.js')>()
  class TextSystem extends AbstractTextSystem {
    override getTexture() { return {} as ReturnType<InstanceType<typeof AbstractTextSystem>['getTexture']> }
    override returnTexture() {}
  }
  let styles = 0, system: TextSystem
  class Container { position = { set() {} }; scale = { set() {} }; addChild() {} }
  class Graphics extends Container {
    context = this; visible = true
    clear() { return this } rect() { return this } roundRect() { return this } fill() { return this } stroke() { return this }
    moveTo() { return this } lineTo() { return this } save() { return this } translate() { return this } path() { return this } restore() { return this }
  }
  class TextStyle { fill = ''; styleKey = `style${styles++}`; constructor(_options: unknown) {} destroy() {} }
  class Text extends Container {
    text = ''; style: TextStyle; visible = true; private rasterResolution: number | null = null; roundPixels: boolean
    _resolution: number | null = null; _autoResolution = false; private currentKey = ''
    get resolution() { return this.rasterResolution }
    set resolution(value: number | null) { this.rasterResolution = this._resolution = value }
    get styleKey() { return `${this.text}:${this.style.styleKey}:${this._resolution}` }
    constructor(options: { style: TextStyle; roundPixels: boolean }) { super(); this.style = options.style; this.roundPixels = options.roundPixels; gpu.texts.add(this) }
    // Pixi's CanvasTextPipe exchanges the managed texture whenever a visible label's key changes.
    render() {
      if (!this.visible || this.currentKey === this.styleKey) return
      system.decreaseReferenceCount(this.currentKey)
      system.getManagedTexture(this as never)
      this.currentKey = this.styleKey
    }
    destroy() { gpu.texts.delete(this); system.decreaseReferenceCount(this.currentKey) }
  }
  class Application {
    stage = new Container(); canvas = document.createElement('canvas')
    renderer = (canvas => {
      const size = (pixels: number) => Math.min(pixels, gpu.allocatable || gpu.limit)
      const renderer = { resolution: 1, canvasText: system = new TextSystem({ resolution: 1 } as never, false),
        gl: gpu.limit ? { MAX_RENDERBUFFER_SIZE: 1, MAX_TEXTURE_SIZE: 2, MAX_VIEWPORT_DIMS: 3, isContextLost: () => false,
          getParameter: (name: number) => name === 3 ? [gpu.limit, gpu.limit] : gpu.limit,
          get drawingBufferWidth() { return size(canvas.width) }, get drawingBufferHeight() { return size(canvas.height) } } : undefined,
        resize(width: number, height: number, resolution: number) { renderer.resolution = resolution; canvas.width = Math.round(width * resolution); canvas.height = Math.round(height * resolution) } }
      return renderer
    })(this.canvas)
    init() { return gpu.init ?? Promise.resolve() }
    render() { for (const text of gpu.texts) text.render() }
    destroy() {}
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

const colors = { background: '#000000', card: '#000000', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', warning: '#ffff00' }
const seeks = (input: ReturnType<typeof largePlan>): PlanStatement => ({ id: input.id, text: '', type: 'SELECT', estimatedCost: null, warnings: [], nodes: input.nodes.map(node => ({ ...node,
  nodeId: node.id, physicalOp: 'Index Seek', logicalOp: 'Index Seek', object: 'dbo.Orders', warnings: [], properties: [], estimatedRows: 10,
  actualRows: null, estimatedCost: null, elapsedMs: null, cpuMs: null, executions: null })) })

it('keeps an explicit camera requested while Pixi initializes instead of the default Fit', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const start = () => {
    let initialized!: () => void
    const pending = gpu.init = new Promise<void>(resolve => { initialized = resolve })
    const root = document.createElement('div'), changed = vi.fn()
    Object.defineProperty(root, 'clientWidth', { value: 600 }); Object.defineProperty(root, 'clientHeight', { value: 400 })
    const canvas = new PlanCanvas({ root, statements: [], layout: layoutPlans([largePlan(200)]), colors,
      select() {}, cameraChanged: changed, hover() {}, failed: () => { throw new Error('Canvas initialization failed') } })
    return { canvas, changed, async finish() { initialized(); await pending; await Promise.resolve() } }
  }
  try {
    const early = start()
    early.canvas.setCamera({ x: 50, y: 40, scale: 2 })
    await early.finish()
    expect(early.canvas.getCamera()).toEqual({ x: 50, y: 40, scale: 2 })
    expect(early.changed).toHaveBeenCalledExactlyOnceWith({ x: 50, y: 40, scale: 2 })
    early.canvas.dispose()
    // A request equal to the default camera is still a request.
    const same = start()
    same.canvas.setCamera({ x: 0, y: 0, scale: 1 })
    await same.finish()
    expect(same.canvas.getCamera()).toEqual({ x: 0, y: 0, scale: 1 })
    same.canvas.dispose()
    // Without a request, and after one that derives from the still unmeasured viewport, the plan is fitted.
    for (const unmeasured of [(_canvas: PlanCanvas) => {}, (canvas: PlanCanvas) => canvas.zoom(2), (canvas: PlanCanvas) => canvas.setCamera({ x: NaN, y: 0, scale: 1 })]) {
      const fitted = start()
      unmeasured(fitted.canvas)
      await fitted.finish()
      expect(fitted.canvas.getCamera().scale).toBeLessThan(1)
      fitted.canvas.dispose()
    }
  } finally { gpu.init = undefined; frames.mockRestore() }
})

it('releases retired text cache keys over a long zoom session and keeps shared textures while panning', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const root = document.createElement('div'), layout = layoutPlans([largePlan(2)]), statement = seeks(largePlan(2))
  Object.defineProperty(root, 'clientWidth', { value: 1200 }); Object.defineProperty(root, 'clientHeight', { value: 800 })
  const canvas = new PlanCanvas({ root, statements: [statement], layout, camera: { x: 0, y: 0, scale: 1 }, colors,
    select() {}, cameraChanged() {}, hover() {}, failed: () => { throw new Error('Canvas initialization failed') } })
  const rendering = canvas as unknown as { draw(): void; pool: { active: Map<string, { styleKey: string }> }
    app: { renderer: { canvasText: { _activeTextures: Record<string, { texture: unknown; usageCount: number } | null>; getReferenceCount(key: string): number } } } }
  const cache = () => rendering.app.renderer.canvasText._activeTextures
  try {
    await Promise.resolve()
    rendering.draw()
    expect(rendering.pool.active.size).toBe(5)
    // Both operators have the same name and object, so each pair of labels shares one texture.
    expect(Object.keys(cache()).length).toBe(3)
    for (let step = 1; step <= 2000; step++) {
      canvas.setCamera({ x: 0, y: 0, scale: 1 + step * 0.000001 })
      rendering.draw()
    }
    expect(Object.keys(cache()).length).toBe(3)
    expect(Object.values(cache()).every(Boolean)).toBe(true)
    const operator = rendering.pool.active.get(layout.nodes[0].id + ':op')!.styleKey
    expect(operator.endsWith(':' + (1 + 2000 * 0.000001))).toBe(true)
    expect(rendering.app.renderer.canvasText.getReferenceCount(operator)).toBe(2)
    const textures = Object.entries(cache()).map(([key, entry]) => [key, entry!.texture] as const)
    canvas.pan(0.3, 0.6)
    canvas.update([statement])
    rendering.draw()
    expect(Object.keys(cache()).length).toBe(3)
    for (const [key, texture] of textures) expect(cache()[key]!.texture).toBe(texture)
    // A live counter retires its previous text on every frame.
    for (let rows = 1; rows <= 200; rows++) {
      canvas.update([{ ...statement, nodes: statement.nodes.map(node => ({ ...node, object: '', actualRows: rows })) }])
      rendering.draw()
    }
    expect(Object.keys(cache()).length).toBe(3)
    expect(Object.values(cache()).every(Boolean)).toBe(true)
  } finally { canvas.dispose(); frames.mockRestore() }
  expect(gpu.texts.size).toBe(0)
})

it('lowers the effective resolution to the device drawing-buffer limit and falls back when it still cannot be allocated', async () => {
  const pixelRatio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3)
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const queries: EventTarget[] = []
  const media = vi.spyOn(window, 'matchMedia').mockImplementation(() => { const value = new EventTarget(); queries.push(value); return value as MediaQueryList })
  const root = document.createElement('div'), layout = layoutPlans([largePlan(2)])
  const size = { width: 1200, height: 20 }
  Object.defineProperty(root, 'clientWidth', { get: () => size.width }); Object.defineProperty(root, 'clientHeight', { get: () => size.height })
  const failed = vi.fn()
  gpu.limit = 16384
  const canvas = new PlanCanvas({ root, statements: [seeks(largePlan(2))], layout, camera: { x: 0, y: -layout.bounds.y, scale: 1 }, colors,
    select() {}, cameraChanged() {}, hover() {}, failed })
  const rendering = canvas as unknown as { draw(): void; resize(): void; pool: { active: Map<string, { resolution: number }> }
    app: { canvas: HTMLCanvasElement; renderer: { resolution: number; gl: { drawingBufferWidth: number; drawingBufferHeight: number } } } }
  const backing = () => ({ resolution: rendering.app.renderer.resolution, requested: rendering.app.canvas.width, actual: rendering.app.renderer.gl.drawingBufferWidth })
  try {
    await Promise.resolve()
    // Full DPI while the backing store fits.
    expect(backing()).toEqual({ resolution: 3, requested: 3600, actual: 3600 })
    size.width = 5500
    rendering.resize()
    expect(backing()).toEqual({ resolution: 16384 / 5500, requested: 16384, actual: 16384 })
    rendering.draw()
    const labels = [...rendering.pool.active.values()]
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(label.resolution).toBe(16384 / 5500)
    // A lower display DPI fits again; returning to 3x is limited again.
    pixelRatio.mockReturnValue(2)
    queries.at(-1)!.dispatchEvent(new Event('change'))
    expect(backing()).toEqual({ resolution: 2, requested: 11000, actual: 11000 })
    pixelRatio.mockReturnValue(3)
    queries.at(-1)!.dispatchEvent(new Event('change'))
    expect(backing()).toEqual({ resolution: 16384 / 5500, requested: 16384, actual: 16384 })
    // The browser can allocate less than it advertises; the actual drawing buffer decides.
    gpu.allocatable = 8192
    rendering.resize()
    expect(backing()).toEqual({ resolution: 8192 / 5500, requested: 8192, actual: 8192 })
    expect(failed).not.toHaveBeenCalled()
    // No resolution can represent a surface the device will not allocate at all.
    Object.defineProperty(rendering.app.renderer.gl, 'drawingBufferWidth', { value: 0 })
    rendering.resize()
    expect(failed).toHaveBeenCalledOnce()
  } finally { gpu.limit = gpu.allocatable = 0; canvas.dispose(); frames.mockRestore(); media.mockRestore(); pixelRatio.mockRestore() }
})
