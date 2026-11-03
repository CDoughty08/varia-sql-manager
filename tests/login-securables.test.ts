// The Securables page (D2d): its catalogue (src/shared/actions/securables.ts), the permission statements in main's schemas, the draft
// helpers and what OK sends (src/renderer/src/dialogs/securables.ts), the Effective tab's read through the object dialog service, and
// the page as it renders on New Login and Login Properties.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionLimits, dialogSpecs } from '../src/shared/actions/catalog'
import { loginLimits, loginsCatalog, newLoginStatements, tooManyStatementsMessage, type NewLoginModel } from '../src/shared/actions/logins'
import { actionDescribeSchema, actionExecuteRequestSchema, actionScriptRequestSchema, type ActionDescribeResult } from '../src/shared/actions/schema'
import {
  explicitStates, loginEffectiveDescribe, objectTypeOrder, permissionChange, permissionChecked, permissionStates, reservedPermission, securablesCatalog, securableSpecs, securablesMessages,
  securableTypes, toggledPermission, type ExplicitPermission, type PermissionState
} from '../src/shared/actions/securables'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { loginPropertiesDefinition } from '../src/renderer/src/dialogs/definitions'
import { initialLoginPropertiesDraft, loginPropertiesChanges, loginPropertiesModelOf, loginPropertiesProblem, loginPropertiesRequest, type LoginPropertiesDraft, type LoginPropertiesModel } from '../src/renderer/src/dialogs/login-properties'
import { initialNewLoginDraft, newLoginRequest, type NewLoginDraft, type SecretState } from '../src/renderer/src/dialogs/new-login'
import { shownPages, type PageProps } from '../src/renderer/src/dialogs/ObjectDialog'
import { ObjectDialogService, type OpenObjectDialog } from '../src/renderer/src/dialogs/ObjectDialogService'
import SecurablesPage, { EffectiveList } from '../src/renderer/src/dialogs/pages/SecurablesPage'
import {
  addSecurables, initialSecurables, objectsOfTypes, permissionChoices, permissionStateOf, removeSecurable, securablesFull, serverRef, setPermission
} from '../src/renderer/src/dialogs/securables'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { loginPropertiesDescribe, propertiesNewLogin } from './fixtures/login-properties'
import { securablesModel } from './fixtures/securables'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const server: ObjectRef = { kind: 'server' }
const appLogin: ObjectRef = { kind: 'login', name: 'app_login' }
const ids = () => ({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() })
const set: SecretState = { password: 'set', matches: true, wellFormed: true, tooLong: false }
const newModel = (): NewLoginModel => propertiesNewLogin()
const newDraft = (changes: Partial<NewLoginDraft> = {}): NewLoginDraft => ({ ...initialNewLoginDraft(newModel()), auth: 'sql', name: 'app', ...changes })
const explicit = (rows: readonly ExplicitPermission[]): LoginPropertiesModel => {
  const describe = loginPropertiesDescribe({ properties: { permissions: rows } })
  return loginPropertiesModelOf(describe)!
}
const draftOf = (of: LoginPropertiesModel, changes: Partial<LoginPropertiesDraft> = {}): LoginPropertiesDraft => ({ ...initialLoginPropertiesDraft(of, appLogin), ...changes })
const create = (changes: Record<string, unknown> = {}) => ({
  action: 'createLogin', ...ids(), target: server, login: { auth: 'sql', name: 'app', defaultDatabase: 'master', checkPolicy: true, checkExpiration: true, mustChange: true },
  serverRoles: [], mappings: [], status: { connect: 'grant', enabled: true }, secrets: { password: 'Throwaway!1' }, ...changes
})
const change = (permissions: unknown) => ({ action: 'loginProperties', ...ids(), target: appLogin, loginIdentity: { sid: '0A1B', created: '2026-01-02T03:04:05.000' }, loginChanges: { permissions } })
const executes = (value: unknown) => actionExecuteRequestSchema.safeParse(value).success
const viewServerState: ExplicitPermission = { securable: { type: 'server' }, permission: 'VIEW SERVER STATE', state: 'grant', grantor: 'sa' }
const impersonate: ExplicitPermission = { securable: { type: 'login', name: 'sa' }, permission: 'IMPERSONATE', state: 'withGrant', grantor: 'sa' }

