import { z } from 'zod'
import type { SerializedDockview } from 'dockview-react'

/**
 * Editor groups (docs/editor-groups.md): the query editor panel holds the open documents in groups, each with its own tab
 * strip and editor, split side by side or floating, as VS Code's editor groups are. Hot exit keeps their arrangement with
 * the documents it keeps, by each document's place in the kept list (`EditorGroupsLayout`): Dockview's own layout names
 * panels by document id, and ids do not outlive the process.
 */
export const editorGroupLimits = {
  /** Groups at once, floating ones included; a split that would make more is refused. */
  groups: 16,
  /** Splits within splits. */
  depth: 8,
  /** Nodes of the grid and of the floating groups together. */
  nodes: 48,
  /** Kept documents (`sessionLimits.documents`), the highest place a group may name. */
  documents: 64
} as const

export type EditorGroupOrientation = 'HORIZONTAL' | 'VERTICAL'
/** A group, its documents by their place in the kept list, in tab order, and the one it shows; or a split of groups. */
export type EditorGroupNode =
  | { readonly type: 'leaf'; readonly views: readonly number[]; readonly active?: number; readonly size?: number }
  | { readonly type: 'branch'; readonly children: readonly EditorGroupNode[]; readonly size?: number }
export interface EditorFloatingGroup {
  readonly root: EditorGroupNode
  /** The direction of the root split, when the floating group is a split of groups. */
  readonly orientation?: EditorGroupOrientation
  readonly position: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
}
/** The editor groups as hot exit keeps them: the grid (its root is a split), floating groups, and the active group. */
export interface EditorGroupsLayout {
  readonly root: EditorGroupNode
  readonly orientation: EditorGroupOrientation
  readonly width: number
  readonly height: number
  readonly floating?: readonly EditorFloatingGroup[]
  /** The active group's place among the groups: the grid's leaves in order, then the floating groups' leaves. */
  readonly activeGroup?: number
}

const dimension = z.number().finite().min(0).max(32_000)
const place = z.int().min(0).max(editorGroupLimits.documents - 1)
const nodeSchema: z.ZodType<EditorGroupNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('leaf'), views: z.array(place).min(1).max(editorGroupLimits.documents), active: place.optional(), size: dimension.optional() }).strict(),
  z.object({ type: z.literal('branch'), children: z.array(nodeSchema).max(editorGroupLimits.nodes), size: dimension.optional() }).strict()
]))
const orientation = z.enum(['HORIZONTAL', 'VERTICAL'])
const coordinate = z.number().finite().min(-32_000).max(32_000)
/** A strict check of a kept layout: limits, each document in one group at most, and an active document the group holds. */
export const editorGroupsLayoutSchema: z.ZodType<EditorGroupsLayout> = z.object({
  root: nodeSchema, orientation, width: dimension, height: dimension,
  floating: z.array(z.object({ root: nodeSchema, orientation: orientation.optional(), position: z.object({ left: coordinate, top: coordinate, width: dimension.min(1), height: dimension.min(1) }).strict() }).strict()).max(editorGroupLimits.groups).optional(),
  activeGroup: z.int().min(0).max(editorGroupLimits.groups - 1).optional()
}).strict().superRefine((layout, context) => {
  const seen = new Set<number>()
  let nodes = 0, groups = 0
  const walk = (node: EditorGroupNode, depth: number) => {
    if (++nodes > editorGroupLimits.nodes || depth > editorGroupLimits.depth) { context.addIssue({ code: 'custom', message: 'The editor groups are too complex.' }); return }
    if (node.type === 'branch') { node.children.forEach(child => walk(child, depth + 1)); return }
    groups++
    if (node.active !== undefined && !node.views.includes(node.active)) context.addIssue({ code: 'custom', message: 'A group shows a document it does not hold.' })
    for (const view of node.views) {
      if (seen.has(view)) context.addIssue({ code: 'custom', message: 'A document is in more than one group.' })
      seen.add(view)
    }
  }
  if (layout.root.type !== 'branch') context.addIssue({ code: 'custom', message: 'The editor grid must be a split.' })
  walk(layout.root, 0)
  for (const floating of layout.floating ?? []) walk(floating.root, 1)
  if (groups > editorGroupLimits.groups) context.addIssue({ code: 'custom', message: 'There are too many editor groups.' })
  if (layout.activeGroup !== undefined && layout.activeGroup >= groups) context.addIssue({ code: 'custom', message: 'The active editor group is missing.' })
})

