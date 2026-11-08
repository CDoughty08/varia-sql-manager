import { positionToDirection, type DockviewApi, type DockviewGroupPanel, type IDockviewPanel, type Position, type PositionResolver, type PositionResolverArgs } from 'dockview-react'
import type { GestureEvent, GestureService } from './core/gestures'

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
  /** The pointer, and whether Float While Dragging's modifier is held (the drag then floats instead of docking). */
  private point = { x: 0, y: 0, float: false }
  /** The pointer on screen, for a panel dragged out of the window into a window of its own. */
  private screen = { x: 0, y: 0 }
  /** A popout tab dragged over the window (the browser's drag): the compass shows for it, without a Dockview source. */
  private external = false
  private dropped = false
  private movingFloat = false
  private moved = false
  private startPoint = { x: 0, y: 0 }
  private pointerId?: number
  private pendingEnd?: ReturnType<typeof setTimeout>
  private disposed = false
  private disposables: { dispose(): void }[] = []
  constructor(private api: DockviewApi, private root: HTMLElement, private beforeFloat: (ids: string[]) => void, private failed: (error: unknown) => void, private gestures: GestureService,
    /** Moves the dragged panels into a new window at a screen point; false when they cannot go (the query editor). */
    private popOut: (ids: string[], at: { x: number; y: number }) => boolean = () => false,
    private dragEnded: () => void = () => {}) {
    this.layer.className = 'docking-guides'; this.layer.hidden = true; this.layer.setAttribute('aria-hidden', 'true')
    this.preview.className = 'docking-preview'; this.preview.hidden = true
    this.compass.className = 'docking-compass'
    this.layer.append(this.preview, this.compass); document.body.append(this.layer)
    this.disposables.push(api.onWillDragPanel(event => this.start(event.panel, event.nativeEvent)),
      api.onWillDragGroup(event => this.start(event.group, event.nativeEvent)),
      api.onWillShowOverlay(event => {
        if ((!this.source && event.nativeEvent instanceof PointerEvent) || this.floats(event.nativeEvent)) { event.preventDefault(); return }
        const hit = this.hit(event.nativeEvent.clientX, event.nativeEvent.clientY)
        const guided = this.source && (hit || event.kind === 'content' || event.kind === 'edge')
        if (guided && (!hit || event.position !== hit.position || (hit.edge ? !event.edge : event.group !== this.target || event.kind !== 'content'))) event.preventDefault()
      }),
      api.onWillDrop(event => {
        if ((!this.source && event.nativeEvent instanceof PointerEvent) || this.floats(event.nativeEvent)) event.preventDefault()
        else {
          const hit = this.hit(event.nativeEvent.clientX, event.nativeEvent.clientY)
          const guided = this.source && (hit || event.kind === 'content' || event.kind === 'edge')
          // A floating source can cover the compass's destination. Do not let its content or tab strip steal the drop.
          if (guided && (!hit || event.position !== hit.position || (hit.edge ? event.kind !== 'edge' : event.group !== this.target || event.kind !== 'content'))) event.preventDefault()
          else this.dropped = true
        }
      }))
    window.addEventListener('pointermove', this.move, true)
    root.addEventListener('pointerdown', this.floatDown, true)
    window.addEventListener('pointerup', this.end, true)
    window.addEventListener('pointercancel', this.pointerCancelled, true)
    document.addEventListener('keydown', this.key, true)
    document.addEventListener('keyup', this.key, true)
    window.addEventListener('blur', this.cancel)
  }
  private start(source: IDockviewPanel | DockviewGroupPanel, event: PointerEvent | DragEvent) {
    this.cancel()
    this.source = source
    this.pointerId = 'pointerId' in event ? event.pointerId : undefined
    this.sourceIds = new Set('panels' in source ? source.panels.map(panel => panel.id) : [source.id])
    this.dropped = false
    this.movingFloat = false; this.moved = true
    this.point = { x: event.clientX, y: event.clientY, float: this.gestures.matches('dock.floatWhileDragging', event) }
    this.screen = { x: event.screenX, y: event.screenY }
    this.refresh()
  }
  private hit(x: number, y: number) { return this.cells.find(({ cell }) => contains(cell, x, y))?.cell }
  private owns(event: PointerEvent) { return this.pointerId === undefined || event.pointerId === this.pointerId }
  private pointerCancelled = (event: PointerEvent) => { if (this.owns(event)) this.cancel() }
  private floats(event: GestureEvent): boolean { return this.gestures.matches('dock.floatWhileDragging', event) || this.point.float }
  private floatDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.gestures.matches('dock.dragFloatingTitleBar', event) || !(event.target instanceof Element) || !event.target.closest('.dv-floating-titlebar')) return
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
    if (!this.source || !this.owns(event) || this.pendingEnd !== undefined) return
    // Recover if the release happened outside the page and never reached our listeners.
    if ((event.buttons & 1) === 0) { this.cancel(); return }
    if (this.movingFloat && Math.hypot(event.clientX - this.startPoint.x, event.clientY - this.startPoint.y) > 4) this.moved = true
    this.point = { x: event.clientX, y: event.clientY, float: this.gestures.matches('dock.floatWhileDragging', event) }
    this.screen = { x: event.screenX, y: event.screenY }
    this.refresh()
  }
  private key = (event: KeyboardEvent) => {
    if (!this.source) return
    if (event.key === 'Escape') { this.cancel(); return }
    if (this.pendingEnd !== undefined) return
    if (this.gestures.isModifierKey('dock.floatWhileDragging', event.key)) { this.point.float = event.type === 'keydown'; this.refresh() }
  }
  private refresh() {
    this.preview.hidden = true
    if ((!this.source && !this.external) || !this.moved || this.point.float || !contains(bounds(this.root), this.point.x, this.point.y)) { this.layer.hidden = true; this.cells = []; return }
    const groups = [...this.api.groups].reverse().sort((a, b) => Number(b.api.location.type === 'floating') - Number(a.api.location.type === 'floating'))
    const candidates = groups.filter(group => group.panels.some(panel => !this.sourceIds.has(panel.id)) && group.api.isVisible && contains(bounds(group.element), this.point.x, this.point.y))
    // Floating windows change stacking order when focused; their creation order does not follow it.
    this.target = null
    for (const element of this.root.ownerDocument.elementsFromPoint?.(this.point.x, this.point.y) ?? []) {
      const group = candidates.find(group => group.element.contains(element))
      if (group) { this.target = group; break }
    }
    this.target ??= candidates[0] ?? null
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
    if (!this.source || this.movingFloat || this.floats(args.event)) return null
    const hit = this.hit(args.event.clientX, args.event.clientY)
    if (!hit || !args.zones.has(hit.position)) return null
    // Root targets only resolve workspace cells; content targets resolve local cells.
    const targetLeft = args.event.clientX - args.x, targetTop = args.event.clientY - args.y
    const root = bounds(this.root)
    const isRoot = Math.abs(targetLeft - root.x) < 2 && Math.abs(targetTop - root.y) < 2 && Math.abs(args.width - root.width) < 2
    if (isRoot && !hit.edge) return null
    return { position: hit.position, edge: hit.edge }
  }
  private end = (event: PointerEvent) => {
    if (!this.source || !this.owns(event) || this.pendingEnd !== undefined) return
    // The release can carry the final position even when no move was delivered there.
    this.point = { x: event.clientX, y: event.clientY, float: this.gestures.matches('dock.floatWhileDragging', event) }
    this.screen = { x: event.screenX, y: event.screenY }
    this.refresh()
    const source = this.source, point = { ...this.point }, sourceIds = [...this.sourceIds]
    const hit = !point.float && this.moved ? this.hit(point.x, point.y) : undefined
    const target = this.target, movingFloat = this.movingFloat
    this.layer.hidden = true; this.preview.hidden = true
    // Keep the resolver until Dockview's window-level release commits the drop, but stop refreshing the hidden guides.
    this.pendingEnd = setTimeout(() => {
      if (this.disposed || this.source !== source) return
      try {
        if (movingFloat) {
          this.api.updateOptions({ disableDnd: false })
          this.movingFloat = false
          if (hit && target && 'panels' in source) source.api.moveTo({ group: hit.edge ? undefined : target, position: hit.position })
        } else if (!this.dropped && sourceIds.every(id => this.api.getPanel(id))) {
          if (hit && target) {
            // Dockview may have hit an overlapping source instead. Commit the destination our compass actually showed.
            const group = hit.edge ? this.api.addGroup({ direction: positionToDirection(hit.position) }) : target
            source.api.moveTo({ group, position: hit.edge ? 'center' : hit.position })
            return
          }
          const root = bounds(this.root), view = this.root.ownerDocument.defaultView!
          // Released outside the window: the panels move into a window of their own there, as VS Code's editors do.
          const outside = point.x < 0 || point.y < 0 || point.x > view.innerWidth || point.y > view.innerHeight
          if (outside && this.popOut(sourceIds, this.screen)) return
          this.beforeFloat(sourceIds)
          this.api.addFloatingGroup(source, { x: Math.max(0, point.x - root.x - 80), y: Math.max(0, point.y - root.y - 16), width: 520, height: 360 })
        }
      } catch (error) { this.failed(error) }
      finally { this.cancel() }
    }, 0)
  }
  /** A popout tab dragged over the window at a client point: the compass shows over the panel under it. */
  dragOver(ids: string[], x: number, y: number) {
    this.external = true
    this.sourceIds = new Set(ids)
    this.moved = true
    this.point = { x, y, float: false }
    this.refresh()
  }
  /** Where a popout tab dropped at a client point docks: a compass cell's group and side, or undefined (where it was). */
  dragDrop(x: number, y: number): { group?: DockviewGroupPanel; position: Position } | undefined {
    const hit = this.external ? this.hit(x, y) : undefined, target = this.target
    this.cancel()
    return hit ? { group: hit.edge ? undefined : target ?? undefined, position: hit.position } : undefined
  }
  /** The popout tab's drag left the window, or ended elsewhere. */
  dragLeave() { if (this.external) this.cancel() }
  private cancel = () => {
    const active = !!this.source || this.external
    clearTimeout(this.pendingEnd); this.pendingEnd = undefined
    if (this.movingFloat) this.api.updateOptions({ disableDnd: false })
    this.external = false
    this.pointerId = undefined
    this.source = null; this.cells = []; this.target = null; this.layer.hidden = true; this.preview.hidden = true; this.movingFloat = false
    if (active) this.dragEnded()
  }
  dispose() {
    this.disposed = true; this.cancel(); this.disposables.forEach(value => value.dispose()); this.layer.remove()
    this.root.removeEventListener('pointerdown', this.floatDown, true)
    window.removeEventListener('pointermove', this.move, true); window.removeEventListener('pointerup', this.end, true)
    window.removeEventListener('pointercancel', this.pointerCancelled, true); document.removeEventListener('keydown', this.key, true); document.removeEventListener('keyup', this.key, true)
    window.removeEventListener('blur', this.cancel)
  }
}
