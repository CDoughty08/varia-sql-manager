import type { ExplorerNode as WireNode, VariaApi } from '../../../shared/contracts'
import { cloudEngineEditions, explorerLimits, filterProperties, folderSpecs, kindSpecs, parentKinds, type FolderId, type NodeKind } from '../../../shared/explorer/catalog.ts'
import { displayText, insertTextFor, refKey, type ExplorerFilter, type ExplorerNodeRef, type ExplorerTarget, type ObjectRef, type ParentRef } from '../../../shared/explorer/refs.ts'
import { explorerFilterSchema } from '../../../shared/explorer/schema.ts'
import { actionContextValues, actionMenuState, type ActionContextValues } from '../../../shared/actions/catalog.ts'
import { scriptContextValues, scriptMenuState, type ScriptContextValues } from '../../../shared/scripting/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { LiveConnection } from '../services/connections'
import { ExplorerLoader, type ExplorerLimitValues, type LoaderLimits, type LoadOutcome, type LoadPriority, type LoadTask } from './loader'
import { emptyRows, flatten, rowIndex, rowKindOf, rowOwner, RowKind, siblingPlan, type NodeError, type NodeTable, type TreeNode, type VisibleRows } from './tree-model'

export type { TreeNode } from './tree-model'
/** A sentence for the tree's live region; `id` changes with every announcement, so a repeated sentence is heard again. */
export interface Announcement { readonly text: string; readonly id: number }
export interface ExplorerSnapshot {
  readonly version: number
  readonly rows: VisibleRows
  /** A node id, or a synthetic row's (negative) id. */
  readonly selected?: number
  readonly announcement?: Announcement
  /** Changes when a selection made outside the tree asks it to scroll the selected row into view. */
  readonly reveal?: number
}
/**
 * The Object Explorer context keys (state scope), from the selected node; the Script As keys come from `scriptMenuState`
 * and the object action keys from `actionMenuState`.
 */
export interface ExplorerContextState extends ScriptContextValues, ActionContextValues {
  readonly explorerHasSelection: boolean
  readonly explorerSelectionKind: '' | 'folder' | NodeKind
  readonly explorerSelectionFolder: '' | FolderId
  readonly explorerSelectionFilterable: boolean
  readonly explorerSelectionFiltered: boolean
  readonly explorerSelectionInsertable: boolean
  readonly explorerLoading: boolean
}
export const noExplorerContext: ExplorerContextState = {
  explorerHasSelection: false, explorerSelectionKind: '', explorerSelectionFolder: '', explorerSelectionFilterable: false, explorerSelectionFiltered: false,
  explorerSelectionInsertable: false, ...scriptContextValues(scriptMenuState(undefined)), ...actionContextValues(actionMenuState(undefined)), explorerLoading: false
}
export type RefreshScope = 'server' | 'databases' | 'other'
export type ExplorerServiceLimits = LoaderLimits & ExplorerLimitValues<'pageSize' | 'folderCap' | 'nodeBudget' | 'siblingLoads' | 'filters' | 'loadingRowDelayMs' | 'deleteSlice'>
export interface ExplorerServiceOptions {
  readonly api: Pick<VariaApi, 'explorerChildren' | 'explorerCancel'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly events: Pick<EventBus, 'emit'>
  readonly timers?: Timers
  /** Runs once per tick: requestAnimationFrame in the app, synchronous in tests. */
  readonly schedule?: (callback: () => void) => void
  readonly newId?: () => string
  readonly limits?: Partial<ExplorerServiceLimits>
}

/** How a first page replaces the children: `keep` reuses static folders (and their state), `replace` collapses everything. */
type PageMode = 'keep' | 'replace' | 'more'
interface Running { readonly task: LoadTask; readonly mode: PageMode }
/** How far a folder's rows had got when a refresh began: put back if the refresh stops or fails. */
interface HeldPaging { readonly cursor: string | undefined; readonly capped: boolean; readonly total: number | undefined }
/** What the service remembers about a node beyond what rows show. */
interface NodeState { pendingMode?: 'keep' | 'replace'; retryMode?: 'keep' | 'replace'; budgetExempt?: boolean; loadingTimer?: unknown; held?: HeldPaging }

const serverRef: ExplorerNodeRef = { type: 'object', object: { kind: 'server' } }
const numbers = new Intl.NumberFormat('en-US')
const count = (value: number) => numbers.format(value)
const databaseFolders: ReadonlySet<string> = new Set<FolderId>(['databases', 'systemDatabases', 'databaseSnapshots'])
/** The object a node is, or the object a folder hangs below. */
const objectOf = (ref: ExplorerNodeRef): ObjectRef => ref.type === 'object' ? ref.object : ref.owner
const isParentKind = (kind: string): kind is ParentRef['kind'] => (parentKinds as readonly string[]).includes(kind)
const sameParent = (a: ParentRef, b: ObjectRef) => a.kind === b.kind && a.schema === b.schema && a.name === b.name

const targetOf = (node: TreeNode): ExplorerTarget =>
  ({ connectionId: node.connectionId, ref: node.ref, kind: node.kind, ...(node.folder ? { folder: node.folder } : {}), ...(node.subtype ? { subtype: node.subtype } : {}), label: node.label })

/** The server row's "(SQL Server 16.0.4135.4 - sa)", from the profile probed at connect, else the reported version. */
export function serverSublabel(connection: Pick<LiveConnection, 'serverVersion' | 'productVersion' | 'login'>): string {
  return connection.productVersion ? `(SQL Server ${connection.productVersion}${connection.login ? ' - ' + connection.login : ''})` : `(SQL Server ${connection.serverVersion})`
}

/**
 * Object Explorer's model: a table of numbered nodes loaded page by page from `explorer.children`, flattened into rows
 * once per tick. Servers come from the connections; nothing loads until a node is expanded. Folders keep loading their
 * remaining pages in the background while expanded, up to 100,000 children; above 250,000 nodes the children of
 * collapsed nodes are evicted, least recently used first. A response for a node that was refreshed, filtered, evicted
 * or removed meanwhile is dropped by its generation.
 */
