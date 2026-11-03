// Login Properties (D2c): New Login's pages on an existing login. Its model is New Login's lists plus what the describe read of the
// login; its draft is New Login's plus Specify old password and Login is locked out; OK and Script send only what differs from the
// describe (an unchanged dialog sends nothing). No React and no password here: the passwords live only in ObjectDialogService's
// secret slot, and this file sees whether the new one is typed, matches its confirmation and is well formed (`SecretState`).
import { actionLimits } from '../../../shared/actions/catalog.ts'
import {
  loginLimits, loginMessages, loginPropertiesMessages, loginPropertiesRefusal, loginPropertiesStatements, newLoginMessages, publicRole, tooManyStatementsMessage, userMappingMessages, type LoginChanges, type LoginDatabaseRoles,
  type LoginFacts, type LoginLockFacts, type LoginMappedUser, type LoginMappingChange, type LoginPropertiesFacts, type NewLoginModel
} from '../../../shared/actions/logins.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { emptySecrets, mappable, mappedUser, mappingOf, type MappingDraft, type NewLoginDraft, type SecretState } from './new-login'

/** What the loginProperties describe answers: New Login's lists, the login's facts (its identity among them), its lock-out state (a
 *  SQL Server login only) and the rest the describe read. `users` grows, and gains each user's roles, as User Mapping reads databases. */
export interface LoginPropertiesModel extends NewLoginModel {
  readonly login: LoginFacts
  readonly lock?: LoginLockFacts
  readonly properties: LoginPropertiesFacts
  /** Each mapped user's roles, by database, once User Mapping has read them (the describe reads none). */
  readonly memberOf?: Readonly<Record<string, readonly string[]>>
}
/** New Login's draft plus Specify old password and Login is locked out (checked while the login is, and only clearable). */
export interface LoginPropertiesDraft extends NewLoginDraft {
  readonly specifyOld: boolean
  readonly locked: boolean
}

export const loginPropertiesModelOf = (result: { readonly newLogin?: NewLoginModel; readonly login?: LoginFacts; readonly lock?: LoginLockFacts; readonly loginProperties?: LoginPropertiesFacts }): LoginPropertiesModel | undefined =>
  result.newLogin && result.login && result.loginProperties ? { ...result.newLogin, login: result.login, ...(result.lock ? { lock: result.lock } : {}), properties: result.loginProperties } : undefined

/** Whether the login is one SQL Server authenticates itself: only it has a password and a password policy. */
export const sqlLogin = (model: Pick<LoginPropertiesModel, 'login'>) => model.login.type === 'S'
/** The user mapped in a database, as read so far. */
export const mappedUserOf = (model: Pick<LoginPropertiesModel, 'properties'>, database: string): LoginMappedUser | undefined => model.properties.users.find(user => user.database === database)
/** Whether User Mapping knows a database's user: the describe's scan read it, or its row's own read did. */
export const databaseRead = (model: Pick<LoginPropertiesModel, 'properties'>, database: string) => model.properties.read.includes(database)

/** The draft as the login stands: its defaults, policy, must-change and lock-out state, server roles, status, and a mapped row per
 *  user the describe found (its roles join when User Mapping reads them). Specify old password starts checked for the connection's own
 *  login when it may not alter logins, as SQL Server then asks for it (D2 §4). */
export function initialLoginPropertiesDraft(model: LoginPropertiesModel, target: ObjectRef): LoginPropertiesDraft {
  const { login, lock, properties } = model
  return {
    auth: sqlLogin(model) ? 'sql' : 'windows', name: target.name ?? '', defaultDatabase: properties.defaultDatabase,
    ...(properties.defaultLanguage !== undefined ? { defaultLanguage: properties.defaultLanguage } : {}),
    checkPolicy: login.policyChecked ?? false, checkExpiration: login.expirationChecked ?? false, mustChange: lock?.mustChange ?? false,
    serverRoles: properties.serverRoles.filter(role => role !== publicRole), connect: login.connectDenied ? 'deny' : 'grant', enabled: !login.disabled,
    mappings: properties.users.map(user => ({ database: user.database, map: true, user: user.user, defaultSchema: user.defaultSchema ?? '', roles: [] })),
    specifyOld: login.own && !login.canAlter, locked: lock?.locked ?? false
  }
}

/** Which General and Status controls are enabled: the password fields for a SQL Server login; the old password while Specify old
 *  password is checked; the policy chain as in New Login; User must change only with a new password (T-SQL's grammar) and not with the
 *  old one; Login is locked out only while the login is locked, to clear it (SSMS's CanEditLockedOutState). */
