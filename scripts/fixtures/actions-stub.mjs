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
 * Security › Logins also lists every login New Login made. New Login describes a Windows server (master, AppData and the
 * offline Archive, the read-only Ledger, `longDatabase` and eight Warehouse databases, so User Mapping's grid scrolls; two
 * languages, three server roles); User Mapping's roles describe answers `databaseRoles` (with `longRole`; guest only in
 * master); its Script is `newLoginScript`; OK with the password "Weak" answers PASSWORD_POLICY at "Create the login", "Held"
 * waits until its Stop arrives, and anything else adds the login. D2e: master has one certificate (AppSigning) and no asymmetric
 * key; the server has two credentials (AzureBlob, and Vault of the EKM provider EkmProv), each mapped after Deny and Disable; Check
 * Names (windowsPrincipal) finds CONTOSO\Ann (a user, any case) and CONTOSO\Ops (a group), and answers NOT_FOUND for any other.
 * Security › Logins lists AppUser (two sessions), CONTOSO\Ops (a Windows group), Held, Locked, Retired (disabled, its CONNECT SQL
 * denied), sa (the login the stub connects as) and SQL Server's own ##MS_PolicyTsqlExecutionLogin## (disabled). The
 * loginFacts describe answers their facts; Disable and Enable change what Logins lists, except Held's, which wait until
 * their Stop arrives; a login renamed to "Taken" is NAME_IN_USE. Delete Object on a login (D4c) lists its mapped users (AppUser's
 * in AppData, and in Sales one that owns a schema; Retired's in AppData, with a note that SQL Server Agent runs as it; CONTOSO\Ops's
 * in AppData; offline Archive not checked where a login has users) and warns about AppUser's sessions, whose Delete answers IN_USE
 * before any step; CONTOSO\Ops's Delete drops its user and then fails the login's DROP (a session signed in meanwhile), after
 * which its describe lists no user; any other login's Delete drops the users it may when asked, then the login, and leaves
 * Logins; its script is `loginDeleteScript`.
 * Locked (with the password policy) is locked out, AppUser enforces the policy and is not; the unlockLogin describe answers
 * their lock-out state, and Unlock unlocks Locked.
 * Login Properties (D2c) describes any login with New Login's lists, its facts, a SQL Server login's lock-out state, master and
 * us_english as its defaults (or the language it was given), sa's sysadmin membership and its users (AppData read, Sales not);
 * User Mapping's read with a login answers that login's user and db_datareader; its Script is `loginPropertiesScript`; OK with the
 * password "Weak" answers PASSWORD_POLICY at "Change the password", and otherwise applies the language and Status and clears
 * Locked's lock-out with UNLOCK.
 */
export function actionsStubData() {
  return { statics: explorerStatics() }
}
export const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
export const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
export const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
export const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
export const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
export const newLoginScript = name => `USE [master]\r\nGO\r\nSET XACT_ABORT ON;\r\nBEGIN TRANSACTION;\r\nCREATE LOGIN [${name}] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF;\r\nCOMMIT TRANSACTION;\r\nGO\r\n`
export const passwordPolicyMessage = 'Password validation failed. The password does not meet the operating system policy requirements because it is not complex enough.'
/** User Mapping's roles describe of a database: its roles and schemas, and guest's CONNECT (master's only). */
export const longDatabase = 'Reports_a_very_long_database_name_that_should_overflow_its_column_width_in_any_window'
export const longRole = 'reporting_readers_with_a_rather_long_role_name_that_cannot_fit_in_one_column_of_the_role_list'
export const databaseRoles = database => ({ roles: ['db_datareader', 'db_owner', 'public', 'Readers', longRole], rolesTruncated: false, guest: database === 'master', schemas: ['dbo', 'sales'], schemasTruncated: false })
/** The backend's warning for an offline database (ActionService.OfflineWarning). */
export const offlineWarning = 'This database is offline. Deleting it removes it from the server but leaves its files on disk.'
/** A login's Delete script as the backend writes it: each droppable user's DROP in its database, then DROP LOGIN in master. */
export const loginDeleteScript = (name, users = []) => [...users.map(([database, user]) => `USE [${database}]\r\nGO\r\nDROP USER [${user}]\r\nGO\r\n`), `USE [master]\r\nGO\r\nDROP LOGIN [${name}]\r\nGO\r\n`].join('')
/** Login Properties' script as the backend writes it for a change of the default language alone (SSMS's form: GO after each statement). */
export const loginPropertiesScript = (name, language) => `USE [master]\r\nGO\r\nALTER LOGIN [${name}] WITH DEFAULT_LANGUAGE=[${language}]\r\nGO\r\n`

