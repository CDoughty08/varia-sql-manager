import { describe, expect, it } from 'vitest'
import type { FolderId, NodeKind, NodeSubtype } from '../src/shared/explorer/catalog'
import type { ExplorerNodeRef } from '../src/shared/explorer/refs'
import {
  computeWindow, flatten, needsQuery, parentIndex, renderedIndices, rowIndex, rowKindOf, RowKind, rowOwner, siblingPlan, swallowedKey, syntheticId, treeKey, treeKeyOf, typeAhead,
  TypeAheadBuffer, type TreeNode, type VisibleRows
} from '../src/renderer/src/explorer/tree-model'
import { meterWork } from './fixtures/work-meter'

/** A node table built by hand: `add` appends a child (or a root), and fields can be set on the result. */
function table() {
  const nodes = new Map<number, TreeNode>(), roots: number[] = []
  let next = 1
  const add = (parent: number, label: string, fields: Partial<TreeNode> & { kind?: NodeKind | 'folder'; folder?: FolderId; subtype?: NodeSubtype } = {}): TreeNode => {
    const owner = parent ? nodes.get(parent)! : undefined
    const kind = fields.kind ?? (fields.folder ? 'folder' : 'table')
    const ref: ExplorerNodeRef = kind === 'folder' ? { type: 'folder', owner: { kind: 'server' }, folder: fields.folder ?? 'tables' } : { type: 'object', object: { kind: kind as NodeKind, name: label } }
    const node: TreeNode = {
      id: next++, parent, connectionId: 'c', ref, kind, folder: fields.folder, level: (owner?.level ?? 0) + 1, label, lower: label.toLocaleLowerCase(), sublabel: undefined,
      detail: undefined, icon: 'folder', subtype: undefined, status: undefined, created: undefined, hasChildren: false, expanded: false, children: undefined, staticCount: 0,
      total: undefined, cursor: undefined, load: 'none', more: 'none', error: undefined, connectionError: undefined, filtered: false, lost: false, showLoading: false,
      generation: 0, rev: 0, lastUsed: 0, descendants: 0, ...fields
    }
    nodes.set(node.id, node)
    if (owner) { (owner.children ??= []).push(node); owner.hasChildren = true; owner.load = 'loaded' } else roots.push(node.id)
    return node
  }
  return { nodes, roots, add, rows: () => flatten(nodes, roots) }
}
/** Rows as `[label or row kind, level, posinset, setsize]`. */
function describeRows(rows: VisibleRows, nodes: Map<number, TreeNode>) {
  const names = Object.fromEntries(Object.entries(RowKind).map(([name, value]) => [value, name]))
  return Array.from(rows.ids, (id, index) => [rows.kinds[index] === RowKind.Node ? nodes.get(id)!.label : `${names[rows.kinds[index]]}(${nodes.get(rowOwner(id))!.label})`, rows.levels[index], rows.posinset[index], rows.setsize[index]])
}
/** A server with Databases › AppData › Tables of `count` tables, all expanded. */
function sample(count = 3) {
  const t = table()
  const server = t.add(0, 'server-a', { kind: 'server', expanded: true })
  const databases = t.add(server.id, 'Databases', { folder: 'databases', expanded: true })
  t.add(server.id, 'Security', { folder: 'serverSecurity' })
  const system = t.add(databases.id, 'System Databases', { folder: 'systemDatabases', hasChildren: true })
  const app = t.add(databases.id, 'AppData', { kind: 'database', expanded: true })
  const tables = t.add(app.id, 'Tables', { folder: 'tables', expanded: true })
  for (let index = 0; index < count; index++) t.add(tables.id, `dbo.Table${index}`)
  return { ...t, server, databases, system, app, tables }
}
describe('row ids', () => {
  it('encode the owner and kind of synthetic rows, and leave node ids alone', () => {
    for (const kind of [RowKind.Loading, RowKind.Error, RowKind.More, RowKind.Stopped, RowKind.Capped, RowKind.Paused, RowKind.MoreError]) {
      const id = syntheticId(12345, kind)
      expect(id).toBeLessThan(0)
      expect([rowOwner(id), rowKindOf(id)]).toEqual([12345, kind])
    }
    expect([rowOwner(42), rowKindOf(42)]).toEqual([42, RowKind.Node])
    expect(new Set([1, 2, 3].flatMap(owner => [1, 2, 3, 4, 5, 6, 7].map(kind => syntheticId(owner, kind as RowKind)))).size).toBe(21)
  })
})

