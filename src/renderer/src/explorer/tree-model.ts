// The Object Explorer tree as rows: flattening, windowing, keyboard navigation, type-ahead and the `*` plan. Pure
// functions over the node table, so they run (and are measured) in Node.
import type { ExplorerErrorCode } from '../../../shared/contracts'
import { explorerLimits, folderSpecs, kindSpecs, type ExplorerIcon, type FolderId, type NodeKind, type NodeStatus, type NodeSubtype } from '../../../shared/explorer/catalog.ts'
import type { ExplorerNodeRef } from '../../../shared/explorer/refs.ts'

export type LoadState = 'none' | 'loading' | 'loaded' | 'error'
export type MoreState = 'none' | 'auto' | 'stopped' | 'capped' | 'paused' | 'error'
/** A failed load: the backend's error value, or a request that failed before reaching it. */
export interface NodeError {
  readonly code: ExplorerErrorCode | 'REQUEST_FAILED'
  readonly message: string
  readonly retryable: boolean
  readonly action?: 'retry' | 'refreshParent'
}

/**
 * One node of the tree. ExplorerService owns and mutates it, bumping `rev` whenever something a row shows changes, so
 * rows memoized on `rev` skip work.
 */
export interface TreeNode {
  readonly id: number
  /** 0 for a server. */
  readonly parent: number
  readonly connectionId: string
  readonly ref: ExplorerNodeRef
  readonly kind: NodeKind | 'folder'
  readonly folder: FolderId | undefined
  readonly level: number
  label: string
  /** `label` in lower case, for type-ahead. */
  lower: string
  sublabel: string | undefined
  detail: string | undefined
  icon: ExplorerIcon
  subtype: NodeSubtype | undefined
  status: NodeStatus | undefined
  created: string | undefined
  hasChildren: boolean
  expanded: boolean
  /** In order; references rather than ids, so flattening and type-ahead need no table lookups. */
  children: TreeNode[] | undefined
  /** How many children are static folders (they survive a filter change). */
  staticCount: number
  /** The first page's count of every child (snapshot; it can drift). */
  total: number | undefined
  cursor: string | undefined
  /** `none` needs its first page (children, if any, are from before a refresh or filter change). */
  load: LoadState
  more: MoreState
  /** The failed first page (`load: 'error'`) or next page (`more: 'error'`). */
  error: NodeError | undefined
  /** A server whose connection failed while loading (cleared by the next successful load). */
  connectionError: NodeError | undefined
  /** A folder with a filter. */
  filtered: boolean
  /** A server whose connection was lost with its backend generation. */
  lost: boolean
  /** The first page took longer than the loading-row delay. */
  showLoading: boolean
  /** Taken out of the tree (refreshed, filtered, evicted or removed) and waiting to be deleted. */
  detached?: boolean
  generation: number
  rev: number
  lastUsed: number
  /** Nodes below this one that are in the tree. */
  descendants: number
  /** What a server row shows after its name ("16.0 · sa"); `sublabel` keeps SSMS's full text for its name and tooltip. */
  brief?: string
  /** When the first page of the children shown now arrived (epoch ms). */
  updatedAt?: number
  /** When a refresh that kept the old children failed (epoch ms); cleared by the next first page. */
  staleSince?: number
}
export interface NodeTable { get(id: number): TreeNode | undefined }

/** Rows that are not nodes: their id is −(owner id · 8 + kind). */
export const RowKind = { Node: 0, Loading: 1, Error: 2, More: 3, Stopped: 4, Capped: 5, Paused: 6, MoreError: 7 } as const
export type RowKind = typeof RowKind[keyof typeof RowKind]
export const syntheticId = (owner: number, kind: RowKind): number => -(owner * 8 + kind)
/** The node a row is, or belongs to. */
export const rowOwner = (id: number): number => id < 0 ? Math.floor(-id / 8) : id
export const rowKindOf = (id: number): RowKind => id < 0 ? (-id % 8) as RowKind : RowKind.Node

