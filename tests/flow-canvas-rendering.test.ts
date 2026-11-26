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
    context = this; visible = true; shapes: number[][] = []
    clear() { this.shapes = []; return this } rect() { return this } roundRect(...box: number[]) { this.shapes.push(box); return this } circle() { return this } fill() { return this } stroke() { return this }
    moveTo() { return this } lineTo() { return this } closePath() { return this } save() { return this } setTransform() { return this } path() { return this } restore() { return this }
  }
  class TextStyle { fill = ''; styleKey = `style${styles++}`; constructor(_options: unknown) {} clone() { return new TextStyle({}) } destroy() {} }
  class Text extends Container {
    text = ''; style: TextStyle; visible = true; alpha = 1; private rasterResolution: number | null = null; roundPixels: boolean
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
import { FlowCanvas, type FlowCanvasModel, type FlowCanvasOptions } from '../src/renderer/src/agent/FlowCanvas'

const colors = { background: '#000000', card: '#111111', text: '#ffffff', muted: '#aaaaaa', border: '#777777', accent: '#8888ff', selection: '#222244', success: '#00ff00', error: '#ff0000', warning: '#ffff00', dots: '#333333' }
function model(names: readonly string[] = ['Check', 'Rebuild', 'Update']): FlowCanvasModel {
  const draft: AgentStepsDraft = { startKey: 's1', steps: names.map((name, at) => ({ ...newStepDraft([]), key: `s${at + 1}`, from: at + 1, name, onSuccess: 3, onFail: 2 })) }
  const flow = stepsFlow(draft)
  return { flow, layout: flowLayout(flow, flowMetrics), nodes: draft.steps.map(step => ({ name: step.name, type: 'T-SQL', icon: 'step-tsql', sub: 'master', never: false, changed: false })),
    accent: new Set(), hot: new Set(), fadeRest: false, chips: [], sequence: new Map() }
}
function create(root: HTMLElement, failed = () => { throw new Error('Canvas initialization failed') }, shown = model(), selected = 0, extra: Partial<FlowCanvasOptions> = {}) {
  return new FlowCanvas({ root, model: shown, colors, selected, focused: false, editable: true, select() {}, open() {}, connect() {}, dropped() {}, cameraChanged() {}, failed, ...extra })
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

it("draws the run overlay's order badges under their numbers, not on the layer above the labels", async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const root = document.createElement('div')
  Object.defineProperty(root, 'clientWidth', { value: 900 }); Object.defineProperty(root, 'clientHeight', { value: 600 })
  const canvas = create(root), rendering = canvas as unknown as Rendering & { front: { shapes: number[][] }; cards: { shapes: number[][] } }
  try {
    await Promise.resolve()
    canvas.update({ ...model(), hot: new Set(['0:success']), fadeRest: true, sequence: new Map([['0:success', '1 · 3']]) }, 0, false, true)
    rendering.draw()
    expect(rendering.pool.active.has('seq:0:success')).toBe(true)
    // The labels layer sits between cards and front (world: back, edges, cards, labels, front): a pill on front hides its number.
    expect(rendering.front.shapes).toEqual([])
    expect(rendering.cards.shapes.some(box => box[3] === 16 && box[4] === 8)).toBe(true)
  } finally { canvas.dispose(); frames.mockRestore() }
})

it("fades a faded step's and an off-path pill's text with its box, and brings it back when the overlay goes", async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const root = sized(900, 600)
  const canvas = create(root), rendering = canvas as unknown as { draw(): void; pool: { active: Map<string, { alpha: number }> } }
  const alpha = (key: string) => rendering.pool.active.get(key)?.alpha
  try {
    await Promise.resolve()
    const shown = model()
    // Step 1 succeeded to step 2, which is running; step 3 never ran. Step 1's failure Quit is off the path.
    canvas.update({ ...shown, nodes: shown.nodes.map((node, at) => ({ ...node, fade: at === 2, right: [{ text: at === 2 ? 'Waiting' : '✓ 00:00:01', tone: 'muted' as const }] })),
      hot: new Set(['0:success']), lit: new Set(['1:success', '1:fail']), fadeRest: true }, 0, false, true)
    rendering.draw()
    expect(alpha('name:2')).toBeLessThan(1)
    expect(alpha('right:2:0')).toBeLessThan(1)
    expect(alpha('name:0')).toBe(1)
    expect(alpha('quit:0:fail')).toBeLessThan(1)
    expect(alpha('quit:1:fail')).toBe(1)
    canvas.update(shown, 0, false, true)
    rendering.draw()
    expect(alpha('name:2')).toBe(1)
    expect(alpha('quit:0:fail')).toBe(1)
  } finally { canvas.dispose(); frames.mockRestore() }
})

