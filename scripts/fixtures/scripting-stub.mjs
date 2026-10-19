// A deterministic SQL Server for scripts/scripting-smoke.mjs, installed in main in place of its request handler and its
// scripting cancel channel. Every request is recorded in `globalThis.variaStub.calls` and every cancelled id in
// `globalThis.variaStub.cancels`.
import { explorerStatics } from './explorer-tree.mjs'

/**
 * What the stub serves below each connected server: Databases › AppData with Tables (dbo.Orders; dbo.Slow, whose
 * scripts wait until cancelled; and dbo.Warned, whose scripts carry the backend's VIEW DEFINITION warning), Views (dbo.OrderSummary), Programmability › Stored Procedures (dbo.ShipOrder, and
 * dbo.Secret, which is encrypted), and Security › Logins (sa). A script is `-- <verb> <object>`.
 */
export function scriptingStubData() {
  return { statics: explorerStatics() }
}
/** B10's ENCRYPTED message for an object. */
export const encryptedMessage = label => `${label} is encrypted (WITH ENCRYPTION), so its definition cannot be scripted. DROP and EXECUTE scripts still work.`
/** The preflight's warning for a table the login may read but not see whole. */
export const viewDefinitionWarning = label => `You do not have VIEW DEFINITION permission on ${label}; parts you cannot see (for example indexes or constraints) may be missing from the script.`

/** Installs the stub; pass it to `application.evaluate` with `scriptingStubData()`. Runs in main, so it is self-contained. */
export function installScriptingStub({ ipcMain }, { statics }) {
  const stub = globalThis.variaStub = { calls: [], cancels: [], held: new Map() }
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const lists = {
    databases: () => [object({ kind: 'database', name: 'AppData' }, 'AppData', 'svg:database')],
    tables: owner => ['Orders', 'Slow', 'Warned'].map(name => object({ kind: 'table', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'svg:table')),
    views: owner => [object({ kind: 'view', database: owner.name, schema: 'dbo', name: 'OrderSummary' }, 'dbo.OrderSummary', 'eye')],
    storedProcedures: owner => ['ShipOrder', 'Secret'].map(name => object({ kind: 'procedure', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'symbol-method', { subtype: 'sql' })),
    logins: () => [object({ kind: 'login', name: 'sa' }, 'sa', 'svg:login', { hasChildren: false })]
  }
  function children({ node }) {
    if (node.type === 'object') {
      const ids = statics.objects[node.object.kind] ?? []
      return ok({ nodes: folders(node.object, ids), total: ids.length, elapsedMs: 1 })
    }
    const nodes = [...folders(node.owner, statics.folders[node.folder] ?? []), ...lists[node.folder]?.(node.owner) ?? []]
    return ok({ nodes, total: nodes.length, elapsedMs: 1 })
  }
  async function script(params) {
    const [target] = params.targets, label = [target.schema, target.name].filter(Boolean).join('.')
    if (target.name === 'Slow') {
      const cancelled = await new Promise(resolve => { stub.held.set(params.requestId, resolve) })
      if (cancelled) return { ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' }
    }
    const warnings = target.name === 'Warned' ? [`You do not have VIEW DEFINITION permission on ${label}; parts you cannot see (for example indexes or constraints) may be missing from the script.`] : []
    const result = { database: target.database ?? 'master', warnings, commands: 1, elapsedMs: 1 }
    if (target.name === 'Secret' && ['create', 'alter', 'createOrAlter', 'dropAndCreate'].includes(params.verb)) {
      return ok({ ...result, error: { code: 'ENCRYPTED', message: `${label} is encrypted (WITH ENCRYPTION), so its definition cannot be scripted. DROP and EXECUTE scripts still work.`, retryable: false } })
    }
    return ok({ ...result, text: `-- ${params.verb} ${label}` })
  }
  ipcMain.removeHandler('varia:request')
  ipcMain.handle('varia:request', async (_event, method, params) => {
    stub.calls.push({ method, params: method === 'connections.connect' ? { server: params.server } : params })
    switch (method) {
      case 'system.health': return ok({ protocolVersion: 2, runtime: 'stub', platform: process.platform, smoVersion: 'stub', sqlClientVersion: 'stub' })
      case 'connections.connect': return ok({ id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '16.00.4135', productVersion: '16.0.4135.4', login: 'sa', engineEdition: 3, generation: 1 })
      case 'connections.disconnect': return ok({ disconnected: true })
      case 'databases.list': return ok([{ name: 'master', isSystem: true, isSnapshot: false }, { name: 'AppData', isSystem: false, isSnapshot: false }])
      case 'explorer.children': return children(params)
      case 'scripting.script': return script(params)
      case 'query.session.close': return ok({ closed: true })
      case 'query.session.state': return ok({ transactionCount: 0, checked: true })
      default: return { ok: false, error: 'Unsupported stub operation.' }
    }
  })
  ipcMain.removeHandler('varia:scripting-cancel')
  ipcMain.handle('varia:scripting-cancel', async (_event, { requestIds }) => {
    stub.cancels.push(...requestIds)
    for (const id of requestIds) { const resolve = stub.held.get(id); if (resolve) { stub.held.delete(id); resolve(true) } }
    return ok({ cancelled: requestIds.length })
  })
}
