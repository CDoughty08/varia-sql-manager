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
 * Databases also lists Archive, which is offline: Delete Object warns that its files stay on disk, and deleting a database
 * drops it from the list, and greys Close existing connections there. Delete Object on AppData lists eight of its 23 sessions
 * (long program and host names, four with an open transaction); with `variaStub.managed` set it is on Managed Instance (D3d).
 * The table designer describes any database (schemas dbo and sales); its script is `designerScript`; saving a table named
 * "Taken" is NAME_IN_USE, one named "Held" waits until its Stop arrives, and any other in dbo appears under Tables.
 * Integration Services Catalogs is empty until Create Catalog runs (CLR off, the startup box unchecked); then it lists SSISDB
 * and its setup answers CATALOG_EXISTS. Create Catalog with the password "Weak" fails at the master key and removes what
 * it made; "Held" waits until its Stop arrives and answers as the backend does before the restore.
 * Security › Logins lists AppUser (two sessions), CONTOSO\Ops (a Windows group), Held, Retired (disabled, its CONNECT SQL
 * denied), sa (the login the stub connects as) and SQL Server's own ##MS_PolicyTsqlExecutionLogin## (disabled). The
 * loginFacts describe answers their facts; Disable and Enable change what Logins lists, except Held's, which wait until
 * their Stop arrives; a login renamed to "Taken" is NAME_IN_USE.
 */
export function actionsStubData() {
  return { statics: explorerStatics() }
}
export const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
export const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
export const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
export const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
export const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
/** The backend's warning for an offline database (ActionService.OfflineWarning). */
export const offlineWarning = 'This database is offline. Deleting it removes it from the server but leaves its files on disk.'

