// The Steps › Flow view's canvas (docs/sql-server-agent.md › Steps › Flow; mocks rx-flow*): Pixi, as the execution plan viewer draws,
// sharing its camera, Fit and zoom (plans/geometry.ts), label pool (plans/labels.ts) and icons (src/shared/icons.ts). It draws on demand
// with no ticker, culls nothing (a job has at most a few dozen steps) and draws nothing while hidden. It only draws and reports pointer
// gestures: the selection, the menu, the editor and every edit belong to JobDocumentService. The accessible tree of steps is the DOM's.
// Pixi's interpreter replaces generated functions, retaining the application's strict CSP.
import 'pixi.js/unsafe-eval'
import { Application, CanvasTextMetrics, Container, Graphics, GraphicsPath, Text, TextStyle, TexturePool } from 'pixi.js'
import { flowEdgeKey, type FlowLayout, type FlowPoint, type FlowWhich, type StepsFlow } from '../../../shared/agent/flow'
import { svgIcons, iconStroke, type SvgIconId } from '../../../shared/icons'
import { radii, typeScale } from '../../../shared/theme/metrics'
import type { Disposable } from '../core/types'
import { observeIntersection, observeResize, windowOf, windows } from '../core/windows'
import { uiFontFamily } from '../fonts'
import { fit, zoomAt, type Camera } from '../plans/geometry'
import { LabelPool } from '../plans/labels'

export interface FlowCanvasColors {
  readonly background: string; readonly card: string; readonly text: string; readonly muted: string; readonly border: string
  readonly accent: string; readonly selection: string; readonly success: string; readonly error: string; readonly warning: string
  /** The dot grid the graph sits on (rx-flow's canvas). */
  readonly dots: string
}

/** The dot grid's pitch at 100 %, in graph units (rx-flow's 16 px), and its dots' radius on screen. */
const gridPitch = 16, gridDot = 1
export type FlowTone = 'ok' | 'bad' | 'muted' | 'run' | 'accent'
/** One step as the canvas draws it. */
export interface FlowCanvasNode {
  readonly name: string
  readonly type: string
  readonly icon: SvgIconId
  /** Its key field: database, package, command, run as or retries. */
  readonly sub: string
  readonly never: boolean
  readonly changed: boolean
  /** An overlay's state: faded (not reached), the current step's ring and bar, and words on the right (an outcome and duration). */
  readonly fade?: boolean
  readonly current?: boolean
  readonly bar?: number
  readonly right?: readonly { readonly text: string; readonly tone: FlowTone }[]
}
export interface FlowCanvasModel {
  readonly flow: StepsFlow
  readonly layout: FlowLayout
  readonly nodes: readonly FlowCanvasNode[]
  /** Edges by `${from}:${which}`: drawn in the accent (changed in the draft), bold (an overlay's path) or faded. */
  readonly accent: ReadonlySet<string>
  readonly hot: ReadonlySet<string>
  /** Everything not hot is faded: an overlay draws its path over the rest. */
  readonly fadeRest: boolean
  /** Chips beside an edge's lane: the loop tag, "changed"; and the order an overlay's run took each edge. */
  readonly chips: readonly { readonly edge: string; readonly text: string; readonly tone?: FlowTone }[]
  readonly sequence: ReadonlyMap<string, string>
}
export interface FlowCanvasOptions {
  readonly root: HTMLElement
  model: FlowCanvasModel
  colors: FlowCanvasColors
  selected: number
  focused: boolean
  editable: boolean
  /** Where the camera was when this view's last canvas was released (Steps scrolled out of view): the new one opens there. */
  readonly camera?: Camera
  /** Bring the selected step into view on the first placement: a selection made before the canvas existed, or while it was released. */
  readonly revealSelected?: boolean
  /** A step was clicked (selected) or double-clicked (opened); right-click selects before MenuService opens the step's menu. */
  select(index: number): void
  open(index: number): void
  /** A ✓ or ✗ port was dragged onto a step, or dropped on empty space (the action's submenu opens there). */
  connect(from: number, which: FlowWhich, to: number): void
  dropped(from: number, which: FlowWhich, clientX: number, clientY: number): void
  cameraChanged(camera: Camera): void
  failed(): void
}

type ChipBox = { readonly chip: FlowCanvasModel['chips'][number]; readonly x: number; readonly y: number; readonly width: number; readonly style: TextStyle; readonly color: string }
const iconPaths = new Map(Object.entries(svgIcons).map(([key, icon]) => [key, new GraphicsPath(icon.path)]))
const portRadius = 7.5
const dash = 5, gap = 3

