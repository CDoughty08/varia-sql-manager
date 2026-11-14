import { describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { dependencyKinds, dependencyLimits, type DependenciesParams, type DependenciesResult } from '../src/shared/explorer/dependencies.ts'
import type { PeekDependency } from '../src/shared/explorer/peek.ts'
import { dependenciesParamsSchema } from '../src/shared/explorer/schema.ts'
import { explorerCatalogJson } from '../src/shared/explorer/catalog.ts'
import { DependencyTree, dependencyRef, levelStatus, type DependencyLoader } from '../src/renderer/src/explorer/dependency-tree'
import { DependenciesService, listingFolder } from '../src/renderer/src/explorer/DependenciesService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'

const connectionId = '00000000-0000-4000-8000-000000000001'
const root = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' } as const
const table = (name: string, extra: Partial<PeekDependency> = {}): PeekDependency => ({ name, schema: 'dbo', kind: 'table', type: 'U', ...extra })
const view = (name: string, extra: Partial<PeekDependency> = {}): PeekDependency => ({ name, schema: 'dbo', kind: 'view', type: 'V', ...extra })

/** A loader that answers from a map of object name to level, and records each request; `hold` keeps answers until released. */
function fakeLoader(levels: Record<string, readonly PeekDependency[] | DependenciesResult | string>, hold = false) {
  const calls: DependenciesParams[] = []
  const cancelled: string[] = []
  const waiting: (() => void)[] = []
  let ids = 0
  const loader: DependencyLoader = {
    load: vi.fn((params: DependenciesParams) => {
      calls.push(params)
      const level = levels[params.target.name ?? '']
      const answer: ApiResult<DependenciesResult> = typeof level === 'string' ? { ok: true, value: { items: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: level, retryable: true } } }
        : Array.isArray(level) ? { ok: true, value: { items: level, elapsedMs: 1 } } : level ? { ok: true, value: level as DependenciesResult } : { ok: true, value: { items: [], elapsedMs: 1 } }
      return hold ? new Promise<ApiResult<DependenciesResult>>(resolve => { waiting.push(() => resolve(answer)) }) : Promise.resolve(answer)
    }),
    cancel: ids => { cancelled.push(...ids) }
  }
  return { loader, calls, cancelled, release: () => { for (const go of waiting.splice(0)) go() }, newId: () => `req-${++ids}` }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function plant(levels: Parameters<typeof fakeLoader>[0], direction: 'uses' | 'usedBy' = 'usedBy', hold = false) {
  const fake = fakeLoader(levels, hold)
  const changes = vi.fn()
  const tree = new DependencyTree(connectionId, root, 'dbo.Orders', 'Table', direction, fake.loader, changes, fake.newId)
  return { tree, changes, ...fake }
}

describe('View Dependencies tree', () => {
  it('reads the root at once and every other level only when its node is expanded', async () => {
    const { tree, calls } = plant({ Orders: [view('OrderSummary'), table('Invoices')], OrderSummary: [view('Dashboard')] })
    expect(calls).toEqual([{ connectionId, requestId: 'req-1', target: root, direction: 'usedBy' }])
    await settle()
    const rows = tree.rows()
    expect(rows.map(row => row.node.label)).toEqual(['dbo.Orders', 'dbo.OrderSummary', 'dbo.Invoices'])
    expect(rows[1]!.node).toMatchObject({ depth: 1, expanded: false, load: 'none', type: 'View', dependencyType: 'Non-schema-bound', ref: { kind: 'view', database: 'Sales', schema: 'dbo', name: 'OrderSummary' } })
    expect(calls).toHaveLength(1)
    tree.expand(rows[1]!.node.id)
    expect(tree.node(rows[1]!.node.id)?.load).toBe('loading')
    expect(calls[1]).toEqual({ connectionId, requestId: 'req-2', target: { kind: 'view', database: 'Sales', schema: 'dbo', name: 'OrderSummary' }, direction: 'usedBy' })
    await settle()
    expect(tree.rows().map(row => [row.node.label, row.node.depth])).toEqual([['dbo.Orders', 0], ['dbo.OrderSummary', 1], ['dbo.Dashboard', 2], ['dbo.Invoices', 1]])
    // Collapsing and expanding again reads nothing more.
    tree.collapse(rows[1]!.node.id)
    expect(tree.rows()).toHaveLength(3)
    tree.expand(rows[1]!.node.id)
    expect(calls).toHaveLength(2)
    expect(tree.rows()).toHaveLength(4)
  })

  it('marks a cycle instead of following it, and reads none of it', async () => {
    // Orders <- vA <- vB <- Orders: the third level's Orders is the root again.
    const { tree, calls } = plant({ Orders: [view('vA')], vA: [view('vB')], vB: [table('Orders'), view('vA')] })
    await settle()
    tree.expand(tree.rows()[1]!.node.id)
    await settle()
    tree.expand(tree.rows()[2]!.node.id)
    await settle()
    const rows = tree.rows()
    expect(rows.map(row => [row.node.label, row.node.leaf ?? null])).toEqual([['dbo.Orders', null], ['dbo.vA', null], ['dbo.vB', null], ['dbo.Orders', 'cycle'], ['dbo.vA', 'cycle']])
    expect(tree.canExpand(rows[3]!.node.id)).toBe(false)
    tree.expand(rows[3]!.node.id)
    expect(calls.map(call => call.target.name)).toEqual(['Orders', 'vA', 'vB'])
  })

  it('makes leaves of linked-server, cross-database, unresolved and unlisted objects, with the reason', async () => {
    const { tree, calls } = plant({ Orders: [
      { name: 'Remote', schema: 'dbo', database: 'Hub', server: 'LINKED1' },
      { name: 'Archive', schema: 'dbo', database: 'History' },
      { name: 'Missing', schema: 'dbo' },
      { name: 'DF_Orders_Date', schema: 'dbo', type: 'D' },
      { name: 'trOrders', schema: 'dbo', kind: 'trigger', type: 'TR', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, schemaBound: true }
    ] }, 'uses')
    await settle()
    const nodes = tree.rows().slice(1).map(row => row.node)
    expect(nodes.map(node => [node.label, node.leaf ?? null, node.type])).toEqual([
      ['LINKED1.Hub.dbo.Remote', 'linkedServer', 'Linked server object'],
      ['History.dbo.Archive', 'otherDatabase', 'Cross-database object'],
      ['dbo.Missing', 'unresolved', 'Unresolved'],
      ['dbo.DF_Orders_Date', 'notListed', 'Default constraint'],
      // A trigger is named below its table; the root is that table, but a trigger is another object, not a cycle.
      ['dbo.Orders.trOrders', null, 'Trigger']
    ])
    expect(nodes[4]).toMatchObject({ dependencyType: 'Schema-bound', ref: { kind: 'trigger', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'trOrders' } })
    for (const node of nodes.slice(0, 4)) tree.expand(node.id)
    expect(calls).toHaveLength(1)
  })

  it('marks a level cut by the backend, and a tree that is full', async () => {
    const { tree } = plant({ Orders: { items: [view('a'), view('b')], truncated: true, elapsedMs: 1 } })
    await settle()
    expect(tree.node(0)).toMatchObject({ load: 'ready', truncated: 'level' })

    const many = Array.from({ length: dependencyLimits.perLevel }, (_, index) => view(`v${index}`))
    const levels: Record<string, readonly PeekDependency[]> = { Orders: many }
    for (const item of many) levels[item.name] = Array.from({ length: dependencyLimits.perLevel }, (_, index) => view(`${item.name}_${index}`))
    const full = plant(levels)
    await settle()
    let cut: number | undefined
    for (const row of full.tree.rows().slice(1, 40)) {
      full.tree.expand(row.node.id)
      await settle()
      if (full.tree.node(row.node.id)?.truncated === 'nodes') { cut = row.node.id; break }
    }
    expect(cut).toBeDefined()
    expect(full.tree.size).toBe(dependencyLimits.nodes)
    expect(levelStatus(full.tree.node(cut!)!)).toBe('nodes')
    // A level read once the tree is full keeps none of its objects, and says the tree is full rather than that there are none.
    const next = full.tree.rows().find(row => row.node.depth === 1 && !row.node.expanded)!
    full.tree.expand(next.node.id)
    await settle()
    expect(full.tree.node(next.node.id)).toMatchObject({ load: 'ready', children: [], truncated: 'nodes' })
    expect(levelStatus(full.tree.node(next.node.id)!)).toBe('nodes')
    const empty = plant({ Orders: [] })
    await settle()
    expect(levelStatus(empty.tree.node(0)!)).toBe('empty')
  })

  it('stops at the depth bound', async () => {
    const levels: Record<string, readonly PeekDependency[]> = { Orders: [view('d1')] }
    for (let depth = 1; depth <= dependencyLimits.depth + 1; depth++) levels[`d${depth}`] = [view(`d${depth + 1}`)]
    const { tree, calls } = plant(levels)
    await settle()
    for (let depth = 1; depth < dependencyLimits.depth; depth++) {
      const last = tree.rows().at(-1)!.node
      tree.expand(last.id)
      await settle()
    }
    const last = tree.rows().at(-1)!.node
    expect(last).toMatchObject({ depth: dependencyLimits.depth, leaf: 'depth' })
    expect(calls).toHaveLength(dependencyLimits.depth)
  })

  it('shows a failed level with its message and reads it again on Retry', async () => {
    const levels: Record<string, string | readonly PeekDependency[]> = { Orders: 'The login may not read sys.sql_expression_dependencies.' }
    const { tree, calls } = plant(levels)
    await settle()
    expect(tree.node(0)).toMatchObject({ load: 'error', error: 'The login may not read sys.sql_expression_dependencies.', expanded: true })
    levels.Orders = [view('ok')]
    tree.retry(0)
    await settle()
    expect(calls).toHaveLength(2)
    expect(tree.node(0)).toMatchObject({ load: 'ready', expanded: true })
    expect(tree.rows()).toHaveLength(2)
  })

  it('cancels the reads still running when it is dropped, and ignores their answers', async () => {
    const { tree, cancelled, release, changes } = plant({ Orders: [view('late')] }, 'usedBy', true)
    tree.dispose()
    const before = changes.mock.calls.length
    release()
    await settle()
    expect(cancelled).toEqual(['req-1'])
    expect(changes.mock.calls.length).toBe(before)
    expect(tree.node(0)?.load).toBe('loading')
  })

  it('names a dependency in the root database only when the tree can read it there', () => {
    expect(dependencyRef(table('T'), 'Sales')).toEqual({ kind: 'table', database: 'Sales', schema: 'dbo', name: 'T' })
    expect(dependencyRef(table('T', { database: 'Other' }), 'Sales')).toBeUndefined()
    expect(dependencyRef({ name: 'tr', schema: 'dbo', kind: 'trigger', type: 'TR' }, 'Sales')).toBeUndefined()
  })
})

describe('View Dependencies service and request', () => {
  const live = { getSnapshot: () => [{ id: connectionId, lost: false }], subscribe: () => () => {} } as never
  const rootNode = { id: 7, connectionId, ref: { type: 'object', object: root }, kind: 'table', label: 'dbo.Orders', lost: false } as ExplorerMenuNode

  it('opens on the kinds SSMS offers it on, cancels the old tree when the choice changes, and reveals a dependency through its folder', async () => {
    expect([...dependencyKinds].sort()).toEqual(['function', 'procedure', 'sequence', 'synonym', 'table', 'tableType', 'trigger', 'type', 'view'])
    const results: Record<string, ApiResult<DependenciesResult>> = {
      usedBy: { ok: true, value: { items: [view('OrderSummary', { subtype: 'ledger' })], elapsedMs: 1 } },
      uses: { ok: true, value: { items: [table('Customers')], elapsedMs: 1 } }
    }
    let hold: (() => void) | undefined
    const api = {
      // 'uses' is held until the test lets it answer, after the choice moved back: its answer must be dropped.
      explorerDependencies: vi.fn((params: DependenciesParams) => params.direction === 'usedBy' ? Promise.resolve(results.usedBy!) : new Promise<ApiResult<DependenciesResult>>(resolve => { hold = () => resolve(results.uses!) })),
      explorerCancel: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
    }
    const reveal = vi.fn(), peek = vi.fn(), select = vi.fn()
    let ids = 0
    const service = new DependenciesService({
      api: api as never, connections: live, reveal, peek, newId: () => `id-${++ids}`,
      explorer: { menuNode: id => id === 7 ? rootNode : undefined, select, objectNode: (cid, object, label, subtype) => ({ connectionId: cid, ref: { type: 'object', object }, kind: object.kind, label, ...(subtype ? { subtype } : {}), lost: false }) }
    })
    expect(service.canOpen({ ...rootNode, kind: 'login', ref: { type: 'object', object: { kind: 'login', name: 'sa' } } })).toBe(false)
    service.open(rootNode)
    await settle()
    expect(service.current?.rows.map(row => row.node.label)).toEqual(['dbo.Orders', 'dbo.OrderSummary'])
    service.setDirection('uses')
    expect(service.current).toMatchObject({ direction: 'uses', selected: 0 })
    service.setDirection('usedBy')
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-2'])
    hold?.()
    await settle()
    expect(service.current?.rows.map(row => row.node.label)).toEqual(['dbo.Orders', 'dbo.OrderSummary'])
    const child = service.current!.rows[1]!.node
    service.select(child.id)
    expect(service.canReveal(child.id)).toBe(true)
    service.reveal(child.id)
    expect(service.current).toBeUndefined()
    expect(reveal).toHaveBeenCalledWith(connectionId, { object: { kind: 'view', database: 'Sales', schema: 'dbo', name: 'OrderSummary' }, folder: 'views', label: 'dbo.OrderSummary', subtype: 'ledger' })

    service.open(rootNode)
    await settle()
    service.reveal(0)
    expect(select).toHaveBeenCalledWith(7, { reveal: true })
    service.open(rootNode)
    await settle()
    service.peek(service.current!.rows[1]!.node.id)
    expect(peek).toHaveBeenCalledWith(expect.objectContaining({ id: 7, kind: 'view', label: 'dbo.OrderSummary', subtype: 'ledger' }))
    service.dispose()
  })

  it('finds the folder Reveal walks to for each kind', () => {
    expect(listingFolder({ kind: 'table', database: 'd', schema: 's', name: 'n' }, 'graphEdge')).toBe('graphTables')
    expect(listingFolder({ kind: 'function', database: 'd', schema: 's', name: 'n' }, 'scalar')).toBe('scalarValuedFunctions')
    expect(listingFolder({ kind: 'trigger', database: 'd', parent: { kind: 'view', schema: 's', name: 'v' }, name: 'n' })).toBe('tableTriggers')
    // sys.sp_executesql and the other extended procedures are listed with the system ones.
    expect(listingFolder({ kind: 'procedure', database: 'd', schema: 'sys', name: 'sp_executesql' }, 'extended')).toBe('systemStoredProcedures')
    expect(listingFolder({ kind: 'procedure', database: 'd', schema: 'dbo', name: 'p' }, 'sql')).toBe('storedProcedures')
    expect(listingFolder({ kind: 'login', name: 'n' })).toBeUndefined()
  })

  it('validates explorer.dependencies strictly, and the catalogue carries the level bound for the backend', () => {
    const base = { connectionId, requestId: '00000000-0000-4000-8000-000000000002', target: root }
    expect(dependenciesParamsSchema.safeParse({ ...base, direction: 'uses' }).success).toBe(true)
    expect(dependenciesParamsSchema.safeParse({ ...base, direction: 'sideways' }).success).toBe(false)
    expect(dependenciesParamsSchema.safeParse({ ...base, direction: 'uses', extra: 1 }).success).toBe(false)
    expect(dependenciesParamsSchema.safeParse({ ...base, direction: 'uses', target: { kind: 'login', name: 'sa' } }).success).toBe(false)
    expect(dependenciesParamsSchema.safeParse({ ...base, direction: 'uses', target: { ...root, name: 'x'.repeat(129) } }).success).toBe(false)
    expect(JSON.parse(explorerCatalogJson()).peek.dependencyLevel).toBe(dependencyLimits.perLevel)
  })
})
