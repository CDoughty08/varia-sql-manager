// Login Properties (D2c): the loginProperties request and the login-scoped User Mapping read in main's schemas, the draft helpers
// and the changes they send (src/renderer/src/dialogs/login-properties.ts), the dialog's run through the object dialog service (the
// passwords only with OK, the old one only with Specify old password, the lazy read naming the login), and the words the backend shares.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionLimits } from '../src/shared/actions/catalog'
import {
  loginDatabaseRolesDescribe, loginMessages, loginPropertiesMessages, loginPropertiesRefusal, loginPropertiesStatements, newLoginMessages, unlockChoices, unlockChoiceText, unlockHandOffLabel,
  type LoginChanges, type LoginDatabaseRoles
} from '../src/shared/actions/logins'
import { actionPrompts, actionPromptRequestSchema } from '../src/shared/actions/prompts'
import {
  actionDescribeSchema, actionExecuteRequestSchema, actionScriptRequestSchema, loginPasswordStepTitle, type ActionDescribeResult, type ActionExecuteResult, type ActionStep
} from '../src/shared/actions/schema'
import type { ApiResult, ExplorerNode, VariaApi } from '../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId } from '../src/shared/explorer/catalog'
import type { ObjectRef } from '../src/shared/explorer/refs'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { loginPropertiesDefinition, loginStatusConfirm } from '../src/renderer/src/dialogs/definitions'
import {
  initialLoginPropertiesDraft, loginMappingChanges, loginMappingUnread, loginPropertiesChanges, loginPropertiesEnabled, loginPropertiesFocus, loginPropertiesHints, loginPropertiesModelOf,
  loginPropertiesProblem, loginPropertiesReadAgain, loginPropertiesRequest, loginStatusLocks, mappingLock, withDatabaseRoles, type LoginPropertiesDraft, type LoginPropertiesModel
} from '../src/renderer/src/dialogs/login-properties'
import type { PageProps } from '../src/renderer/src/dialogs/ObjectDialog'
import { NewLoginGeneralPage, NewLoginServerRolesPage, NewLoginStatusPage } from '../src/renderer/src/dialogs/pages/NewLoginPages'
import UserMappingPage from '../src/renderer/src/dialogs/pages/UserMappingPage'
import { setMapped, setMappingRole, setMappingSchema, setMappingUser, type SecretState } from '../src/renderer/src/dialogs/new-login'
import { ObjectDialogService, type OpenObjectDialog } from '../src/renderer/src/dialogs/ObjectDialogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { loginPropertiesDescribe } from './fixtures/login-properties'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const appLogin: ObjectRef = { kind: 'login', name: 'app_login' }
const ids = () => ({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() })
const identity = { sid: '0A1B', created: '2026-01-02T03:04:05.000' }
const typed: SecretState = { password: 'set', matches: true, wellFormed: true, tooLong: false }
const model = (changes: Parameters<typeof loginPropertiesDescribe>[0] = {}): LoginPropertiesModel => loginPropertiesModelOf(loginPropertiesDescribe(changes))!
const draftOf = (of: LoginPropertiesModel, changes: Partial<LoginPropertiesDraft> = {}): LoginPropertiesDraft => ({ ...initialLoginPropertiesDraft(of, appLogin), ...changes })
const request = (loginChanges: LoginChanges, changes: Record<string, unknown> = {}) => ({ action: 'loginProperties', ...ids(), target: appLogin, loginIdentity: identity, loginChanges, ...changes })
const script = (value: unknown) => actionScriptRequestSchema.safeParse(value).success
const executes = (value: unknown) => actionExecuteRequestSchema.safeParse(value).success
const roles = (count: number) => Array.from({ length: count }, (_, index) => `r${index}`)

