import type { VariaApi } from '../../../shared/contracts'
import { kindSpecs, type FolderId, type NodeSubtype } from '../../../shared/explorer/catalog.ts'
import { isDependencyKind, type DependencyDirection } from '../../../shared/explorer/dependencies.ts'
import { isPeekKind } from '../../../shared/explorer/peek.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ObjectSearchHit } from '../../../shared/explorer/search.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode, ObjectMenuNode } from '../menus/targets'
import type { LiveConnection } from '../services/connections'
import { DependencyTree, type DependencyNode, type DependencyRow } from './dependency-tree'

export interface OpenDependencies {
  /** Changes with every dialog, so the form remounts. */
  readonly id: number
  readonly connectionId: string
  /** The Object Explorer node the dialog was opened for. */
  readonly root: ExplorerMenuNode
  readonly direction: DependencyDirection
  readonly rows: readonly DependencyRow[]
  readonly selected: number
  /** The server was lost: the tree stays as it was, and nothing more is read. */
  readonly lost?: boolean
}
export interface DependenciesSnapshot { readonly open?: OpenDependencies }
export interface DependenciesServiceOptions {
  readonly api: Pick<VariaApi, 'explorerDependencies' | 'explorerCancel'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: {
    menuNode(id: number | undefined): ExplorerMenuNode | undefined
    select(id: number, options?: { readonly reveal?: boolean }): void
    objectNode(connectionId: string, object: ObjectRef, label: string, subtype?: NodeSubtype): ObjectMenuNode
  }
  /** Shows a dependency in Object Explorer (Search Objects' Reveal: the tree walks and pages its way there). */
  readonly reveal: (connectionId: string, hit: ObjectSearchHit) => void
  /** Opens Peek on a node, as a tab: the dialog closes first. */
  readonly peek: (node: ExplorerMenuNode) => void
  readonly newId?: () => string
}

/** The Object Explorer folder that lists an object of a kind and subtype, as Search Objects' Reveal walks to it. */
export function listingFolder(ref: ObjectRef, subtype?: NodeSubtype): FolderId | undefined {
  switch (ref.kind) {
    // A temporal or ledger history table is listed below its table, which a dependency does not name: it cannot be revealed.
    case 'table': return subtype === 'history' || subtype === 'ledgerHistory' ? undefined : subtype === 'system' ? 'systemTables' : subtype === 'fileTable' ? 'fileTables' : subtype === 'external' ? 'externalTables'
      : subtype === 'graphNode' || subtype === 'graphEdge' ? 'graphTables' : subtype === 'droppedLedger' ? 'droppedLedgerTables' : 'tables'
    case 'view': return subtype === 'system' ? 'systemViews' : subtype === 'droppedLedger' ? 'droppedLedgerViews' : 'views'
    case 'procedure': return subtype === 'system' || subtype === 'extended' ? 'systemStoredProcedures' : 'storedProcedures'
    case 'function': return subtype === 'scalar' || subtype === 'clrScalar' ? 'scalarValuedFunctions' : subtype === 'aggregate' ? 'aggregateFunctions' : 'tableValuedFunctions'
    case 'synonym': return 'synonyms'
    case 'sequence': return 'sequences'
    case 'tableType': return 'userDefinedTableTypes'
    case 'type': return subtype === 'clr' ? 'userDefinedTypes' : 'userDefinedDataTypes'
    case 'trigger': return 'tableTriggers'
    default: return undefined
  }
}

const root = (open: OpenDependencies): ObjectRef | undefined => open.root.ref.type === 'object' ? open.root.ref.object : undefined
const sameObject = (parent: NonNullable<ObjectRef['parent']>, object: ObjectRef) => parent.kind === object.kind && parent.schema === object.schema && parent.name === object.name

/**
 * View Dependencies (SSMS's dialog of that name): at most one open, for an object of a `dependencyKinds` kind on a live server.
 * It holds one `DependencyTree` for the chosen direction; changing the choice drops that tree (its reads cancelled) and starts
 * the other from the root. Enter or a double-click on a node selects it in Object Explorer (the root's own row, or a dependency
 * through Search Objects' Reveal) and closes the dialog; Peek opens a node's Peek tab. Losing the server keeps the tree but reads
 * nothing more. Failures are values in the tree; nothing throws into React.
 */