export class ExplorerService extends SnapshotStore<ExplorerSnapshot> implements Disposable {
  private readonly connections: ExplorerServiceOptions['connections']
  private readonly events: ExplorerServiceOptions['events']
  private readonly timers: Timers
  private readonly schedule: (callback: () => void) => void
  private readonly limits: ExplorerServiceLimits
  private readonly loader: ExplorerLoader
  private readonly nodes = new Map<number, TreeNode>()
  private readonly states = new Map<number, NodeState>()
  private roots: number[] = []
  private readonly rootByConnection = new Map<string, number>()
  private readonly running = new Map<number, Running>()
  /**
   * Expanded nodes whose load an ancestor's collapse, refresh or filter change stopped: they resume when visible again
   * and no ancestor is loading its first page, and Stop marks them stopped.
   */
  private readonly stalled = new Set<number>()
  /** Per connection, by the folder's refKey. */
  private readonly filters = new Map<string, Map<string, ExplorerFilter>>()
  private filterCount = 0
  private readonly parentRefs = new WeakMap<ObjectRef, ParentRef>()
  /** Detached nodes to delete, as lists walked in place, so a 100,000-row folder is not copied first. */
  private graveyard: { readonly list: readonly TreeNode[]; next: number }[] = []
  private sweeping = false
  /** False once an eviction scan could not get below the budget, until a collapse or a new selection frees a node. */
  private evictable = true
  private nextId = 1
  private clock = 0
  private selected?: number
  private announcement?: Announcement
  private announcements = 0
  private reveals = 0
  private version = 0
  private dirty = false
  private scheduled = false
  private disposed = false
  private readonly contextStore = new (class extends SnapshotStore<ExplorerContextState> { set(value: ExplorerContextState) { this.publish(value) } clear() { this.clearListeners() } })(noExplorerContext)
  private readonly dialogStore = new (class extends SnapshotStore<number | undefined> { set(value: number | undefined) { if (value !== this.getSnapshot()) this.publish(value) } clear() { this.clearListeners() } })(undefined)
  private readonly renameStore = new (class extends SnapshotStore<number | undefined> { set(value: number | undefined) { if (value !== this.getSnapshot()) this.publish(value) } clear() { this.clearListeners() } })(undefined)
  /** The child refreshAndSelect selects when its folder's first page arrives. */
  private pendingSelect?: { readonly folder: number; readonly key: string }
  private readonly unsubscribe: () => void
  /** The selected node's context keys; it publishes only when one changes, and synchronously on `select`. */
  readonly context: ExternalStore<ExplorerContextState> = this.contextStore