describe('Login Properties in the request schemas', () => {
  it('accepts every change with hostile names verbatim on Script, and on OK with the identity and the passwords it needs', () => {
    const hostile = "a]'; DROP LOGIN x; --‮"
    const changes: LoginChanges = {
      defaultDatabase: hostile, defaultLanguage: 'Deutsch', checkPolicy: true, checkExpiration: true, password: { oldPassword: false, unlock: true, mustChange: true },
      rolesAdd: ['dbcreator', hostile], rolesDrop: ['bulkadmin'], connect: 'deny', enabled: false,
      mappings: [
        { database: hostile, change: 'map', user: hostile, defaultSchema: hostile, rolesAdd: ['db_owner'] },
        { database: 'AppData', change: 'update', user: 'app', newName: 'app2', defaultSchema: 'sales', rolesAdd: ['db_owner'], rolesDrop: ['db_datareader'] },
        { database: 'Sales', change: 'unmap', user: 'old' }
      ]
    }
    expect(script(request(changes))).toBe(true)
    expect(script(request(changes, { loginIdentity: undefined }))).toBe(true)
    expect(executes(request(changes, { secrets: { password: 'N3w!pass' } }))).toBe(true)
    expect(executes(request({ password: { oldPassword: true, unlock: false, mustChange: false } }, { secrets: { password: 'N3w!pass', oldPassword: 'Old!pass' } }))).toBe(true)
    // A blank old password is SQL Server's to judge (a login may have none).
    expect(executes(request({ password: { oldPassword: true, unlock: false, mustChange: false } }, { secrets: { password: 'N3w!pass', oldPassword: '' } }))).toBe(true)
    expect(executes(request({ enabled: true }))).toBe(true)
  })
  it('refuses the passwords on Script, and on OK a change without the identity or with the wrong passwords', () => {
    const password = { oldPassword: false, unlock: false, mustChange: false }
    expect(script(request({ password }, { secrets: { password: 'N3w!pass' } }))).toBe(false)
    expect(executes(request({ enabled: true }, { loginIdentity: undefined }))).toBe(false)
    for (const [name, value] of [
      ['no new password', request({ password })],
      ['a blank new password (blank keeps the current one)', request({ password }, { secrets: { password: '' } })],
      ['a password with no password change', request({ enabled: true }, { secrets: { password: 'N3w!pass' } })],
      ['an old password without Specify old password', request({ password }, { secrets: { password: 'N3w!pass', oldPassword: 'x' } })],
      ['Specify old password without the old one', request({ password: { ...password, oldPassword: true } }, { secrets: { password: 'N3w!pass' } })],
      ['a password over the limit', request({ password }, { secrets: { password: 'x'.repeat(129) } })]
    ] as const) expect(executes(value), name).toBe(false)
  })
  it('refuses changes SQL Server would refuse or Varia never sends, and anything but a login as its target', () => {
    for (const [name, changes] of [
      ['nothing', {}],
      ['expiration without the policy', { checkPolicy: false, checkExpiration: true }],
      ['the old password with UNLOCK', { password: { oldPassword: true, unlock: true, mustChange: false } }],
      ['the old password with MUST_CHANGE', { password: { oldPassword: true, unlock: false, mustChange: true } }],
      ['public', { rolesAdd: ['public'] }], ['public in a database', { mappings: [{ database: 'A', change: 'update', user: 'u', rolesDrop: ['public'] }] }],
      ['a duplicate role', { rolesAdd: ['a', 'a'] }], ['a role added and dropped', { rolesAdd: ['a'], rolesDrop: ['a'] }],
      ['a database twice', { mappings: [{ database: 'A', change: 'unmap', user: 'u' }, { database: 'A', change: 'map', user: 'u' }] }],
      ['an unmap with roles', { mappings: [{ database: 'A', change: 'unmap', user: 'u', rolesAdd: ['r'] }] }],
      ['a map that renames', { mappings: [{ database: 'A', change: 'map', user: 'u', newName: 'v' }] }],
      ['an update that changes nothing', { mappings: [{ database: 'A', change: 'update', user: 'u' }] }],
      ['a rename to the same name', { mappings: [{ database: 'A', change: 'update', user: 'u', newName: 'u' }] }],
      ['too many server roles', { rolesAdd: roles(257) }],
      ['too many statements', { mappings: Array.from({ length: 200 }, (_, index) => ({ database: `d${index}`, change: 'map', user: 'u', rolesAdd: ['a', 'b'] })) }],
      ['an unknown member', { enabled: true, sid: '01' }], ['a third connect state', { connect: 'revoke' }]
    ] as const) expect(script(request(changes as LoginChanges)), name).toBe(false)
    expect(loginPropertiesStatements({ mappings: Array.from({ length: 200 }, (_, index) => ({ database: `d${index}`, change: 'map', user: 'u', rolesAdd: ['a', 'b'] })) })).toBeGreaterThan(actionLimits.statements)
    expect(script(request({ enabled: true }, { target: { kind: 'database', name: 'AppData' } }))).toBe(false)
    expect(script(request({ enabled: true }, { action: 'properties' }))).toBe(false)
  })
  it('reads a login\'s properties on a login, and a database\'s User Mapping with the login named only for loginDatabaseRoles', () => {
    expect(actionDescribeSchema.safeParse({ ...ids(), dialog: 'loginProperties', target: appLogin }).success).toBe(true)
    expect(actionDescribeSchema.safeParse({ ...ids(), dialog: 'loginProperties', target: { kind: 'database', name: 'AppData' } }).success).toBe(false)
    expect(actionDescribeSchema.safeParse({ ...ids(), dialog: loginDatabaseRolesDescribe, target: { kind: 'database', name: 'Sales' }, login: "a]'b" }).success).toBe(true)
    expect(actionDescribeSchema.safeParse({ ...ids(), dialog: loginDatabaseRolesDescribe, target: { kind: 'database', name: 'Sales' }, login: 'x'.repeat(129) }).success).toBe(false)
    expect(actionDescribeSchema.safeParse({ ...ids(), dialog: 'loginProperties', target: appLogin, login: 'app_login' }).success).toBe(false)
  })
})

