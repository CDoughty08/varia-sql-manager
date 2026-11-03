// Login Properties (D2c): New Login's pages on an existing login. Its model is New Login's lists plus what the describe read of the
// login; its draft is New Login's plus Specify old password and Login is locked out; OK and Script send only what differs from the
// describe (an unchanged dialog sends nothing). No React and no password here: the passwords live only in ObjectDialogService's
// secret slot, and this file sees whether the new one is typed, matches its confirmation and is well formed (`SecretState`).
import { actionLimits } from '../../../shared/actions/catalog.ts'
import {
  credentialAuths, loginLimits, loginMessages, loginPropertiesMessages, loginPropertiesRefusal, loginPropertiesStatements, newLoginMessages, publicRole, tooManyStatementsMessage, userMappingMessages, type LoginChanges, type LoginDatabaseRoles,
  type LoginFacts, type LoginLockFacts, type LoginMappedUser, type LoginMappingChange, type LoginPropertiesFacts, type NewLoginAuth, type NewLoginModel
} from '../../../shared/actions/logins.ts'
import { displayText, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { emptySecrets, mappable, mappedUser, signingAuth, type MappingDraft, type NewLoginDraft, type SecretState } from './new-login'

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
/** The General page's kind for a sys.server_principals type (D2e): its radio, shown checked and read-only. */
export function loginAuthOf(type: string): NewLoginAuth {
  switch (type) {
    case 'S': return 'sql'
    case 'E': case 'X': return 'entra'
    case 'C': return 'certificate'
    case 'K': return 'asymmetricKey'
    default: return 'windows'
  }
}
/** The user mapped in a database, as read so far. */
export const mappedUserOf = (model: Pick<LoginPropertiesModel, 'properties'>, database: string): LoginMappedUser | undefined => model.properties.users.find(user => user.database === database)
/** Whether User Mapping knows a database's user: the describe's scan read it, or its row's own read did. */
export const databaseRead = (model: Pick<LoginPropertiesModel, 'properties'>, database: string) => model.properties.read.includes(database)

/** The draft as the login stands: its defaults, policy, must-change and lock-out state, server roles, status, and a mapped row per
 *  user the describe found (its roles join when User Mapping reads them). Specify old password starts checked for the connection's own
 *  login when it may not alter logins, as SQL Server then asks for it (D2 §4), unless the login is locked out, where SQL Server refuses
 *  the old password (15113) and only a new one with UNLOCK clears it. */
export function initialLoginPropertiesDraft(model: LoginPropertiesModel, target: ObjectRef): LoginPropertiesDraft {
  const { login, lock, properties } = model
  return {
    auth: loginAuthOf(login.type), name: target.name ?? '', defaultDatabase: properties.defaultDatabase,
    ...(properties.defaultLanguage !== undefined ? { defaultLanguage: properties.defaultLanguage } : {}),
    checkPolicy: login.policyChecked ?? false, checkExpiration: login.expirationChecked ?? false, mustChange: lock?.mustChange ?? false,
    serverRoles: properties.serverRoles.filter(role => role !== publicRole), connect: login.connectDenied ? 'deny' : 'grant', enabled: !login.disabled,
    mappings: properties.users.map(user => ({ database: user.database, map: true, user: user.user, defaultSchema: user.defaultSchema ?? '', roles: [], rolesKnown: false })),
    specifyOld: login.own && !login.canAlter && !lock?.locked, locked: lock?.locked ?? false,
    certificate: properties.certificate ?? '', asymmetricKey: properties.asymmetricKey ?? '', mapCredential: false, credential: model.credentials[0]?.name ?? '', credentials: [...properties.credentials]
  }
}

/** Which General and Status controls are enabled: the password fields for a SQL Server login; the old password while Specify old
 *  password is checked; the policy chain as in New Login; User must change only with a new password (T-SQL's grammar), not with the
 *  old one and not for the login this connection uses (loginPropertiesRefusal); Login is locked out only while the login is locked
 *  (SSMS's CanEditLockedOutState), to clear it or check it again. */
export function loginPropertiesEnabled(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets) {
  const sql = sqlLogin(model), typed = sql && secrets.password === 'set'
  return {
    password: sql, oldPassword: sql && draft.specifyOld, checkPolicy: sql, checkExpiration: sql && draft.checkPolicy,
    mustChange: typed && !draft.specifyOld && draft.checkPolicy && draft.checkExpiration && !model.login.own, locked: sql && !!model.lock?.locked,
    // D2e: Map to Credential for every kind but Microsoft Entra (loginPropertiesRefusal's externalCredentials).
    mapCredential: credentialAuths.includes(loginAuthOf(model.login.type)), credential: credentialAuths.includes(loginAuthOf(model.login.type)) && draft.mapCredential
  } as const
}

/** Why Status greys a choice that is not the login's current one (loginPropertiesRefusal would refuse it after OK): Deny and Disabled
 *  for the login this connection uses, Disabled for a Windows group. */
export function loginStatusLocks(model: Pick<LoginPropertiesModel, 'login'>): { readonly deny?: string; readonly disable?: string } {
  const { login } = model
  if (login.subtype === 'system') return {}
  if (login.own) return { ...(login.connectDenied ? {} : { deny: loginMessages.ownStatus }), ...(login.disabled ? {} : { disable: loginMessages.ownStatus }) }
  if (login.subtype === 'windowsGroup' && !login.disabled) return { disable: loginMessages.windowsGroupDisable }
  return {}
}

/** Where focus goes once the dialog has read the login: the password when it opens to unlock it (Unlock's hand-off clears Login is
 *  locked out), which is what the hand-off is for. */
export const loginPropertiesFocus = (model: LoginPropertiesModel, draft: LoginPropertiesDraft) => sqlLogin(model) && model.lock?.locked && !draft.locked ? 'new-login-password' : undefined

/** The page's notes about the password: blank keeps it, or unlocking needs a new one; must-change needs one too. */
export function loginPropertiesHints(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets): readonly string[] {
  if (!sqlLogin(model)) return []
  const hints: string[] = [model.lock?.locked && !draft.locked && secrets.password !== 'set' ? loginPropertiesMessages.unlockNeedsPassword : loginPropertiesMessages.keepPassword]
  if (secrets.password === 'empty' && !draft.specifyOld && draft.checkPolicy && draft.checkExpiration) hints.push(loginPropertiesMessages.mustChangeHint)
  if (model.login.own && !model.login.canAlter) hints.push(loginPropertiesMessages.ownPassword)
  return [...hints, newLoginMessages.passwordScript]
}

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
const without = (values: readonly string[], drop: ReadonlySet<string>) => sorted(values.filter(value => !drop.has(value) && value !== publicRole))

/** The first database whose User Mapping row OK cannot judge, or undefined: a row of a database the model does not count as read, or
 *  a mapped user's row whose roles were read (or chosen) but whose user's roles the model no longer holds. Both happen only after a
 *  partial run reloaded the login, until the dialog has read those databases again; OK must then neither drop those changes nor send
 *  them against a stale read. */
export function loginMappingUnread(model: LoginPropertiesModel, draft: LoginPropertiesDraft): string | undefined {
  for (const row of draft.mappings) {
    const database = model.databases.find(item => item.name === row.database)
    if (!database || !mappable(database)) continue
    if (!databaseRead(model, row.database)) return row.database
    const before = mappedUserOf(model, row.database)
    if (before && !before.owner && row.map && model.memberOf?.[row.database] === undefined && (row.rolesKnown === true || (row.rolesKnown === undefined && row.roles.length > 0))) return row.database
  }
  return undefined
}

/** User Mapping's changes, per database in the describe's order: a mapped user unchecked is dropped, a new row checked maps one, and
 *  a mapped row whose user, default schema or (once read) roles changed is updated. dbo (the login owns the database) never changes. A
 *  row's roles count only once they are known (seeded from the read, or a row the user mapped), against the user's roles as read. */
export function loginMappingChanges(model: LoginPropertiesModel, draft: LoginPropertiesDraft): LoginMappingChange[] {
  const changes: LoginMappingChange[] = [], signing = signingAuth(loginAuthOf(model.login.type))
  for (const database of model.databases) {
    const before = mappedUserOf(model, database.name), row = draft.mappings.find(mapping => mapping.database === database.name)
    if (before?.owner) continue
    if (before && row && !row.map) { changes.push({ database: database.name, change: 'unmap', user: before.user }); continue }
    if (!row?.map || !mappable(database)) continue
    const user = mappedUser(draft, row), roles = new Set(row.roles.filter(role => role !== publicRole))
    if (!before) {
      if (!databaseRead(model, database.name)) continue
      changes.push({ database: database.name, change: 'map', user, ...(row.defaultSchema && !signing ? { defaultSchema: row.defaultSchema } : {}), rolesAdd: sorted(roles) })
      continue
    }
    const memberOf = row.rolesKnown === false ? undefined : model.memberOf?.[database.name]
    const rolesAdd = memberOf ? without([...roles], new Set(memberOf)) : [], rolesDrop = memberOf ? without(memberOf, roles) : []
    const newName = user !== before.user ? user : undefined
    // Clearing the schema keeps it: ALTER USER has no "none" (D2c deviation); a different one is set. A certificate or key login's
    // users have none (15259), so it never changes there.
    const defaultSchema = row.defaultSchema && !signing && row.defaultSchema !== (before.defaultSchema ?? '') ? row.defaultSchema : undefined
    if (newName === undefined && defaultSchema === undefined && !rolesAdd.length && !rolesDrop.length) continue
    changes.push({ database: database.name, change: 'update', user: before.user, ...(newName !== undefined ? { newName } : {}), ...(defaultSchema !== undefined ? { defaultSchema } : {}),
      ...(rolesAdd.length ? { rolesAdd } : {}), ...(rolesDrop.length ? { rolesDrop } : {}) })
  }
  return changes
}

/**
 * What differs from the describe, as OK and Script send it: General's defaults and password policy, the password (a typed one, with
 * the old one, or with UNLOCK when Login is locked out was cleared and MUST_CHANGE while User must change is checked), Status, the
 * server roles added and dropped, Mapped Credentials' rows added (in the grid's order) and removed (D2e), and User Mapping's changes.
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
  const mappedBefore = new Set(properties.credentials), mappedNow = new Set(draft.credentials)
  const credentialsAdd = draft.credentials.filter(name => !mappedBefore.has(name)), credentialsDrop = sorted(properties.credentials.filter(name => !mappedNow.has(name)))
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
    ...(rolesAdd.length ? { rolesAdd } : {}), ...(rolesDrop.length ? { rolesDrop } : {}), ...(credentialsAdd.length ? { credentialsAdd } : {}), ...(credentialsDrop.length ? { credentialsDrop } : {}),
    ...(mappings.length ? { mappings } : {}),
    ...(connect ? { connect } : {}), ...(draft.enabled !== !login.disabled ? { enabled: draft.enabled } : {})
  }
}

/** Why OK and Script cannot send the changes, or undefined: a password that is too long, does not match or is broken; a lock-out
 *  cleared without a new password; a change the login's rules refuse (loginPropertiesRefusal); a default database or language the lists do not hold; more credentials
 *  than one request maps or removes, or one the server does not list; too many databases or statements. */
export function loginPropertiesProblem(model: LoginPropertiesModel, draft: LoginPropertiesDraft, secrets: SecretState = emptySecrets, changes = loginPropertiesChanges(model, draft, secrets)): string | undefined {
  if (sqlLogin(model)) {
    if (secrets.tooLong) return newLoginMessages.tooLong
    if (!secrets.matches) return newLoginMessages.mismatch
    if (!secrets.wellFormed) return newLoginMessages.broken
    if (model.lock?.locked && !draft.locked && secrets.password !== 'set') return loginPropertiesMessages.unlockNeedsPassword
    // SQL Server refuses OLD_PASSWORD on a locked-out login (15113), after any options step already ran.
    if (model.lock?.locked && changes.password?.oldPassword) return loginPropertiesMessages.lockedOldPassword
  }
  const refused = loginPropertiesRefusal(model.login, changes)
  if (refused) return loginMessages[refused]
  const unread = loginMappingUnread(model, draft)
  if (unread !== undefined) return loginPropertiesMessages.readAgain(displayText(unread))
  if (changes.defaultDatabase !== undefined && !model.databases.some(database => database.name === changes.defaultDatabase)) return newLoginMessages.defaultDatabase
  if (changes.defaultLanguage !== undefined && !model.languages.some(language => language.name === changes.defaultLanguage)) return newLoginMessages.defaultLanguage
  if ((changes.credentialsAdd?.length ?? 0) > loginLimits.credentials || (changes.credentialsDrop?.length ?? 0) > loginLimits.credentials) return newLoginMessages.credentialsLimit
  if (changes.credentialsAdd?.some(name => !model.credentials.some(credential => credential.name === name))) return newLoginMessages.credential
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
 *  that user's roles, which seed the row's roles once, checked or not (Map may have been cleared before the read landed), unless they
 *  are known already: a row the user mapped, or one seeded by an earlier read. */
export function withDatabaseRoles(model: LoginPropertiesModel, draft: LoginPropertiesDraft, database: string, value: LoginDatabaseRoles): { readonly model: LoginPropertiesModel; readonly draft: LoginPropertiesDraft } {
  const known = mappedUserOf(model, database), user = value.user
  const users = known || !user ? model.properties.users : [...model.properties.users, { database, user: user.name, ...(user.defaultSchema !== undefined ? { defaultSchema: user.defaultSchema } : {}), owner: user.owner }]
  const read = databaseRead(model, database) ? model.properties.read : [...model.properties.read, database]
  const firstRoles = (known ?? user) && model.memberOf?.[database] === undefined
  const memberOf = firstRoles ? { ...model.memberOf, [database]: (value.memberOf ?? []).filter(role => role !== publicRole) } : model.memberOf
  const next: LoginPropertiesModel = { ...model, properties: { ...model.properties, users, read }, ...(memberOf ? { memberOf } : {}) }
  let mappings = draft.mappings
  const row = draft.mappings.find(mapping => mapping.database === database)
  const roles = memberOf?.[database] ?? []
  if (!row && !known && user) mappings = [...mappings, { database, map: true, user: user.name, defaultSchema: user.defaultSchema ?? '', roles, rolesKnown: true }]
  else if (row?.rolesKnown === false && (known ?? user)) mappings = mappings.map((mapping: MappingDraft) => mapping.database === database ? { ...mapping, roles, rolesKnown: true } : mapping)
  return { model: next, draft: mappings === draft.mappings ? draft : { ...draft, mappings } }
}

/** The databases a partial run's reload must read again for User Mapping (ObjectDialogService.reload): each with a row in the draft and
 *  each whose user's roles the old model held, as the fresh describe reads neither their roles nor (past its scan) their users. */
export function loginPropertiesReadAgain(old: LoginPropertiesModel, draft: LoginPropertiesDraft): readonly string[] {
  return [...new Set([...draft.mappings.map(row => row.database), ...Object.keys(old.memberOf ?? {})])]
    .filter(name => old.databases.some(database => database.name === name && mappable(database)))
}

/** Why a User Mapping row cannot change: dbo (the login owns the database), or a database not read yet. */
export function mappingLock(model: LoginPropertiesModel, database: string): string | undefined {
  if (mappedUserOf(model, database)?.owner) return loginPropertiesMessages.owner
  if (!databaseRead(model, database)) return loginPropertiesMessages.notReadHint
  return undefined
}
