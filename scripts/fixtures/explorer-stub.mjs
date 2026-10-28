// A deterministic SQL Server for scripts/explorer-smoke.mjs, installed in main in place of its request handler and its
// Object Explorer cancel channel. Every request is recorded in `globalThis.variaStub.calls` and every cancelled id in
// `globalThis.variaStub.cancels`; the suite steers it through `globalThis.variaStub`'s fields.
import { explorerStatics } from './explorer-tree.mjs'

/**
 * What the stub serves below each connected server (both look the same):
 * - Databases: System Databases, Database Snapshots, AppData, and Legacy (offline: no chevron).
 * - AppData › Tables: the five static subfolders, then dbo.Orders and `tables - 1` synthetic tables (dbo.table1…), in
 *   pages of `pageSize` with `total`, after `pageDelayMs`, filtered by name when asked; its first page fails with the
 *   error code `tablesError` while that is set. dbo.Orders › Columns has
 *   `Id (PK, int, not null)` and `CustomerName (nvarchar(50), null)`.
 * - AppData › Views: `views` expandable views (dbo.view0…), paged the same way.
 * - Security › Audits fails with PERMISSION_DENIED until `auditsOk` is set.
 * - Server Objects › Linked Servers is held until `release()` or a cancel for its request.
 */
export function explorerStubData() {
  return { statics: explorerStatics() }
}

