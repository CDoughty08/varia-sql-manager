import type { ApiResult } from '../../../shared/contracts'
import { explorerLimits, kindSpecs, type NodeKind } from '../../../shared/explorer/catalog.ts'
import {
  dependencyKindWord, dependencyLimits, dependencyTypeWord, isDependencyKind, type DependenciesParams, type DependenciesResult, type DependencyDirection, type DependencyLeaf
} from '../../../shared/explorer/dependencies.ts'
import type { PeekDependency } from '../../../shared/explorer/peek.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'

export type DependencyLoad = 'none' | 'loading' | 'ready' | 'error'
/** One node of View Dependencies' tree: the selected object (id 0, no `item`) or one of its dependencies, at `depth` below it. */
export interface DependencyNode {
  readonly id: number
  readonly parent?: number
  readonly depth: number
  /** The row the backend sent; absent for the root. */
  readonly item?: PeekDependency
  /** The object in this connection, for the kinds the tree can read, select in Object Explorer or peek; absent for the rest. */
  readonly ref?: ObjectRef
  /** server.database.schema.name, as far as known; a trigger as schema.table.trigger. */
  readonly label: string
  readonly type: string
  /** Foreign key, schema-bound or non-schema-bound; absent for the root. */
  readonly dependencyType?: string
  /** Why the node is not expanded; absent when it can be. */
  readonly leaf?: DependencyLeaf
  readonly expanded: boolean
  readonly load: DependencyLoad
  readonly error?: string
  readonly children?: readonly number[]
  /** The level had more objects than it lists (`dependencyLimits.perLevel`), or the tree was full (`dependencyLimits.nodes`). */
  readonly truncated?: 'level' | 'nodes'
}
/** A visible row: a node and whether it is the last of its siblings (for the tree lines and aria-setsize). */
export interface DependencyRow { readonly node: DependencyNode; readonly index: number; readonly count: number }

export interface DependencyLoader {
  load(params: DependenciesParams): Promise<ApiResult<DependenciesResult>>
  cancel(requestIds: readonly string[]): void
}

/** The status line below an expanded node: its level loading or failed, read but empty, or cut. A level cut because the tree
 *  was full is never called empty, since its objects were read, just not kept. */
export function levelStatus(node: DependencyNode): 'loading' | 'error' | 'empty' | 'level' | 'nodes' | undefined {
  if (!node.expanded) return undefined
  if (node.load === 'loading' || node.load === 'error') return node.load
  if (node.load !== 'ready') return undefined
  return node.truncated ?? (node.children?.length ? undefined : 'empty')
}

const kindTitle =(kind: NodeKind) => kindSpecs[kind].title
/** The identity of an object on a branch: two nodes with the same key are one object, so the lower one is a cycle. */
export const objectKey = (ref: ObjectRef): string => JSON.stringify([ref.kind, ref.schema ?? null, ref.parent?.kind ?? null, ref.parent?.schema ?? null, ref.parent?.name ?? null, ref.name ?? null])

/** The object a dependency names in the root's database, when the tree can read it there (a kind it describes, named fully). */
export function dependencyRef(item: PeekDependency, database: string | undefined): ObjectRef | undefined {
  if (item.server !== undefined || item.database !== undefined || item.kind === undefined) return undefined
  const at = database === undefined ? {} : { database }
  const scope = kindSpecs[item.kind].scope
  if (scope === 'schemaObject' && item.schema !== undefined) return { kind: item.kind, ...at, schema: item.schema, name: item.name }
  if (scope === 'child' && item.parent) return { kind: item.kind, ...at, parent: item.parent, name: item.name }
  return undefined
}
const labelOf = (item: PeekDependency) => item.parent
  ? [item.parent.schema, item.parent.name, item.name].join('.')
  : [item.server, item.database, item.schema, item.name].filter(part => part !== undefined).join('.')

/**
 * View Dependencies' tree for one direction: the root is the selected object, expanded at once; every other node reads its level
 * (explorer.dependencies) the first time it is expanded, never before. A node is a leaf, with the reason, when its object is on a
 * linked server or in another database (named only), unresolved, of a kind the tree cannot read, already above it on its branch
 * (a cycle, marked rather than followed), or `dependencyLimits.depth` levels down. Each level keeps at most
 * `dependencyLimits.perLevel` objects and the tree `dependencyLimits.nodes`, both marked when cut. `dispose` cancels the reads
 * still running and drops their answers.
 */
export class DependencyTree {
  private readonly nodes = new Map<number, DependencyNode>()
  private readonly running = new Map<number, string>()
  private next = 1
  private disposed = false
  /** Abandoned (the server was lost): the tree still expands and collapses what it has read, but reads nothing more. */
  private stopped = false

