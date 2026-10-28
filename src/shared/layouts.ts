import { z } from 'zod'
import type { SerializedDockview } from 'dockview-react'

export const paneIds = ['explorer', 'editor', 'output'] as const
export type PaneId = typeof paneIds[number]
export const paneTitles: Record<PaneId, string> = { explorer: 'Object Explorer', editor: 'Query editor', output: 'Query output' }
export type WorkspaceLayout = SerializedDockview
export interface SavedLayout { id: string; name: string; layout: WorkspaceLayout }
export interface LayoutState { version: 1; current: WorkspaceLayout | null; saved: SavedLayout[] }
export interface LayoutLoad { state: LayoutState; warning?: string }
export const emptyLayoutState = (): LayoutState => ({ version: 1, current: null, saved: [] })
export const maxLayoutFileBytes = 200_000
export const maxLayoutStateBytes = 1_000_000

const dimension = z.number().finite().min(0).max(32_000)
const maximum = dimension.nullish().transform(value => value ?? undefined)
const identifier = z.string().min(1).max(64).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value))
const constraints = z.object({ minimumWidth: dimension.optional(), minimumHeight: dimension.optional(), maximumWidth: maximum, maximumHeight: maximum }).strict()
const groupSchema = z.object({
  id: identifier, views: z.array(z.enum(paneIds)).min(1).max(3), activeView: z.enum(paneIds).optional(),
  hideHeader: z.boolean().optional(), locked: z.union([z.boolean(), z.literal('no-drop-target')]).optional(),
  headerPosition: z.enum(['top', 'bottom', 'left', 'right']).optional(), skipSetActive: z.boolean().optional(),
  constraints: constraints.optional(), initialWidth: dimension.optional(), initialHeight: dimension.optional()
}).strict()
type Group = z.infer<typeof groupSchema>
type Node = { type: 'leaf'; data: Group; size?: number; visible?: boolean } | { type: 'branch'; data: Node[]; size?: number; visible?: boolean }
const nodeSchema: z.ZodType<Node> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('leaf'), data: groupSchema, size: dimension.optional(), visible: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('branch'), data: z.array(nodeSchema).max(3), size: dimension.optional(), visible: z.boolean().optional() }).strict()
]))
const gridSchema = z.object({ root: nodeSchema, width: dimension, height: dimension, orientation: z.enum(['HORIZONTAL', 'VERTICAL']) }).strict()
const panelSchema = z.object({
  id: z.enum(paneIds), contentComponent: z.literal('workbench').default('workbench'), tabComponent: z.literal('props.defaultTabComponent').optional(), title: z.string().max(64).optional(), renderer: z.enum(['always', 'onlyWhenVisible']).default('always'),
  params: z.object({}).strict().optional(), minimumWidth: dimension.optional(), minimumHeight: dimension.optional(), maximumWidth: maximum, maximumHeight: maximum, pinned: z.boolean().optional()
}).strict()
const positionSchema = z.object({ width: dimension.min(1), height: dimension.min(1),
  left: z.number().finite().min(-32_000).max(32_000).optional(), top: z.number().finite().min(-32_000).max(32_000).optional(),
  right: z.number().finite().min(-32_000).max(32_000).optional(), bottom: z.number().finite().min(-32_000).max(32_000).optional()
}).strict().refine(value => (value.left === undefined) !== (value.right === undefined) && (value.top === undefined) !== (value.bottom === undefined), 'A floating panel needs one horizontal and one vertical anchor.')

const layoutSchema = z.object({
  grid: gridSchema, panels: z.object({ explorer: panelSchema.optional(), editor: panelSchema.optional(), output: panelSchema.optional() }).strict(),
  activeGroup: identifier.optional(),
  floatingGroups: z.array(z.object({ data: groupSchema.optional(), grid: gridSchema.optional(), position: positionSchema }).strict()
    .refine(value => (value.data === undefined) !== (value.grid === undefined), 'A floating group needs exactly one layout.')).max(3).optional()
}).strict().superRefine((layout, context) => {
  const seen = new Set<string>()
  const groups = new Set<string>()
  let nodes = 0
  function group(value: Group) {
    if (groups.has(value.id) || (value.activeView && !value.views.includes(value.activeView))) context.addIssue({ code: 'custom', message: 'Invalid panel group.' })
    groups.add(value.id)
    for (const id of value.views) {
      if (seen.has(id)) context.addIssue({ code: 'custom', message: 'A panel is referenced more than once.' })
      seen.add(id)
    }
  }
  function node(value: Node, depth: number) {
    if (++nodes > 16 || depth > 8) { context.addIssue({ code: 'custom', message: 'Layout is too complex.' }); return }
    if (value.type === 'leaf') group(value.data)
    else {
      if (depth > 0 && value.data.length === 0) context.addIssue({ code: 'custom', message: 'An inner split cannot be empty.' })
      value.data.forEach(child => node(child, depth + 1))
    }
  }
  function grid(value: z.infer<typeof gridSchema>) {
    if (value.root.type !== 'branch') context.addIssue({ code: 'custom', message: 'The layout root must be a split.' })
    node(value.root, 0)
  }
  grid(layout.grid)
  for (const floating of layout.floatingGroups ?? []) { if (floating.data) group(floating.data); else grid(floating.grid!) }
  for (const id of paneIds) {
    const panel = layout.panels[id]
    if (seen.has(id) !== !!panel || (panel && panel.id !== id)) context.addIssue({ code: 'custom', path: ['panels', id], message: 'Panel definitions and layout references must agree.' })
    if (panel) { panel.title = paneTitles[id]; panel.renderer = 'always' }
  }
  if (layout.activeGroup && !groups.has(layout.activeGroup)) context.addIssue({ code: 'custom', message: 'Unknown active group.' })
})