/** The visible rows in order. `posinset` and `setsize` count real children only; synthetic rows have 0. */
export interface VisibleRows {
  readonly count: number
  readonly ids: Int32Array
  readonly kinds: Uint8Array
  readonly levels: Uint8Array
  readonly posinset: Int32Array
  readonly setsize: Int32Array
  /** Each row's node; undefined for synthetic rows. */
  readonly nodes: readonly (TreeNode | undefined)[]
}
export const emptyRows: VisibleRows = { count: 0, ids: new Int32Array(0), kinds: new Uint8Array(0), levels: new Uint8Array(0), posinset: new Int32Array(0), setsize: new Int32Array(0), nodes: [] }

class RowBuilder {
  count = 0
  ids: Int32Array; kinds: Uint8Array; levels: Uint8Array; posinset: Int32Array; setsize: Int32Array
  readonly nodes: (TreeNode | undefined)[] = []
  constructor(capacity: number) {
    this.ids = new Int32Array(capacity); this.kinds = new Uint8Array(capacity); this.levels = new Uint8Array(capacity)
    this.posinset = new Int32Array(capacity); this.setsize = new Int32Array(capacity)
  }
  push(id: number, kind: RowKind, level: number, posinset: number, setsize: number, node: TreeNode | undefined): void {
    if (this.count === this.ids.length) this.grow()
    const index = this.count++
    this.ids[index] = id; this.kinds[index] = kind; this.levels[index] = level; this.posinset[index] = posinset; this.setsize[index] = setsize
    this.nodes.push(node)
  }
  private grow(): void {
    const capacity = this.ids.length * 2
    const copy = <T extends Int32Array | Uint8Array>(from: T, to: T) => { to.set(from); return to }
    this.ids = copy(this.ids, new Int32Array(capacity)); this.kinds = copy(this.kinds, new Uint8Array(capacity)); this.levels = copy(this.levels, new Uint8Array(capacity))
    this.posinset = copy(this.posinset, new Int32Array(capacity)); this.setsize = copy(this.setsize, new Int32Array(capacity))
  }
  /** Drops the rows from `mark` on: a filtered subtree with no match in it. */
  truncate(mark: number): void {
    this.count = mark
    this.nodes.length = mark
  }
  rows(): VisibleRows {
    const n = this.count
    return { count: n, ids: this.ids.subarray(0, n), kinds: this.kinds.subarray(0, n), levels: this.levels.subarray(0, n), posinset: this.posinset.subarray(0, n), setsize: this.setsize.subarray(0, n), nodes: this.nodes }
  }
}

/** A filter's text as `TreeNode.lower` is compared with it: trimmed and in lower case; '' for no filter. */
export const filterText = (text: string): string => text.trim().toLocaleLowerCase()
/** Where `filter` (from `filterText`) starts in a node's label, or −1. */
export const filterMatch = (node: Pick<TreeNode, 'lower'>, filter: string): number => filter ? node.lower.indexOf(filter) : -1

/** The row after an expanded node's children, if any. */
export function tailRow(node: TreeNode): RowKind | undefined {
  switch (node.more) {
    case 'auto': return node.cursor === undefined ? undefined : RowKind.More
    case 'stopped': return RowKind.Stopped
    case 'capped': return RowKind.Capped
    case 'paused': return RowKind.Paused
    case 'error': return RowKind.MoreError
    default: return undefined
  }
}

/**
 * Pre-order over expanded nodes, O(visible rows). An expanded node shows its load error first (old rows stay below it
 * after a failed refresh), or "Loading…" while its first page is late, then its children, then a progress, stopped,
 * capped, paused or page-error row.
 */
export function flatten(nodes: NodeTable, roots: readonly number[], capacityHint = 256): VisibleRows {
  const out = new RowBuilder(Math.max(64, capacityHint))
  const visit = (node: TreeNode, posinset: number, setsize: number) => {
    out.push(node.id, RowKind.Node, node.level, posinset, setsize, node)
    if (!node.expanded) return
    const level = node.level + 1, children = node.children
    if (node.load === 'error') out.push(syntheticId(node.id, RowKind.Error), RowKind.Error, level, 0, 0, undefined)
    else if (node.showLoading && !children?.length) out.push(syntheticId(node.id, RowKind.Loading), RowKind.Loading, level, 0, 0, undefined)
    if (children) {
      const size = Math.max(node.total ?? 0, children.length)
      for (let index = 0; index < children.length; index++) {
        const child = children[index]
        // Most children are collapsed leaves: no call for them.
        if (child.expanded) visit(child, index + 1, size)
        else out.push(child.id, RowKind.Node, child.level, index + 1, size, child)
      }
    }
    const tail = tailRow(node)
    if (tail !== undefined) out.push(syntheticId(node.id, tail), tail, level, 0, 0, undefined)
  }
  for (let index = 0; index < roots.length; index++) {
    const root = nodes.get(roots[index])
    if (root) visit(root, index + 1, roots.length)
  }
  return out.rows()
}