export function loginPropertiesEnabled(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets) {
  const sql = sqlLogin(model), typed = sql && secrets.password === 'set'
  return {
    password: sql, oldPassword: sql && draft.specifyOld, checkPolicy: sql, checkExpiration: sql && draft.checkPolicy,
    mustChange: typed && !draft.specifyOld && draft.checkPolicy && draft.checkExpiration, locked: sql && !!model.lock?.locked
  } as const
}

/** The page's notes about the password: blank keeps it; the lock-out needs a new one; must-change needs one too. */
export function loginPropertiesHints(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets): readonly string[] {
  if (!sqlLogin(model)) return []
  const hints: string[] = [loginPropertiesMessages.keepPassword]
  if (secrets.password === 'empty' && !draft.specifyOld && draft.checkPolicy && draft.checkExpiration) hints.push(loginPropertiesMessages.mustChangeHint)
  if (model.login.own && !model.login.canAlter) hints.push(loginPropertiesMessages.ownPassword)
  return [...hints, newLoginMessages.passwordScript]
}

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
const without = (values: readonly string[], drop: ReadonlySet<string>) => sorted(values.filter(value => !drop.has(value) && value !== publicRole))

/** User Mapping's changes, per database in the describe's order: a mapped user unchecked is dropped, a new row checked maps one, and
 *  a mapped row whose user, default schema or (once read) roles changed is updated. dbo (the login owns the database) never changes. */
export function loginMappingChanges(model: LoginPropertiesModel, draft: LoginPropertiesDraft): LoginMappingChange[] {
  const changes: LoginMappingChange[] = []
  for (const database of model.databases) {
    const before = mappedUserOf(model, database.name), row = draft.mappings.find(mapping => mapping.database === database.name)
    if (before?.owner) continue
    if (before && row && !row.map) { changes.push({ database: database.name, change: 'unmap', user: before.user }); continue }
    if (!row?.map || !mappable(database)) continue
    const user = mappedUser(draft, row), roles = new Set(row.roles.filter(role => role !== publicRole))
    if (!before) {
      if (!databaseRead(model, database.name)) continue
      changes.push({ database: database.name, change: 'map', user, ...(row.defaultSchema ? { defaultSchema: row.defaultSchema } : {}), rolesAdd: sorted(roles) })
      continue
    }
    const memberOf = model.memberOf?.[database.name]
    const rolesAdd = memberOf ? without([...roles], new Set(memberOf)) : [], rolesDrop = memberOf ? without(memberOf, roles) : []
    const newName = user !== before.user ? user : undefined
    // Clearing the schema keeps it: ALTER USER has no "none" (D2c deviation); a different one is set.
    const defaultSchema = row.defaultSchema && row.defaultSchema !== (before.defaultSchema ?? '') ? row.defaultSchema : undefined
    if (newName === undefined && defaultSchema === undefined && !rolesAdd.length && !rolesDrop.length) continue
    changes.push({ database: database.name, change: 'update', user: before.user, ...(newName !== undefined ? { newName } : {}), ...(defaultSchema !== undefined ? { defaultSchema } : {}),
      ...(rolesAdd.length ? { rolesAdd } : {}), ...(rolesDrop.length ? { rolesDrop } : {}) })
  }
  return changes
}

/**
 * What differs from the describe, as OK and Script send it: General's defaults and password policy, the password (a typed one, with
 * the old one, or with UNLOCK when Login is locked out was cleared and MUST_CHANGE while User must change is checked), Status, the
 * server roles added and dropped, and User Mapping's changes.
 */
export function loginPropertiesChanges(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets): LoginChanges {
  const { login, properties } = model, sql = sqlLogin(model), enabled = loginPropertiesEnabled(model, draft, secrets)
  const policy = sql && draft.checkPolicy, expiration = policy && draft.checkExpiration
  const listed = new Set(model.serverRoles.map(role => role.name)), chosen = new Set(draft.serverRoles), current = new Set(properties.serverRoles)
  const rolesAdd = sorted(draft.serverRoles.filter(role => role !== publicRole && listed.has(role) && !current.has(role)))
  const rolesDrop = sorted(properties.serverRoles.filter(role => role !== publicRole && !chosen.has(role)))
  const mappings = loginMappingChanges(model, draft)
  const connect = draft.connect !== (login.connectDenied ? 'deny' : 'grant') ? draft.connect : undefined
  const typed = sql && secrets.password === 'set'
  return {
    ...(draft.defaultDatabase !== properties.defaultDatabase ? { defaultDatabase: draft.defaultDatabase } : {}),
    ...(draft.defaultLanguage !== undefined && draft.defaultLanguage !== properties.defaultLanguage ? { defaultLanguage: draft.defaultLanguage } : {}),
    ...(sql && policy !== (login.policyChecked ?? false) ? { checkPolicy: policy } : {}),
    ...(sql && expiration !== (login.expirationChecked ?? false) ? { checkExpiration: expiration } : {}),
    ...(typed ? {
      password: {
        oldPassword: draft.specifyOld, unlock: !draft.specifyOld && !!model.lock?.locked && !draft.locked, mustChange: enabled.mustChange && draft.mustChange
      }
    } : {}),
    ...(rolesAdd.length ? { rolesAdd } : {}), ...(rolesDrop.length ? { rolesDrop } : {}), ...(mappings.length ? { mappings } : {}),
    ...(connect ? { connect } : {}), ...(draft.enabled !== !login.disabled ? { enabled: draft.enabled } : {})
  }
}