/** The Flow view's Pixi canvas: one per Flow view, created after an asynchronous import as the plan viewer's is. */
export class FlowCanvas {
  private readonly app = new Application()
  private readonly world = new Container()
  /** In screen space, under the world: the dots move with the graph but stay one size at every zoom. */
  private readonly grid = new Graphics()
  private readonly back = new Graphics()
  private readonly edges = new Graphics()
  private readonly cards = new Graphics()
  private readonly labels = new Container()
  private readonly front = new Graphics()
  private readonly styles = {
    title: new TextStyle({ fontFamily: uiFontFamily, fontSize: typeScale.sm.size, fontWeight: '600' }),
    body: new TextStyle({ fontFamily: uiFontFamily, fontSize: typeScale.xs.size }),
    small: new TextStyle({ fontFamily: uiFontFamily, fontSize: typeScale.xs.size - 1 }),
    badge: new TextStyle({ fontFamily: uiFontFamily, fontSize: typeScale.xs.size - 1, fontWeight: '600' })
  }
  private readonly pool = new LabelPool<Text>(() => {
    const sprite = new Text({ text: '', style: this.styles.body, roundPixels: true })
    this.labels.addChild(sprite)
    return sprite
  }, sprite => { sprite.visible = false }, sprite => sprite.destroy())
  private readonly fitted = new Map<string, string>()
  private camera: Camera = { x: 0, y: 0, scale: 1 }
  private placed = false
  private ready = false
  private disposed = false
  private visible = true
  private frame = 0
  private width = 1
  private height = 1
  private hover = -1
  private drag?: { readonly id: number; x: number; y: number; moved: boolean }
  /** The node under the last press (-1 for none): a pointer menu is the menu of the step it opened on, never the selected one. */
  private pressed = -1
  private connecting?: { readonly from: number; readonly which: FlowWhich; readonly id: number; x: number; y: number; over: number }
  private owner: Window
  private ownerDocument: Document
  private pixelRatioQuery?: MediaQueryList
  private backingLimit = Infinity
  private readonly size: Disposable
  private readonly visibility: Disposable
  private readonly adoption: Disposable

