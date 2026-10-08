import { type DockviewApi, type DockviewGroupPanel, type IDockviewPanel, type Position, type PositionResolver, type PositionResolverArgs } from 'dockview-react'

export interface Rect { x: number; y: number; width: number; height: number }
export interface GuideCell extends Rect { position: Position; edge: boolean }
const directions: Position[] = ['top', 'left', 'center', 'right', 'bottom']
const offsets = { top: [0, -1], left: [-1, 0], center: [0, 0], right: [1, 0], bottom: [0, 1] }
export function guideCells(rect: Rect): GuideCell[] {
  const scale = Math.min(1, rect.width / 184, rect.height / 184)
  const size = 32 * scale, step = 36 * scale
  const cells: GuideCell[] = []
  for (const edge of [false, true]) for (const position of directions) {
    if (edge && position === 'center') continue
    const [dx, dy] = offsets[position]
    cells.push({ position, edge, x: rect.x + rect.width / 2 + dx * step * (edge ? 2 : 1) - size / 2,
      y: rect.y + rect.height / 2 + dy * step * (edge ? 2 : 1) - size / 2, width: size, height: size })
  }
  return cells
}
export function contains(rect: Rect, x: number, y: number) { return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height }
export function landingRect(rect: Rect, position: Position): Rect {
  if (position === 'center') return { ...rect }
  const horizontal = position === 'left' || position === 'right'
  return { x: rect.x + (position === 'right' ? rect.width / 2 : 0), y: rect.y + (position === 'bottom' ? rect.height / 2 : 0),
    width: rect.width / (horizontal ? 2 : 1), height: rect.height / (horizontal ? 1 : 2) }
}
function bounds(element: HTMLElement): Rect { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }
function place(element: HTMLElement, rect: Rect) { Object.assign(element.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' }) }
function glyph(position: Position, edge: boolean) {
  const accent = position === 'center' ? '<rect x="6" y="7" width="16" height="14" fill="currentColor" fill-opacity=".25"/>'
    : position === 'left' ? '<rect x="6" y="7" width="7" height="14" fill="currentColor" fill-opacity=".45"/>'
    : position === 'right' ? '<rect x="15" y="7" width="7" height="14" fill="currentColor" fill-opacity=".45"/>'
    : position === 'top' ? '<rect x="6" y="7" width="16" height="6" fill="currentColor" fill-opacity=".45"/>'
    : '<rect x="6" y="15" width="16" height="6" fill="currentColor" fill-opacity=".45"/>'
  return '<svg viewBox="0 0 28 28" aria-hidden="true"><rect x="5.5" y="6.5" width="17" height="15" fill="none" stroke="currentColor"/>' + accent
    + '<path d="M6 10H22" stroke="currentColor"/>' + (edge ? '<path d="M3 3H25V25H3Z" fill="none" stroke="currentColor" stroke-dasharray="2 2"/>' : '') + '</svg>'
}

/** An app-owned SSMS-style compass using Dockview's public drop resolver. */
export class DockingGuides implements PositionResolver {
  private layer = document.createElement('div')
  private preview = document.createElement('div')
  private compass = document.createElement('div')
  private cells: { cell: GuideCell; element: HTMLElement }[] = []
  private source: IDockviewPanel | DockviewGroupPanel | null = null
  private sourceIds = new Set<string>()
  private target: DockviewGroupPanel | null = null
  private point = { x: 0, y: 0, ctrl: false }
  private dropped = false
  private movingFloat = false
  private moved = false
  private startPoint = { x: 0, y: 0 }
  private disposed = false
  private disposables: { dispose(): void }[] = []
  constructor(private api: DockviewApi, private root: HTMLElement, private beforeFloat: (ids: string[]) => void, private failed: (error: unknown) => void) {
    this.layer.className = 'docking-guides'; this.layer.hidden = true; this.layer.setAttribute('aria-hidden', 'true')
    this.preview.className = 'docking-preview'; this.preview.hidden = true
    this.compass.className = 'docking-compass'
    this.layer.append(this.preview, this.compass); document.body.append(this.layer)
    this.disposables.push(api.onWillDragPanel(event => this.start(event.panel, event.nativeEvent)),
      api.onWillDragGroup(event => this.start(event.group, event.nativeEvent)),
      api.onWillShowOverlay(event => { if (event.nativeEvent.ctrlKey || this.point.ctrl) event.preventDefault() }),
      api.onWillDrop(event => {
        if (event.nativeEvent.ctrlKey || this.point.ctrl) event.preventDefault()
        else this.dropped = true
      }))
    document.addEventListener('pointermove', this.move, true)
    root.addEventListener('pointerdown', this.floatDown, true)
    document.addEventListener('pointerup', this.end, true)
    document.addEventListener('pointercancel', this.cancel, true)
    document.addEventListener('keydown', this.key, true)
    document.addEventListener('keyup', this.key, true)
    window.addEventListener('blur', this.cancel)
  }
  private start(source: IDockviewPanel | DockviewGroupPanel, event: PointerEvent | DragEvent) {
    this.source = source
    this.sourceIds = new Set('panels' in source ? source.panels.map(panel => panel.id) : [source.id])
    this.dropped = false
    this.movingFloat = false; this.moved = true
    this.point = { x: event.clientX, y: event.clientY, ctrl: event.ctrlKey }
    this.refresh()
  }
  private floatDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element) || !event.target.closest('.dv-floating-titlebar')) return
    const container = event.target.closest('.dv-resize-container')
    const group = this.api.groups.find(group => container?.contains(group.element))
    if (!group) return
    this.start(group, event); this.movingFloat = true; this.moved = false
    // The library otherwise starts a second group DnD gesture on mouse move,
    // cancelling its floating-window move. Keep one gesture and commit our guide on release.
    this.api.updateOptions({ disableDnd: true })
    this.startPoint = { x: event.clientX, y: event.clientY }; this.layer.hidden = true
  }
  private move = (event: PointerEvent) => {
    if (!this.source) return
    if (this.movingFloat && Math.hypot(event.clientX - this.startPoint.x, event.clientY - this.startPoint.y) > 4) this.moved = true
    this.point = { x: event.clientX, y: event.clientY, ctrl: event.ctrlKey }
    this.refresh()
  }
  private key = (event: KeyboardEvent) => {
    if (!this.source) return
    if (event.key === 'Escape') { this.cancel(); return }
    if (event.key === 'Control') { this.point.ctrl = event.type === 'keydown'; this.refresh() }
  }
  private refresh() {
    this.preview.hidden = true
    if (!this.source || !this.moved || this.point.ctrl || !contains(bounds(this.root), this.point.x, this.point.y)) { this.layer.hidden = true; this.cells = []; return }
    const groups = [...this.api.groups].reverse().sort((a, b) => Number(b.api.location.type === 'floating') - Number(a.api.location.type === 'floating'))
    this.target = groups.find(group => group.panels.some(panel => !this.sourceIds.has(panel.id)) && group.api.isVisible && contains(bounds(group.element), this.point.x, this.point.y)) ?? null
    // Keep the compass attached to the hovered destination, even while crossing its cells.
    if (!this.target) { this.layer.hidden = true; this.cells = []; return }
    this.layer.hidden = false
    const rect = bounds(this.target.element)
    this.cells = guideCells(rect).map(cell => {
      const element = document.createElement('span')
      element.className = 'docking-guide-cell'; element.dataset.guidePosition = cell.position
      element.dataset.guideScope = cell.edge ? 'workspace' : 'panel'
      element.title = cell.position === 'center' ? 'Tab into this panel' : 'Dock ' + cell.position + (cell.edge ? ' of workspace' : ' of panel')
      element.innerHTML = glyph(cell.position, cell.edge); place(element, cell)
      this.compass.append(element)
      return { cell, element }
    })
    // Replace in one operation: the guide never intercepts the pointer drag.
    this.compass.replaceChildren(...this.cells.map(item => item.element))
    const hit = this.cells.find(({ cell }) => contains(cell, this.point.x, this.point.y))
    if (hit) {
      hit.element.classList.add('active')
      place(this.preview, landingRect(hit.cell.edge ? bounds(this.root) : rect, hit.cell.position))
      this.preview.hidden = false
    }
  }
  resolve(args: PositionResolverArgs) {
    if (!this.source || this.movingFloat || args.event.ctrlKey || this.point.ctrl) return null
    const hit = this.cells.find(({ cell }) => contains(cell, args.event.clientX, args.event.clientY))?.cell
    if (!hit || !args.zones.has(hit.position)) return null
    // Root targets only resolve workspace cells; content targets resolve local cells.
    const targetLeft = args.event.clientX - args.x, targetTop = args.event.clientY - args.y
    const root = bounds(this.root)
    const isRoot = Math.abs(targetLeft - root.x) < 2 && Math.abs(targetTop - root.y) < 2 && Math.abs(args.width - root.width) < 2
    if (isRoot && !hit.edge) return null
    return { position: hit.position, edge: hit.edge }
  }
  private end = () => {
    if (!this.source) return
    const source = this.source, point = { ...this.point }, sourceIds = [...this.sourceIds]
    const hit = !point.ctrl && this.moved ? this.cells.find(({ cell }) => contains(cell, point.x, point.y))?.cell : undefined
    const target = this.target, movingFloat = this.movingFloat
    this.layer.hidden = true
    // Let Dockview's window-level pointer-up handler commit a guide/header drop first.
    setTimeout(() => {
      if (this.disposed || this.source !== source) return
      try {
        if (movingFloat) {
          this.api.updateOptions({ disableDnd: false })
          if (hit && target && 'panels' in source) source.api.moveTo({ group: hit.edge ? undefined : target, position: hit.position })
        } else if (!this.dropped && sourceIds.every(id => this.api.getPanel(id))) {
          const root = bounds(this.root)
          this.beforeFloat(sourceIds)
          this.api.addFloatingGroup(source, { x: Math.max(0, point.x - root.x - 80), y: Math.max(0, point.y - root.y - 16), width: 520, height: 360 })
        }
      } catch (error) { this.failed(error) }
      this.source = null; this.cells = []; this.target = null; this.movingFloat = false
    }, 0)
  }
  private cancel = () => {
    if (this.movingFloat) this.api.updateOptions({ disableDnd: false })
    this.source = null; this.cells = []; this.target = null; this.layer.hidden = true; this.movingFloat = false
  }
  dispose() {
    this.disposed = true; this.cancel(); this.disposables.forEach(value => value.dispose()); this.layer.remove()
    this.root.removeEventListener('pointerdown', this.floatDown, true)
    document.removeEventListener('pointermove', this.move, true); document.removeEventListener('pointerup', this.end, true)
    document.removeEventListener('pointercancel', this.cancel, true); document.removeEventListener('keydown', this.key, true); document.removeEventListener('keyup', this.key, true)
    window.removeEventListener('blur', this.cancel)
  }
}
