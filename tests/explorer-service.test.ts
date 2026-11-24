import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, ConnectionInfo, ExplorerChildrenResult, ExplorerError, ExplorerNode, VariaApi } from '../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId, type NodeSubtype } from '../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ExplorerFilter, ExplorerNodeRef, ObjectRef } from '../src/shared/explorer/refs'
import { explorerChildrenParamsSchema } from '../src/shared/explorer/schema'
import { EventBus } from '../src/renderer/src/core/events'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Timers } from '../src/renderer/src/core/timers'
import type { WorkbenchEvent } from '../src/renderer/src/core/types'
import { ConnectionService, type LiveConnection } from '../src/renderer/src/services/connections'
import { ExplorerService, expansionKey, serverBrief, serverSublabel, type ExplorerServiceLimits, type ExplorerServiceOptions, type SeekOutcome } from '../src/renderer/src/explorer/ExplorerService'
import { LongRunService } from '../src/renderer/src/services/long-runs'
import { scriptContextValues, scriptMenuState } from '../src/shared/scripting/catalog'
import { actionContextValues, actionMenuReasons, actionMenuState } from '../src/shared/actions/catalog'
import { ssisVerbContextValues, ssisVerbMenuState } from '../src/shared/ssis/catalog'
import { childrenShown, lastDescendant, rowIndex, RowKind, rowKindOf, syntheticId, treeKey } from '../src/renderer/src/explorer/tree-model'
import { connectionInfo, connectionOptions } from './fixtures/workbench'
import { explorerNodeProvider } from '../src/shared/providers'
import { heavyTimeout, meterWork } from './fixtures/work-meter'

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
    lockedDenied: true, leafTables: false,
    /**
     * Auto-expand single children: Views lists only dbo.vOrders, whose only folder is Columns (empty while
     * `viewColumnsEmpty`); `viewsSystemOnly` lists only its System Views folder instead.
     */
    viewsChain: false, viewColumnsEmpty: false, viewsSystemOnly: false,
    /** sa's row fields in Logins. */
    sa: {} as Partial<ExplorerNode>,
    /** The server lists SQL Server Agent's node after its folders, as the backend does where Agent runs. */
    agentNode: false
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
        case 'server': return ok([folder(value, 'databases'), folder(value, 'serverSecurity'), folder(value, 'serverObjects'), ...state.agentNode ? [object({ kind: 'agent' }, 'SQL Server Agent')] : []])
        case 'database': return value.name === 'Locked' && state.lockedDenied ? failure('NO_DB_ACCESS', 'The current login cannot access database Locked.') : ok([folder(value, 'tables'), folder(value, 'views')])
        case 'view': return ok([folder(value, 'columns')])
        case 'table': return state.dropped.has(`${value.schema}.${value.name}`) ? failure('NOT_FOUND', `${value.schema}.${value.name} no longer exists.`) : ok([folder(value, 'columns'), folder(value, 'keys')])
        default: return ok([])
      }
    }
    const owner = node.owner
    switch (node.folder) {
      case 'databases': {
        const statics = [folder(owner, 'systemDatabases'), folder(owner, 'databaseSnapshots')]
        const rows = [object({ kind: 'database', name: 'AppData' }, 'AppData', state.appData), object({ kind: 'database', name: 'Locked' }, 'Locked', { status: 'noAccess' }),
          ...state.offline ? [object({ kind: 'database', name: 'Offline' }, 'Offline', { sublabel: '(Offline)', status: 'unavailable', hasChildren: false, database: { state: 6, userAccess: 0, readOnly: false, standby: false } })] : []]
        const filtered = params.filter?.name ? rows.filter(row => row.label.includes(params.filter!.name!.value)) : rows
        return ok([...statics, ...filtered], { total: statics.length + filtered.length })
      }
      case 'views': return ok(state.viewsSystemOnly ? [folder(owner, 'systemViews')] : state.viewsChain ? [object({ kind: 'view', database: owner.name, schema: 'dbo', name: 'vOrders' }, 'dbo.vOrders')] : [])
      case 'systemViews': return ok(['sys.objects', 'sys.tables'].map(name => { const [schema, view] = name.split('.'); return object({ kind: 'view', database: owner.database, schema, name: view }, name, { subtype: 'system' }) }))
      case 'systemDatabases': return ok(['master', 'model'].map(name => object({ kind: 'database', name }, name, { subtype: 'system' })))
      case 'serverSecurity': return ok([folder(owner, 'logins'), folder(owner, 'audits')])
      case 'logins': return ok([object({ kind: 'login', name: 'sa' }, 'sa', state.sa)])
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
        if (state.viewColumnsEmpty && owner.kind === 'view') return ok([])
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

function fixture(limits: Partial<ExplorerServiceLimits> = {}, more: Partial<ExplorerServiceOptions> = {}) {
  const backend = fakeBackend()
  const connections = new ConnectionService(), events = new EventBus(), emitted: WorkbenchEvent[] = []
  events.subscribe(event => emitted.push(event))
  const clock = steppedTimers()
  let ids = 0
  // The wall clock listings are stamped with; tests move it by hand.
  const wall = { now: 1_800_000_000_000 }
  const explorer = new ExplorerService({ api: backend.api, connections, events, timers: clock.timers, schedule: callback => callback(), newId: () => uuid(++ids), limits, now: () => wall.now, ...more })
  disposals.push(() => explorer.dispose())
  const connect = (name = 'server-a', profile: Partial<ConnectionInfo> = {}) => connections.add({ ...info(name), productVersion: '16.0.4135.4', login: 'sa', ...profile }, connectionOptions)
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
  return { ...backend, backend, explorer, connections, events, emitted, clock, wall, connect, rows, labels, find, open, calls }
}

/** A big folder for the reconcile tests: 50 pages, so the per-page bounds below are about a twentieth of the folder. They
 *  scale with the page and the folder, not the row count, so a scan or copy of the folder per page fails here as it would
 *  at 99,000 rows (2,000 a page), which took 15 to 32 s on a starved 4-vCPU Windows runner and stalled the tests beside it. */
const bigFolder = { rows: 9_900, page: 200 }

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

describe('ExplorerService: SQL Server Agent', () => {
  it('lists the SQL Server Agent node after the server folders with no release gate to open (AG-1, AG-9)', async () => {
    const f = fixture()
    f.state.agentNode = true
    f.connect()
    await settle()
    expect(f.labels().slice(1)).toEqual(['  Databases', '  Security', '  Server Objects', '  SQL Server Agent'])
  })
  it('greys the Agent node\'s Start, Stop and Restart up front on a cluster, and while one of them runs on its server (AG-10)', async () => {
    const f = fixture({}, { windowsClient: true })
    f.state.agentNode = true
    f.connect()
    await settle()
    let service: { state?: number; clustered?: boolean } = { state: 4 }
    const listeners = new Set<() => void>()
    f.explorer.useStatus({ databaseRuntime: () => undefined, agentServiceOf: () => service, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } })
    const longRuns = new LongRunService()
    disposals.push(() => longRuns.dispose())
    f.explorer.useLongRuns(longRuns)
    const agent = f.find('SQL Server Agent')
    const menu = () => { const node = f.explorer.menuNode(agent)!; return [node.agent?.clustered ?? false, node.agent?.busy ?? false] }
    expect(menu()).toEqual([false, false])
    service = { state: 4, clustered: true }
    listeners.forEach(listener => listener())
    expect(menu()).toEqual([true, false])
    service = { state: 4 }
    // A run on another server does not count; one on this server does, until it ends.
    const elsewhere = longRuns.begin({ kind: 'restartAgent', connectionId: 'server-b', server: 'b' })
    expect(menu()).toEqual([false, false])
    const restart = longRuns.begin({ kind: 'restartAgent', connectionId: f.explorer.menuNode(agent)!.connectionId, server: 'server-a' })
    expect(menu()).toEqual([false, true])
    // The node's menu state follows: every service verb greyed with the busy reason.
    expect(actionMenuState(f.explorer.menuNode(agent)!).stopAgent).toBe('disabled')
    expect(actionMenuReasons(f.explorer.menuNode(agent)!).stopAgent).toBe('SQL Server Agent is being started or stopped.')
    restart.dispose()
    elsewhere.dispose()
    expect(menu()).toEqual([false, false])
  })
  it("finds a server's Agent node for Job Activity Monitor's Start without walking the tree again (AG-10)", async () => {
    const f = fixture({}, { windowsClient: true })
    f.state.agentNode = true
    f.connect()
    await settle()
    const agent = f.find('SQL Server Agent')
    const connectionId = f.explorer.menuNode(agent)!.connectionId
    expect(f.explorer.agentMenuNode(connectionId, { state: 1 })).toMatchObject({ id: agent, kind: 'agent', agent: { state: 1 } })
    // The banner asks on every tree and status publish: the node found last is asked first.
    const walk = vi.spyOn((f.explorer as unknown as { nodes: Map<number, unknown> }).nodes, 'values')
    expect(f.explorer.agentMenuNode(connectionId)?.id).toBe(agent)
    expect(walk).not.toHaveBeenCalled()
  })
})

