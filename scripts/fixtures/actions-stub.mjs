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
 * Integration Services Catalogs is empty until Create Catalog runs (CLR off, the startup box unchecked); then it lists SSISDB
 * and its setup answers CATALOG_EXISTS. New Database reads model as Database Properties reads AppData, with the default data folder
 * for data and logs; its Script is `newDatabaseScript`; OK on a database named "Held" waits until its Stop arrives, and any other
 * appears under Databases. Create Catalog with the password "Weak" fails at the master key and removes what
 * it made; "Held" waits until its Stop arrives and answers as the backend does before the restore.
 * The server file picker ('serverFiles') lists `stubServerFiles`: drive C:\, the default data and backup folders, the backup
 * folder's Nightly, Empty and Slow (which answers after 1.5 s), a share, and C:\Legacy\ as SQL Server 2016 answers a login
 * outside sysadmin (legacyEmpty); any other folder is PATH_NOT_FOUND. A check (`exists`) finds a name in those folders, the
 * type filter aside, and under C:\Legacy\ answers legacyEmpty.
 * Restore Database ('restoreDatabase') reads AppData's three backups (see restore()); its Script returns `restoreScript`.
 * Attach Databases opens with the logins app_owner and sa and the default data folder, which holds Sales.mdf (whose second
 * data file it recorded in D:\Old\, not found, and whose log it finds), Sales_2.ndf and Hr.mdf (whose log in D:\Old\ is not
 * found); any other file is not a primary one. An attach that includes Hr fails at Hr and detaches what it attached before
 * (Rolled Back); otherwise each database appears under Databases.
 */
export function actionsStubData() {
  return { statics: explorerStatics(), serverFiles: stubServerFiles }
}
const backupFolder = String.raw`C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\Backup` + '\\'
const dataFolder = String.raw`C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\DATA` + '\\'
const stubFile = (name, sizeBytes) => ({ name, directory: false, sizeBytes, modified: '2026-10-12T14:03:05' })
export const stubServerFiles = {
  backupFolder,
  dataFolder,
  roots: [{ path: 'C:\\', kind: 'drive', freeMb: 217_088 }, { path: dataFolder, kind: 'folder', defaults: ['data', 'log'] }, { path: backupFolder, kind: 'folder', defaults: ['backup'] }],
  /** Folders by lower-case path. */
  folders: {
    'c:\\': [{ name: 'Program Files', directory: true }, { name: 'Legacy', directory: true }],
    [backupFolder.toLowerCase()]: [{ name: 'Empty', directory: true }, { name: 'Nightly', directory: true }, { name: 'Slow', directory: true },
      stubFile('AppData.bak', 15 * 1024 * 1024), stubFile('AppData_log.trn', 2 * 1024 * 1024), stubFile('readme.txt', 512)],
    [(backupFolder + 'Nightly\\').toLowerCase()]: [stubFile('Sales.bak', 4 * 1024 * 1024)],
    [(backupFolder + 'Empty\\').toLowerCase()]: [],
    [(backupFolder + 'Slow\\').toLowerCase()]: [stubFile('Old.bak', 1024)],
    [dataFolder.toLowerCase()]: [stubFile('master.mdf', 4 * 1024 * 1024), stubFile('mastlog.ldf', 1024 * 1024), stubFile('Sales.mdf', 8 * 1024 * 1024), stubFile('Sales_2.ndf', 8 * 1024 * 1024),
      stubFile('Sales_log.ldf', 1024 * 1024), stubFile('Hr.mdf', 8 * 1024 * 1024)],
    '\\\\files\\share\\': [stubFile('Shared.bak', 8 * 1024 * 1024)],
    'c:\\legacy\\': []
  }
}
export const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
export const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
export const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
export const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
export const restoreScript = "USE [master]\r\nRESTORE DATABASE [AppData] FROM  DISK = N'AppData.bak' WITH  FILE = 1,  NOUNLOAD,  STATS = 5\r\n\r\nGO\r\n"
export const newDatabaseScript = name => `CREATE DATABASE [${name}]
 CONTAINMENT = NONE
 ON PRIMARY
GO
`
export const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`

/** Installs the stub; pass it to `application.evaluate` with `actionsStubData()`. Runs in main, so it is self-contained. */
export function installActionsStub({ ipcMain }, { statics, serverFiles }) {
  const stub = globalThis.variaStub = { calls: [], cancels: [], tables: ['Orders', 'Lines'], databases: ['AppData'], blocked: new Map(), catalog: false }
  // The exported texts again: this function runs in main, where the module's own bindings do not exist.
  const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
  const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
  const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
  const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
  const newDatabaseScript = name => `CREATE DATABASE [${name}]
 CONTAINMENT = NONE
 ON PRIMARY
