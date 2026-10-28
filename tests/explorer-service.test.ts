import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult, ExplorerError, ExplorerNode, VariaApi } from '../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId, type NodeSubtype } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ExplorerFilter, ExplorerNodeRef, ObjectRef } from '../src/shared/explorer/refs'
import { explorerChildrenParamsSchema } from '../src/shared/explorer/schema'
import { EventBus } from '../src/renderer/src/core/events'
import type { Timers } from '../src/renderer/src/core/timers'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { ExplorerService, serverSublabel, type ExplorerServiceLimits } from '../src/renderer/src/explorer/ExplorerService'
import { scriptContextValues, scriptMenuState } from '../src/shared/scripting/catalog'
import { actionContextValues, actionMenuState } from '../src/shared/actions/catalog'
import { RowKind, rowKindOf, syntheticId } from '../src/renderer/src/explorer/tree-model'
import { connectionInfo, connectionOptions } from './fixtures/workbench'
import { meterWork } from './fixtures/work-meter'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
/** Connection ids are uuids, as main's schema requires; servers are named `<name>.example`. */
const cid = (name: string) => `10000000-0000-4000-8000-${Buffer.from(name.slice(-1)).toString('hex').padStart(12, '0')}`
const info = (name: string, generation = 1) => ({ ...connectionInfo(cid(name), generation), server: `${name}.example` })

