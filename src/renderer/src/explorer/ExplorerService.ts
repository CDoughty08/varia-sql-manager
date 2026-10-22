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

/**
 * How a first page replaces the children: `keep` reuses static folders (and their state); `reconcile` keeps every child
 * that is still there, by refKey, with its own children, expansion and selection.
 */
type PageMode = 'keep' | 'reconcile' | 'more'
type FirstMode = Exclude<PageMode, 'more'>
/** `deep`: a reconcile that reloads the expanded nodes below the node as well. */
interface Running { readonly task: LoadTask; readonly mode: PageMode; readonly deep: boolean }
/**
 * A reconcile whose folder pages on: its children are the rows this reconcile's pages brought, then the old rows no page
 * has brought back yet, which stay until the last page (or the folder cap) shows they are gone.
 */
interface Reconciling {
  /** The children before the reconcile, in order. Pages usually list them in the same order, so they are matched in turn. */
  readonly old: readonly TreeNode[]
  /** `old[next]` is the row the next page row is compared with first. */
  next: number
  /** Old rows before `old[next]` that no page row matched yet: they still wait. */
  readonly skipped: Set<TreeNode>
  /** Old rows from `old[next]` on that the index matched out of turn. */
  readonly takenAhead: Set<TreeNode>
  /** Built at the first row that is not a few rows on: the waiting rows by name (folders by folder id), matched by refKey. */
  index?: { readonly objects: Map<string, TreeNode | TreeNode[]>; readonly folders: Map<string, TreeNode> }
  /** This reconcile's rows so far: the children start with them, and the waiting old rows follow. */
  readonly rows: TreeNode[]
  added: number
  readonly deep: boolean
}
/** How far a folder's rows had got when a refresh began: put back if the refresh stops or fails. */
/** A reconcile still paging is held too: continuing its cursor must go on matching the rows it left waiting. */
interface HeldPaging { readonly cursor: string | undefined; readonly capped: boolean; readonly total: number | undefined; readonly reconciling: Reconciling | undefined }
/** What the service remembers about a node beyond what rows show. */
interface NodeState { pendingMode?: FirstMode; retryMode?: FirstMode; deep?: boolean; budgetExempt?: boolean; loadingTimer?: unknown; held?: HeldPaging; reconciling?: Reconciling }
/** What `reconcile` does besides reloading the node. */
export interface ReconcileOptions {
  /** Selects (and reveals) the child with this identity once a page brings it; the node itself if none does. */
  readonly select?: ExplorerNodeRef
  /** Reloads the expanded nodes below too, and has collapsed ones reload when next expanded (Refresh does). */
  readonly deep?: boolean
  /**
   * A reconcile nobody asked for (a probe saw a change): it loads behind the user's own loads and emits no
   * `explorer.refreshed`, so the query bars' database lists are not reloaded for it.
   */
  readonly background?: boolean
}