/** Installs the stub; pass it to `application.evaluate` with `actionsStubData()`. Runs in main, so it is self-contained. */
export function installActionsStub({ ipcMain }, { statics }) {
  const stub = globalThis.variaStub = { calls: [], cancels: [], tables: ['Orders', 'Lines'], databases: ['AppData', 'Archive'], blocked: new Map(), catalog: false, managed: false,
    logins: [
      { name: '##MS_PolicyTsqlExecutionLogin##', type: 'S', subtype: 'system', disabled: true }, { name: 'AppUser', type: 'S', subtype: 'sql', sessions: 2 },
      { name: 'CONTOSO\\Ops', type: 'G', subtype: 'windowsGroup' }, { name: 'Held', type: 'S', subtype: 'sql' }, { name: 'Retired', type: 'S', subtype: 'sql', disabled: true, connectDenied: true },
      { name: 'sa', type: 'S', subtype: 'sa', sysadmin: true }
    ] }
  // The exported texts again: this function runs in main, where the module's own bindings do not exist.
  const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
  const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
  const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
  const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
  const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
  const offlineWarning = 'This database is offline. Deleting it removes it from the server but leaves its files on disk.'
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const lists = {
    databases: () => stub.databases.map(name => object({ kind: 'database', name }, name, 'database', name === 'Archive' ? { status: 'unavailable' } : {})),
    systemDatabases: () => [object({ kind: 'database', name: 'master' }, 'master', 'database', { subtype: 'system' })],
    tables: owner => stub.tables.map(name => object({ kind: 'table', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'table')),
    views: owner => [object({ kind: 'view', database: owner.name, schema: 'dbo', name: 'OrderSummary' }, 'dbo.OrderSummary', 'eye')],
    storedProcedures: owner => [object({ kind: 'procedure', database: owner.name, schema: 'dbo', name: 'ShipOrder' }, 'dbo.ShipOrder', 'symbol-method', { subtype: 'sql' })],
    integrationServicesCatalogs: () => stub.catalog ? [object({ kind: 'ssisCatalog', name: 'SSISDB' }, 'SSISDB', 'svg:database')] : [],
    logins: () => stub.logins.map(login => object({ kind: 'login', name: login.name }, login.name, 'login',
      { hasChildren: false, subtype: login.subtype, ...login.disabled ? { status: 'disabled' } : login.connectDenied ? { status: 'noAccess' } : {} }))
  }
  const loginOf = target => stub.logins.find(login => login.name === target.name)
  /** The login preflight's facts (ActionSql.Login), as the loginFacts describe answers them: the stub signs in as sa. */
  function loginFacts({ target }) {
    const login = loginOf(target)
    if (!login) return ok({ elapsedMs: 1, error: { code: 'NOT_FOUND', message: `The login ${target.name} no longer exists. Refresh Object Explorer.`, retryable: false } })
    return ok({ elapsedMs: 1, login: {
      principalId: login.subtype === 'sa' ? 1 : 300, type: login.type, subtype: login.subtype, disabled: !!login.disabled, sid: '01', created: '2026-01-02T03:04:05.000', connectDenied: !!login.connectDenied,
      own: login.name === 'sa', sysadmin: !!login.sysadmin, sessions: login.sessions ?? 0, ownedDatabases: 0, ownedDatabaseNames: [], ownedServerObjects: 0, canAlter: true, canControlServer: true, nameInUse: false
    } })
  }
  /** A login's Disable or Enable: Held's waits until its Stop arrives; the others change what Logins lists. */
  function loginState({ action, target, requestId }) {
    const login = loginOf(target), title = action === 'disable' ? 'Disable the login' : 'Enable the login'
    if (target.name === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title }], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: `The action was stopped at "${title}"; SQL Server cancelled that statement.`, retryable: true } }))))
    if (login) login.disabled = action === 'disable'
    return ok({ steps: [{ status: 'done', title }], messages: [], elapsedMs: 1, sessions: login?.sessions ?? 0 })
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
        collation: 'Latin1_General_CI_AS', id: 7 },
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
        // SQL Server's default folder: a long path takes most of the grid's width, as real ones do, and the other columns must keep their words whole.
        { name: target.name + '_Archive2026_log', type: 'log', sizeMb: 8, growth: { enabled: true, unit: 'percent', by: 10, maxMb: 2097152 }, path: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL17.MSSQLSERVER\\MSSQL\\DATA',
          fileName: target.name + '_Archive2026_log.ldf', isPrimary: false }
      ],
      filesTruncated: false, filegroups: [{ name: 'PRIMARY', type: 'rows', files: 1, readOnly: false, isDefault: true, autogrowAllFiles: false }], filegroupsTruncated: false,
      server: { level: 16, sysadmin: true, filestreamLevel: 0, pathSeparator: '\\', edition: 3, containedAuthentication: false }, sessions: 1
    }, elapsedMs: 1 })
  }
  /** A database's sessions as the backend describes them: none in offline Archive, whose option is greyed; 23 in AppData, eight
   *  listed with program and host names as long as the backend's 128-character clip allows, four with a transaction. */
  const sessionsOf = name => name === 'Archive' ? { sessions: 0, withTransaction: 0, blockers: [], blockersTruncated: false, closeConnectionsNote: 'An offline database has no connections to close.' }
    : { sessions: 23, withTransaction: 4, blockersTruncated: true, ...stub.managed ? { closeConnectionsNote: 'Managed Instance cannot set SINGLE_USER.' } : {},
      blockers: Array.from({ length: 8 }, (_, index) => ({ sessionId: 61 + index, program: `Report Builder ${index + 1} `.padEnd(128, 'p'), host: `BUILD-${index + 1}-`.padEnd(128, 'h'), openTransaction: index % 2 === 0 })) }
  function describe({ target }) {
    const warnings = target.name === 'Lines' ? [{ text: 'Referenced by foreign key FK_Items_Lines on dbo.Items; the DROP fails until it is dropped.', blocking: true }]
      : target.kind === 'database' && target.name === 'Archive' ? [{ text: offlineWarning, blocking: false }] : []
    return ok({ deleteTarget: { name: label(target), type: target.kind === 'database' ? 'Database' : 'Table', owner: target.kind === 'database' ? 'sa' : 'dbo', warnings, dependentsTruncated: false,
      ...(target.kind === 'database' ? { isSnapshot: false, ...sessionsOf(target.name) } : {}) }, elapsedMs: 1 })
  }
  /** The table designer's Save: NAME_IN_USE for "Taken", a wait until Stop for "Held", otherwise a new table under Tables.
   *  Its steps are the backend's (DesignerSql.Statements and the commit): the key's only for a keyed design. */
  function createTable({ design, requestId }) {
    const titles = ['Create the table', ...design.primaryKey.length ? ['Add the primary key'] : [], 'Set lock escalation', 'Commit']
    if (design.name === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'An object named Taken already exists in schema dbo.', retryable: false } })
    if (design.name === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: titles.map((title, index) => ({ status: index === 0 ? 'cancelled' : 'skipped', title })), messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'The action was stopped at "Create the table"; SQL Server cancelled that statement. SQL Server rolled back the transaction; the table was not created.', retryable: true } }))))
    if (design.schema === 'dbo') stub.tables = [...stub.tables, design.name]
    return ok({ steps: titles.map(title => ({ status: 'done', title })), messages: [], elapsedMs: 1 })
  }
  /** Create Catalog's dialog read: a 2025 server without the catalog, CLR off; or the catalog's refusal once it exists. */
  function catalogSetup() {
    if (stub.catalog) return ok({ elapsedMs: 1, error: { code: 'CATALOG_EXISTS', message: 'There already exists a catalog (SSISDB), and only one catalog is supported on a server.', retryable: false } })
    return ok({ setup: { catalog: 'SSISDB', clrEnabled: false, startupDefault: false, backupFile: String.raw`C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak`,
      dataFile: String.raw`C:\Data\SSISDB.mdf`, logFile: String.raw`C:\Data\SSISDB.ldf` }, elapsedMs: 1 })
  }
  /** Create Catalog: "Weak" fails at the master key and removes what it made, "Held" waits for Stop, anything else creates SSISDB. */
  function createCatalog({ action, requestId }) {
    const titles = ['Enable CLR integration', 'Restore the catalog database', 'Create the master key', 'Register the Integration Services assembly and startup procedure', 'Create the maintenance job']
    if (action.password === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title: titles[0] }], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'Create Catalog was stopped at "Enable CLR integration"; SQL Server cancelled that statement, so CLR integration may or may not be enabled. Nothing else changed.', retryable: true } }))))
    if (action.password === 'Weak') {
      const message = 'Msg 15118: Password validation failed. The password does not meet the operating system policy requirements because it is not complex enough.'
      return ok({ steps: [{ status: 'done', title: titles[0] }, { status: 'done', title: titles[1] }, { status: 'failed', title: titles[2], message }, { status: 'skipped', title: titles[3] }, { status: 'skipped', title: titles[4] },
        { status: 'done', title: 'Remove the incomplete catalog', compensates: true }], elapsedMs: 1,
        error: { code: 'SQL_ERROR', message: message + ' Varia removed what Create Catalog had created, so the catalog does not exist. CLR integration stays enabled.', retryable: true } })
    }
    stub.catalog = true
    return ok({ steps: titles.map(title => ({ status: 'done', title })), elapsedMs: 1 })
  }
  function execute(params) {
    const { target } = params
    if (params.action === 'createTable') return createTable(params)
    if (params.action === 'disable' || params.action === 'enable') return loginState(params)
    if (params.action === 'rename' && target.kind === 'login') {
      if (params.newName === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'The name Taken is already used by another login or server role.', retryable: false } })
      const login = loginOf(target)
      if (login) login.name = params.newName
      return ok({ steps: [{ status: 'done', title: 'Rename' }], messages: [], elapsedMs: 1 })
    }
    if (params.action === 'properties') return ok({ steps: Object.keys(params.changes.options ?? {}).map(key => ({ status: 'done', title: 'Set ' + key })), messages: [], elapsedMs: 1 })
    if (params.action === 'rename') {
      if (params.newName === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'The name Taken is already in use in this schema.', retryable: false } })
      if (params.newName === 'Blocked') return new Promise(resolve => stub.blocked.set(params.requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title: 'Rename' }], messages: [], elapsedMs: 1,
        error: { code: 'CANCELLED', message: 'The action was stopped at "Rename"; SQL Server cancelled that statement.', retryable: true } }))))
      stub.tables = stub.tables.map(name => name === target.name ? params.newName : name)
      return ok({ steps: [{ status: 'done', title: 'Rename' }], messages: [caution], elapsedMs: 1 })
    }
    if (target.kind === 'database') {
      stub.databases = stub.databases.filter(name => name !== target.name)
      return ok({ steps: [{ status: 'done', title: 'Drop the database' }, ...params.deleteHistory ? [{ status: 'done', title: 'Delete backup and restore history' }] : []], messages: [], elapsedMs: 1 })
    }
    if (target.name === 'Lines') return ok({ steps: [{ status: 'failed', title: 'Drop the object', message: dependentsMessage }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: dependentsMessage, retryable: false } })
    stub.tables = stub.tables.filter(name => name !== target.name)
    return ok({ steps: [{ status: 'done', title: 'Drop the object' }], messages: [], elapsedMs: 1 })
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
          case 'tableDesigner': return ok({ tableDesigner: { database: params.target.name, band: 16, schemas: ['dbo', 'sales'], schemasTruncated: false, defaultSchema: 'dbo', defaultFilegroup: 'PRIMARY', caseSensitiveNames: false, accentSensitiveNames: true, canCreate: true }, elapsedMs: 1 })
          case 'databaseProperties': return properties(params)
          case 'loginFacts': return loginFacts(params)
          default: return describe(params)
        }
      case 'actions.script':
        switch (params.action) {
          case 'properties': return ok({ text: propertiesScript, database: 'master', warnings: [] })
          case 'createTable': return ok({ text: designerScript(params.design.name), database: params.target.name, warnings: [] })
          default: return ok({ text: scriptText(params.target.name), database: params.target.database ?? 'master', warnings: [] })
        }
      case 'actions.execute': return execute(params)
      case 'ssis.catalogSetup': return catalogSetup()
      case 'ssis.execute': return createCatalog(params)
      default: return { ok: false, error: 'Unsupported stub operation.' }
    }
  })
  ipcMain.removeHandler('varia:ssis-cancel')
  ipcMain.handle('varia:ssis-cancel', async (_event, { requestIds }) => {
    stub.cancels.push(...requestIds)
    for (const id of requestIds) { stub.blocked.get(id)?.(); stub.blocked.delete(id) }
    return ok({ cancelled: requestIds.length })
  })
  ipcMain.removeHandler('varia:actions-cancel')
  ipcMain.handle('varia:actions-cancel', async (_event, { requestIds }) => {
    stub.cancels.push(...requestIds)
    for (const id of requestIds) { stub.blocked.get(id)?.(); stub.blocked.delete(id) }
    return ok({ cancelled: requestIds.length })
  })
}