export class DependenciesService extends SnapshotStore<DependenciesSnapshot> implements Disposable {
  private tree?: DependencyTree
  private dialogs = 0
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly options: DependenciesServiceOptions) {
    super({})
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (error) { onUnexpectedError(error) } })
  }

  get current(): OpenDependencies | undefined { return this.getSnapshot().open }

  /** Whether the dialog can open on a node: an object of a kind it lists, on a live server. */
  canOpen(node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    return !!node && node.ref.type === 'object' && node.kind !== 'folder' && isDependencyKind(node.kind) && !node.lost && this.live(node.connectionId)
  }

  open(node: ExplorerMenuNode | undefined): void {
    if (this.disposed || !this.canOpen(node)) return
    this.dropTree()
    const open: OpenDependencies = { id: ++this.dialogs, connectionId: node.connectionId, root: node, direction: 'usedBy', rows: [], selected: 0 }
    this.publish({ open })
    this.plant(open)
  }

  close(): void {
    this.dropTree()
    if (this.current) this.publish({})
  }

  setDirection(direction: DependencyDirection): void {
    const open = this.current
    // Once the server is lost the tree stays as it was: the other choice could not be read.
    if (!open || open.direction === direction || open.lost) return
    this.dropTree()
    const next = { ...open, direction, rows: [], selected: 0 }
    this.publish({ open: next })
    if (!open.lost) this.plant(next)
  }

  select(id: number): void {
    const open = this.current
    if (open && open.selected !== id && this.tree?.node(id)) this.publish({ open: { ...open, selected: id } })
  }
  expand(id: number): void { this.tree?.expand(id) }
  collapse(id: number): void { this.tree?.collapse(id) }
  retry(id: number): void { if (!this.current?.lost) this.tree?.retry(id) }
  node(id: number): DependencyNode | undefined { return this.tree?.node(id) }

  /** Whether a node can be shown in Object Explorer: the root, or a dependency named in the root's database. */
  canReveal(id: number): boolean {
    const node = this.tree?.node(id)
    return !!node && !!node.ref && (id === 0 && !!this.options.explorer.menuNode(this.current?.root.id) || listingFolder(node.ref, id === 0 ? this.current?.root.subtype : node.item?.subtype) !== undefined)
  }
  /** Selects the node in Object Explorer and closes the dialog. */
  reveal(id: number): void {
    const open = this.current, node = this.tree?.node(id)
    if (!open || !node || !this.canReveal(id) || open.lost) return
    this.close()
    if (id === 0 && this.options.explorer.menuNode(open.root.id)) { this.options.explorer.select(open.root.id, { reveal: true }); return }
    // The root's own subtype only for the root: a dependency without one is a plain object, whatever the root is.
    const subtype = id === 0 ? open.root.subtype : node.item?.subtype
    const ref = node.ref!, folder = listingFolder(ref, subtype)!
    // A trigger is listed below its table's folder (Graph Tables, FileTables …): the root's when it is the root, else its row's.
    const parentFolder = !ref.parent ? undefined : root(open) && sameObject(ref.parent, root(open)!) ? listingFolder(root(open)!, open.root.subtype)
      : listingFolder({ kind: ref.parent.kind, schema: ref.parent.schema, name: ref.parent.name }, node.item?.parentSubtype)
    this.options.reveal(open.connectionId, { object: ref, folder, label: node.label, ...(subtype ? { subtype } : {}), ...(parentFolder ? { parentFolder } : {}) })
  }

  /** Whether a node can be peeked: an object of a kind Peek describes, named in the root's database. */
  canPeek(id: number): boolean {
    const node = this.tree?.node(id)
    return !!node?.ref && isPeekKind(node.ref.kind) && !this.current?.lost
  }
  /** Opens Peek on the node (as a tab) and closes the dialog. */
  peek(id: number): void {
    const open = this.current, node = this.tree?.node(id)
    if (!open || !node?.ref || !this.canPeek(id)) return
    const target: ExplorerMenuNode = id === 0 ? open.root
      : { ...this.options.explorer.objectNode(open.connectionId, node.ref, node.label, node.item?.subtype), id: open.root.id }
    this.close()
    this.options.peek(target)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dropTree()
    this.unsubscribe()
    this.clearListeners()
  }

  private plant(open: OpenDependencies): void {
    const root = open.root
    if (root.ref.type !== 'object') return
    const type = kindSpecs[root.ref.object.kind].title
    // The tree starts reading its root as it is made, before `this.tree` names it: changes until then show with the first publish.
    let made: DependencyTree | undefined
    const tree = new DependencyTree(open.connectionId, root.ref.object, root.label, type, open.direction, {
      load: params => this.options.api.explorerDependencies(params),
      cancel: ids => { void this.options.api.explorerCancel(ids).catch(onUnexpectedError) }
    }, () => { if (made) this.treeChanged(made) }, this.options.newId)
    made = tree
    this.tree = tree
    this.treeChanged(tree)
  }

  private treeChanged(tree: DependencyTree): void {
    const open = this.current
    if (!open || this.tree !== tree) return
    this.publish({ open: { ...open, rows: tree.rows() } })
  }

  private dropTree(): void {
    const tree = this.tree
    this.tree = undefined
    tree?.dispose()
  }

  private live(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }

  private connectionsChanged(): void {
    const open = this.current
    if (!open || open.lost || this.live(open.connectionId)) return
    // The reads were lost with the server: keep what the tree shows, read nothing more, and end the levels still loading.
    this.tree?.abandon('The server was disconnected.')
    // abandon published the ended levels: read the snapshot again rather than the one from before it.
    this.publish({ open: { ...(this.current ?? open), lost: true } })
  }
}