/** Installs the stub; pass it to `application.evaluate` with `actionsStubData()`. Runs in main, so it is self-contained. */
export function installActionsStub({ ipcMain }, { statics }) {
  const stub = globalThis.variaStub = { calls: [], cancels: [], tables: ['Orders', 'Lines'], databases: ['AppData', 'Archive'], blocked: new Map(), catalog: false, managed: false,
    logins: [
      { name: '##MS_PolicyTsqlExecutionLogin##', type: 'S', subtype: 'system', disabled: true },
      { name: 'AppUser', type: 'S', subtype: 'sql', sessions: 2, policy: true, users: [['AppData', 'AppUser'], ['Sales', 'app_owner', 1]] },
      { name: 'CONTOSO\\Ops', type: 'G', subtype: 'windowsGroup', users: [['AppData', 'ops']], failsDrop: true }, { name: 'Held', type: 'S', subtype: 'sql' },
      { name: 'Locked', type: 'S', subtype: 'sql', policy: true, locked: true },
      { name: 'Retired', type: 'S', subtype: 'sql', disabled: true, connectDenied: true, users: [['AppData', 'Retired']], service: 'SQL Server Agent (MSSQLSERVER)' },
      { name: 'sa', type: 'S', subtype: 'sa', sysadmin: true }
    ] }
  // The exported texts again: this function runs in main, where the module's own bindings do not exist.
  const caution = 'Caution: Changing any part of an object name could break scripts and stored procedures.'
  const dependentsMessage = "Could not drop object 'dbo.Lines' because it is referenced by a FOREIGN KEY constraint."
  const scriptText = name => `USE [AppData]\r\nGO\r\nDROP TABLE [dbo].[${name}]\r\nGO\r\n`
  const propertiesScript = 'USE [master]\r\nGO\r\nALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT\r\nGO\r\nALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT\r\nGO\r\n'
  const designerScript = name => `CREATE TABLE dbo.${name}\r\n\t(\r\n\tId int NOT NULL\r\n\t)  ON [PRIMARY]\r\nGO\r\n`
  const newLoginScript = name => `USE [master]\r\nGO\r\nSET XACT_ABORT ON;\r\nBEGIN TRANSACTION;\r\nCREATE LOGIN [${name}] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF;\r\nCOMMIT TRANSACTION;\r\nGO\r\n`
  const passwordPolicyMessage = 'Password validation failed. The password does not meet the operating system policy requirements because it is not complex enough.'
  const longDatabase = 'Reports_a_very_long_database_name_that_should_overflow_its_column_width_in_any_window'
  const longRole = 'reporting_readers_with_a_rather_long_role_name_that_cannot_fit_in_one_column_of_the_role_list'
  const databaseRoles = database => ({ roles: ['db_datareader', 'db_owner', 'public', 'Readers', longRole], rolesTruncated: false, guest: database === 'master', schemas: ['dbo', 'sales'], schemasTruncated: false })
  const offlineWarning = 'This database is offline. Deleting it removes it from the server but leaves its files on disk.'
  const loginDeleteScript = (name, users = []) => [...users.map(([database, user]) => `USE [${database}]\r\nGO\r\nDROP USER [${user}]\r\nGO\r\n`), `USE [master]\r\nGO\r\nDROP LOGIN [${name}]\r\nGO\r\n`].join('')
  const loginPropertiesScript = (name, language) => `USE [master]\r\nGO\r\nALTER LOGIN [${name}] WITH DEFAULT_LANGUAGE=[${language}]\r\nGO\r\n`
  const ok = value => ({ ok: true, value })
  const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
  const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
  const lists = {
    databases: () => stub.databases.map(name => object({ kind: 'database', name }, name, 'database', name === 'Archive' ? { status: 'unavailable' } : {})),
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
  const factsOf = login => ({
    principalId: login.subtype === 'sa' ? 1 : 300, type: login.type, subtype: login.subtype, disabled: !!login.disabled, sid: '01', created: '2026-01-02T03:04:05.000', connectDenied: !!login.connectDenied,
    own: login.name === 'sa', sysadmin: !!login.sysadmin, sessions: login.sessions ?? 0, ownedDatabases: 0, ownedDatabaseNames: [], ownedServerObjects: 0, canAlter: true, canControlServer: true, nameInUse: false,
    ...login.type === 'S' ? { policyChecked: !!login.policy, expirationChecked: !!login.policy } : {}
  })
  const notFound = target => ({ code: 'NOT_FOUND', message: `The login ${target.name} no longer exists. Refresh Object Explorer.`, retryable: false })
  const sessionsWarning = count => `${count} sessions are connected as this login; the DROP fails until they end. Activity Monitor can end them.`
  /** The users a Delete with dropMappedUsers drops: not those that own a schema (ActionService.Kept). */
  const droppable = login => (login.users ?? []).filter(([, , schemas]) => !schemas)
  function loginFacts({ target }) {
    const login = loginOf(target)
    if (!login) return ok({ elapsedMs: 1, error: notFound(target) })
    return ok({ elapsedMs: 1, login: factsOf(login) })
  }
  /** Delete Object's describe of a login (ActionService.DescribeLoginDeleteAsync): its facts, the sessions' warning, its users. */
  function describeLogin({ target }) {
    const login = loginOf(target)
    if (!login) return ok({ elapsedMs: 1, error: notFound(target) })
    const users = (login.users ?? []).map(([database, user, schemas = 0]) => ({ database, user, ownedSchemas: schemas, ownedRoles: 0, readOnly: false, ownedSecurables: 0, grantedPermissions: 0, canDrop: true }))
    const warnings = [...login.sessions ? [{ text: sessionsWarning(login.sessions), blocking: true }] : [], ...login.service ? [{ text: `${login.service} runs as this account.`, blocking: false }] : []]
    return ok({ elapsedMs: 1, deleteTarget: { name: login.name, type: 'Login', owner: null, warnings, dependentsTruncated: false,
      login: factsOf(login), mappings: { users, mapped: users.length, checked: stub.databases.length, notChecked: login.users ? 1 : 0 } } })
  }
  /** A login's Delete: refused before any step while it has sessions; otherwise its droppable users when asked, then the login. */
  function deleteLogin({ target, dropMappedUsers }) {
    const login = loginOf(target)
    if (!login) return ok({ steps: [], messages: [], elapsedMs: 1, error: notFound(target) })
    if (login.sessions) return ok({ steps: [], messages: [], elapsedMs: 1, sessions: login.sessions, error: { code: 'IN_USE', message: sessionsWarning(login.sessions), retryable: true } })
    const users = dropMappedUsers ? droppable(login) : []
    const dropped = users.map(([database, user]) => ({ status: 'done', title: 'Drop the database user', detail: `${user} in ${database}` }))
    if (login.failsDrop) {
      login.users = (login.users ?? []).filter(user => !users.includes(user))
      const message = `Could not drop login '${login.name}' as the user is currently logged in. End the login's sessions first; Activity Monitor can end them.`
      return ok({ steps: [...dropped, { status: 'failed', title: 'Drop the login', message }], messages: [], elapsedMs: 1, error: { code: 'IN_USE', message, retryable: true } })
    }
    stub.logins = stub.logins.filter(other => other !== login)
    return ok({ steps: [...dropped, { status: 'done', title: 'Drop the login' }], messages: [], elapsedMs: 1, sessions: 0 })
  }
  /** The unlockLogin describe: the login's facts and its lock-out state (ActionSql.LoginLock). */
  function unlockFacts(params) {
    const facts = loginFacts(params), login = loginOf(params.target)
    if (!login) return facts
    return ok({ ...facts.value, lock: { locked: !!login.locked, badPasswords: login.locked ? 10 : 0, ...login.locked ? { lockoutTime: '2026-11-02T21:07:12.123' } : {}, mustChange: false, expired: false, daysUntilExpiration: 42 } })
  }
  /** New Login's describe: a Windows server's databases (offline Archive, read-only Ledger, eight Warehouses), languages and roles. */
  const newLoginModel = () => ({ server: { level: 16, linux: false, windowsOnly: false, canCreate: true, engine: 'box' },
    databases: [{ name: 'AppData', state: 0, accessible: true, readOnly: false }, { name: 'Archive', state: 6, accessible: false, readOnly: false }, { name: 'Ledger', state: 0, accessible: true, readOnly: true },
      { name: 'master', state: 0, accessible: true, readOnly: false }, { name: longDatabase, state: 0, accessible: true, readOnly: false },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `Warehouse0${index + 1}`, state: 0, accessible: true, readOnly: false }))], databasesTruncated: false,
    languages: [{ name: 'Deutsch', alias: 'German' }, { name: 'us_english', alias: 'English' }],
    serverRoles: [{ name: 'dbcreator', fixed: true }, { name: 'public', fixed: true }, { name: 'sysadmin', fixed: true }], serverRolesTruncated: false,
    certificates: ['AppSigning'], certificatesTruncated: false, asymmetricKeys: [], asymmetricKeysTruncated: false,
    credentials: [{ name: 'AzureBlob' }, { name: 'Vault', provider: 'EkmProv' }], credentialsTruncated: false })
  /** Check Names (D2e): xp_logininfo's answer for the two accounts the stub knows, NOT_FOUND for any other. */
  function windowsPrincipal({ target }) {
    const name = target.name.toLowerCase()
    if (name === 'contoso\\ann') return ok({ windowsPrincipal: { accountName: 'CONTOSO\\Ann', access: true, type: 'user', via: 'CONTOSO\\Ann' }, elapsedMs: 1 })
    if (name === 'contoso\\ops') return ok({ windowsPrincipal: { accountName: 'CONTOSO\\Ops', access: true, type: 'group', via: 'CONTOSO\\Ops' }, elapsedMs: 1 })
    return ok({ elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'The server could not find this Windows account. Check the name, typed as DOMAIN\\name.', retryable: false } })
  }
  /** Login Properties' describe (ActionService.DescribeLoginPropertiesJobAsync): New Login's lists, the login's facts and a SQL
   *  Server login's lock-out state, its defaults and server roles, and the users the scan read (AppData's; Sales was not read). */
  function loginProperties(params) {
    const facts = unlockFacts(params), login = loginOf(params.target)
    if (!login) return facts
    const { lock, ...rest } = facts.value
    const users = (login.users ?? []).filter(([database]) => database === 'AppData').map(([database, user]) => ({ database, user, defaultSchema: 'dbo', owner: false }))
    return ok({ ...rest, ...login.type === 'S' ? { lock } : {}, newLogin: newLoginModel(),
      loginProperties: { defaultDatabase: 'master', defaultLanguage: login.language ?? 'us_english', serverRoles: login.sysadmin ? ['sysadmin'] : [], serverRolesTruncated: false, users,
        read: ['AppData', 'Ledger', 'master', longDatabase], credentials: [], credentialsTruncated: false } })
  }
  /** Login Properties' OK: "Weak" fails at the password; otherwise each change is a step, in the backend's order. */
  function changeLogin({ target, loginChanges: changes, secrets }) {
    const login = loginOf(target)
    if (!login) return ok({ steps: [], messages: [], elapsedMs: 1, error: notFound(target) })
    const options = ['defaultDatabase', 'defaultLanguage', 'checkPolicy', 'checkExpiration'].some(key => changes[key] !== undefined)
    const roles = [...changes.rolesAdd ?? [], ...changes.rolesDrop ?? []].sort()
    const steps = [...options ? [{ title: "Change the login's options" }] : [], ...changes.password ? [{ title: 'Change the password' }] : [],
      ...changes.connect ? [{ title: changes.connect === 'deny' ? 'Deny permission to connect' : 'Grant permission to connect' }] : [],
      ...changes.enabled === undefined ? [] : [{ title: changes.enabled ? 'Enable the login' : 'Disable the login' }],
      ...(changes.credentialsDrop ?? []).map(detail => ({ title: 'Remove a credential', detail })), ...(changes.credentialsAdd ?? []).map(detail => ({ title: 'Map a credential', detail })),
      ...roles.map(detail => ({ title: (changes.rolesAdd ?? []).includes(detail) ? 'Add to a server role' : 'Remove from a server role', detail }))]
    if (secrets?.password === 'Weak') {
      const failed = steps.findIndex(step => step.title === 'Change the password')
      const partly = failed > 0 ? 'The login was changed only in part: its steps run one by one, as in SSMS, and list what completed. ' : ''
      return ok({ steps: steps.map((step, index) => ({ status: index < failed ? 'done' : index === failed ? 'failed' : 'skipped', ...step, ...index === failed ? { message: passwordPolicyMessage } : {} })),
        messages: [], elapsedMs: 1, error: { code: 'PASSWORD_POLICY', message: partly + passwordPolicyMessage, retryable: true } })
    }
    if (changes.defaultLanguage) login.language = changes.defaultLanguage
    if (changes.password?.unlock) login.locked = false
    if (changes.enabled !== undefined) login.disabled = !changes.enabled
    if (changes.connect) login.connectDenied = changes.connect === 'deny'
    return ok({ steps: steps.map(step => ({ status: 'done', ...step })), messages: [], elapsedMs: 1 })
  }
  /** Unlock keeping the password: its two statements and the commit, in one transaction. */
  function unlock({ target }) {
    const login = loginOf(target)
    if (!login?.locked) return ok({ steps: [], messages: [], elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: 'The login is not locked out.', retryable: false } })
    login.locked = false
    return ok({ steps: ['Turn off the password policy', 'Turn the password policy and expiration back on', 'Commit'].map(title => ({ status: 'done', title })), messages: [], elapsedMs: 1 })
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
  /** New Login: "Weak" answers PASSWORD_POLICY, "Held" waits for Stop, anything else adds the login to Logins. The steps are
   * the backend's, in SSMS's order: CREATE LOGIN, then Deny and Disable as Status chose, then each server role, then per mapped
   * database its user, default schema and roles (the stub's databases have every schema chosen, so no CREATE SCHEMA). */
  function createLogin({ login, secrets, serverRoles, status, mappings, requestId }) {
    const steps = [{ title: 'Create the login' }, ...status?.connect === 'deny' ? [{ title: 'Deny permission to connect' }] : [], ...status?.enabled === false ? [{ title: 'Disable the login' }] : [],
      ...(login.credentials ?? []).map(detail => ({ title: 'Map a credential', detail })), ...serverRoles.map(detail => ({ title: 'Add to a server role', detail })),
      ...(mappings ?? []).flatMap(({ database, defaultSchema, rolesAdd }) => [{ title: 'Create a user', detail: database }, ...defaultSchema ? [{ title: 'Set the default schema', detail: database }] : [],
        ...rolesAdd.map(role => ({ title: 'Add to a database role', detail: `${role} in ${database}` }))])]
    const after = steps.slice(1).map(step => ({ status: 'skipped', ...step }))
    if (secrets?.password === 'Weak') return ok({ steps: [{ status: 'failed', ...steps[0], message: passwordPolicyMessage }, ...after], messages: [], elapsedMs: 1,
      error: { code: 'PASSWORD_POLICY', message: passwordPolicyMessage, retryable: true } })
    if (secrets?.password === 'Held') return new Promise(resolve => stub.blocked.set(requestId, () => resolve(ok({ steps: [{ status: 'cancelled', ...steps[0] }, ...after], messages: [], elapsedMs: 1,
      error: { code: 'CANCELLED', message: 'The action was stopped at "Create the login"; SQL Server cancelled that statement.', retryable: true } }))))
    const kinds = { sql: ['S', 'sql'], windows: ['U', 'windowsUser'], entra: ['E', 'externalUser'], certificate: ['C', 'certificateMapped'], asymmetricKey: ['K', 'asymmetricKeyMapped'] }
    const [type, subtype] = kinds[login.auth]
    stub.logins = [...stub.logins, { name: login.name, type, subtype }].sort((a, b) => a.name < b.name ? -1 : 1)
    return ok({ steps: steps.map(step => ({ status: 'done', ...step })), messages: [], elapsedMs: 1 })
  }
  function execute(params) {
    const { target } = params
    if (params.action === 'createTable') return createTable(params)
    if (params.action === 'createLogin') return createLogin(params)
    if (params.action === 'disable' || params.action === 'enable') return loginState(params)
    if (params.action === 'unlock') return unlock(params)
    if (params.action === 'loginProperties') return changeLogin(params)
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
    if (params.action === 'delete' && target.kind === 'login') return deleteLogin(params)
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
          case 'loginDatabaseRoles': {
            // With a login (Login Properties): its user there, in db_datareader, or none.
            const mapped = params.login === undefined ? undefined : (loginOf({ name: params.login })?.users ?? []).find(([database]) => database === params.target.name)
            const user = params.login === undefined ? {} : mapped ? { user: { name: mapped[1], defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader'] } : { memberOf: [] }
            return ok({ loginDatabaseRoles: { ...databaseRoles(params.target.name), ...user }, elapsedMs: 1 })
          }
          case 'newLogin': return ok({ newLogin: newLoginModel(), elapsedMs: 1 })
          case 'windowsPrincipal': return windowsPrincipal(params)
          case 'loginProperties': return loginProperties(params)
          case 'loginFacts': return loginFacts(params)
          case 'unlockLogin': return unlockFacts(params)
          default: return params.target.kind === 'login' ? describeLogin(params) : describe(params)
        }
      case 'actions.script':
        switch (params.action) {
          case 'properties': return ok({ text: propertiesScript, database: 'master', warnings: [] })
          case 'createTable': return ok({ text: designerScript(params.design.name), database: params.target.name, warnings: [] })
          case 'createLogin': return ok({ text: newLoginScript(params.login.name), database: 'master', warnings: [] })
          case 'loginProperties': return ok({ text: loginPropertiesScript(params.target.name, params.loginChanges.defaultLanguage ?? 'us_english'), database: 'master', warnings: [] })
          case 'unlock': return ok({ text: ['USE [master]', 'GO', 'SET XACT_ABORT ON;', 'BEGIN TRANSACTION;', `ALTER LOGIN [${params.target.name}] WITH CHECK_POLICY = OFF;`, `ALTER LOGIN [${params.target.name}] WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON;`, 'COMMIT TRANSACTION;', 'GO', ''].join(String.fromCharCode(13, 10)), database: 'master', warnings: [] })
          default: {
            const login = params.target.kind === 'login' ? loginOf(params.target) : undefined
            if (login) return ok({ text: loginDeleteScript(login.name, params.dropMappedUsers ? droppable(login) : []), database: 'master', warnings: login.sessions ? [sessionsWarning(login.sessions)] : [] })
            return ok({ text: scriptText(params.target.name), database: params.target.database ?? 'master', warnings: [] })
          }
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