describe('flatten', () => {
  it('lists expanded nodes in pre-order with levels, positions and set sizes', () => {
    const t = sample()
    expect(describeRows(t.rows(), t.nodes)).toEqual([
      ['server-a', 1, 1, 1], ['Databases', 2, 1, 2], ['System Databases', 3, 1, 2], ['AppData', 3, 2, 2], ['Tables', 4, 1, 1],
      ['dbo.Table0', 5, 1, 3], ['dbo.Table1', 5, 2, 3], ['dbo.Table2', 5, 3, 3], ['Security', 2, 2, 2]
    ])
    t.databases.expanded = false
    expect(describeRows(t.rows(), t.nodes).map(row => row[0])).toEqual(['server-a', 'Databases', 'Security'])
  })
  it('takes the set size from the total while pages are still coming, and the loaded count otherwise', () => {
    const t = sample(2)
    t.tables.total = 120_000
    expect(describeRows(t.rows(), t.nodes).filter(row => String(row[0]).startsWith('dbo.')).map(row => row[3])).toEqual([120_000, 120_000])
    t.tables.total = 1
    expect(describeRows(t.rows(), t.nodes).filter(row => String(row[0]).startsWith('dbo.')).map(row => row[3])).toEqual([2, 2])
  })
  it('places synthetic rows: errors first (old rows stay), late loading rows, then the tail row', () => {
    const t = sample(2)
    const labels = () => describeRows(t.rows(), t.nodes).slice(4).map(row => row[0])
    t.tables.load = 'error'
    expect(labels()).toEqual(['Tables', 'Error(Tables)', 'dbo.Table0', 'dbo.Table1', 'Security'])
    expect(describeRows(t.rows(), t.nodes)[5]).toEqual(['Error(Tables)', 5, 0, 0])
    t.tables.load = 'loading'
    t.tables.showLoading = true
    // Old rows of a refresh need no loading row.
    expect(labels()).toEqual(['Tables', 'dbo.Table0', 'dbo.Table1', 'Security'])
    t.tables.children = []
    expect(labels()).toEqual(['Tables', 'Loading(Tables)', 'Security'])
    t.tables.children = undefined
    t.tables.showLoading = false
    expect(labels()).toEqual(['Tables', 'Security'])
    const tails: [TreeNode['more'], string | undefined, string | undefined][] = [
      ['auto', 'v1.tables.x', 'More'], ['auto', undefined, undefined], ['stopped', 'v1.tables.x', 'Stopped'], ['capped', undefined, 'Capped'],
      ['paused', 'v1.tables.x', 'Paused'], ['error', 'v1.tables.x', 'MoreError'], ['none', undefined, undefined]
    ]
    for (const [more, cursor, row] of tails) {
      Object.assign(t.tables, { load: 'loaded', more, cursor, children: [] })
      expect(labels(), more).toEqual(['Tables', ...row ? [`${row}(Tables)`] : [], 'Security'])
    }
    t.tables.expanded = false
    expect(labels()).toEqual(['Tables', 'Security'])
  })
  it('carries each row\'s node, and none for synthetic rows', () => {
    const t = sample(1)
    t.tables.load = 'error'
    const rows = t.rows()
    expect(rows.nodes.map(node => node?.label)).toEqual(['server-a', 'Databases', 'System Databases', 'AppData', 'Tables', undefined, 'dbo.Table0', 'Security'])
    expect(rows.nodes.every((node, index) => node ? node.id === rows.ids[index] : rows.ids[index] < 0)).toBe(true)
  })
  it('flattens 250,000 visible rows with one visit per node, preserving order and identity', () => {
    const t = sample(250_000)
    const prefix = [t.server, t.databases, t.system, t.app, t.tables].map(node => node.id)
    const children = t.tables.children!, security = t.server.children!.find(node => node.folder === 'serverSecurity')!
    const visits = new Uint8Array(t.nodes.size)
    for (const [id, node] of t.nodes) {
      Object.defineProperty(node, 'id', { configurable: true, enumerable: true, get: () => {
        if (++visits[id - 1] > 1) throw new Error('Flatten inspected a node more than once.')
        return id
      } })
    }
    const { result: rows, work } = meterWork(() => t.rows())
    expect(rows.count).toBe(250_000 + 6)
    expect(visits.every(count => count === 1)).toBe(true)
    // Its five row arrays grow by doubling from 256 rows: O(log n) allocations, and allocating and copying O(n) elements in
    // all. A fixed growth step, a copy per row or a second pass is quadratic or more work, whatever the runner's speed.
    const arrays = 5, growths = Math.ceil(Math.log2(rows.count / 256))
    expect(work.allocations, JSON.stringify(work)).toBeLessThanOrEqual(arrays * (growths + 1))
    expect(work.allocated, JSON.stringify(work)).toBeLessThanOrEqual(arrays * 4 * rows.count)
    expect(work.elements, JSON.stringify(work)).toBeLessThanOrEqual(arrays * 2 * rows.count)
    expect([work.characters, work.costly]).toEqual([0, 0])
    expect(Array.from(rows.ids.subarray(0, prefix.length))).toEqual(prefix)
    expect(children.every((node, index) => rows.nodes[index + prefix.length] === node)).toBe(true)
    expect(rows.nodes.at(-1)).toBe(security)
    expect(rows.nodes.every((node, index) => node === t.nodes.get(rows.ids[index]))).toBe(true)
    expect([rows.levels[5], rows.posinset[5], rows.setsize[5]]).toEqual([5, 1, 250_000])
    expect([rows.levels.at(-2), rows.posinset.at(-2), rows.setsize.at(-2)]).toEqual([5, 250_000, 250_000])
  })
})