type Placed = { camera: { x: number; y: number; scale: number }; connecting?: unknown }
const sized = (width: number, height: number) => {
  const root = document.createElement('div')
  Object.defineProperty(root, 'clientWidth', { value: width }); Object.defineProperty(root, 'clientHeight', { value: height })
  return root
}
const fifty = () => model(Array.from({ length: 50 }, (_, at) => `Step ${at + 1}`))

it('opens at the step selected before the canvas existed, and Fit shows the whole of a 50-step job', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const shown = fifty(), canvas = create(sized(900, 600), undefined, shown, 30), placed = canvas as unknown as Placed
  try {
    await Promise.resolve()
    // Step 31 was selected in List: the first placement scrolls to it rather than opening at the top.
    const node = shown.layout.nodes[30]!, top = placed.camera.y + node.y * placed.camera.scale
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top + node.height * placed.camera.scale).toBeLessThanOrEqual(600)
    // Fit goes below the 25 % zoom floor when the graph needs it, and the translation is for the scale it draws at.
    canvas.fit()
    expect(placed.camera.scale).toBeLessThan(0.25)
    expect(placed.camera.y).toBeGreaterThanOrEqual(0)
    expect(placed.camera.y + shown.layout.height * placed.camera.scale).toBeLessThanOrEqual(600)
    // Zooming out past Fit stays at Fit's scale, its centre kept.
    const fitted = placed.camera.scale
    canvas.zoom(0.5)
    expect(placed.camera.scale).toBeCloseTo(fitted)
  } finally { canvas.dispose(); frames.mockRestore() }
})

it('ends a connect drag when the steps change, and names the step under a pointer menu, none over empty canvas', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const root = sized(900, 600), shown = model(), canvas = create(root, undefined, shown), placed = canvas as unknown as Placed
  try {
    await Promise.resolve()
    const press = (x: number, y: number) => root.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: x, clientY: y }))
    const node = shown.layout.nodes[1]!, scale = placed.camera.scale
    press(placed.camera.x + (node.x + 20) * scale, placed.camera.y + (node.y + 10) * scale)
    expect(canvas.pressedNode()).toBe(1)
    press(placed.camera.x + (node.x - 60) * scale, placed.camera.y + (node.y + 10) * scale)
    expect(canvas.pressedNode()).toBe(-1)
    // A drag held from a port while a step is deleted (or moved): the next model ends it rather than drawing from a port that moved.
    placed.connecting = { from: 2, which: 'success', id: 1, x: 0, y: 0, over: -1 }
    canvas.update(model(['Check', 'Rebuild']), 0, false, true)
    expect(placed.connecting).toBeUndefined()
  } finally { canvas.dispose(); frames.mockRestore() }
})

type Moving = Placed & { moveCamera(camera: { x: number; y: number; scale: number }): void; chipBoxes(): { x: number; y: number; width: number }[] }
const captured = (root: HTMLElement) => Object.assign(root, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false })

it('drops a port dragged off the canvas on nothing, though a step lies under the pointer past the canvas edge', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const connect = vi.fn(), dropped = vi.fn()
  const root = captured(sized(900, 360)), shown = model(Array.from({ length: 8 }, (_, at) => `Step ${at + 1}`))
  const canvas = create(root, undefined, shown, 0, { connect, dropped }), placed = canvas as unknown as Placed
  try {
    await Promise.resolve()
    const { x, y, scale } = placed.camera, screen = ([px, py]: readonly [number, number]) => ({ clientX: x + px * scale, clientY: y + py * scale })
    const middle = (at: number) => { const node = shown.layout.nodes[at]!; return screen([node.x + node.width / 2, node.y + node.height / 2]) }
    const drag = (to: { clientX: number; clientY: number }) => {
      root.dispatchEvent(new MouseEvent('pointerdown', { button: 0, ...screen(shown.layout.ports[0]![0]) }))
      root.dispatchEvent(new MouseEvent('pointermove', to))
      root.dispatchEvent(new MouseEvent('pointerup', to))
    }
    // Step 5 is below the 360 px canvas: released over where it is drawn, the drag connects nothing and opens no picker.
    expect(middle(4).clientY).toBeGreaterThan(360)
    drag(middle(4))
    expect(connect).not.toHaveBeenCalled()
    expect(dropped).not.toHaveBeenCalled()
    // On the canvas, the same drag onto step 3 connects.
    drag(middle(2))
    expect(connect).toHaveBeenCalledWith(0, 'success', 2)
  } finally { canvas.dispose(); frames.mockRestore() }
})