describe('Login Properties drafts', () => {
  it('starts from the login as read, and sends nothing until something changes', () => {
    const of = model()
    expect(draftOf(of)).toEqual({
      auth: 'sql', name: 'app_login', defaultDatabase: 'master', defaultLanguage: 'us_english', checkPolicy: true, checkExpiration: true, mustChange: false, serverRoles: ['bulkadmin'],
      connect: 'grant', enabled: true, specifyOld: false, locked: true, securables: [], permissions: [],
      mappings: [{ database: 'AppData', map: true, user: 'app', defaultSchema: 'dbo', roles: [], rolesKnown: false }, { database: 'Owned', map: true, user: 'dbo', defaultSchema: 'dbo', roles: [], rolesKnown: false }]
    })
    expect(loginPropertiesRequest(appLogin, of, draftOf(of))).toBeUndefined()
    // The connection's own login, which may not alter logins, starts with Specify old password checked: SQL Server asks for it.
    expect(draftOf(model({ login: { own: true, canAlter: false }, lock: { locked: false } })).specifyOld).toBe(true)
    expect(draftOf(model({ lock: null })).locked).toBe(false)
  })
  it('sends a typed password, with UNLOCK once Login is locked out is cleared and MUST_CHANGE only where T-SQL takes it', () => {
    const of = model()
    expect(loginPropertiesChanges(of, draftOf(of), typed)).toEqual({ password: { oldPassword: false, unlock: false, mustChange: false } })
    expect(loginPropertiesChanges(of, draftOf(of, { locked: false }), typed).password).toEqual({ oldPassword: false, unlock: true, mustChange: false })
    expect(loginPropertiesChanges(of, draftOf(of, { mustChange: true }), typed).password).toEqual({ oldPassword: false, unlock: false, mustChange: true })
    // The old password's ALTER LOGIN takes neither UNLOCK nor MUST_CHANGE, so Specify old password greys User must change.
    expect(loginPropertiesChanges(of, draftOf(of, { specifyOld: true, mustChange: true, locked: false }), typed).password).toEqual({ oldPassword: true, unlock: false, mustChange: false })
    expect(loginPropertiesEnabled(of, draftOf(of, { specifyOld: true }), typed)).toMatchObject({ oldPassword: true, mustChange: false })
    // User must change needs a new password and both policy options.
    expect(loginPropertiesEnabled(of, draftOf(of))).toMatchObject({ password: true, oldPassword: false, mustChange: false, locked: true })
    expect(loginPropertiesEnabled(of, draftOf(of, { checkExpiration: false }), typed).mustChange).toBe(false)
    expect(loginPropertiesChanges(of, draftOf(of, { checkExpiration: false, mustChange: true }), typed)).toEqual({ checkExpiration: false, password: { oldPassword: false, unlock: false, mustChange: false } })
    // A blank password keeps the current one; clearing the lock-out then needs one.
    expect(loginPropertiesProblem(of, draftOf(of, { locked: false }))).toBe(loginPropertiesMessages.unlockNeedsPassword)
    expect(loginPropertiesProblem(of, draftOf(of, { locked: false }), typed)).toBeUndefined()
    expect(loginPropertiesProblem(of, draftOf(of), { ...typed, matches: false })).toBe(newLoginMessages.mismatch)
    expect(loginPropertiesProblem(of, draftOf(of), { ...typed, tooLong: true })).toBe(newLoginMessages.tooLong)
    expect(loginPropertiesHints(of, draftOf(of))).toEqual([loginPropertiesMessages.keepPassword, loginPropertiesMessages.mustChangeHint, newLoginMessages.passwordScript])
    expect(loginPropertiesHints(model({ login: { own: true, canAlter: false } }), draftOf(of, { specifyOld: true }))).toEqual([loginPropertiesMessages.keepPassword, loginPropertiesMessages.ownPassword, newLoginMessages.passwordScript])
  })
  it('sends General\'s defaults and policy, Status, and the server roles added and dropped', () => {
    const of = model()
    const draft = draftOf(of, { defaultDatabase: 'AppData', defaultLanguage: 'Deutsch', checkPolicy: false, serverRoles: ['dbcreator', 'sysadmin'], connect: 'deny', enabled: false })
    const changes = loginPropertiesChanges(of, draft)
    expect(changes).toEqual({
      defaultDatabase: 'AppData', defaultLanguage: 'Deutsch', checkPolicy: false, checkExpiration: false, rolesAdd: ['dbcreator', 'sysadmin'], rolesDrop: ['bulkadmin'], connect: 'deny', enabled: false
    })
    expect(loginPropertiesStatements(changes)).toBe(6)
    expect(loginPropertiesRequest(appLogin, of, draft)).toEqual({ action: 'loginProperties', target: appLogin, loginIdentity: identity, loginChanges: changes })
    expect(loginPropertiesProblem(of, draftOf(of, { defaultDatabase: 'Gone' }))).toBe(newLoginMessages.defaultDatabase)
  })
  it('refuses what the login\'s rules refuse: its own status, a Windows group\'s Disable, a password on another kind; SQL Server\'s own never change', () => {
    const own = model({ login: { own: true } })
    expect(loginPropertiesProblem(own, draftOf(own, { connect: 'deny' }))).toBe(loginMessages.ownStatus)
    expect(loginPropertiesProblem(own, draftOf(own, { enabled: false }))).toBe(loginMessages.ownStatus)
    expect(loginPropertiesProblem(own, draftOf(own, { defaultDatabase: 'AppData' }))).toBeUndefined()
    const group = model({ login: { type: 'G', subtype: 'windowsGroup', policyChecked: undefined, expirationChecked: undefined }, lock: null })
    expect(loginPropertiesProblem(group, draftOf(group, { enabled: false }))).toBe(loginMessages.windowsGroupDisable)
    expect(loginPropertiesProblem(group, draftOf(group, { connect: 'deny' }))).toBeUndefined()
    // A Windows login has no password: a typed one (the field is greyed) never joins the changes, and its policy never changes.
    expect(loginPropertiesChanges(group, draftOf(group, { checkPolicy: true }), typed)).toEqual({})
    expect(loginPropertiesEnabled(group, draftOf(group), typed)).toEqual({ password: false, oldPassword: false, checkPolicy: false, checkExpiration: false, mustChange: false, locked: false })
    expect(loginPropertiesHints(group, draftOf(group))).toEqual([])
    expect(loginPropertiesRefusal({ type: 'U', subtype: 'windowsUser', own: false }, { checkPolicy: true })).toBe('propertiesNotSql')
    expect(loginPropertiesRefusal({ type: 'S', subtype: 'system', own: false }, { enabled: true })).toBe('system')
    expect(loginPropertiesDefinition.blocked?.(model({ login: { subtype: 'system' } }), draftOf(model({ login: { subtype: 'system' } })))).toBe(loginMessages.system)
    expect(loginPropertiesDefinition.blocked?.(model({ login: { subtype: 'sa' } }), draftOf(model({ login: { subtype: 'sa' } })))).toBeUndefined()
  })
  it('unmaps, renames and changes a mapped user\'s schema and roles once read; dbo and unread databases never change', () => {
    let of = model(), draft = draftOf(of)
    expect(mappingLock(of, 'Owned')).toBe(loginPropertiesMessages.owner)
    expect(mappingLock(of, 'Sales')).toBe(loginPropertiesMessages.notReadHint)
    expect(mappingLock(of, 'AppData')).toBeUndefined()
    expect(loginMappingChanges(of, { ...draft, ...setMapped(draft, 'AppData', false) })).toEqual([{ database: 'AppData', change: 'unmap', user: 'app' }])
    expect(loginMappingChanges(of, { ...draft, ...setMapped(draft, 'Owned', false) })).toEqual([])
    expect(loginMappingChanges(of, { ...draft, ...setMapped(draft, 'Sales', true) })).toEqual([])
    expect(loginMappingChanges(of, { ...draft, ...setMappingUser(draft, 'AppData', 'app2') })).toEqual([{ database: 'AppData', change: 'update', user: 'app', newName: 'app2' }])
    expect(loginMappingChanges(of, { ...draft, ...setMappingSchema(draft, 'AppData', 'sales') })).toEqual([{ database: 'AppData', change: 'update', user: 'app', defaultSchema: 'sales' }])
    // ALTER USER has no "no default schema", so clearing it keeps the one the user has.
    expect(loginMappingChanges(of, { ...draft, ...setMappingSchema(draft, 'AppData', '') })).toEqual([])
    // Roles change only once read: the row then shows the user's roles, and a change is the difference.
    const read = (value: Partial<LoginDatabaseRoles>) => ({ roles: ['db_datareader', 'db_owner', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, ...value })
    ;({ model: of, draft } = withDatabaseRoles(of, draft, 'AppData', read({ user: { name: 'app', defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader', 'public'] })))
    expect(of.memberOf).toEqual({ AppData: ['db_datareader'] })
    expect(draft.mappings.find(mapping => mapping.database === 'AppData')?.roles).toEqual(['db_datareader'])
    expect(loginMappingChanges(of, draft)).toEqual([])
    const roled = { ...draft, ...setMappingRole(draft, 'AppData', 'db_owner', true) }
    expect(loginMappingChanges(of, { ...roled, ...setMappingRole(roled, 'AppData', 'db_datareader', false) })).toEqual([{ database: 'AppData', change: 'update', user: 'app', rolesAdd: ['db_owner'], rolesDrop: ['db_datareader'] }])
    // Sales, read now with no user there, can be mapped; its roles are added.
    ;({ model: of, draft } = withDatabaseRoles(of, draft, 'Sales', read({})))
    expect(mappingLock(of, 'Sales')).toBeUndefined()
    const mapped = { ...draft, ...setMapped(draft, 'Sales', true) }
    expect(loginMappingChanges(of, { ...mapped, ...setMappingRole(mapped, 'Sales', 'db_owner', true) })).toEqual([{ database: 'Sales', change: 'map', user: 'app_login', rolesAdd: ['db_owner'] }])
    // A database the scan missed whose read finds the login's user joins as a mapped row.
    const missed = model({ properties: { read: ['AppData', 'master', 'Owned'] } })
    const found = withDatabaseRoles(missed, draftOf(missed), 'Sales', read({ user: { name: 'legacy', owner: false }, memberOf: ['db_owner'] }))
    expect(found.model.properties.users.at(-1)).toEqual({ database: 'Sales', user: 'legacy', owner: false })
    expect(found.draft.mappings.at(-1)).toEqual({ database: 'Sales', map: true, user: 'legacy', defaultSchema: '', roles: ['db_owner'], rolesKnown: true })
    expect(loginMappingChanges(found.model, found.draft)).toEqual([])
  })
  it('keeps a mapped user\'s roles when Map is cleared before its read lands and checked again (finding 4)', () => {
    let of = model(), draft = draftOf(of)
    draft = { ...draft, ...setMapped(draft, 'AppData', false) }
    ;({ model: of, draft } = withDatabaseRoles(of, draft, 'AppData', { roles: ['db_datareader', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'app', defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader'] }))
    draft = { ...draft, ...setMapped(draft, 'AppData', true) }
    expect(draft.mappings.find(row => row.database === 'AppData')).toMatchObject({ map: true, roles: ['db_datareader'], rolesKnown: true })
    // Nothing changed: the user keeps db_datareader.
    expect(loginMappingChanges(of, draft)).toEqual([])
    // Before its read, the row's roles are not known: nothing about them is sent.
    const unread = draftOf(model())
    expect(loginMappingChanges(model(), { ...unread, ...setMappingSchema(unread, 'AppData', 'sales') })).toEqual([{ database: 'AppData', change: 'update', user: 'app', defaultSchema: 'sales' }])
  })
  it('refuses a mapped row whose read a reload lost, until it is read again, and names the databases to read (finding 5)', () => {
    let of = model(), draft = draftOf(of)
    const read = { roles: ['db_datareader', 'db_owner', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'app', defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader'] }
    ;({ model: of, draft } = withDatabaseRoles(of, draft, 'AppData', read))
    draft = { ...draft, ...setMappingRole(draft, 'AppData', 'db_owner', true) }
    expect(loginPropertiesReadAgain(of, draft)).toEqual(['AppData', 'Owned'])
    // The reload's model holds no roles: OK refuses instead of dropping db_owner.
    const fresh = model()
    expect(loginMappingUnread(fresh, draft)).toBe('AppData')
    expect(loginPropertiesProblem(fresh, draft)).toBe(loginPropertiesMessages.readAgain('AppData'))
    // Once read again, the change is sent.
    const again = withDatabaseRoles(fresh, draft, 'AppData', read)
    expect(loginPropertiesProblem(again.model, again.draft)).toBeUndefined()
    expect(loginMappingChanges(again.model, again.draft)).toEqual([{ database: 'AppData', change: 'update', user: 'app', rolesAdd: ['db_owner'] }])
  })
  it('clears the lock-out without the old password: SQL Server refuses it on a locked-out login (finding 8)', () => {
    const own = model({ login: { own: true, canAlter: false } })
    expect(draftOf(own).specifyOld).toBe(false)
    expect(draftOf(model({ login: { own: true, canAlter: false }, lock: { locked: false } })).specifyOld).toBe(true)
    expect(loginPropertiesProblem(own, draftOf(own, { specifyOld: true }), typed)).toBe(loginPropertiesMessages.lockedOldPassword)
    expect(loginPropertiesProblem(own, draftOf(own, { specifyOld: false, locked: false }), typed)).toBeUndefined()
  })
  it('checks Login is locked out again after clearing it, and then sends no UNLOCK (finding 10)', () => {
    const of = model()
    const cleared = draftOf(of, { locked: false }), again = { ...cleared, locked: true }
    expect(loginPropertiesEnabled(of, again, typed).locked).toBe(true)
    expect(loginPropertiesChanges(of, again, typed).password).toEqual({ oldPassword: false, unlock: false, mustChange: false })
    expect(loginPropertiesProblem(of, again)).toBeUndefined()
  })
  it('says a new password unlocks the login once Login is locked out is cleared, and focuses Password then (finding 12)', () => {
    const of = model()
    expect(loginPropertiesHints(of, draftOf(of, { locked: false }))[0]).toBe(loginPropertiesMessages.unlockNeedsPassword)
    expect(loginPropertiesHints(of, draftOf(of, { locked: false }), typed)[0]).toBe(loginPropertiesMessages.keepPassword)
    expect(loginPropertiesFocus(of, draftOf(of, { locked: false }))).toBe('new-login-password')
    expect(loginPropertiesFocus(of, draftOf(of))).toBeUndefined()
    expect(loginPropertiesFocus(model({ lock: null }), draftOf(model({ lock: null }), { locked: false }))).toBeUndefined()
  })
  it('greys Status\' Deny and Disabled for the connection\'s own login and Disabled for a Windows group, and MUST_CHANGE on its own login (findings 3, 13)', () => {
    expect(loginStatusLocks(model({ login: { own: true } }))).toEqual({ deny: loginMessages.ownStatus, disable: loginMessages.ownStatus })
    // Its current state stays selectable.
    expect(loginStatusLocks(model({ login: { own: true, disabled: true, connectDenied: true } }))).toEqual({})
    expect(loginStatusLocks(model({ login: { type: 'G', subtype: 'windowsGroup' } }))).toEqual({ disable: loginMessages.windowsGroupDisable })
    expect(loginStatusLocks(model())).toEqual({})
    const own = model({ login: { own: true }, lock: { locked: false } })
    expect(loginPropertiesEnabled(own, draftOf(own), typed).mustChange).toBe(false)
    expect(loginPropertiesRefusal({ type: 'S', subtype: 'sql', own: true }, { password: { oldPassword: false, unlock: false, mustChange: true } })).toBe('ownMustChange')
    expect(loginMessages.ownMustChange).toContain('Connect with another login')
  })
  it('asks before Status\' Disabled or Deny only when someone would be locked out, as the Disable verb does (finding 18)', () => {
    const of = model({ login: { sessions: 2 } })
    const disable = loginPropertiesRequest(appLogin, of, draftOf(of, { enabled: false }))!, deny = loginPropertiesRequest(appLogin, of, draftOf(of, { connect: 'deny' }))!
    const asked = loginStatusConfirm(of, disable as never, {})
    expect(asked).toEqual({ prompt: 'disableLogin', facts: { login: 'app_login', sysadmin: false, sessions: 2 } })
    expect(loginStatusConfirm(of, deny as never, { loginConnections: ['Prod (server-a.example)'] })).toEqual({ prompt: 'disableLogin', facts: { login: 'app_login', sysadmin: false, sessions: 2, connections: ['Prod (server-a.example)'], deny: true } })
    expect(actionPromptRequestSchema.safeParse(asked).success).toBe(true)
    expect(actionPrompts.disableLogin.buttons({ login: 'x', sysadmin: false, deny: true }).map(button => button.label)).toEqual(['Deny', 'Cancel'])
    // Nobody to lock out, or no Disable or Deny: no question, as in SSMS.
    const idle = model()
    expect(loginStatusConfirm(idle, loginPropertiesRequest(appLogin, idle, draftOf(idle, { enabled: false })) as never, {})).toBeUndefined()
    expect(loginStatusConfirm(of, loginPropertiesRequest(appLogin, of, draftOf(of, { defaultDatabase: 'AppData' })) as never, { loginConnections: ['x'] })).toBeUndefined()
    expect(loginStatusConfirm(model({ login: { service: 'MSSQLSERVER' } }), disable as never, {})).toMatchObject({ facts: { service: 'MSSQLSERVER' } })
  })
})

function setup(describe: Parameters<typeof loginPropertiesDescribe>[0] = {}, other?: string) {
  const execute = deferred<ApiResult<ActionExecuteResult>>()
  const reads = new Map<string, ReturnType<typeof deferred<ApiResult<ActionDescribeResult>>>>()
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async describe2 => {
      if (describe2.dialog === 'loginProperties') return { ok: true, value: { ...loginPropertiesDescribe(describe), elapsedMs: 1 } }
      const read = deferred<ApiResult<ActionDescribeResult>>()
      reads.set(describe2.target.name ?? '', read)
      return read.promise
    }),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async () => ({ ok: true, value: { text: '', database: 'master', warnings: [] } })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async cancelled => ({ ok: true, value: { cancelled: cancelled.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false })),
    confirmAction: vi.fn<VariaApi['confirmAction']>(async () => ({ ok: true, value: 'cancel' }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  // Varia's other connection to the same server, signed in as `other`.
  if (other) connections.add({ ...connectionInfo('server-b'), server: 'server-a.example', displayName: 'Prod', login: other }, connectionOptions)
  const explorer = {
    listingFolderOf: vi.fn(() => 5 as number | undefined), reconcile: vi.fn(),
    folderNode: vi.fn((_connection: string, owner: ObjectRef, folder: string) => folder === 'users' && owner.name === 'AppData' ? 9 : undefined)
  }
  let count = 0
  const notify = vi.fn()
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() }, newId: () => `id-${++count}`, notify })
  cleanups.push(() => dialogs.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const node: ExplorerMenuNode = { id: 7, connectionId: 'server-a', ref: { type: 'object', object: appLogin }, kind: 'login', subtype: 'sql', label: 'app_login', lost: false, engine: 'box' }
  const open = async () => { dialogs.open('loginProperties', node); await settle() }
  return { dialogs, api, explorer, execute, reads, settle, open, notify }
}

describe('Login Properties in the object dialog service', () => {
  it('opens on the login, and User Mapping\'s read of a database names the login, whose user and roles join the dialog', async () => {
    const { dialogs, api, reads, settle, open } = setup()
    await open()
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ dialog: 'loginProperties', target: appLogin })
    expect(dialogs.current).toMatchObject({ dialog: 'loginProperties', title: 'Login Properties - app_login', phase: 'ready', draft: { name: 'app_login', locked: true } })
    dialogs.loadDatabaseRoles('Sales')
    expect(api.describeObject.mock.calls[1][0]).toMatchObject({ dialog: loginDatabaseRolesDescribe, target: { kind: 'database', name: 'Sales' }, login: 'app_login' })
    reads.get('Sales')!.resolve({ ok: true, value: { elapsedMs: 1, loginDatabaseRoles: { roles: ['db_owner', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'legacy', owner: false }, memberOf: ['db_owner'] } } })
    await settle()
    const current = dialogs.current!
    expect((current.model as LoginPropertiesModel).properties.read).toContain('Sales')
    expect((current.draft as LoginPropertiesDraft).mappings.at(-1)).toEqual({ database: 'Sales', map: true, user: 'legacy', defaultSchema: '', roles: ['db_owner'], rolesKnown: true })
  })
  it('sends the new password only with OK, the old one only with Specify old password, and Script without either', async () => {
    const { dialogs, api, explorer, execute, open } = setup()
    await open()
    dialogs.setSecret('password', 'N3w!pass')
    dialogs.setSecret('confirm', 'N3w!pass')
    dialogs.setSecret('oldPassword', 'Old!pass')
    dialogs.updateDraft({ locked: false })
    await dialogs.script('clipboard')
    expect(api.scriptObjectAction.mock.calls[0][0]).not.toHaveProperty('secrets')
    expect(api.scriptObjectAction.mock.calls[0][0]).toMatchObject({ action: 'loginProperties', loginChanges: { password: { oldPassword: false, unlock: true, mustChange: false } } })
    const ok = dialogs.ok()
    const sent = api.executeObjectAction.mock.calls[0][0]
    expect(sent).toMatchObject({ action: 'loginProperties', target: appLogin, loginIdentity: identity, secrets: { password: 'N3w!pass' } })
    expect((sent as { secrets: object }).secrets).not.toHaveProperty('oldPassword')
    expect(executes({ ...sent, ...ids() })).toBe(true)
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Change the password' }], messages: [], elapsedMs: 1 } })
    await ok
    expect(dialogs.current).toBeUndefined()
    expect(explorer.reconcile).toHaveBeenCalledWith(5)
  })
  it('attaches the old password with Specify old password, and reloads Logins and each changed database\'s Users after a partial run', async () => {
    const { dialogs, api, explorer, execute, settle, open } = setup({ lock: { locked: false } })
    await open()
    dialogs.updateDraft({ specifyOld: true })
    dialogs.setSecret('password', 'N3w!pass')
    dialogs.setSecret('confirm', 'N3w!pass')
    dialogs.setSecret('oldPassword', 'Old!pass')
    const draft = dialogs.current!.draft as LoginPropertiesDraft
    dialogs.updateDraft(setMapped(draft, 'AppData', false))
    const ok = dialogs.ok()
    const sent = api.executeObjectAction.mock.calls[0][0]
    expect(sent).toMatchObject({ secrets: { password: 'N3w!pass', oldPassword: 'Old!pass' }, loginChanges: { password: { oldPassword: true, unlock: false, mustChange: false }, mappings: [{ database: 'AppData', change: 'unmap', user: 'app' }] } })
    expect(executes({ ...sent, ...ids() })).toBe(true)
    execute.resolve({ ok: true, value: {
      steps: [{ status: 'done', title: 'Change the password' }, { status: 'failed', title: 'Drop the user', message: 'denied' }], messages: [], elapsedMs: 1,
      error: { code: 'PERMISSION_DENIED', message: 'The login was changed only in part.', retryable: false }
    } })
    await ok
    await settle()
    expect(explorer.reconcile).toHaveBeenCalledWith(5)
    expect(explorer.reconcile).toHaveBeenCalledWith(9)
    // The pages read the login again, as it is now.
    expect(api.describeObject.mock.calls.filter(([call]) => call.dialog === 'loginProperties')).toHaveLength(2)
    // The password changed before the failure: the slot and the fields are emptied (finding 6), so a retry never sends it again.
    const current = dialogs.current!
    expect(dialogs.holdsSecrets).toBe(false)
    expect(current).toMatchObject({ phase: 'failed', secretState: { password: 'empty' }, secretEpoch: 1, draft: { specifyOld: false, locked: false } })
    expect(current.error?.message).toBe('The login was changed only in part. ' + loginPropertiesMessages.passwordApplied)
  })
  it('keeps the password for a retry when the password step did not complete', async () => {
    const { dialogs, execute, settle, open } = setup({ lock: { locked: false } })
    await open()
    dialogs.setSecret('password', 'N3w!pass')
    dialogs.setSecret('confirm', 'N3w!pass')
    dialogs.updateDraft({ defaultDatabase: 'AppData' })
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Set the login\'s options' }, { status: 'failed', title: loginPasswordStepTitle }], messages: [], elapsedMs: 1, error: { code: 'PASSWORD_POLICY', message: 'Too short.', retryable: true } } })
    await ok
    await settle()
    expect(dialogs.holdsSecrets).toBe(true)
    expect(dialogs.current).toMatchObject({ secretState: { password: 'set' } })
    expect(dialogs.current?.secretEpoch).toBeUndefined()
  })
  it('reads User Mapping\'s databases again after a partial run, and OK waits for them rather than dropping their changes (finding 5)', async () => {
    const { dialogs, api, execute, reads, settle, open } = setup()
    await open()
    dialogs.loadDatabaseRoles('AppData')
    reads.get('AppData')!.resolve({ ok: true, value: { elapsedMs: 1, loginDatabaseRoles: { roles: ['db_datareader', 'db_owner', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'app', defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader'] } } })
    await settle()
    const draft = dialogs.current!.draft as LoginPropertiesDraft
    dialogs.updateDraft({ ...setMappingRole(draft, 'AppData', 'db_owner', true), serverRoles: ['bulkadmin', 'dbcreator'] })
    const ok = dialogs.ok()
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ loginChanges: { rolesAdd: ['dbcreator'], mappings: [{ database: 'AppData', change: 'update', rolesAdd: ['db_owner'] }] } })
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Add to a server role' }, { status: 'failed', title: 'Add to a database role' }], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'Failed.', retryable: true } } })
    await ok
    await settle()
    // The reload read the login, then reads AppData and Owned again, one at a time.
    expect(dialogs.current!.databaseRoles?.get('AppData')).toEqual({ state: 'loading' })
    await dialogs.ok()
    expect(api.executeObjectAction).toHaveBeenCalledTimes(1)
    expect(dialogs.current!.error?.message).toBe(loginPropertiesMessages.readAgain('AppData'))
    reads.get('AppData')!.resolve({ ok: true, value: { elapsedMs: 1, loginDatabaseRoles: { roles: ['db_datareader', 'db_owner', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'app', defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader'] } } })
    await settle()
    expect(api.describeObject.mock.calls.at(-1)![0]).toMatchObject({ target: { kind: 'database', name: 'Owned' } })
    reads.get('Owned')!.resolve({ ok: true, value: { elapsedMs: 1, loginDatabaseRoles: { roles: ['public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'dbo', defaultSchema: 'dbo', owner: true }, memberOf: [] } } })
    await settle()
    api.executeObjectAction.mockImplementationOnce(async () => ({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } }))
    await dialogs.ok()
    // The server role was added by the first run (the fixture's describe still lists only bulkadmin), and db_owner is still sent.
    expect(api.executeObjectAction.mock.calls[1][0]).toMatchObject({ loginChanges: { mappings: [{ database: 'AppData', change: 'update', user: 'app', rolesAdd: ['db_owner'] }] } })
  })
  it('keeps a mapped row\'s roles when Map is cleared before its read lands and checked again (finding 4)', async () => {
    const { dialogs, api, reads, settle, open } = setup()
    await open()
    let draft = dialogs.current!.draft as LoginPropertiesDraft
    dialogs.updateDraft(setMapped(draft, 'AppData', false))
    dialogs.loadDatabaseRoles('AppData')
    reads.get('AppData')!.resolve({ ok: true, value: { elapsedMs: 1, loginDatabaseRoles: { roles: ['db_datareader', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo'], schemasTruncated: false, user: { name: 'app', defaultSchema: 'dbo', owner: false }, memberOf: ['db_datareader'] } } })
    await settle()
    draft = dialogs.current!.draft as LoginPropertiesDraft
    dialogs.updateDraft(setMapped(draft, 'AppData', true))
    // Nothing changed, so Script says so and sends nothing.
    await dialogs.script('clipboard')
    expect(api.scriptObjectAction).not.toHaveBeenCalled()
  })
  it('asks before Disabled when another Varia connection signs in as the login, and Cancel sends nothing (finding 18)', async () => {
    const { dialogs, api, execute, open } = setup({}, 'app_login')
    await open()
    dialogs.updateDraft({ enabled: false })
    await dialogs.ok()
    expect(api.confirmAction).toHaveBeenCalledWith({ prompt: 'disableLogin', facts: { login: 'app_login', sysadmin: false, connections: ['Prod (server-a.example)'] } })
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current).toMatchObject({ phase: 'ready' })
    api.confirmAction.mockResolvedValueOnce({ ok: true, value: 'disable' })
    const ok = dialogs.ok()
    await vi.waitFor(() => expect(api.executeObjectAction).toHaveBeenCalledTimes(1))
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ loginChanges: { enabled: false } })
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Disable the login' }], messages: [], elapsedMs: 1 } })
    await ok
  })
  it('says after a password change that Varia\'s connections signing in as the login use the new one (findings 7, 21)', async () => {
    const { dialogs, execute, open, notify } = setup({ lock: { locked: false } }, 'app_login')
    await open()
    dialogs.setSecret('password', 'N3w!pass')
    dialogs.setSecret('confirm', 'N3w!pass')
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: loginPasswordStepTitle }], messages: [], elapsedMs: 1 } })
    await ok
    expect(notify).toHaveBeenCalledWith(loginPropertiesMessages.connectionsPassword('app_login'))
    // Without such a connection, nothing to say.
    const quiet = setup({ lock: { locked: false } })
    await quiet.open()
    quiet.dialogs.setSecret('password', 'N3w!pass')
    quiet.dialogs.setSecret('confirm', 'N3w!pass')
    const done = quiet.dialogs.ok()
    quiet.execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: loginPasswordStepTitle }], messages: [], elapsedMs: 1 } })
    await done
    expect(quiet.notify).not.toHaveBeenCalled()
  })
})

describe('Login Properties pages', () => {
  const render = (Page: ComponentType<PageProps>, open: OpenObjectDialog) =>
    renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: { dialogs: { updateDraft: vi.fn(), setSecret: vi.fn(), loadDatabaseRoles: vi.fn() } } as unknown as Workbench, children: createElement(Page, { open, editable: true }) }))
  const opened = (of: LoginPropertiesModel, changes: Partial<OpenObjectDialog> = {}): OpenObjectDialog => ({
    id: 1, dialog: 'loginProperties', connectionId: 'c', nodeId: 1, target: appLogin, label: 'app_login', title: 'Login Properties - app_login', server: 's', page: 'general', phase: 'ready',
    model: of, draft: draftOf(of), secretState: { password: 'empty', matches: true, wellFormed: true, tooLong: false }, ...changes
  })
  it('says on every page why SQL Server\'s own logins never change, and greys their controls (finding 11)', () => {
    const system = model({ login: { subtype: 'system', principalId: 260 } })
    for (const Page of [NewLoginGeneralPage, NewLoginServerRolesPage, UserMappingPage, NewLoginStatusPage]) {
      const html = render(Page, opened(system)), plain = render(Page, opened(model()))
      expect(html, Page.name).toContain(loginMessages.system)
      expect(plain, Page.name).not.toContain(loginMessages.system)
      // User Mapping's grid greys its Map boxes; the other pages their fieldset.
      const greyed = Page === UserMappingPage ? /aria-label="Map AppData" disabled=""/ : /<fieldset[^>]*disabled=""/
      expect(html, Page.name).toMatch(greyed)
      expect(plain, Page.name).not.toMatch(greyed)
    }
  })
  it('greys Status\' refused choices with the reason, and lets Login is locked out be checked again (findings 10, 13)', () => {
    const own = render(NewLoginStatusPage, opened(model({ login: { own: true } })))
    expect(own).toMatch(/<input type="radio" disabled="" aria-describedby="login-status-note" name="new-login-connect"\/>Deny/)
    expect(own).toMatch(/<input type="radio" disabled="" aria-describedby="login-status-note" name="new-login-enabled"\/>Disabled/)
    expect(own).toContain(`<p class="field-note" id="login-status-note">${loginMessages.ownStatus}</p>`)
    const group = render(NewLoginStatusPage, opened(model({ login: { type: 'G', subtype: 'windowsGroup' }, lock: null })))
    expect(group).toMatch(/<input type="radio" disabled="" aria-describedby="login-status-note" name="new-login-enabled"\/>Disabled/)
    expect(group).not.toMatch(/disabled=""[^>]*name="new-login-connect"/)
    const plain = render(NewLoginStatusPage, opened(model()))
    expect(plain).not.toContain('login-status-note')
    // Cleared, it stays enabled, so it can be checked again.
    const cleared = render(NewLoginStatusPage, opened(model(), { draft: draftOf(model(), { locked: false }) }))
    expect(cleared).toMatch(/<input type="checkbox" aria-describedby="login-properties-unlock"\/>/)
  })
  it('names the hint the password field describes, and the kind only when the radios do not say it (findings 12, 15)', () => {
    const cleared = render(NewLoginGeneralPage, opened(model(), { draft: draftOf(model(), { locked: false }) }))
    expect(cleared).toContain(`<li id="login-properties-keep">`)
    expect(cleared).toMatch(new RegExp(`<li id="login-properties-keep">.*?<span>${loginPropertiesMessages.unlockNeedsPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`))
    expect(cleared).not.toContain('login-properties-kind')
    const group = render(NewLoginGeneralPage, opened(model({ login: { type: 'G', subtype: 'windowsGroup' }, lock: null })))
    expect(group).toContain('<p class="field-note" id="login-properties-kind">Windows group</p>')
    expect(group).toContain('<input id="new-login-name" type="text" readOnly="" aria-describedby="login-properties-kind" value="app_login"/>')
    expect(cleared).toContain('<input id="new-login-name" type="text" readOnly="" value="app_login"/>')
  })
  it('marks a database not read yet, and says why through its cell (finding 14)', () => {
    const html = render(UserMappingPage, opened(model(), { page: 'userMapping' }))
    expect(html).toContain(`<p id="user-mapping-unread" hidden="">${loginPropertiesMessages.notReadHint}</p>`)
    expect(html).toMatch(/aria-describedby="user-mapping-unread"[^>]*><span class="user-mapping-text" data-unread="true"><bdi>Not read<\/bdi>/)
    const css = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles.css'), 'utf8')
    expect(css).toContain('.user-mapping-text[data-unread] { color: var(--varia-descriptionForeground)')
    expect(css).toMatch(/@media \(forced-colors: active\) \{[^@]*\.user-mapping-text\[data-unread\] \{ color: GrayText; \}/)
    expect(css).toMatch(/\.new-login-page input\[readonly\] \{ background: transparent; border-color: var\(--varia-/)
  })
})

describe('Login Properties from Object Explorer', () => {
  it('opens Login Properties on a login\'s Properties, and a database\'s Properties as a document (finding 19)', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    const folder = (owner: ObjectRef, id: FolderId): ExplorerNode => ({ ref: { type: 'folder', owner, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
    const object = (value: ObjectRef, subtype?: string): ExplorerNode => ({ ref: { type: 'object', object: value }, label: value.name!, icon: kindSpecs[value.kind].icon, hasChildren: false, ...(subtype ? { subtype } : {}) } as ExplorerNode)
    fixture.api.explorerChildren.mockImplementation(async ({ node }) => {
      const nodes = node.type === 'object' ? node.object.kind === 'server' ? [folder(node.object, 'databases'), folder(node.object, 'serverSecurity')] : []
        : node.folder === 'databases' ? [object({ kind: 'database', name: 'AppData' })]
          : node.folder === 'serverSecurity' ? [folder(node.owner, 'logins')]
            : node.folder === 'logins' ? [object(appLogin, 'sql')] : []
      return { ok: true, value: { nodes, total: nodes.length, elapsedMs: 1 } }
    })
    fixture.connect(connectionInfo('c1'))
    const select = async (...labels: string[]) => {
      for (const [index, label] of labels.entries()) {
        let id: number | undefined
        await vi.waitFor(() => { id = fixture.explorer.getSnapshot().rows.nodes.find(item => item?.label === label)?.id; expect(id, label).toBeDefined() })
        if (index < labels.length - 1) { if (!fixture.explorer.getSnapshot().rows.nodes.find(item => item?.id === id)?.expanded) fixture.explorer.expand(id!) }
        else fixture.explorer.select(id!)
      }
      return fixture.explorer.menuNode(fixture.explorer.getSnapshot().selected)!
    }
    const dialog = vi.spyOn(fixture.dialogs, 'open').mockImplementation(() => {})
    const document = vi.spyOn(fixture.properties, 'open').mockImplementation(() => 'doc')
    const login = await select('c1.example', 'Security', 'Logins', 'app_login')
    expect(await fixture.commands.execute('explorer.properties', { target: { kind: 'explorer', node: login } }, 'menu')).toBe(true)
    expect(dialog).toHaveBeenCalledWith('loginProperties', login)
    expect(document).not.toHaveBeenCalled()
    const database = await select('c1.example', 'Databases', 'AppData')
    expect(await fixture.commands.execute('explorer.properties', { target: { kind: 'explorer', node: database } }, 'menu')).toBe(true)
    expect(document).toHaveBeenCalledWith(database)
    expect(dialog).toHaveBeenCalledTimes(1)
  })
})

describe('Login Properties words', () => {
  it('names Unlock\'s choices and hand-off as the docs and smoke tests do, and shares its advice with the backend', () => {
    expect(unlockChoices).toEqual(['setPassword', 'keepPassword'])
    expect(unlockChoiceText).toEqual({ setPassword: 'Set a new password…', keepPassword: 'Keep the current password' })
    expect(unlockHandOffLabel).toBe('Continue in Login Properties…')
    const jobs = readFileSync(join(import.meta.dirname, '../backend/Varia.Backend/Actions/LoginPropertiesJobs.cs'), 'utf8')
    expect(jobs).toContain(`LoginOldPasswordAdvice = "${loginPropertiesMessages.oldPasswordAdvice}"`)
    // A reply whose password step is done changed the password (spentSecrets reads it by this title).
    expect(jobs).toContain(`LoginPasswordStep = "${loginPasswordStepTitle}"`)
    expect(loginPropertiesDefinition.spentSecrets?.(model(), draftOf(model()), [{ status: 'done', title: loginPasswordStepTitle } as ActionStep])?.note).toBe(loginPropertiesMessages.passwordApplied)
    // Script's warning per dropped user, bracketed as the backend's ActionSql.Quote does.
    expect(loginPropertiesMessages.dropsUser('a]b', 'Sales')).toBe('Drops the user [a]]b] in [Sales].')
    expect(jobs).toContain('"Drops the user " + ActionSql.Quote(')
  })
})