  constructor(options: ExplorerServiceOptions) {
    super({ version: 0, rows: emptyRows })
    this.connections = options.connections
    this.events = options.events
    this.timers = options.timers ?? browserTimers
    this.schedule = options.schedule ?? (callback => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback()); else queueMicrotask(callback) })
    this.limits = { ...explorerLimits, ...options.limits }
    this.loader = new ExplorerLoader({ api: options.api, timers: this.timers, newId: options.newId, limits: this.limits, onPendingChange: () => this.updateContext() })
    this.unsubscribe = this.connections.subscribe(() => this.guard(() => this.syncConnections()))
    this.syncConnections()
  }

  /** The node table, for the tree's `*` plan. */
  get table(): NodeTable { return this.nodes }
  get rootIds(): readonly number[] { return this.roots }
  node(id: number): TreeNode | undefined { return this.nodes.get(id) }
  /** Nodes in the tree (evicted and removed ones excluded). */
  get size(): number { return this.roots.reduce((sum, id) => sum + 1 + (this.nodes.get(id)?.descendants ?? 0), 0) }
  /** The refKey of a node: its identity, which survives refresh. */
  keyOf(id: number): string | undefined { const node = this.nodes.get(id); return node && refKey(node.connectionId, node.ref) }

  expand(id: number, priority: LoadPriority = 'user'): void {
    const node = this.nodes.get(id)
    if (!node || !node.hasChildren || node.lost || !this.attached(node)) return
    node.lastUsed = ++this.clock
    if (!node.expanded) { node.expanded = true; node.rev++ }
    this.ensureLoading(node, priority)
    this.resumeStalled()
    this.invalidate()
  }
  /** Collapses a node and stops its loads and its descendants'; loaded pages and cursors stay, so expanding resumes. */
  collapse(id: number): void {
    const node = this.nodes.get(id)
    if (!node?.expanded) return
    node.expanded = false
    node.rev++
    this.evictable = true
    this.abortWithin(new Set([node.id]), 'collapse')
    if (this.selected !== undefined && this.selected !== id && this.within(rowOwner(this.selected), id)) this.selected = id
    this.invalidate()
  }
  toggle(id: number): void { if (this.nodes.get(id)?.expanded) this.collapse(id); else this.expand(id) }

  /** `*`: expands every collapsed sibling; at most 50 of those that need a query are loaded, the rest are skipped. */
  expandSiblings(id: number): { expanded: number; queued: number; skipped: number } {
    const plan = siblingPlan(this.nodes, this.roots, id, this.limits.siblingLoads)
    for (const sibling of plan.expand) this.expand(sibling, 'user')
    for (const sibling of plan.load) this.expand(sibling, 'background')
    const expanded = plan.expand.length + plan.load.length
    if (expanded || plan.skipped) this.announce(`Expanded ${count(expanded)} of ${count(expanded + plan.skipped)} items`)
    this.invalidate()
    return { expanded: plan.expand.length, queued: plan.load.length, skipped: plan.skipped }
  }
  /** Collapses everything below the servers. */
  collapseAll(): void {
    const roots = new Set(this.roots)
    this.abortWithin(undefined, 'collapse', task => !roots.has(task.nodeId))
    for (const node of this.nodes.values()) if (node.expanded && node.parent !== 0) { node.expanded = false; node.rev++ }
    this.stalled.clear()
    this.evictable = true
    if (this.selected !== undefined) {
      let node = this.nodes.get(rowOwner(this.selected))
      while (node && node.parent !== 0 && !roots.has(node.parent)) node = this.nodes.get(node.parent)
      this.selected = node?.id
    }
    this.invalidate()
  }

  /**
   * Reloads a row's node (a leaf's parent), or every server without one. Old rows stay until the first page arrives;
   * descendants come back collapsed, and the selection stays when its node reappears.
   */
  refresh(id?: number): void {
    if (id === undefined) { for (const root of [...this.roots]) this.refreshNode(this.nodes.get(root)); this.invalidate(); return }
    let node = this.nodes.get(rowOwner(id))
    if (node && node.kind !== 'folder' && !node.hasChildren && node.parent) node = this.nodes.get(node.parent)
    this.refreshNode(node)
    this.invalidate()
  }
  /** Stops every load. Partly loaded folders show a Stopped row, and first pages that never arrived collapse. */
  stop(): void {
    for (const [id, running] of [...this.running]) { this.running.delete(id); this.loader.abort(running.task); this.reverted(id, running, 'stop') }
    for (const id of this.stalled) {
      const node = this.nodes.get(id)
      if (!node || !this.attached(node)) continue
      if (node.more === 'auto' && node.cursor) node.more = 'stopped'
      else if (node.load === 'none') {
        this.state(node).pendingMode = undefined
        if (node.children?.length) { node.load = 'loaded'; this.restorePaging(node) }
        else node.expanded = false
      }
      node.rev++
    }
    this.stalled.clear()
    this.invalidate()
  }
  /** Enter on an error row: reloads the page that failed, or refreshes the parent of an object that no longer exists. */
  retry(rowId: number): void {
    const node = this.nodes.get(rowOwner(rowId))
    if (!node || !this.attached(node)) return
    const kind = rowKindOf(rowId)
    if (node.more === 'error' && (kind === RowKind.MoreError || kind === RowKind.Node)) {
      node.more = 'auto'
      node.error = undefined
      node.rev++
      if (node.expanded) this.loadMore(node, 'user')
    } else if (node.load === 'error' && (kind === RowKind.Error || kind === RowKind.Node)) {
      if (node.error?.action === 'refreshParent') { this.refresh(this.missingParent(node).id); return }
      const mode = this.state(node).retryMode ?? 'keep'
      node.error = undefined
      node.load = 'none'
      if (mode === 'replace') this.holdPaging(node)
      node.rev++
      this.loadFirst(node, mode, 'user')
    }
    this.invalidate()
  }
  /** Enter on a stopped or paused row: loads the rest of the folder (a paused one regardless of the node budget). */
  continueLoading(id: number): void {
    const node = this.nodes.get(rowOwner(id))
    if (!node || !node.cursor || (node.more !== 'stopped' && node.more !== 'paused' && node.more !== 'error')) return
    if (node.more === 'paused') this.state(node).budgetExempt = true
    node.more = 'auto'
    node.error = undefined
    node.rev++
    if (node.expanded) this.loadMore(node, 'user')
    this.invalidate()
  }

  /**
   * Selects a row and publishes the selection and context keys at once, so a menu opened next reads them. `reveal` asks
   * the tree to scroll the row into view, as it does for rows its keys select.
   */
  select(id: number, options?: { readonly reveal?: boolean }): void {
    const node = this.nodes.get(rowOwner(id))
    if (!node || !this.attached(node)) return
    node.lastUsed = ++this.clock
    const reveal = !!options?.reveal
    if (this.selected === id && !reveal) return
    this.selected = id
    if (reveal) this.reveals++
    this.evictable = true
    if (this.dirty) this.flush()
    else this.publish({ ...this.getSnapshot(), version: ++this.version, selected: id, ...(this.reveals ? { reveal: this.reveals } : {}) })
    this.updateContext()
  }
  /** The selected node as a command target; synthetic rows have none. */
  target(): ExplorerTarget | undefined {
    const node = this.selectedNode()
    return node && targetOf(node)
  }
  /** A row's node (a synthetic row's owner) as a context menu's target, with its id; undefined for a removed node. */
  menuNode(rowId: number | undefined): ExplorerMenuNode | undefined {
    const node = rowId === undefined ? undefined : this.nodes.get(rowOwner(rowId))
    return node && this.attached(node) ? { ...targetOf(node), id: node.id, lost: node.lost, ...(node.filtered ? { filtered: true } : {}), ...(node.kind === 'folder' && this.insertable(node) ? { insertable: true } : {}) } : undefined
  }
  /** The server and database a new query for the row should use (the database is the node's, if it has one). */
  queryTarget(id: number | undefined = this.selected): { connectionId: string; database?: string } | undefined {
    const node = id === undefined ? undefined : this.nodes.get(rowOwner(id))
    if (!node || !this.connections.getSnapshot().some(connection => connection.id === node.connectionId && !connection.lost)) return undefined
    const object = objectOf(node.ref), database = object.kind === 'database' ? object.name : object.database
    return database === undefined ? { connectionId: node.connectionId } : { connectionId: node.connectionId, database }
  }
  /**
   * What dragging the node into a query inserts: its quoted name, or for a Columns folder, once fully loaded, its
   * columns joined with ", ". Servers, other folders and synthetic rows insert nothing.
   */
  insertText(id: number): string | undefined {
    const node = id > 0 ? this.nodes.get(id) : undefined
    if (!node) return undefined
    if (node.kind !== 'folder') return insertTextFor(node.ref)
    if (node.folder !== 'columns' || !this.columnsLoaded(node)) return undefined
    const text = node.children!.map(column => insertTextFor(column.ref)).filter(value => value !== undefined).join(', ')
    return text && text.length <= 1_000_000 ? text : undefined
  }
  /** Whether a row can be dragged into a query: objects with a name to insert, and a Columns folder once fully loaded. */
  canInsert(id: number): boolean {
    const node = id > 0 ? this.nodes.get(id) : undefined
    return !!node && this.insertable(node)
  }
  /** What Copy Name copies: the insert text, or a server's name as connected to. */
  copyText(id: number): string | undefined {
    const node = id > 0 ? this.nodes.get(id) : undefined
    if (node?.kind === 'server') return this.connections.getSnapshot().find(connection => connection.id === node.connectionId)?.server
    return this.insertText(id)
  }

  /** The folder whose Filter Settings dialog is open. */
  get filterDialog(): ExternalStore<number | undefined> { return this.dialogStore }
  /** Opens Filter Settings for a folder that can be filtered. */
  openFilter(folderNodeId: number): void {
    const node = this.nodes.get(folderNodeId)
    if (!node?.folder || !folderSpecs[node.folder].filter?.length || !this.attached(node)) throw new Error('Select a folder that can be filtered.')
    this.dialogStore.set(folderNodeId)
  }
  closeFilter(): void { this.dialogStore.set(undefined) }

  /** The node whose label is an inline Rename box. */
  get renaming(): ExternalStore<number | undefined> { return this.renameStore }
  /**
   * Turns a node's label into the Rename box (F2, or Rename in its menu), selected and scrolled into view. Only an
   * object on a live server whose kind and subtype offer Rename enabled; false otherwise.
   */
  beginRename(nodeId: number): boolean {
    const node = this.nodes.get(nodeId)
    if (!node || node.kind === 'folder' || node.lost || !this.attached(node) || actionMenuState({ kind: node.kind, subtype: node.subtype }).rename !== 'enabled') return false
    if (!this.connections.getSnapshot().some(connection => connection.id === node.connectionId && !connection.lost)) return false
    this.select(nodeId, { reveal: true })
    this.renameStore.set(nodeId)
    return true
  }
  /** Ends the Rename box, whether it committed or not; the label shows the node's name again. */
  endRename(): void { this.renameStore.set(undefined) }
  /** The folder a node is listed in (a table's Tables folder, a database's Databases folder), which a rename or delete reloads. */
  listingFolderOf(nodeId: number): number | undefined {
    const node = this.nodes.get(nodeId), parent = node?.parent ? this.nodes.get(node.parent) : undefined
    return parent?.kind === 'folder' && this.attached(parent) ? parent.id : undefined
  }
  /**
   * Reloads a folder and selects the child whose identity is `ref` once its first page arrives (a renamed object under its
   * new name); when it never appears, the folder stays selected.
   */
  refreshAndSelect(folderNodeId: number, ref: ExplorerNodeRef): void {
    const folder = this.nodes.get(folderNodeId)
    if (!folder || folder.kind !== 'folder' || !this.attached(folder)) return
    this.pendingSelect = { folder: folderNodeId, key: refKey(folder.connectionId, ref) }
    this.refresh(folderNodeId)
    if (!folder.expanded) this.expand(folderNodeId)
  }
  /** The folder's filter; filters are kept per connection until it disconnects. */
  filter(folderNodeId: number): ExplorerFilter | undefined {
    const node = this.nodes.get(folderNodeId)
    return node?.kind === 'folder' ? this.filters.get(node.connectionId)?.get(refKey(node.connectionId, node.ref)) : undefined
  }
  /** Sets or clears a folder's filter, then reloads the folder (expanded): its static subfolders stay as they are. */
  setFilter(folderNodeId: number, filter: ExplorerFilter | undefined): void {
    const node = this.nodes.get(folderNodeId)
    const allowed = node?.folder ? folderSpecs[node.folder].filter ?? [] : []
    if (!node || !allowed.length || !this.attached(node)) throw new Error('Select a folder that can be filtered.')
    if (filter) {
      const parsed = explorerFilterSchema.safeParse(filter)
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'The filter is not valid.')
      if (filterProperties.some(property => filter[property] !== undefined && !allowed.includes(property))) throw new Error('This folder cannot be filtered by that property.')
    }
    const key = refKey(node.connectionId, node.ref)
    let map = this.filters.get(node.connectionId)
    if (filter) {
      if (!map?.has(key) && this.filterCount >= this.limits.filters) throw new Error(`Object Explorer keeps at most ${this.limits.filters} filters. Remove one first.`)
      if (!map) { map = new Map(); this.filters.set(node.connectionId, map) }
      if (!map.has(key)) this.filterCount++
      map.set(key, filter)
    } else {
      if (!map?.delete(key)) return
      this.filterCount--
    }
    node.filtered = !!filter
    node.generation++
    this.abortWithin(new Set([node.id]), 'detach')
    this.detach(node, node.children?.filter(child => child.kind !== 'folder') ?? [])
    Object.assign(node, { total: undefined, cursor: undefined, more: 'none', error: undefined, load: 'none', hasChildren: true, expanded: true })
    this.state(node).held = undefined
    node.lastUsed = ++this.clock
    node.rev++
    this.loadFirst(node, 'keep', 'user')
    this.announce(filter ? `Filter applied to ${node.label}` : `Filter removed from ${node.label}`)
    this.invalidate()
  }

  /** The text of a synthetic row, as shown: names and server messages in it get `displayText`'s markers. */
  rowText(rowId: number): string { return displayText(this.syntheticText(rowId)) }
  private syntheticText(rowId: number): string {
    const node = this.nodes.get(rowOwner(rowId))
    if (!node) return ''
    const loaded = node.children?.length ?? 0, total = Math.max(node.total ?? 0, loaded)
    const message = node.error?.message ?? ''
    switch (rowKindOf(rowId)) {
      case RowKind.Loading: return 'Loading…'
      case RowKind.More: return `Loading… ${count(loaded)} of ${count(total)}`
      case RowKind.Stopped: return `Stopped after ${count(loaded)} of ${count(total)} items. Press Enter to continue loading.`
      case RowKind.Capped: return `Showing the first ${count(loaded)} of ${count(total)} items in ${node.label}. Use Filter Settings to narrow the list.`
      case RowKind.Paused: return `Loading paused: Object Explorer holds ${count(this.limits.nodeBudget)} items. Collapse other folders or filter this one. Press Enter to continue.`
      case RowKind.MoreError: return `Could not load more: ${message} Press Enter to retry.`
      case RowKind.Error: {
        const prefix = this.states.get(node.id)?.retryMode === 'replace' ? 'Refresh failed: ' : ''
        if (node.error?.action === 'refreshParent') return `${prefix}${message} Press Enter to refresh ${this.missingParent(node).label}.`
        return `${prefix}${message}${node.error?.retryable ? ' Press Enter to retry.' : ''}`
      }
      default: return node.label
    }
  }

  /** Cancels everything and rebuilds the servers from the connections (the error boundary's Reload). Filters stay. */
  reset(): void {
    this.loader.abortWhere(() => true)
    this.running.clear()
    this.stalled.clear()
    for (const root of this.roots) this.bury(root)
    this.roots = []
    this.rootByConnection.clear()
    this.selected = undefined
    this.pendingSelect = undefined
    this.dialogStore.set(undefined)
    this.renameStore.set(undefined)
    this.syncConnections()
    // At once rather than next frame: the tree remounts right after this and must not show the old rows meanwhile.
    this.dirty = true
    this.flush()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.loader.dispose()
    for (const state of this.states.values()) this.timers.clearTimeout(state.loadingTimer)
    this.running.clear()
    this.clearListeners()
    this.contextStore.clear()
    this.dialogStore.clear()
    this.renameStore.clear()
  }

  // Connections

  private syncConnections(): void {
    if (this.disposed) return
    const list = this.connections.getSnapshot(), ids = new Set(list.map(connection => connection.id))
    const selectedRoot = this.selected === undefined ? undefined : this.rootOf(this.nodes.get(rowOwner(this.selected)))
    let removedAt = -1
    for (const [connectionId, rootId] of [...this.rootByConnection]) {
      if (ids.has(connectionId)) continue
      if (selectedRoot?.id === rootId) removedAt = this.roots.indexOf(rootId)
      this.removeRoot(connectionId, rootId)
    }
    const roots: number[] = [], added: number[] = []
    for (const connection of list) {
      const existing = this.rootByConnection.get(connection.id)
      if (existing === undefined) {
        const id = this.addRoot(connection)
        roots.push(id)
        if (!connection.lost) added.push(id)
        continue
      }
      const root = this.nodes.get(existing)!
      if (connection.lost && !root.lost) this.markLost(root)
      roots.push(existing)
    }
    this.roots = roots
    if (removedAt >= 0) this.selected = roots[Math.min(removedAt, roots.length - 1)]
    if (this.selected === undefined && roots.length) this.selected = added[0] ?? roots[0]
    for (const id of added) this.expand(id, 'user')
    this.invalidate()
  }
  private addRoot(connection: LiveConnection): number {
    const node = this.createNode(0, connection.id, serverRef, 'server', undefined, 0, connection.displayName || connection.server, 'server')
    node.sublabel = serverSublabel(connection)
    const facts = [connection.displayName ? connection.server : '', connection.engineEdition !== undefined && (cloudEngineEditions as readonly number[]).includes(connection.engineEdition) ? 'Only databases can be browsed on this edition.' : '']
    node.detail = facts.filter(Boolean).join(' · ') || undefined
    node.hasChildren = !connection.lost
    node.lost = !!connection.lost
    node.lastUsed = ++this.clock
    this.rootByConnection.set(connection.id, node.id)
    return node.id
  }
  private removeRoot(connectionId: string, rootId: number): void {
    this.abortWhere(task => task.connectionId === connectionId)
    const filters = this.filters.get(connectionId)
    if (filters) { this.filterCount -= filters.size; this.filters.delete(connectionId) }
    this.rootByConnection.delete(connectionId)
    this.roots = this.roots.filter(id => id !== rootId)
    this.bury(rootId)
  }
  /** A connection lost with its backend generation keeps its row, collapsed and loading nothing, until it is reconnected or removed. */
  private markLost(root: TreeNode): void {
    this.abortWhere(task => task.connectionId === root.connectionId)
    this.detach(root, root.children ?? [])
    Object.assign(root, { lost: true, hasChildren: false, expanded: false, children: undefined, load: 'none', more: 'none', cursor: undefined, total: undefined, error: undefined, connectionError: undefined, staticCount: 0 })
    root.rev++
    if (this.selected !== undefined && this.within(rowOwner(this.selected), root.id)) this.selected = root.id
  }

  // Loading

  private ensureLoading(node: TreeNode, priority: LoadPriority): void {
    if (!node.expanded || this.running.has(node.id)) return
    if (node.load === 'none' || node.load === 'loading') this.loadFirst(node, this.state(node).pendingMode ?? 'keep', priority)
    else if (node.more === 'auto' && node.cursor) this.capOrContinue(node)
  }
  private resumeStalled(): void {
    for (const id of [...this.stalled]) {
      const node = this.nodes.get(id)
      if (!node || !node.expanded || !this.attached(node)) { this.stalled.delete(id); continue }
      if (!this.visible(node) || this.reloadingAbove(node)) continue
      this.stalled.delete(id)
      this.ensureLoading(node, 'background')
    }
  }
  private params(node: TreeNode, cursor?: string): LoadTask['params'] {
    const filter = node.kind === 'folder' ? this.filters.get(node.connectionId)?.get(refKey(node.connectionId, node.ref)) : undefined
    return { node: node.ref, ...(node.ref.type === 'object' && node.subtype ? { subtype: node.subtype } : {}), ...(cursor ? { cursor } : {}), ...(filter ? { filter } : {}) }
  }
  private loadFirst(node: TreeNode, mode: 'keep' | 'replace', priority: LoadPriority): void {
    const previous = this.running.get(node.id)
    if (previous) { this.running.delete(node.id); this.loader.abort(previous.task) }
    const state = this.state(node)
    state.pendingMode = mode
    const running: Running = {
      mode, task: this.loader.enqueue({ connectionId: node.connectionId, nodeId: node.id, generation: node.generation, params: this.params(node) }, priority, outcome => this.guard(() => this.settled(node.id, running, outcome)))
    }
    this.running.set(node.id, running)
    if (node.load !== 'loading') { node.load = 'loading'; node.rev++ }
    if (!node.children?.length && state.loadingTimer === undefined) {
      state.loadingTimer = this.timers.setTimeout(() => {
        state.loadingTimer = undefined
        if (node.load !== 'loading' || node.showLoading) return
        node.showLoading = true
        node.rev++
        this.invalidate()
      }, this.limits.loadingRowDelayMs)
    }
  }
  private loadMore(node: TreeNode, priority: LoadPriority): void {
    if (!node.cursor || this.running.has(node.id)) return
    const running: Running = {
      mode: 'more', task: this.loader.enqueue({ connectionId: node.connectionId, nodeId: node.id, generation: node.generation, params: this.params(node, node.cursor) }, priority, outcome => this.guard(() => this.settled(node.id, running, outcome)))
    }
    this.running.set(node.id, running)
  }
  /** Continues a folder in the background while it is expanded, below the folder cap and within the node budget. */
  private capOrContinue(node: TreeNode): void {
    if (!node.cursor) { node.more = 'none'; return }
    if ((node.children?.length ?? 0) >= this.limits.folderCap) { node.cursor = undefined; node.more = 'capped'; return }
    node.more = 'auto'
    if (!node.expanded || this.running.has(node.id)) return
    if (!this.state(node).budgetExempt && this.size >= this.limits.nodeBudget && !this.evict()) {
      node.more = 'paused'
      this.announce(`Loading paused: Object Explorer holds ${count(this.limits.nodeBudget)} items`)
      return
    }
    this.loadMore(node, 'background')
  }

  private settled(nodeId: number, running: Running, outcome: LoadOutcome): void {
    if (this.running.get(nodeId) !== running) return
    this.running.delete(nodeId)
    const node = this.nodes.get(nodeId)
    if (!node || node.generation !== running.task.generation || !this.attached(node)) return
    this.stopLoadingRow(node)
    const root = this.rootOf(node)
    if (outcome.ok && !outcome.result.error) {
      if (root?.connectionError) { root.connectionError = undefined; root.rev++ }
      if (running.mode === 'more') this.appendPage(node, outcome.result.nodes, outcome.result.cursor)
      else this.firstPage(node, outcome.result.nodes, outcome.result.cursor, outcome.result.total, running.mode)
    } else {
      const error: NodeError = outcome.ok ? outcome.result.error! : outcome.error
      this.failed(node, error, running.mode, outcome.ok ? outcome.result.nodes : [])
      if (root && (outcome.ok ? error.code === 'CONNECTION_LOST' : outcome.connectionLost)) { root.connectionError = error; root.rev++ }
    }
    // Loads below a refreshed or filtered folder waited for its first page: gone with the old rows, or resumed now.
    if (running.mode !== 'more' && this.stalled.size) this.resumeStalled()
    this.enforceBudget()
    this.invalidate()
  }
  private firstPage(node: TreeNode, wires: readonly WireNode[], cursor: string | undefined, total: number | undefined, mode: PageMode): void {
    const selectedKey = mode === 'replace' && this.selected !== undefined && this.selected !== node.id && this.within(rowOwner(this.selected), node.id) ? this.keyOf(rowOwner(this.selected)) : undefined
    const truncated = this.replaceChildren(node, wires, mode === 'replace' ? 'replace' : 'keep')
    const state = this.state(node)
    state.pendingMode = state.retryMode = state.held = undefined
    Object.assign(node, { total, cursor: truncated ? undefined : cursor, load: 'loaded', error: undefined, more: truncated ? 'capped' : 'none' })
    node.rev++
    if (selectedKey !== undefined) this.selected = node.children!.find(child => refKey(child.connectionId, child.ref) === selectedKey)?.id ?? node.id
    if (this.pendingSelect?.folder === node.id) {
      const { key } = this.pendingSelect
      this.pendingSelect = undefined
      this.selected = node.children!.find(child => refKey(child.connectionId, child.ref) === key)?.id ?? node.id
      this.reveals++
    }
    if (!node.children!.length) {
      node.hasChildren = false
      node.expanded = false
      this.announce(`${node.label}: no items`)
    } else if (cursor && total !== undefined) this.announce(`${node.label}: loaded ${count(node.children!.length)} of ${count(total)}`)
    if (!truncated) this.capOrContinue(node)
  }
  private appendPage(node: TreeNode, wires: readonly WireNode[], cursor: string | undefined): void {
    const truncated = this.addChildren(node, wires)
    node.cursor = truncated ? undefined : cursor
    node.error = undefined
    node.rev++
    if (truncated) node.more = 'capped'
    else this.capOrContinue(node)
  }
  private failed(node: TreeNode, error: NodeError, mode: PageMode, partial: readonly WireNode[]): void {
    const state = this.state(node)
    if (mode === 'more') {
      node.more = 'error'
    } else {
      // A refresh keeps its old rows; other loads show the static folders that did not need the failed query.
      if (mode === 'keep' && partial.length) this.replaceChildren(node, partial, 'keep')
      state.retryMode = mode
      state.pendingMode = undefined
      node.load = 'error'
      node.more = 'none'
      if (mode === 'replace') this.restorePaging(node)
    }
    node.error = error
    node.rev++
    this.announce(`Could not load ${node.label}: ${error.message}`)
    if (this.pendingSelect?.folder === node.id && mode !== 'more') { this.pendingSelect = undefined; this.selected = node.id }
  }

  /** Replaces a node's children with a first page; `keep` reuses existing static folders with the same id. */
  private replaceChildren(node: TreeNode, wires: readonly WireNode[], mode: 'keep' | 'replace'): boolean {
    const old = node.children ?? []
    const reuse = new Map<FolderId, TreeNode>()
    if (mode === 'keep') for (const child of old) if (child.folder) reuse.set(child.folder, child)
    const children: TreeNode[] = [], kept = new Set<TreeNode>()
    let statics = 0, truncated = false
    for (const wire of wires) {
      if (children.length >= this.limits.folderCap) { truncated = true; break }
      if (wire.ref.type === 'folder') {
        statics++
        const reused = reuse.get(wire.ref.folder)
        if (reused) { reuse.delete(wire.ref.folder); kept.add(reused); children.push(reused); continue }
      }
      children.push(this.createChild(node, wire))
    }
    this.detach(node, old.filter(child => !kept.has(child)))
    node.children = children
    node.staticCount = statics
    this.addDescendants(node, children.length - kept.size)
    return truncated
  }
  /** Appends a page, stopping at the folder cap; true when rows were cut. */
  private addChildren(node: TreeNode, wires: readonly WireNode[]): boolean {
    const children = node.children ?? (node.children = [])
    let created = 0
    for (const wire of wires) {
      if (children.length >= this.limits.folderCap) { this.addDescendants(node, created); return true }
      children.push(this.createChild(node, wire))
      created++
    }
    this.addDescendants(node, created)
    return false
  }

  private createNode(parent: number, connectionId: string, ref: ExplorerNodeRef, kind: TreeNode['kind'], folder: FolderId | undefined, level: number, label: string, icon: TreeNode['icon']): TreeNode {
    const node: TreeNode = {
      id: this.nextId++, parent, connectionId, ref, kind, folder, level: level + 1, label, lower: label.toLocaleLowerCase(), sublabel: undefined, detail: undefined, icon,
      subtype: undefined, status: undefined, created: undefined, hasChildren: false, expanded: false, children: undefined, staticCount: 0, total: undefined, cursor: undefined,
      load: 'none', more: 'none', error: undefined, connectionError: undefined, filtered: false, lost: false, showLoading: false, detached: false, generation: 0, rev: 0, lastUsed: 0,
      descendants: 0
    }
    this.nodes.set(node.id, node)
    return node
  }
  private createChild(parent: TreeNode, wire: WireNode): TreeNode {
    const ref = this.intern(parent, wire.ref)
    const node = this.createNode(parent.id, parent.connectionId, ref, ref.type === 'folder' ? 'folder' : ref.object.kind, ref.type === 'folder' ? ref.folder : undefined, parent.level, wire.label, wire.icon)
    node.sublabel = wire.sublabel
    node.detail = wire.detail
    node.subtype = wire.subtype
    node.status = wire.status
    node.created = wire.created
    node.hasChildren = wire.hasChildren
    if (ref.type === 'folder' && this.filters.get(parent.connectionId)?.size) node.filtered = this.filters.get(parent.connectionId)!.has(refKey(parent.connectionId, ref))
    return node
  }
  /**
   * Makes a child's ref share its parent's strings and objects: a folder's owner is the parent's object, and a row's
   * database and parent reuse the parent's, so 250,000 nodes do not hold 250,000 copies of a database name.
   */
  private intern(parent: TreeNode, ref: ExplorerNodeRef): ExplorerNodeRef {
    const base = objectOf(parent.ref)
    type Mutable<T> = { -readonly [K in keyof T]: T[K] }
    if (ref.type === 'folder') {
      const owner = ref.owner
      if (owner.kind === base.kind && owner.database === base.database && owner.schema === base.schema && owner.name === base.name && owner.parent?.name === base.parent?.name
        && owner.parent?.schema === base.parent?.schema && owner.parent?.kind === base.parent?.kind) (ref as Mutable<typeof ref>).owner = base
      return ref
    }
    const object = ref.object as Mutable<ObjectRef>
    const database = base.kind === 'database' ? base.name : base.database
    if (object.database !== undefined && object.database === database) object.database = database
    if (object.parent && isParentKind(base.kind) && sameParent(object.parent, base)) {
      let shared = this.parentRefs.get(base)
      if (!shared) { shared = { kind: base.kind as ParentRef['kind'], schema: base.schema!, name: base.name! }; this.parentRefs.set(base, shared) }
      object.parent = shared
    }
    return ref
  }

  // Tree bookkeeping

  private state(node: TreeNode): NodeState {
    let state = this.states.get(node.id)
    if (!state) { state = {}; this.states.set(node.id, state) }
    return state
  }
  private stopLoadingRow(node: TreeNode): void {
    const state = this.states.get(node.id)
    if (state?.loadingTimer !== undefined) { this.timers.clearTimeout(state.loadingTimer); state.loadingTimer = undefined }
    if (node.showLoading) { node.showLoading = false; node.rev++ }
  }
  private addDescendants(node: TreeNode, delta: number): void {
    if (!delta) return
    for (let current: TreeNode | undefined = node; current; current = current.parent ? this.nodes.get(current.parent) : undefined) current.descendants += delta
  }
  /** `id` is `ancestor` or below it. */
  private within(id: number, ancestor: number): boolean { return this.inSet(id, new Set([ancestor])) }
  /** `id` is in `set` or below a node in it. */
  private inSet(id: number, set: ReadonlySet<number>): boolean {
    for (let current = this.nodes.get(id); current; current = current.parent ? this.nodes.get(current.parent) : undefined) if (set.has(current.id)) return true
    return false
  }
  private rootOf(node: TreeNode | undefined): TreeNode | undefined {
    let current = node
    while (current && current.parent) current = this.nodes.get(current.parent)
    return current
  }
  /** In the tree: not removed, evicted or replaced, below a current server. */
  private attached(node: TreeNode): boolean {
    for (let current: TreeNode | undefined = node; current; current = current.parent ? this.nodes.get(current.parent) : undefined) {
      if (current.detached) return false
      if (!current.parent) return this.rootByConnection.get(current.connectionId) === current.id
    }
    return false
  }
  private visible(node: TreeNode): boolean {
    for (let current = node.parent ? this.nodes.get(node.parent) : undefined; current; current = current.parent ? this.nodes.get(current.parent) : undefined) if (!current.expanded) return false
    return true
  }
  /** The parent to refresh for a NOT_FOUND: that of the object that is gone (a folder's owner, or the node itself). */
  private missingParent(node: TreeNode): TreeNode {
    let object = node
    while (object.kind === 'folder' && object.parent) object = this.nodes.get(object.parent) ?? object
    return (object.parent ? this.nodes.get(object.parent) : undefined) ?? object
  }
  private selectedNode(): TreeNode | undefined {
    const node = this.selected !== undefined && this.selected > 0 ? this.nodes.get(this.selected) : undefined
    return node && this.attached(node) ? node : undefined
  }
  private columnsLoaded(node: TreeNode): boolean {
    return node.load === 'loaded' && node.more === 'none' && !node.cursor && !!node.children?.length
  }
  private insertable(node: TreeNode): boolean {
    return node.kind === 'folder' ? node.folder === 'columns' && this.columnsLoaded(node) : kindSpecs[node.kind].insert !== 'none'
  }

  private refreshNode(node: TreeNode | undefined): void {
    if (!node || node.lost || !this.attached(node)) return
    node.generation++
    this.abortWithin(new Set([node.id]), 'detach')
    const state = this.state(node)
    state.budgetExempt = undefined
    this.holdPaging(node)
    node.error = undefined
    if (node.load === 'error') node.load = node.children?.length ? 'loaded' : 'none'
    if (node.kind === 'folder' && !node.hasChildren) { node.hasChildren = true; node.expanded = true }
    if (node.expanded) this.loadFirst(node, 'replace', 'user')
    else {
      this.detach(node, node.children ?? [])
      Object.assign(node, { children: undefined, total: undefined, staticCount: 0, load: 'none' })
      state.pendingMode = state.retryMode = state.held = undefined
    }
    node.rev++
    const scope: RefreshScope = node.kind === 'server' ? 'server' : node.folder && databaseFolders.has(node.folder) ? 'databases' : 'other'
    try { this.events.emit({ type: 'explorer.refreshed', connectionId: node.connectionId, scope }) } catch (error) { onUnexpectedError(error) }
  }

  /**
   * Aborts the loads of `roots` and everything below them (or those `predicate` picks) and puts their nodes back. Loads
   * strictly below a collapsed, refreshed or filtered root wait in `stalled`.
   */
  private abortWithin(roots: ReadonlySet<number> | undefined, reason: 'collapse' | 'stop' | 'detach', predicate?: (task: LoadTask) => boolean): void {
    for (const [id, running] of [...this.running]) {
      if (predicate && !predicate(running.task)) continue
      if (roots && !this.inSet(id, roots)) continue
      this.running.delete(id)
      this.loader.abort(running.task)
      this.reverted(id, running, reason)
      const below = reason === 'collapse' ? !roots?.has(id) : reason === 'detach' && !!roots && !roots.has(id)
      if (below && this.nodes.get(id)?.expanded) this.stalled.add(id)
    }
  }
  /** An ancestor is loading its first page (a refresh or filter change), which may replace this node. */
  private reloadingAbove(node: TreeNode): boolean {
    for (let current = node.parent ? this.nodes.get(node.parent) : undefined; current; current = current.parent ? this.nodes.get(current.parent) : undefined) {
      const running = this.running.get(current.id)
      if (running && running.mode !== 'more') return true
    }
    return false
  }
  /** A refresh hides how far the old rows had got (cursor, cap) until its first page replaces them. */
  private holdPaging(node: TreeNode): void {
    if (node.children?.length && (node.cursor || node.more === 'capped')) this.state(node).held = { cursor: node.cursor, capped: node.more === 'capped', total: node.total }
    Object.assign(node, { cursor: undefined, more: 'none' })
  }
  /** A refresh that stopped or failed: the old rows say again how far they had got, stopped rather than loading. */
  private restorePaging(node: TreeNode): void {
    const state = this.states.get(node.id), held = state?.held
    if (!held) return
    state.held = undefined
    if (!node.children?.length) return
    node.total = held.total
    if (held.cursor) { node.cursor = held.cursor; node.more = 'stopped' } else if (held.capped) node.more = 'capped'
  }
  private abortWhere(predicate: (task: LoadTask) => boolean): void { this.abortWithin(undefined, 'detach', predicate) }
  /** A node whose load was aborted: a first page is needed again (old rows stay), or a stopped folder says so. */
  private reverted(id: number, running: Running, reason: 'collapse' | 'stop' | 'detach'): void {
    const node = this.nodes.get(id)
    if (!node) return
    this.stopLoadingRow(node)
    if (running.mode === 'more') {
      if (reason === 'stop') node.more = 'stopped'
    } else if (reason === 'stop') {
      this.state(node).pendingMode = undefined
      if (node.children?.length) { node.load = 'loaded'; this.restorePaging(node) }
      else { node.load = 'none'; node.expanded = false }
    } else node.load = 'none'
    node.rev++
  }

  /**
   * Takes `children` of `node` out of the tree now and deletes their subtrees in slices. A flag on each child (no set,
   * no per-child state) keeps a refresh of a 100,000-row folder within one frame.
   */
  private detach(node: TreeNode, children: readonly TreeNode[]): void {
    if (!children.length) return
    let removed = 0
    for (const child of children) {
      removed += 1 + child.descendants
      child.detached = true
    }
    this.abortDetached()
    if (node.children) node.children = node.children.length === children.length ? [] : node.children.filter(child => !child.detached)
    this.addDescendants(node, -removed)
    const selected = this.selected === undefined ? undefined : this.nodes.get(rowOwner(this.selected))
    if (selected && !this.attached(selected) && this.within(selected.id, node.id)) this.selected = node.id
    this.graveyard.push({ list: children, next: 0 })
    this.sweep()
  }
  /** Aborts the loads of nodes that are no longer in the tree. */
  private abortDetached(): void {
    for (const [id, running] of [...this.running]) {
      const node = this.nodes.get(id)
      if (node && this.attached(node)) continue
      this.running.delete(id)
      this.loader.abort(running.task)
      this.reverted(id, running, 'detach')
    }
  }
  private bury(rootId: number): void {
    const root = this.nodes.get(rootId)
    if (!root) return
    root.detached = true
    this.graveyard.push({ list: [root], next: 0 })
    this.sweep()
  }
  private sweep(): void {
    if (this.sweeping || !this.graveyard.length) return
    this.sweeping = true
    this.timers.setTimeout(() => this.guard(() => {
      this.sweeping = false
      let budget = this.limits.deleteSlice
      while (budget > 0 && this.graveyard.length) {
        const top = this.graveyard[this.graveyard.length - 1]
        if (top.next >= top.list.length) { this.graveyard.pop(); continue }
        const node = top.list[top.next++], id = node.id
        if (this.nodes.get(id) !== node) continue
        this.nodes.delete(id)
        const state = this.states.get(id)
        if (state) { this.timers.clearTimeout(state.loadingTimer); this.states.delete(id) }
        this.stalled.delete(id)
        budget--
        if (node.children?.length) this.graveyard.push({ list: node.children, next: 0 })
      }
      this.sweep()
    }), 0)
  }

  private enforceBudget(): void { if (this.size > this.limits.nodeBudget) this.evict() }
  /**
   * Frees room below the node budget by evicting the children of collapsed nodes, least recently used first; expanded
   * nodes and the selection's ancestors keep theirs. True when the tree is back below the budget.
   */
  private evict(): boolean {
    // Every page arrives here while the tree is over budget: scanning 250,000 nodes again would find nothing new.
    if (!this.evictable) return this.size < this.limits.nodeBudget
    const target = Math.max(0, this.limits.nodeBudget - this.limits.pageSize)
    const keep = new Set<number>()
    for (let node = this.selected === undefined ? undefined : this.nodes.get(rowOwner(this.selected)); node; node = node.parent ? this.nodes.get(node.parent) : undefined) keep.add(node.id)
    const candidates: TreeNode[] = []
    for (const node of this.nodes.values()) if (!node.expanded && node.children?.length && !keep.has(node.id)) candidates.push(node)
    candidates.sort((a, b) => a.lastUsed - b.lastUsed)
    for (const node of candidates) {
      if (this.size <= target) break
      if (!this.attached(node)) continue
      node.generation++
      this.abortWithin(new Set([node.id]), 'detach')
      this.detach(node, node.children ?? [])
      Object.assign(node, { children: undefined, total: undefined, cursor: undefined, staticCount: 0, load: 'none', more: 'none', error: undefined })
      const state = this.state(node)
      state.pendingMode = state.retryMode = state.budgetExempt = state.held = undefined
      node.rev++
    }
    if (this.size > target) this.evictable = false
    return this.size < this.limits.nodeBudget
  }

  // Publishing

  private announce(text: string): void { this.announcement = { text: displayText(text), id: ++this.announcements } }
  private invalidate(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => { this.scheduled = false; this.guard(() => this.flush()) })
  }
  private flush(): void {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    const previous = this.getSnapshot()
    const rows = flatten(this.nodes, this.roots, previous.rows.count + 64)
    const renaming = this.renameStore.getSnapshot(), renamed = renaming === undefined ? undefined : this.nodes.get(renaming)
    if (renaming !== undefined && (!renamed || renamed.lost || !this.attached(renamed) || this.rootOf(renamed)?.lost)) this.renameStore.set(undefined)
    // A synthetic row can disappear (a load finished); its owner is selected instead.
    if (this.selected !== undefined && this.selected < 0 && rowIndex(rows, this.selected) < 0) this.selected = rowOwner(this.selected)
    if (this.selected !== undefined && !this.nodes.has(rowOwner(this.selected))) this.selected = undefined
    this.publish({ version: ++this.version, rows, ...(this.selected !== undefined ? { selected: this.selected } : {}), ...(this.announcement ? { announcement: this.announcement } : {}),
      ...(this.reveals ? { reveal: this.reveals } : {}) })
    this.updateContext()
  }
  private updateContext(): void {
    if (this.disposed) return
    const node = this.selectedNode()
    const folder = node?.folder ? folderSpecs[node.folder] : undefined
    const next: ExplorerContextState = {
      explorerHasSelection: !!node,
      explorerSelectionKind: node?.kind ?? '',
      explorerSelectionFolder: node?.folder ?? '',
      explorerSelectionFilterable: !!node && !!folder?.filter?.length,
      explorerSelectionFiltered: !!node?.filtered,
      explorerSelectionInsertable: !!node && (node.kind === 'server' || this.insertable(node)),
      ...scriptContextValues(scriptMenuState(node && { kind: node.kind, subtype: node.subtype, parentKind: node.ref.type === 'object' ? node.ref.object.parent?.kind : undefined })),
      ...actionContextValues(actionMenuState(node && { kind: node.kind, subtype: node.subtype })),
      explorerLoading: this.loader.pending > 0
    }
    const current = this.contextStore.getSnapshot()
    if ((Object.keys(next) as (keyof ExplorerContextState)[]).some(key => next[key] !== current[key])) this.contextStore.set(next)
  }
  private guard(action: () => void): void {
    try { action() } catch (error) { onUnexpectedError(error) }
  }
}
