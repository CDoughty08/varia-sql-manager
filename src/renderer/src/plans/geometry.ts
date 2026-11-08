export interface Rect { x: number; y: number; width: number; height: number }
export interface Camera { x: number; y: number; scale: number }
export interface PlacedNode extends Rect { id: string; statement: number; index: number }
export interface PlacedStatement extends Rect { index: number }
export interface PlacedEdge extends Rect { points: { x: number; y: number }[]; childId?: string; statement?: number; index?: number }
export interface PlanLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; statements: PlacedStatement[]; bounds: Rect }
export const card = { width: 192, height: 52, gap: 18, padding: 12, heading: 30, layerGap: 112, nodeGap: 16 } as const
export const intersects = (a: Rect, b: Rect): boolean => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
export function union(items: readonly Rect[]): Rect {
  if (!items.length) return { x: 0, y: 0, width: 1, height: 1 }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const item of items) { x = Math.min(x, item.x); y = Math.min(y, item.y); right = Math.max(right, item.x + item.width); bottom = Math.max(bottom, item.y + item.height) }
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}
export function fit(rect: Rect, width: number, height: number): Camera {
  const scale = Math.max(0.00001, Math.min(1, (width - 48) / Math.max(1, rect.width), (height - 48) / Math.max(1, rect.height)))
  return { scale, x: (width - rect.width * scale) / 2 - rect.x * scale, y: (height - rect.height * scale) / 2 - rect.y * scale }
}
export function zoomAt(camera: Camera, x: number, y: number, factor: number): Camera {
  const scale = Math.max(0.00001, Math.min(3, camera.scale * factor)), ratio = scale / camera.scale
  return { scale, x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio }
}
export function viewport(camera: Camera, width: number, height: number): Rect {
  return { x: -camera.x / camera.scale, y: -camera.y / camera.scale, width: width / camera.scale, height: height / camera.scale }
}
/** Static bounding volume tree: edges as well as cards can be found without scanning the whole batch on every frame. */
export class SpatialIndex<T extends Rect> {
  private readonly bounds: Rect
  private readonly items?: readonly T[]
  private readonly children?: readonly SpatialIndex<T>[]
  constructor(items: readonly T[]) {
    this.bounds = union(items)
    if (items.length <= 12) this.items = items
    else {
      const horizontal = this.bounds.width > this.bounds.height
      const sorted = [...items].sort((a, b) => horizontal ? a.x + a.width / 2 - b.x - b.width / 2 : a.y + a.height / 2 - b.y - b.height / 2)
      const middle = Math.floor(sorted.length / 2)
      this.children = [new SpatialIndex(sorted.slice(0, middle)), new SpatialIndex(sorted.slice(middle))]
    }
  }
  query(rect: Rect, into: T[] = []): T[] {
    if (!intersects(this.bounds, rect)) return into
    if (this.items) for (const item of this.items) { if (intersects(item, rect)) into.push(item) }
    else for (const child of this.children ?? []) child.query(rect, into)
    return into
  }
}
