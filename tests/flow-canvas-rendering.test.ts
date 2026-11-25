// @vitest-environment happy-dom
// The steps Flow canvas keeps text sharp as the plan canvas does (tests/plan-canvas-rendering.test.ts): labels rasterize at the displayed
// size, a new display scale draws again at it, the backing store follows what the device allocates, and zooming leaves no stale text keys.
import { expect, it, vi } from 'vitest'
import { flowLayout, flowMetrics, stepsFlow } from '../src/shared/agent/flow'
import { newStepDraft, type AgentStepsDraft } from '../src/shared/agent/steps'

const gpu = vi.hoisted(() => ({ limit: 0, allocatable: 0, texts: new Set<{ render(): void }>() }))
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
    clear() { return this } rect() { return this } roundRect() { return this } circle() { return this } fill() { return this } stroke() { return this }
    moveTo() { return this } lineTo() { return this } closePath() { return this } save() { return this } setTransform() { return this } path() { return this } restore() { return this }
  }
  class TextStyle { fill = ''; styleKey = `style${styles++}`; constructor(_options: unknown) {} clone() { return new TextStyle({}) } destroy() {} }
  class Text extends Container {
    text = ''; style: TextStyle; visible = true; private rasterResolution: number | null = null; roundPixels: boolean
    _resolution: number | null = null; private currentKey = ''
    get resolution() { return this.rasterResolution }
    set resolution(value: number | null) { this.rasterResolution = this._resolution = value }
    get styleKey() { return `${this.text}:${this.style.styleKey}:${this._resolution}` }
    constructor(options: { style: TextStyle; roundPixels: boolean }) { super(); this.style = options.style; this.roundPixels = options.roundPixels; gpu.texts.add(this) }
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
      const size = (pixels: number) => Math.max(1, Math.min(pixels, gpu.allocatable || gpu.limit))
      const renderer = { resolution: 1, canvasText: system = new TextSystem({ resolution: 1 } as never, false),
        gl: gpu.limit ? { MAX_RENDERBUFFER_SIZE: 1, MAX_TEXTURE_SIZE: 2, MAX_VIEWPORT_DIMS: 3, isContextLost: () => false,
          getParameter: (name: number) => name === 3 ? [gpu.limit, gpu.limit] : gpu.limit,
          get drawingBufferWidth() { return size(canvas.width) }, get drawingBufferHeight() { return size(canvas.height) } } : undefined,
        resize(width: number, height: number, resolution: number) { renderer.resolution = resolution; canvas.width = Math.round(width * resolution); canvas.height = Math.round(height * resolution) } }
      return renderer
    })(this.canvas)
    init() { return Promise.resolve() }
    render() { for (const text of gpu.texts) text.render() }
    destroy() {}
  }
  return { Application, Container, Graphics, GraphicsPath: class {}, Text, TextStyle, CanvasTextMetrics: { measureText: (value: string) => ({ width: value.length * 7 }) }, TexturePool: { clear() {} } }
})
vi.mock('../src/renderer/src/core/windows', () => ({ observeResize: () => ({ dispose() {} }), observeIntersection: () => ({ dispose() {} }),
  windowOf: (node: Node) => node.ownerDocument?.defaultView ?? window, windows: { onDidAdopt: vi.fn(() => ({ dispose() {} })) } }))
import { FlowCanvas, type FlowCanvasModel } from '../src/renderer/src/agent/FlowCanvas'