/** The documents a layout places, by place, in group order. */
export function layoutViews(layout: EditorGroupsLayout): number[] {
  const views: number[] = []
  const walk = (node: EditorGroupNode) => { if (node.type === 'leaf') views.push(...node.views); else node.children.forEach(walk) }
  walk(layout.root)
  for (const floating of layout.floating ?? []) walk(floating.root)
  return views
}

/**
 * The layout with every document moved to `map(place)`, or dropped where it gives undefined (a tab that was not kept, a
 * file that is gone). Groups left empty go, splits left with one child give way to it, and the active group follows its
 * group, or is the first one when its group went. Undefined when no group is left.
 */
export function remapEditorGroups(layout: EditorGroupsLayout, map: (place: number) => number | undefined): EditorGroupsLayout | undefined {
  let index = 0, active: number | undefined, kept = 0
  const flip = (value: EditorGroupOrientation): EditorGroupOrientation => value === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'
  const sized = (value: EditorGroupNode, size: number | undefined): EditorGroupNode => size === undefined ? value : { ...value, size }
  // A split's children; a split left with one split inside gives way to that split's children, which run the same way
  // as its own siblings (Dockview alternates the direction at each depth).
  const children = (value: Extract<EditorGroupNode, { type: 'branch' }>): EditorGroupNode[] => value.children.flatMap(child => {
    const next = node(child)
    if (!next) return []
    if (next.type === 'branch' && next.children.length === 1 && next.children[0].type === 'branch') return next.children[0].children
    return [next]
  })
  const node = (value: EditorGroupNode): EditorGroupNode | undefined => {
    if (value.type === 'leaf') {
      const was = index++
      const views = value.views.map(map).filter((view): view is number => view !== undefined)
      if (!views.length) return undefined
      if (was === layout.activeGroup) active = kept
      kept++
      const shown = value.active === undefined ? undefined : map(value.active)
      return { type: 'leaf', views, ...shown !== undefined && views.includes(shown) ? { active: shown } : {}, ...value.size !== undefined ? { size: value.size } : {} }
    }
    const list = children(value)
    if (list.length === 0) return undefined
    // One group left in a split: the group takes the split's place. One split left is spliced by the parent above.
    if (list.length === 1 && list[0].type === 'leaf') return sized(list[0], value.size)
    return { type: 'branch', children: list, ...value.size !== undefined ? { size: value.size } : {} }
  }
  // The grid's root stays a split; one split inside it becomes the root, turned the other way.
  let orientation = layout.orientation
  let rootChildren = layout.root.type === 'branch' ? children(layout.root) : [node(layout.root)].filter((item): item is EditorGroupNode => !!item)
  if (rootChildren.length === 1 && rootChildren[0].type === 'branch') { rootChildren = [...rootChildren[0].children]; orientation = flip(orientation) }
  const root: EditorGroupNode = { type: 'branch', children: rootChildren }
  const floating = (layout.floating ?? []).flatMap((item): EditorFloatingGroup[] => {
    const next = node(item.root)
    if (!next) return []
    return [next.type === 'leaf' ? { root: next, position: item.position } : { root: next, orientation: item.orientation ?? 'HORIZONTAL', position: item.position }]
  })
  if (!kept) return undefined
  return { root, orientation, width: layout.width, height: layout.height, ...floating.length ? { floating } : {}, activeGroup: active ?? 0 }
}

type DockGrid = SerializedDockview['grid']
type DockNode = DockGrid['root']
interface DockGroup { id: string; views: string[]; activeView?: string }
const isLeaf = (node: DockNode): node is DockNode & { type: 'leaf'; data: DockGroup } => node.type === 'leaf'

/**
 * Dockview's layout of the editor groups as hot exit keeps it: each panel by `place(id)`, panels it gives undefined for
 * (a table designer, a tab past hot exit's caps) left out, and with them groups that held nothing else. Undefined when
 * no group holds a kept document.
 */
