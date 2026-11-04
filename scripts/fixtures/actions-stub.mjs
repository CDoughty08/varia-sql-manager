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
 * and its setup answers CATALOG_EXISTS. New Database reads model as Database Properties reads AppData, with the default data folder
 * for data and logs; its Script is `newDatabaseScript`; OK on a database named "Held" waits until its Stop arrives, and any other
 * appears under Databases. Create Catalog with the password "Weak" fails at the master key and removes what
 * it made; "Held" waits until its Stop arrives and answers as the backend does before the restore.
 * The server file picker ('serverFiles') lists `stubServerFiles`: drive C:\, the default data and backup folders, the backup
 * folder's Nightly, Empty and Slow (which answers after 1.5 s), a share, and C:\Legacy\ as SQL Server 2016 answers a login
 * outside sysadmin (legacyEmpty); any other folder is PATH_NOT_FOUND. A check (`exists`) finds a name in those folders, the
 * type filter aside, and under C:\Legacy\ answers legacyEmpty.
 * Restore Database ('restoreDatabase') reads AppData's three backups (see restore()); its Script returns `restoreScript`. Its run
 * (restoreRun()) takes the backend's steps: with Close existing connections it reports the full backup's RESTORE at 40 % and
 * waits until its Stop arrives, then answers as the backend does over a database that existed (left RESTORING); otherwise
 * every step is done and the database online. Restore Files and Filegroups (the same reads, action 'restoreFiles') scripts
 * `restoreFilesScript` and runs RestoreFilesRun.cs's steps at once, each done, leaving the database online.
 * Attach Databases opens with the logins app_owner and sa and the default data folder, which holds Sales.mdf (whose second
 * data file it recorded in D:\Old\, not found, and whose log it finds), Sales_2.ndf and Hr.mdf (whose log in D:\Old\ is not
 * found); any other file is not a primary one. An attach that includes Hr fails at Hr and detaches what it attached before
 * (Rolled Back); otherwise each database appears under Databases.
 * Security › Logins lists AppUser (two sessions), CONTOSO\Ops (a Windows group), Held, Retired (disabled, its CONNECT SQL
 * denied), sa (the login the stub connects as) and SQL Server's own ##MS_PolicyTsqlExecutionLogin## (disabled). The
 * loginFacts describe answers their facts; Disable and Enable change what Logins lists, except Held's, which wait until
 * their Stop arrives; a login renamed to "Taken" is NAME_IN_USE. Every login New Login made is listed too.
 * New Login describes a Windows server (master, AppData and the
 * offline Archive, the read-only Ledger, `longDatabase` and eight Warehouse databases, so User Mapping's grid scrolls; two
 * languages, three server roles); User Mapping's roles describe answers `databaseRoles` (with `longRole`; guest only in
 * master); its Script is `newLoginScript`; OK with the password "Weak" answers PASSWORD_POLICY at "Create the login", "Held"
 * waits until its Stop arrives, and anything else adds the login.
 * Take Database Offline describes AppData with two sessions, one of them in a transaction; taken offline (Drop All Active
 * Connections, or none left), it lists as "(Offline)" until Bring Online. With `holding` set, a SET OFFLINE without Drop All
 * Active Connections waits, as on a session that joined after the describe, until its Stop arrives.
 * Detach Database describes AppData with the same sessions and `detachFiles`; detached, it leaves Databases and the result
 * keeps its files, until AppData is put back in `databases` (as if it were attached again) and Databases is refreshed.
 * A database's rename (D3c) reads `renameSessions` other sessions (none at first) and renames it in the listings; a name
 * another database has (ignoring case, as SQL Server's default collation does) is refused with NAME_IN_USE, as the backend's
 * preflight refuses it, so a suite cannot leave two databases of one name in the tree.
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
export const offlineScript = drop => `USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET  OFFLINE${drop ? ' WITH ROLLBACK IMMEDIATE' : ''}\r\nGO\r\n`
export const detachScript = (drop, statistics) => (drop ? 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE\r\nGO\r\n' : '')
  + `USE [master]\r\nGO\r\nEXEC master.dbo.sp_detach_db @dbname = N'AppData', @skipchecks = '${statistics ? 'false' : 'true'}'\r\nGO\r\n`
export const detachFiles = [{ fileId: 1, name: 'AppData', type: 'rows', path: 'C:\\Data\\AppData.mdf' }, { fileId: 2, name: 'AppData_log', type: 'log', path: 'C:\\Data\\AppData_log.ldf' }]
export const stubSessions = [{ sessionId: 61, login: 'app', program: 'Contoso Orders', host: 'web1', openTransactions: 1 }, { sessionId: 62, login: 'report', program: 'Reports', host: 'web2', openTransactions: 0 }]
export const restoreFilesScript = "USE [master]\r\nRESTORE DATABASE [AppData] FILE = N'AppData_2' FROM  DISK = N'AppData.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5\r\n\r\nGO\r\n"
export const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
/** The backend's warning for an offline database (ActionService.OfflineWarning). */
export const offlineWarning = 'This database is offline. Deleting it removes it from the server but leaves its files on disk.'
export const newLoginScript = name => `USE [master]\r\nGO\r\nSET XACT_ABORT ON;\r\nBEGIN TRANSACTION;\r\nCREATE LOGIN [${name}] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF;\r\nCOMMIT TRANSACTION;\r\nGO\r\n`
export const passwordPolicyMessage = 'Password validation failed. The password does not meet the operating system policy requirements because it is not complex enough.'
/** User Mapping's roles describe of a database: its roles and schemas, and guest's CONNECT (master's only). */
export const longDatabase = 'Reports_a_very_long_database_name_that_should_overflow_its_column_width_in_any_window'
export const longRole = 'reporting_readers_with_a_rather_long_role_name_that_cannot_fit_in_one_column_of_the_role_list'
export const databaseRoles = database => ({ roles: ['db_datareader', 'db_owner', 'public', 'Readers', longRole], rolesTruncated: false, guest: database === 'master', schemas: ['dbo', 'sales'], schemasTruncated: false })

/** Installs the stub; pass it to `application.evaluate` with `actionsStubData()`. Runs in main, so it is self-contained. */
export function installActionsStub({ ipcMain }, { statics, serverFiles }) {
  const stub = globalThis.variaStub = { calls: [], cancels: [], tables: ['Orders', 'Lines'], databases: ['AppData', 'Archive'], blocked: new Map(), catalog: false, managed: false, offline: false, holding: false, renameSessions: 0,
    sessions: [{ sessionId: 61, login: 'app', program: 'Contoso Orders', host: 'web1', openTransactions: 1 }, { sessionId: 62, login: 'report', program: 'Reports', host: 'web2', openTransactions: 0 }],
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
  const newDatabaseScript = name => `CREATE DATABASE [${name}]
 CONTAINMENT = NONE
 ON PRIMARY
GO
`
  const offlineScript = drop => `USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET  OFFLINE${drop ? ' WITH ROLLBACK IMMEDIATE' : ''}\r\nGO\r\n`
  const detachScript = (drop, statistics) => (drop ? 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE\r\nGO\r\n' : '')
    + `USE [master]\r\nGO\r\nEXEC master.dbo.sp_detach_db @dbname = N'AppData', @skipchecks = '${statistics ? 'false' : 'true'}'\r\nGO\r\n`
  const detachFiles = [{ fileId: 1, name: 'AppData', type: 'rows', path: 'C:\\Data\\AppData.mdf' }, { fileId: 2, name: 'AppData_log', type: 'log', path: 'C:\\Data\\AppData_log.ldf' }]
  const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
  const offlineWarning = 'This database is offline. Deleting it removes it from the server but leaves its files on disk.'
  const newLoginScript = name => `USE [master]\r\nGO\r\nSET XACT_ABORT ON;\r\nBEGIN TRANSACTION;\r\nCREATE LOGIN [${name}] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF;\r\nCOMMIT TRANSACTION;\r\nGO\r\n`
  const passwordPolicyMessage = 'Password validation failed. The password does not meet the operating system policy requirements because it is not complex enough.'
  const longDatabase = 'Reports_a_very_long_database_name_that_should_overflow_its_column_width_in_any_window'
  const longRole = 'reporting_readers_with_a_rather_long_role_name_that_cannot_fit_in_one_column_of_the_role_list'
  const databaseRoles = database => ({ roles: ['db_datareader', 'db_owner', 'public', 'Readers', longRole], rolesTruncated: false, guest: database === 'master', schemas: ['dbo', 'sales'], schemasTruncated: false })
  const restoreScript = "USE [master]\r\nRESTORE DATABASE [AppData] FROM  DISK = N'AppData.bak' WITH  FILE = 1,  NOUNLOAD,  STATS = 5\r\n\r\nGO\r\n"
  const restoreFilesScript = "USE [master]\r\nRESTORE DATABASE [AppData] FILE = N'AppData_2' FROM  DISK = N'AppData.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5\r\n\r\nGO\r\n"
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const lists = {
    // As the backend lists a database: its runtime state, and offline (AppData after Take Offline), that state in the sublabel,
    // unavailable, with nothing to expand. Archive is offline for Delete Object (D3d), listed as it was before Take Offline came.
    databases: () => stub.databases.map(name => object({ kind: 'database', name }, name, 'database', name === 'AppData' && stub.offline
      ? { sublabel: '(Offline)', status: 'unavailable', hasChildren: false, database: { state: 6, userAccess: 0, readOnly: false, standby: false } }
      : name === 'Archive' ? { status: 'unavailable', database: { state: 6, userAccess: 0, readOnly: false, standby: false } }
      : { database: { state: 0, userAccess: 0, readOnly: false, standby: false } })),
    systemDatabases: () => [object({ kind: 'database', name: 'master' }, 'master', 'database', { subtype: 'system' })],
    tables: owner => stub.tables.map(name => object({ kind: 'table', database: owner.name, schema: 'dbo', name }, `dbo.${name}`, 'table')),
    views: owner => [object({ kind: 'view', database: owner.name, schema: 'dbo', name: 'OrderSummary' }, 'dbo.OrderSummary', 'view')],
    storedProcedures: owner => [object({ kind: 'procedure', database: owner.name, schema: 'dbo', name: 'ShipOrder' }, 'dbo.ShipOrder', 'procedure', { subtype: 'sql' })],
    integrationServicesCatalogs: () => stub.catalog ? [object({ kind: 'ssisCatalog', name: 'SSISDB' }, 'SSISDB', 'database')] : [],
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
  /** Take Database Offline's and Bring Database Online's read, refused as the backend's database rules refuse it. */
  function databaseState({ dialog, target }) {
    const refused = message => ok({ elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message, retryable: false } })
    if (dialog === 'takeOffline' && stub.offline) return refused('The database is offline.')
    if (dialog === 'bringOnline' && !stub.offline) return refused('The database is online.')
    const sessions = stub.offline ? [] : stub.sessions
    return ok({ databaseState: { name: target.name, identity: { id: 7, created: '2026-01-02T03:04:05.000' }, state: stub.offline ? 6 : 0, userAccess: 0, readOnly: false, standby: false,
      sessions: sessions.length, withTransaction: sessions.filter(session => session.openTransactions > 0).length, sessionList: sessions, sessionsTruncated: false, warnings: [],
      ...(dialog === 'detachDatabase' ? { files: detachFiles, filesTruncated: false } : {}) }, elapsedMs: 1 })
  }
  /** Detach: AppData leaves Databases; the result lists the files that stay on the server. */
  function detach(params) {
    stub.databases = stub.databases.filter(name => name !== params.target.name)
    stub.sessions = []
    const steps = [...params.dropConnections ? [{ status: 'done', title: 'Close existing connections' }] : [], { status: 'done', title: 'Detach the database' }]
    return ok({ steps, messages: [], elapsedMs: 1, filesKept: detachFiles })
  }
  /** SET OFFLINE (waiting until Stop while `holding`, without Drop All Active Connections) and SET ONLINE. */
  function databaseStateChange(params) {
    if (params.action === 'bringOnline') {
      stub.offline = false
      return ok({ steps: [{ status: 'done', title: 'Bring database online' }], messages: [], elapsedMs: 1 })
    }
    const title = params.dropConnections ? 'Close connections and take database offline' : 'Take database offline'
    if (!params.dropConnections && stub.holding) return new Promise(resolve => stub.blocked.set(params.requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title }], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: `The action was stopped at "${title}"; SQL Server cancelled that statement.`, retryable: true } }))))
    stub.offline = true
    stub.sessions = []
    return ok({ steps: [{ status: 'done', title }], messages: [], elapsedMs: 1 })
  }
  /** What a database's rename reads first: `renameSessions` other sessions, one of them in a transaction, and no login defaulting to it. */
  function renameFacts({ target, connectionId }) {
    const sessions = stub.renameSessions
    return ok({ renameDatabase: { name: target.name, identity: { id: 7, created: '2026-01-02T03:04:05.000' }, userAccess: 0, sessions, withTransaction: Math.min(sessions, 1), loginsDefaulting: 0, canClose: true,
      connections: [connectionId] }, elapsedMs: 1 })
  }
  /** A database's rename: SINGLE_USER, MODIFY NAME and MULTI_USER when it closes connections, MODIFY NAME alone otherwise; the
   *  reply names the database under its new name, with the new create_date SQL Server gives it. */
  function renameDatabase(params) {
    const key = params.newName.toLowerCase()
    if (stub.databases.some(name => name !== params.target.name && name.toLowerCase() === key))
      return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: `The name ${params.newName} is already in use by another database.`, retryable: false } })
    stub.databases =stub.databases.map(name => name === params.target.name ? params.newName : name)
    const titles = params.closeConnections ? ['Close existing connections', 'Rename', 'Restore multi-user access'] : ['Rename']
    return ok({ steps: titles.map(title => ({ status: 'done', title })), messages: [`The database name '${params.newName}' has been set.`], elapsedMs: 1,
      identity: { id: 7, created: '2026-01-02T03:04:06.000' } })
  }
  function describe({ target }) {
    const warnings = target.name === 'Lines' ? [{ text: 'Referenced by foreign key FK_Items_Lines on dbo.Items; the DROP fails until it is dropped.', blocking: true }]
      : target.kind === 'database' && target.name === 'Archive' ? [{ text: offlineWarning, blocking: false }] : []
    return ok({ deleteTarget: { name: label(target), type: target.kind === 'database' ? 'Database' : 'Table', owner: target.kind === 'database' ? 'sa' : 'dbo', warnings, dependentsTruncated: false,
      ...(target.kind === 'database' ? { isSnapshot: false, ...sessionsOf(target.name) } : {}) }, elapsedMs: 1 })
  }
  /** Restore Database's reads (D1e): AppData's history (a full, a differential and a log backup in the default backup
   *  folder, all on 2026-10-29), its files (PRIMARY's, the log, and AppData_2 in Archive, which Restore Files and Filegroups
   *  can restore online), and the server's facts; master is a destination too, and greyed. */
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
      files: [{ database: 'AppData', path: data + 'AppData.mdf' }, { database: 'AppData', path: data + 'AppData_log.ldf' }, { database: 'AppData', path: data + 'AppData_2.ndf' }] }
    const files = [{ logical: 'AppData', physical: data + 'AppData.mdf', type: 'data', filegroup: 'PRIMARY', sizeBytes: 8 * 1024 * 1024, fileId: 1 },
      { logical: 'AppData_log', physical: data + 'AppData_log.ldf', type: 'log', sizeBytes: 8 * 1024 * 1024, fileId: 2 },
      { logical: 'AppData_2', physical: data + 'AppData_2.ndf', type: 'data', filegroup: 'Archive', sizeBytes: 8 * 1024 * 1024, fileId: 3 }]
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
  /** Restore Database's run: RestoreRun.cs's step titles for the request; Close existing connections makes it a held run. */
  function restoreRun({ restore: options, identity, requestId }, sender) {
    const titles = { close: 'Close existing connections', tailLog: 'Back up the tail of the log', full: 'Restore the full backup', differential: 'Restore the differential backup', log: 'Restore log backup', multiUser: 'Restore multi-user access' }
    const close = options.closeConnections && !!identity, logs = options.sets.filter(set => set.type === 'log').length
    let log = 0
    const steps = [...close ? [titles.close] : [], ...options.tailLog ? [titles.tailLog] : [], ...options.sets.map(set => set.type === 'log' ? titles.log + (logs > 1 ? ` ${++log} of ${logs}` : '') : titles[set.type]),
      ...close && options.recovery === 'recovery' && !options.restrictedUser ? [titles.multiUser] : []]
    if (!close) return ok({ steps: steps.map(title => ({ status: 'done', title })), messages: [], elapsedMs: 1, restored: { state: 0, userAccess: 0 } })
    const first = steps.indexOf(options.sets[0].type === 'log' ? steps.find(title => title.startsWith(titles.log)) : titles[options.sets[0].type])
    if (!sender.isDestroyed()) sender.send('varia:actions-progress', { requestId, step: first, percent: 40 })
    return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ messages: [], elapsedMs: 1, restored: { state: 1, userAccess: 1 },
      steps: steps.map((title, index) => ({ status: index < first ? 'done' : index === first ? 'cancelled' : 'skipped', title, ...index === first ? { progress: 40 } : {} })),
      error: { code: 'CANCELLED', message: `The action was stopped at "${steps[first]}"; SQL Server cancelled that statement. Completed before Stop: ${steps.slice(0, first).join(', ')}.`, retryable: true } }))))
  }
  /** New Database's OK: a wait until Stop for "Held" (SQL Server cancelled CREATE DATABASE), otherwise the database under Databases. */
  function createDatabase({ target, requestId }) {
    if (target.name === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', title: 'Create the database' }], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'The action was stopped at "Create the database"; SQL Server cancelled that statement.', retryable: true } }))))
    stub.databases = [...stub.databases, target.name]
    return ok({ steps: [{ status: 'done', title: 'Create the database' }], messages: [], elapsedMs: 1 })
  }
  /** New Login: "Weak" answers PASSWORD_POLICY, "Held" waits for Stop, anything else adds the login to Logins. The steps are
   * the backend's, in SSMS's order: CREATE LOGIN, then Deny and Disable as Status chose, then each server role, then per mapped
   * database its user, default schema and roles (the stub's databases have every schema chosen, so no CREATE SCHEMA). */
  function createLogin({ login, secrets, serverRoles, status, mappings, requestId }) {
    const steps = [{ title: 'Create the login' }, ...status?.connect === 'deny' ? [{ title: 'Deny permission to connect' }] : [], ...status?.enabled === false ? [{ title: 'Disable the login' }] : [],
      ...serverRoles.map(detail => ({ title: 'Add to a server role', detail })),
      ...(mappings ?? []).flatMap(({ database, defaultSchema, rolesAdd }) => [{ title: 'Create a user', detail: database }, ...defaultSchema ? [{ title: 'Set the default schema', detail: database }] : [],
        ...rolesAdd.map(role => ({ title: 'Add to a database role', detail: `${role} in ${database}` }))])]
    const after = steps.slice(1).map(step => ({ status: 'skipped', ...step }))
    if (secrets?.password === 'Weak') return ok({ steps: [{ status: 'failed', ...steps[0], message: passwordPolicyMessage }, ...after], messages: [], elapsedMs: 1,
      error: { code: 'PASSWORD_POLICY', message: passwordPolicyMessage, retryable: true } })
    if (secrets?.password === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', ...steps[0] }, ...after], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'The action was stopped at "Create the login"; SQL Server cancelled that statement.', retryable: true } }))))
    const windows = login.auth === 'windows'
    stub.logins = [...stub.logins, { name: login.name, type: windows ? 'U' : 'S', subtype: windows ? 'windowsUser' : 'sql' }].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return ok({ steps: steps.map(step => ({ status: 'done', ...step })), messages: [], elapsedMs: 1 })
  }
  /** Restore Files and Filegroups' run: RestoreFilesRun.cs's step titles for the request, each done, the database online. */
  function restoreFilesRun({ restoreFiles: options }) {
    const logs = options.sets.length - 1
    const steps = [...options.sets.map((set, index) => index === 0 ? 'Restore the files' : 'Restore log backup' + (logs > 1 ? ` ${index} of ${logs}` : '')),
      ...options.logBackup ? ['Back up the log', 'Restore the log backup'] : []]
    return ok({ steps: steps.map(title => ({ status: 'done', title })), messages: [], elapsedMs: 1, restored: { state: 0, userAccess: 0 } })
  }
  function execute(params, sender) {
    const { target } = params
    if (params.action === 'createDatabase') return createDatabase(params)
    if (params.action === 'restoreFiles') return restoreFilesRun(params)
    if (params.action === 'createTable') return createTable(params)
    if (params.action === 'disable' || params.action === 'enable') return loginState(params)
    if (params.action === 'rename' && target.kind === 'login') {
      if (params.newName === 'Taken') return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'The name Taken is already used by another login or server role.', retryable: false } })
      const login = loginOf(target)
      if (login) login.name = params.newName
      return ok({ steps: [{ status: 'done', title: 'Rename' }], messages: [], elapsedMs: 1 })
    }
    if (params.action === 'restore') return restoreRun(params, sender)
    if (params.action === 'createLogin') return createLogin(params)
    if (params.action === 'attach') return attachExecute(params)
    if (params.action === 'takeOffline' || params.action === 'bringOnline') return databaseStateChange(params)
    if (params.action === 'detach') return detach(params)
    if (params.action === 'properties') return ok({ steps: Object.keys(params.changes.options ?? {}).map(key => ({ status: 'done', title: 'Set ' + key })), messages: [], elapsedMs: 1 })
    if (params.action === 'rename' && target.kind === 'database') return renameDatabase(params)
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
          case 'loginFacts': return loginFacts(params)
          case 'loginDatabaseRoles': return ok({ loginDatabaseRoles: databaseRoles(params.target.name), elapsedMs: 1 })
          case 'newLogin': return ok({ newLogin: { server: { level: 16, linux: false, windowsOnly: false, canCreate: true },
            databases: [{ name: 'AppData', state: 0, accessible: true, readOnly: false }, { name: 'Archive', state: 6, accessible: false, readOnly: false }, { name: 'Ledger', state: 0, accessible: true, readOnly: true },
              { name: 'master', state: 0, accessible: true, readOnly: false }, { name: longDatabase, state: 0, accessible: true, readOnly: false },
              ...Array.from({ length: 8 }, (_, index) => ({ name: `Warehouse0${index + 1}`, state: 0, accessible: true, readOnly: false }))], databasesTruncated: false,
            languages: [{ name: 'Deutsch', alias: 'German' }, { name: 'us_english', alias: 'English' }],
            serverRoles: [{ name: 'dbcreator', fixed: true }, { name: 'public', fixed: true }, { name: 'sysadmin', fixed: true }], serverRolesTruncated: false }, elapsedMs: 1 })
          case 'newDatabase': {
            const folder = serverFiles.roots[1].path
            return ok({ newDatabase: { model: properties({ target: { name: 'model' } }).value.databaseProperties, dataPath: folder, logPath: folder, serverCollation: 'Latin1_General_CI_AS', canCreate: true, masterLevel: 160, linux: false }, elapsedMs: 1 })
          }
          case 'serverFiles': return listServerFiles(params)
          case 'restoreDatabase': return restore(params)
          case 'attachDatabase': return attachDescribe(params)
          case 'takeOffline': case 'bringOnline': case 'detachDatabase': return databaseState(params)
          case 'renameDatabase': return renameFacts(params)
          default: return describe(params)
        }
      case 'actions.script':
        switch (params.action) {
          case 'properties': return ok({ text: propertiesScript, database: 'master', warnings: [] })
          case 'createTable': return ok({ text: designerScript(params.design.name), database: params.target.name, warnings: [] })
          case 'createLogin': return ok({ text: newLoginScript(params.login.name), database: 'master', warnings: [] })
          case 'restore': return ok({ text: restoreScript, database: 'master', warnings: [] })
          case 'createDatabase': return ok({ text: newDatabaseScript(params.target.name), database: 'master', warnings: [] })
          case 'attach': return ok({ text: params.databases.map(database => `USE [master]\r\nGO\r\nCREATE DATABASE [${database.name}] ON ${database.files.map(file => `( FILENAME = N'${file}' )`).join(', ')}`
            + ` FOR ATTACH${database.rebuildLog ? '_REBUILD_LOG' : ''}\r\nGO\r\n`).join(''), database: 'master', warnings: [] })
          case 'takeOffline': return ok({ text: offlineScript(params.dropConnections), database: 'master', warnings: [] })
          case 'detach': return ok({ text: detachScript(params.dropConnections, params.updateStatistics), database: 'master', warnings: [] })
          case 'restoreFiles': return ok({ text: restoreFilesScript, database: 'master', warnings: [] })
          default: return ok({ text: scriptText(params.target.name), database: params.target.database ?? 'master', warnings: [] })
        }
      case 'actions.execute': return execute(params, _event.sender)
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