/**
 * The rows a filter leaves, how many of their nodes match it, and the nodes shown only for rows below them or as the
 * selection (`partial`: neither a match nor inside a match's subtree). Those list only some of their children, so a
 * folder's item count would misread beside them.
 */
export interface FilteredRows { readonly rows: VisibleRows; readonly matches: number; readonly partial: ReadonlySet<number> }
/**
 * `flatten` narrowed to the nodes whose label contains `filter` (from `filterText`). It walks expanded nodes only, so it
 * searches what has been loaded and opened, and never asks for more. A match keeps its ancestors (servers always show)
 * and shows its expanded rows below as usual; a node that neither matches nor has a match below is left out with its
 * loading and error rows. Positions in a set count the siblings that show. O(visible rows unfiltered).
 *
 * The `pinned` node (the selection) and its ancestors show too, matching or not: collapsing a node that showed only for
 * the matches below it, or typing text the selection does not match, would otherwise leave the selection off the rows,
 * where F5, copy and the footer would still act on it unseen.
 */
export function flattenFiltered(nodes: NodeTable, roots: readonly number[], filter: string, capacityHint = 256, pinned?: number): FilteredRows {
  const out = new RowBuilder(Math.max(64, capacityHint))
  const keep = new Set<number>()
  for (let node = pinned === undefined ? undefined : nodes.get(pinned); node; node = node.parent ? nodes.get(node.parent) : undefined) keep.add(node.id)
  let matches = 0
  const partial = new Set<number>()
  /** A node's synthetic rows around its children, as `flatten` places them; `each` emits one child. */
  const visitChildren = (node: TreeNode, each: (child: TreeNode, index: number, size: number) => void) => {
    const level = node.level + 1, children = node.children
    if (node.load === 'error') out.push(syntheticId(node.id, RowKind.Error), RowKind.Error, level, 0, 0, undefined)
    else if (node.showLoading && !children?.length) out.push(syntheticId(node.id, RowKind.Loading), RowKind.Loading, level, 0, 0, undefined)
    if (children) {
      const size = Math.max(node.total ?? 0, children.length)
      for (let index = 0; index < children.length; index++) each(children[index], index, size)
    }
    const tail = tailRow(node)
    if (tail !== undefined) out.push(syntheticId(node.id, tail), tail, level, 0, 0, undefined)
  }
  // A match's subtree shows whole, as without a filter; the matches in it still count. `matched`: the caller has
  // already matched the node, so each name is searched once.
  const visitAll = (node: TreeNode, posinset: number, setsize: number, matched = false) => {
    out.push(node.id, RowKind.Node, node.level, posinset, setsize, node)
    if (matched || filterMatch(node, filter) >= 0) matches++
    if (node.expanded) visitChildren(node, (child, index, size) => visitAll(child, index + 1, size))
  }
  /** Emits the node if it or a node below it matches, or it is a server or pinned; true when it did. */
  const visit = (node: TreeNode, posinset: number, setsize: number, server: boolean): boolean => {
    if (filterMatch(node, filter) >= 0) { visitAll(node, posinset, setsize, true); return true }
    const mark = out.count
    out.push(node.id, RowKind.Node, node.level, posinset, setsize, node)
    const shown: number[] = []
    if (node.expanded) {
      visitChildren(node, child => {
        const at = out.count
        if (child.expanded || keep.has(child.id) ? visit(child, 0, 0, false) : filterMatch(child, filter) >= 0) {
          if (out.count === at) { out.push(child.id, RowKind.Node, child.level, 0, 0, child); matches++ }
          shown.push(at)
        }
      })
    }
    if (!shown.length && !server && !keep.has(node.id)) { out.truncate(mark); return false }
    for (let index = 0; index < shown.length; index++) { out.posinset[shown[index]] = index + 1; out.setsize[shown[index]] = shown.length }
    partial.add(node.id)
    return true
  }
  for (let index = 0; index < roots.length; index++) {
    const root = nodes.get(roots[index])
    if (root) visit(root, index + 1, roots.length, true)
  }
  return { rows: out.rows(), matches, partial }
}