/** Timers that run only when told: `advance` runs everything due by then; `step` runs one due timer. */
function steppedTimers() {
  let now = 0, next = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: Timers = { setTimeout: (callback, ms) => { pending.set(next, { at: now + ms, callback }); return next++ }, clearTimeout: handle => { pending.delete(handle as number) } }
  const due = (until: number) => [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
  const step = () => { const timer = due(now); if (!timer) return false; pending.delete(timer[0]); timer[1].callback(); return true }
  const advance = (ms: number) => {
    const until = now + ms
    for (let timer = due(until); timer; timer = due(until)) { pending.delete(timer[0]); now = timer[1].at; timer[1].callback() }
    now = until
  }
  return { timers, step, advance, pending }
}

interface Sent { readonly params: ExplorerChildrenParams; resolve(result: ApiResult<ExplorerChildrenResult>): void; settled: boolean }
const folder = (owner: ObjectRef, id: FolderId): ExplorerNode => ({ ref: { type: 'folder', owner: { ...owner }, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
const object = (value: ObjectRef, label: string, fields: Partial<ExplorerNode> = {}): ExplorerNode => ({ ref: { type: 'object', object: value }, label, icon: kindSpecs[value.kind].icon, hasChildren: value.kind !== 'login', ...fields })
const failure = (code: ExplorerError['code'], message: string, nodes: ExplorerNode[] = []): ApiResult<ExplorerChildrenResult> =>
  ({ ok: true, value: { nodes, elapsedMs: 1, error: { code, message, retryable: code !== 'NOT_FOUND' && code !== 'NO_DB_ACCESS', ...code === 'NOT_FOUND' ? { action: 'refreshParent' as const } : {} } } })

/**
 * A backend with one server tree: Databases (System Databases, Database Snapshots, AppData, Offline), Security (Logins,
 * Audits), Server Objects; AppData has Tables (System Tables, then `tables`, paged by `pageSize`) and Views (empty);
 * tables have Columns (Id, Name). `hold` keeps matching requests unanswered until `release`.
 */
function fakeBackend() {
  const state = {
    tables: ['dbo.T0', 'dbo.T1', 'dbo.T2'], pageSize: 2000, dropped: new Set<string>(), auditsDenied: true, offline: true, failNext: undefined as ApiResult<ExplorerChildrenResult> | undefined,
    /** AppData's row fields (a sublabel, no chevron when offline), table subtypes and other row fields by name. */
    appData: {} as Partial<ExplorerNode>, subtypes: {} as Record<string, NodeSubtype>, tableFields: {} as Record<string, Partial<ExplorerNode>>,
    /** Locked cannot be opened while this holds; `leafTables` lists tables without a chevron. */
    lockedDenied: true, leafTables: false
  }
  const sent: Sent[] = []
  const holds: ((params: ExplorerChildrenParams) => boolean)[] = []
  const tableRef = (name: string): ObjectRef => { const [schema, table] = name.split('.'); return { kind: 'table', database: 'AppData', schema, name: table } }
  const ok = (nodes: ExplorerNode[], extra: Partial<ExplorerChildrenResult> = {}): ApiResult<ExplorerChildrenResult> => ({ ok: true, value: { nodes, elapsedMs: 1, total: nodes.length, ...extra } })
  function respond(params: ExplorerChildrenParams): ApiResult<ExplorerChildrenResult> {
    if (state.failNext) { const result = state.failNext; state.failNext = undefined; return result }
    const { node } = params
    if (node.type === 'object') {
      const value = node.object
      switch (value.kind) {
        case 'server': return ok([folder(value, 'databases'), folder(value, 'serverSecurity'), folder(value, 'serverObjects')])
        case 'database': return value.name === 'Locked' && state.lockedDenied ? failure('NO_DB_ACCESS', 'The current login cannot access database Locked.') : ok([folder(value, 'tables'), folder(value, 'views')])
        case 'table': return state.dropped.has(`${value.schema}.${value.name}`) ? failure('NOT_FOUND', `${value.schema}.${value.name} no longer exists.`) : ok([folder(value, 'columns'), folder(value, 'keys')])
        default: return ok([])
      }
    }
    const owner = node.owner
    switch (node.folder) {
      case 'databases': {
        const statics = [folder(owner, 'systemDatabases'), folder(owner, 'databaseSnapshots')]
        const rows = [object({ kind: 'database', name: 'AppData' }, 'AppData', state.appData), object({ kind: 'database', name: 'Locked' }, 'Locked', { status: 'noAccess' }),
          ...state.offline ? [object({ kind: 'database', name: 'Offline' }, 'Offline', { sublabel: '(Offline)', status: 'unavailable', hasChildren: false })] : []]
        const filtered = params.filter?.name ? rows.filter(row => row.label.includes(params.filter!.name!.value)) : rows
        return ok([...statics, ...filtered], { total: statics.length + filtered.length })
      }
      case 'systemDatabases': return ok(['master', 'model'].map(name => object({ kind: 'database', name }, name, { subtype: 'system' })))
      case 'serverSecurity': return ok([folder(owner, 'logins'), folder(owner, 'audits')])
      case 'logins': return ok([object({ kind: 'login', name: 'sa' }, 'sa')])
      case 'audits': return state.auditsDenied ? failure('PERMISSION_DENIED', 'You do not have permission to view Audits.') : ok([object({ kind: 'audit', name: 'LoginAudit' }, 'LoginAudit', { hasChildren: false })])
      case 'tables': {
        const offset = params.cursor ? Number(params.cursor.split('.')[2]) : 0
        const statics = params.cursor ? [] : [folder(owner, 'systemTables')]
        const names = params.filter?.name ? state.tables.filter(name => name.includes(params.filter!.name!.value)) : state.tables
        const rows = names.slice(offset, offset + state.pageSize).map(name => object(tableRef(name), name, { ...state.subtypes[name] ? { subtype: state.subtypes[name] } : {}, ...state.leafTables ? { hasChildren: false } : {}, ...state.tableFields[name] }))
        const end = offset + state.pageSize
        return { ok: true, value: { nodes: [...statics, ...rows], elapsedMs: 1, ...params.cursor ? {} : { total: 1 + names.length }, ...end < names.length ? { cursor: `v1.tables.${end}` } : {} } }
      }
      case 'columns': {
        const parent = { kind: 'table' as const, schema: owner.schema!, name: owner.name! }
        if (state.dropped.has(`${owner.schema}.${owner.name}`)) return failure('NOT_FOUND', `${owner.schema}.${owner.name} no longer exists.`)
        return ok(['Id', 'Name'].map(name => object({ kind: 'column', database: owner.database, parent: { ...parent }, name }, name, { hasChildren: false, sublabel: '(int, not null)' })))
      }
      default: return ok([])
    }
  }
  const api = {
    explorerChildren: vi.fn<VariaApi['explorerChildren']>(params => new Promise(resolve => {
      const entry: Sent = { params, settled: false, resolve: result => { if (entry.settled) return; entry.settled = true; resolve(result) } }
      sent.push(entry)
      // Every request is one main would accept.
      expect.soft(explorerChildrenParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(true)
      if (!holds.some(hold => hold(params))) entry.resolve(respond(params))
    })),
    explorerCancel: vi.fn<VariaApi['explorerCancel']>(async ids => {
      for (const entry of sent) if (!entry.settled && ids.includes(entry.params.requestId)) entry.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
      return { ok: true, value: { cancelled: ids.length } }
    })
  }
  const hold = (predicate: (params: ExplorerChildrenParams) => boolean) => { holds.push(predicate) }
  /** Stops holding requests; those already held wait for `release`. */
  const unhold = () => { holds.length = 0 }
  /** Answers the waiting requests that match. */
  const release = (predicate: (params: ExplorerChildrenParams) => boolean = () => true, result?: ApiResult<ExplorerChildrenResult>) => {
    for (const entry of sent) if (!entry.settled && predicate(entry.params)) entry.resolve(result ?? respond(entry.params))
  }
  return { api, sent, state, hold, unhold, release, respond }
}
const isFolder = (id: FolderId) => (params: ExplorerChildrenParams) => params.node.type === 'folder' && params.node.folder === id
const isPage = (id: FolderId) => (params: ExplorerChildrenParams) => isFolder(id)(params) && !!params.cursor

const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()) })

function fixture(limits: Partial<ExplorerServiceLimits> = {}) {
  const backend = fakeBackend()
  const connections = new ConnectionService(), events = new EventBus(), emitted: WorkbenchEvent[] = []
  events.subscribe(event => emitted.push(event))
  const clock = steppedTimers()
  let ids = 0
  const explorer = new ExplorerService({ api: backend.api, connections, events, timers: clock.timers, schedule: callback => callback(), newId: () => uuid(++ids), limits })
  disposals.push(() => explorer.dispose())
  const connect = (name = 'server-a') => connections.add({ ...info(name), productVersion: '16.0.4135.4', login: 'sa' }, connectionOptions)
  const rows = () => explorer.getSnapshot().rows
  /** Visible rows as labels; synthetic rows as their text in brackets. */
  const labels = () => Array.from(rows().ids, id => id > 0 ? '  '.repeat(explorer.node(id)!.level - 1) + explorer.node(id)!.label : `[${explorer.rowText(id)}]`)
  const find = (label: string, under?: number) => {
    const ids = Array.from(rows().ids).filter(id => id > 0 && explorer.node(id)!.label === label && (under === undefined || isBelow(id, under)))
    if (ids.length !== 1) throw new Error(`${ids.length} rows are labelled ${label}`)
    return ids[0]
  }
  const isBelow = (id: number, ancestor: number): boolean => { for (let node = explorer.node(id); node; node = explorer.node(node.parent)) if (node.id === ancestor) return true; return false }
  const open = async (...path: string[]) => {
    let under: number | undefined
    for (const label of path) { under = find(label, under); explorer.expand(under); await settle() }
    return under!
  }
  const calls = () => backend.sent.map(entry => entry.params)
  return { ...backend, backend, explorer, connections, events, emitted, clock, connect, rows, labels, find, open, calls }
}

/** Measure reconciliation's work, not a shared runner's GC pauses or setTimeout(0) wakeup time. Old refs count matching
 *  work; table reads catch a scan of every pending load for each unchanged leaf. Flattening visits the visible nodes
 *  directly, so it does not charge a table lookup for every visible row. The work meter counts the array copying, sorting
 *  and flattening that touch neither. */
async function reconcilePages(f: ReturnType<typeof fixture>, tables: number, matches: (params: ExplorerChildrenParams) => boolean = isFolder('tables')) {
  let refs = 0, lookups = 0
  const table = f.explorer.table, get = table.get
  table.get = function(id) { lookups++; return get.call(this, id) }
  for (const child of f.explorer.node(tables)!.children!) {
    const ref = child.ref
    Object.defineProperty(child, 'ref', { configurable: true, enumerable: true, get: () => { refs++; return ref } })
  }
  let pages = 0
  const folderRows = f.explorer.node(tables)!.children!.length
  try {
    for (;;) {
      const pending = f.sent.filter(entry => !entry.settled && matches(entry.params))
      if (!pending.length) break
      expect(pending).toHaveLength(1)
      const offset = pending[0].params.cursor ? Number(pending[0].params.cursor.split('.')[2]) : 0
      const count = Math.min(f.state.pageSize, f.state.tables.length - offset) + (offset === 0 ? 1 : 0)
      const version = f.explorer.getSnapshot().version
      refs = lookups = 0
      // The next page stays unanswered across this event-loop turn: its predecessor must be published independently.
      const { work } = await meterWork(async () => { f.release(matches); await settle(); f.explorer.getSnapshot() })
      // Work grows with the arriving page, rather than the old folder or the unrelated pending-load queue per row.
      const budget = count * 16
      expect(refs, `page ${pages + 1}: old-node identity reads`).toBeLessThanOrEqual(budget)
      expect(lookups, `page ${pages + 1}: node-table reads`).toBeLessThanOrEqual(budget)
      // Array work the counters above cannot see: a page passes over the folder about three times (the waiting rows' slice
      // and filter, and the children's concat) plus a few times over its own rows, and the snapshot is flattened once. An
      // extra copy or a sort of the folder per page, or a second flatten, is more work here, whatever the runner's speed.
      expect(work.elements, `page ${pages + 1}: array elements visited or copied ${JSON.stringify(work)}`).toBeLessThanOrEqual(3.5 * folderRows + 8 * count)
      expect(work.allocations, `page ${pages + 1}: typed arrays allocated (one flatten) ${JSON.stringify(work)}`).toBeLessThanOrEqual(5)
      expect(work.costly, `page ${pages + 1}: locale-aware or regular-expression calls ${JSON.stringify(work)}`).toBeLessThanOrEqual(8)
      const loaded = Math.min(offset + f.state.pageSize, f.state.tables.length)
      expect(f.explorer.node(tables)!.children![loaded].label).toBe(f.state.tables[loaded - 1])
      expect(f.explorer.getSnapshot().version).toBeGreaterThan(version)
      const next = f.sent.filter(entry => !entry.settled && matches(entry.params))
      expect(next).toHaveLength(loaded < f.state.tables.length ? 1 : 0)
      // A user selection is still applied while the next page waits, rather than waiting for the entire folder.
      const selected = pages % 2 ? tables : f.explorer.node(tables)!.children![1].id
      f.explorer.select(selected)
      expect(f.explorer.getSnapshot().selected).toBe(selected)
      pages++
    }
    return pages
  } finally { table.get = get }
}

describe('ExplorerService: loading', () => {
  it('expands a new server, loads nothing below its static folders, and selects it', async () => {
    const f = fixture()
    f.connect()
    await settle()
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '  Security', '  Server Objects'])
    expect(f.calls().map(params => params.node)).toEqual([{ type: 'object', object: { kind: 'server' } }])
    const root = f.explorer.node(f.find('server-a.example'))!
    expect([root.sublabel, root.icon, root.expanded, root.level]).toEqual(['(SQL Server 16.0.4135.4 - sa)', 'server', true, 1])
    expect(f.explorer.getSnapshot().selected).toBe(root.id)
    expect(serverSublabel({ serverVersion: '15.0', productVersion: undefined, login: undefined })).toBe('(SQL Server 15.0)')
    expect(serverSublabel({ serverVersion: '15.0', productVersion: '15.0.2000.5', login: undefined })).toBe('(SQL Server 15.0.2000.5)')
  })
  it('shows a folder\'s static subfolders before its rows, and positions count every child', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Databases')
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '    System Databases', '    Database Snapshots', '    AppData', '    Locked', '    Offline', '  Security', '  Server Objects'])
    const rows = f.rows()
    expect(Array.from(rows.posinset.slice(2, 7))).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(rows.setsize.slice(2, 7))).toEqual([5, 5, 5, 5, 5])
    const offline = f.explorer.node(f.find('Offline'))!
    expect([offline.hasChildren, offline.status, offline.sublabel]).toEqual([false, 'unavailable', '(Offline)'])
    expect(f.calls()[1]).toEqual({ connectionId: cid('server-a'), requestId: uuid(2), node: { type: 'folder', owner: { kind: 'server' }, folder: 'databases' } })
  })
  it('passes the subtype of the node it expands, and never a folder\'s', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Databases', 'System Databases', 'master')
    expect(f.calls().at(-1)).toMatchObject({ node: { type: 'object', object: { kind: 'database', name: 'master' } }, subtype: 'system' })
    expect(f.calls().at(-2)).not.toHaveProperty('subtype')
  })
  it('shows a loading row only when the first page takes longer than 150 ms', async () => {
    const f = fixture()
    f.connect()
    await settle()
    f.hold(isFolder('databases'))
    f.explorer.expand(f.find('Databases'))
    f.clock.advance(149)
    expect(f.labels()).not.toContain('[Loading…]')
    f.clock.advance(1)
    expect(f.labels().slice(1, 3)).toEqual(['  Databases', '[Loading…]'])
    f.release()
    await settle()
    expect(f.labels()).not.toContain('[Loading…]')
    // Fast answers never show it.
    f.explorer.expand(f.find('Security'))
    await settle()
    f.clock.advance(1000)
    expect(f.labels()).not.toContain('[Loading…]')
  })
  it('drops the chevron of an empty folder and announces it', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const views = await f.open('Databases', 'AppData', 'Views')
    expect(f.explorer.node(views)).toMatchObject({ hasChildren: false, expanded: false, load: 'loaded' })
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Views: no items')
  })
  it('keeps loading a folder\'s pages in the background while it is expanded', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 7 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 3
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const at = f.labels().indexOf('      Tables')
    expect(f.labels().slice(at, at + 7)).toEqual(['      Tables', '        System Tables', '        dbo.T0', '        dbo.T1', '        dbo.T2', '[Loading… 4 of 8]', '      Views'])
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: loaded 4 of 8')
    expect(f.calls().at(-1)).toMatchObject({ cursor: 'v1.tables.3' })
    f.unhold()
    f.release()
    await settle()
    expect(f.explorer.node(tables)).toMatchObject({ more: 'none', cursor: undefined, total: 8 })
    expect(f.explorer.node(tables)!.children!.length).toBe(8)
    expect(f.calls().filter(isFolder('tables')).map(params => params.cursor)).toEqual([undefined, 'v1.tables.3', 'v1.tables.6'])
  })
  it('lets user loads overtake background pages', async () => {
    const f = fixture({ inFlightTotal: 1 })
    f.state.tables = Array.from({ length: 10 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 2
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    await f.open('Databases', 'AppData', 'Tables')
    f.explorer.expand(f.find('Security'))
    f.release(isPage('tables'))
    await settle()
    // The page that was running finished; then Security went before the next page.
    const order = f.calls().slice(-3).map(params => params.node.type === 'folder' ? params.node.folder + (params.cursor ? ':' + params.cursor : '') : 'object')
    expect(order).toEqual(['tables:v1.tables.2', 'serverSecurity', 'tables:v1.tables.4'])
  })
  it('stops a collapsed folder\'s loads and resumes from its cursor when it is expanded again', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 5 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 2
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const page = f.sent.at(-1)!
    expect(page.params.cursor).toBe('v1.tables.2')
    f.explorer.collapse(tables)
    await settle()
    expect(f.api.explorerCancel).toHaveBeenCalledWith([page.params.requestId])
    expect(f.explorer.node(tables)).toMatchObject({ cursor: 'v1.tables.2', more: 'auto', children: expect.any(Array) })
    f.unhold()
    f.explorer.expand(tables)
    await settle()
    const pages = f.calls().filter(isPage('tables'))
    expect(pages.map(params => params.cursor)).toEqual(['v1.tables.2', 'v1.tables.2', 'v1.tables.4'])
    expect(new Set(pages.map(params => params.requestId)).size).toBe(3)
    expect(f.explorer.node(tables)!.children!.length).toBe(6)
  })
  it('resumes a descendant\'s interrupted load when its ancestor is expanded again', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    f.hold(isFolder('systemDatabases'))
    const system = f.find('System Databases')
    f.explorer.expand(system)
    f.explorer.collapse(databases)
    await settle()
    expect(f.explorer.node(system)).toMatchObject({ expanded: true, load: 'none' })
    f.unhold()
    f.explorer.expand(databases)
    await settle()
    expect(f.labels()).toContain('      master')
  })
  it('caps a folder at the folder limit, and says how to narrow it', async () => {
    const f = fixture({ folderCap: 5 })
    f.state.tables = Array.from({ length: 8 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 3
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    expect(f.explorer.node(tables)).toMatchObject({ more: 'capped', cursor: undefined })
    expect(f.explorer.node(tables)!.children).toHaveLength(5)
    expect(f.labels()).toContain('[Showing the first 5 of 9 items in Tables. Use Filter Settings to narrow the list.]')
    expect(f.calls().filter(isFolder('tables'))).toHaveLength(2)
  })
})