const serverRef: ExplorerNodeRef = { type: 'object', object: { kind: 'server' } }
const numbers = new Intl.NumberFormat('en-US')
const count = (value: number) => numbers.format(value)
/** How many old rows past the next one a page row is looked for before the name index: a few dropped objects stay cheap. */
const reconcileLookahead = 16
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
  /** The child `reconcile` selects when a page of its folder brings it. */
  private pendingSelect?: { readonly folder: number; readonly key: string; readonly name: string | undefined }
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
   * Refresh: reconciles a row's node (a leaf's parent), or every server without one, deeply. Old rows stay until the first
   * page arrives; rows that are still there keep their node, expansion and selection, and expanded nodes below reload too.
   */
  refresh(id?: number): void {
    if (id === undefined) { for (const root of [...this.roots]) this.reconcileNode(this.nodes.get(root), { deep: true }); this.invalidate(); return }
    let node = this.nodes.get(rowOwner(id))
    if (node && node.kind !== 'folder' && !node.hasChildren && node.parent) node = this.nodes.get(node.parent)
    this.reconcileNode(node, { deep: true })
    this.invalidate()
  }
  /**
   * Reloads a node's children in place and diffs them by refKey: a child that is still there keeps its node (with its
   * children, expansion, selection and Rename box) and takes the new label and state; new children are inserted, and
   * those that are gone are removed once the folder's last page has arrived. The changes are announced ("Tables: 1 added,
   * 1 removed"). A collapsed node reconciles when it is next expanded. Used after Varia's own DDL and by Refresh.
   */
  reconcile(nodeId: number, options: ReconcileOptions = {}): void {
    const node = this.nodes.get(nodeId)
    if (!node || node.lost || !this.attached(node)) return
    if (options.select) {
      const object = options.select.type === 'object' ? options.select.object : undefined
      this.pendingSelect = { folder: node.id, key: refKey(node.connectionId, options.select), name: object?.name }
    }
    this.reconcileNode(node, options, options.background ? 'background' : 'user')
    this.invalidate()
  }
  /** Stops every load. Partly loaded folders show a Stopped row, and first pages that never arrived collapse. */
  stop(): void {
    this.pendingSelect = undefined
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
      const state = this.state(node), mode = state.retryMode ?? 'keep'
      node.error = undefined
      node.load = 'none'
      if (mode === 'reconcile') this.holdPaging(node)
      node.rev++
      this.loadFirst(node, mode, 'user', !!state.deep)
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
    // A selection the user made wins over one a reconcile still waits to make.
    this.pendingSelect = undefined
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
    const state = this.state(node)
    state.held = state.reconciling = state.pendingMode = state.deep = undefined
    // The filtered list is not the one a reconcile was to select a child from.
    if (this.pendingSelect?.folder === node.id) this.pendingSelect = undefined
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
    const loaded = this.loadedCount(node), total = Math.max(node.total ?? 0, loaded)
    const message = node.error?.message ?? ''
    switch (rowKindOf(rowId)) {
      case RowKind.Loading: return 'Loading…'
      case RowKind.More: return `Loading… ${count(loaded)} of ${count(total)}`
      case RowKind.Stopped: return `Stopped after ${count(loaded)} of ${count(total)} items. Press Enter to continue loading.`
      case RowKind.Capped: return `Showing the first ${count(loaded)} of ${count(total)} items in ${node.label}. Use Filter Settings to narrow the list.`
      case RowKind.Paused: return `Loading paused: Object Explorer holds ${count(this.limits.nodeBudget)} items. Collapse other folders or filter this one. Press Enter to continue.`
      case RowKind.MoreError: return `Could not load more: ${message} Press Enter to retry.`
      case RowKind.Error: {
        const prefix = this.states.get(node.id)?.retryMode === 'reconcile' ? 'Refresh failed: ' : ''
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
    const node = this.createNode(0, connection.id, serverRef, 'server', undefined, 0, connection.displayName || connection.server, 'svg:server')
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
    // A lost root never loads again (reconnecting adds a new one); this only lets go of the rows a reconcile held.
    const state = this.state(root)
    state.pendingMode = state.retryMode = state.deep = state.held = state.reconciling = undefined
    root.rev++
    if (this.selected !== undefined && this.within(rowOwner(this.selected), root.id)) this.selected = root.id
  }

  // Loading

  private ensureLoading(node: TreeNode, priority: LoadPriority): void {
    if (!node.expanded || this.running.has(node.id)) return
    if (node.load === 'none' || node.load === 'loading') { const state = this.state(node); this.loadFirst(node, state.pendingMode ?? 'keep', priority, !!state.deep) }
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
  private loadFirst(node: TreeNode, mode: FirstMode, priority: LoadPriority, deep = false): void {
    const previous = this.running.get(node.id)
    if (previous) { this.running.delete(node.id); this.loader.abort(previous.task) }
    const state = this.state(node)
    state.pendingMode = mode
    state.deep = deep || undefined
    const running: Running = {
      mode, deep, task: this.loader.enqueue({ connectionId: node.connectionId, nodeId: node.id, generation: node.generation, params: this.params(node) }, priority, outcome => this.guard(() => this.settled(node.id, running, outcome)))
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
      mode: 'more', deep: false, task: this.loader.enqueue({ connectionId: node.connectionId, nodeId: node.id, generation: node.generation, params: this.params(node, node.cursor) }, priority, outcome => this.guard(() => this.settled(node.id, running, outcome)))
    }
    this.running.set(node.id, running)
  }
  /** Continues a folder in the background while it is expanded, below the folder cap and within the node budget. */
  private capOrContinue(node: TreeNode): void {
    if (!node.cursor) { node.more = 'none'; return }
    if (this.loadedCount(node) >= this.limits.folderCap) { node.cursor = undefined; node.more = 'capped'; return }
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
      else if (running.mode === 'reconcile') this.reconcileFirst(node, outcome.result.nodes, outcome.result.cursor, outcome.result.total, running.deep)
      else this.firstPage(node, outcome.result.nodes, outcome.result.cursor, outcome.result.total)
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
  private firstPage(node: TreeNode, wires: readonly WireNode[], cursor: string | undefined, total: number | undefined): void {
    const truncated = this.replaceChildren(node, wires)
    const state = this.state(node)
    state.pendingMode = state.retryMode = state.deep = state.held = state.reconciling = undefined
    Object.assign(node, { total, cursor: truncated ? undefined : cursor, load: 'loaded', error: undefined, more: truncated ? 'capped' : 'none' })
    node.rev++
    if (!node.children!.length) {
      node.hasChildren = false
      node.expanded = false
      this.announce(`${node.label}: no items`)
    } else if (cursor && total !== undefined) this.announce(`${node.label}: loaded ${count(node.children!.length)} of ${count(total)}`)
    if (!truncated) this.capOrContinue(node)
  }
  private appendPage(node: TreeNode, wires: readonly WireNode[], cursor: string | undefined): void {
    const reconciling = this.states.get(node.id)?.reconciling
    const truncated = reconciling ? this.reconcileRows(node, reconciling, wires, cursor) : this.addChildren(node, wires)
    node.cursor = truncated ? undefined : cursor
    node.error = undefined
    node.rev++
    if (truncated) node.more = 'capped'
    else this.capOrContinue(node)
  }
  /** A reconcile's first page: the old children wait to be matched by this page and the folder's later ones. */
  private reconcileFirst(node: TreeNode, wires: readonly WireNode[], cursor: string | undefined, total: number | undefined, deep: boolean): void {
    const reconciling: Reconciling = { old: node.children ?? [], next: 0, skipped: new Set(), takenAhead: new Set(), rows: [], added: 0, deep }
    const state = this.state(node)
    state.pendingMode = state.retryMode = state.deep = state.held = undefined
    state.reconciling = reconciling
    node.staticCount = wires.reduce((sum, wire) => sum + (wire.ref.type === 'folder' ? 1 : 0), 0)
    const truncated = this.reconcileRows(node, reconciling, wires, cursor)
    Object.assign(node, { total, cursor: truncated ? undefined : cursor, load: 'loaded', error: undefined, more: truncated ? 'capped' : 'none' })
    node.rev++
    if (!node.children!.length) {
      node.hasChildren = false
      node.expanded = false
      this.announce(`${node.label}: no items`)
    }
    if (!truncated) this.capOrContinue(node)
  }
  /**
   * Matches a page against the old children still waiting: a match keeps its node, the rest are created after the rows
   * already matched, and the waiting rows stay after them. The folder's last page, or its cap, removes the rows still
   * waiting and announces what changed. True when rows were cut at the cap.
   */
  private reconcileRows(node: TreeNode, reconciling: Reconciling, wires: readonly WireNode[], cursor: string | undefined): boolean {
    const { rows } = reconciling, reused: TreeNode[] = []
    const select = this.pendingSelect?.folder === node.id ? this.pendingSelect : undefined
    let created = 0, truncated = false, selected: TreeNode | undefined
    for (const wire of wires) {
      if (rows.length >= this.limits.folderCap) { truncated = true; break }
      const old = this.takeMatch(reconciling, node, wire)
      const child = old ?? this.createChild(node, wire)
      if (old) { reused.push(old); this.updateChild(old, wire) } else created++
      rows.push(child)
      if (select && !selected && wire.ref.type === 'object' && wire.ref.object.name === select.name && refKey(node.connectionId, wire.ref) === select.key) selected = child
    }
    const { old, next, skipped, takenAhead } = reconciling
    const rest = takenAhead.size ? old.slice(next).filter(child => !takenAhead.has(child)) : old.slice(next)
    const waiting = skipped.size ? [...skipped, ...rest] : rest
    reconciling.added += created
    this.addDescendants(node, created)
    const done = truncated || !cursor || rows.length >= this.limits.folderCap
    if (done) {
      this.state(node).reconciling = undefined
      node.children = rows
      if (waiting.length) this.detach(node, waiting, false)
      const changes = [reconciling.added ? `${count(reconciling.added)} added` : '', waiting.length ? `${count(waiting.length)} removed` : ''].filter(Boolean)
      if (changes.length && rows.length) this.announce(`${node.label}: ${changes.join(', ')}`)
    } else node.children = waiting.length ? rows.concat(waiting) : rows.slice()
    if (select && (selected || done)) {
      this.pendingSelect = undefined
      this.selected = selected?.id ?? node.id
      this.reveals++
    }
    for (const child of reused) this.reconcileBelow(child, reconciling.deep)
    return truncated
  }
  /**
   * Takes the waiting old child whose refKey is the page row's, if any: the next old row, or one a few rows on (the rows
   * passed keep waiting), else any waiting row with that name.
   */
  private takeMatch(reconciling: Reconciling, parent: TreeNode, wire: WireNode): TreeNode | undefined {
    const { old, takenAhead } = reconciling, ref = wire.ref
    while (reconciling.next < old.length && takenAhead.delete(old[reconciling.next])) reconciling.next++
    let key: string | undefined
    const same = (candidate: TreeNode) => candidate.ref.type === ref.type
      && (ref.type === 'folder' ? candidate.folder === ref.folder : candidate.ref.type === 'object' && candidate.ref.object.name === ref.object.name)
      && refKey(candidate.connectionId, candidate.ref) === (key ??= refKey(parent.connectionId, ref))
    for (let at = reconciling.next, end = Math.min(old.length, at + reconcileLookahead); at < end; at++) {
      const candidate = old[at]
      if (takenAhead.has(candidate) || !same(candidate)) continue
      for (let pass = reconciling.next; pass < at; pass++) if (!takenAhead.delete(old[pass])) reconciling.skipped.add(old[pass])
      reconciling.next = at + 1
      if (reconciling.index) this.unindex(reconciling.index, candidate)
      return candidate
    }
    const index = reconciling.index ?? (reconciling.index = this.indexOf(reconciling))
    const bucket = ref.type === 'folder' ? index.folders.get(ref.folder) : index.objects.get(ref.object.name ?? '')
    const found = Array.isArray(bucket) ? bucket.find(same) : bucket && same(bucket) ? bucket : undefined
    if (!found) return undefined
    this.unindex(index, found)
    if (!reconciling.skipped.delete(found)) takenAhead.add(found)
    return found
  }
  /** The old rows still waiting, by name, and folders by folder id. */
  private indexOf(reconciling: Reconciling): NonNullable<Reconciling['index']> {
    const objects = new Map<string, TreeNode | TreeNode[]>(), folders = new Map<string, TreeNode>()
    const add = (child: TreeNode) => {
      const ref = child.ref
      if (ref.type === 'folder') { folders.set(ref.folder, child); return }
      const name = ref.object.name ?? '', bucket = objects.get(name)
      if (!bucket) objects.set(name, child)
      else if (Array.isArray(bucket)) bucket.push(child)
      else objects.set(name, [bucket, child])
    }
    for (const child of reconciling.skipped) add(child)
    const { old, takenAhead } = reconciling
    for (let at = reconciling.next; at < old.length; at++) if (!takenAhead.has(old[at])) add(old[at])
    return { objects, folders }
  }
  private unindex(index: NonNullable<Reconciling['index']>, node: TreeNode): void {
    const ref = node.ref
    if (ref.type === 'folder') { if (index.folders.get(ref.folder) === node) index.folders.delete(ref.folder); return }
    const name = ref.object.name ?? '', bucket = index.objects.get(name)
    if (bucket === node) index.objects.delete(name)
    else if (Array.isArray(bucket)) {
      const at = bucket.indexOf(node)
      if (at >= 0) bucket.splice(at, 1)
      if (!bucket.length) index.objects.delete(name)
    }
  }
  /** A child that is still there takes the page's label and state; a new subtype, or no children any more, drops its children. */
  private updateChild(node: TreeNode, wire: WireNode): void {
    let changed = false
    if (node.label !== wire.label) { node.label = wire.label; node.lower = wire.label.toLocaleLowerCase(); changed = true }
    if (node.sublabel !== wire.sublabel) { node.sublabel = wire.sublabel; changed = true }
    if (node.detail !== wire.detail) { node.detail = wire.detail; changed = true }
    if (node.icon !== wire.icon) { node.icon = wire.icon; changed = true }
    if (node.status !== wire.status) { node.status = wire.status; changed = true }
    if (node.created !== wire.created) { node.created = wire.created; changed = true }
    // The subtype picks the folders below (a table's history row), so they are listed again.
    const subtype = node.subtype !== wire.subtype
    if (subtype) { node.subtype = wire.subtype; changed = true }
    // A row that never had a chevron has nothing to drop (most rows of a big folder of leaves), and walking every pending
    // load for each of them would make a reconcile's pages as slow as the queue is long.
    if (subtype || (!wire.hasChildren && (node.hasChildren || node.children !== undefined))) this.forget(node)
    if (node.hasChildren !== wire.hasChildren) {
      node.hasChildren = wire.hasChildren
      // An empty folder gets its chevron back and lists its rows again when expanded.
      if (!wire.hasChildren) node.expanded = false
      else if (!node.children?.length) node.load = 'none'
      changed = true
    }
    if (changed) node.rev++
  }
  /** Drops a node's children, paging and loads, so it lists them again when expanded. */
  private forget(node: TreeNode): void {
    node.generation++
    this.abortWithin(new Set([node.id]), 'detach')
    this.detach(node, node.children ?? [])
    Object.assign(node, { children: undefined, total: undefined, cursor: undefined, staticCount: 0, load: 'none', more: 'none', error: undefined })
    const state = this.state(node)
    state.pendingMode = state.retryMode = state.deep = state.budgetExempt = state.held = state.reconciling = undefined
    node.rev++
  }
  /**
   * Below a child a reconcile kept: an expanded one that lost its rows loads them again, one that could not load drops
   * its error and loads again (what failed may be fixed: access granted, MULTI_USER set), and a deep reconcile reloads
   * expanded ones too (in the background, after the user's loads) and has collapsed ones reconcile when next expanded.
   */
  private reconcileBelow(child: TreeNode, deep: boolean): void {
    // A first page asked for while the reconcile waited (the user expanded the row) is new enough: it keeps its place in
    // the queue and its priority.
    const running = this.running.get(child.id)
    if (running && running.mode !== 'more') return
    const failed = child.load === 'error'
    if (deep && (child.expanded || child.children?.length)) this.reconcileNode(child, { deep: true }, 'background')
    else if (failed && child.children?.length) this.reconcileNode(child, {}, 'background')
    else {
      if (failed) { child.error = undefined; child.load = 'none'; this.state(child).retryMode = undefined; child.rev++ }
      if (child.expanded && child.load === 'none') this.ensureLoading(child, 'background')
    }
  }
  /** Children shown that a load brought: during a reconcile, not the old rows still waiting. */
  private loadedCount(node: TreeNode): number {
    return this.states.get(node.id)?.reconciling?.rows.length ?? node.children?.length ?? 0
  }
  private failed(node: TreeNode, error: NodeError, mode: PageMode, partial: readonly WireNode[]): void {
    const state = this.state(node)
    if (mode === 'more') {
      node.more = 'error'
    } else {
      // A refresh keeps its old rows; other loads show the static folders that did not need the failed query.
      if (mode === 'keep' && partial.length) this.replaceChildren(node, partial)
      state.retryMode = mode
      state.pendingMode = undefined
      node.load = 'error'
      node.more = 'none'
      if (mode === 'reconcile') this.restorePaging(node)
    }
    node.error = error
    node.rev++
    this.announce(`Could not load ${node.label}: ${error.message}`)
    if (this.pendingSelect?.folder === node.id && mode !== 'more') { this.pendingSelect = undefined; this.selected = node.id }
  }

  /** Replaces a node's children with a first page, reusing existing static folders with the same id. */
  private replaceChildren(node: TreeNode, wires: readonly WireNode[]): boolean {
    const old = node.children ?? []
    const reuse = new Map<FolderId, TreeNode>()
    for (const child of old) if (child.folder) reuse.set(child.folder, child)
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
        && owner.parent?.schema === base.parent?.schema && owner.parent?.kind === base.parent?.kind && owner.ssisFolder === base.ssisFolder && owner.ssisProject === base.ssisProject) {
        (ref as Mutable<typeof ref>).owner = base
      }
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

  /**
   * Starts a reconcile: an expanded node (or one `select` opens) loads its first page while its old rows stay; a collapsed
   * one keeps its rows and reconciles when next expanded. A reconcile the user started (not one below it) says so.
   */
  private reconcileNode(node: TreeNode | undefined, options: ReconcileOptions, priority: LoadPriority = 'user'): void {
    if (!node || node.lost || !this.attached(node)) return
    node.generation++
    this.abortWithin(new Set([node.id]), 'detach')
    const state = this.state(node), deep = !!options.deep
    state.budgetExempt = state.retryMode = undefined
    // Rows a reconcile in progress had not matched yet are still children: this one matches them again (held, its state
    // comes back if this one stops before its first page).
    this.holdPaging(node)
    node.error = undefined
    if (node.load === 'error') node.load = node.children?.length ? 'loaded' : 'none'
    // A node that listed nothing has no expander. Varia's own change opens the folder on what it made; a background
    // reconcile (a probe saw a change) never opens anything: the node only gets its expander back, and lists when opened.
    if (options.background && !node.hasChildren && node.children !== undefined) { node.hasChildren = true; node.load = 'none' }
    else if (node.kind === 'folder' && !node.hasChildren) { node.hasChildren = true; node.expanded = true }
    if (options.select && node.hasChildren) node.expanded = true
    // A node never listed (one that could not load, say) has its first load, with nothing to announce as added.
    if (node.expanded) this.loadFirst(node, node.children !== undefined || this.pendingSelect?.folder === node.id ? 'reconcile' : 'keep', priority, deep)
    else if (node.children?.length) {
      node.load = 'none'
      state.pendingMode = 'reconcile'
      state.deep = deep || undefined
    }
    node.rev++
    if (priority !== 'user') return
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
    const state = this.state(node)
    if (node.children?.length && (node.cursor || node.more === 'capped')) state.held = { cursor: node.cursor, capped: node.more === 'capped', total: node.total, reconciling: state.reconciling }
    state.reconciling = undefined
    Object.assign(node, { cursor: undefined, more: 'none' })
  }
  /** A refresh that stopped or failed: the old rows say again how far they had got, stopped rather than loading. */
  private restorePaging(node: TreeNode): void {
    const state = this.states.get(node.id), held = state?.held
    if (!held) return
    state.held = undefined
    if (!node.children?.length) return
    node.total = held.total
    if (held.cursor) { node.cursor = held.cursor; node.more = 'stopped'; state.reconciling = held.reconciling } else if (held.capped) node.more = 'capped'
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
  private detach(node: TreeNode, children: readonly TreeNode[], listed = true): void {
    if (!children.length) return
    let removed = 0
    for (const child of children) {
      removed += 1 + child.descendants
      child.detached = true
    }
    this.abortDetached()
    // Unless the caller took them out of the children already (`listed` false).
    if (listed && node.children) node.children = node.children.length === children.length ? [] : node.children.filter(child => !child.detached)
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
      if (this.attached(node)) this.forget(node)
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