describe('ExplorerService: expanding as the user', () => {
  const appData = async (f: ReturnType<typeof fixture>) => {
    f.state.viewsChain = true
    f.connect()
    await settle()
    return f.open('Databases', 'AppData')
  }
  /** Views › dbo.vOrders › Columns: the chain's levels. */
  const levels = (f: ReturnType<typeof fixture>, views: number) => { const view = f.find('dbo.vOrders', views); return { view, columns: f.find('Columns', view) } }
  const settleAll = async () => { for (let pass = 0; pass < 4; pass++) await settle() }
  /** Opens Views as the user, holding Columns' listing: the walk waits on its last level. */
  const waiting = async (f: ReturnType<typeof fixture>, views: number) => {
    f.hold(isFolder('columns'))
    f.explorer.open(views, true)
    await settleAll()
    const { view, columns } = levels(f, views)
    expect(f.explorer.node(columns)!.expanded).toBe(true)
    return { view, columns }
  }
  it('auto-expands only children down to the first node with more than one child, loading each level, and selects it', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database)
    f.explorer.open(views, true)
    expect(f.explorer.opening).toMatchObject({ id: views, settled: false })
    await settleAll()
    const { view, columns } = levels(f, views)
    expect(f.explorer.node(view)!.expanded).toBe(true)
    expect(f.explorer.node(columns)!.expanded).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(columns)
    const shown = f.labels(), at = shown.indexOf('      Views')
    expect(shown.slice(at, at + 5)).toEqual(['      Views', '        dbo.vOrders', '          Columns', '            Id', '            Name'])
    // The tree keeps Columns' children in view until it has shown them.
    expect(f.explorer.opening).toMatchObject({ id: columns, settled: true })
    f.explorer.endOpening()
    expect(f.explorer.opening).toBeUndefined()
    // Down then goes to its first child, as if the user had walked there.
    const rows = f.rows(), index = rowIndex(rows, columns)
    expect(treeKey(rows, index, 'down', 1)).toEqual({ type: 'select', index: index + 1 })
  })
  it('expands only the node itself when the setting is off, when its only child is a leaf, or when it is a System folder', async () => {
    const f = fixture()
    const database = await appData(f)
    const selected = f.explorer.getSnapshot().selected
    const views = f.find('Views', database)
    f.explorer.open(views, false)
    await settleAll()
    expect(f.explorer.node(f.find('dbo.vOrders', views))!.expanded).toBe(false)
    expect(f.explorer.getSnapshot().selected).toBe(selected)
    const logins = await f.open('Security')
    f.explorer.open(f.find('Logins', logins), true)
    await settle()
    expect(f.labels()).toContain('      sa')
    expect(f.explorer.getSnapshot().selected).toBe(selected)
    // Views in a database without views lists only System Views, which it leaves closed.
    f.state.viewsSystemOnly = true
    f.explorer.refresh(views)
    await settleAll()
    f.explorer.collapse(views)
    f.explorer.open(views, true)
    await settleAll()
    expect(f.explorer.node(f.find('System Views', views))!.expanded).toBe(false)
    expect(f.explorer.getSnapshot().selected).toBe(selected)
    expect(f.calls().filter(call => call.node.type === 'folder' && call.node.folder === 'systemViews')).toHaveLength(0)
  })
  it('stops at a folder whose first page has one child and more to come', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database), selected = f.explorer.getSnapshot().selected
    f.hold(isFolder('views'))
    f.explorer.open(views, true)
    f.unhold(); f.hold(isPage('views'))
    f.release(isFolder('views'), { ok: true, value: { nodes: [object({ kind: 'view', database: 'AppData', schema: 'dbo', name: 'vOrders' }, 'dbo.vOrders')], elapsedMs: 1, total: 2, cursor: 'v1.views.1' } })
    await settle()
    expect(f.explorer.node(f.find('dbo.vOrders', views))!.expanded).toBe(false)
    expect(f.explorer.getSnapshot().selected).toBe(selected)
  })
  it('walks levels already loaded at once', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database)
    f.explorer.open(views, true)
    await settleAll()
    const { view, columns } = levels(f, views)
    f.explorer.collapse(columns); f.explorer.collapse(view); f.explorer.collapse(views)
    f.explorer.select(database)
    f.explorer.open(views, true)
    expect(f.explorer.node(columns)!.expanded).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(columns)
  })
  it('stops when the user selects another row while a level loads', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database), tables = f.find('Tables', database)
    await waiting(f, views)
    f.explorer.select(tables)
    f.unhold(); f.release()
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(tables)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('stays stopped when the user selects another row and comes back before a level loads', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database)
    const { view } = await waiting(f, views)
    f.explorer.select(view)
    f.explorer.select(database)
    f.unhold(); f.release()
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(database)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('stops when the user clicks a row, even the one already selected', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database), selected = f.explorer.getSnapshot().selected
    await waiting(f, views)
    f.explorer.endOpen()
    f.explorer.select(selected!)
    f.unhold(); f.release()
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(selected)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('stops when the user collapses another node, as a chevron click does without selecting it', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database), tables = f.find('Tables', database), selected = f.explorer.getSnapshot().selected
    f.explorer.expand(tables)
    await settleAll()
    await waiting(f, views)
    f.explorer.toggleOpen(tables, true)
    expect(f.explorer.node(tables)!.expanded).toBe(false)
    f.unhold(); f.release()
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(selected)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('ends at, and selects, a level that comes back empty', async () => {
    const f = fixture()
    f.state.viewColumnsEmpty = true
    const database = await appData(f)
    const views = f.find('Views', database)
    f.explorer.open(views, true)
    await settleAll()
    const { columns } = levels(f, views)
    expect(f.explorer.node(columns)!.expanded).toBe(false)
    expect(f.explorer.getSnapshot().selected).toBe(columns)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('ends at, and selects, a level whose listing fails, and the tree stops following it once its error row shows', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database)
    const { columns } = await waiting(f, views)
    f.unhold(); f.release(isFolder('columns'), failure('PERMISSION_DENIED', 'Denied.'))
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(columns)
    expect(f.explorer.opening).toMatchObject({ id: columns, settled: true })
    const rows = f.rows(), index = rowIndex(rows, columns)
    expect(childrenShown(rows, index)).toBe(true)
    expect(lastDescendant(rows, index)).toBe(index + 1)
  })
  it.each([
    ['a collapse of a level it walked through', (f: ReturnType<typeof fixture>, views: number) => f.explorer.collapse(views)],
    ['Collapse All', (f: ReturnType<typeof fixture>) => f.explorer.collapseAll()],
    ['Stop', (f: ReturnType<typeof fixture>) => f.explorer.stop()],
    ['Refresh', (f: ReturnType<typeof fixture>) => f.explorer.refresh()],
    ['turning the setting off', (f: ReturnType<typeof fixture>) => f.explorer.stopChain()]
  ])('stops at %s while a level loads, keeping the selection', async (_name, act) => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database), selected = f.explorer.getSnapshot().selected
    const { view, columns } = await waiting(f, views)
    act(f, views)
    f.unhold(); f.release()
    await settleAll()
    // Expanding the levels again without the user's expand never resumes the walk.
    f.explorer.expand(views); f.explorer.expand(view); f.explorer.expand(columns)
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(selected)
  })
  it('selects the end of a walk the user scrolled away from without revealing it', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database)
    const { columns } = await waiting(f, views)
    f.explorer.holdOpening()
    expect(f.explorer.opening).toBeUndefined()
    const reveal = f.explorer.getSnapshot().reveal
    f.unhold(); f.release()
    await settleAll()
    expect(f.explorer.getSnapshot().selected).toBe(columns)
    expect(f.explorer.getSnapshot().reveal).toBe(reveal)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('forgets an expand that listed nothing, so Varia opening the folder later does not follow it', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const database = await f.open('Databases', 'AppData')
    const views = f.find('Views', database)
    f.explorer.open(views, false)
    await settleAll()
    expect(f.explorer.node(views)).toMatchObject({ expanded: false, hasChildren: false })
    f.state.viewsChain = true
    f.explorer.reconcile(views)
    await settleAll()
    expect(f.explorer.node(views)!.expanded).toBe(true)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('forgets an expand whose reloaded listing came back empty, so Varia opening the folder later does not follow it', async () => {
    const f = fixture()
    const database = await appData(f)
    const views = f.find('Views', database)
    f.explorer.expand(views)
    await settleAll()
    f.explorer.collapse(views)
    // Collapsed with its rows, it lists them again (a reconcile) when next expanded, and they are gone.
    f.explorer.reconcile(views)
    f.state.viewsChain = false
    f.explorer.open(views, false)
    await settleAll()
    expect(f.explorer.node(views)).toMatchObject({ expanded: false, hasChildren: false })
    f.state.viewsChain = true
    f.explorer.reconcile(views)
    await settleAll()
    expect(f.explorer.node(views)!.expanded).toBe(true)
    expect(f.explorer.opening).toBeUndefined()
  })
  it('forgets an expand on a server lost before its page arrives, so reconnecting does not follow it', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const root = f.find('server-a.example')
    f.explorer.collapse(root)
    f.explorer.select(root)
    f.hold(params => params.node.type === 'object' && params.node.object.kind === 'server')
    f.explorer.open(root, true)
    expect(f.explorer.opening).toMatchObject({ id: root })
    f.connections.markLostBefore(2)
    await settle()
    f.unhold()
    f.connections.replace(cid('server-a'), info('server-c', 2), connectionOptions)
    await settleAll()
    expect(f.explorer.node(root)!.expanded).toBe(true)
    expect(f.explorer.opening).toBeUndefined()
  })
})

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
    expect(serverSublabel({ serverVersion: '', productVersion: undefined, login: undefined })).toBe('(SQL Server)')
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
  it('finds the Databases folder above a system database, whose own listing folder is System Databases', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const system = await f.open('Databases', 'System Databases')
    const databases = f.find('Databases'), master = f.find('master', system)
    expect(f.explorer.listingFolderOf(master)).toBe(system)
    expect(f.explorer.databasesFolderOf(master)).toBe(databases)
    expect(f.explorer.databasesFolderOf(f.find('AppData', databases))).toBe(databases)
    expect(f.explorer.databasesFolderOf(databases)).toBe(databases)
    expect(f.explorer.databasesFolderOf(f.find('Security'))).toBeUndefined()
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
    expect(f.emitted.slice(events)).toEqual([{ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'databases', nodeId: expect.any(Number) }])
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
    expect(f.emitted.at(-1)).toEqual({ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'databases', nodeId: expect.any(Number) })
    // A folder refreshes itself, and so does an empty one.
    const views = await f.open('AppData', 'Views')
    f.explorer.refresh(views)
    await settle()
    expect(f.calls().at(-1)!.node).toMatchObject({ folder: 'views' })
    expect(f.emitted.at(-1)).toEqual({ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'other', nodeId: expect.any(Number) })
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
    expect(f.emitted.at(-1)).toEqual({ type: 'explorer.refreshed', connectionId: cid('server-a'), scope: 'other', nodeId: expect.any(Number) })
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
  it('keeps a login\'s denial of CONNECT SQL beside its status, from the first page and through reconciles', async () => {
    const f = fixture()
    f.state.sa = { status: 'disabled', connectDenied: true }
    f.connect()
    await settle()
    await f.open('Security')
    const logins = await f.open('Logins')
    const sa = f.find('sa')!
    expect(f.explorer.node(sa)).toMatchObject({ status: 'disabled', connectDenied: true })
    const rev = f.explorer.node(sa)!.rev
    // GRANT CONNECT SQL: still disabled, no longer denied, and the row is drawn again.
    f.state.sa = { status: 'disabled' }
    f.explorer.reconcile(logins)
    await settle()
    expect(f.find('sa')).toBe(sa)
    expect(f.explorer.node(sa)!.connectDenied).toBeUndefined()
    expect(f.explorer.node(sa)!.rev).toBeGreaterThan(rev)
    f.state.sa = { status: 'noAccess', connectDenied: true }
    f.explorer.reconcile(logins)
    await settle()
    expect(f.explorer.node(sa)).toMatchObject({ status: 'noAccess', connectDenied: true })
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
  it('never opens a node from a background reconcile: an empty one gets its expander back, while Varia\'s own change opens it', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const views = await f.open('Databases', 'AppData', 'Views')
    expect(f.explorer.node(views)).toMatchObject({ expanded: false, hasChildren: false, load: 'loaded' })
    const from = f.calls().length
    f.explorer.reconcile(views, { background: true })
    await settle()
    // Nothing loads until the user opens it; then it lists again.
    expect(f.calls().length).toBe(from)
    expect(f.explorer.node(views)).toMatchObject({ expanded: false, hasChildren: true, load: 'none' })
    f.explorer.expand(views)
    await settle()
    expect(f.calls().slice(from).map(params => params.node)).toEqual([{ type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'views' }])
    // Varia's own change (DDL) opens the folder on what it made.
    f.explorer.reconcile(views)
    expect(f.explorer.node(views)!.expanded).toBe(true)
  })
  it('defers a background reconcile of an expanded node that a collapsed one above hides until it shows, and names the node a user\'s refresh reloaded', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const appData = f.find('AppData')
    f.explorer.collapse(appData)
    await settle()
    const from = f.calls().length, events = f.emitted.length
    f.explorer.reconcile(tables, { background: true })
    await settle()
    expect(f.calls().length).toBe(from)
    f.explorer.expand(appData)
    await settle()
    expect(f.calls().slice(from).map(params => params.node)).toEqual([{ type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' }])
    expect(f.emitted.slice(events).filter(event => event.type === 'explorer.refreshed')).toEqual([])
    f.explorer.refresh(tables)
    expect(f.emitted.slice(events).filter(event => event.type === 'explorer.refreshed')).toEqual([{ type: 'explorer.refreshed', connectionId: expect.any(String), scope: 'other', nodeId: tables }])
  })
  it('keeps another service\'s note on a node across reconciles until it is cleared', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const appData = f.find('AppData')
    const note = { label: '(not updating)', sentence: 'Live updates stopped.' }
    f.explorer.setNote(appData, note)
    const rev = f.explorer.node(appData)!.rev
    f.explorer.setNote(appData, { ...note })
    expect(f.explorer.node(appData)!.rev).toBe(rev)
    f.explorer.refresh(tables)
    f.explorer.refresh(f.find('Databases'))
    await settle()
    expect(f.find('AppData')).toBe(appData)
    expect(f.explorer.node(appData)!.note).toEqual(note)
    f.explorer.setNote(appData, undefined)
    expect(f.explorer.node(appData)!.note).toBeUndefined()
  })
  it('reconciles 9,900 rows in 50 pages with bounded matching work and publishes each page before the next', async () => {
    const f = fixture()
    const names = Array.from({ length: bigFolder.rows }, (_, index) => `dbo.Table${index}`)
    f.state.tables = names
    f.state.pageSize = bigFolder.page
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    while (f.explorer.node(tables)!.more === 'auto') await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(bigFolder.rows + 1)
    // The first row is gone, so every page after it is matched by name rather than in turn.
    f.state.tables = [...names.slice(1), 'dbo.Extra']
    f.hold(isFolder('tables'))
    f.explorer.reconcile(tables)
    expect(await reconcilePages(f, tables)).toBe(50)
    expect(f.explorer.node(tables)!.children).toHaveLength(bigFolder.rows + 1)
    expect(f.explorer.node(tables)!.children!.at(-1)!.label).toBe('dbo.Extra')
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
  })
  it('reconciles 9,900 leaves in 50 pages with bounded work while 300 loads wait on another server', async () => {
    const f = fixture()
    f.state.tables = Array.from({ length: 300 }, (_, index) => `dbo.Wait${index}`)
    f.connect('server-a')
    f.connect('server-b')
    await settle()
    let waiting = f.find('server-b.example')
    for (const label of ['Databases', 'AppData', 'Tables']) { waiting = f.find(label, waiting); f.explorer.expand(waiting); await settle() }
    f.hold(params => params.connectionId === cid('server-b') && params.node.type === 'object')
    for (const child of f.explorer.node(waiting)!.children!.filter(child => child.kind === 'table')) f.explorer.expand(child.id)
    const names = Array.from({ length: bigFolder.rows }, (_, index) => `dbo.Table${index}`)
    f.state.tables = names
    f.state.pageSize = bigFolder.page
    f.state.leafTables = true
    let tables = f.find('server-a.example')
    for (const label of ['Databases', 'AppData', 'Tables']) { tables = f.find(label, tables); f.explorer.expand(tables); await settle() }
    while (f.explorer.node(tables)!.more === 'auto') await settle()
    expect(f.explorer.node(tables)!.children).toHaveLength(bigFolder.rows + 1)
    f.state.tables = [...names.slice(1), 'dbo.Extra']
    const isA = (params: ExplorerChildrenParams) => params.connectionId === cid('server-a') && isFolder('tables')(params)
    f.hold(isA)
    f.explorer.reconcile(tables)
    expect(await reconcilePages(f, tables, isA)).toBe(50)
    expect(f.explorer.node(tables)!.children).toHaveLength(bigFolder.rows + 1)
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Tables: 1 added, 1 removed')
    expect(f.explorer.context.getSnapshot().explorerLoading).toBe(true)
  })
})

describe('ExplorerService: seek', () => {
  const server: ObjectRef = { kind: 'server' }, appData: ObjectRef = { kind: 'database', name: 'AppData' }
  const databases: ExplorerNodeRef = { type: 'folder', owner: server, folder: 'databases' }
  const tablesFolder: ExplorerNodeRef = { type: 'folder', owner: appData, folder: 'tables' }
  const tablePath = (name: string, database: ObjectRef = appData): ExplorerNodeRef[] =>
    [databases, { type: 'object', object: database }, { type: 'folder', owner: database, folder: 'tables' }, { type: 'object', object: { kind: 'table', database: database.name, schema: 'dbo', name } }]
  const names = (count: number) => Array.from({ length: count }, (_, at) => `dbo.T${at}`)

  it('expands each node on the path and pages a folder on until the row arrives, then selects and reveals it', async () => {
    const f = fixture()
    f.state.tables = names(10)
    f.state.pageSize = 2
    f.connect()
    await settle()
    const outcome = await f.explorer.seek(cid('server-a'), [tablePath('T7')])
    const t7 = f.find('dbo.T7')
    expect(outcome).toEqual({ ok: true, nodeId: t7 })
    expect(f.explorer.getSnapshot().selected).toBe(t7)
    expect(f.explorer.getSnapshot().reveal).toBeDefined()
    expect([f.find('Databases'), f.find('AppData'), f.find('Tables')].map(id => f.explorer.node(id)!.expanded)).toEqual([true, true, true])
    // Only the folders on the path were listed, and Tables' later pages by cursor.
    const pages = f.calls().filter(isFolder('tables')).map(params => params.cursor ?? 'first')
    expect(pages.slice(0, 4)).toEqual(['first', 'v1.tables.2', 'v1.tables.4', 'v1.tables.6'])
    expect(f.calls().some(isFolder('views'))).toBe(false)
  })
  it('opens the collapsed folders above a row that is already loaded, sending nothing', async () => {
    const f = fixture()
    f.state.tables = names(3)
    f.connect()
    await settle()
    await f.open('Databases', 'AppData', 'Tables')
    const t1 = f.find('dbo.T1')
    f.explorer.collapse(f.find('Databases'))
    expect(f.labels().some(label => label.trim() === 'dbo.T1')).toBe(false)
    const sent = f.calls().length
    expect(await f.explorer.seek(cid('server-a'), [tablePath('T1')])).toEqual({ ok: true, nodeId: t1 })
    expect(f.labels().some(label => label.trim() === 'dbo.T1')).toBe(true)
    expect(f.explorer.getSnapshot().selected).toBe(t1)
    expect(f.calls()).toHaveLength(sent)
  })

  it('tries the next path when a fully listed node lacks the step: a database under System Databases', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const master: ObjectRef = { kind: 'database', name: 'master' }
    const system: ExplorerNodeRef = { type: 'folder', owner: server, folder: 'systemDatabases' }
    const outcome = await f.explorer.seek(cid('server-a'), [[databases, { type: 'object', object: master }], [databases, system, { type: 'object', object: master }]])
    expect(outcome).toEqual({ ok: true, nodeId: f.find('master') })
    // With no path left, the first path's reason is the answer.
    expect(await f.explorer.seek(cid('server-a'), [[databases, { type: 'object', object: { kind: 'database', name: 'Gone' } }], [databases, system, { type: 'object', object: { kind: 'database', name: 'Gone' } }]]))
      .toEqual({ ok: false, message: 'Gone is not in Databases. Refresh Object Explorer, then try again.' })
    // A database with nothing to list (Offline) has no Tables to walk into.
    expect(await f.explorer.seek(cid('server-a'), [[databases, { type: 'object', object: { kind: 'database', name: 'Offline' } }, tablesFolder]])).toEqual({ ok: false, message: 'Tables is not in Offline. Refresh Object Explorer, then try again.' })
  })

  it('says why it cannot get there: the object is gone, a filter hides it, the folder stopped at its cap, a listing failed', async () => {
    const f = fixture({ folderCap: 4 })
    f.state.tables = names(10)
    f.state.pageSize = 2
    f.connect()
    await settle()
    const id = cid('server-a')
    expect(await f.explorer.seek(id, [tablePath('T2')])).toMatchObject({ ok: true })
    expect(await f.explorer.seek(id, [tablePath('T9')])).toEqual({ ok: false, message: 'Tables stopped at 4 items (its cap). Filter it by name to find dbo.T9.' })
    f.explorer.setFilter(f.find('Tables'), { name: { op: 'contains', value: 'T1' } })
    await settle()
    expect(await f.explorer.seek(id, [tablePath('T3')])).toEqual({ ok: false, message: 'A filter on Tables hides dbo.T3. Remove it, then try again.' })
    expect(await f.explorer.seek(id, [tablePath('T1')])).toMatchObject({ ok: true })
    expect(await f.explorer.seek(id, [tablePath('T1', { kind: 'database', name: 'Locked' })])).toEqual({ ok: false, message: 'Object Explorer could not list Locked: The current login cannot access database Locked.' })
  })

  it('ends when Stop, another seek or a lost server ends it, and answers a server Object Explorer does not show', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const id = cid('server-a')
    f.hold(isFolder('tables'))
    const stopped = f.explorer.seek(id, [tablePath('T1')])
    await settle()
    f.explorer.stop()
    expect(await stopped).toEqual({ ok: false, message: 'Stopped.', cancelled: true })
    const first = f.explorer.seek(id, [tablePath('T1')])
    await settle()
    const second = f.explorer.seek(id, [tablePath('T2')])
    expect(await first).toEqual({ ok: false, message: 'Another reveal started.', cancelled: true })
    f.connections.markLostBefore(2)
    expect(await second).toEqual({ ok: false, message: 'Object Explorer is not connected to this server.' })
    expect(await f.explorer.seek(cid('server-z'), [tablePath('T1')])).toEqual({ ok: false, message: 'Object Explorer is not connected to this server.' })
  })
  it('ends when the user collapses a node on its path, so a later load does not open it again; other collapses leave it running', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const id = cid('server-a')
    await f.open('Security')
    f.hold(isFolder('tables'))
    const seek = f.explorer.seek(id, [tablePath('T1')])
    let outcome: SeekOutcome | undefined
    void seek.then(value => { outcome = value })
    await settle()
    // Security is not on the path: the reveal still waits for Tables.
    f.explorer.collapse(f.find('Security'))
    await settle()
    expect(outcome).toBeUndefined()
    // AppData is: collapsing it ends the reveal, so Security's listing landing afterwards leaves AppData collapsed.
    f.explorer.collapse(f.find('AppData'))
    f.unhold()
    f.explorer.expand(f.find('Security'))
    f.explorer.refresh(f.find('Security'))
    await settle()
    expect(f.explorer.node(f.find('AppData'))!.expanded).toBe(false)
    expect(outcome).toEqual({ ok: false, message: 'Collapsed.', cancelled: true })
    // Collapse All ends one past the server too.
    f.hold(isFolder('tables'))
    const again = f.explorer.seek(id, [tablePath('T1')])
    await settle()
    f.explorer.collapseAll()
    expect(await again).toEqual({ ok: false, message: 'Collapsed.', cancelled: true })
    f.unhold()
    f.release()
    f.explorer.expand(f.find('Security'))
    await settle()
    expect(f.explorer.node(f.find('Databases'))!.expanded).toBe(false)
  })
  it('keeps a reveal that waits on the first page of the server node through Collapse All, which leaves servers open', async () => {
    const f = fixture()
    f.hold(params => params.node.type === 'object' && params.node.object.kind === 'server')
    f.connect()
    await settle()
    const seek = f.explorer.seek(cid('server-a'), [[databases]])
    await settle()
    f.explorer.collapseAll()
    f.unhold()
    f.release()
    expect(await seek).toEqual({ ok: true, nodeId: f.find('Databases') })
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
  it('retains the exact target root through disconnect and a fresh handle, rejecting metadata from its old handle', async () => {
    class Connections extends SnapshotStore<readonly LiveConnection[]> { set(value: readonly LiveConnection[]) { this.publish(value) } }
    const backend = fakeBackend(), connections = new Connections([])
    // Cancellation can race a successful catalog reply. Leave the old promise pending until after reconnect.
    backend.api.explorerCancel.mockImplementation(async ids => ({ ok: true, value: { cancelled: ids.length } }))
    const explorer = new ExplorerService({ api: backend.api, connections, events: new EventBus(), schedule: callback => callback() })
    disposals.push(() => explorer.dispose())
    const first: LiveConnection = { ...info('server-a'), targetId: uuid(900), options: connectionOptions, login: 'sa', productVersion: '16.0.1' }
    const other: LiveConnection = { ...info('server-b'), targetId: uuid(901), options: connectionOptions }
    connections.set([first, other])
    await settle()
    const root = explorer.rootIds[0], sibling = explorer.rootIds[1]
    const security = explorer.node(root)!.children!.find(node => node.label === 'Security')!
    backend.hold(params => params.connectionId === first.id && isFolder('serverSecurity')(params))
    explorer.expand(security.id)
    await settle()
    explorer.select(security.id)
    connections.set([{ ...first, lost: true }, other])
    await settle()
    expect(explorer.getSnapshot().selected).toBe(root)
    expect(explorer.node(root)).toMatchObject({ lost: true, expanded: false, children: undefined, hasChildren: false })
    expect(explorer.rootIds).toEqual([root, sibling])
    expect(explorer.queryTarget(root)).toBeUndefined()
    expect(backend.api.explorerCancel).toHaveBeenCalled()
    const fresh = { ...first, id: cid('server-c'), generation: 2 }
    connections.set([fresh, other])
    await settle()
    expect(explorer.rootIds).toEqual([root, sibling])
    expect(explorer.queryTarget(root)).toEqual({ connectionId: fresh.id })
    expect(explorer.getSnapshot().selected).toBe(root)
    const children = explorer.node(root)!.children!
    backend.release()
    await settle()
    expect(explorer.node(root)!.children).toBe(children)
    expect(explorer.menuNode(security.id)).toBeUndefined()
    expect(explorer.node(root)).toMatchObject({ expanded: true, lost: false, connectionId: fresh.id })
  })
  it('shows a BigQuery connection as a root of its own with BigQuery commands, its projects loaded on expand', async () => {
    class Connections extends SnapshotStore<readonly LiveConnection[]> { set(value: readonly LiveConnection[]) { this.publish(value) } }
    const backend = fakeBackend(), connections = new Connections([])
    const explorer = new ExplorerService({ api: backend.api, connections, events: new EventBus(), schedule: callback => callback() })
    disposals.push(() => explorer.dispose())
    const bigQuery: LiveConnection = { ...info('varia-alpha'), server: 'varia-alpha', serverVersion: 'BigQuery', login: 'ada@example.com', providerId: 'bigquery', targetId: uuid(950), options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } }
    connections.set([bigQuery])
    await settle()
    const root = explorer.rootIds[0]!
    expect(explorer.node(root)).toMatchObject({ label: 'varia-alpha', hasChildren: true, sublabel: '(BigQuery - ada@example.com)' })
    // Whatever it loads asks the backend for the connection node's children: its projects.
    const asked = () => vi.mocked(backend.api.explorerChildren).mock.calls.map(([params]) => params.node)
    expect(asked().every(node => node.type === 'object' && node.object.kind === 'server')).toBe(true)
    expect(explorer.menuNode(root)).toMatchObject({ provider: 'bigquery' })
    expect(explorerNodeProvider(explorer.menuNode(root))).toBe('bigquery')
    // A reconnect under a new handle can be expanded again (BQ-5: the backend lists its projects).
    connections.set([{ ...bigQuery, lost: true }])
    await settle()
    connections.set([{ ...bigQuery, id: cid('varia-alpha-2'), generation: 2 }])
    await settle()
    expect(explorer.node(root)).toMatchObject({ lost: false, hasChildren: true })
    expect(asked().every(node => node.type === 'object' && node.object.kind === 'server')).toBe(true)
  })
  it('updates target details in place and hides only Explorer membership while keeping other targets in order', async () => {
    class Connections extends SnapshotStore<readonly LiveConnection[]> { set(value: readonly LiveConnection[]) { this.publish(value) } }
    const backend = fakeBackend(), connections = new Connections([])
    const explorer = new ExplorerService({ api: backend.api, connections, events: new EventBus(), schedule: callback => callback() })
    disposals.push(() => explorer.dispose())
    const first: LiveConnection = { ...info('server-a'), targetId: uuid(900), options: connectionOptions }
    const other: LiveConnection = { ...info('server-b'), targetId: uuid(901), options: connectionOptions }
    connections.set([first, other])
    await settle()
    const root = explorer.rootIds[0], sibling = explorer.rootIds[1], children = explorer.node(root)!.children
    connections.set([{ ...first, displayName: 'Production' }, other])
    expect(explorer.node(root)).toMatchObject({ label: 'Production', lower: 'production' })
    expect(explorer.node(root)!.children).toBe(children)
    connections.set([{ ...first, inExplorer: false, lost: true }, other])
    expect(explorer.rootIds).toEqual([sibling])
    expect(explorer.menuNode(root)).toBeUndefined()
    connections.set([{ ...first, lost: true }, other])
    expect(explorer.rootIds[1]).toBe(sibling)
    expect(explorer.node(explorer.rootIds[0])).toMatchObject({ targetId: first.targetId, lost: true, expanded: false })
  })
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
  it('keeps a lost server collapsed until it is reconnected, which takes its place and opens what it showed', async () => {
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
    // Databases was open when the server was lost; Security still waits for its first page.
    expect(f.labels()).toEqual(['server-c.example', '  Databases', '    System Databases', '    Database Snapshots', '    AppData', '    Locked', '    Offline', '  Security', '  Server Objects', 'server-b.example'])
    expect(f.explorer.getSnapshot().selected).toBe(f.find('server-c.example'))
    expect(f.find('server-c.example')).toBe(a)
    expect(f.explorer.queryTarget(a)).toEqual({ connectionId: cid('server-c') })
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

describe('ExplorerService: settle', () => {
  it('publishes rows waiting for the next frame, so a second key acts on what the first did', async () => {
    const backend = fakeBackend(), connections = new ConnectionService(), queued: (() => void)[] = []
    const explorer = new ExplorerService({ api: backend.api, connections, events: new EventBus(), schedule: callback => { queued.push(callback) } })
    disposals.push(() => explorer.dispose())
    const frames = async () => { for (let round = 0; round < 10; round++) { await settle(); queued.splice(0).forEach(callback => callback()) } }
    connections.add(info('server-a'), connectionOptions)
    await frames()
    const rows = () => explorer.getSnapshot().rows
    const server = rows().ids[0]
    expect(rows().nodes[0]!.expanded).toBe(true)
    // Left collapses the server; its rows wait for the frame, and settle publishes them at once.
    explorer.collapse(server)
    expect(rows().count).toBeGreaterThan(1)
    const collapsed = explorer.settle().rows
    expect([collapsed.count, collapsed.nodes[0]!.expanded]).toEqual([1, false])
    expect(treeKey(collapsed, 0, 'right', 10)).toEqual({ type: 'expand', id: server })
    // Right expands it again (its folders are loaded). Before the frame, the published rows show it expanded without its
    // children, where Right does nothing; the settled rows have them, so the next Right moves into it.
    explorer.expand(server)
    expect(treeKey(rows(), 0, 'right', 10)).toEqual({ type: 'none' })
    const expanded = explorer.settle()
    expect(treeKey(expanded.rows, rowIndex(expanded.rows, expanded.selected), 'right', 10)).toEqual({ type: 'select', index: 1 })
    // Nothing waits any more: settling again publishes nothing, and the queued frame finds nothing to do.
    const version = explorer.getSnapshot().version
    expect(explorer.settle().version).toBe(version)
    queued.splice(0).forEach(callback => callback())
    expect(explorer.getSnapshot().version).toBe(version)
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
      explorerHasSelection: true, explorerSelectionProvider: 'sqlserver', explorerSelectionKind: 'folder', explorerSelectionFolder: 'databases', explorerSelectionFilterable: true, explorerSelectionFiltered: false,
      explorerSelectionInsertable: false, explorerSelectionStatus: '', explorerSelectionServerEngine: 'box', explorerSelectionServerLinux: false, explorerSelectionPeekable: false, explorerSelectionDependencies: false, explorerSelectionAgentRole: '',
      ...scriptContextValues(scriptMenuState({ kind: 'folder' })), ...actionContextValues(actionMenuState({ kind: 'folder' })), ...ssisVerbContextValues(ssisVerbMenuState('folder')), explorerLoading: false, explorerGroupBySchema: false,
      // The Databases folder's own actions (Attach D1d, Restore Database D1f, Restore Files and Filegroups D1g), on a SQL Server box edition.
      explorerActionAttach: 'enabled', explorerActionRestore: 'enabled', explorerActionRestoreFiles: 'enabled'
    })
    expect(f.explorer.getSnapshot().selected).toBe(databases)
    f.explorer.select(f.find('Database Snapshots'))
    expect(listener).toHaveBeenCalledTimes(2)
    f.explorer.select(f.find('AppData'))
    expect(listener).toHaveBeenCalledTimes(3)
    expect(f.explorer.context.getSnapshot()).toMatchObject({
      explorerSelectionKind: 'database', explorerSelectionFolder: '', explorerSelectionInsertable: true, explorerScriptTitle: 'database', explorerScriptCreate: 'enabled', explorerScriptAlter: 'enabled',
      explorerScriptCreateOrAlter: '', explorerScriptSelect: '', explorerSelectionModifiable: false, explorerSelectionPeekable: true,
      explorerActionSelectTop: '', explorerActionRename: 'enabled', explorerActionDelete: 'enabled'
    })
    // A status badge is a key of its own.
    f.explorer.select(f.find('Locked'))
    expect(listener).toHaveBeenCalledTimes(4)
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerSelectionKind: 'database', explorerSelectionStatus: 'noAccess', explorerActionRename: 'enabled' })
    f.explorer.select(f.find('server-a.example'))
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerSelectionKind: 'server', explorerSelectionInsertable: true, explorerScriptTitle: '', explorerScriptCreate: '' })
    // A system database's subtype changes the row: it still scripts as a database.
    f.explorer.expand(f.find('System Databases'))
    await settle()
    f.explorer.select(f.find('master'))
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerSelectionKind: 'database', explorerScriptTitle: 'database', explorerScriptDrop: 'enabled', explorerActionRename: 'disabled', explorerActionDelete: 'disabled' })
    // A row with the same keys publishes nothing.
    const calls = listener.mock.calls.length
    f.explorer.select(f.find('model'))
    expect(listener).toHaveBeenCalledTimes(calls)
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
    expect(f.explorer.target()).toEqual({
      connectionId: cid('server-a'), ref: { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'T0' } }, kind: 'table', label: 'dbo.T0', engine: 'box', linux: false
    })
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
      id: table, lost: false, connectionId: cid('server-a'), ref: { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'T0' } }, kind: 'table', label: 'dbo.T0',
      engine: 'box', linux: false
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
  it('carries a node\'s status, a database\'s runtime state as listed, and its server\'s engine and platform to targets and keys', async () => {
    const f = fixture()
    f.connect('server-a', { engineEdition: 8, linux: true })
    await settle()
    await f.open('Databases')
    const offline = f.find('Offline'), appData = f.find('AppData')
    f.explorer.select(offline)
    expect(f.explorer.target()).toMatchObject({ status: 'unavailable', database: { state: 6, userAccess: 0, readOnly: false, standby: false }, listedAt: f.wall.now, engine: 'managedInstance', linux: true })
    expect(f.explorer.menuNode(offline)).toMatchObject({ status: 'unavailable', database: { state: 6 }, engine: 'managedInstance', linux: true })
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerSelectionStatus: 'unavailable', explorerSelectionServerEngine: 'managedInstance', explorerSelectionServerLinux: true })
    // A row without runtime facts carries none; a reconcile that brings them stamps the time it listed them.
    expect(f.explorer.menuNode(appData)).not.toHaveProperty('database')
    f.state.appData = { database: { state: 0, userAccess: 1, readOnly: true, standby: false } }
    f.wall.now += 5_000
    f.explorer.reconcile(f.find('Databases'))
    await settle()
    expect(f.explorer.menuNode(appData)).toMatchObject({ database: { userAccess: 1, readOnly: true }, listedAt: f.wall.now })
    f.state.appData = {}
    f.explorer.reconcile(f.find('Databases'))
    await settle()
    expect(f.explorer.menuNode(appData)).not.toHaveProperty('listedAt')
    // A cloud edition, and a server whose profile probe failed.
    f.connect('server-b', { engineEdition: 5 })
    f.connect('server-c')
    await settle()
    expect(f.explorer.menuNode(f.find('server-b.example'))).toMatchObject({ engine: 'cloud', linux: false })
    expect(f.explorer.menuNode(f.find('server-c.example'))).toMatchObject({ engine: 'box', linux: false })
  })
  it('narrows a database\'s Tasks by a live status sample newer than its listing', async () => {
    const f = fixture()
    f.connect('server-a')
    await settle()
    await f.open('Databases')
    const appData = f.find('AppData')
    // A live sample newer than the listing overlays it (D3a): Take Offline greys at once when the status probe sees the
    // database offline, and an older sample changes nothing. Its signal updates the context keys; disposing drops it.
    f.explorer.select(appData)
    const listedAt = f.wall.now
    let sample: { at: number, row: { name: string, state: number, userAccess: number, readOnly: boolean, standby: boolean } | undefined, complete: boolean } | undefined
    const listeners = new Set<() => void>()
    const status = f.explorer.useStatus({ databaseRuntime: (connectionId, database) => connectionId === cid('server-a') && database === 'AppData' ? sample : undefined, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } })
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerActionTakeOffline: 'enabled', explorerActionBringOnline: 'enabled' })
    sample = { at: listedAt + 1, row: { name: 'AppData', state: 6, userAccess: 0, readOnly: false, standby: false }, complete: true }
    listeners.forEach(listener => listener())
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerActionTakeOffline: 'disabled', explorerActionBringOnline: 'enabled' })
    expect(f.explorer.target()).toMatchObject({ database: { state: 6 } })
    expect(f.explorer.menuNode(appData)).toMatchObject({ database: { state: 6 } })
    sample = { at: listedAt + 2, row: undefined, complete: true }
    listeners.forEach(listener => listener())
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerActionTakeOffline: 'enabled', explorerActionBringOnline: 'disabled' })
    status.dispose()
    expect(listeners.size).toBe(0)
    expect(f.explorer.context.getSnapshot()).toMatchObject({ explorerActionTakeOffline: 'enabled', explorerActionBringOnline: 'enabled' })
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
  }, heavyTimeout)
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
  }, heavyTimeout)
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