describe('ExplorerService: errors', () => {
  it('shows a folder error as a row, keeps static folders, and retries with Enter', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const audits = await f.open('Security', 'Audits')
    const error = syntheticId(audits, RowKind.Error)
    expect(f.labels()).toContain('[You do not have permission to view Audits. Press Enter to retry.]')
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Could not load Audits: You do not have permission to view Audits.')
    f.state.auditsDenied = false
    f.explorer.retry(error)
    await settle()
    expect(f.labels()).toContain('      LoginAudit')
    expect(f.labels().some(label => label.startsWith('[You do not'))).toBe(false)
  })
  it('shows a failed page below the loaded rows and retries only that page', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 4 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 2
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.release(isPage('tables'), failure('BLOCKED', 'Another session holds a lock on this metadata.'))
    await settle()
    expect(f.labels().filter(label => label.includes('dbo.T'))).toHaveLength(2)
    expect(f.labels()).toContain('[Could not load more: Another session holds a lock on this metadata. Press Enter to retry.]')
    f.unhold()
    f.explorer.retry(syntheticId(tables, RowKind.MoreError))
    await settle()
    expect(f.labels().filter(label => label.includes('dbo.T'))).toHaveLength(4)
    expect(f.calls().filter(isPage('tables')).map(params => params.cursor)).toEqual(['v1.tables.2', 'v1.tables.2'])
  })
  it('refreshes the parent of an object that no longer exists', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    await f.open('dbo.T1')
    f.state.dropped.add('dbo.T1')
    const columns = await f.open('Columns')
    expect(f.labels()).toContain('[dbo.T1 no longer exists. Press Enter to refresh Tables.]')
    expect(f.explorer.rowText(syntheticId(columns, RowKind.Error))).toBe('dbo.T1 no longer exists. Press Enter to refresh Tables.')
    f.state.tables = ['dbo.T0', 'dbo.T2']
    f.explorer.select(syntheticId(columns, RowKind.Error))
    f.explorer.retry(syntheticId(columns, RowKind.Error))
    await settle()
    expect(f.calls().at(-1)!.node).toEqual({ type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' })
    expect(f.labels().filter(label => label.includes('dbo.T'))).toEqual(['        dbo.T0', '        dbo.T2'])
    expect(f.explorer.getSnapshot().selected).toBe(tables)
  })
  it('shows names and server text in error rows and announcements with visible markers', async () => {
    const f = fixture()
    f.connect()
    await settle()
    f.state.failNext = failure('NOT_FOUND', 'dbo.txt.\u202eexe\u202c\nfake line no longer exists.')
    await f.open('Databases')
    const shown = 'dbo.txt.⟨U+202E⟩exe⟨U+202C⟩⟨U+000A⟩fake line no longer exists.'
    expect(f.labels()).toContain(`[${shown} Press Enter to refresh server-a.example.]`)
    expect(f.explorer.getSnapshot().announcement?.text).toBe(`Could not load Databases: ${shown}`)
  })
  it('states a non-retryable error without a retry hint', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Databases', 'Locked')
    expect(f.labels()).toContain('[The current login cannot access database Locked.]')
  })
  it('marks the server when its connection fails, until a load succeeds', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const root = f.find('server-a.example')
    f.state.failNext = { ok: false, error: 'Connect to a SQL Server first.', code: 'NOT_CONNECTED' }
    await f.open('Databases')
    expect(f.explorer.node(root)!.connectionError).toMatchObject({ code: 'CONNECTION_LOST', message: 'Connect to a SQL Server first.' })
    expect(f.labels()).toContain('[Connect to a SQL Server first. Press Enter to retry.]')
    f.explorer.retry(syntheticId(f.find('Databases'), RowKind.Error))
    await settle()
    expect(f.explorer.node(root)!.connectionError).toBeUndefined()
    expect(f.labels()).toContain('    AppData')
  })
})