describe('Securables catalogue', () => {
  it('lists each class\'s permissions once, alphabetically, as keywords only, with CONNECT SQL left to the Status page', () => {
    for (const type of securableTypes) {
      const { permissions, on } = securableSpecs[type]
      expect([...permissions].sort(), type).toEqual(permissions)
      expect(new Set(permissions).size, type).toBe(permissions.length)
      for (const permission of permissions) expect(permission, type).toMatch(/^[A-Z]+(?: [A-Z]+)*$/)
      expect(on === undefined, type).toBe(type === 'server')
      if (on) expect(on).toMatch(/^ ON [A-Z]+(?: [A-Z]+)*::$/)
    }
    expect([...objectTypeOrder].sort()).toEqual([...securableTypes].sort())
    expect(securableTypes.flatMap(type => securableSpecs[type].permissions.filter(permission => reservedPermission(type, permission)).map(permission => `${type}:${permission}`))).toEqual(['server:CONNECT SQL'])
    // What C# reads (actions-catalog.json): every type with its class, ON clause and permissions, and the Effective tab's words.
    expect(loginsCatalog().securables).toEqual(securablesCatalog())
    expect(securablesCatalog()).toMatchObject({ effectiveDescribe: loginEffectiveDescribe, effectiveDenied: securablesMessages.effectiveDenied, reserved: [{ type: 'server', permission: 'CONNECT SQL' }] })
    expect(securablesCatalog().types.map(type => type.type)).toEqual([...securableTypes])
  })
  it('turns a box change into SMO\'s statement: GRANT, WITH GRANT OPTION, DENY, REVOKE, and REVOKE GRANT OPTION FOR, cascading from a grant option', () => {
    const states: (PermissionState | undefined)[] = [undefined, ...permissionStates]
    const table = states.flatMap(before => states.map(after => [before ?? 'none', after ?? 'none', permissionChange(before, after)]))
    expect(table).toEqual([
      ['none', 'none', undefined], ['none', 'grant', { state: 'grant' }], ['none', 'withGrant', { state: 'withGrant' }], ['none', 'deny', { state: 'deny' }],
      ['grant', 'none', { state: 'revoke' }], ['grant', 'grant', undefined], ['grant', 'withGrant', { state: 'withGrant' }], ['grant', 'deny', { state: 'deny' }],
      ['withGrant', 'none', { state: 'revoke', cascade: true }], ['withGrant', 'grant', { state: 'revokeGrantOption' }], ['withGrant', 'withGrant', undefined], ['withGrant', 'deny', { state: 'deny', cascade: true }],
      ['deny', 'none', { state: 'revoke' }], ['deny', 'grant', { state: 'grant' }], ['deny', 'withGrant', { state: 'withGrant' }], ['deny', 'deny', undefined]
    ])
  })
  it('ties the boxes as SSMS does: Grant and Deny exclude each other, With Grant implies Grant, and clearing Grant clears With Grant', () => {
    expect(toggledPermission(undefined, 'grant', true)).toBe('grant')
    expect(toggledPermission(undefined, 'withGrant', true)).toBe('withGrant')
    expect(toggledPermission('deny', 'grant', true)).toBe('grant')
    expect(toggledPermission('grant', 'deny', true)).toBe('deny')
    expect(toggledPermission('withGrant', 'withGrant', false)).toBe('grant')
    expect(toggledPermission('withGrant', 'grant', false)).toBeUndefined()
    expect(toggledPermission('withGrant', 'grant', true)).toBe('withGrant')
    expect(toggledPermission('deny', 'deny', false)).toBeUndefined()
    expect(toggledPermission('grant', 'deny', false)).toBe('grant')
    expect(['grant', 'withGrant', 'deny'].map(column => permissionChecked('withGrant', column as 'grant'))).toEqual([true, true, false])
    expect(['grant', 'withGrant', 'deny'].map(column => permissionChecked('deny', column as 'grant'))).toEqual([false, false, true])
  })
  it('shows a deny over any grant and a grant option over a plain grant, as sys.server_permissions keeps a row per grantor', () => {
    const states = explicitStates([viewServerState, { ...viewServerState, state: 'withGrant', grantor: 'admin' }, impersonate, { ...impersonate, state: 'deny', grantor: 'other' }])
    expect(states.get('server:')?.get('VIEW SERVER STATE')).toEqual({ state: 'withGrant', grantor: 'admin' })
    expect(states.get('login:sa')?.get('IMPERSONATE')).toEqual({ state: 'deny', grantor: 'other' })
  })
})