  constructor(private readonly options: FlowCanvasOptions) {
    this.owner = windowOf(options.root)
    this.ownerDocument = options.root.ownerDocument
    this.ownerDocument.addEventListener('visibilitychange', this.visibilityChanged)
    this.watchPixelRatio()
    this.adoption = windows.onDidAdopt(() => {
      const document = options.root.ownerDocument
      if (this.ownerDocument === document) return
      this.cancelFrame()
      this.ownerDocument.removeEventListener('visibilitychange', this.visibilityChanged)
      this.owner = windowOf(options.root)
      this.ownerDocument = document
      document.addEventListener('visibilitychange', this.visibilityChanged)
      this.watchPixelRatio()
      this.resize()
    })
    this.size = observeResize(options.root, () => this.resize())
    this.visibility = observeIntersection(options.root, entries => {
      this.visible = entries.some(entry => entry.isIntersecting)
      if (this.visible) this.resize()
      else this.cancelFrame()
    })
    options.root.addEventListener('wheel', this.wheel, { passive: false })
    options.root.addEventListener('pointerdown', this.down)
    options.root.addEventListener('pointermove', this.move)
    options.root.addEventListener('pointerup', this.up)
    options.root.addEventListener('pointercancel', this.cancel)
    options.root.addEventListener('lostpointercapture', this.cancel)
    options.root.addEventListener('pointerleave', this.leave)
    options.root.addEventListener('dblclick', this.doubleClick)
    void this.initialize()
  }
  private async initialize(): Promise<void> {
    try {
      await this.app.init({ preference: 'webgl', autoStart: false, sharedTicker: false, antialias: true, backgroundAlpha: 0, resolution: this.owner.devicePixelRatio || 1, autoDensity: true })
      this.ready = true
      if (this.disposed) { this.app.destroy(true, { children: true }); return }
      this.app.canvas.setAttribute('aria-hidden', 'true')
      this.app.canvas.addEventListener('webglcontextlost', this.contextLost)
      this.options.root.append(this.app.canvas)
      this.world.addChild(this.back, this.edges, this.cards, this.labels, this.front)
      this.app.stage.addChild(this.grid, this.world)
      const gl = this.gl
      if (gl) {
        const limits = [gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), ...Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as ArrayLike<number> | null ?? [])]
        this.backingLimit = Math.min(...limits.filter((value): value is number => typeof value === 'number' && value > 0))
      }
      this.resize()
    } catch {
      try { this.app.destroy(true, { children: true }) } catch { /* Initialization may have failed before a renderer exists. */ }
      this.ready = false
      if (!this.disposed) this.options.failed()
    }
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.cancelFrame(); this.options.failed() }
  private visibilityChanged = () => { if (this.ownerDocument.hidden) this.cancelFrame(); else this.resize() }
  // As the plan canvas: a new display scale (another monitor, a changed OS scale) draws again at it, so text stays sharp.
  private watchPixelRatio(): void {
    this.pixelRatioQuery?.removeEventListener('change', this.pixelRatioChanged)
    this.pixelRatioQuery = this.owner.matchMedia(`(resolution: ${this.owner.devicePixelRatio || 1}dppx)`)
    this.pixelRatioQuery.addEventListener('change', this.pixelRatioChanged, { once: true })
  }
  private pixelRatioChanged = () => {
    if (this.disposed) return
    this.watchPixelRatio()
    this.resize()
  }
  private get gl(): WebGLRenderingContext | undefined { return (this.app.renderer as { gl?: WebGLRenderingContext }).gl }
  // A collapsed root at a low zoom factor rounds to a 0-pixel canvas, which still has a 1-pixel drawing buffer.
  private backed(gl: WebGLRenderingContext): boolean { return gl.drawingBufferWidth === Math.max(1, this.app.canvas.width) && gl.drawingBufferHeight === Math.max(1, this.app.canvas.height) }
  private resize(): void {
    if (this.disposed || !this.ready) return
    this.width = Math.max(1, this.options.root.clientWidth)
    this.height = Math.max(1, this.options.root.clientHeight)
    // Full DPI when the backing store fits, else the most the device allocates; labels rasterize at the effective resolution.
    this.app.renderer.resize(this.width, this.height, Math.min(this.owner.devicePixelRatio || 1, this.backingLimit / this.width, this.backingLimit / this.height))
    const gl = this.gl
    if (gl && !gl.isContextLost() && !this.backed(gl)) {
      // Browsers may allocate less than the advertised limits and clamp silently. Follow what was allocated.
      const resolution = Math.min(gl.drawingBufferWidth / this.width, gl.drawingBufferHeight / this.height)
      if (resolution > 0) this.app.renderer.resize(this.width, this.height, resolution)
      if (!(resolution > 0) || !this.backed(gl)) { this.cancelFrame(); this.options.failed(); return }
    }
    // The first size places the graph at 100 %, centred, from the top (Fit when it is wider than the view).
    // The selection made before the canvas existed (List's, or before Retry) is revealed once the view has its size.
    if (!this.placed && this.width > 1) {
      this.placed = true
      this.moveCamera(this.options.camera ?? this.home())
      if (this.options.selected >= 0 && (this.options.revealSelected ?? true)) this.reveal(this.options.selected)
    }
    this.invalidate()
  }
  private home(): Camera {
    const { x, width } = this.bounds()
    // Narrowed to the width only (a long job scrolls), from the top as at 100 %, so the Start step stays where the eye starts.
    if (width > this.width) { const scale = Math.max(this.minScale(), (this.width - 16) / width); return { scale, x: Math.round((this.width - width * scale) / 2 - x * scale), y: 0 } }
    return { scale: 1, x: Math.round((this.width - width) / 2 - x), y: 0 }
  }
  private cancelFrame(): void { if (this.frame) this.owner.cancelAnimationFrame(this.frame); this.frame = 0 }
  private invalidate(): void {
    if (!this.frame && this.ready && !this.disposed && this.visible && !this.ownerDocument.hidden) this.frame = this.owner.requestAnimationFrame(() => { this.frame = 0; this.draw() })
  }
  /** The least zoom: 25 %, or less where Fit needs it to show the whole graph (a 50-step job). */
  private minScale(): number { return Math.min(0.25, fit(this.bounds(), this.width, this.height).scale) }
  /** What the graph draws over: the layout, and the chips beside its lanes, whose text can reach past the layout's left edge. */
  private bounds(): { x: number; y: number; width: number; height: number } {
    const { width, height } = this.options.model.layout
    let left = 0, right = width
    for (const chip of this.chipBoxes()) { left = Math.min(left, chip.x - 8); right = Math.max(right, chip.x + chip.width + 8) }
    return { x: left, y: 0, width: right - left, height }
  }
  /** A zoom about a point, its scale kept within the limits before the camera is moved, so the point stays put. */
  private zoomAbout(x: number, y: number, factor: number): void {
    const scale = Math.max(this.minScale(), Math.min(3, this.camera.scale * factor))
    this.moveCamera(zoomAt(this.camera, x, y, scale / this.camera.scale))
  }
  private moveCamera(camera: Camera): void {
    if (![camera.x, camera.y, camera.scale].every(Number.isFinite) || camera.scale <= 0) return
    this.camera = { ...camera, scale: Math.max(this.minScale(), Math.min(3, camera.scale)) }
    this.options.cameraChanged({ ...this.camera })
    this.invalidate()
  }

  // --- What the view tells the canvas ------------------------------------------------------------------------------------

  update(model: FlowCanvasModel, selected: number, focused: boolean, editable: boolean): void {
    const grew = model.layout.width !== this.options.model.layout.width
    // A connect drag names its step by index: once the steps change under it (Delete, Alt+Up) that index may be another step, or none.
    if (this.connecting && model.flow !== this.options.model.flow) this.cancelConnect()
    Object.assign(this.options, { model, selected, focused, editable })
    if (grew && this.placed && this.camera.scale === 1) this.rehome()
    this.invalidate()
  }
  colors(colors: FlowCanvasColors): void { this.options.colors = colors; this.invalidate() }
  fit(): void { this.moveCamera(fit(this.bounds(), this.width, this.height)) }
  /** Back to where the graph first showed (100 %, centred, or Fit when wider than the view), once the view has its new size: the docked editor opening or closing. */
  recenter(): void { this.owner.requestAnimationFrame(() => { if (!this.disposed && this.ready) { this.resize(); this.rehome() } }) }
  /** For a new width: x and the scale as placed first, the scroll kept, and the selected step (the one being edited) still in view. */
  private rehome(): void {
    this.moveCamera({ ...this.home(), y: this.camera.y })
    if (this.options.selected >= 0) this.reveal(this.options.selected)
  }
  zoom(factor: number): void { this.zoomAbout(this.width / 2, this.height / 2, factor) }
  /** Scrolls a step into view on both axes (the keyboard's selection, and its menu's anchor); a step wider than the view shows its left. */
  reveal(index: number): void {
    const node = this.options.model.layout.nodes[index]
    if (!node) return
    const into = (start: number, size: number, view: number) => start < 8 || size > view - 16 ? 8 - start : start + size > view - 8 ? view - 8 - (start + size) : 0
    const { x, y, scale } = this.camera
    const dx = into(x + node.x * scale, node.width * scale, this.width), dy = into(y + node.y * scale, node.height * scale, this.height)
    if (dx || dy) this.moveCamera({ ...this.camera, x: x + dx, y: y + dy })
  }
  /** The step a pointer menu opened on: the node under the press that opened it, or -1 for empty canvas, an edge or a pill. */
  pressedNode(): number { return this.pressed }
  /** A step's box on screen, for a menu opened from the keyboard. */
  anchor(index: number): DOMRect | undefined {
    const node = this.options.model.layout.nodes[index]
    if (!node) return undefined
    const box = this.options.root.getBoundingClientRect(), { x, y, scale } = this.camera
    return new DOMRect(box.left + x + node.x * scale, box.top + y + node.y * scale, node.width * scale, node.height * scale)
  }

  // --- Pointer ---------------------------------------------------------------------------------------------------------

  private world2(event: { clientX: number; clientY: number }): FlowPoint {
    const rect = this.options.root.getBoundingClientRect()
    return [(event.clientX - rect.left - this.camera.x) / this.camera.scale, (event.clientY - rect.top - this.camera.y) / this.camera.scale]
  }
  /** The pointer is over the canvas: pointer capture keeps reporting a drag that left it, where no step or empty space is under it. */
  private inside(event: { clientX: number; clientY: number }): boolean {
    const rect = this.options.root.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }
  private nodeAt([x, y]: FlowPoint): number {
    return this.options.model.layout.nodes.findIndex(node => x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height + portRadius)
  }
  private portAt([x, y]: FlowPoint): { readonly from: number; readonly which: FlowWhich } | undefined {
    const ports = this.options.model.layout.ports
    for (let at = 0; at < ports.length; at++) for (const [index, which] of [[0, 'success'], [1, 'fail']] as const) {
      const [px, py] = ports[at]![index]
      if (Math.hypot(x - px, y - py) <= portRadius + 2) return { from: at, which }
    }
    return undefined
  }
  private wheel = (event: WheelEvent) => {
    event.preventDefault()
    const bounds = this.options.root.getBoundingClientRect()
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1
    if (event.ctrlKey || event.metaKey) this.zoomAbout(event.clientX - bounds.left, event.clientY - bounds.top, Math.exp(-event.deltaY * multiplier * 0.005))
    else this.moveCamera({ ...this.camera, x: this.camera.x - (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * multiplier, y: this.camera.y - (event.shiftKey ? 0 : event.deltaY) * multiplier })
  }
  private down = (event: PointerEvent) => {
    if (this.drag || this.connecting) return
    const point = this.world2(event)
    this.pressed = this.nodeAt(point)
    if (event.button === 2) { const node = this.nodeAt(point); if (node >= 0) this.options.select(node); return }
    if (event.button !== 0 && event.button !== 1) return
    const port = event.button === 0 && this.options.editable ? this.portAt(point) : undefined
    event.preventDefault()
    this.options.root.focus({ preventScroll: true })
    this.options.root.setPointerCapture(event.pointerId)
    if (port) { this.connecting = { ...port, id: event.pointerId, x: point[0], y: point[1], over: -1 }; this.invalidate(); return }
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
  }
  private move = (event: PointerEvent) => {
    if (this.connecting?.id === event.pointerId) {
      const point = this.world2(event)
      const over = this.inside(event) ? this.nodeAt(point) : -1
      Object.assign(this.connecting, { x: point[0], y: point[1], over: over === this.connecting.from ? -1 : over })
      this.invalidate()
      return
    }
    if (this.drag?.id === event.pointerId) {
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 2) this.drag.moved = true
      if (this.drag.moved) { this.moveCamera({ ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy }); this.drag.x = event.clientX; this.drag.y = event.clientY }
      return
    }
    if (!event.buttons && event.pointerType !== 'touch') {
      const point = this.world2(event)
      const hover = this.nodeAt(point)
      const port = this.options.editable ? this.portAt(point) : undefined
      this.options.root.style.cursor = port ? 'crosshair' : hover >= 0 ? 'pointer' : ''
      if (hover !== this.hover) { this.hover = hover; this.invalidate() }
    }
  }
  private up = (event: PointerEvent) => {
    if (this.options.root.hasPointerCapture(event.pointerId)) this.options.root.releasePointerCapture(event.pointerId)
    const connecting = this.connecting
    if (connecting?.id === event.pointerId) {
      this.connecting = undefined
      this.invalidate()
      const [px, py] = this.options.model.layout.ports[connecting.from]![connecting.which === 'success' ? 0 : 1]
      // A press without a drag is a click on the port, and a release off the canvas is no drop (the step there may be scrolled away).
      if (Math.hypot(connecting.x - px, connecting.y - py) < 6 || !this.inside(event)) return
      if (connecting.over >= 0) this.options.connect(connecting.from, connecting.which, connecting.over)
      else if (this.nodeAt([connecting.x, connecting.y]) !== connecting.from) this.options.dropped(connecting.from, connecting.which, event.clientX, event.clientY)
      return
    }
    const drag = this.drag
    if (drag?.id !== event.pointerId) return
    this.drag = undefined
    if (drag.moved) return
    const node = this.nodeAt(this.world2(event))
    if (node >= 0) this.options.select(node)
  }
  private cancel = (event: PointerEvent) => {
    if (this.connecting?.id === event.pointerId) { this.connecting = undefined; this.invalidate() }
    if (this.drag?.id === event.pointerId) this.drag = undefined
  }
  /** Escape ends a connect drag without connecting. */
  cancelConnect(): boolean {
    if (!this.connecting) return false
    const id = this.connecting.id
    this.connecting = undefined
    if (this.options.root.hasPointerCapture(id)) this.options.root.releasePointerCapture(id)
    this.invalidate()
    return true
  }
  private leave = () => { if (this.hover !== -1) { this.hover = -1; this.invalidate() } }
  private doubleClick = (event: MouseEvent) => {
    const node = this.nodeAt(this.world2(event))
    if (node >= 0) this.options.open(node)
  }

  // --- Drawing ---------------------------------------------------------------------------------------------------------

  private fitText(text: string, width: number, style: TextStyle): string {
    const key = `${style.fontWeight}:${style.fontSize}:${width}:${text}`
    const cached = this.fitted.get(key)
    if (cached !== undefined) return cached
    let fitted = text.replace(/\s+/g, ' ').trim()
    if (CanvasTextMetrics.measureText(fitted, style).width > width) {
      const characters = Array.from(fitted)
      let low = 0, high = characters.length - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (CanvasTextMetrics.measureText(characters.slice(0, middle).join('') + '…', style).width <= width) low = middle
        else high = middle - 1
      }
      fitted = characters.slice(0, low).join('') + '…'
    }
    if (this.fitted.size >= 1024) this.fitted.delete(this.fitted.keys().next().value!)
    this.fitted.set(key, fitted)
    return fitted
  }
  private measure(text: string, style: TextStyle): number { return CanvasTextMetrics.measureText(text, style).width }
  private tone(tone: FlowTone | undefined): string {
    const colors = this.options.colors
    return tone === 'ok' ? colors.success : tone === 'bad' ? colors.error : tone === 'run' || tone === 'accent' ? colors.accent : tone === 'muted' ? colors.muted : colors.text
  }
  private polyline(graphics: Graphics, points: readonly FlowPoint[], dashed: boolean): void {
    if (!dashed) { graphics.moveTo(points[0]![0], points[0]![1]); for (const point of points.slice(1)) graphics.lineTo(point[0], point[1]); return }
    let on = true, left = dash
    for (let at = 1; at < points.length; at++) {
      let [x, y] = points[at - 1]!
      const [tx, ty] = points[at]!
      let length = Math.hypot(tx - x, ty - y)
      const ux = (tx - x) / (length || 1), uy = (ty - y) / (length || 1)
      while (length > 0) {
        const step = Math.min(left, length)
        if (on) graphics.moveTo(x, y).lineTo(x + ux * step, y + uy * step)
        x += ux * step; y += uy * step; length -= step; left -= step
        if (left <= 0) { on = !on; left = on ? dash : gap }
      }
    }
  }
  private arrow(graphics: Graphics, points: readonly FlowPoint[], color: string): void {
    const [x, y] = points[points.length - 1]!, [px, py] = points[points.length - 2]!
    const angle = Math.atan2(y - py, x - px), dx = Math.cos(angle), dy = Math.sin(angle)
    graphics.moveTo(x, y).lineTo(x - dx * 7 - dy * 4, y - dy * 7 + dx * 4).lineTo(x - dx * 7 + dy * 4, y - dy * 7 - dx * 4).closePath().fill(color)
  }
  /** Only the dots the view shows, one fill; zoomed out, every other dot is left out so the grid never turns into a texture. */
  private drawGrid(color: string): void {
    this.grid.clear()
    let pitch = gridPitch * this.camera.scale
    while (pitch < gridPitch / 2) pitch *= 2
    const first = (offset: number) => ((offset % pitch) + pitch) % pitch
    const x0 = first(this.camera.x), y0 = first(this.camera.y)
    for (let y = y0; y < this.height; y += pitch) for (let x = x0; x < this.width; x += pitch) this.grid.circle(Math.round(x), Math.round(y), gridDot)
    this.grid.fill(color)
  }
  private draw(): void {
    const { colors, model, selected, focused } = this.options
    const { layout, flow, nodes } = model
    const resolution = this.app.renderer.resolution * this.camera.scale
    this.world.position.set(this.camera.x, this.camera.y)
    this.world.scale.set(this.camera.scale)
    this.back.clear(); this.edges.clear(); this.cards.clear(); this.front.clear()
    this.drawGrid(colors.dots)
    this.pool.begin()
    const label = (key: string, text: string, x: number, y: number, style: TextStyle, _fill: string, anchorX = 0) => {
      const sprite = this.pool.get(key)
      if (sprite.text !== text) sprite.text = text
      if (sprite.style !== style) sprite.style = style
      if (sprite.resolution !== resolution) sprite.resolution = resolution
      sprite.position.set(Math.round(x - (anchorX ? this.measure(text, style) * anchorX : 0)), Math.round(y)); sprite.visible = true
    }
    const styled = (base: TextStyle, fill: string) => this.styled(base, fill)
    const pill = (key: string, text: string, cx: number, top: number, stroke: string, fill: string, color: string, alpha = 1, center = true) => {
      const style = styled(this.styles.small, color)
      const width = this.measure(text, style) + 14, left = center ? cx - width / 2 : cx
      this.cards.roundRect(left, top, width, 18, 9).fill({ color: fill, alpha }).stroke({ color: stroke, width: 1, alpha })
      label(key, text, left + 7, top + 3, style, color)
      return width
    }
    // Edges: each with a halo in the canvas's colour first, so the one drawn on top of a crossing shows a gap.
    for (const item of layout.edges) {
      if (item.points.length < 2) continue
      const key = flowEdgeKey(item.edge.from, item.edge.which)
      const accent = model.accent.has(key), hot = model.hot.has(key)
      const dim = !hot && (model.fadeRest || nodes[item.edge.from]?.never)
      const color = accent ? colors.accent : item.edge.which === 'success' ? colors.success : colors.error
      const width = hot || accent ? 2.25 : 1.25
      this.polyline(this.edges, item.points, false)
      this.edges.stroke({ color: colors.background, width: width + 4 })
      this.polyline(this.edges, item.points, item.edge.which === 'fail')
      this.edges.stroke({ color, width, alpha: dim ? 0.3 : 1, cap: 'butt' })
      this.arrow(this.edges, item.points, color)
      if (item.edge.marked) {
        const target = item.edge.target.kind === 'step' ? item.edge.target.index + 1 : 0
        const text = `→ ${target}`, style = styled(this.styles.small, colors.muted)
        const width2 = this.measure(text, style) + 10, [mx, my] = item.points[0]!
        this.cards.roundRect(mx - 10 - width2, my + 5, width2, 16, 3).fill(colors.card).stroke({ color: colors.border, width: 1, alpha: dim ? 0.4 : 1 })
        label(`mark:${key}`, text, mx - 5 - width2, my + 7, style, colors.muted)
      }
    }
    // The Start step's entry arrow and pill.
    if (layout.start) {
      const [fx, fy] = layout.start.from, [tx, ty] = layout.start.to
      const points: FlowPoint[] = [[fx + 4, fy], [tx, ty]]
      this.polyline(this.edges, points, false)
      this.edges.stroke({ color: colors.background, width: 5 })
      this.polyline(this.edges, points, false)
      this.edges.stroke({ color: colors.accent, width: 1.25 })
      this.arrow(this.edges, points, colors.accent)
      const style = styled(this.styles.body, colors.accent)
      const width = this.measure('Start', style) + 24
      this.cards.roundRect(fx - width, fy - 10, width, 20, 10).fill(colors.selection).stroke({ color: colors.accent, width: 1 })
      this.cards.moveTo(fx - width + 8, fy - 4).lineTo(fx - width + 14, fy).lineTo(fx - width + 8, fy + 4).closePath().fill(colors.accent)
      label('start', 'Start', fx - width + 17, fy - 7, style, colors.accent)
    }
    // Quit pills and the End node.
    for (const quit of layout.quits) {
      const key = flowEdgeKey(quit.edge.from, quit.edge.which)
      const alpha = model.hot.has(key) ? 1 : model.fadeRest || nodes[quit.edge.from]?.never ? 0.35 : 1
      const target = quit.edge.target
      if (target.kind === 'unread') { pill(`quit:${key}`, target.stepId !== undefined ? `Step ${target.stepId} · not read` : 'Not read', quit.at[0], quit.at[1], colors.muted, colors.background, colors.muted, alpha); continue }
      if (target.kind === 'missing') { pill(`quit:${key}`, 'Step missing', quit.at[0], quit.at[1], colors.warning, colors.background, colors.warning, alpha); continue }
      const success = target.kind === 'quit' && target.success
      pill(`quit:${key}`, `Quit · ${success ? 'success' : 'failure'}`, quit.at[0], quit.at[1], success ? colors.success : colors.error, colors.background, success ? colors.success : colors.error, alpha)
    }
    for (const end of layout.ends) {
      const key = flowEdgeKey(end.edge.from, end.edge.which)
      pill(`end:${key}`, '⚠ End · job fails', end.at[0], end.at[1], colors.warning, colors.background, colors.text, model.fadeRest && !model.hot.has(key) ? 0.35 : 1)
    }
    // Chips beside lanes (the loop tag, "changed") and the overlay's sequence badges.
    // A lane's chips sit past the lanes on its side, one after another; a straight edge's or a Quit's beside its port, clear of the pill.
    for (const { chip, x, y, width, style, color } of this.chipBoxes()) {
      this.cards.roundRect(x, y, width, 16, 3).fill(colors.card).stroke({ color: chip.tone === 'accent' ? colors.accent : colors.border, width: 1 })
      label(`chip:${chip.edge}:${chip.text}`, chip.text, x + 6, y + 2, style, color)
    }
    for (const [key, text] of model.sequence) {
      const item = layout.edges.find(edge => flowEdgeKey(edge.edge.from, edge.edge.which) === key)
      if (!item) continue
      const style = styled(this.styles.badge, colors.background), width = Math.max(16, this.measure(text, style) + 8)
      this.front.roundRect(item.mid[0] - width / 2, item.mid[1] - 8, width, 16, 8).fill(colors.text)
      label(`seq:${key}`, text, item.mid[0], item.mid[1] - 6, style, colors.background, 0.5)
    }
    // Nodes.
    nodes.forEach((node, at) => {
      const box = layout.nodes[at]!
      const isSelected = at === selected, isHover = at === this.hover || at === this.connecting?.over
      const alpha = node.fade ? 0.5 : 1
      const stroke = isSelected || node.current || isHover ? colors.accent : colors.border
      if (node.current) this.cards.roundRect(box.x - 3, box.y - 3, box.width + 6, box.height + 6, radii.lg.px + 3).stroke({ color: colors.accent, width: 3, alpha: 0.35 })
      if (isSelected && focused) this.cards.roundRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8, radii.lg.px + 4).stroke({ color: colors.accent, width: 1, alpha: 0.6 })
      this.cards.roundRect(box.x, box.y, box.width, box.height, radii.lg.px).fill({ color: node.never ? colors.background : isSelected ? colors.selection : colors.card, alpha })
      if (node.never) this.polylineRect(this.cards, box.x, box.y, box.width, box.height, stroke)
      else this.cards.roundRect(box.x, box.y, box.width, box.height, radii.lg.px).stroke({ color: stroke, width: isSelected ? 2 : 1, alpha })
      if (node.bar !== undefined) this.cards.rect(box.x, box.y + box.height - 3, box.width * Math.max(0, Math.min(1, node.bar)), 3).fill(colors.accent)
      // Number, name, tags, type and icon; then the key field and the overlay's words.
      const textAlpha = node.fade ? 0.55 : 1
      const muted = colors.muted, strong = node.never ? colors.muted : colors.text
      this.cards.circle(box.x + 17, box.y + 14, 9).fill(colors.background).stroke({ color: colors.border, width: 1, alpha })
      label(`no:${at}`, String(at + 1), box.x + 17, box.y + 7, styled(this.styles.small, muted), muted, 0.5)
      const typeStyle = styled(this.styles.small, muted)
      const typeWidth = this.measure(node.type, typeStyle)
      const typeX = box.x + box.width - 10 - typeWidth
      label(`type:${at}`, node.type, typeX, box.y + 7, typeStyle, muted)
      const path = iconPaths.get(node.icon)
      // One matrix, since a scale after a translate in Pixi's context scales the translation too.
      if (path) this.cards.context.save().setTransform(0.75, 0, 0, 0.75, typeX - 15, box.y + 5).path(path).stroke({ color: muted, width: iconStroke / 0.75, alpha: textAlpha }).restore()
      let tagRight = typeX - 24
      const tag = (key: string, text: string, color: string) => {
        const style = styled(this.styles.small, color), width = this.measure(text, style) + 10
        tagRight -= width
        this.cards.roundRect(tagRight, box.y + 6, width, 15, 3).fill({ color: colors.background }).stroke({ color, width: 1, alpha: 0.7 })
        label(key, text, tagRight + 5, box.y + 7, style, color)
        tagRight -= 6
      }
      if (node.changed) tag(`changed:${at}`, 'changed', colors.accent)
      if (node.never) tag(`never:${at}`, 'Never runs', colors.warning)
      const titleStyle = styled(this.styles.title, strong)
      label(`name:${at}`, this.fitText(node.name || 'Unnamed step', Math.max(20, tagRight - (box.x + 32)), titleStyle), box.x + 32, box.y + 5, titleStyle, strong)
      let right = box.x + box.width - 10
      for (const [index, part] of [...node.right ?? []].reverse().entries()) {
        const style = styled(this.styles.small, this.tone(part.tone)), width = this.measure(part.text, style)
        right -= width
        label(`right:${at}:${index}`, part.text, right, box.y + 27, style, this.tone(part.tone))
        right -= 8
      }
      const subStyle = styled(this.styles.small, muted)
      label(`sub:${at}`, this.fitText(node.sub, Math.max(20, right - (box.x + 32)), subStyle), box.x + 32, box.y + 27, subStyle, muted)
      // Ports: ✓ on success, ✗ on failure, each with its glyph so colour is never the only cue.
      const [ok, bad] = layout.ports[at]!
      for (const [[px, py], which] of [[ok, 'success'], [bad, 'fail']] as const) {
        const color = which === 'success' ? colors.success : colors.error
        this.cards.circle(px, py, portRadius).fill(colors.background).stroke({ color, width: 1, alpha })
        if (which === 'success') this.cards.moveTo(px - 3, py).lineTo(px - 1, py + 2).lineTo(px + 3, py - 2).stroke({ color, width: 1.5, alpha })
        else this.cards.moveTo(px - 2.5, py - 2.5).lineTo(px + 2.5, py + 2.5).moveTo(px + 2.5, py - 2.5).lineTo(px - 2.5, py + 2.5).stroke({ color, width: 1.5, alpha })
      }
    })
    // A connect drag: a line from the port to the pointer, the step under it outlined.
    if (this.connecting) {
      const [px, py] = layout.ports[this.connecting.from]![this.connecting.which === 'success' ? 0 : 1]
      this.polyline(this.front, [[px, py + portRadius], [this.connecting.x, this.connecting.y]], true)
      this.front.stroke({ color: colors.accent, width: 1.5 })
    }
    if (this.pool.end()) TexturePool.clear(true)
    this.app.render()
    this.pruneTextCache()
    void flow
  }
  private readonly toned = new Map<string, TextStyle>()
  /** Each chip's box: past the lanes on its edge's side, one after another; a straight edge's or a Quit's beside its port, clear of the pill. */
  private chipBoxes(): ChipBox[] {
    const { layout, chips } = this.options.model
    const used = new Map<string, number>(), boxes: ChipBox[] = []
    for (const chip of chips) {
      const item = layout.edges.find(edge => flowEdgeKey(edge.edge.from, edge.edge.which) === chip.edge)
      if (!item) continue
      const right = item.edge.which === 'fail', color = this.tone(chip.tone ?? 'muted')
      const style = this.styled(this.styles.small, color), width = this.measure(chip.text, style) + 12
      const before = used.get(chip.edge) ?? 0
      used.set(chip.edge, before + width + 4)
      const pilled = item.points.length === 0, gap = item.lane !== undefined ? 8 : pilled ? 44 : 10
      const anchor = item.lane !== undefined ? (right ? layout.chipRight : layout.chipLeft) : item.mid[0] - (pilled ? 0 : 13)
      boxes.push({ chip, x: right ? anchor + gap + before : anchor - gap - before - width, y: item.mid[1] + (pilled ? 10 : 0) - 8, width, style, color })
    }
    return boxes
  }
  // Every text style is shared by its sprites, so a sprite's fill is set on a style of its own: one per tone.
  private styled(base: TextStyle, fill: string): TextStyle {
    const key = `${base.fontSize}:${base.fontWeight}:${fill}`
    let style = this.toned.get(key)
    if (!style) { style = base.clone(); style.fill = fill; this.toned.set(key, style) }
    return style
  }
  /** A step that never runs: a dashed outline. */
  private polylineRect(graphics: Graphics, x: number, y: number, width: number, height: number, color: string): void {
    this.polyline(graphics, [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]], true)
    graphics.stroke({ color, width: 1 })
  }
  /** Pixi 8 keeps a null entry for every released text/style/resolution key, so each zoom step would otherwise leave one behind
   *  until disposal (the plan canvas does the same). Its lookups treat a missing key like a null one. */
  private pruneTextCache(): void {
    const cache = (this.app.renderer as unknown as { canvasText?: { _activeTextures?: Record<string, unknown> | null } }).canvasText?._activeTextures
    if (cache) for (const key in cache) if (cache[key] === null) delete cache[key]
  }
  dispose(): void {
    this.disposed = true; this.cancelFrame(); this.adoption.dispose(); this.size.dispose(); this.visibility.dispose()
    const root = this.options.root
    root.removeEventListener('wheel', this.wheel); root.removeEventListener('pointerdown', this.down); root.removeEventListener('pointermove', this.move)
    root.removeEventListener('pointerup', this.up); root.removeEventListener('pointercancel', this.cancel); root.removeEventListener('lostpointercapture', this.cancel)
    root.removeEventListener('pointerleave', this.leave); root.removeEventListener('dblclick', this.doubleClick)
    this.ownerDocument.removeEventListener('visibilitychange', this.visibilityChanged)
    this.pixelRatioQuery?.removeEventListener('change', this.pixelRatioChanged)
    this.pool.dispose(); this.fitted.clear()
    if (this.ready) { this.app.canvas.removeEventListener('webglcontextlost', this.contextLost); this.app.destroy(true, { children: true, texture: true, textureSource: true }) }
    TexturePool.clear(true)
    for (const style of [...Object.values(this.styles), ...this.toned.values()]) style.destroy()
    this.toned.clear()
  }
}