GO
`
  const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
  const restoreScript = "USE [master]\r\nRESTORE DATABASE [AppData] FROM  DISK = N'AppData.bak' WITH  FILE = 1,  NOUNLOAD,  STATS = 5\r\n\r\nGO\r\n"
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const lists = {
    databases: () => stub.databases.map(name => object({ kind: 'database', name }, name, 'database')),
    systemDatabases: () => [object({ kind: 'database', name: 'master' }, 'master', 'database', { subtype: 'system' })],
    tables: owner => stub.tables.map(name => object({ kind: 'table', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'table')),
    views: owner => [object({ kind: 'view', database: owner.name, schema: 'dbo', name: 'OrderSummary' }, 'dbo.OrderSummary', 'eye')],
    storedProcedures: owner => [object({ kind: 'procedure', database: owner.name, schema: 'dbo', name: 'ShipOrder' }, 'dbo.ShipOrder', 'symbol-method', { subtype: 'sql' })],
    integrationServicesCatalogs: () => stub.catalog ? [object({ kind: 'ssisCatalog', name: 'SSISDB' }, 'SSISDB', 'svg:database')] : []
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
  function describe({ target }) {
    const warnings = target.name === 'Lines' ? [{ text: 'Referenced by foreign key FK_Items_Lines on dbo.Items; the DROP fails until it is dropped.', blocking: true }] : []
    return ok({ deleteTarget: { name: label(target), type: target.kind === 'database' ? 'Database' : 'Table', owner: target.kind === 'database' ? 'sa' : 'dbo', warnings, dependentsTruncated: false,
      ...(target.kind === 'database' ? { isSnapshot: false } : {}) }, elapsedMs: 1 })
  }
  /** Restore Database's reads (D1e): AppData's history (a full, a differential and a log backup in the default backup
   *  folder, all on 2026-10-29), its files, and the server's facts; master is a destination too, and greyed. */
  function restore({ restore: source }) {
    const data = serverFiles.roots.find(root => root.defaults?.includes('data')).path, backup = serverFiles.backupFolder
    const set = (id, name, type, position, firstLsn, lastLsn, checkpointLsn, databaseBackupLsn, finish, device) => ({ id, name, type, server: 'server-a', database: 'AppData', position, firstLsn, lastLsn,
      checkpointLsn, databaseBackupLsn, start: '2026-10-29T' + finish, finish: '2026-10-29T' + finish, sizeBytes: 4 * 1024 * 1024, userName: 'sa', copyOnly: false, damaged: false, devices: [backup + device] })
    const sets = [
      set('00000000-0000-4000-8000-0000000000a3', 'AppData-Log', 'log', 1, '2000', '5000', '3000', '1000', '13:00:00', 'AppData_log.trn'),
      set('00000000-0000-4000-8000-0000000000a2', 'AppData-Differential', 'differential', 2, '3000', '4000', '3000', '1000', '12:00:00', 'AppData.bak'),
      set('00000000-0000-4000-8000-0000000000a1', 'AppData-Full', 'full', 1, '1000', '2000', '1000', '0', '08:00:00', 'AppData.bak')
    ]
    const server = { separator: '\\', dataPath: data, logPath: data, backupPath: backup, canRestore: true, destinationsTruncated: false, filesTruncated: false,
      destinations: [{ name: 'AppData', id: 5, created: '2026-10-01T09:00:00.000', state: 'ONLINE', recoveryModel: 'FULL', sessions: 1 }, { name: 'master', id: 1, created: '2003-04-08T09:13:36.390', state: 'ONLINE', recoveryModel: 'SIMPLE' }],
      files: [{ database: 'AppData', path: data + 'AppData.mdf' }, { database: 'AppData', path: data + 'AppData_log.ldf' }] }
    const files = [{ logical: 'AppData', physical: data + 'AppData.mdf', type: 'data', filegroup: 'PRIMARY', sizeBytes: 8 * 1024 * 1024, fileId: 1 },
      { logical: 'AppData_log', physical: data + 'AppData_log.ldf', type: 'log', sizeBytes: 8 * 1024 * 1024, fileId: 2 }]
    switch (source.kind) {
      case 'history': return ok({ restore: { server, historyDatabases: ['AppData', 'master'], ...source.database === 'AppData' ? { sets, setsTruncated: false } : source.database ? { sets: [], setsTruncated: false } : { historyTruncated: false } }, elapsedMs: 1 })
      case 'historyFiles': case 'mediaFiles': return ok({ restore: { files, filesTruncated: false }, elapsedMs: 1 })
      default: return ok({ restore: { server, sets: [], setsTruncated: false }, elapsedMs: 1 })
    }
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
  /** Attach Databases' describe: the server's facts, and with an .mdf its database (see the header). */
  function attachDescribe({ attach }) {
    const server = { logins: ['app_owner', 'sa'], loginsTruncated: false, separator: '\\', dataPath: serverFiles.dataFolder }
    if (!attach) return ok({ attachDatabase: { server }, elapsedMs: 1 })
    const at = name => serverFiles.dataFolder + name
    const databases = {
      'sales.mdf': { databaseName: 'Sales', version: 957, files: [{ original: at('Sales.mdf'), type: 'data', current: attach.mdf, found: true },
        { original: String.raw`D:\Old\Sales_2.ndf`, type: 'data', current: String.raw`D:\Old\Sales_2.ndf`, found: false }, { original: at('Sales_log.ldf'), type: 'log', current: at('Sales_log.ldf'), found: true }] },
      'hr.mdf': { databaseName: 'Hr', version: 957, files: [{ original: at('Hr.mdf'), type: 'data', current: attach.mdf, found: true },
        { original: String.raw`D:\Old\Hr_log.ldf`, type: 'log', current: String.raw`D:\Old\Hr_log.ldf`, found: false }] }
    }
    const database = databases[attach.mdf.slice(attach.mdf.lastIndexOf('\\') + 1).toLowerCase()]
    if (!database) return ok({ elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: `${attach.mdf} is not the primary data file of a database.`, retryable: false } })
    return ok({ attachDatabase: { server, database: { mdf: attach.mdf, ...database } }, elapsedMs: 1 })
  }
  /** Attach's OK, with the backend's steps: a database whose files include Hr.mdf fails, and what was attached before it is detached again. */
  function attachExecute({ databases }) {
    const steps = []
    for (const [index, database] of databases.entries()) {
      if (database.files.some(file => file.toLowerCase().endsWith('\\hr.mdf'))) {
        const message = String.raw`Msg 5120: Unable to open the physical file "D:\Old\Hr_log.ldf". Operating system error 2: "The system cannot find the file specified.".`
        steps.push({ status: 'failed', title: 'Attach the database', detail: database.name, message })
        for (const later of databases.slice(index + 1)) steps.push({ status: 'skipped', title: 'Attach the database', detail: later.name })
        for (const earlier of databases.slice(0, index).reverse()) steps.push({ status: 'done', title: 'Detach the database again', detail: earlier.name, compensates: true })
        return ok({ steps, messages: [], elapsedMs: 1, error: { code: 'FILE_ACCESS', message, retryable: true } })
      }
      steps.push({ status: 'done', title: 'Attach the database', detail: database.name })
      if (database.owner) steps.push({ status: 'done', title: 'Set the database owner', detail: database.name })
    }
    stub.databases = [...stub.databases, ...databases.map(database => database.name)]
    return ok({ steps, messages: [], elapsedMs: 1 })
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
  /** New Database's OK: a wait until Stop for "Held" (SQL Server cancelled CREATE DATABASE), otherwise the database under Databases. */
  function createDatabase({ target, requestId }) {
    if (target.name === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title: 'Create the database' }], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'The action was stopped at "Create the database"; SQL Server cancelled that statement.', retryable: true } }))))
    stub.databases = [...stub.databases, target.name]
    return ok({ steps: [{ status: 'done', title: 'Create the database' }], messages: [], elapsedMs: 1 })
  }
  function execute(params) {
    const { target } = params
    if (params.action === 'createDatabase') return createDatabase(params)
    if (params.action === 'createTable') return createTable(params)
    if (params.action === 'attach') return attachExecute(params)
    if (params.action === 'properties') return ok({ steps: Object.keys(params.changes.options ?? {}).map(key => ({ status: 'done', title: 'Set ' + key })), messages: [], elapsedMs: 1 })
    if (params.action === 'rename') {
      if (params.newName === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'The name Taken is already in use in this schema.', retryable: false } })
      if (params.newName === 'Blocked') return new Promise(resolve => stub.blocked.set(params.requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title: 'Rename' }], messages: [], elapsedMs: 1,
        error: { code: 'CANCELLED', message: 'The action was stopped at "Rename"; SQL Server cancelled that statement.', retryable: true } }))))
      stub.tables = stub.tables.map(name => name === target.name ? params.newName : name)
      return ok({ steps: [{ status: 'done', title: 'Rename' }], messages: [caution], elapsedMs: 1 })
    }
    if (target.name === 'Lines') return ok({ steps: [{ status: 'failed', title: 'Drop the object', message: dependentsMessage }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: dependentsMessage, retryable: false } })
    stub.tables = stub.tables.filter(name => name !== target.name)
    return ok({ steps: [{ status: 'done', title: 'Drop the object' }], messages: [], elapsedMs: 1 })
  }
  /** One folder of `serverFiles`, filtered by the purpose's extensions as the backend filters; Slow waits 1.5 s (or its cancel). */
  function listServerFiles({ files, requestId }) {
    if (files.path === undefined) return ok({ serverFiles: { separator: '\\', roots: serverFiles.roots, entries: [], truncated: false }, elapsedMs: 1 })
    if (files.exists) {
      // A check of one path: its own entry, none, or under C:\Legacy\ SQL Server 2016's silence (legacyEmpty).
      const path = files.path.replaceAll('/', '\\').replace(/\\$/, '')
      const at = path.lastIndexOf('\\')
      const parent = path.slice(0, at + 1).toLowerCase()
      const legacy = parent.startsWith('c:\\legacy\\')
      const own = legacy ? undefined : serverFiles.folders[parent]?.find(entry => entry.name.toLowerCase() === path.slice(at + 1).toLowerCase())
      return ok({ serverFiles: { separator: '\\', path, roots: [], entries: own ? [{ name: own.name, directory: own.directory }] : [], truncated: false, ...(legacy ? { notice: 'legacyEmpty' } : {}) }, elapsedMs: 1 })
    }
    const folder = files.path.replaceAll('/', '\\').replace(/\\?$/, '\\')
    const entries = serverFiles.folders[folder.toLowerCase()]
    if (!entries) return ok({ elapsedMs: 1, error: { code: 'PATH_NOT_FOUND', message: `The folder ${folder} does not exist, or SQL Server's service account cannot see it.`, retryable: false } })
    const extensions = { backup: ['.bak', '.trn'], database: ['.mdf'], log: ['.ldf'], folder: [] }[files.purpose]
    const listed = entries.filter(entry => entry.directory || (files.allFiles || extensions.some(extension => entry.name.toLowerCase().endsWith(extension))))
    const answer = ok({ serverFiles: { separator: '\\', path: folder, roots: [], entries: listed, truncated: false, ...(folder.toLowerCase() === 'c:\\legacy\\' ? { notice: 'legacyEmpty' } : {}) }, elapsedMs: 1 })
    if (!folder.toLowerCase().endsWith('\\slow\\')) return answer
    return new Promise(resolve => {
      const timer = setTimeout(() => { stub.blocked.delete(requestId); resolve(answer) }, 1500)
      stub.blocked.set(requestId, () => { clearTimeout(timer); resolve(ok({ elapsedMs: 1, error: { code: 'CANCELLED', message: 'Cancelled.', retryable: true } })) })
    })
  }
  ipcMain.removeHandler('varia:request')
  ipcMain.handle('varia:request', async (_event, method, params) => {
    stub.calls.push({ method, params: method === 'connections.connect' ? { server: params.server } : params })
    switch (method) {
      case 'system.health': return ok({ protocolVersion: 2, runtime: 'stub', platform: process.platform, smoVersion: 'stub', sqlClientVersion: 'stub' })
      case 'connections.connect': return ok({ id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '16.00.4135', productVersion: '16.0.4135.4', login: 'sa', engineEdition: 3, generation: 1 })
      case 'connections.disconnect': return ok({ disconnected: true })
      case 'databases.list': return ok([{ name: 'master', isSystem: true, isSnapshot: false }, ...stub.databases.map(name => ({ name, isSystem: false, isSnapshot: false }))])
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
          case 'newDatabase': {
            const folder = serverFiles.roots[1].path
            return ok({ newDatabase: { model: properties({ target: { name: 'model' } }).value.databaseProperties, dataPath: folder, logPath: folder, serverCollation: 'Latin1_General_CI_AS', canCreate: true, masterLevel: 160, linux: false }, elapsedMs: 1 })
          }
          case 'serverFiles': return listServerFiles(params)
          case 'restoreDatabase': return restore(params)
          case 'attachDatabase': return attachDescribe(params)
          default: return describe(params)
        }
      case 'actions.script':
        switch (params.action) {
          case 'properties': return ok({ text: propertiesScript, database: 'master', warnings: [] })
          case 'createTable': return ok({ text: designerScript(params.design.name), database: params.target.name, warnings: [] })
          case 'restore': return ok({ text: restoreScript, database: 'master', warnings: [] })
          case 'createDatabase': return ok({ text: newDatabaseScript(params.target.name), database: 'master', warnings: [] })
          case 'attach': return ok({ text: params.databases.map(database => `USE [master]\r\nGO\r\nCREATE DATABASE [${database.name}] ON ${database.files.map(file => `( FILENAME = N'${file}' )`).join(', ')}`
            + ` FOR ATTACH${database.rebuildLog ? '_REBUILD_LOG' : ''}\r\nGO\r\n`).join(''), database: 'master', warnings: [] })
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