describe('Securables in the request schemas', () => {
  it('reads one securable as the login only through the Effective tab\'s describe', () => {
    const effective = (changes: Record<string, unknown>) => actionDescribeSchema.safeParse({ ...ids(), dialog: loginEffectiveDescribe, target: appLogin, ...changes }).success
    expect(effective({ securable: { type: 'server' } })).toBe(true)
    expect(effective({ securable: { type: 'endpoint', name: 'TSQL Default TCP' } })).toBe(true)
    expect(effective({})).toBe(false)
    expect(effective({ securable: { type: 'server', name: 'x' } })).toBe(false)
    expect(effective({ securable: { type: 'login' } })).toBe(false)
    expect(effective({ securable: { type: 'database', name: 'x' } })).toBe(false)
    expect(effective({ securable: { type: 'login', name: 'x'.repeat(129) } })).toBe(false)
    expect(effective({ securable: { type: 'login', name: 'x', extra: 1 } })).toBe(false)
    expect(effective({ target: server, securable: { type: 'server' } })).toBe(false)
    // SQL Server's own logins have no Securables page, so nothing reads their effective permissions.
    expect(effective({ target: { kind: 'login', name: '##MS_PolicyTsqlExecutionLogin##' }, securable: { type: 'server' } })).toBe(false)
    expect(actionDescribeSchema.safeParse({ ...ids(), dialog: 'loginProperties', target: appLogin, securable: { type: 'server' } }).success).toBe(false)
  })
  it('takes New Login\'s grants and denies of catalogue permissions, never a revoke, CASCADE, CONNECT SQL, free text or one twice', () => {
    const grant = { securable: { type: 'server' }, permission: 'VIEW SERVER STATE', state: 'grant' }
    expect(executes(create({ permissions: [grant, { securable: { type: 'login', name: 'sa' }, permission: 'IMPERSONATE', state: 'withGrant' }, { securable: { type: 'endpoint', name: 'TSQL Default TCP' }, permission: 'CONNECT', state: 'deny' }] }))).toBe(true)
    const { secrets: _secrets, ...scripted } = create({ permissions: [grant] })
    expect(actionScriptRequestSchema.safeParse(scripted).success).toBe(true)
    expect(executes(create({ permissions: [{ ...grant, state: 'revoke' }] }))).toBe(false)
    expect(executes(create({ permissions: [{ ...grant, state: 'deny', cascade: true }] }))).toBe(false)
    expect(executes(create({ permissions: [{ ...grant, permission: 'CONNECT SQL' }] }))).toBe(false)
    expect(executes(create({ permissions: [{ ...grant, permission: 'VIEW SERVER STATE; DROP LOGIN sa' }] }))).toBe(false)
    expect(executes(create({ permissions: [{ ...grant, permission: 'IMPERSONATE' }] }))).toBe(false)
    expect(executes(create({ permissions: [grant, { ...grant, state: 'deny' }] }))).toBe(false)
    expect(executes(create({ permissions: Array.from({ length: loginLimits.permissions + 1 }, () => grant) }))).toBe(false)
  })
  it('takes Login Properties\' REVOKE and REVOKE GRANT OPTION FOR, with CASCADE only on DENY and REVOKE', () => {
    const on = { securable: { type: 'login', name: 'sa' }, permission: 'IMPERSONATE' }
    expect(executes(change([{ ...on, state: 'revoke', cascade: true }, { securable: { type: 'server' }, permission: 'SHUTDOWN', state: 'revokeGrantOption' }]))).toBe(true)
    expect(executes(change([{ ...on, state: 'deny', cascade: true }]))).toBe(true)
    expect(executes(change([{ ...on, state: 'grant', cascade: true }]))).toBe(false)
    expect(executes(change([{ ...on, state: 'revoke', cascade: false }]))).toBe(false)
    expect(executes(change([{ ...on, state: 'revoke' }, { ...on, state: 'grant' }]))).toBe(false)
    expect(executes(change([{ securable: { type: 'serverRole', name: 'auditors' }, permission: 'IMPERSONATE', state: 'grant' }]))).toBe(false)
  })
})