describe('windowing', () => {
  it('renders the viewport with overscan, clamped to the rows', () => {
    expect(computeWindow(0, 220, 1000)).toEqual([0, 20])
    expect(computeWindow(2200, 220, 1000)).toEqual([90, 120])
    expect(computeWindow(22_000 - 220, 220, 1000)).toEqual([980, 1000])
    expect(computeWindow(1e9, 220, 1000)).toEqual([1000, 1000])
    expect(computeWindow(-50, 220, 1000)).toEqual([0, 20])
    expect(computeWindow(0, 0, 1000)).toEqual([0, 10])
    expect(computeWindow(0, 220, 0)).toEqual([0, 0])
    expect(computeWindow(33, 44, 100, 11, 0)).toEqual([3, 7])
  })
  it('always renders the selected row, even outside the window', () => {
    expect(renderedIndices([10, 14], 2)).toEqual([2, 10, 11, 12, 13])
    expect(renderedIndices([10, 14], 12)).toEqual([10, 11, 12, 13])
    expect(renderedIndices([10, 14], 500)).toEqual([10, 11, 12, 13, 500])
    expect(renderedIndices([10, 14], -1)).toEqual([10, 11, 12, 13])
  })
})

describe('keyboard', () => {
  const index = (rows: VisibleRows, nodes: Map<number, TreeNode>, label: string) => Array.from(rows.ids).findIndex(id => id > 0 && nodes.get(id)!.label === label)
  it('maps keys, ignoring workbench modifiers', () => {
    expect(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', '*'].map(key => treeKeyOf({ key })))
      .toEqual(['up', 'down', 'left', 'right', 'home', 'end', 'pageUp', 'pageDown', 'enter', 'expandSiblings'])
    expect(treeKeyOf({ key: '+', code: 'NumpadAdd' })).toBe('expand')
    expect(treeKeyOf({ key: '-', code: 'NumpadSubtract' })).toBe('collapse')
    // The main keyboard's + and - are type-ahead characters.
    expect(treeKeyOf({ key: '+', code: 'Equal' })).toBeUndefined()
    expect(treeKeyOf({ key: 'ArrowDown', ctrlKey: true })).toBeUndefined()
    expect(treeKeyOf({ key: 'Enter', altKey: true })).toBeUndefined()
    expect(treeKeyOf({ key: 'Home', metaKey: true })).toBeUndefined()
    expect(treeKeyOf({ key: 'F5' })).toBeUndefined()
  })
  it('moves up, down, home, end and by pages without wrapping', () => {
    const t = sample(20), rows = t.rows(), last = rows.count - 1
    expect(treeKey(rows, 3, 'up', 10)).toEqual({ type: 'select', index: 2 })
    expect(treeKey(rows, 0, 'up', 10)).toEqual({ type: 'select', index: 0 })
    expect(treeKey(rows, last, 'down', 10)).toEqual({ type: 'select', index: last })
    expect(treeKey(rows, 5, 'home', 10)).toEqual({ type: 'select', index: 0 })
    expect(treeKey(rows, 5, 'end', 10)).toEqual({ type: 'select', index: last })
    expect(treeKey(rows, 5, 'pageDown', 10)).toEqual({ type: 'select', index: 14 })
    expect(treeKey(rows, 14, 'pageUp', 10)).toEqual({ type: 'select', index: 5 })
    expect(treeKey(rows, last - 2, 'pageDown', 10)).toEqual({ type: 'select', index: last })
    expect(treeKey(rows, 2, 'pageUp', 10)).toEqual({ type: 'select', index: 0 })
    expect(treeKey(rows, 2, 'pageDown', 1)).toEqual({ type: 'select', index: 3 })
    // Without a selection, the first key selects an end.
    expect(treeKey(rows, -1, 'down', 10)).toEqual({ type: 'select', index: 0 })
    expect(treeKey(rows, -1, 'end', 10)).toEqual({ type: 'select', index: last })
    expect(treeKey(rows, -1, 'enter', 10)).toEqual({ type: 'none' })
    expect(treeKey(flatten(new Map(), []), 0, 'down', 10)).toEqual({ type: 'none' })
  })
  it('expands, enters, collapses and climbs with the arrows', () => {
    const t = sample(2), rows = t.rows(), at = (label: string) => index(rows, t.nodes, label)
    expect(treeKey(rows, at('System Databases'), 'right', 10)).toEqual({ type: 'expand', id: t.system.id })
    expect(treeKey(rows, at('Tables'), 'right', 10)).toEqual({ type: 'select', index: at('dbo.Table0') })
    expect(treeKey(rows, at('dbo.Table0'), 'right', 10)).toEqual({ type: 'none' })
    expect(treeKey(rows, at('Tables'), 'left', 10)).toEqual({ type: 'collapse', id: t.tables.id })
    expect(treeKey(rows, at('dbo.Table1'), 'left', 10)).toEqual({ type: 'select', index: at('Tables') })
    expect(treeKey(rows, at('System Databases'), 'left', 10)).toEqual({ type: 'select', index: at('Databases') })
    expect(treeKey(rows, 0, 'left', 10)).toEqual({ type: 'collapse', id: t.server.id })
    t.server.expanded = false
    expect(treeKey(rows, 0, 'left', 10)).toEqual({ type: 'none' })
    // An expanded node whose children have not arrived has nothing to enter.
    t.system.expanded = true
    expect(treeKey(rows, at('System Databases'), 'right', 10)).toEqual({ type: 'none' })
  })
  it('toggles with Enter and Numpad plus and minus, and expands siblings with *', () => {
    const t = sample(1), rows = t.rows(), at = (label: string) => index(rows, t.nodes, label)
    expect(treeKey(rows, at('Tables'), 'enter', 10)).toEqual({ type: 'toggle', id: t.tables.id })
    expect(treeKey(rows, at('dbo.Table0'), 'enter', 10)).toEqual({ type: 'none' })
    expect(treeKey(rows, at('System Databases'), 'expand', 10)).toEqual({ type: 'expand', id: t.system.id })
    expect(treeKey(rows, at('Tables'), 'expand', 10)).toEqual({ type: 'none' })
    expect(treeKey(rows, at('Tables'), 'collapse', 10)).toEqual({ type: 'collapse', id: t.tables.id })
    expect(treeKey(rows, at('System Databases'), 'collapse', 10)).toEqual({ type: 'none' })
    expect(treeKey(rows, at('AppData'), 'expandSiblings', 10)).toEqual({ type: 'expandSiblings', id: t.app.id })
    // A lost server cannot be expanded.
    Object.assign(t.server, { lost: true, expanded: false })
    expect(treeKey(rows, 0, 'enter', 10)).toEqual({ type: 'none' })
    expect(treeKey(rows, 0, 'right', 10)).toEqual({ type: 'none' })
  })
  it('retries, continues, or opens Filter Settings from synthetic rows, and climbs from them', () => {
    const t = sample(1)
    const enter = (setup: Partial<TreeNode>) => {
      Object.assign(t.tables, { load: 'loaded', more: 'none', cursor: undefined, ...setup })
      const rows = t.rows(), row = Array.from(rows.kinds).findIndex(kind => kind !== RowKind.Node)
      return { rows, row, action: treeKey(rows, row, 'enter', 10) }
    }
    expect(enter({ load: 'error' }).action).toEqual({ type: 'retry', id: syntheticId(t.tables.id, RowKind.Error) })
    expect(enter({ more: 'error', cursor: 'v1.tables.x' }).action).toEqual({ type: 'retry', id: syntheticId(t.tables.id, RowKind.MoreError) })
    expect(enter({ more: 'stopped', cursor: 'v1.tables.x' }).action).toEqual({ type: 'continue', id: t.tables.id })
    expect(enter({ more: 'paused', cursor: 'v1.tables.x' }).action).toEqual({ type: 'continue', id: t.tables.id })
    expect(enter({ more: 'capped' }).action).toEqual({ type: 'filter', id: t.tables.id })
    expect(enter({ more: 'auto', cursor: 'v1.tables.x' }).action).toEqual({ type: 'none' })
    const { rows, row } = enter({ more: 'stopped', cursor: 'v1.tables.x' })
    expect(treeKey(rows, row, 'left', 10)).toEqual({ type: 'select', index: index(rows, t.nodes, 'Tables') })
    expect(treeKey(rows, row, 'right', 10)).toEqual({ type: 'none' })
    expect(parentIndex(rows, 0)).toBe(-1)
    expect(rowIndex(rows, t.tables.id)).toBe(index(rows, t.nodes, 'Tables'))
    expect(rowIndex(rows, 999)).toBe(-1)
    expect(rowIndex(rows, undefined)).toBe(-1)
  })
})

describe('type-ahead', () => {
  function folder(labels: string[]) {
    const t = table()
    const root = t.add(0, 'Tables', { folder: 'tables', expanded: true })
    for (const label of labels) t.add(root.id, label)
    const rows = t.rows()
    const find = (from: string | number, buffer: string) => {
      const start = typeof from === 'number' ? from : Array.from(rows.ids).findIndex(id => t.nodes.get(id)?.label === from)
      const found = typeAhead(rows, start, buffer)
      return found < 0 ? undefined : t.nodes.get(rows.ids[found])!.label
    }
    return { ...t, rows, root, find }
  }
  it('finds the next label with the prefix, wrapping, case-insensitively', () => {
    const { find } = folder(['dbo.Alpha', 'dbo.Beta', 'Sales.Delta', 'Sales.Dune', 'dbo.Gamma'])
    expect(find('Tables', 's')).toBe('Sales.Delta')
    expect(find('Sales.Delta', 's')).toBe('Sales.Dune')
    expect(find('Sales.Dune', 'S')).toBe('Sales.Delta')
    expect(find('dbo.Gamma', 'd')).toBe('dbo.Alpha')
    expect(find(-1, 'dbo.b')).toBe('dbo.Beta')
    expect(find('Tables', 'x')).toBeUndefined()
  })
  it('matches the part after the schema', () => {
    const { find } = folder(['dbo.Customers', 'dbo.Orders', 'Sales.OrderLines'])
    expect(find('Tables', 'ord')).toBe('dbo.Orders')
    expect(find('dbo.Orders', 'orderl')).toBe('Sales.OrderLines')
    // A longer buffer starts at the selection, so typing on keeps the current match.
    expect(find('dbo.Orders', 'or')).toBe('dbo.Orders')
  })
  it('cycles through rows with one repeated character', () => {
    const { find } = folder(['dbo.d1', 'ddd', 'dbo.d2', 'Data'])
    expect(find('Tables', 'd')).toBe('dbo.d1')
    expect(find('dbo.d1', 'dd')).toBe('ddd')
    expect(find('ddd', 'ddd')).toBe('dbo.d2')
    expect(find('dbo.d2', 'dddd')).toBe('Data')
  })
  it('skips synthetic rows and returns -1 for an empty buffer', () => {
    const t = folder(['Error'])
    t.root.load = 'error'
    const rows = flatten(t.nodes, t.roots)
    expect(rows.kinds[1]).toBe(RowKind.Error)
    expect(t.nodes.get(rows.ids[typeAhead(rows, 0, 'e')])!.label).toBe('Error')
    expect(typeAhead(rows, 0, '')).toBe(-1)
  })
  it('searches 100,000 rows in one pass and wraps without rescanning', () => {
    const labels = Array.from({ length: 100_000 }, (_, index) => `dbo.table${index}`)
    const { rows, nodes } = folder(labels)
    const visited: number[] = []
    for (const [index, node] of rows.nodes.entries()) {
      const lower = node!.lower
      Object.defineProperty(node, 'lower', { configurable: true, enumerable: true, get: () => {
        visited.push(index)
        if (visited.length > rows.count) throw new Error('Type-ahead inspected more than one pass of the visible rows.')
        return lower
      } })
    }
    // Count actual matching work, independent of shared-runner scheduling or garbage-collection pauses.
    const missed = meterWork(() => typeAhead(rows, 0, 'zzz'))
    expect(missed.result).toBe(-1)
    expect(visited).toHaveLength(rows.count)
    expect(new Set(visited).size).toBe(rows.count)
    // Matching a row scans its label at most once plus the prefix twice (at the start and after the schema), with no
    // locale-aware, Unicode or regular-expression call per row: only the buffer is lowercased, once.
    const longest = Math.max(...labels.map(label => label.length))
    expect(missed.work.characters, JSON.stringify(missed.work)).toBeLessThanOrEqual(rows.count * (longest + 2 * 'z'.length) + 'zzz'.length)
    expect(missed.work.costly, JSON.stringify(missed.work)).toBeLessThanOrEqual(1)
    // Nor any array work per row (a few dozen elements is the buffer's own handling).
    expect(missed.work.elements + missed.work.allocated, JSON.stringify(missed.work)).toBeLessThanOrEqual(1000)
    visited.length = 0
    const { result: last, work: found } = meterWork(() => typeAhead(rows, 0, 'table99999'))
    expect(found.characters, JSON.stringify(found)).toBeLessThanOrEqual(rows.count * (longest + 2 * 'table99999'.length) + 'table99999'.length)
    expect(found.costly).toBeLessThanOrEqual(1)
    expect(nodes.get(rows.ids[last])!.label).toBe('dbo.table99999')
    expect(visited).toHaveLength(rows.count)
    expect(new Set(visited).size).toBe(rows.count)
    visited.length = 0
    const wrapped = typeAhead(rows, last, 'table0')
    expect(nodes.get(rows.ids[wrapped])!.label).toBe('dbo.table0')
    expect(visited).toEqual([last, 0, wrapped])
  })
  it('collects printable keys until a pause of a second, ignoring IME, modifiers and leading spaces', () => {
    let now = 0
    const buffer = new TypeAheadBuffer(() => now)
    expect(buffer.accept({ key: ' ' })).toBeUndefined()
    expect(buffer.accept({ key: 's' })).toBe('s')
    now = 500
    expect(buffer.accept({ key: 'e' })).toBe('se')
    expect(buffer.accept({ key: ' ' })).toBe('se ')
    expect(buffer.accept({ key: 'c', isComposing: true })).toBeUndefined()
    expect(buffer.accept({ key: 'c', ctrlKey: true })).toBeUndefined()
    expect(buffer.accept({ key: 'c', altKey: true })).toBeUndefined()
    expect(buffer.accept({ key: 'c', metaKey: true })).toBeUndefined()
    expect(buffer.accept({ key: 'Enter' })).toBeUndefined()
    expect(buffer.accept({ key: 'F5' })).toBeUndefined()
    expect(buffer.accept({ key: '\u0007' })).toBeUndefined()
    now = 1500
    expect(buffer.accept({ key: 'x' })).toBe('se x')
    now = 2501
    expect(buffer.accept({ key: '表' })).toBe('表')
    expect(buffer.accept({ key: '😀' })).toBe('表😀')
    buffer.clear()
    expect(buffer.value).toBe('')
    for (let index = 0; index < 100; index++) buffer.accept({ key: 'a' })
    expect(buffer.value).toHaveLength(64)
  })
  it('swallows Space and Shift+Space that type-ahead leaves, which would scroll the tree away from its selection', () => {
    expect(swallowedKey({ key: ' ' })).toBe(true)
    expect(swallowedKey({ key: ' ', shiftKey: true } as { key: string })).toBe(true)
    for (const event of [{ key: ' ', ctrlKey: true }, { key: ' ', altKey: true }, { key: ' ', metaKey: true }, { key: ' ', isComposing: true }, { key: 'a' }, { key: 'PageDown' }])
      expect(swallowedKey(event)).toBe(false)
  })
})

describe('* (expand siblings)', () => {
  it('expands loaded and SQL-free siblings, loads at most the cap that need a query, and skips the rest', () => {
    const t = table()
    const server = t.add(0, 'server-a', { kind: 'server', expanded: true })
    const databases = t.add(server.id, 'Databases', { folder: 'databases', hasChildren: true })
    const security = t.add(server.id, 'Security', { folder: 'serverSecurity', hasChildren: true })
    const objects = t.add(server.id, 'Server Objects', { folder: 'serverObjects', hasChildren: true, expanded: true })
    expect(siblingPlan(t.nodes, t.roots, security.id)).toEqual({ expand: [security.id], load: [databases.id], skipped: 0 })
    expect(objects.expanded).toBe(true)
    const list = t.add(databases.id, 'Folder', { folder: 'tables' })
    const dbs = Array.from({ length: 60 }, (_, index) => t.add(list.id, `db${index}`, { kind: 'database', hasChildren: true }))
    dbs[3].load = 'loaded'
    dbs[4].hasChildren = false
    dbs[5].expanded = true
    const plan = siblingPlan(t.nodes, t.roots, dbs[0].id, 50)
    expect(plan.expand).toEqual([dbs[3].id])
    expect(plan.load).toHaveLength(50)
    expect(plan.skipped).toBe(60 - 3 - 50)
    expect(siblingPlan(t.nodes, t.roots, server.id)).toEqual({ expand: [], load: [], skipped: 0 })
    expect(siblingPlan(t.nodes, t.roots, 999)).toEqual({ expand: [], load: [], skipped: 0 })
  })
  it('caps the requests * sends, SQL or not, so a folder of 10,000 tables sends 50', () => {
    const t = table()
    const server = t.add(0, 'server-a', { kind: 'server', expanded: true })
    const tables = t.add(server.id, 'Tables', { folder: 'tables', hasChildren: true, expanded: true })
    const rows = Array.from({ length: 10_000 }, (_, index) => t.add(tables.id, `dbo.T${index}`, { kind: 'table', hasChildren: true }))
    rows[7].load = 'loaded'
    const plan = siblingPlan(t.nodes, t.roots, rows[0].id)
    expect(plan.expand).toHaveLength(51)
    expect(plan.expand).toContain(rows[7].id)
    expect(plan.load).toEqual([])
    expect(plan.skipped).toBe(10_000 - 51)
  })
  it('knows which expansions run SQL', () => {
    expect(needsQuery({ kind: 'folder', folder: 'tables', subtype: undefined })).toBe(true)
    expect(needsQuery({ kind: 'folder', folder: 'programmability', subtype: undefined })).toBe(false)
    expect(needsQuery({ kind: 'database', folder: undefined, subtype: undefined })).toBe(true)
    expect(needsQuery({ kind: 'server', folder: undefined, subtype: undefined })).toBe(false)
    expect(needsQuery({ kind: 'table', folder: undefined, subtype: undefined })).toBe(false)
    expect(needsQuery({ kind: 'table', folder: undefined, subtype: 'systemVersioned' })).toBe(true)
    expect(needsQuery({ kind: 'table', folder: undefined, subtype: 'history' })).toBe(false)
  })
})