// Bound depth before the recursive schema, including IPC objects and imported files.
function bounded(value: unknown, bytes: number) {
  let visited = 0
  function visit(item: unknown, depth: number) {
    if (++visited > 5000 || depth > 32) throw new Error('Layout data is too complex.')
    if (item && typeof item === 'object') Object.values(item).forEach(child => visit(child, depth + 1))
  }
  visit(value, 0)
  if (JSON.stringify(value)?.length > bytes) throw new Error('Layout data exceeds its size limit.')
}
export function parseWorkspaceLayout(value: unknown): WorkspaceLayout {
  bounded(value, maxLayoutFileBytes)
  // Dockview emits optional properties with undefined values; persisted JSON omits them.
  const serialized = JSON.stringify(value)
  const parsed = layoutSchema.safeParse(serialized ? JSON.parse(serialized) : undefined)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error('Invalid or unsupported workspace layout' + (issue.path.length ? ' at ' + issue.path.join('.') : '') + ': ' + issue.message)
  }
  return JSON.parse(JSON.stringify(parsed.data)) as WorkspaceLayout
}
export function parseLayoutState(value: unknown): LayoutState {
  bounded(value, maxLayoutStateBytes)
  const parsed = z.object({ version: z.literal(1), current: z.unknown(), saved: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(64), layout: z.unknown()
  }).strict()).max(20) }).strict().parse(value)
  const ids = new Set<string>(), names = new Set<string>()
  for (const saved of parsed.saved) {
    if (ids.has(saved.id) || names.has(saved.name.toLowerCase())) throw new Error('Saved layout names and IDs must be unique.')
    ids.add(saved.id); names.add(saved.name.toLowerCase())
  }
  return { version: 1, current: parsed.current === null ? null : parseWorkspaceLayout(parsed.current),
    saved: parsed.saved.map(saved => ({ ...saved, layout: parseWorkspaceLayout(saved.layout) })) }
}
export function layoutFile(layout: WorkspaceLayout) { return { kind: 'varia-workspace-layout', version: 1, layout: parseWorkspaceLayout(layout) } }
export function parseLayoutFile(value: unknown): WorkspaceLayout {
  bounded(value, maxLayoutFileBytes)
  const file = z.object({ kind: z.literal('varia-workspace-layout'), version: z.literal(1), layout: z.unknown() }).strict().safeParse(value)
  if (!file.success) throw new Error('Invalid or unsupported Varia layout file.')
  return parseWorkspaceLayout(file.data.layout)
}

/** Whether a dock group hides its header (its tabs): a docked group with one panel does, unless Window › Panel Tabs is on. */
export function hidesHeader(group: { readonly location: string; readonly panels: number }, panelTabs: boolean): boolean {
  return !panelTabs && group.location === 'grid' && group.panels === 1
}
/**
 * The panel a ⋯ menu's Dock Left/Right/Top/Bottom docks `id` beside: the editor (the explorer, for the editor), else any
 * other panel, as long as it is docked in the grid; beside a floating panel the move would split the floating window
 * instead. Undefined when no other panel is docked: `id` then goes to the grid's own edge.
 */
export function dockReference<T extends { readonly id: string; readonly location: string }>(id: PaneId, panels: readonly T[]): T | undefined {
  const docked = panels.filter(panel => panel.id !== id && panel.location === 'grid')
  const preferred = id === 'editor' ? 'explorer' : 'editor'
  return docked.find(panel => panel.id === preferred) ?? docked[0]
}
/**
 * The layout without hidden-header state. Which headers hide follows `hidesHeader`, not the layout, so a saved or exported
 * layout leaves it out and shows the same panels however Panel Tabs is set when it is loaded.
 */
export function withoutHeaderState(layout: WorkspaceLayout): WorkspaceLayout {
  const copy = JSON.parse(JSON.stringify(layout)) as { grid: { root: unknown }; floatingGroups?: { data?: Record<string, unknown>; grid?: { root: unknown } }[] }
  const node = (value: unknown): void => {
    const item = value as { type?: string; data?: unknown }
    if (item?.type === 'leaf' && item.data && typeof item.data === 'object') delete (item.data as Record<string, unknown>).hideHeader
    else if (item?.type === 'branch' && Array.isArray(item.data)) item.data.forEach(node)
  }
  node(copy.grid.root)
  for (const floating of copy.floatingGroups ?? []) { if (floating.data) delete floating.data.hideHeader; if (floating.grid) node(floating.grid.root) }
  return copy as unknown as WorkspaceLayout
}