describe('ExplorerService: server rows and freshness', () => {
  it('gives a server row its version and login in brief, keeping SSMS\'s text for its name and tooltip', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const root = f.explorer.node(f.find('server-a.example'))!
    expect([root.brief, root.sublabel]).toEqual(['16.0 · sa', '(SQL Server 16.0.4135.4 - sa)'])
    expect(serverBrief({ serverVersion: '15.00.2000', productVersion: undefined, login: undefined })).toBe('15.0')
    // A Windows login shows without its domain or machine, which the tooltip keeps.
    expect(serverBrief({ serverVersion: '17.00.1000', productVersion: '17.0.1000.7', login: 'CONTOSO\\dba' })).toBe('17.0 · dba')
    expect(serverBrief({ serverVersion: '17.00.1000', productVersion: '17.0.1000.7', login: 'MACHINE\\user' })).toBe('17.0 · user')
    expect(serverSublabel({ serverVersion: '17.00.1000', productVersion: '17.0.1000.7', login: 'MACHINE\\user' })).toBe('(SQL Server 17.0.1000.7 - MACHINE\\user)')
    expect(serverBrief({ serverVersion: '17.00.1000', productVersion: '17.0.1000.7', login: 'dba@contoso.com' })).toBe('17.0 · dba@contoso.com')
  })
  it('stamps each listing when its first page arrives, and marks the rows a failed refresh kept stale until a load succeeds', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const loaded = f.wall.now
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const t1 = f.find('dbo.T1')
    // A row is described by the listing it is in; an expanded folder by its own.
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'Tables', updatedAt: loaded })
    expect(f.explorer.listingFreshness(tables)).toEqual({ label: 'Tables', updatedAt: loaded })
    expect(f.explorer.listingFreshness(f.find('Security'))).toEqual({ label: 'server-a.example', updatedAt: loaded })
    expect(f.explorer.listingFreshness(undefined)).toBeUndefined()
    f.wall.now += 60_000
    f.state.failNext = failure('BLOCKED', 'Another session holds a lock on this metadata.')
    f.explorer.refresh(tables)
    await settle()
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'Tables', updatedAt: loaded, staleSince: loaded + 60_000 })
    // A second failure keeps the time the rows first went stale.
    f.wall.now += 5_000
    f.state.failNext = failure('BLOCKED', 'Another session holds a lock on this metadata.')
    f.explorer.refresh(tables)
    await settle()
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'Tables', updatedAt: loaded, staleSince: loaded + 60_000 })
    f.wall.now += 5_000
    f.explorer.refresh(tables)
    await settle()
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'Tables', updatedAt: loaded + 70_000 })
    // A collapsed folder that is not loaded yet has no listing of its own: its parent's describes it.
    expect(f.explorer.listingFreshness(f.find('Views'))).toEqual({ label: 'AppData', updatedAt: loaded })
  })
  it('dates no listing of a lost server, nor one whose server was removed while its rows wait to be dropped', async () => {
    const f = fixture()
    f.connect('server-a')
    await settle()
    // A removed server's rows stay in the table until the sweep drops them; none of them is dated meanwhile.
    await f.open('Databases', 'AppData', 'Tables')
    const t1 = f.find('dbo.T1')
    expect(f.explorer.listingFreshness(t1)).toMatchObject({ label: 'Tables' })
    f.connections.remove(cid('server-a'))
    await settle()
    expect(f.explorer.node(t1)).toBeDefined()
    expect(f.explorer.listingFreshness(t1)).toBeUndefined()
    // A server lost with the backend keeps its row, which no listing dates.
    f.connect('server-b')
    await settle()
    const root = f.find('server-b.example')
    expect(f.explorer.listingFreshness(root)).toMatchObject({ label: 'server-b.example' })
    f.connections.markLostBefore(2)
    await settle()
    expect(f.explorer.node(root)).toMatchObject({ lost: true })
    expect(f.explorer.listingFreshness(root)).toBeUndefined()
  })
  it('forgets a listing\'s date when its rows are dropped, and dates the listing again when its first page arrives', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const tables = await f.open('Databases', 'AppData', 'Tables')
    const t1 = await f.open('dbo.T1'), opened = f.wall.now
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'dbo.T1', updatedAt: opened })
    // A new subtype drops dbo.T1's folders to list them again; until they arrive, Tables' new listing describes it.
    f.wall.now += 60_000
    f.state.subtypes['dbo.T1'] = 'systemVersioned'
    f.hold(params => params.node.type === 'object' && params.node.object.kind === 'table')
    f.explorer.reconcile(tables)
    await settle()
    expect(f.explorer.node(t1)).toMatchObject({ expanded: true, load: 'loading' })
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'Tables', updatedAt: opened + 60_000 })
    f.wall.now += 5_000
    f.unhold()
    f.release()
    await settle()
    expect(f.explorer.listingFreshness(t1)).toEqual({ label: 'dbo.T1', updatedAt: opened + 65_000 })
  })
  it('forgets a listing\'s date when Filter Settings replaces it, and dates the filtered one when it arrives', async () => {
    const f = fixture()
    f.connect()
    await settle()
    const loaded = f.wall.now
    const tables = await f.open('Databases', 'AppData', 'Tables')
    f.wall.now += 120_000
    f.state.failNext = failure('BLOCKED', 'Another session holds a lock on this metadata.')
    f.explorer.setFilter(tables, { name: { op: 'contains', value: 'T' } })
    // While the filtered list loads, and after it failed, Tables has no listing of its own: AppData's describes it.
    expect(f.explorer.listingFreshness(tables)).toEqual({ label: 'AppData', updatedAt: loaded })
    await settle()
    expect(f.explorer.node(tables)!.load).toBe('error')
    expect(f.explorer.listingFreshness(tables)).toEqual({ label: 'AppData', updatedAt: loaded })
    f.explorer.setFilter(tables, undefined)
    await settle()
    expect(f.explorer.listingFreshness(tables)).toEqual({ label: 'Tables', updatedAt: loaded + 120_000 })
  })
})