describe('ExplorerService: refresh', () => {
  it('keeps old rows until the first page, then keeps what is still there, expanded and selected, and reloads it too', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const tables = await f.open('AppData', 'Tables')
    const app = f.find('AppData'), t1 = f.find('dbo.T1')
    await f.open('System Databases')
    f.explorer.collapse(f.find('System Databases'))
    f.explorer.select(t1)
    f.hold(isFolder('databases'))
    const from = f.calls().length, events = f.emitted.length
    f.explorer.refresh(databases)
    expect(f.labels()).toContain('        dbo.T0')
    f.state.tables = ['dbo.T1', 'dbo.T2', 'dbo.T3']
    f.release()
    await settle()
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '    System Databases', '    Database Snapshots', '    AppData', '      Tables', '        System Tables', '        dbo.T1', '        dbo.T2',
      '        dbo.T3', '      Views', '    Locked', '    Offline', '  Security', '  Server Objects'])
    expect([f.find('AppData'), f.find('Tables'), f.find('dbo.T1')]).toEqual([app, tables, t1])
    expect(f.explorer.getSnapshot().selected).toBe(t1)
    // Expanded nodes below reload in turn; a collapsed one that was loaded waits to be expanded. One event says so.
    expect(f.calls().slice(from).map(params => params.node.type === 'folder' ? params.node.folder : params.node.object.kind)).toEqual(['databases', 'database', 'tables'])
    expect(f.emitted.slice(events)).toEqual([{ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'databases' }])
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
    expect(f.explorer.node(f.find('System Databases'))).toMatchObject({ load: 'none', expanded: false, children: expect.any(Array) })
    f.explorer.expand(f.find('System Databases'))
    await settle()
    expect(f.calls().at(-1)!.node).toMatchObject({ folder: 'systemDatabases' })
  })
  it('moves the selection to the refreshed node when its node is gone, and refreshes a leaf\'s parent', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const offline = f.find('Offline')
    f.explorer.select(offline)
    f.state.offline = false
    f.explorer.refresh(offline)
    await settle()
    expect(f.calls().at(-1)!.node).toMatchObject({ folder: 'databases' })
    expect(f.explorer.getSnapshot().selected).toBe(databases)
    expect(f.labels()).not.toContain('    Offline')
    expect(f.emitted.at(-1)).toEqual({ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'databases' })
    // A folder refreshes itself, and so does an empty one.
    const views = await f.open('AppData', 'Views')
    f.explorer.refresh(views)
    await settle()
    expect(f.calls().at(-1)!.node).toMatchObject({ folder: 'views' })
    expect(f.emitted.at(-1)).toEqual({ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'other' })
  })
  it('keeps the old rows and puts an error first when a refresh fails', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.state.failNext = failure('BLOCKED', 'Another session holds a lock on this metadata.')
    f.explorer.refresh(tables)
    await settle()
    const index = f.labels().indexOf('      Tables')
    expect(f.labels().slice(index, index + 3)).toEqual(['      Tables', '[Refresh failed: Another session holds a lock on this metadata. Press Enter to retry.]', '        System Tables'])
    expect(f.labels()).toContain('        dbo.T2')
    f.state.tables = ['dbo.T9']
    f.explorer.retry(syntheticId(tables, RowKind.Error))
    await settle()
    expect(f.labels().filter(label => label.includes('dbo.T'))).toEqual(['        dbo.T9'])
  })
  it('keeps a collapsed node\'s rows until it is expanded, and finishes an interrupted refresh when expanded again', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const app = f.find('AppData')
    f.explorer.collapse(databases)
    const before = f.calls().length
    f.explorer.refresh(databases)
    expect(f.calls().length).toBe(before)
    expect(f.explorer.node(databases)).toMatchObject({ children: expect.any(Array), load: 'none', expanded: false })
    f.state.offline = false
    f.explorer.expand(databases)
    await settle()
    expect(f.calls().length).toBe(before + 1)
    expect(f.find('AppData')).toBe(app)
    expect(f.labels()).not.toContain('    Offline')
    f.hold(isFolder('databases'))
    f.explorer.refresh(databases)
    f.explorer.collapse(databases)
    await settle()
    expect(f.sent.at(-1)!.settled).toBe(true)
    expect(f.explorer.node(databases)).toMatchObject({ load: 'none', expanded: false })
    f.unhold()
    f.state.offline = true
    f.explorer.expand(databases)
    await settle()
    expect(f.find('AppData')).toBe(app)
    expect(f.labels()).toContain('    Offline')
    expect(f.explorer.node(databases)!.load).toBe('loaded')
  })
  it('stops a folder that was loading pages below a refresh that is stopped, or resumes it when the refresh fails', async () => {
    const isApp = (params: ExplorerChildrenParams) => params.node.type === 'object' && params.node.object.kind === 'database' && params.node.object.name === 'AppData'
    for (const outcome of ['stop', 'fail'] as const) {
      const f = fixture()
      f.state.tables = Array.from({ length: 10 }, (_, index) => `dbo.T${index}`)
      f.state.pageSize = 3
      f.connect()
      await settle()
      f.hold(isPage('tables'))
      const tables = await f.open('Databases', 'AppData', 'Tables')
      expect(f.labels()).toContain('[Loading… 4 of 11]')
      f.hold(isApp)
      f.explorer.refresh(f.find('AppData'))
      await settle()
      // Until the refresh answers, the folder's old rows stay and nothing below it loads.
      expect(f.sent.filter(entry => isPage('tables')(entry.params) && !entry.settled)).toHaveLength(0)
      if (outcome === 'stop') {
        f.explorer.stop()
        await settle()
        expect(f.labels()).toContain('[Stopped after 4 of 11 items. Press Enter to continue loading.]')
        expect(f.labels()).not.toContain('[Loading… 4 of 11]')
        expect(f.explorer.context.getSnapshot().explorerLoading).toBe(false)
        f.unhold()
        f.explorer.continueLoading(syntheticId(tables, RowKind.Stopped))
      } else {
        f.release(isApp, failure('DATABASE_UNAVAILABLE', 'Database AppData is not available.'))
        await settle()
        expect(f.labels()).toContain('[Refresh failed: Database AppData is not available. Press Enter to retry.]')
        expect(f.sent.filter(entry => isPage('tables')(entry.params) && !entry.settled).map(entry => entry.params.cursor)).toEqual(['v1.tables.3'])
        f.unhold()
        f.release(isPage('tables'))
      }
      await settle()
      expect(f.explorer.node(tables)).toMatchObject({ more: 'none', cursor: undefined })
      expect(f.explorer.node(tables)!.children).toHaveLength(11)
    }
  })
  it('puts back how far a folder had got when its refresh is stopped before the first page', async () => {
    const f = fixture({ folderCap: 8 })
    f.state.tables = Array.from({ length: 10 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 3
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.explorer.stop()
    await settle()
    const stopped = '[Stopped after 4 of 11 items. Press Enter to continue loading.]'
    expect(f.labels()).toContain(stopped)
    f.unhold()
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    f.explorer.stop()
    await settle()
    expect(f.explorer.node(tables)).toMatchObject({ more: 'stopped', cursor: 'v1.tables.3', total: 11, load: 'loaded' })
    expect(f.labels()).toContain(stopped)
    // A capped folder keeps saying it is capped.
    f.unhold()
    f.explorer.continueLoading(syntheticId(tables, RowKind.Stopped))
    await settle()
    const capped = '[Showing the first 8 of 11 items in Tables. Use Filter Settings to narrow the list.]'
    expect(f.labels()).toContain(capped)
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    expect(f.labels()).not.toContain(capped)
    f.explorer.stop()
    await settle()
    expect(f.labels()).toContain(capped)
    // A refresh that fails puts it back too, below its error row.
    f.unhold()
    f.state.failNext = failure('BLOCKED', 'Another session holds a lock on this metadata.')
    f.explorer.refresh(tables)
    await settle()
    expect(f.labels()).toContain('[Refresh failed: Another session holds a lock on this metadata. Press Enter to retry.]')
    expect(f.labels()).toContain(capped)
  })
  it('puts back how far a folder had got when its refresh waits below a collapsed node and Stop is pressed', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 10 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 3
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    const tables = await f.open('Databases', 'AppData', 'Tables')
    expect(f.labels()).toContain('[Loading… 4 of 11]')
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    const app = f.find('AppData')
    f.explorer.collapse(app)
    f.hold(isFolder('serverSecurity'))
    f.explorer.expand(f.find('Security'))
    expect(f.explorer.context.getSnapshot().explorerLoading).toBe(true)
    f.explorer.stop()
    f.unhold()
    f.explorer.expand(app)
    await settle()
    expect(f.explorer.node(tables)).toMatchObject({ load: 'loaded', more: 'stopped', cursor: 'v1.tables.3', total: 11 })
    expect(f.labels()).toContain('[Stopped after 4 of 11 items. Press Enter to continue loading.]')
    f.explorer.continueLoading(syntheticId(tables, RowKind.Stopped))
    await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(11)
  })
  it('refreshes every server when nothing is selected, and drops a stale answer', async () => {
    const f = fixture()
    f.connect('server-a')
    f.connect('server-b')
    await settle()
    const databases = f.find('Databases', f.find('server-a.example'))
    f.hold(isFolder('databases'))
    f.explorer.expand(databases)
    const stale = f.sent.at(-1)!
    f.explorer.refresh(databases)
    await settle()
    // The first load was cancelled; its answer changes nothing.
    expect(stale.settled).toBe(true)
    expect(f.explorer.node(databases)!.children).toBeUndefined()
    f.release()
    await settle()
    expect(f.explorer.node(databases)!.children).toHaveLength(5)
    const reloads = f.calls().length
    f.explorer.refresh()
    await settle()
    // Then server-a's expanded Databases, below it.
    expect(f.calls().slice(reloads).map(params => [params.connectionId, params.node.type])).toEqual([[cid('server-a'), 'object'], [cid('server-b'), 'object'], [cid('server-a'), 'folder']])
    expect(f.emitted.filter(event => event.type === 'explorer.refreshed' && event.scope === 'server')).toHaveLength(2)
  })
})