it('brings a step panned off to the side back into view, as well as one above or below', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const shown = model(), canvas = create(sized(900, 600), undefined, shown), placed = canvas as unknown as Moving
  try {
    await Promise.resolve()
    placed.moveCamera({ x: -1200, y: -400, scale: 1 })
    canvas.reveal(1)
    const node = shown.layout.nodes[1]!, left = placed.camera.x + node.x, top = placed.camera.y + node.y
    expect(left).toBeGreaterThanOrEqual(0)
    expect(left + node.width).toBeLessThanOrEqual(900)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top + node.height).toBeLessThanOrEqual(600)
    expect(canvas.anchor(1)!.left).toBeGreaterThanOrEqual(0)
  } finally { canvas.dispose(); frames.mockRestore() }
})

it('opens where the released canvas left off, and brings the selection into view only when asked', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const shown = fifty(), camera = { x: -40, y: -1500, scale: 0.8 }
  const kept = create(sized(900, 600), undefined, shown, 0, { camera, revealSelected: false }), moved = create(sized(900, 600), undefined, shown, 0, { camera, revealSelected: true })
  try {
    await Promise.resolve()
    expect((kept as unknown as Placed).camera).toEqual(camera)
    // Step 1 is above that view: a selection made while no canvas existed is brought back.
    expect((moved as unknown as Placed).camera.y).toBeGreaterThan(camera.y)
  } finally { kept.dispose(); moved.dispose(); frames.mockRestore() }
})

it("fits the loop and changed chips beside the lanes as well as the graph, in a narrow pane", async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const draft: AgentStepsDraft = { startKey: 's1', steps: Array.from({ length: 10 }, (_, at) => ({ ...newStepDraft([]), key: `s${at + 1}`, from: at + 1, name: `Step ${at + 1}`, onSuccess: 3 as const, onFail: 2 as const })) }
  const steps = draft.steps.map((step, at) => at === 9 ? { ...step, onSuccess: 4 as const, onSuccessTarget: 's1' } : step)
  const flow = stepsFlow({ ...draft, steps }), layout = flowLayout(flow, flowMetrics)
  const shown: FlowCanvasModel = { ...model(steps.map(step => step.name)), flow, layout,
    chips: [{ edge: '9:success', text: 'Loop · 1, 2, 3, 4, 5, 6, 7, 8, 9, 10' }, { edge: '9:success', text: 'changed', tone: 'accent' }] }
  const canvas = create(sized(320, 600), undefined, shown), placed = canvas as unknown as Moving
  try {
    await Promise.resolve()
    const boxes = placed.chipBoxes()
    expect(Math.min(...boxes.map(box => box.x))).toBeLessThan(0)
    canvas.fit()
    for (const box of boxes) {
      expect(placed.camera.x + box.x * placed.camera.scale).toBeGreaterThanOrEqual(0)
      expect(placed.camera.x + (box.x + box.width) * placed.camera.scale).toBeLessThanOrEqual(320)
    }
  } finally { canvas.dispose(); frames.mockRestore() }
})

type Pressing = Moving & { drag?: unknown; width: number; rehome(): void }

it("treats macOS's Control+click as a right-click: it selects the step under it and starts no drag or connect", async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const select = vi.fn(), root = captured(sized(900, 600)), shown = model()
  const canvas = create(root, undefined, shown, 0, { select, platform: 'darwin' }), placed = canvas as unknown as Pressing
  try {
    await Promise.resolve()
    const { x, y, scale } = placed.camera, screen = ([px, py]: readonly [number, number]) => ({ clientX: x + px * scale, clientY: y + py * scale })
    const node = shown.layout.nodes[1]!
    root.dispatchEvent(new MouseEvent('pointerdown', { button: 0, ctrlKey: true, ...screen([node.x + 20, node.y + 10]) }))
    expect(select).toHaveBeenCalledWith(1)
    expect([placed.drag, placed.connecting]).toEqual([undefined, undefined])
    // On a port too: the menu opens, no edge follows the pointer.
    root.dispatchEvent(new MouseEvent('pointerdown', { button: 0, ctrlKey: true, ...screen(shown.layout.ports[1]![1]) }))
    expect(placed.connecting).toBeUndefined()
  } finally { canvas.dispose(); frames.mockRestore() }
})