describe('ExplorerService: saved server order and expansion', () => {
  /** Servers from the connection workspace (a target id each), whose order and connected state the test sets. */
  function workspaceFixture() {
    const backend = fakeBackend()
    const store = new (class extends SnapshotStore<readonly LiveConnection[]> { set(value: readonly LiveConnection[]) { this.publish(value) } })([])
    const server = (name: string, connected = true, generation = 1): LiveConnection => ({
      ...info(name, generation), productVersion: '16.0.4135.4', login: 'sa', options: connectionOptions, targetId: uuid(0x100 + name.charCodeAt(name.length - 1)), inExplorer: true,
      ...connected ? {} : { lost: true as const }
    })
    const reorder = vi.fn((ids: readonly string[]) => {
      const current = store.getSnapshot(), next = ids.map(id => current.find(connection => connection.targetId === id)!)
      if (next.every((connection, index) => connection === current[index])) return false
      store.set(next)
      return true
    })
    const targets = { savedExplorerExpansion: vi.fn((_id: string): readonly string[] | undefined => undefined), reorder }
    let ids = 0
    const explorer = new ExplorerService({ api: backend.api, connections: store, events: new EventBus(), timers: steppedTimers().timers, schedule: callback => callback(), newId: () => uuid(++ids), targets })
    disposals.push(() => explorer.dispose())
    const labels = () => Array.from(explorer.getSnapshot().rows.ids, id => id > 0 ? '  '.repeat(explorer.node(id)!.level - 1) + explorer.node(id)!.label : `[${explorer.rowText(id)}]`)
    const find = (label: string) => Array.from(explorer.getSnapshot().rows.ids).find(id => id > 0 && explorer.node(id)!.label === label)!
    return { backend, store, server, targets, reorder, explorer, labels, find }
  }
  const key = (ref: ExplorerNodeRef) => expansionKey(ref)
  const serverKey = key({ type: 'object', object: { kind: 'server' } })
  const databasesKey = key({ type: 'folder', owner: { kind: 'server' }, folder: 'databases' })
  const appDataKey = key({ type: 'object', object: { kind: 'database', name: 'AppData' } })
  const goneKey = key({ type: 'object', object: { kind: 'database', name: 'Gone' } })

  it('keys a node by its identity without the connection, so a key survives a new connection', () => {
    expect(serverKey).toBe(JSON.stringify(['', 'object', 'server', null, null, null, null, null, null, null]))
  })
  it('restores the nodes a restored server had expanded as their pages arrive, and keeps a server saved collapsed collapsed', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a'), b = f.server('server-b')
    f.targets.savedExplorerExpansion.mockImplementation(id => id === a.targetId ? [serverKey, databasesKey, appDataKey, goneKey] : id === b.targetId ? [] : undefined)
    f.store.set([a, b])
    for (let turn = 0; turn < 4; turn++) await settle()
    expect(f.labels()).toEqual([
      'server-a.example', '  Databases', '    System Databases', '    Database Snapshots', '    AppData', '      Tables', '      Views', '    Locked', '    Offline', '  Security', '  Server Objects',
      'server-b.example'
    ])
    // The collapsed server loads nothing.
    expect(f.backend.sent.filter(entry => entry.params.connectionId === b.id)).toEqual([])
    // What is saved is what shows, outermost first. Gone no longer exists: once Databases had its last page the restore
    // ended, so its key is not kept for ever.
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey, databasesKey, appDataKey])
    expect(f.explorer.savedExpansion().get(b.targetId!)).toEqual([])
  })
  it('opens a server connected for the first time to its first level, and a reconnect to what it showed when it disconnected', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a')
    f.store.set([a])
    await settle()
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '  Security', '  Server Objects'])
    f.explorer.expand(f.find('Databases'))
    await settle()
    f.explorer.collapse(f.find('Databases'))
    f.explorer.expand(f.find('Security'))
    await settle()
    f.store.set([{ ...a, lost: true }])
    expect(f.labels()).toEqual(['server-a.example'])
    // A disconnected server keeps what it showed for the next start too; Databases was collapsed, so it is not kept.
    const securityKey = key({ type: 'folder', owner: { kind: 'server' }, folder: 'serverSecurity' })
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey, securityKey])
    f.store.set([f.server('server-a', true, 2)])
    for (let turn = 0; turn < 3; turn++) await settle()
    // Security opens again, Databases stays collapsed.
    expect(f.labels().slice(0, 4)).toEqual(['server-a.example', '  Databases', '  Security', '    Logins'])
    expect(f.explorer.node(f.find('Databases'))!.expanded).toBe(false)
  })
  it('ends a restore the user collapses, so keys it can no longer reach are neither expanded nor saved again', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a')
    f.targets.savedExplorerExpansion.mockReturnValue([serverKey, databasesKey, appDataKey])
    f.backend.hold(isFolder('databases'))
    f.store.set([a])
    for (let turn = 0; turn < 3; turn++) await settle()
    // The restore has asked for Databases' page; AppData still waits for it.
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey, databasesKey, appDataKey])
    f.explorer.collapse(f.find('Databases'))
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey])
    f.backend.unhold()
    f.backend.release()
    for (let turn = 0; turn < 3; turn++) await settle()
    expect(f.explorer.node(f.find('Databases'))!.expanded).toBe(false)
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey])
  })
  it('ends a restore on Stop, so a node the user expands later does not restore below it', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a')
    f.targets.savedExplorerExpansion.mockReturnValue([serverKey, databasesKey, appDataKey])
    f.backend.hold(isFolder('databases'))
    f.store.set([a])
    for (let turn = 0; turn < 3; turn++) await settle()
    // Databases' page is still on its way when the user stops.
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey, databasesKey, appDataKey])
    f.explorer.stop()
    f.backend.unhold()
    f.backend.release()
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey])
    f.explorer.expand(f.find('Databases'))
    for (let turn = 0; turn < 3; turn++) await settle()
    expect(f.explorer.node(f.find('AppData'))!.expanded).toBe(false)
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey, databasesKey])
  })
  it('ends a restore whose awaited node a refresh drops, rather than saving its key at every close', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a')
    f.store.set([a])
    await settle()
    for (const label of ['Databases', 'AppData', 'Tables', 'dbo.T1', 'Columns']) { f.explorer.expand(f.find(label)); for (let turn = 0; turn < 2; turn++) await settle() }
    const shown = f.explorer.savedExpansion().get(a.targetId!)!
    expect(shown).toHaveLength(6)
    // Lost, then back: the reconnect restores down to dbo.T1, whose page waits, so Columns' key is still to find.
    f.store.set([{ ...a, lost: true }])
    const isT1 = (params: ExplorerChildrenParams) => params.node.type === 'object' && params.node.object.kind === 'table' && params.node.object.name === 'T1'
    f.backend.hold(isT1)
    f.store.set([f.server('server-a', true, 2)])
    for (let turn = 0; turn < 6; turn++) await settle()
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual(shown)
    // dbo.T1 is dropped elsewhere; refreshing Tables removes its row, and its held load is aborted without settling.
    f.backend.state.tables = ['dbo.T0', 'dbo.T2']
    f.explorer.refresh(f.find('Tables'))
    for (let turn = 0; turn < 3; turn++) await settle()
    expect(f.labels()).not.toContain('        dbo.T1')
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual(shown.slice(0, 4))
  })
  it('forgets the saved expansion of a server removed from Explorer, so adding it back later opens it afresh', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a'), b = f.server('server-b')
    f.targets.savedExplorerExpansion.mockReturnValue([serverKey])
    f.store.set([a, b])
    await settle()
    f.store.set([b])
    expect(f.explorer.savedExpansion()).toEqual(new Map([[a.targetId!, null], [b.targetId!, [serverKey]]]))
    // Back this run: it is shown again, so what shows is kept.
    f.store.set([b, f.server('server-a', true, 2)])
    await settle()
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey])
  })
  it('ends every restore on Collapse All, even one whose server page is still loading', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a')
    f.targets.savedExplorerExpansion.mockReturnValue([serverKey, databasesKey, appDataKey])
    f.store.set([a])
    // The server's page is asked for but has not arrived when the user collapses everything.
    f.explorer.collapseAll()
    for (let turn = 0; turn < 4; turn++) await settle()
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '  Security', '  Server Objects'])
    expect(f.explorer.savedExpansion().get(a.targetId!)).toEqual([serverKey])
  })
  it('keeps what the start restored for a server it never connected this run, an older file\'s collapse included', async () => {
    const f = workspaceFixture()
    const a = f.server('server-a', false), b = f.server('server-b', false), c = f.server('server-c', false)
    f.targets.savedExplorerExpansion.mockImplementation(id => id === a.targetId ? [serverKey] : id === b.targetId ? [] : undefined)
    f.store.set([a, b, c])
    await settle()
    expect(f.explorer.savedExpansion()).toEqual(new Map([[a.targetId!, [serverKey]], [b.targetId!, []]]))
    // Asking does not use it up: the server's first connect still restores it.
    f.store.set([f.server('server-a', true, 2), b, c])
    await settle()
    expect(f.explorer.node(f.find('server-a.example'))!.expanded).toBe(true)
    expect(f.labels()).toEqual(['server-a.example', '  Databases', '  Security', '  Server Objects', 'server-b.example', 'server-c.example'])
  })
  it('moves servers through the workspace order, says where, and offers Move Up and Move Down only where they apply', async () => {
    const f = workspaceFixture()
    const [a, b, c] = ['server-a', 'server-b', 'server-c'].map(name => f.server(name))
    f.store.set([a, b, c])
    await settle()
    const rowOf = (name: string) => f.find(`${name}.example`)
    for (const name of ['server-a', 'server-b', 'server-c']) f.explorer.collapse(rowOf(name))
    expect(f.explorer.serverPlace(rowOf('server-b'))).toEqual({ index: 1, count: 3 })
    f.explorer.select(rowOf('server-a'))
    const revealBefore = f.explorer.getSnapshot().reveal ?? 0
    expect(f.explorer.moveServer(rowOf('server-a'), 2)).toBe(true)
    // The moved server is selected, so the tree scrolls it into view (it may have left the rows on screen).
    expect(f.explorer.getSnapshot().reveal).toBe(revealBefore + 1)
    expect(f.reorder).toHaveBeenLastCalledWith([b.targetId, c.targetId, a.targetId])
    expect(f.labels()).toEqual(['server-b.example', 'server-c.example', 'server-a.example'])
    expect(f.explorer.getSnapshot().announcement?.text).toBe('Moved server-a.example to position 3 of 3')
    // The selection stays on the moved server, which can now only move up.
    expect(f.explorer.getSnapshot().selected).toBe(rowOf('server-a'))
    expect(f.explorer.serverPlace(rowOf('server-a'))).toEqual({ index: 2, count: 3 })
    expect(f.explorer.moveServer(rowOf('server-a'), 2)).toBe(false)
    expect(f.explorer.moveServer(rowOf('server-a'), Number.NaN)).toBe(false)
    expect(f.explorer.moveServer(rowOf('server-b'), -5)).toBe(false)
    expect(f.reorder).toHaveBeenCalledTimes(1)
    // Rows below a server do not move.
    f.explorer.expand(rowOf('server-b'))
    await settle()
    expect(f.explorer.serverPlace(f.find('Databases'))).toBeUndefined()
    expect(f.explorer.moveServer(f.find('Databases'), 0)).toBe(false)
  })
})