describe('ExplorerService: reconcile', () => {
  const table = (name: string): ExplorerNodeRef => ({ type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name } })
  it('diffs a folder by identity after DDL: kept rows keep their node and what is expanded below them, which is not reloaded', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const t1 = f.find('dbo.T1'), t2 = f.find('dbo.T2'), t0 = f.find('dbo.T0')
    const columns = await f.open('dbo.T1', 'Columns')
    const id = f.find('Id')
    f.explorer.select(id)
    f.state.tables = ['dbo.T1', 'dbo.T2', 'dbo.T3']
    const from = f.calls().length
    f.explorer.reconcile(tables)
    expect(f.emitted.at(-1)).toEqual({ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'other' })
    await settle()
    expect(f.calls().slice(from).map(params => params.node)).toEqual([{ type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' }])
    const at = f.labels().indexOf('      Tables')
    expect(f.labels().slice(at, at + 10)).toEqual(['      Tables', '        System Tables', '        dbo.T1', '          Columns', '            Id', '            Name', '          Keys', '        dbo.T2', '        dbo.T3', '      Views'])
    expect([f.find('dbo.T1'), f.find('dbo.T2'), f.find('Columns'), f.find('Id')]).toEqual([t1, t2, columns, id])
    expect(f.explorer.getSnapshot().selected).toBe(id)
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
    f.clock.advance(0)
    expect(f.explorer.node(t0)).toBeUndefined()
    // Nothing changed: nothing is announced.
    const announcement = f.explorer.getSnapshot().announcement
    f.explorer.reconcile(tables)
    await settle()
    expect(f.explorer.getSnapshot().announcement).toBe(announcement)
  })
  it('selects the identity it was asked to once a page brings it, else the folder; a selection made meanwhile wins', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.state.tables = ['dbo.T0', 'dbo.T1', 'dbo.T9']
    f.explorer.reconcile(tables, { select: table('T9') })
    await settle()
    const t9 = f.find('dbo.T9'), reveal = f.explorer.getSnapshot().reveal
    expect(f.explorer.getSnapshot().selected).toBe(t9)
    expect(reveal).toBeDefined()
    f.explorer.reconcile(tables, { select: table('Gone') })
    await settle()
    expect(f.explorer.getSnapshot().selected).toBe(tables)
    expect(f.explorer.getSnapshot().reveal).not.toBe(reveal)
    // A collapsed folder opens to show it.
    f.explorer.collapse(tables)
    f.explorer.reconcile(tables, { select: table('T1') })
    await settle()
    expect(f.explorer.node(tables)!.expanded).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(f.find('dbo.T1'))
    f.hold(isFolder('tables'))
    f.explorer.reconcile(tables, { select: table('T0') })
    const views = f.find('Views')
    f.explorer.select(views)
    f.release()
    await settle()
    expect(f.explorer.getSnapshot().selected).toBe(views)
    // A filter applied meanwhile drops the selection still to be made.
    f.hold(isFolder('tables'))
    f.explorer.reconcile(tables, { select: table('T0') })
    f.explorer.setFilter(tables, { name: { op: 'contains', value: 'T' } })
    f.release()
    await settle()
    f.unhold()
    f.explorer.refresh(tables)
    await settle()
    expect(f.explorer.getSnapshot().selected).toBe(views)
    // So does Stop: a later refresh does not move the selection.
    f.hold(isFolder('tables'))
    f.explorer.reconcile(tables, { select: table('T1') })
    f.explorer.stop()
    await settle()
    f.unhold()
    f.explorer.refresh(tables)
    await settle()
    expect(f.find('dbo.T1')).toBeDefined()
    expect(f.explorer.getSnapshot().selected).toBe(views)
  })
  it('keeps the old rows a paged folder has not brought back until its last page, through Stop, then removes them', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 6 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 2
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    expect(f.explorer.node(tables)!.children).toHaveLength(7)
    const t5 = f.find('dbo.T5'), t1 = f.find('dbo.T1')
    f.explorer.select(t5)
    f.state.tables = ['dbo.T0', 'dbo.T2', 'dbo.T3', 'dbo.T4', 'dbo.T5', 'dbo.T6']
    f.hold(isPage('tables'))
    f.explorer.reconcile(tables)
    await settle()
    const rows = () => f.labels().filter(label => label.includes('dbo.T') || label.startsWith('[')).map(label => label.trim())
    // The first page brought T0 and T2; T1, T3, T4 and T5 wait below them, and the count is of what came back.
    expect(rows()).toEqual(['dbo.T0', 'dbo.T2', 'dbo.T1', 'dbo.T3', 'dbo.T4', 'dbo.T5', '[Loading… 3 of 7]'])
    expect(f.explorer.getSnapshot().selected).toBe(t5)
    f.explorer.stop()
    await settle()
    expect(rows()).toEqual(['dbo.T0', 'dbo.T2', 'dbo.T1', 'dbo.T3', 'dbo.T4', 'dbo.T5', '[Stopped after 3 of 7 items. Press Enter to continue loading.]'])
    // A refresh stopped before its first page puts the reconcile back, so continuing still matches the waiting rows.
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    expect(rows()).toEqual(['dbo.T0', 'dbo.T2', 'dbo.T1', 'dbo.T3', 'dbo.T4', 'dbo.T5'])
    f.explorer.stop()
    await settle()
    expect(rows()).toEqual(['dbo.T0', 'dbo.T2', 'dbo.T1', 'dbo.T3', 'dbo.T4', 'dbo.T5', '[Stopped after 3 of 7 items. Press Enter to continue loading.]'])
    f.unhold()
    f.explorer.continueLoading(syntheticId(tables, RowKind.Stopped))
    await settle()
    expect(rows()).toEqual(['dbo.T0', 'dbo.T2', 'dbo.T3', 'dbo.T4', 'dbo.T5', 'dbo.T6'])
    expect(f.explorer.getSnapshot().selected).toBe(t5)
    expect(f.explorer.node(tables)).toMatchObject({ more: 'none', cursor: undefined, total: 7 })
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
    f.clock.advance(0)
    expect(f.explorer.node(t1)).toBeUndefined()
  })
  it('removes the old rows that the folder cap leaves out', async () => {
    const f = fixture({ folderCap: 5 })
    f.state.tables = Array.from({ length: 8 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 2
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    expect(f.explorer.node(tables)).toMatchObject({ more: 'capped' })
    f.state.tables = Array.from({ length: 8 }, (_, index) => `dbo.N${index}`)
    f.explorer.reconcile(tables)
    await settle()
    expect(f.explorer.node(tables)!.children!.map(child => child.label)).toEqual(['System Tables', 'dbo.N0', 'dbo.N1', 'dbo.N2', 'dbo.N3'])
    expect(f.labels()).toContain('[Showing the first 5 of 9 items in Tables. Use Filter Settings to narrow the list.]')
  })
  it('updates the rows it keeps: their label and state, a lost chevron collapses them, a new subtype lists their folders again', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const app = await f.open('AppData')
    const tables = await f.open('Tables')
    const t1 = await f.open('dbo.T1')
    f.state.subtypes['dbo.T1'] = 'systemVersioned'
    f.state.tableFields['dbo.T1'] = { label: 'dbo.T1 (System-Versioned)', detail: 'Created 2024-05-01', icon: kindSpecs.view.icon, created: '2024-05-01T09:30:00' }
    f.explorer.reconcile(tables)
    await settle()
    expect(f.find('dbo.T1 (System-Versioned)')).toBe(t1)
    expect(f.calls().at(-1)).toMatchObject({ node: { type: 'object', object: { kind: 'table', name: 'T1' } }, subtype: 'systemVersioned' })
    expect(f.explorer.node(t1)).toMatchObject({ subtype: 'systemVersioned', expanded: true, load: 'loaded', detail: 'Created 2024-05-01', icon: kindSpecs.view.icon, created: '2024-05-01T09:30:00' })
    expect(f.explorer.node(t1)!.lower).toBe('dbo.t1 (system-versioned)')
    f.state.appData = { sublabel: '(Read-Only)' }
    f.explorer.reconcile(databases)
    await settle()
    expect(f.find('AppData')).toBe(app)
    expect(f.explorer.node(app)).toMatchObject({ sublabel: '(Read-Only)', expanded: true })
    f.explorer.select(t1)
    f.state.appData = { sublabel: '(Offline)', status: 'unavailable', hasChildren: false }
    f.explorer.reconcile(databases)
    await settle()
    expect(f.explorer.node(app)).toMatchObject({ sublabel: '(Offline)', status: 'unavailable', hasChildren: false, expanded: false, children: undefined })
    expect(f.explorer.getSnapshot().selected).toBe(app)
    // Back online: the chevron returns, and expanding lists its folders again.
    f.state.appData = {}
    f.explorer.reconcile(databases)
    await settle()
    expect(f.explorer.node(app)).toMatchObject({ hasChildren: true, expanded: false, load: 'none' })
    f.explorer.expand(app)
    await settle()
    expect(f.labels()).toContain('      Tables')
  })
  it('drops the error of a row it keeps and loads it again: at once when expanded, else when next expanded', async () => {
    // After DDL (Database Properties set MULTI_USER, say) on the listing folder, with the row expanded.
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const locked = await f.open('Locked')
    expect(f.labels()).toContain('[The current login cannot access database Locked.]')
    f.state.lockedDenied = false
    f.explorer.reconcile(databases)
    await settle()
    expect(f.find('Locked')).toBe(locked)
    expect(f.explorer.node(locked)).toMatchObject({ load: 'loaded', error: undefined, expanded: true })
    expect(f.labels().filter(label => label.startsWith('['))).toEqual([])
    expect(f.find('Tables', locked)).toBeDefined()
    // After F5 on the folder, with the row expanded: it loads as a first load, which announces nothing as added.
    const h = fixture()
    h.connect()
    await settle()
    const listing = await h.open('Databases')
    const opened = await h.open('Locked')
    h.state.lockedDenied = false
    h.explorer.refresh(listing)
    await settle()
    expect(h.explorer.node(opened)).toMatchObject({ load: 'loaded', error: undefined, expanded: true })
    expect(h.explorer.node(opened)!.children!.map(child => child.label)).toEqual(['Tables', 'Views'])
    expect(h.explorer.getSnapshot().announcement?.text).toBe('Could not load Locked: The current login cannot access database Locked.')
    // After F5 on the folder (access granted, say), with the row collapsed: expanding it loads it.
    const g = fixture()
    g.connect()
    await settle()
    const folder = await g.open('Databases')
    const row = await g.open('Locked')
    g.explorer.collapse(row)
    g.state.lockedDenied = false
    g.explorer.refresh(folder)
    await settle()
    expect(g.explorer.node(row)).toMatchObject({ load: 'none', error: undefined, expanded: false })
    const from = g.calls().length
    g.explorer.expand(row)
    await settle()
    expect(g.calls().slice(from).map(params => params.node)).toEqual([{ type: 'object', object: { kind: 'database', name: 'Locked' } }])
    expect(g.explorer.node(row)!.children!.map(child => child.label)).toEqual(['Tables', 'Views'])
    // A row whose refresh failed keeps its rows, which are reconciled, so what is expanded below them stays.
    const app = g.find('AppData')
    g.explorer.expand(app)
    await settle()
    const tables = g.find('Tables', app)
    g.explorer.expand(tables)
    await settle()
    const t1 = g.find('dbo.T1')
    g.explorer.expand(t1)
    await settle()
    g.state.failNext = failure('BLOCKED', 'Another session holds a lock on this metadata.')
    g.explorer.refresh(tables)
    await settle()
    expect(g.labels()).toContain('[Refresh failed: Another session holds a lock on this metadata. Press Enter to retry.]')
    g.explorer.reconcile(app)
    await settle()
    expect(g.explorer.node(tables)).toMatchObject({ load: 'loaded', error: undefined, expanded: true })
    expect(g.labels().filter(label => label.startsWith('['))).toEqual([])
    expect(g.find('dbo.T1')).toBe(t1)
    expect(g.explorer.node(t1)!.expanded).toBe(true)
  })
  it('keeps a row the user expands while a refresh waits loading at the user\'s priority', async () => {
    const f = fixture({ inFlightPerConnection: 1 })
    f.state.tables = Array.from({ length: 6 }, (_, index) => `dbo.T${index}`)
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    for (const name of ['dbo.T0', 'dbo.T1', 'dbo.T2']) await f.open(name)
    const t5 = f.find('dbo.T5')
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    f.explorer.expand(t5)
    const from = f.calls().length
    f.unhold()
    f.release()
    while (f.explorer.context.getSnapshot().explorerLoading) await settle()
    // The expanded tables below reload in the background, after the one the user opened, which is not asked for again.
    expect(f.calls().slice(from).map(params => params.node.type === 'object' ? params.node.object.name : params.node.folder)).toEqual(['T5', 'T0', 'T1', 'T2'])
    expect(f.explorer.node(t5)).toMatchObject({ expanded: true, load: 'loaded' })
    expect(f.explorer.node(t5)!.children!.map(child => child.label)).toEqual(['Columns', 'Keys'])
  })
  it('reconciles in the background when asked, behind the user\'s loads, without a refreshed event', async () => {
    const f = fixture({ inFlightPerConnection: 1 })
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.hold(isFolder('views'))
    f.explorer.expand(f.find('Views'))
    const from = f.calls().length, events = f.emitted.length
    f.state.tables = ['dbo.T0', 'dbo.T1', 'dbo.T2', 'dbo.T3']
    f.explorer.reconcile(tables, { background: true })
    f.explorer.expand(f.find('Security'))
    f.unhold()
    f.release()
    while (f.explorer.context.getSnapshot().explorerLoading) await settle()
    expect(f.calls().slice(from).map(params => params.node.type === 'folder' ? params.node.folder : params.node.object.kind)).toEqual(['serverSecurity', 'tables'])
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added')
    expect(f.emitted.slice(events).filter(event => event.type === 'explorer.refreshed')).toEqual([])
  })
  it('reconciles 99,000 rows with bounded matching work and publishes each page before the next', async () => {
    const f = fixture()
    const names = Array.from({ length: 99_000 }, (_, index) => `dbo.Table${index}`)
    f.state.tables = names
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    while (f.explorer.node(tables)!.more === 'auto') await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(99_001)
    // The first row is gone, so every page after it is matched by name rather than in turn.
    f.state.tables = [...names.slice(1), 'dbo.Extra']
    f.hold(isFolder('tables'))
    f.explorer.reconcile(tables)
    expect(await reconcilePages(f, tables)).toBe(50)
    expect(f.explorer.node(tables)!.children).toHaveLength(99_001)
    expect(f.explorer.node(tables)!.children!.at(-1)!.label).toBe('dbo.Extra')
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
  })
  it('reconciles 99,000 leaves with bounded work while 300 loads wait on another server', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 300 }, (_, index) => `dbo.Wait${index}`)
    f.connect('server-a')
    f.connect('server-b')
    await settle()
    let waiting = f.find('server-b.example')
    for (const label of ['Databases', 'AppData', 'Tables']) { waiting = f.find(label, waiting); f.explorer.expand(waiting); await settle() }
    f.hold(params => params.connectionId === cid('server-b') && params.node.type === 'object')
    for (const child of f.explorer.node(waiting)!.children!.filter(child => child.kind === 'table')) f.explorer.expand(child.id)
    const names = Array.from({ length: 99_000 }, (_, index) => `dbo.Table${index}`)
    f.state.tables = names
    f.state.leafTables = true
    let tables = f.find('server-a.example')
    for (const label of ['Databases', 'AppData', 'Tables']) { tables = f.find(label, tables); f.explorer.expand(tables); await settle() }
    while (f.explorer.node(tables)!.more === 'auto') await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(99_001)
    f.state.tables = [...names.slice(1), 'dbo.Extra']
    const isA = (params: ExplorerChildrenParams) => params.connectionId === cid('server-a') && isFolder('tables')(params)
    f.hold(isA)
    f.explorer.reconcile(tables)
    expect(await reconcilePages(f, tables, isA)).toBe(50)
    expect(f.explorer.node(tables)!.children).toHaveLength(99_001)
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
    expect(f.explorer.context.getSnapshot().explorerLoading).toBe(true)
  })
})

