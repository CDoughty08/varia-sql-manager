import { z } from 'zod'
import type { SerializedDockview } from 'dockview-react'
import { popoutLimits } from './popouts'

export const paneIds = ['explorer', 'editor', 'results', 'messages', 'plan', 'statistics'] as const
export type PaneId = typeof paneIds[number]
/** The panels that show the active query's output; by default they share one group, tabbed, below the editor. */
export const outputPaneIds = ['results', 'messages', 'plan', 'statistics'] as const
export type OutputPaneId = typeof outputPaneIds[number]
export const isOutputPane = (id: string): id is OutputPaneId => (outputPaneIds as readonly string[]).includes(id)
/**
 * Where an output panel goes among a group's tabs (`tabs`, without it): after the output panels that come before it in
 * Results, Messages, Execution plan, else before those that follow it; undefined (last) when the group holds none.
 */
export function outputIndex(id: OutputPaneId, tabs: readonly string[]): number | undefined {
  const order = (tab: string) => (outputPaneIds as readonly string[]).indexOf(tab)
  const before = tabs.reduce((last, tab, index) => isOutputPane(tab) && order(tab) < order(id) ? index : last, -1)
  const after = tabs.findIndex(tab => isOutputPane(tab) && order(tab) > order(id))
  return before >= 0 ? before + 1 : after >= 0 ? after : undefined
}
export const paneTitles: Record<PaneId, string> = { explorer: 'Object Explorer', editor: 'Query editor', results: 'Results', messages: 'Messages', plan: 'Execution plan', statistics: 'Client Statistics' }
/**
 * The panels that can move into a window of their own (Move into New Window). The query editor stays in the main window:
 * Monaco keeps per-document state (its styles, hover and suggest widgets, IME text area and clipboard handling) that it
 * does not move to a second document (docs/popout-windows.md).
 */
export const popoutPaneIds = ['explorer', 'results', 'messages', 'plan', 'statistics'] as const
export type PopoutPaneId = typeof popoutPaneIds[number]
export const canPopOut = (id: string): id is PopoutPaneId => (popoutPaneIds as readonly string[]).includes(id)
/** A popout window: its panels as tabs in order, the one it shows, and where it is on screen (content size, in the page's CSS pixels; main scales them by the zoom). */
export interface PopoutLayout { id: string; panes: PopoutPaneId[]; active: PopoutPaneId; bounds: { x: number; y: number; width: number; height: number } }
/** Dockview's layout of the main window, plus Varia's popout windows (version 3). */
export type WorkspaceLayout = SerializedDockview & { windows?: PopoutLayout[] }
export interface SavedLayout { id: string; name: string; layout: WorkspaceLayout }
/**
 * Version 2 split version 1's one Query output panel (`output`) into Results, Messages and Execution plan; version 3 adds
 * popout windows (`windows`), which version 2 layouts have none of.
 */
export interface LayoutState { version: 3; current: WorkspaceLayout | null; saved: SavedLayout[] }
export interface LayoutLoad { state: LayoutState; warning?: string }
export const emptyLayoutState = (): LayoutState => ({ version: 3, current: null, saved: [] })
export const maxLayoutFileBytes = 200_000
export const maxLayoutStateBytes = 1_000_000

const dimension = z.number().finite().min(0).max(32_000)
const maximum = dimension.nullish().transform(value => value ?? undefined)
const identifier = z.string().min(1).max(64).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value))
const constraints = z.object({ minimumWidth: dimension.optional(), minimumHeight: dimension.optional(), maximumWidth: maximum, maximumHeight: maximum }).strict()
const groupSchema = z.object({
  id: identifier, views: z.array(z.enum(paneIds)).min(1).max(paneIds.length), activeView: z.enum(paneIds).optional(),
  hideHeader: z.boolean().optional(), locked: z.union([z.boolean(), z.literal('no-drop-target')]).optional(),
  headerPosition: z.enum(['top', 'bottom', 'left', 'right']).optional(), skipSetActive: z.boolean().optional(),
  constraints: constraints.optional(), initialWidth: dimension.optional(), initialHeight: dimension.optional()
}).strict()
type Group = z.infer<typeof groupSchema>
type Node = { type: 'leaf'; data: Group; size?: number; visible?: boolean } | { type: 'branch'; data: Node[]; size?: number; visible?: boolean }
const nodeSchema: z.ZodType<Node> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('leaf'), data: groupSchema, size: dimension.optional(), visible: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('branch'), data: z.array(nodeSchema).max(paneIds.length), size: dimension.optional(), visible: z.boolean().optional() }).strict()
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

const coordinate = z.number().int().min(-32_000).max(32_000)
const windowSchema = z.object({
  id: z.uuid(), panes: z.array(z.enum(popoutPaneIds)).min(1).max(popoutPaneIds.length), active: z.enum(popoutPaneIds),
  bounds: z.object({ x: coordinate, y: coordinate, width: z.number().int().min(popoutLimits.minWidth).max(popoutLimits.maxSize), height: z.number().int().min(popoutLimits.minHeight).max(popoutLimits.maxSize) }).strict()
}).strict()