/** Installs the stub; pass it to `application.evaluate` with `explorerStubData()`. Runs in main, so it is self-contained. */
export function installExplorerStub({ ipcMain }, { statics }) {
  const stub = globalThis.variaStub = {
    calls: [], cancels: [], held: new Map(), connections: {},
    tables: 120_000, views: 10_000, pageSize: 2000, pageDelayMs: 0, auditsOk: false, holdLinked: true, tablesError: undefined,
    release() { for (const [id, resolve] of [...stub.held]) { stub.held.delete(id); resolve() } }
  }
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const matches = (name, filter) => {
    if (!filter?.name) return true
    const value = filter.name.value.toLowerCase(), text = name.toLowerCase()
    return filter.name.op === 'equals' ? text === value : filter.name.op === 'contains' ? text.includes(value) : !text.includes(value)
  }
  /** A listing folder: static subfolders first, then rows `0..count` in pages with a cursor. */
  async function paged(params, owner, count, row) {
    const offset = params.cursor ? Number(params.cursor.split('.')[2].slice(1)) : 0
    if (params.cursor && stub.pageDelayMs) await new Promise(resolve => setTimeout(resolve, stub.pageDelayMs))
    const fixed = params.cursor ? [] : folders(owner, statics.folders[params.node.folder] ?? [])
    // A name filter lists the first ten matches in one page; the synthetic names never contain "ord".
    if (params.filter) {
      const found = []
      for (let index = 0; index < count && found.length < 10; index++) { const node = row(index); if (matches(node.label.split('.').pop(), params.filter)) found.push(node) }
      return ok({ nodes: [...fixed, ...found], total: fixed.length + found.length, elapsedMs: 1 })
    }
    const end = Math.min(count, offset + stub.pageSize), nodes = [...fixed]
    for (let index = offset; index < end; index++) nodes.push(row(index))
    return ok({ nodes, ...params.cursor ? {} : { total: fixed.length + count }, ...end < count ? { cursor: `v1.${params.node.folder}.p${end}` } : {}, elapsedMs: 1 })
  }
  async function children(params) {
    const { node } = params
    if (node.type === 'object') {
      const value = node.object
      return ok({ nodes: folders(value, statics.objects[value.kind] ?? []), total: (statics.objects[value.kind] ?? []).length, elapsedMs: 1 })
    }
    const owner = node.owner
    switch (node.folder) {
      case 'databases': {
        const rows = [object({ kind: 'database', name: 'AppData' }, 'AppData', 'database'), object({ kind: 'database', name: 'Legacy' }, 'Legacy', 'database', { sublabel: '(Offline)', status: 'unavailable', hasChildren: false })]
        const nodes = [...folders(owner, statics.folders.databases), ...rows.filter(row => matches(row.label, params.filter))]
        return ok({ nodes, total: nodes.length, elapsedMs: 1 })
      }
      case 'tables':
        if (stub.tablesError && !params.cursor) return ok({ nodes: [], elapsedMs: 1, error: { code: stub.tablesError, message: 'The stub failed this listing.', retryable: true } })
        return paged(params, owner, stub.tables, index => {
          const name = index === 0 ? 'Orders' : `table${index}`
          return object({ kind: 'table', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'table')
        })
      case 'views': return paged(params, owner, stub.views, index => object({ kind: 'view', database: owner.name, schema: 'dbo', name: `view${index}` }, `dbo.view${index}`, 'eye'))
      case 'columns': {
        const parent = { kind: owner.kind, schema: owner.schema, name: owner.name }
        const column = (name, sublabel, icon) => object({ kind: 'column', database: owner.database, parent, name }, name, icon, { sublabel, hasChildren: false })
        const nodes = owner.name === 'Orders' ? [column('Id', '(PK, int, not null)', 'key'), column('CustomerName', '(nvarchar(50), null)', 'symbol-field')] : [column('Id', '(int, not null)', 'symbol-field')]
        return ok({ nodes, total: nodes.length, elapsedMs: 1 })
      }
      case 'logins': return ok({ nodes: [object({ kind: 'login', name: 'sa' }, 'sa', 'login', { hasChildren: false })], total: 1, elapsedMs: 1 })
      case 'audits':
        if (!stub.auditsOk) return ok({ nodes: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to view Audits.', retryable: true } })
        return ok({ nodes: [object({ kind: 'audit', name: 'LoginAudit' }, 'LoginAudit', 'shield', { hasChildren: false })], total: 1, elapsedMs: 1 })
      case 'linkedServers': {
        if (stub.holdLinked) {
          const cancelled = await new Promise(resolve => { stub.held.set(params.requestId, resolve) })
          if (cancelled) return { ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' }
        }
        return ok({ nodes: [object({ kind: 'linkedServer', name: 'REMOTE1' }, 'REMOTE1', 'remote', { hasChildren: false })], total: 1, elapsedMs: 1 })
      }
      default: {
        const nodes = folders(owner, statics.folders[node.folder] ?? [])
        return ok({ nodes, total: nodes.length, elapsedMs: 1 })
      }
    }
  }
  ipcMain.removeHandler('varia:request')
  ipcMain.handle('varia:request', async (_event, method, params) => {
    stub.calls.push({ method, params: method === 'connections.connect' ? { server: params.server } : params })
    switch (method) {
      case 'system.health': return ok({ protocolVersion: 2, runtime: 'stub', platform: process.platform, smoVersion: 'stub', sqlClientVersion: 'stub' })
      case 'connections.connect': {
        const info = { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '16.00.4135', productVersion: '16.0.4135.4', login: 'sa', engineEdition: 3, generation: 1 }
        stub.connections[info.id] = info
        return ok(info)
      }
      case 'connections.disconnect': delete stub.connections[params.connectionId]; return ok({ disconnected: true })
      case 'databases.list': return ok([{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }])
      case 'explorer.children': return children(params)
      case 'query.session.close': return ok({ closed: true })
      case 'query.session.state': return ok({ transactionCount: 0, checked: true })
      case 'query.execute': return ok({
        resultSets: [], discardedResultSets: 0, messages: [`Executed in ${params.database}`], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
        database: params.database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }
      })
      default: return { ok: false, error: 'Unsupported stub operation.' }
    }
  })
  ipcMain.removeHandler('varia:explorer-cancel')
  ipcMain.handle('varia:explorer-cancel', async (_event, { requestIds }) => {
    stub.cancels.push(...requestIds)
    for (const id of requestIds) { const resolve = stub.held.get(id); if (resolve) { stub.held.delete(id); resolve(true) } }
    return ok({ cancelled: requestIds.length })
  })
}