describe('ExplorerService: stop, budget and eviction', () => {
  it('stops every load, shows how far folders got, and continues on Enter', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 6 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 2
    f.connect()
    await settle()
    f.hold(isPage('tables'))
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.hold(isFolder('serverSecurity'))
    const security = f.find('Security')
    f.explorer.expand(security)
    expect(f.explorer.context.getSnapshot().explorerLoading).toBe(true)
    f.explorer.stop()
    await settle()
    // One call for both: cancels are sent together.
    expect(f.api.explorerCancel.mock.calls.map(([ids]) => ids.length)).toEqual([2])
    expect(f.explorer.context.getSnapshot().explorerLoading).toBe(false)
    expect(f.labels()).toContain('[Stopped after 3 of 7 items. Press Enter to continue loading.]')
    // A first page that never arrived collapses.
    expect(f.explorer.node(security)).toMatchObject({ expanded: false, load: 'none' })
    f.unhold()
    f.explorer.continueLoading(syntheticId(tables, RowKind.Stopped))
    await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(7)
  })
  it('evicts the children of collapsed nodes, least recently used first, to stay within the node budget', async () => {
    const f = fixture({ nodeBudget: 20, pageSize: 2 })
    f.connect()
    await settle()
    const security = await f.open('Security')
    await f.open('Logins')
    f.explorer.collapse(security)
    const databases = await f.open('Databases')
    const system = await f.open('System Databases')
    f.explorer.collapse(system)
    expect(f.explorer.size).toBe(14)
    f.state.tables = Array.from({ length: 5 }, (_, index) => `dbo.T${index}`)
    await f.open('AppData', 'Tables')
    // 23 nodes: Security's subtree went first, then System Databases'.
    expect(f.explorer.node(security)).toMatchObject({ children: undefined, load: 'none', hasChildren: true })
    expect(f.explorer.node(system)).toMatchObject({ children: undefined, load: 'none' })
    expect(f.explorer.node(databases)!.children).toHaveLength(5)
    expect(f.explorer.size).toBeLessThanOrEqual(20)
    f.clock.advance(0)
    expect(f.explorer.node(f.find('Databases'))).toBeDefined()
    // Expanding an evicted node loads it again.
    f.explorer.expand(security)
    await settle()
    expect(f.labels()).toContain('    Logins')
  })
  it('scans for nodes to evict once while nothing can be evicted, and again after a collapse', async () => {
    const f = fixture({ nodeBudget: 16 })
    f.state.tables = Array.from({ length: 30 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 4
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    expect(f.explorer.node(tables)!.more).toBe('paused')
    const scans = vi.spyOn(f.explorer.table as Map<number, unknown>, 'values')
    f.explorer.continueLoading(syntheticId(tables, RowKind.Paused))
    await settle()
    // Seven more pages arrived over the budget; none of them walked the node table again.
    expect(f.explorer.node(tables)!.children).toHaveLength(31)
    expect(scans).not.toHaveBeenCalled()
    f.explorer.collapse(tables)
    f.explorer.select(f.find('Security'))
    await f.open('Security')
    expect(scans).toHaveBeenCalled()
    expect(f.explorer.node(tables)).toMatchObject({ children: undefined, load: 'none' })
  })
  it('pauses background loading when nothing can be evicted, and continues on Enter', async () => {
    const f = fixture({ nodeBudget: 16, pageSize: 2 })
    f.state.tables = Array.from({ length: 12 }, (_, index) => `dbo.T${index}`)
    f.state.pageSize = 4
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    expect(f.explorer.node(tables)!.more).toBe('paused')
    expect(f.labels()).toContain('[Loading paused: Object Explorer holds 16 items. Collapse other folders or filter this one. Press Enter to continue.]')
    f.explorer.continueLoading(syntheticId(tables, RowKind.Paused))
    await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(13)
    expect(f.explorer.node(tables)!.more).toBe('none')
  })
})

describe('ExplorerService: connections', () => {
  it('drops a disconnected server at once, deletes its nodes in slices, and moves the selection on', async () => {
    const f = fixture({ deleteSlice: 4 })
    f.connect('server-a')
    f.connect('server-b')
    await settle()
    const a = f.find('server-a.example'), b = f.find('server-b.example')
    f.explorer.expand(f.find('Databases', a))
    await settle()
    f.hold(isFolder('serverSecurity'))
    f.explorer.expand(f.find('Security', a))
    f.explorer.select(a)
    f.connections.remove(cid('server-a'))
    await settle()
    expect(f.api.explorerCancel).toHaveBeenCalledTimes(1)
    expect(f.labels()).toEqual(['server-b.example', '  Databases', '  Security', '  Server Objects'])
    expect(f.explorer.getSnapshot().selected).toBe(b)
    expect(f.explorer.node(a)).toBeDefined()
    let slices = 0
    while (f.clock.step()) slices++
    expect(slices).toBeGreaterThan(1)
    expect(f.explorer.node(a)).toBeUndefined()
    expect(f.explorer.table.get(a)).toBeUndefined()
  })
  it('keeps a lost server collapsed until it is reconnected, which takes its place', async () => {
    const f = fixture()
    f.connect('server-a')
    f.connect('server-b')
    await settle()
    const a = f.find('server-a.example')
    f.explorer.expand(f.find('Databases', a))
    await settle()
    f.hold(isFolder('serverSecurity'))
    f.explorer.expand(f.find('Security', a))
    f.connections.markLostBefore(2)
    await settle()
    expect(f.explorer.node(a)).toMatchObject({ lost: true, expanded: false, hasChildren: false })
    expect(f.labels()).toEqual(['server-a.example', 'server-b.example'])
    expect(f.api.explorerCancel).toHaveBeenCalled()
    f.explorer.expand(a)
    f.explorer.refresh(a)
    expect(f.labels()).toEqual(['server-a.example', 'server-b.example'])
    f.explorer.select(a)
    f.connections.replace(cid('server-a'), info('server-c', 2), connectionOptions)
    await settle()
    expect(f.labels()).toEqual(['server-c.example', '  Databases', '  Security', '  Server Objects', 'server-b.example'])
    expect(f.explorer.getSnapshot().selected).toBe(f.find('server-c.example'))
    expect(f.explorer.queryTarget(a)).toBeUndefined()
  })
  it('rebuilds the tree from the connections on reset, keeping filters', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    f.explorer.setFilter(databases, { name: { op: 'contains', value: 'App' } })
    await settle()
    f.explorer.reset()
    await settle()
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '  Security', '  Server Objects'])
    await f.open('Databases')
    expect(f.calls().at(-1)!.filter).toEqual({ name: { op: 'contains', value: 'App' } })
    expect(f.explorer.node(f.find('Databases'))!.filtered).toBe(true)
  })
})

describe('ExplorerService: reset', () => {
  it('publishes the rebuilt tree at once, so the old rows never show again', () => {
    const backend = fakeBackend(), connections = new ConnectionService(), queued: (() => void)[] = []
    const explorer = new ExplorerService({ api: backend.api, connections, events: new EventBus(), schedule: callback => { queued.push(callback) } })
    disposals.push(() => explorer.dispose())
    connections.add(info('server-a'), connectionOptions)
    queued.splice(0).forEach(callback => callback())
    const before = explorer.getSnapshot().rows.ids[0]
    explorer.reset()
    const after = explorer.getSnapshot().rows
    expect([after.count, after.nodes[0]?.label]).toEqual([1, 'server-a.example'])
    expect(after.ids[0]).not.toBe(before)
    expect(explorer.getSnapshot().selected).toBe(after.ids[0])
  })
})