describe('Securables draft and request', () => {
  it('starts Login Properties with each securable the login has a permission on, the server first, and New Login with none', () => {
    expect(initialSecurables([impersonate, viewServerState, { ...viewServerState, permission: 'SHUTDOWN' }, { ...impersonate, securable: { type: 'endpoint', name: 'E' } }])).toEqual({
      securables: [{ type: 'server' }, { type: 'endpoint', name: 'E' }, { type: 'login', name: 'sa' }], securable: 'server:', permissions: []
    })
    expect(draftOf(explicit([]))).toMatchObject({ securables: [], permissions: [] })
    expect(draftOf(explicit([]))).not.toHaveProperty('securable')
    expect(initialNewLoginDraft(newModel())).toMatchObject({ securables: [], permissions: [] })
  })
  it('adds objects once each, selects the first new one, keeps the limit, and removes a row with its changes only', () => {
    const model = newModel(), draft = newDraft()
    const added = { ...draft, ...addSecurables(draft, [serverRef, { type: 'login', name: 'sa' }, serverRef]) }
    expect(added).toMatchObject({ securables: [{ type: 'server' }, { type: 'login', name: 'sa' }], securable: 'server:' })
    expect(addSecurables(added, objectsOfTypes(model, ['login', 'server']))).toEqual({ securables: [{ type: 'server' }, { type: 'login', name: 'sa' }, { type: 'login', name: 'app' }], securable: 'server:' })
    expect(objectsOfTypes(model, ['endpoint'])).toEqual([{ type: 'endpoint', name: 'Dedicated Admin Connection' }, { type: 'endpoint', name: 'TSQL Default TCP' }])
    const many = Array.from({ length: loginLimits.securableObjects + 1 }, (_, index) => ({ type: 'login' as const, name: `l${index}` }))
    expect(securablesFull(draft, many)).toBe(true)
    expect(securablesFull(draft, many.slice(1))).toBe(false)
    expect(addSecurables(draft, many).securables).toHaveLength(loginLimits.securableObjects)
    const changed = { ...added, ...setPermission(model, added, { type: 'login', name: 'sa' }, 'IMPERSONATE', 'grant') }
    expect(changed.permissions).toHaveLength(1)
    const both = { ...changed, ...setPermission(model, changed, serverRef, 'SHUTDOWN', 'deny') }
    expect(both.permissions).toHaveLength(2)
    expect(removeSecurable(both, 'login:sa')).toEqual({ securables: [{ type: 'server' }], securable: 'server:', permissions: [{ securable: serverRef, permission: 'SHUTDOWN', state: 'deny' }] })
    expect(removeSecurable({ ...both, securables: [serverRef] }, 'server:')).toEqual({ securables: [], securable: undefined, permissions: [{ securable: { type: 'login', name: 'sa' }, permission: 'IMPERSONATE', state: 'grant' }] })
  })
  it('sends New Login\'s changed boxes in the grid\'s order, only when there are some, and counts them toward the statement limit', () => {
    const model = newModel()
    let draft = newDraft()
    expect(newLoginRequest(server, model, draft, set)).not.toHaveProperty('permissions')
    draft = { ...draft, ...addSecurables(draft, [{ type: 'login', name: 'sa' }, serverRef]) }
    draft = { ...draft, ...setPermission(model, draft, serverRef, 'VIEW SERVER STATE', 'withGrant') }
    draft = { ...draft, ...setPermission(model, draft, { type: 'login', name: 'sa' }, 'IMPERSONATE', 'deny') }
    // A box checked and cleared again sends nothing; CONNECT SQL is the Status page's.
    draft = { ...draft, ...setPermission(model, draft, serverRef, 'SHUTDOWN', 'grant') }
    draft = { ...draft, ...setPermission(model, draft, serverRef, 'SHUTDOWN', undefined) }
    draft = { ...draft, permissions: [...draft.permissions, { securable: serverRef, permission: 'CONNECT SQL', state: 'deny' }] }
    const request = newLoginRequest(server, model, draft, set)
    expect(request).toMatchObject({ permissions: [{ securable: { type: 'login', name: 'sa' }, permission: 'IMPERSONATE', state: 'deny' }, { securable: { type: 'server' }, permission: 'VIEW SERVER STATE', state: 'withGrant' }] })
    expect(actionScriptRequestSchema.safeParse({ ...request, ...ids() }).success).toBe(true)
    // A permission the server does not list is never sent, even when the draft holds one.
    expect(permissionChoices({ ...model, securables: securablesModel({ permissions: { ...securablesModel().permissions, server: ['SHUTDOWN'] } }) }, draft)).toEqual([
      { securable: { type: 'login', name: 'sa' }, permission: 'IMPERSONATE', state: 'deny' }
    ])
    expect(newLoginStatements({ serverRoles: [], status: { connect: 'grant', enabled: true }, mappings: [], permissions: [1, 2, 3] })).toBe(4)
    const all = Array.from({ length: loginLimits.permissions + 1 }, (_, index) => ({ type: 'login' as const, name: `l${index}` }))
    const full = { ...newDraft(), securables: all, permissions: all.map(ref => ({ securable: ref, permission: 'ALTER', state: 'grant' as const })) }
    expect(newLoginRequest(server, model, full, set)).toEqual({ problem: securablesMessages.permissionsLimit(loginLimits.permissions) })
    const many = all.slice(0, loginLimits.permissions)
    expect(newLoginRequest(server, model, { ...full, securables: many, permissions: full.permissions.slice(0, loginLimits.permissions) }, set)).toEqual({ problem: tooManyStatementsMessage(actionLimits.statements) })
  })
  it('sends Login Properties\' changes against what the describe read: REVOKE GRANT OPTION FOR, CASCADE after a grant option, nothing when unchanged', () => {
    const model = explicit([viewServerState, impersonate])
    let draft = draftOf(model)
    expect(draft.securables).toEqual([{ type: 'server' }, { type: 'login', name: 'sa' }])
    expect(permissionStateOf(model, draft, impersonate.securable, 'IMPERSONATE')).toBe('withGrant')
    expect(loginPropertiesRequest(appLogin, model, draft)).toBeUndefined()
    // Clearing With Grant alone, then setting it back, leaves nothing to send.
    draft = { ...draft, ...setPermission(model, draft, impersonate.securable, 'IMPERSONATE', 'grant') }
    expect(loginPropertiesChanges(model, draft).permissions).toEqual([{ securable: impersonate.securable, permission: 'IMPERSONATE', state: 'revokeGrantOption' }])
    expect({ ...draft, ...setPermission(model, draft, impersonate.securable, 'IMPERSONATE', 'withGrant') }.permissions).toEqual([])
    draft = { ...draft, ...setPermission(model, draft, impersonate.securable, 'IMPERSONATE', 'deny') }
    draft = { ...draft, ...setPermission(model, draft, serverRef, 'VIEW SERVER STATE', undefined) }
    const request = loginPropertiesRequest(appLogin, model, draft)
    expect(request).toMatchObject({ loginChanges: { permissions: [
      { securable: { type: 'server' }, permission: 'VIEW SERVER STATE', state: 'revoke' }, { securable: impersonate.securable, permission: 'IMPERSONATE', state: 'deny', cascade: true }
    ] } })
    expect(executes({ ...request, ...ids() })).toBe(true)
    // Remove drops the row and its changes, not the permission: nothing is revoked.
    expect(loginPropertiesChanges(model, { ...draft, ...removeSecurable(draft, 'login:sa') }).permissions).toEqual([{ securable: { type: 'server' }, permission: 'VIEW SERVER STATE', state: 'revoke' }])
    const crowded = { ...draft, securables: Array.from({ length: loginLimits.permissions + 1 }, (_, index) => ({ type: 'login' as const, name: `l${index}` })) }
    const loud = { ...crowded, permissions: crowded.securables.map(ref => ({ securable: ref, permission: 'ALTER', state: 'grant' as const })) }
    expect(loginPropertiesProblem(model, loud)).toBe(securablesMessages.permissionsLimit(loginLimits.permissions))
  })
  it('hides Securables for SQL Server\'s own logins, as SSMS does', () => {
    const system = loginPropertiesModelOf(loginPropertiesDescribe({ login: { subtype: 'system', principalId: 260 } }))!
    expect(loginPropertiesDefinition.hiddenPages?.(system)).toEqual(['securables'])
    expect(loginPropertiesDefinition.hiddenPages?.(explicit([]))).toEqual([])
    expect(shownPages(dialogSpecs.loginProperties.pages, ['securables']).map(page => page.title)).toEqual(['General', 'Server Roles', 'User Mapping', 'Status'])
    expect(dialogSpecs.newLogin.pages.map(page => page.title)).toEqual(['General', 'Server Roles', 'User Mapping', 'Securables', 'Status'])
  })
})