/**
 * Where rows sit: every row is `rowHeight` tall except servers (rows at level 1), which are `serverRowHeight`. Servers
 * are few, so a row's offset is its index times the row height plus the extra height of the servers above it.
 */
export interface RowLayout {
  readonly count: number
  /** The height of every row together: the spacer's. */
  readonly total: number
  top(index: number): number
  height(index: number): number
  /** The row at `offset` px from the top, clamped to the rows. */
  indexAt(offset: number): number
}
export function rowLayout(rows: Pick<VisibleRows, 'count' | 'levels'>, rowHeight: number = explorerLimits.rowHeight, serverRowHeight: number = explorerLimits.serverRowHeight): RowLayout {
  const servers: number[] = [], extra = serverRowHeight - rowHeight
  for (let index = 0; index < rows.count; index++) if (rows.levels[index] === 1) servers.push(index)
  /** How many servers sit above row `index`. */
  const above = (index: number) => {
    let low = 0, high = servers.length
    while (low < high) { const middle = (low + high) >> 1; if (servers[middle] < index) low = middle + 1; else high = middle }
    return low
  }
  const top = (index: number) => index * rowHeight + above(index) * extra
  return {
    count: rows.count,
    total: rows.count * rowHeight + servers.length * extra,
    top,
    height: index => rows.levels[index] === 1 ? serverRowHeight : rowHeight,
    indexAt(offset: number) {
      let low = 0, high = Math.max(0, rows.count - 1)
      while (low < high) { const middle = (low + high + 1) >> 1; if (top(middle) <= offset) low = middle; else high = middle - 1 }
      return low
    }
  }
}

/** The rows to render, `[first, end)`: the viewport plus `overscan` rows on each side. */
export function computeWindow(scrollTop: number, viewport: number, count: number, rowHeight: number = explorerLimits.rowHeight, overscan: number = explorerLimits.overscan): [number, number] {
  if (count <= 0 || rowHeight <= 0) return [0, 0]
  const top = Math.max(0, scrollTop), height = Math.max(0, viewport)
  const first = Math.min(count, Math.max(0, Math.floor(top / rowHeight) - overscan))
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan)
  return [first, Math.max(first, end)]
}
/** The scroll offset that brings row `index` into a `viewport` px view scrolled to `scrollTop`, or undefined when it shows. */
export function revealScroll(layout: RowLayout, index: number, scrollTop: number, viewport: number): number | undefined {
  if (index < 0 || index >= layout.count) return undefined
  const top = layout.top(index), bottom = top + layout.height(index)
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewport) return bottom - viewport
  return undefined
}
/** `computeWindow` over a layout whose rows differ in height. */
export function layoutWindow(scrollTop: number, viewport: number, layout: RowLayout, overscan: number = explorerLimits.overscan): [number, number] {
  if (layout.count <= 0) return [0, 0]
  const top = Math.max(0, scrollTop), bottom = top + Math.max(0, viewport)
  if (top >= layout.total) return [layout.count, layout.count]
  const first = Math.max(0, layout.indexAt(top) - overscan)
  return [first, Math.min(layout.count, layout.indexAt(Math.max(top, bottom - 1)) + 1 + overscan)]
}
/** The window's row indices plus the selected row, which is always rendered so `aria-activedescendant` resolves. */
export function renderedIndices([first, end]: readonly [number, number], selected: number): number[] {
  const indices: number[] = []
  if (selected >= 0 && selected < first) indices.push(selected)
  for (let index = first; index < end; index++) indices.push(index)
  if (selected >= end) indices.push(selected)
  return indices
}

/** The row index of `id`, or −1. */
export function rowIndex(rows: VisibleRows, id: number | undefined): number {
  if (id === undefined) return -1
  return rows.ids.indexOf(id)
}
/** The nearest row above `index` one level up: a node's parent, or a synthetic row's owner. */
export function parentIndex(rows: VisibleRows, index: number): number {
  const level = rows.levels[index]
  for (let row = index - 1; row >= 0; row--) if (rows.levels[row] < level) return row
  return -1
}