describe('ExplorerService: filters', () => {
  it('sends the filter, marks the folder, reloads only its rows, and removes it', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const system = await f.open('System Databases')
    const filter: ExplorerFilter = { name: { op: 'contains', value: 'App' } }
    f.explorer.setFilter(databases, filter)
    await settle()
    expect(f.calls().at(-1)).toMatchObject({ node: { folder: 'databases' }, filter })
    expect(f.explorer.filter(databases)).toEqual(filter)
    expect(f.explorer.node(databases)!.filtered).toBe(true)
    // Static subfolders keep their place and state.
    expect(f.find('System Databases')).toBe(system)
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '    System Databases', '      master', '      model', '    Database Snapshots', '    AppData', '  Security', '  Server Objects'])
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Filter applied to Databases')
    f.explorer.setFilter(databases, undefined)
    await settle()
    expect(f.calls().at(-1)).not.toHaveProperty('filter')
    expect(f.explorer.node(databases)!.filtered).toBe(false)
    expect(f.labels()).toContain('    Offline')
  })
  it('rejects folders without filters, invalid filters, and more than 64 filters', async () => {
    const f = fixture({ filters: 1 })
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    expect(() => f.explorer.setFilter(f.find('Security'), { name: { op: 'contains', value: 'x' } })).toThrow('Select a folder that can be filtered.')
    expect(() => f.explorer.setFilter(databases, { schema: { op: 'contains', value: 'x' } })).toThrow('This folder cannot be filtered by that property.')
    expect(() => f.explorer.setFilter(databases, { name: { op: 'contains', value: '' } })).toThrow()
    expect(() => f.explorer.setFilter(databases, {})).toThrow('A filter needs at least one property.')
    f.explorer.setFilter(databases, { name: { op: 'equals', value: 'AppData' } })
    f.explorer.setFilter(databases, { name: { op: 'equals', value: 'Offline' } })
    const snapshots = f.find('Database Snapshots')
    expect(() => f.explorer.setFilter(snapshots, { name: { op: 'contains', value: 'x' } })).toThrow('Object Explorer keeps at most 1 filters. Remove one first.')
    f.explorer.setFilter(databases, undefined)
    f.explorer.setFilter(snapshots, { name: { op: 'contains', value: 'x' } })
    expect(f.explorer.filter(snapshots)).toBeDefined()
    // Disconnecting forgets the connection's filters.
    f.connections.remove(cid('server-a'))
    f.connect('server-b')
    await settle()
    const other = await f.open('Databases')
    expect(() => f.explorer.setFilter(other, { name: { op: 'contains', value: 'y' } })).not.toThrow()
  })
})

describe('ExplorerService: selection, targets and context', () => {
  it('publishes the context keys synchronously on select, and only when one changes', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    const listener = vi.fn()
    f.explorer.context.subscribe(listener)
    f.explorer.select(databases)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(f.explorer.context.getSnapshot()).toEqual({
      explorerHasSelection: true, explorerSelectionKind: 'folder', explorerSelectionFolder: 'databases', explorerSelectionFilterable: true, explorerSelectionFiltered: false,
      explorerSelectionInsertable: false, ...scriptContextValues(scriptMenuState({ kind: 'folder' })), ...actionContextValues(actionMenuState({ kind: 'folder' })), explorerLoading: false
    })
    expect(f.explorer.getSnapshot().selected).toBe(databases)
    f.explorer.select(f.find('Database Snapshots'))
    expect(listener).toHaveBeenCalledTimes(2)
    f.explorer.select(f.find('AppData'))
    expect(listener).toHaveBeenCalledTimes(3)
    expect(f.explorer.context.getSnapshot()).toMatchObject({
      explorerSelectionKind: 'database', explorerSelectionFolder: '', explorerSelectionInsertable: true, explorerScriptTitle: 'database', explorerScriptCreate: 'enabled', explorerScriptAlter: 'enabled',
      explorerScriptCreateOrAlter: '', explorerScriptSelect: '', explorerSelectionModifiable: false,
      explorerActionSelectTop: '', explorerActionRename: 'enabled', explorerActionDelete: 'enabled'
    })
    // A row with the same keys publishes nothing.
    f.explorer.select(f.find('Locked'))
    expect(listener).toHaveBeenCalledTimes(3)
    f.explorer.select(f.find('server-a.example'))
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerSelectionKind: 'server', explorerSelectionInsertable: true, explorerScriptTitle: '', explorerScriptCreate: '' })
    // A system database's subtype changes the row: it still scripts as a database.
    f.explorer.expand(f.find('System Databases'))
    await settle()
    f.explorer.select(f.find('master'))
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerSelectionKind: 'database', explorerScriptTitle: 'database', explorerScriptDrop: 'enabled', explorerActionRename: 'disabled', explorerActionDelete: 'disabled' })
    // Synthetic rows are not nodes.
    f.explorer.select(syntheticId(1, RowKind.Error))
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerHasSelection: false, explorerSelectionKind: '' })
    expect(f.explorer.target()).toBeUndefined()
  })
  it('asks the tree to reveal a selection made outside it, even of the row already selected', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases')
    f.explorer.select(databases)
    const before = f.explorer.getSnapshot()
    expect(before.reveal).toBeUndefined()
    f.explorer.select(databases)
    expect(f.explorer.getSnapshot()).toBe(before)
    f.explorer.select(databases, { reveal: true })
    const first = f.explorer.getSnapshot().reveal
    expect(first).toBeDefined()
    expect(f.explorer.getSnapshot().selected).toBe(databases)
    f.explorer.select(f.find('Security'), { reveal: true })
    expect(f.explorer.getSnapshot().reveal).not.toBe(first)
    // Later snapshots keep the last request, so the tree does not reveal again.
    const last = f.explorer.getSnapshot().reveal
    f.explorer.expand(databases)
    await settle()
    expect(f.explorer.getSnapshot().reveal).toBe(last)
  })
  it('gives commands the selection as a target, and new queries its server and database', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const table = f.find('dbo.T0')
    f.explorer.select(table)
    expect(f.explorer.target()).toEqual({ connectionId: cid('server-a'), ref: { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'T0' } }, kind: 'table', label: 'dbo.T0' })
    expect(f.explorer.queryTarget()).toEqual({ connectionId: cid('server-a'), database: 'AppData' })
    expect(f.explorer.queryTarget(tables)).toEqual({ connectionId: cid('server-a'), database: 'AppData' })
    expect(f.explorer.queryTarget(f.find('AppData'))).toEqual({ connectionId: cid('server-a'), database: 'AppData' })
    expect(f.explorer.queryTarget(f.find('Databases'))).toEqual({ connectionId: cid('server-a') })
    expect(f.explorer.queryTarget(f.find('server-a.example'))).toEqual({ connectionId: cid('server-a') })
    f.explorer.select(tables)
    expect(f.explorer.target()).toMatchObject({ kind: 'folder', folder: 'tables', label: 'Tables' })
    expect(f.explorer.keyOf(tables)).toBe(JSON.stringify([cid('server-a'), 'folder', 'database', null, null, 'AppData', null, null, null, 'tables']))
  })
  it('describes a row for its context menu: the node and its id, a synthetic row\'s owner, and a lost server', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const table = f.find('dbo.T0'), root = f.find('server-a.example')
    expect(f.explorer.menuNode(table)).toEqual({
      id: table, lost: false, connectionId: cid('server-a'), ref: { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'T0' } }, kind: 'table', label: 'dbo.T0'
    })
    expect(f.explorer.menuNode(syntheticId(tables, RowKind.Error))).toMatchObject({ id: tables, kind: 'folder', folder: 'tables', lost: false })
    expect(f.explorer.menuNode(undefined)).toBeUndefined()
    // The backend restarted: the server stays, lost, and the rows below it are gone.
    f.connections.markLostBefore(2)
    expect(f.explorer.menuNode(root)).toMatchObject({ id: root, kind: 'server', lost: true })
    expect(f.explorer.menuNode(table)).toBeUndefined()
    f.connections.remove(cid('server-a'))
    expect(f.explorer.menuNode(root)).toBeUndefined()
  })
  it('gives quoted insert text, a fully loaded Columns folder\'s list, and a server\'s name to copy', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Databases', 'AppData', 'Tables')
    const table = f.find('dbo.T0')
    expect(f.explorer.insertText(table)).toBe('[dbo].[T0]')
    const columns = await f.open('dbo.T0', 'Columns')
    expect(f.explorer.insertText(columns)).toBe('[Id], [Name]')
    expect(f.explorer.insertText(f.find('Id'))).toBe('[Id]')
    expect(f.explorer.insertText(f.find('Keys'))).toBeUndefined()
    expect(f.explorer.insertText(f.find('server-a.example'))).toBeUndefined()
    expect(f.explorer.copyText(f.find('server-a.example'))).toBe('server-a.example')
    expect(f.explorer.copyText(f.find('AppData'))).toBe('[AppData]')
    expect(f.explorer.insertText(syntheticId(columns, RowKind.Error))).toBeUndefined()
    f.explorer.select(columns)
    expect(f.explorer.context.getSnapshot().explorerSelectionInsertable).toBe(true)
    // Its context menu offers Copy Name too; Keys, with nothing to copy, does not.
    expect(f.explorer.menuNode(columns)).toMatchObject({ kind: 'folder', folder: 'columns', insertable: true })
    expect(f.explorer.menuNode(f.find('Keys'))).not.toHaveProperty('insertable')
    expect(f.explorer.menuNode(table)).not.toHaveProperty('insertable')
  })
  it('lets objects with a name, and a Columns folder only once fully loaded, be dragged', async () => {
    const f = fixture()
    f.connect()
    await settle()
    await f.open('Databases', 'AppData', 'Tables', 'dbo.T0')
    const columns = f.find('Columns')
    expect([f.explorer.canInsert(f.find('dbo.T0')), f.explorer.canInsert(f.find('AppData')), f.explorer.canInsert(columns)]).toEqual([true, true, false])
    // Servers, other folders and synthetic rows carry nothing to a query.
    for (const id of [f.find('server-a.example'), f.find('Tables'), f.find('Keys'), syntheticId(columns, RowKind.Loading)]) expect(f.explorer.canInsert(id), String(id)).toBe(false)
    f.hold(isFolder('columns'))
    f.explorer.expand(columns)
    await settle()
    expect(f.explorer.canInsert(columns)).toBe(false)
    f.release()
    await settle()
    expect(f.explorer.canInsert(columns)).toBe(true)
    expect(f.explorer.insertText(columns)).toBe('[Id], [Name]')
    // While a refresh reloads it, its list may be stale.
    f.hold(isFolder('columns'))
    f.explorer.refresh(columns)
    expect(f.explorer.canInsert(columns)).toBe(false)
  })
  it('opens Filter Settings only for a folder that can be filtered, and marks a filtered folder\'s menu node', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const seen: (number | undefined)[] = []
    f.explorer.filterDialog.subscribe(() => seen.push(f.explorer.filterDialog.getSnapshot()))
    expect(() => f.explorer.openFilter(f.find('server-a.example'))).toThrow('Select a folder that can be filtered.')
    expect(() => f.explorer.openFilter(f.find('Security'))).toThrow('Select a folder that can be filtered.')
    f.explorer.openFilter(tables)
    f.explorer.openFilter(tables)
    expect(f.explorer.filterDialog.getSnapshot()).toBe(tables)
    f.explorer.closeFilter()
    expect(seen).toEqual([tables, undefined])
    expect(f.explorer.menuNode(tables)).not.toHaveProperty('filtered')
    f.explorer.setFilter(tables, { name: { op: 'contains', value: 'T1' } })
    expect(f.explorer.menuNode(tables)).toMatchObject({ id: tables, filtered: true })
    f.explorer.openFilter(tables)
    f.explorer.reset()
    expect(f.explorer.filterDialog.getSnapshot()).toBeUndefined()
  })
  it('collapses a node with the selection inside onto itself, and collapses everything below the servers', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const databases = await f.open('Databases', 'AppData', 'Tables')
    f.explorer.select(f.find('dbo.T1'))
    f.explorer.collapse(f.find('AppData'))
    expect(f.explorer.getSnapshot().selected).toBe(f.find('AppData'))
    f.explorer.select(f.find('AppData'))
    f.explorer.collapseAll()
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '  Security', '  Server Objects'])
    expect(f.explorer.getSnapshot().selected).toBe(f.find('Databases'))
    expect(databases).toBeGreaterThan(0)
  })
  it('expands every sibling with *, sending at most the cap of requests', async () => {
    const f = fixture({ siblingLoads: 1 })
    f.connect()
    await settle()
    await f.open('Databases')
    const result = f.explorer.expandSiblings(f.find('AppData'))
    expect(result).toEqual({ expanded: 0, queued: 1, skipped: 3 })
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Expanded 1 of 4 items')
    await settle()
    // Static folders need a request too (no SQL), so they count against the cap.
    const top = f.explorer.expandSiblings(f.find('Security'))
    expect(top).toEqual({ expanded: 1, queued: 0, skipped: 1 })
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Expanded 1 of 2 items')
  })
})