export function captureEditorGroups(json: SerializedDockview, place: (id: string) => number | undefined): EditorGroupsLayout | undefined {
  let index = 0, activeGroup: number | undefined
  const group = (data: DockGroup, size?: number): EditorGroupNode => {
    if (data.id === json.activeGroup) activeGroup = index
    index++
    const views = data.views.map(place).filter((view): view is number => view !== undefined)
    const active = data.activeView === undefined ? undefined : place(data.activeView)
    return { type: 'leaf', views, ...active !== undefined ? { active } : {}, ...size !== undefined ? { size } : {} }
  }
  const node = (value: DockNode): EditorGroupNode => isLeaf(value) ? group(value.data, value.size)
    : { type: 'branch', children: (value.data as DockNode[]).map(node), ...value.size !== undefined ? { size: value.size } : {} }
  const position = (box: { left?: number; top?: number; right?: number; bottom?: number; width: number; height: number }) => ({
    left: Math.round(box.left ?? Math.max(0, json.grid.width - (box.right ?? 0) - box.width)), top: Math.round(box.top ?? Math.max(0, json.grid.height - (box.bottom ?? 0) - box.height)),
    width: Math.round(box.width), height: Math.round(box.height)
  })
  // The grid's groups are numbered before the floating ones, as the active group's place counts them.
  const root = node(json.grid.root)
  const floating = (json.floatingGroups ?? []).map(item => {
    const value = item as { data?: DockGroup; grid?: DockGrid; position: Parameters<typeof position>[0] }
    if (value.data) return { root: group(value.data), position: position(value.position) }
    return value.grid ? { root: node(value.grid.root), orientation: value.grid.orientation as EditorGroupOrientation, position: position(value.position) } : undefined
  }).filter((item): item is EditorFloatingGroup => !!item)
  const captured: EditorGroupsLayout = { root, orientation: json.grid.orientation as EditorGroupOrientation, width: json.grid.width, height: json.grid.height,
    ...floating.length ? { floating } : {}, ...activeGroup !== undefined ? { activeGroup } : {} }
  // Pruned through the same rules as a remap, so empty groups go.
  return remapEditorGroups(captured, view => view)
}

/**
 * The Dockview layout for kept groups: each place's document by `id(place)` (places it gives undefined for are left
 * out) and each document's panel as `panel` describes it. Undefined when no group is left.
 */
export function restoreEditorGroups<P extends { id: string }>(layout: EditorGroupsLayout, id: (place: number) => string | undefined, panel: (id: string) => P): SerializedDockview | undefined {
  const ids = new Map<number, string>()
  for (const view of layoutViews(layout)) { const value = id(view); if (value !== undefined) ids.set(view, value) }
  const pruned = remapEditorGroups(layout, view => ids.has(view) ? view : undefined)
  if (!pruned) return undefined
  let index = 0, activeGroup: string | undefined
  const panels: Record<string, P> = {}
  const group = (value: Extract<EditorGroupNode, { type: 'leaf' }>): DockGroup => {
    const groupId = 'g' + (index + 1)
    if (index === pruned.activeGroup) activeGroup = groupId
    index++
    const views = value.views.map(view => ids.get(view)!)
    for (const view of views) panels[view] = panel(view)
    return { id: groupId, views, ...value.active !== undefined ? { activeView: ids.get(value.active)! } : {} }
  }
  const node = (value: EditorGroupNode): DockNode => value.type === 'leaf'
    ? { type: 'leaf', data: group(value), ...value.size !== undefined ? { size: value.size } : {} } as DockNode
    : { type: 'branch', data: value.children.map(node), ...value.size !== undefined ? { size: value.size } : {} } as DockNode
  const root = node(pruned.root)
  const floatingGroups = (pruned.floating ?? []).map(item => item.root.type === 'leaf'
    ? { data: group(item.root), position: item.position }
    : { grid: { root: node(item.root), width: item.position.width, height: item.position.height, orientation: item.orientation ?? 'HORIZONTAL' }, position: item.position })
  return { grid: { root, width: pruned.width, height: pruned.height, orientation: pruned.orientation }, panels, ...activeGroup ? { activeGroup } : {},
    ...floatingGroups.length ? { floatingGroups } : {} } as unknown as SerializedDockview
}