export type TreeKey = 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'left' | 'right' | 'enter' | 'expandSiblings' | 'expand' | 'collapse'
export type TreeAction =
  | { readonly type: 'select'; readonly index: number }
  | { readonly type: 'expand' | 'collapse' | 'toggle' | 'expandSiblings'; readonly id: number }
  /** Enter on an error row: reload, or refresh the parent of an object that is gone. */
  | { readonly type: 'retry'; readonly id: number }
  /** Enter on a stopped or paused row. */
  | { readonly type: 'continue'; readonly id: number }
  /** Enter on a capped row opens Filter Settings for its folder. */
  | { readonly type: 'filter'; readonly id: number }
  | { readonly type: 'none' }
const none: TreeAction = { type: 'none' }

/** The tree's own keys (E3), with modifiers ignored: Ctrl, Alt and Meta combinations belong to the workbench. */
export function treeKeyOf(event: { readonly key: string; readonly code?: string; readonly ctrlKey?: boolean; readonly altKey?: boolean; readonly metaKey?: boolean }): TreeKey | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey) return undefined
  if (event.code === 'NumpadAdd') return 'expand'
  if (event.code === 'NumpadSubtract') return 'collapse'
  switch (event.key) {
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    case 'ArrowLeft': return 'left'
    case 'ArrowRight': return 'right'
    case 'Home': return 'home'
    case 'End': return 'end'
    case 'PageUp': return 'pageUp'
    case 'PageDown': return 'pageDown'
    case 'Enter': return 'enter'
    case '*': return 'expandSiblings'
    default: return undefined
  }
}

const expandable = (node: TreeNode | undefined): node is TreeNode => !!node && node.hasChildren && !node.lost
/** What a key does at row `index` (−1: nothing selected). Moves never wrap. */
export function treeKey(rows: VisibleRows, index: number, key: TreeKey, pageRows: number): TreeAction {
  const last = rows.count - 1
  if (last < 0) return none
  const select = (target: number): TreeAction => ({ type: 'select', index: Math.max(0, Math.min(last, target)) })
  const page = Math.max(1, pageRows - 1)
  if (index < 0 || index > last) return key === 'end' ? select(last) : key === 'up' || key === 'down' || key === 'home' || key === 'pageUp' || key === 'pageDown' ? select(0) : none
  switch (key) {
    case 'up': return select(index - 1)
    case 'down': return select(index + 1)
    case 'home': return select(0)
    case 'end': return select(last)
    case 'pageUp': return select(index - page)
    case 'pageDown': return select(index + page)
    default: break
  }
  const id = rows.ids[index], kind = rows.kinds[index] as RowKind
  if (kind !== RowKind.Node) {
    if (key === 'left') { const parent = parentIndex(rows, index); return parent < 0 ? none : select(parent) }
    if (key !== 'enter') return none
    switch (kind) {
      case RowKind.Error: case RowKind.MoreError: return { type: 'retry', id }
      case RowKind.Stopped: case RowKind.Paused: return { type: 'continue', id: rowOwner(id) }
      case RowKind.Capped: return { type: 'filter', id: rowOwner(id) }
      default: return none
    }
  }
  const node = rows.nodes[index]
  switch (key) {
    case 'right':
      if (!expandable(node)) return none
      if (!node.expanded) return { type: 'expand', id }
      return index < last && rows.levels[index + 1] > rows.levels[index] ? select(index + 1) : none
    case 'left': {
      if (expandable(node) && node.expanded) return { type: 'collapse', id }
      const parent = parentIndex(rows, index)
      return parent < 0 ? none : select(parent)
    }
    case 'enter': return expandable(node) ? { type: 'toggle', id } : none
    case 'expand': return expandable(node) && !node.expanded ? { type: 'expand', id } : none
    case 'collapse': return node?.expanded ? { type: 'collapse', id } : none
    case 'expandSiblings': return node ? { type: 'expandSiblings', id } : none
    default: return none
  }
}

