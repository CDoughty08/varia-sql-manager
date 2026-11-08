// Pixi's interpreter replaces generated functions, retaining the application's strict CSP.
import 'pixi.js/unsafe-eval'
import { Application, CanvasTextMetrics, Container, Graphics, GraphicsPath, Text, TextStyle, TexturePool } from 'pixi.js'
import type { PlanStatement } from '../../../shared/plans'
import { svgIcons, iconStroke } from '../../../shared/icons'
import { radii, typeScale } from '../../../shared/theme/metrics'
import type { Disposable } from '../core/types'
import { observeIntersection, observeResize, windowOf, windows } from '../core/windows'
import { uiFontFamily } from '../fonts'
import { SpatialIndex, fit, intersects, viewport, zoomAt, type Camera, type PlanLayout, type PlacedNode, type PlacedEdge, type Rect } from './geometry'
import { LabelPool } from './labels'
import { operatorIcon, rowFlow, rowFlowMetrics } from './presentation'

export interface CanvasColors { background: string; card: string; text: string; muted: string; border: string; accent: string; warning: string }
export interface HoveredOperator { id: string; anchor: Rect }
export interface CanvasOptions {
  root: HTMLElement; statements: readonly PlanStatement[]; layout: PlanLayout; camera?: Camera; colors: CanvasColors
  select(id: string): void; cameraChanged(camera: Camera): void; failed(): void
  hover(operator: HoveredOperator | undefined): void
  minimap?: boolean; rowFlow?: boolean; collapsed?: ReadonlySet<string>
}
const hoverDelayMs = 180
const hoverExitMs = 160
const iconPaths = new Map(Object.entries(svgIcons).map(([key, icon]) => [key, new GraphicsPath(icon.path)]))
export const minimapSize = { width: 160, height: 96, margin: 12 } as const
export class PlanCanvas {
  private readonly app = new Application()
  private readonly world = new Container()
  private readonly edges = new Graphics()
  private readonly cards = new Graphics()
  private readonly labels = new Container()
  private readonly overview = new Graphics()
  private readonly overviewCamera = new Graphics()
  private readonly overviewCells: { x: number; y: number }[]
  private overviewDirty = true
  private readonly pool = new LabelPool<Text>(() => {
    const sprite = new Text({ text: '', style: this.textStyle })
    this.labels.addChild(sprite)
    return sprite
  }, sprite => { sprite.visible = false }, sprite => sprite.destroy())
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
    const bounds = options.layout.bounds, cells = new Map<number, { x: number; y: number }>()
    // At most 80 × 48 cells. Counter frames never rebuild the overview.
    for (const node of options.layout.nodes) {
      const x = Math.min(79, Math.floor((node.x - bounds.x) / bounds.width * 80)), y = Math.min(47, Math.floor((node.y - bounds.y) / bounds.height * 48))
      cells.set(y * 80 + x, { x: x * 2, y: y * 2 })
    }
    this.overviewCells = [...cells.values()]
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
      this.app.stage.addChild(this.overview, this.overviewCamera)
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
  /** Public camera hook for linked viewers. Values are copied and invalid cameras are ignored. */
  setCamera(camera: Camera, notify = true): void {
    if (![camera.x, camera.y, camera.scale].every(Number.isFinite) || camera.scale <= 0) return
    if (this.camera.x === camera.x && this.camera.y === camera.y && this.camera.scale === camera.scale) return
    this.dismissHover()
    this.camera = { ...camera, scale: Math.max(0.00001, Math.min(3, camera.scale)) }
    if (notify) this.options.cameraChanged({ ...this.camera })
    this.invalidate()
  }
  getCamera(): Camera { return { ...this.camera } }
  /** Apply a linked viewer's camera without echoing it back to the host or fitting over it during initialization. */
  restoreCamera(camera: Camera): void {
    if (![camera.x, camera.y, camera.scale].every(Number.isFinite) || camera.scale <= 0) return
    this.options.camera = { ...camera, scale: Math.max(0.00001, Math.min(3, camera.scale)) }
    this.setCamera(this.options.camera, false)
  }
  pan(x: number, y: number): void { this.setCamera({ ...this.camera, x: this.camera.x + x, y: this.camera.y + y }) }
  navigateMinimap(x: number, y: number): void {
    const bounds = this.options.layout.bounds
    const worldX = bounds.x + Math.max(0, Math.min(1, x / minimapSize.width)) * bounds.width
    const worldY = bounds.y + Math.max(0, Math.min(1, y / minimapSize.height)) * bounds.height
    this.setCamera({ ...this.camera, x: this.width / 2 - worldX * this.camera.scale, y: this.height / 2 - worldY * this.camera.scale })
  }
  preferences(minimap: boolean, flow: boolean, collapsed: ReadonlySet<string>): void { this.options.minimap = minimap; this.options.rowFlow = flow; this.options.collapsed = collapsed; this.invalidate() }
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
  colors(colors: CanvasColors): void { this.options.colors = colors; this.overviewDirty = true; this.invalidate() }
  update(statements: readonly PlanStatement[]): void { this.options.statements = statements; this.invalidate() }
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
    this.pool.begin()
    const label = (key: string, text: string, x: number, y: number, muted = false) => {
      const sprite = this.pool.get(key)
      const style = muted ? this.mutedStyle : this.textStyle
      if (sprite.text !== text) sprite.text = text
      if (sprite.style !== style) sprite.style = style
      sprite.position.set(x, y); sprite.visible = true
    }
    for (const section of this.options.layout.statements) {
      if (!intersects(section, area)) continue
      this.cards.rect(section.x, section.y, section.width, section.height).stroke({ color: colors.border, width: 1 })
      if (this.camera.scale >= 0.3) {
        const statement = this.options.statements[section.index]
        const heading = `Statement ${section.index + 1} · ${statement.type} · ${statement.nodes.length} ${statement.nodes.length === 1 ? 'operator' : 'operators'}`
        label('section:' + statement.id, this.fitLabel(heading, section.width - 20, this.mutedStyle), section.x + 10, section.y + 7, true)
      }
    }
    const showFlowLabels = this.options.rowFlow && this.camera.scale >= 0.75
    // Labels extend above the edge. Broaden only the candidate query, then cull each label itself.
    const edgeArea = showFlowLabels ? { ...area, height: area.height + 18 } : area
    for (const edge of this.edgeIndex.query(edgeArea)) {
      const [start, next] = edge.points
      if (!start || !next) continue
      this.edges.moveTo(start.x, start.y)
      for (const point of edge.points.slice(1)) this.edges.lineTo(point.x, point.y)
      const node = edge.statement === undefined || edge.index === undefined ? undefined : this.options.statements[edge.statement]?.nodes[edge.index]
      const partial = (this.options.statements[edge.statement!] as { partial?: boolean } | undefined)?.partial
      const flow = node ? rowFlowMetrics(node, partial) : undefined
      const color = flow?.kind === 'partial' ? colors.warning : colors.muted
      this.edges.stroke({ color, width: this.options.rowFlow ? flow?.width ?? 1.5 : 1.5, alpha: flow?.kind === 'estimated' ? 0.65 : 1 })
      const angle = Math.atan2(next.y - start.y, next.x - start.x), dx = Math.cos(angle), dy = Math.sin(angle)
      this.edges.moveTo(start.x + dx * 6 - dy * 4, start.y + dy * 6 + dx * 4).lineTo(start.x, start.y)
        .lineTo(start.x + dx * 6 + dy * 4, start.y + dy * 6 - dx * 4).stroke({ color, width: 1.5 })
      if (showFlowLabels && node) {
        const end = edge.points.at(-1)!
        const bounds = { x: end.x - 108, y: end.y - 18, width: 106, height: typeScale.sm.line }
        if (intersects(bounds, area)) label('flow:' + edge.childId, this.fitLabel(rowFlow(node, partial).label, bounds.width, this.mutedStyle), bounds.x, bounds.y, true)
      }
    }
    for (const placed of this.index.query(area)) {
      const node = this.options.statements[placed.statement].nodes[placed.index]
      const selected = placed.id === this.selected
      const highlighted = selected || placed === this.hovered || node.liveActivity
      const stroke = highlighted ? colors.accent : node.warnings.length ? colors.warning : colors.border
      this.cards.roundRect(placed.x, placed.y, placed.width, placed.height, radii.sm.px).fill(colors.card).stroke({ color: stroke, width: highlighted ? 2 : 1 })
      if (this.camera.scale < 0.35) continue
      const labelWidth = placed.width - 38
      this.cards.context.save().translate(placed.x + 8, placed.y + 8).path(iconPaths.get(operatorIcon(node.physicalOp, node.logicalOp))!).stroke({ color: colors.text, width: iconStroke }).restore()
      label(placed.id + ':op', this.fitLabel(node.physicalOp, labelWidth, this.textStyle), placed.x + 30, placed.y + 8)
      if (this.camera.scale < 0.55) continue
      const caption = this.options.collapsed?.has(node.id) ? 'Inputs collapsed' : node.object || rowFlow(node, (this.options.statements[placed.statement] as { partial?: boolean }).partial).label
      if (caption) label(placed.id + ':caption', this.fitLabel(caption, placed.width - 20, this.mutedStyle, !!node.object), placed.x + 10, placed.y + 28, true)
    }
    // Text.destroy returns its managed texture to Pixi's global idle pool. Release that surplus too;
    // clear only touches idle textures, so other canvases' borrowed textures remain valid.
    if (this.pool.end()) TexturePool.clear(true)
    const showOverview = !!this.options.minimap && this.width >= 240 && this.height >= 160
    this.overview.visible = this.overviewCamera.visible = showOverview
    if (showOverview) {
      const { width, height, margin } = minimapSize, x = this.width - width - margin, y = this.height - height - margin
      this.overview.position.set(x, y); this.overviewCamera.position.set(x, y)
      if (this.overviewDirty) {
        this.overview.clear().rect(0, 0, width, height).fill(colors.background).stroke({ color: colors.border, width: 1 })
        for (const cell of this.overviewCells) this.overview.rect(cell.x, cell.y, 2, 2).fill(colors.muted)
        this.overviewDirty = false
      }
      const bounds = this.options.layout.bounds
      const left = Math.max(0, Math.min(width, (area.x - bounds.x) / bounds.width * width)), top = Math.max(0, Math.min(height, (area.y - bounds.y) / bounds.height * height))
      const right = Math.max(0, Math.min(width, (area.x + area.width - bounds.x) / bounds.width * width)), bottom = Math.max(0, Math.min(height, (area.y + area.height - bounds.y) / bounds.height * height))
      this.overviewCamera.clear().rect(left, top, Math.max(1, right - left), Math.max(1, bottom - top)).stroke({ color: colors.accent, width: 2 })
    }
    this.app.render()
  }
  dispose(): void {
    this.disposed = true; this.dismissHover(); this.cancelFrame(); this.adoption.dispose(); this.size.dispose(); this.visibility.dispose()
    const root = this.options.root
    root.removeEventListener('wheel', this.wheel); root.removeEventListener('pointerdown', this.down); root.removeEventListener('pointermove', this.move)
    root.removeEventListener('pointerup', this.up); root.removeEventListener('pointercancel', this.cancelDrag); root.removeEventListener('lostpointercapture', this.cancelDrag)
    root.removeEventListener('pointerleave', this.leaveHover)
    this.ownerDocument.removeEventListener('visibilitychange', this.visibilityChanged)
    this.pool.dispose(); this.fittedLabels.clear()
    if (this.ready) { this.app.canvas.removeEventListener('webglcontextlost', this.contextLost); this.app.destroy(true, { children: true, texture: true, textureSource: true }) }
    TexturePool.clear(true)
    this.textStyle.destroy(); this.mutedStyle.destroy()
  }
}