  constructor(
    readonly connectionId: string,
    readonly root: ObjectRef,
    rootLabel: string,
    rootType: string,
    readonly direction: DependencyDirection,
    private readonly loader: DependencyLoader,
    private readonly onChange: () => void,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {
    this.nodes.set(0, { id: 0, depth: 0, ref: root, label: rootLabel, type: rootType, expanded: false, load: 'none' })
    this.expand(0)
  }

  get size(): number { return this.nodes.size }
  node(id: number): DependencyNode | undefined { return this.nodes.get(id) }

  /** Whether a node can be expanded: no leaf reason, and not expanded already. */
  canExpand(id: number): boolean { const node = this.nodes.get(id); return !!node && !node.leaf && !node.expanded }

  /** Expands a node, reading its level the first time (and again after a failure). */
  expand(id: number): void {
    const node = this.nodes.get(id)
    if (this.disposed || !node || node.leaf || node.expanded && node.load !== 'error') return
    // Once stopped, a failed level only opens again to show why: it cannot be read again.
    if (node.load === 'ready' || node.load === 'loading' || this.stopped && node.load === 'error') { this.set({ ...node, expanded: true }); return }
    if (this.stopped) return
    this.set({ ...node, expanded: true, load: 'loading', error: undefined })
    void this.read(node)
  }
  collapse(id: number): void {
    const node = this.nodes.get(id)
    if (!node?.expanded) return
    this.set({ ...node, expanded: false })
  }
  /** Reads a failed level again. */
  retry(id: number): void {
    const node = this.nodes.get(id)
    if (node?.load !== 'error') return
    this.set({ ...node, expanded: false, load: 'none' })
    this.expand(id)
  }

  /** The rows shown: the root, then each expanded node's children in order. */
  rows(): DependencyRow[] {
    const rows: DependencyRow[] = []
    const walk = (id: number, index: number, count: number) => {
      const node = this.nodes.get(id)
      if (!node) return
      rows.push({ node, index, count })
      if (node.expanded && node.children) node.children.forEach((child, at) => walk(child, at, node.children!.length))
    }
    walk(0, 0, 1)
    return rows
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelRunning()
  }

  /** Stops reading for good (the server was lost): the levels still loading show `message`, nothing more is read, and what was
   *  read can still be expanded and collapsed. */
  abandon(message: string): void {
    if (this.disposed || this.stopped) return
    this.stopped = true
    const loading = [...this.running.keys()]
    this.cancelRunning()
    for (const id of loading) {
      const node = this.nodes.get(id)
      if (node?.load === 'loading') this.nodes.set(id, { ...node, load: 'error', error: message })
    }
    if (loading.length) this.onChange()
  }

  private cancelRunning(): void {
    const ids = [...this.running.values()]
    this.running.clear()
    // explorer.cancel takes at most `explorerLimits.cancelBatch` ids a call; queued expansions can outnumber that.
    for (let at = 0; at < ids.length; at += explorerLimits.cancelBatch) this.loader.cancel(ids.slice(at, at + explorerLimits.cancelBatch))
  }

  private set(node: DependencyNode): void {
    this.nodes.set(node.id, node)
    if (!this.disposed) this.onChange()
  }

  private async read(node: DependencyNode): Promise<void> {
    const requestId = this.newId()
    this.running.set(node.id, requestId)
    let result: ApiResult<DependenciesResult>
    try {
      result = await this.loader.load({ connectionId: this.connectionId, requestId, target: node.ref!, direction: this.direction })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'The dependencies could not be read.' }
    }
    if (this.disposed || this.running.get(node.id) !== requestId) return
    this.running.delete(node.id)
    const current = this.nodes.get(node.id)
    if (!current) return
    if (!result.ok || result.value.error) {
      this.set({ ...current, load: 'error', error: result.ok ? result.value.error!.message : result.error })
      return
    }
    const ancestors = new Set<string>()
    for (let at: DependencyNode | undefined = current; at; at = at.parent === undefined ? undefined : this.nodes.get(at.parent)) if (at.ref) ancestors.add(objectKey(at.ref))
    const room = Math.max(0, dependencyLimits.nodes - this.nodes.size)
    const items = result.value.items.slice(0, room)
    const children = items.map(item => {
      const id = this.next++
      const ref = dependencyRef(item, this.root.database)
      const depth = current.depth + 1
      const leaf: DependencyLeaf | undefined = item.server !== undefined ? 'linkedServer'
        : item.database !== undefined ? 'otherDatabase'
          : item.type === undefined && item.kind === undefined ? 'unresolved'
            : !ref || !isDependencyKind(ref.kind) ? 'notListed'
              : ancestors.has(objectKey(ref)) ? 'cycle'
                : depth >= dependencyLimits.depth ? 'depth' : undefined
      const child: DependencyNode = {
        id, parent: current.id, depth, item, ...(ref ? { ref } : {}), label: labelOf(item), type: dependencyTypeWord(item, kindTitle), dependencyType: dependencyKindWord(item),
        ...(leaf ? { leaf } : {}), expanded: false, load: 'none'
      }
      this.nodes.set(id, child)
      return id
    })
    const truncated = items.length < result.value.items.length ? 'nodes' as const : result.value.truncated ? 'level' as const : undefined
    this.set({ ...current, load: 'ready', children, ...(truncated ? { truncated } : {}) })
  }
}