const matches = (lower: string, prefix: string) => {
  if (lower.startsWith(prefix)) return true
  // Schema-qualified labels also match by the part after the schema: "ord" finds "dbo.Orders".
  const dot = lower.indexOf('.')
  return dot >= 0 && lower.startsWith(prefix, dot + 1)
}
/**
 * The row type-ahead moves to, or −1: the next node row (wrapping) whose label starts with `buffer`. A one-character
 * buffer, or one character repeated ("ddd"), searches from the row after `from`, so repeating a key cycles; a longer
 * buffer searches from `from`, so typing on extends the current match.
 */
export function typeAhead(rows: VisibleRows, from: number, buffer: string): number {
  if (!buffer || !rows.count) return -1
  let prefix = buffer.toLocaleLowerCase()
  const first = prefix[0], repeated = [...prefix].every(char => char === first)
  if (repeated) prefix = first
  const start = repeated || from < 0 ? from + 1 : from
  const { count, nodes } = rows
  for (let step = 0; step < count; step++) {
    const index = ((start + step) % count + count) % count
    const node = nodes[index]
    if (node && matches(node.lower, prefix)) return index
  }
  return -1
}

/**
 * Keys the tree swallows when type-ahead does not take them: Space and Shift+Space would scroll it a page and leave the
 * selected row out of view, and the Windows tree ignores them. Type-ahead takes a space only after other text.
 */
export function swallowedKey(event: { readonly key: string; readonly ctrlKey?: boolean; readonly altKey?: boolean; readonly metaKey?: boolean; readonly isComposing?: boolean }): boolean {
  return event.key === ' ' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing
}

/** Type-ahead input: printable keys without Ctrl, Alt or Meta, outside IME composition, reset after a pause. */
export class TypeAheadBuffer {
  private text = ''
  private last = -Infinity
  constructor(private readonly now: () => number = () => performance.now(), private readonly resetMs: number = explorerLimits.typeAheadMs, private readonly max: number = explorerLimits.typeAheadMax) {}
  get value(): string { return this.text }
  /** The search text after `event`, or undefined when the key is not type-ahead input. */
  accept(event: { readonly key: string; readonly ctrlKey?: boolean; readonly altKey?: boolean; readonly metaKey?: boolean; readonly isComposing?: boolean }): string | undefined {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return undefined
    const { key } = event
    // One code point that is not a control character: named keys ("Enter", "F5") have longer names.
    if ([...key].length !== 1 || /\p{Cc}/u.test(key)) return undefined
    const now = this.now()
    if (now - this.last > this.resetMs) this.text = ''
    if (key === ' ' && !this.text) return undefined
    this.last = now
    if (this.text.length + key.length <= this.max) this.text += key
    return this.text
  }
  clear(): void { this.text = ''; this.last = -Infinity }
}

/** Whether expanding the node runs catalog SQL: listing folders, databases (state check) and tables with a history row. */
export function needsQuery(node: Pick<TreeNode, 'kind' | 'folder' | 'subtype'>): boolean {
  if (node.kind === 'folder') return !!(node.folder && folderSpecs[node.folder].list)
  if (node.kind === 'database') return true
  return !!node.subtype && !!kindSpecs[node.kind].historyLookup?.includes(node.subtype)
}
/**
 * What `*` does for a node: every collapsed expandable sibling (itself included) is expanded. Those already loaded, and
 * those served without SQL, go in `expand`; those that need a query go in `load`. At most `cap` of them may need a
 * request, SQL or not, so `*` on one of 10,000 tables sends 50 requests rather than flooding the queue; the rest are
 * `skipped`.
 */
export function siblingPlan(nodes: NodeTable, roots: readonly number[], id: number, cap: number = explorerLimits.siblingLoads): { expand: number[]; load: number[]; skipped: number } {
  const plan = { expand: [] as number[], load: [] as number[], skipped: 0 }
  const node = nodes.get(id)
  if (!node) return plan
  const siblings = node.parent ? nodes.get(node.parent)?.children ?? [] : roots.map(root => nodes.get(root))
  let requests = 0
  for (const value of siblings) {
    if (!expandable(value) || value.expanded) continue
    if (value.load === 'loaded') { plan.expand.push(value.id); continue }
    if (requests >= cap) { plan.skipped++; continue }
    requests++
    if (needsQuery(value)) plan.load.push(value.id)
    else plan.expand.push(value.id)
  }
  return plan
}