function setup(describe: Parameters<typeof loginPropertiesDescribe>[0] = {}) {
  const reads: ReturnType<typeof deferred<ApiResult<ActionDescribeResult>>>[] = []
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async request => {
      if (request.dialog === 'loginProperties') return { ok: true, value: { ...loginPropertiesDescribe(describe), elapsedMs: 1 } }
      const read = deferred<ApiResult<ActionDescribeResult>>()
      reads.push(read)
      return read.promise
    }),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async () => ({ ok: true, value: { text: '', database: 'master', warnings: [] } })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(async () => ({ ok: true, value: {
      steps: [{ status: 'done', title: 'Grant a permission', detail: 'SHUTDOWN' }, { status: 'failed', title: 'Deny a permission', message: 'denied' }], messages: [], elapsedMs: 1,
      error: { code: 'PERMISSION_DENIED', message: 'The login was changed only in part.', retryable: false }
    } })),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async cancelled => ({ ok: true, value: { cancelled: cancelled.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false })),
    confirmAction: vi.fn<VariaApi['confirmAction']>(async () => ({ ok: true, value: 'cancel' }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  let count = 0
  const dialogs = new ObjectDialogService({ api, connections, explorer: { listingFolderOf: vi.fn(() => 5 as number | undefined), reconcile: vi.fn() }, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() }, newId: () => `id-${++count}` })
  cleanups.push(() => dialogs.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const node = (kind: 'login' | 'folder'): ExplorerMenuNode => kind === 'login'
    ? { id: 7, connectionId: 'server-a', ref: { type: 'object', object: appLogin }, kind: 'login', subtype: 'sql', label: 'app_login', lost: false, engine: 'box' }
    : { id: 5, connectionId: 'server-a', ref: { type: 'folder', owner: server, folder: 'logins' }, kind: 'folder', folder: 'logins', label: 'Logins', lost: false, engine: 'box' }
  return { dialogs, api, reads, settle, node }
}
const effectiveCalls = (api: ReturnType<typeof setup>['api']) => api.describeObject.mock.calls.filter(([call]) => call.dialog === loginEffectiveDescribe).map(([call]) => call)

describe('The Effective tab in the object dialog service', () => {
  it('reads a securable as the login once, again after a failure, and cancels a read for another securable', async () => {
    const { dialogs, api, reads, settle, node } = setup()
    dialogs.open('loginProperties', node('login'))
    await settle()
    dialogs.loadEffective({ type: 'server' })
    expect(effectiveCalls(api)).toEqual([expect.objectContaining({ dialog: loginEffectiveDescribe, target: appLogin, securable: { type: 'server' } })])
    expect(actionDescribeSchema.safeParse({ ...effectiveCalls(api)[0], ...ids() }).success).toBe(true)
    expect(dialogs.current?.effective?.get('server:')).toEqual({ state: 'loading' })
    // Moving on cancels the first read, which is forgotten.
    dialogs.loadEffective({ type: 'login', name: 'sa' })
    expect(api.cancelObjectActions).toHaveBeenCalledWith(['id-2'])
    expect(dialogs.current?.effective?.has('server:')).toBe(false)
    reads[0].resolve({ ok: true, value: { elapsedMs: 1, effectivePermissions: { permissions: ['CONNECT SQL'], truncated: false } } })
    reads[1].resolve({ ok: true, value: { elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: securablesMessages.effectiveDenied, retryable: false } } })
    await settle()
    expect(dialogs.current?.effective?.get('login:sa')).toEqual({ state: 'failed', error: { code: 'PERMISSION_DENIED', message: securablesMessages.effectiveDenied, retryable: false } })
    expect(dialogs.current?.effective?.has('server:')).toBe(false)
    dialogs.loadEffective({ type: 'login', name: 'sa' })
    reads[2].resolve({ ok: true, value: { elapsedMs: 1, effectivePermissions: { permissions: ['IMPERSONATE'], truncated: false } } })
    await settle()
    expect(dialogs.current?.effective?.get('login:sa')).toEqual({ state: 'ready', value: { permissions: ['IMPERSONATE'], truncated: false } })
    dialogs.loadEffective({ type: 'login', name: 'sa' })
    expect(effectiveCalls(api)).toHaveLength(3)
  })
  it('forgets what it read once a partial run changed the login, and never reads for New Login', async () => {
    const { dialogs, api, reads, settle, node } = setup()
    dialogs.open('loginProperties', node('login'))
    await settle()
    dialogs.loadEffective({ type: 'server' })
    reads[0].resolve({ ok: true, value: { elapsedMs: 1, effectivePermissions: { permissions: ['CONNECT SQL'], truncated: false } } })
    await settle()
    const model = dialogs.current!.model as LoginPropertiesModel, draft = dialogs.current!.draft as LoginPropertiesDraft
    dialogs.updateDraft({ ...addSecurables(draft, [serverRef]) })
    dialogs.updateDraft(setPermission(model, dialogs.current!.draft as LoginPropertiesDraft, serverRef, 'SHUTDOWN', 'grant'))
    await dialogs.ok()
    await settle()
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ loginChanges: { permissions: [{ securable: { type: 'server' }, permission: 'SHUTDOWN', state: 'grant' }] } })
    expect(dialogs.current).toMatchObject({ phase: 'failed' })
    expect(dialogs.current?.effective).toBeUndefined()
    dialogs.close()
    dialogs.open('newLogin', node('folder'))
    await settle()
    dialogs.loadEffective({ type: 'server' })
    expect(effectiveCalls(api)).toHaveLength(1)
  })
})