/** Why OK and Script cannot send the changes, or undefined: a password that is too long, does not match or is broken; a lock-out
 *  cleared without a new password; a change the login's rules refuse (loginPropertiesRefusal); a default database or language the lists do not hold; too many databases or statements. */
export function loginPropertiesProblem(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets, changes = loginPropertiesChanges(model, draft, secrets)): string | undefined {
  if (sqlLogin(model)) {
    if (secrets.tooLong) return newLoginMessages.tooLong
    if (!secrets.matches) return newLoginMessages.mismatch
    if (!secrets.wellFormed) return newLoginMessages.broken
    if (model.lock?.locked && !draft.locked && secrets.password !== 'set') return loginPropertiesMessages.unlockNeedsPassword
  }
  const refused = loginPropertiesRefusal(model.login, changes)
  if (refused) return loginMessages[refused]
  if (changes.defaultDatabase !== undefined && !model.databases.some(database => database.name === changes.defaultDatabase)) return newLoginMessages.defaultDatabase
  if (changes.defaultLanguage !== undefined && !model.languages.some(language => language.name === changes.defaultLanguage)) return newLoginMessages.defaultLanguage
  if ((changes.mappings?.length ?? 0) > loginLimits.mappings) return userMappingMessages.mappingsLimit
  if (loginPropertiesStatements(changes) > actionLimits.statements) return tooManyStatementsMessage(actionLimits.statements)
  return undefined
}

/** The request OK and Script send, without secrets (only OK attaches the passwords), nothing when nothing changed, or the problem
 *  the page shows. The identity binds it to the login the dialog read. */
export function loginPropertiesRequest(target: ObjectRef, model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets) {
  const changes = loginPropertiesChanges(model, draft, secrets)
  const problem = loginPropertiesProblem(model, draft, secrets, changes)
  if (problem) return { problem }
  if (loginPropertiesStatements(changes) === 0) return undefined
  return { action: 'loginProperties', target, loginIdentity: { sid: model.login.sid, created: model.login.created }, loginChanges: changes } as const
}

/** A database's read for User Mapping arrived: the user it found (a row the describe did not read becomes read, mapped or not) and
 *  that user's roles, which become the row's roles unless the row was edited already. */
export function withDatabaseRoles(model: LoginPropertiesModel, draft: LoginPropertiesDraft, database: string, value: LoginDatabaseRoles): { readonly model: LoginPropertiesModel; readonly draft: LoginPropertiesDraft } {
  const known = mappedUserOf(model, database), user = value.user
  const users = known || !user ? model.properties.users : [...model.properties.users, { database, user: user.name, ...(user.defaultSchema !== undefined ? { defaultSchema: user.defaultSchema } : {}), owner: user.owner }]
  const read = databaseRead(model, database) ? model.properties.read : [...model.properties.read, database]
  const firstRoles = (known ?? user) && model.memberOf?.[database] === undefined
  const memberOf = firstRoles ? { ...model.memberOf, [database]: (value.memberOf ?? []).filter(role => role !== publicRole) } : model.memberOf
  const next: LoginPropertiesModel = { ...model, properties: { ...model.properties, users, read }, ...(memberOf ? { memberOf } : {}) }
  let mappings = draft.mappings
  const row = mappingOf(draft, database)
  if (!known && user && !draft.mappings.some(mapping => mapping.database === database)) mappings = [...mappings, { database, map: true, user: user.name, defaultSchema: user.defaultSchema ?? '', roles: memberOf?.[database] ?? [] }]
  else if (firstRoles && row.map && row.roles.length === 0) mappings = mappings.map((mapping: MappingDraft) => mapping.database === database ? { ...mapping, roles: memberOf?.[database] ?? [] } : mapping)
  return { model: next, draft: mappings === draft.mappings ? draft : { ...draft, mappings } }
}

/** Why a User Mapping row cannot change: dbo (the login owns the database), or a database not read yet. */
export function mappingLock(model: LoginPropertiesModel, database: string): string | undefined {
  if (mappedUserOf(model, database)?.owner) return loginPropertiesMessages.owner
  if (!databaseRead(model, database)) return loginPropertiesMessages.notReadHint
  return undefined
}
