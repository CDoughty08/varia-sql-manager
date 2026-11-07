// Pixi's interpreter replaces generated functions, retaining the application's strict CSP.
import 'pixi.js/unsafe-eval'
import { Application, CanvasTextMetrics, Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { PlanStatement } from '../../../shared/plans'
import { radii, typeScale } from '../../../shared/theme/metrics'
import type { Disposable } from '../core/types'
import { observeIntersection, observeResize, windowOf, windows } from '../core/windows'
import { uiFontFamily } from '../fonts'
import { SpatialIndex, fit, intersects, viewport, zoomAt, type Camera, type PlanLayout, type PlacedNode, type PlacedEdge, type Rect } from './geometry'

export interface CanvasColors { background: string; card: string; text: string; muted: string; border: string; accent: string; warning: string }
export interface HoveredOperator { id: string; anchor: Rect }
export interface CanvasOptions {
  root: HTMLElement; statements: readonly PlanStatement[]; layout: PlanLayout; camera?: Camera; colors: CanvasColors
  select(id: string): void; cameraChanged(camera: Camera): void; failed(): void
  hover(operator: HoveredOperator | undefined): void
}
const hoverDelayMs = 180
const hoverExitMs = 160
const rowCountFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
export class PlanCanvas {
  private readonly app = new Application()
  private readonly world = new Container()
  private readonly edges = new Graphics()
  private readonly cards = new Graphics()
  private readonly labels = new Container()
  private readonly pool: Text[] = []
  private readonly textStyle = new TextStyle({ fontFamily: uiFontFamily, fontSize: typeScale.sm.size, fontWeight: '600' })
  private readonly mutedStyle = new TextStyle({ fontFamily: uiFontFamily, fontSize: typeScale.sm.size })
  private readonly fittedLabels = new Map<string, string>()
  private readonly index: SpatialIndex<PlacedNode>
  private readonly edgeIndex: SpatialIndex<PlacedEdge>
  private readonly placed: Map<string, PlacedNode>
  private camera: Camera
  private selected = ''
  private frame = 0
  private ready = false
  private disposed = false
  private visible = true
  private width = 1
  private height = 1
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>()
  private dragMoved = false
  private hovered?: PlacedNode
  private hoverDelay?: ReturnType<typeof setTimeout>
  private hoverExit?: ReturnType<typeof setTimeout>
  private readonly size: Disposable
  private readonly visibility: Disposable
  private readonly adoption: Disposable
  private owner: Window
  private ownerDocument: Document
  constructor(private readonly options: CanvasOptions) {
    this.index = new SpatialIndex(options.layout.nodes)
    this.placed = new Map(options.layout.nodes.map(node => [node.id, node]))
    this.edgeIndex = new SpatialIndex(options.layout.edges)
    this.camera = options.camera ?? { x: 0, y: 0, scale: 1 }
    this.owner = windowOf(options.root)
    this.ownerDocument = options.root.ownerDocument
    this.ownerDocument.addEventListener('visibilitychange', this.visibilityChanged)
    this.adoption = windows.onDidAdopt(() => {
      const document = options.root.ownerDocument
      if (this.ownerDocument === document) return
      this.cancelFrame()
      this.dismissHover()
      this.ownerDocument.removeEventListener('visibilitychange', this.visibilityChanged)
      this.owner = windowOf(options.root)
      this.ownerDocument = document
      document.addEventListener('visibilitychange', this.visibilityChanged)
    })
    this.size = observeResize(options.root, () => this.resize())
    this.visibility = observeIntersection(options.root, entries => {
      this.visible = entries.some(entry => entry.isIntersecting)
      if (this.visible) this.resize()
      else { this.dismissHover(); this.cancelFrame() }
    })
    options.root.addEventListener('wheel', this.wheel, { passive: false })
    options.root.addEventListener('pointerdown', this.down)
    options.root.addEventListener('pointermove', this.move)
    options.root.addEventListener('pointerleave', this.leaveHover)
    options.root.addEventListener('pointerup', this.up)
    options.root.addEventListener('pointercancel', this.cancelDrag)
    options.root.addEventListener('lostpointercapture', this.cancelDrag)
    void this.initialize()
  }
  private async initialize(): Promise<void> {
    try {
      await this.app.init({ preference: 'webgl', autoStart: false, sharedTicker: false, antialias: true, backgroundAlpha: 0,
        resolution: Math.min(this.owner.devicePixelRatio || 1, 2), autoDensity: true })
      this.ready = true
      if (this.disposed) { this.app.destroy(true, { children: true }); return }
      this.app.canvas.setAttribute('aria-hidden', 'true')
      this.app.canvas.addEventListener('webglcontextlost', this.contextLost)
      this.options.root.append(this.app.canvas)
      this.world.addChild(this.edges, this.cards, this.labels)
      this.app.stage.addChild(this.world)
      this.resize()
      if (!this.options.camera) this.fit()
    } catch {
      try { this.app.destroy(true, { children: true }) } catch { /* Initialization may have failed before a renderer exists. */ }
      this.ready = false
      if (!this.disposed) this.options.failed()
    }
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.dismissHover(); this.cancelFrame(); this.options.failed() }
  private visibilityChanged = () => {
    if (this.ownerDocument.hidden) { this.dismissHover(); this.cancelFrame() }
    else this.invalidate()
  }
  private resize(): void {
    if (this.disposed || !this.ready) return
    this.dismissHover()
    this.width = Math.max(1, this.options.root.clientWidth)
    this.height = Math.max(1, this.options.root.clientHeight)
    this.app.renderer.resize(this.width, this.height, Math.min(this.owner.devicePixelRatio || 1, 2))
    this.invalidate()
  }
  private cancelFrame(): void { if (this.frame) this.owner.cancelAnimationFrame(this.frame); this.frame = 0 }
  private invalidate(): void {
    if (!this.frame && this.ready && !this.disposed && this.visible && !this.ownerDocument.hidden) this.frame = this.owner.requestAnimationFrame(() => { this.frame = 0; this.draw() })
  }
  private setCamera(camera: Camera): void {
    this.dismissHover()
    this.camera = camera
    this.options.cameraChanged({ ...camera })
    this.invalidate()
  }
  fit(statement?: number): void {
    const bounds = statement === undefined ? this.options.layout.bounds : this.options.layout.statements[statement] ?? this.options.layout.bounds
    this.setCamera(fit(bounds, this.width, this.height))
  }
  zoom(factor: number): void { this.setCamera(zoomAt(this.camera, this.width / 2, this.height / 2, factor)) }
  actualSize(): void { this.zoom(1 / this.camera.scale) }
  select(id: string, reveal = false): void {
    this.selected = id
    const node = this.placed.get(id)
    const area = viewport(this.camera, this.width, this.height)
    if (reveal && node && (node.x < area.x || node.y < area.y || node.x + node.width > area.x + area.width || node.y + node.height > area.y + area.height))
      this.setCamera({ scale: this.camera.scale, x: this.width / 2 - (node.x + node.width / 2) * this.camera.scale, y: this.height / 2 - (node.y + node.height / 2) * this.camera.scale })
    this.invalidate()
  }
  colors(colors: CanvasColors): void { this.options.colors = colors; this.invalidate() }
  update(statements: readonly PlanStatement[]): void { this.options.statements = statements; if (this.fittedLabels.size > 4000) this.fittedLabels.clear(); this.invalidate() }
  private wheel = (event: WheelEvent) => {
    event.preventDefault()
    const bounds = this.options.root.getBoundingClientRect()
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1
    if (event.ctrlKey || event.metaKey) this.setCamera(zoomAt(this.camera, event.clientX - bounds.left, event.clientY - bounds.top, Math.exp(-event.deltaY * multiplier * 0.005)))
    else this.setCamera({ ...this.camera, x: this.camera.x - (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * multiplier, y: this.camera.y - (event.shiftKey ? 0 : event.deltaY) * multiplier })
  }
  private down = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    const first = this.pointers.values().next().value
    if (this.pointers.size === 2 || first && (first.type !== 'touch' || event.pointerType !== 'touch')) return
    event.preventDefault()
    this.dismissHover()
    if (!first) this.options.root.focus({ preventScroll: true })
    this.dragMoved = !!first
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType })
    this.options.root.setPointerCapture(event.pointerId)
  }
  private move = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId)
    if (!pointer) {
      if (!this.pointers.size && this.ready && this.visible && !event.buttons && event.pointerType !== 'touch') this.hoverNode(this.hit(event))
      return
    }
    const x = event.clientX, y = event.clientY
    const dx = x - pointer.x, dy = y - pointer.y
    if (this.pointers.size === 2) {
      const [first, second] = this.pointers.values()
      const other = first === pointer ? second : first
      const bounds = this.options.root.getBoundingClientRect()
      const before = Math.max(1, Math.hypot(pointer.x - other.x, pointer.y - other.y))
      const after = Math.max(1, Math.hypot(x - other.x, y - other.y))
      // Keep the world point under the fingers' midpoint as the gesture pans and scales.
      const camera = zoomAt(this.camera, (pointer.x + other.x) / 2 - bounds.left, (pointer.y + other.y) / 2 - bounds.top, after / before)
      this.setCamera({ ...camera, x: camera.x + dx / 2, y: camera.y + dy / 2 })
    } else {
      if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true
      if (this.dragMoved) this.setCamera({ ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy })
    }
    pointer.x = x
    pointer.y = y
  }
  private up = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return
    if (this.options.root.hasPointerCapture(event.pointerId)) this.options.root.releasePointerCapture(event.pointerId)
    if (this.dragMoved) return
    const node = this.hit(event)
    if (node) this.options.select(node.id)
  }
  private cancelDrag = (event: PointerEvent) => { this.pointers.delete(event.pointerId) }
  private hit(event: PointerEvent): PlacedNode | undefined {
    const rect = this.options.root.getBoundingClientRect()
    const x = (event.clientX - rect.left - this.camera.x) / this.camera.scale
    const y = (event.clientY - rect.top - this.camera.y) / this.camera.scale
    return this.index.query({ x, y, width: 0, height: 0 }).at(-1)
  }
  private hoverNode(node: PlacedNode | undefined): void {
    if (!node) { this.leaveHover(); return }
    this.holdHover()
    if (this.hovered === node) return
    this.dismissHover()
    this.hovered = node
    this.options.root.toggleAttribute('data-operator-hover', true)
    this.invalidate()
    this.hoverDelay = setTimeout(() => {
      this.hoverDelay = undefined
      const box = this.options.root.getBoundingClientRect()
      const { x, y, scale } = this.camera
      const left = box.left + x + node.x * scale, top = box.top + y + node.y * scale
      const visibleLeft = Math.max(box.left, left), visibleTop = Math.max(box.top, top)
      this.options.hover({ id: node.id, anchor: {
        x: visibleLeft, y: visibleTop,
        width: Math.max(0, Math.min(box.right, left + node.width * scale) - visibleLeft),
        height: Math.max(0, Math.min(box.bottom, top + node.height * scale) - visibleTop)
      } })
    }, hoverDelayMs)
  }
  /** Give the pointer time to cross the gap from a node to its statistics. */
  leaveHover = () => {
    if (!this.hovered) return
    if (this.hoverDelay !== undefined) { this.dismissHover(); return }
    this.hoverExit ??= setTimeout(this.dismissHover, hoverExitMs)
  }
  holdHover(): void {
    clearTimeout(this.hoverExit)
    this.hoverExit = undefined
  }
  dismissHover = () => {
    this.holdHover()
    clearTimeout(this.hoverDelay)
    this.hoverDelay = undefined
    if (!this.hovered) return
    this.hovered = undefined
    this.options.root.removeAttribute('data-operator-hover')
    this.options.hover(undefined)
    this.invalidate()
  }
  private fitLabel(text: string, width: number, style: TextStyle, keepEnd = false): string {
    const key = `${style.fontWeight}:${width}:${keepEnd}:${text}`
    const cached = this.fittedLabels.get(key)
    if (cached !== undefined) return cached
    let fitted = text.replace(/\s+/g, ' ').trim()
    if (CanvasTextMetrics.measureText(fitted, style).width > width) {
      const characters = Array.from(fitted)
      const shortened = (length: number) => keepEnd ? '…' + characters.slice(characters.length - length).join('') : characters.slice(0, length).join('') + '…'
      let low = 0, high = characters.length - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (CanvasTextMetrics.measureText(shortened(middle), style).width <= width) low = middle
        else high = middle - 1
      }
      fitted = shortened(low)
    }
    if (this.fittedLabels.size >= 2048) this.fittedLabels.delete(this.fittedLabels.keys().next().value!)
    this.fittedLabels.set(key, fitted)
    return fitted
  }
  private draw(): void {
    const colors = this.options.colors, area = viewport(this.camera, this.width, this.height)
    if (this.textStyle.fill !== colors.text) this.textStyle.fill = colors.text
    if (this.mutedStyle.fill !== colors.muted) this.mutedStyle.fill = colors.muted
    this.world.position.set(this.camera.x, this.camera.y)
    this.world.scale.set(this.camera.scale)
    this.edges.clear(); this.cards.clear()
    let used = 0
    const label = (text: string, x: number, y: number, muted = false) => {
      let sprite = this.pool[used]
      const style = muted ? this.mutedStyle : this.textStyle
      if (!sprite) { sprite = new Text({ text, style }); this.pool.push(sprite); this.labels.addChild(sprite) }
      else { if (sprite.text !== text) sprite.text = text; if (sprite.style !== style) sprite.style = style }
      sprite.position.set(x, y); sprite.visible = true; used++
    }
    for (const section of this.options.layout.statements) {
      if (!intersects(section, area)) continue
      this.cards.rect(section.x, section.y, section.width, section.height).stroke({ color: colors.border, width: 1 })
      if (this.camera.scale >= 0.3) {
        const statement = this.options.statements[section.index]
        const heading = `Statement ${section.index + 1} · ${statement.type} · ${statement.nodes.length} ${statement.nodes.length === 1 ? 'operator' : 'operators'}`
        label(this.fitLabel(heading, section.width - 20, this.mutedStyle), section.x + 10, section.y + 7, true)
      }
    }
    for (const edge of this.edgeIndex.query(area)) {
      const [start, next] = edge.points
      if (!start || !next) continue
      this.edges.moveTo(start.x, start.y)
      for (const point of edge.points.slice(1)) this.edges.lineTo(point.x, point.y)
      this.edges.stroke({ color: colors.muted, width: 1.5 })
      const angle = Math.atan2(next.y - start.y, next.x - start.x), dx = Math.cos(angle), dy = Math.sin(angle)
      this.edges.moveTo(start.x + dx * 6 - dy * 4, start.y + dy * 6 + dx * 4).lineTo(start.x, start.y)
        .lineTo(start.x + dx * 6 + dy * 4, start.y + dy * 6 - dx * 4).stroke({ color: colors.muted, width: 1.5 })
    }
    for (const placed of this.index.query(area)) {
      const node = this.options.statements[placed.statement].nodes[placed.index]
      const selected = placed.id === this.selected
      const highlighted = selected || placed === this.hovered || node.liveActivity
      const stroke = highlighted ? colors.accent : node.warnings.length ? colors.warning : colors.border
      this.cards.roundRect(placed.x, placed.y, placed.width, placed.height, radii.sm.px).fill(colors.card).stroke({ color: stroke, width: highlighted ? 2 : 1 })
      if (this.camera.scale < 0.35) continue
      const labelWidth = placed.width - 20
      label(this.fitLabel(node.physicalOp, labelWidth, this.textStyle), placed.x + 10, placed.y + 8)
      if (this.camera.scale < 0.55) continue
      const rows = node.actualRows ?? node.estimatedRows
      const caption = node.actualRows !== null ? `Rows ${rowCountFormat.format(node.actualRows)}` : node.object || (rows === null ? node.logicalOp : `Est. rows ${rowCountFormat.format(rows)}`)
      if (caption) label(this.fitLabel(caption, labelWidth, this.mutedStyle, !!node.object), placed.x + 10, placed.y + 28, true)
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].visible = false
    this.app.render()
  }
  dispose(): void {
    this.disposed = true; this.dismissHover(); this.cancelFrame(); this.adoption.dispose(); this.size.dispose(); this.visibility.dispose()
    const root = this.options.root
    root.removeEventListener('wheel', this.wheel); root.removeEventListener('pointerdown', this.down); root.removeEventListener('pointermove', this.move)
    root.removeEventListener('pointerup', this.up); root.removeEventListener('pointercancel', this.cancelDrag); root.removeEventListener('lostpointercapture', this.cancelDrag)
    root.removeEventListener('pointerleave', this.leaveHover)
    this.ownerDocument.removeEventListener('visibilitychange', this.visibilityChanged)
    if (this.ready) { this.app.canvas.removeEventListener('webglcontextlost', this.contextLost); this.app.destroy(true, { children: true, texture: true, textureSource: true }) }
  }
}