describe('Securables page', () => {
  const render = (open: OpenObjectDialog) => renderToStaticMarkup(createElement(WorkbenchProvider, {
    workbench: { dialogs: { updateDraft: vi.fn(), loadEffective: vi.fn() } } as unknown as Workbench, children: createElement(SecurablesPage, { open, editable: true } satisfies PageProps)
  }))
  const opened = (dialog: 'newLogin' | 'loginProperties', model: NewLoginModel, draft: NewLoginDraft, changes: Partial<OpenObjectDialog> = {}): OpenObjectDialog => ({
    id: 1, dialog, connectionId: 'c', nodeId: 1, target: dialog === 'newLogin' ? server : appLogin, label: 'x', title: 'x', server: 's', page: 'securables', phase: 'ready', model, draft, ...changes
  })
  it('lists the securables, then the selected one\'s explicit permissions with their grantor and boxes, CONNECT SQL greyed', () => {
    const model = explicit([viewServerState, impersonate]), html = render(opened('loginProperties', model, draftOf(model)))
    expect(html).toContain('Securables:')
    expect(html).toMatch(/role="columnheader">Name<.*role="columnheader">Type</)
    expect(html).toContain('DEV-SQL')
    expect(html).toContain('>Server<')
    expect(html).toMatch(/Permissions for <bdi>DEV-SQL<\/bdi>:/)
    expect(html).toMatch(/role="columnheader">Permission<.*role="columnheader">Grantor<.*>Grant<.*>With Grant<.*>Deny</)
    expect(html).toMatch(/aria-label="Grant VIEW SERVER STATE" checked=""/)
    expect(html).toMatch(/aria-label="Grant CONNECT SQL" disabled="" checked=""/)
    expect(html).toMatch(/role="tab"[^>]*>Explicit</)
    expect(html).not.toMatch(/role="tab"[^>]*disabled=""[^>]*>Effective</)
  })
  it('greys the Effective tab on New Login and says how to start', () => {
    const model = newModel(), html = render(opened('newLogin', model, newDraft()))
    expect(html).toMatch(/role="tab"[^>]*disabled=""[^>]*>Effective</)
    expect(html).toContain(securablesMessages.noSecurable.replace('…', '…'))
    expect(html).toMatch(/<button type="button">Search…<\/button>/)
  })
  it('shows the Effective tab\'s answer, its failure with Retry, and a truncation', () => {
    const model = explicit([viewServerState]), draft = draftOf(model)
    const note = render(opened('loginProperties', model, draft, { model: { ...model, properties: { ...model.properties, permissionsTruncated: true } } as LoginPropertiesModel }))
    expect(note).toContain(securablesMessages.explicitTruncated(loginLimits.explicitPermissions))
    const list = (lookup: Parameters<typeof EffectiveList>[0]['lookup']) => renderToStaticMarkup(createElement(EffectiveList, { lookup, onRetry: vi.fn() }))
    expect(list({ state: 'loading' })).toContain(securablesMessages.effectiveLoading)
    expect(list({ state: 'ready', value: { permissions: ['CONNECT SQL', 'VIEW ANY DATABASE'], truncated: true } })).toContain(`aria-label="Effective permissions"><li>CONNECT SQL</li><li>VIEW ANY DATABASE</li></ul>`)
    expect(list({ state: 'ready', value: { permissions: ['CONNECT SQL'], truncated: true } })).toContain(securablesMessages.effectiveTruncated(loginLimits.effectivePermissions))
    expect(list({ state: 'ready', value: { permissions: [], truncated: false } })).toContain(securablesMessages.effectiveNone)
    expect(list({ state: 'failed', error: { code: 'PERMISSION_DENIED', message: securablesMessages.effectiveDenied, retryable: false } })).toContain(`role="alert"><span>You don&#x27;t have permission to view effective permissions.</span><button type="button">Retry</button>`)
  })
})