it('takes a port press that has not moved on screen as a click, at any zoom, and drops where the pointer is released', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const connect = vi.fn(), dropped = vi.fn(), root = captured(sized(900, 600)), shown = model()
  const canvas = create(root, undefined, shown, 0, { connect, dropped }), placed = canvas as unknown as Pressing
  const screen = ([px, py]: readonly [number, number]) => ({ clientX: placed.camera.x + px * placed.camera.scale, clientY: placed.camera.y + py * placed.camera.scale })
  const press = (from: { clientX: number; clientY: number }, ...moves: { clientX: number; clientY: number }[]) => {
    root.dispatchEvent(new MouseEvent('pointerdown', { button: 0, ...from }))
    for (const to of moves) root.dispatchEvent(new MouseEvent('pointermove', to))
    root.dispatchEvent(new MouseEvent('pointerup', moves.at(-1) ?? from))
  }
  try {
    await Promise.resolve()
    const [px, py] = shown.layout.ports[0]![0]
    // The port's lower rim, below the step's own box: a click there opens no picker.
    press(screen([px, py + 8.5]))
    // Zoomed out to 25 %, a 4 px nudge is still a click, though it spans 16 graph units.
    placed.moveCamera({ ...placed.camera, scale: 0.25 })
    const at = screen([px, py])
    press(at, { clientX: at.clientX, clientY: at.clientY + 4 })
    expect(dropped).not.toHaveBeenCalled()
    // Moved over step 3 and released in the gap past the last step: the release decides, so it drops on empty space.
    placed.moveCamera({ ...placed.camera, scale: 1 })
    const third = shown.layout.nodes[2]!
    press(screen([px, py]), screen([third.x + 20, third.y + 10]), screen([third.x + 20, third.y + third.height + 30]))
    expect(connect).not.toHaveBeenCalled()
    expect(dropped).toHaveBeenCalledTimes(1)
  } finally { canvas.dispose(); frames.mockRestore() }
})

it("keeps a chip beside a Go to step's → N badge, and a left chip off the Start arrow's row", async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const base = model()
  // Step 1 goes to step 2 by Go to step (marked "→ 2"), and step 3 back to step 1 on success: a loop in a left lane.
  const steps = [0, 1, 2].map(at => ({ ...newStepDraft([]), key: `s${at + 1}`, from: at + 1, name: `Step ${at + 1}`, onSuccess: at === 1 ? 3 as const : 4 as const, onFail: 2 as const,
    onSuccessTarget: at === 0 ? 's2' : 's1' }))
  const flow = stepsFlow({ startKey: 's1', steps }), layout = flowLayout(flow, flowMetrics)
  const shown: FlowCanvasModel = { ...base, flow, layout, chips: [{ edge: '0:success', text: 'changed', tone: 'accent' }, { edge: '2:success', text: 'Loop · 1, 2, 3' }] }
  const canvas = create(sized(900, 600), undefined, shown), placed = canvas as unknown as Moving
  try {
    await Promise.resolve()
    // Step 1 goes to step 2 by Go to step: "→ 2" sits left of its arrow (31 px wide here), and "changed" sits left of that.
    const [changed] = placed.chipBoxes(), [px] = layout.ports[0]![0]
    expect(changed!.x + changed!.width).toBeLessThanOrEqual(px - 10 - 31 - 4)
    // The loop's chip moved onto the Start arrow's row: it goes below the arrow and pill instead.
    const loop = placed.chipBoxes()[1]!, sy = loop.y + 8
    canvas.update({ ...shown, layout: { ...layout, start: { from: [layout.start!.from[0], sy], to: [layout.start!.to[0], sy] } } }, 0, false, true)
    expect(placed.chipBoxes()[1]!.y).toBe(sy + 12)
  } finally { canvas.dispose(); frames.mockRestore() }
})

it('keeps its place while its view has no width (a background tab) rather than zooming right out', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const canvas = create(sized(900, 600)), placed = canvas as unknown as Pressing
  try {
    await Promise.resolve()
    const before = { ...placed.camera }
    placed.width = 1
    placed.rehome()
    expect(placed.camera).toEqual(before)
  } finally { canvas.dispose(); frames.mockRestore() }
})