const colors = { background: '#000000', card: '#111111', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', selection: '#222244', success: '#00ff00', error: '#ff0000', warning: '#ffff00', dots: '#333333' }
function model(): FlowCanvasModel {
  const draft: AgentStepsDraft = { startKey: 's1', steps: ['Check', 'Rebuild', 'Update'].map((name, at) => ({ ...newStepDraft([]), key: `s${at + 1}`, from: at + 1, name, onSuccess: 3, onFail: 2 })) }
  const flow = stepsFlow(draft)
  return { flow, layout: flowLayout(flow, flowMetrics), nodes: draft.steps.map(step => ({ name: step.name, type: 'T-SQL', icon: 'step-tsql', sub: 'master', never: false, changed: false })),
    accent: new Set(), hot: new Set(), fadeRest: false, chips: [], sequence: new Map() }
}
function create(root: HTMLElement, failed = () => { throw new Error('Canvas initialization failed') }) {
  return new FlowCanvas({ root, model: model(), colors, selected: 0, focused: false, editable: true, select() {}, open() {}, connect() {}, dropped() {}, cameraChanged() {}, failed })
}
type Rendering = { draw(): void; resize(): void; pool: { active: Map<string, { resolution: number; styleKey: string }> }
  app: { canvas: HTMLCanvasElement; renderer: { resolution: number; gl: { drawingBufferWidth: number }; canvasText: { _activeTextures: Record<string, unknown> } } } }

it('rasterizes labels at the displayed size and leaves no stale text keys over a long zoom', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const root = document.createElement('div')
  Object.defineProperty(root, 'clientWidth', { value: 900 }); Object.defineProperty(root, 'clientHeight', { value: 600 })
  const canvas = create(root), rendering = canvas as unknown as Rendering
  try {
    await Promise.resolve()
    rendering.draw()
    const keys = Object.keys(rendering.app.renderer.canvasText._activeTextures).length
    expect(keys).toBeGreaterThan(0)
    for (let step = 1; step <= 500; step++) { canvas.zoom(1.001); rendering.draw() }
    const scale = (canvas as unknown as { camera: { scale: number } }).camera.scale
    for (const label of rendering.pool.active.values()) expect(label.resolution).toBeCloseTo(scale)
    expect(Object.keys(rendering.app.renderer.canvasText._activeTextures).length).toBe(keys)
  } finally { canvas.dispose(); frames.mockRestore() }
  expect(gpu.texts.size).toBe(0)
})

it('draws again at a new display scale, caps the backing store at what the device allocates, and stops watching on disposal', async () => {
  const pixelRatio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const queries: EventTarget[] = []
  const media = vi.spyOn(window, 'matchMedia').mockImplementation(() => { const value = new EventTarget(); queries.push(value); return value as MediaQueryList })
  const root = document.createElement('div'), size = { width: 1200, height: 600 }
  Object.defineProperty(root, 'clientWidth', { get: () => size.width }); Object.defineProperty(root, 'clientHeight', { get: () => size.height })
  gpu.limit = 16384
  const canvas = create(root), rendering = canvas as unknown as Rendering
  const backing = () => ({ resolution: rendering.app.renderer.resolution, actual: rendering.app.renderer.gl.drawingBufferWidth })
  let disposed = false
  try {
    await Promise.resolve()
    pixelRatio.mockReturnValue(2)
    queries.at(-1)!.dispatchEvent(new Event('change'))
    expect(backing()).toEqual({ resolution: 2, actual: 2400 })
    expect(media).toHaveBeenLastCalledWith('(resolution: 2dppx)')
    rendering.draw()
    for (const label of rendering.pool.active.values()) expect(label.resolution).toBe(2)
    // Wider than the device allows at 3x: the highest resolution that fits, then what the browser really allocated.
    pixelRatio.mockReturnValue(3)
    size.width = 6000
    queries.at(-1)!.dispatchEvent(new Event('change'))
    expect(backing()).toEqual({ resolution: 16384 / 6000, actual: 16384 })
    gpu.allocatable = 8192
    rendering.resize()
    expect(backing()).toEqual({ resolution: 8192 / 6000, actual: 8192 })
    const removeWatch = vi.spyOn(queries.at(-1)!, 'removeEventListener')
    canvas.dispose()
    disposed = true
    expect(removeWatch).toHaveBeenCalledWith('change', expect.any(Function))
  } finally {
    if (!disposed) canvas.dispose()
    gpu.limit = 0; gpu.allocatable = 0
    frames.mockRestore(); media.mockRestore(); pixelRatio.mockRestore()
  }
})