const layoutSchema = z.object({
  grid: gridSchema, panels: z.object({ explorer: panelSchema.optional(), editor: panelSchema.optional(), results: panelSchema.optional(), messages: panelSchema.optional(), plan: panelSchema.optional(), statistics: panelSchema.optional() }).strict(),
  activeGroup: identifier.optional(),
  floatingGroups: z.array(z.object({ data: groupSchema.optional(), grid: gridSchema.optional(), position: positionSchema }).strict()
    .refine(value => (value.data === undefined) !== (value.grid === undefined), 'A floating group needs exactly one layout.')).max(paneIds.length).optional(),
  windows: z.array(windowSchema).max(popoutPaneIds.length).optional()
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
  // A popped-out panel is in its window only: never also docked, floating, or in another window; it has no Dockview panel.
  const windowIds = new Set<string>(), popped = new Set<string>()
  for (const item of layout.windows ?? []) {
    if (windowIds.has(item.id) || !item.panes.includes(item.active)) context.addIssue({ code: 'custom', message: 'Invalid popout window.' })
    windowIds.add(item.id)
    for (const id of item.panes) {
      if (seen.has(id) || popped.has(id) || layout.panels[id]) context.addIssue({ code: 'custom', message: 'A panel is referenced more than once.' })
      popped.add(id)
    }
  }
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
const legacyPaneIds: ReadonlySet<unknown> = new Set(['explorer', 'editor', 'output'])
/**
 * A version 1 layout as version 2 reads it: its Query output panel becomes Results, Messages and Execution plan, tabbed in
 * its place (in its group, docked or floating) with Results selected, keeping its constraints. The result is then
 * validated as any version 2 layout is.
 */
export function migrateLayoutV1(value: unknown): unknown {
  // Preserve the historical migration. New optional panels open through Window or their feature toggle.
  const legacyOutputs = ['results', 'messages', 'plan'] as const
  bounded(value, maxLayoutFileBytes)
  const copy = JSON.parse(JSON.stringify(value) ?? 'null') as Record<string, unknown> | null
  if (!copy || typeof copy !== 'object') return copy
  const group = (data: unknown) => {
    const item = data as { views?: unknown; activeView?: unknown } | undefined
    if (!item || typeof item !== 'object' || !Array.isArray(item.views)) return
    if (item.views.some(id => !legacyPaneIds.has(id))) throw new Error('Invalid or unsupported workspace layout: a version 1 layout names an unknown panel.')
    item.views = item.views.flatMap(id => id === 'output' ? [...legacyOutputs] : [id])
    if (item.activeView === 'output') item.activeView = 'results'
  }
  const node = (value: unknown): void => {
    const item = value as { type?: unknown; data?: unknown } | undefined
    if (item?.type === 'leaf') group(item.data)
    else if (item?.type === 'branch' && Array.isArray(item.data)) item.data.forEach(node)
  }
  node((copy.grid as { root?: unknown } | undefined)?.root)
  for (const floating of Array.isArray(copy.floatingGroups) ? copy.floatingGroups as ({ data?: unknown; grid?: { root?: unknown } } | null)[] : []) { group(floating?.data); node(floating?.grid?.root) }
  const panels = copy.panels as Record<string, unknown> | undefined
  if (panels && typeof panels === 'object' && Object.hasOwn(panels, 'output')) {
    const { output, ...rest } = panels, legacy = output as { id?: unknown } | null
    copy.panels = { ...rest, ...Object.fromEntries(legacyOutputs.map(id => [id, legacy && typeof legacy === 'object' ? { ...legacy, id: legacy.id === 'output' ? id : legacy.id } : legacy])) }
  }
  return copy
}
const layoutVersion = z.union([z.literal(1), z.literal(2), z.literal(3)])
export function parseLayoutState(value: unknown): LayoutState {
  bounded(value, maxLayoutStateBytes)
  const parsed = z.object({ version: layoutVersion, current: z.unknown(), saved: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(64), layout: z.unknown()
  }).strict()).max(20) }).strict().parse(value)
  const ids = new Set<string>(), names = new Set<string>()
  for (const saved of parsed.saved) {
    if (ids.has(saved.id) || names.has(saved.name.toLowerCase())) throw new Error('Saved layout names and IDs must be unique.')
    ids.add(saved.id); names.add(saved.name.toLowerCase())
  }
  const read = (layout: unknown) => parseWorkspaceLayout(parsed.version === 1 ? migrateLayoutV1(layout) : layout)
  return { version: 3, current: parsed.current === null ? null : read(parsed.current), saved: parsed.saved.map(saved => ({ ...saved, layout: read(saved.layout) })) }
}
export function layoutFile(layout: WorkspaceLayout) { return { kind: 'varia-workspace-layout', version: 3, layout: parseWorkspaceLayout(layout) } }
export function parseLayoutFile(value: unknown): WorkspaceLayout {
  bounded(value, maxLayoutFileBytes)
  const file = z.object({ kind: z.literal('varia-workspace-layout'), version: layoutVersion, layout: z.unknown() }).strict().safeParse(value)
  if (!file.success) throw new Error('Invalid or unsupported Varia layout file.')
  return parseWorkspaceLayout(file.data.version === 1 ? migrateLayoutV1(file.data.layout) : file.data.layout)
}

/**
 * Whether a dock group hides its header (its tabs), unless Window › Panel Tabs is on: a docked group with one panel does,
 * and so does a docked group of output panels only, whose own toolbar tabs between them.
 */
export function hidesHeader(group: { readonly location: string; readonly panels: readonly string[] }, panelTabs: boolean): boolean {
  return !panelTabs && group.location === 'grid' && group.panels.length > 0 && (group.panels.length === 1 || group.panels.every(isOutputPane))
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