describe('ExplorerService: memory and speed', () => {
  it('shares strings and objects between a node\'s ref and its children\'s', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const columns = await f.open('Databases', 'AppData', 'Tables', 'dbo.T0', 'Columns')
    const table = f.explorer.node(f.find('dbo.T0'))!, folderNode = f.explorer.node(columns)!
    const [id, name] = folderNode.children!
    if (table.ref.type !== 'object' || folderNode.ref.type !== 'folder' || id.ref.type !== 'object' || name.ref.type !== 'object') throw new Error('Unexpected refs.')
    expect(folderNode.ref.owner).toBe(table.ref.object)
    expect(id.ref.object.parent).toBe(name.ref.object.parent)
    expect(id.ref.object.parent).toEqual({ kind: 'table', schema: 'dbo', name: 'T0' })
  })
  it('shares a folder\'s owner only when every identity field matches, SSIS folder and project included', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const appData: ObjectRef = { kind: 'database', name: 'AppData' }
    const databases = await f.open('Databases')
    f.state.failNext = { ok: true, value: { nodes: [folder({ ...appData, ssisFolder: 'Finance' }, 'tables'), folder({ ...appData, ssisProject: 'Loads' }, 'views'), folder(appData, 'synonyms')], elapsedMs: 1, total: 3 } }
    await f.open('AppData')
    const database = f.explorer.node(f.find('AppData', databases))!
    const [tables, views, synonyms] = database.children!
    if (database.ref.type !== 'object' || tables.ref.type !== 'folder' || views.ref.type !== 'folder' || synonyms.ref.type !== 'folder') throw new Error('Unexpected refs.')
    expect(tables.ref.owner).toEqual({ ...appData, ssisFolder: 'Finance' })
    expect(views.ref.owner).toEqual({ ...appData, ssisProject: 'Loads' })
    expect(synonyms.ref.owner).toBe(database.ref.object)
    expect(new Set([tables, views, synonyms].map(node => f.explorer.keyOf(node.id))).size).toBe(3)
  })
  it('merges a 2,000-node page with bounded matching work and republishes it', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 2000 }, (_, index) => `dbo.Table${index}`)
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const before = f.explorer.node(tables)!.children!.slice()
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    expect(await reconcilePages(f, tables)).toBe(1)
    expect(f.explorer.node(tables)!.children).toHaveLength(2001)
    expect(f.explorer.node(tables)!.children!.every((child, index) => child === before[index])).toBe(true)
    expect(f.rows().count).toBeGreaterThan(2000)
  })
  it('refreshes a folder of 100,000 rows to 2,000 with bounded matching work before deleting the old rows', async () => {
    const f = fixture()
    const names = (count: number) => Array.from({ length: count }, (_, index) => `dbo.Table${index}`)
    f.state.tables = names(100_000)
    f.state.pageSize = 100_000
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const before = f.explorer.node(tables)!.children!.slice(), removed = before.at(-1)!
    f.state.tables = names(2000)
    f.hold(isFolder('tables'))
    f.explorer.refresh(tables)
    expect(await reconcilePages(f, tables)).toBe(1)
    expect(f.explorer.node(tables)!.children).toHaveLength(2001)
    expect(f.explorer.node(tables)!.children!.every((child, index) => child === before[index])).toBe(true)
    expect(f.explorer.size).toBeLessThan(3000)
    expect(Array.from(f.rows().ids)).not.toContain(removed.id)
    // The replacement page is visible and selectable before any old node is physically deleted.
    expect(f.explorer.table.get(removed.id)).toBe(removed)
    const selected = before[2000].id
    f.explorer.select(selected)
    expect(f.explorer.getSnapshot().selected).toBe(selected)
    let slices = 0
    while (f.clock.step()) slices++
    expect(slices).toBeGreaterThan(1)
    expect(f.explorer.table.get(removed.id)).toBeUndefined()
    expect(f.explorer.node(selected)).toBe(before[2000])
  })
  it('deletes a 100,000-node subtree in slices of at most 10,000 while the surviving server stays usable', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 100_000 }, (_, index) => `dbo.Table${index}`)
    f.state.pageSize = 100_000
    f.connect()
    await settle()
    const root = f.find('server-a.example')
    await f.open('Databases', 'AppData', 'Tables')
    const removedCount = f.explorer.size
    expect(removedCount).toBeGreaterThan(100_000)
    f.connect('server-b')
    await settle()
    const survivor = f.find('server-b.example'), security = f.find('Security', survivor)
    const table = f.explorer.table as Map<number, unknown>, remove = table.delete
    let deleted = 0
    table.delete = function(id) { deleted++; return remove.call(this, id) }
    try {
      f.connections.remove(cid('server-a'))
      expect(f.rows().count).toBe(4)
      expect(deleted).toBe(0)
      expect(table.get(root)).toBeDefined()
      let slices = 0, previous = 0
      while (f.clock.step()) {
        const removed = deleted - previous
        expect(removed).toBeGreaterThan(0)
        expect(removed).toBeLessThanOrEqual(10_000)
        // Selection still publishes between deletion slices, and the other server's nodes stay attached.
        const selected = slices % 2 ? survivor : security
        f.explorer.select(selected)
        expect(f.explorer.getSnapshot().selected).toBe(selected)
        expect(table.get(selected)).toBeDefined()
        previous = deleted
        slices++
      }
      expect(slices).toBeGreaterThanOrEqual(Math.ceil(removedCount / 10_000))
      expect(deleted).toBe(removedCount)
      expect(table.get(root)).toBeUndefined()
      expect(table.size).toBe(4)
    } finally { table.delete = remove }
  })
})

describe('ExplorerService: lifecycle', () => {
  it('stops listening and loading when disposed', async () => {
    const f = fixture()
    f.connect()
    await settle()
    f.hold(isFolder('databases'))
    f.explorer.expand(f.find('Databases'))
    const listener = vi.fn()
    f.explorer.subscribe(listener)
    f.explorer.dispose()
    expect(f.api.explorerCancel).toHaveBeenCalledTimes(1)
    f.connect('server-b')
    f.release()
    await settle()
    expect(listener).not.toHaveBeenCalled()
    expect(rowKindOf(syntheticId(3, RowKind.Paused))).toBe(RowKind.Paused)
  })
})
