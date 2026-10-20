// A deterministic SQL Server for scripts/object-actions-smoke.mjs, installed in main in place of its request handler and
// its object action cancel channel. Every request is recorded in `globalThis.variaStub.calls` and every cancelled id in
// `globalThis.variaStub.cancels`; renames and deletes change what the stub lists.
import { explorerStatics } from './explorer-tree.mjs'

/**
 * What the stub serves below each connected server: Databases › AppData (and System Databases › master) with Tables
 * (dbo.Orders; dbo.Lines, which a foreign key blocks), Views (dbo.OrderSummary) and Programmability › Stored Procedures
 * (dbo.ShipOrder). Renaming to "Taken" is NAME_IN_USE; renaming to "Blocked" waits, as on another session's lock, until
 * its Stop arrives and then answers as the backend does once SQL Server cancelled it; a rename returns sp_rename's caution.
 * Database Properties describes AppData (two files, PRIMARY, one session) and master; Script returns `propertiesScript`.
 * The table designer describes any database (schemas dbo and sales); its script is `designerScript`; saving a table named
 * "Taken" is NAME_IN_USE, one named "Held" waits until its Stop arrives, and any other in dbo appears under Tables.
 */
export function actionsStubData() {
  return { statics: explorerStatics() }
}
export const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
export const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
export const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
export const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
export const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`

/** Installs the stub; pass it to `application.evaluate` with `actionsStubData()`. Runs in main, so it is self-contained. */
export function installActionsStub({ ipcMain }, { statics }) {
  const stub = globalThis.variaStub = { calls: [], cancels: [], tables: ['Orders', 'Lines'], blocked: new Map() }
  // The exported texts again: this function runs in main, where the module's own bindings do not exist.
  const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
  const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
  const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
  const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
  const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const lists = {
    databases: () => [object({ kind: 'database', name: 'AppData' }, 'AppData', 'svg:database')],
    systemDatabases: () => [object({ kind: 'database', name: 'master' }, 'master', 'svg:database', { subtype: 'system' })],
    tables: owner => stub.tables.map(name => object({ kind: 'table', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'svg:table')),
    views: owner => [object({ kind: 'view', database: owner.name, schema: 'dbo', name: 'OrderSummary' }, 'dbo.OrderSummary', 'eye')],
    storedProcedures: owner => [object({ kind: 'procedure', database: owner.name, schema: 'dbo', name: 'ShipOrder' }, 'dbo.ShipOrder', 'symbol-method', { subtype: 'sql' })]
  }
  function children({ node }) {
    if (node.type === 'object') {
      const ids = statics.objects[node.object.kind] ?? []
      return ok({ nodes: folders(node.object, ids), total: ids.length, elapsedMs: 1 })
    }
    const nodes = [...folders(node.owner, statics.folders[node.folder] ?? []), ...lists[node.folder]?.(node.owner) ?? []]
    return ok({ nodes, total: nodes.length, elapsedMs: 1 })
  }
  const label = target => [target.schema, target.name].filter(Boolean).join('.')
  /** Database Properties' model of AppData (or master): SQL Server 2022, a sysadmin, one other session. */
  function properties({ target }) {
    const bool = value => value ? 'true' : 'false'
    return ok({ databaseProperties: {
      general: { name: target.name, status: 'ONLINE', standby: false, owner: 'sa', created: '2026-01-02T03:04:05.000', sizeMb: 16, spaceAvailableMb: 5.25, users: 4, lastBackup: 'None', lastLogBackup: 'None',
        collation: 'Latin1_General_CI_AS' },
      options: {
        collation: 'Latin1_General_CI_AS', recoveryModel: 'FULL', compatibilityLevel: '160', containmentType: 'NONE', autoClose: bool(false), autoCreateIncrementalStatistics: bool(false),
        autoCreateStatistics: bool(true), autoShrink: bool(false), autoUpdateStatistics: bool(true), autoUpdateStatisticsAsync: bool(false), closeCursorOnCommit: bool(false), defaultCursor: 'GLOBAL',
        filestreamNonTransactedAccess: 'OFF', isLedgerDatabase: bool(false), allowSnapshotIsolation: bool(false), ansiNullDefault: bool(false), ansiNulls: bool(false), ansiPadding: bool(false),
        ansiWarnings: bool(false), arithmeticAbort: bool(false), concatNullYieldsNull: bool(false), dbChaining: bool(false), dateCorrelationOptimization: bool(false), delayedDurability: 'DISABLED',
        readCommittedSnapshot: bool(false), numericRoundAbort: bool(false), parameterization: 'SIMPLE', quotedIdentifiers: bool(false), recursiveTriggers: bool(false), trustworthy: bool(false),
        varDecimalStorageFormat: bool(true), pageVerify: 'CHECKSUM', targetRecoveryTime: '60', brokerEnabled: bool(false), honorBrokerPriority: bool(false),
        serviceBrokerIdentifier: '6F9619FF-8B86-D011-B42D-00C04FC964FF', readOnly: bool(false), databaseState: 'ONLINE', encryptionEnabled: bool(false), restrictAccess: 'MULTI_USER'
      },
      scoped: { maxDop: '0', maxDopForSecondary: 'PRIMARY', legacyCardinalityEstimation: 'OFF', legacyCardinalityEstimationForSecondary: 'PRIMARY', parameterSniffing: 'ON',
        parameterSniffingForSecondary: 'PRIMARY', queryOptimizerFixes: 'OFF', queryOptimizerFixesForSecondary: 'PRIMARY' },
      compatibilityLevels: [100, 110, 120, 130, 140, 150, 160], collations: ['Latin1_General_BIN2', 'Latin1_General_CI_AS'], logins: ['AppUser', 'sa'],
      files: [
        { name: target.name, type: 'rows', filegroup: 'PRIMARY', sizeMb: 8, growth: { enabled: true, unit: 'mb', by: 64 }, path: 'C:\\Data', fileName: target.name + '.mdf', isPrimary: true },
        { name: target.name + '_log', type: 'log', sizeMb: 8, growth: { enabled: true, unit: 'percent', by: 10, maxMb: 2097152 }, path: 'C:\\Data', fileName: target.name + '_log.ldf', isPrimary: false }
      ],
      filesTruncated: false, filegroups: [{ name: 'PRIMARY', type: 'rows', files: 1, readOnly: false, isDefault: true, autogrowAllFiles: false }], filegroupsTruncated: false,
      server: { level: 16, sysadmin: true, filestreamLevel: 0, pathSeparator: '\\', edition: 3, containedAuthentication: false }, sessions: 1
    }, elapsedMs: 1 })
  }
  function describe({ target }) {
    const warnings = target.name === 'Lines' ? [{ text: 'Referenced by foreign key FK_Items_Lines on dbo.Items; the DROP fails until it is dropped.', blocking: true }] : []
    return ok({ deleteTarget: { name: label(target), type: target.kind === 'database' ? 'Database' : 'Table', owner: target.kind === 'database' ? 'sa' : 'dbo', warnings, dependentsTruncated: false,
      ...(target.kind === 'database' ? { isSnapshot: false } : {}) }, elapsedMs: 1 })
  }
  /** The table designer's Save: NAME_IN_USE for "Taken", a wait until Stop for "Held", otherwise a new table under Tables. */
  function createTable({ design, requestId }) {
    if (design.name === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'An object named Taken already exists in schema dbo.', retryable: false } })
    if (design.name === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', message: 'Create the table' }], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'The action was stopped at "Create the table"; SQL Server cancelled that statement.', retryable: true } }))))
    if (design.schema === 'dbo') stub.tables = [...stub.tables, design.name]
    return ok({ steps: ['Create the table', 'Set lock escalation', 'Commit'].map(message => ({ status: 'done', message })), messages: [], elapsedMs: 1 })
  }
  function execute(params) {
    const { target } = params
    if (params.action === 'createTable') return createTable(params)
    if (params.action === 'properties') return ok({ steps: Object.keys(params.changes.options ?? {}).map(key => ({ status: 'done', message: key })), messages: [], elapsedMs: 1 })
    if (params.action === 'rename') {
      if (params.newName === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'The name Taken is already in use in this schema.', retryable: false } })
      if (params.newName === 'Blocked') return new Promise(resolve => stub.blocked.set(params.requestId, () => resolve(ok({ steps: [{ status: 'cancelled', message: 'Rename' }], messages: [], elapsedMs: 1,
        error: { code: 'CANCELLED', message: 'The action was stopped at "Rename"; SQL Server cancelled that statement.', retryable: true } }))))
      stub.tables = stub.tables.map(name => name === target.name ? params.newName : name)
      return ok({ steps: [{ status: 'done', message: 'Rename' }], messages: [caution], elapsedMs: 1 })
    }
    if (target.name === 'Lines') return ok({ steps: [{ status: 'failed', message: dependentsMessage }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: dependentsMessage, retryable: false } })
    stub.tables = stub.tables.filter(name => name !== target.name)
    return ok({ steps: [{ status: 'done', message: 'Drop the object' }], messages: [], elapsedMs: 1 })
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
      case 'tables.columns': return ok({ columns: [{ name: 'OrderId', dataType: 'int' }, { name: 'Total', dataType: 'money' }], truncated: false })
      case 'query.execute': return ok({
        resultSets: [], discardedResultSets: 0, messages: [{ text: 'Commands completed successfully.', kind: 'info' }], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 1, totalBatches: 1,
        database: params.database, messagesTruncated: false, budget: { usedBytes: 0, globalBytes: 1, queryBytes: 1, generation: 1, seq: 1 }, completedAt: '2026-10-19 00:00:00.0000000'
      })
      case 'query.session.close': return ok({ closed: true })
      case 'query.session.state': return ok({ transactionCount: 0, checked: true })
      case 'actions.describe':
        switch (params.dialog) {
          case 'tableDesigner': return ok({ tableDesigner: { database: params.target.name, band: 16, schemas: ['dbo', 'sales'], schemasTruncated: false, defaultSchema: 'dbo', defaultFilegroup: 'PRIMARY', canCreate: true }, elapsedMs: 1 })
          case 'databaseProperties': return properties(params)
          default: return describe(params)
        }
      case 'actions.script':
        switch (params.action) {
          case 'properties': return ok({ text: propertiesScript, database: 'master', warnings: [] })
          case 'createTable': return ok({ text: designerScript(params.design.name), database: params.target.name, warnings: [] })
          default: return ok({ text: scriptText(params.target.name), database: params.target.database ?? 'master', warnings: [] })
        }
      case 'actions.execute': return execute(params)
      default: return { ok: false, error: 'Unsupported stub operation.' }
    }
  })
  ipcMain.removeHandler('varia:actions-cancel')
  ipcMain.handle('varia:actions-cancel', async (_event, { requestIds }) => {
    stub.cancels.push(...requestIds)
    for (const id of requestIds) { stub.blocked.get(id)?.(); stub.blocked.delete(id) }
    return ok({ cancelled: requestIds.length })
  })
}
