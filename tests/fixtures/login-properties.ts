// Login Properties (D2c) describe answers for the renderer's tests: a locked SQL Server login with policy and expiration on, mapped
// in AppData (as app) and owning Owned (as dbo), on a server whose User Mapping lists five databases.
import type { LoginFacts, LoginLockFacts, LoginPropertiesFacts, NewLoginModel } from '../../src/shared/actions/logins'
import { securablesModel } from './securables'

export const propertiesLogin = (changes: Partial<LoginFacts> = {}): LoginFacts => ({
  principalId: 300, type: 'S', subtype: 'sql', disabled: false, sid: '0A1B', created: '2026-01-02T03:04:05.000', policyChecked: true, expirationChecked: true,
  connectDenied: false, own: false, sysadmin: false, ownedDatabaseNames: [], canAlter: true, canControlServer: true, nameInUse: false, ...changes
})
export const propertiesLock = (changes: Partial<LoginLockFacts> = {}): LoginLockFacts => ({
  locked: true, badPasswords: 11, lockoutTime: '2026-11-02T21:07:12.123', mustChange: false, expired: false, daysUntilExpiration: 42, ...changes
})
export const propertiesNewLogin = (): NewLoginModel => ({
  server: { level: 17, linux: false, windowsOnly: false, canCreate: true, engine: 'box' },
  databases: [
    { name: 'AppData', state: 0, accessible: true, readOnly: false }, { name: 'Closed', state: 0, accessible: false, readOnly: false },
    { name: 'master', state: 0, accessible: true, readOnly: false }, { name: 'Owned', state: 0, accessible: true, readOnly: false },
    { name: 'Sales', state: 0, accessible: true, readOnly: false }
  ],
  databasesTruncated: false,
  languages: [{ name: 'us_english', alias: 'English' }, { name: 'Deutsch', alias: 'German' }],
  serverRoles: [{ name: 'bulkadmin', fixed: true }, { name: 'dbcreator', fixed: true }, { name: 'public', fixed: true }, { name: 'sysadmin', fixed: true }],
  serverRolesTruncated: false, certificates: [], certificatesTruncated: false, asymmetricKeys: [], asymmetricKeysTruncated: false, credentials: [], credentialsTruncated: false,
  securables: securablesModel()
})
export const propertiesFacts = (changes: Partial<LoginPropertiesFacts> = {}): LoginPropertiesFacts => ({
  defaultDatabase: 'master', defaultLanguage: 'us_english', serverRoles: ['bulkadmin', 'public'], serverRolesTruncated: false,
  users: [{ database: 'AppData', user: 'app', defaultSchema: 'dbo', owner: false }, { database: 'Owned', user: 'dbo', defaultSchema: 'dbo', owner: true }],
  // Sales was not read in time: User Mapping reads it when its row is selected.
  read: ['AppData', 'master', 'Owned'], permissions: [], permissionsTruncated: false, credentials: [], credentialsTruncated: false, ...changes
})
export const loginPropertiesDescribe = (changes: { login?: Partial<LoginFacts>; lock?: Partial<LoginLockFacts> | null; properties?: Partial<LoginPropertiesFacts> } = {}) => ({
  newLogin: propertiesNewLogin(), login: propertiesLogin(changes.login), ...(changes.lock === null ? {} : { lock: propertiesLock(changes.lock) }), loginProperties: propertiesFacts(changes.properties)
})
