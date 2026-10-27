import { describe, expect, it } from 'vitest'
import type { FolderId, NodeKind, NodeSubtype } from '../src/shared/explorer/catalog'
import type { ExplorerNodeRef } from '../src/shared/explorer/refs'
import {
  computeWindow, filterMatch, filterText, flatten, flattenFiltered, layoutWindow, needsQuery, rowLayout, parentIndex, renderedIndices, revealScroll, rowIndex, rowKindOf, RowKind, rowOwner, siblingPlan, swallowedKey, syntheticId, treeKey, treeKeyOf, typeAhead,
  TypeAheadBuffer, type TreeNode, type VisibleRows
} from '../src/renderer/src/explorer/tree-model'

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
function bestOf3(action: () => void): number {
  let best = Infinity
  for (let run = 0; run < 3; run++) { const start = performance.now(); action(); best = Math.min(best, performance.now() - start) }
  return best
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
  it('flattens 250,000 visible rows within the budget', () => {
    const t = sample(250_000)
    let rows = t.rows()
    const time = bestOf3(() => { rows = t.rows() })
    expect(rows.count).toBe(250_000 + 6)
    expect(time).toBeLessThan(60)
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
  it('scans 100,000 rows within the budget', () => {
    const labels = Array.from({ length: 100_000 }, (_, index) => `dbo.table${index}`)
    const { rows, nodes } = folder(labels)
    let found = -1
    const time = bestOf3(() => { found = typeAhead(rows, 0, 'zzz') })
    expect(found).toBe(-1)
    expect(time).toBeLessThan(20)
    expect(nodes.get(rows.ids[typeAhead(rows, 0, 'table99999')])!.label).toBe('dbo.table99999')
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

describe('Filter loaded objects', () => {
  const filtered = (t: ReturnType<typeof sample>, text: string) => { const result = flattenFiltered(t.nodes, t.roots, filterText(text)); return { rows: describeRows(result.rows, t.nodes), matches: result.matches } }
  it('keeps matches with their ancestors, counts the siblings that show, and leaves the rest out', () => {
    const t = sample(12)
    const other = t.add(0, 'server-b', { kind: 'server', expanded: true })
    t.add(other.id, 'Databases', { folder: 'databases' })
    expect(filtered(t, 'TABLE1')).toEqual({
      rows: [['server-a', 1, 1, 2], ['Databases', 2, 1, 1], ['AppData', 3, 1, 1], ['Tables', 4, 1, 1], ['dbo.Table1', 5, 1, 3], ['dbo.Table10', 5, 2, 3], ['dbo.Table11', 5, 3, 3], ['server-b', 1, 2, 2]],
      matches: 3
    })
    expect(filtered(t, 'nothing')).toEqual({ rows: [['server-a', 1, 1, 2], ['server-b', 1, 2, 2]], matches: 0 })
  })
  it('shows a match\'s expanded rows as they are, and searches only expanded nodes', () => {
    const t = sample(2)
    // Below a collapsed folder, a loaded match stays hidden: the filter narrows what is open.
    t.add(t.system.id, 'master', { kind: 'database' })
    expect(filtered(t, 'tables')).toEqual({
      rows: [['server-a', 1, 1, 1], ['Databases', 2, 1, 1], ['AppData', 3, 1, 1], ['Tables', 4, 1, 1], ['dbo.Table0', 5, 1, 2], ['dbo.Table1', 5, 2, 2]],
      matches: 1
    })
    expect(filtered(t, 'master').rows).toEqual([['server-a', 1, 1, 1]])
  })
  it('keeps a shown node\'s loading, error and progress rows, and drops those of a node it leaves out', () => {
    const t = sample(2)
    Object.assign(t.tables, { more: 'auto', cursor: 'v1.tables.2', total: 10 })
    Object.assign(t.databases, { load: 'error' })
    expect(filtered(t, 'table0').rows).toEqual([
      ['server-a', 1, 1, 1], ['Databases', 2, 1, 1], ['Error(Databases)', 3, 0, 0], ['AppData', 3, 1, 1], ['Tables', 4, 1, 1], ['dbo.Table0', 5, 1, 1], ['More(Tables)', 5, 0, 0]
    ])
    expect(filtered(t, 'security').rows).toEqual([['server-a', 1, 1, 1], ['Security', 2, 1, 1]])
  })
  it('keeps the pinned node (the selection) and its ancestors, matching or not, without counting them', () => {
    const t = sample(2)
    // Tables, collapsed while it showed only for its matches, stays with its ancestors.
    t.tables.expanded = false
    const pinned = (id: number, text: string) => { const result = flattenFiltered(t.nodes, t.roots, filterText(text), 64, id); return { rows: describeRows(result.rows, t.nodes), matches: result.matches } }
    expect(pinned(t.tables.id, 'table1')).toEqual({ rows: [['server-a', 1, 1, 1], ['Databases', 2, 1, 1], ['AppData', 3, 1, 1], ['Tables', 4, 1, 1]], matches: 0 })
    expect(filtered(t, 'table1').rows).toEqual([['server-a', 1, 1, 1]])
    // A pinned leaf beside the matches, and a pinned node that is gone or a server, change nothing else.
    t.tables.expanded = true
    const security = t.nodes.get(t.server.children!.find(child => child.label === 'Security')!.id)!
    expect(pinned(security.id, 'table1')).toEqual({ rows: [['server-a', 1, 1, 1], ['Databases', 2, 1, 2], ['AppData', 3, 1, 1], ['Tables', 4, 1, 1], ['dbo.Table1', 5, 1, 1], ['Security', 2, 2, 2]], matches: 1 })
    expect(pinned(9999, 'table1')).toEqual(filtered(t, 'table1'))
    expect(pinned(t.server.id, 'zzz')).toEqual({ rows: [['server-a', 1, 1, 1]], matches: 0 })
  })
  it('matches anywhere in the label, ignoring case and surrounding spaces', () => {
    expect(filterText('  Ord ')).toBe('ord')
    expect(filterMatch({ lower: 'dbo.orders' }, 'ord')).toBe(4)
    expect(filterMatch({ lower: 'dbo.orders' }, '')).toBe(-1)
  })
  it('filters 100,000 loaded rows within a frame', () => {
    const t = sample(100_000)
    expect(flattenFiltered(t.nodes, t.roots, 'table9999').matches).toBe(11)
    expect(bestOf3(() => flattenFiltered(t.nodes, t.roots, 'table9'))).toBeLessThan(50)
  })
})

describe('row layout', () => {
  it('makes server rows taller and places every row below them by it', () => {
    const t = sample(3)
    const other = t.add(0, 'server-b', { kind: 'server' })
    const rows = t.rows(), layout = rowLayout(rows, 22, 30)
    const index = Array.from(rows.ids).indexOf(other.id)
    expect([layout.top(0), layout.height(0), layout.top(1), layout.height(1), layout.top(index), layout.height(index)]).toEqual([0, 30, 30, 22, 30 + (index - 1) * 22, 30])
    expect(layout.total).toBe(rows.count * 22 + 2 * 8)
    expect([layout.indexAt(0), layout.indexAt(29), layout.indexAt(30), layout.indexAt(51), layout.indexAt(52), layout.indexAt(1e9), layout.indexAt(-5)]).toEqual([0, 0, 1, 1, 2, rows.count - 1, 0])
  })
  it('scrolls a row into view by where the layout places it, servers above included', () => {
    const t = sample(3)
    for (const name of ['server-b', 'server-c', 'server-d']) t.add(0, name, { kind: 'server' })
    const rows = t.rows(), layout = rowLayout(rows, 22, 30), last = rows.count - 1
    // The last row, server-d, sits below 3 taller servers: its bottom is 3 · 8 px further down than index · 22 would say.
    expect(layout.top(last) + layout.height(last)).toBe(last * 22 + 3 * 8 + 30)
    expect(revealScroll(layout, last, 0, 100)).toBe(layout.total - 100)
    expect(revealScroll(layout, 1, 200, 100)).toBe(30)
    expect(revealScroll(layout, 1, 0, 100)).toBeUndefined()
    expect([revealScroll(layout, -1, 0, 100), revealScroll(layout, rows.count, 0, 100)]).toEqual([undefined, undefined])
  })
  it('windows rows of different heights with overscan, clamped to the rows', () => {
    const t = sample(1000), layout = rowLayout(t.rows(), 22, 30)
    expect(layoutWindow(0, 220, layout, 0)).toEqual([0, 10])
    expect(layoutWindow(30 + 22 * 99, 220, layout, 5)).toEqual([95, 115])
    expect(layoutWindow(1e9, 220, layout)).toEqual([layout.count, layout.count])
    expect(layoutWindow(0, 220, rowLayout(flatten(new Map(), [])))).toEqual([0, 0])
    // Uniform rows window as computeWindow does.
    const plain = rowLayout(t.rows(), 22, 22)
    for (const top of [0, 2200, 5000]) expect(layoutWindow(top, 220, plain)).toEqual(computeWindow(top, 220, plain.count))
  })
})
