// New Login's User Mapping (D2b): the createLogin request's mappings and the loginDatabaseRoles describe in main's schemas, the
// draft helpers and the request they build (src/renderer/src/dialogs/new-login.ts), the object dialog service's lazy read of a
// database's roles, the Users folders reloaded after OK, and the grid's helpers.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionLimits } from '../src/shared/actions/catalog'
import { loginDatabaseRolesDescribe, loginLimits, newLoginStatements, tooManyStatementsMessage, userMappingMessages, type LoginDatabaseRoles, type NewLoginModel } from '../src/shared/actions/logins'
import { actionDescribeSchema, actionExecuteRequestSchema, actionScriptRequestSchema, type ActionDescribeResult, type ActionExecuteResult, type CreateLoginRequest } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { newLoginDefinition } from '../src/renderer/src/dialogs/definitions'
import { initialNewLoginDraft, mappable, mappingOf, newLoginRequest, renameLogin, setMapped, setMappingRole, setMappingSchema, setMappingUser, userMappings, type NewLoginDraft, type SecretState } from '../src/renderer/src/dialogs/new-login'
import { ObjectDialogService } from '../src/renderer/src/dialogs/ObjectDialogService'
import { mappingRange, unavailableChip, userMappingRowHeight } from '../src/renderer/src/dialogs/pages/UserMappingPage'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const server: ObjectRef = { kind: 'server' }
const ids = () => ({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() })
const model = (): NewLoginModel => ({
  server: { level: 17, linux: false, windowsOnly: false, canCreate: true },
  databases: [
    { name: 'AppData', state: 0, accessible: true, readOnly: false }, { name: 'Closed', state: 0, accessible: false, readOnly: false }, { name: 'master', state: 0, accessible: true, readOnly: false },
    { name: 'Old', state: 6, accessible: false, readOnly: false }, { name: 'Sales', state: 0, accessible: true, readOnly: false }, { name: 'Shelf', state: 0, accessible: true, readOnly: true }
  ],
  databasesTruncated: false, languages: [], serverRoles: [{ name: 'public', fixed: true }], serverRolesTruncated: false
})
const draft = (changes: Partial<NewLoginDraft> = {}): NewLoginDraft => ({ ...initialNewLoginDraft(model()), auth: 'sql', name: 'app', ...changes })
const set: SecretState = { password: 'set', matches: true, wellFormed: true, tooLong: false }
const login = { auth: 'sql', name: 'app', defaultDatabase: 'master', checkPolicy: true, checkExpiration: true, mustChange: true } as const
const create = (changes: Record<string, unknown> = {}) => ({ action: 'createLogin', ...ids(), target: server, login, serverRoles: [], mappings: [], status: { connect: 'grant', enabled: true }, ...changes })
const valid = (value: unknown) => actionScriptRequestSchema.safeParse(value).success
const roles = (count: number) => Array.from({ length: count }, (_, index) => `r${index}`)

describe('User Mapping in the request schemas', () => {
  it('accepts hostile names verbatim, SQL Server\'s own databases, a default schema and roles, on Script and OK alike', () => {
    const mappings = [{ database: "Ap]p'; DROP DATABASE x; --", user: 'u]\nGO', defaultSchema: "s'", rolesAdd: ['db_data]reader', 'Db_Data]Reader'] }, { database: 'master', user: 'app', rolesAdd: [] }]
    expect(valid(create({ mappings }))).toBe(true)
    expect(actionExecuteRequestSchema.safeParse(create({ mappings, secrets: { password: 'p' } })).success).toBe(true)
    expect(valid(create({ mappings: Array.from({ length: loginLimits.mappings }, (_, index) => ({ database: `d${index}`, user: 'u', rolesAdd: [] })) }))).toBe(true)
    expect(valid(create({ mappings: [{ database: 'A', user: 'u', rolesAdd: roles(loginLimits.roles) }] }))).toBe(true)
  })
  it('refuses a database twice, public, a role twice, empty or long names, too many mappings or roles, extra members and a plan over the statement limit', () => {
    const map = (changes: Record<string, unknown> = {}) => ({ database: 'A', user: 'u', rolesAdd: [], ...changes })
    for (const [name, request] of [
      ['no mappings', { ...create(), mappings: undefined }],
      ['a database twice', create({ mappings: [map(), map({ user: 'v' })] })],
      ['public', create({ mappings: [map({ rolesAdd: ['public'] })] })],
      ['a role twice', create({ mappings: [map({ rolesAdd: ['r', 'r'] })] })],
      ['an empty user', create({ mappings: [map({ user: '' })] })],
      ['an empty schema', create({ mappings: [map({ defaultSchema: '' })] })],
      ['a 129-unit database', create({ mappings: [map({ database: 'd'.repeat(129) })] })],
      ['U+0000 in a user', create({ mappings: [map({ user: 'a\u0000b' })] })],
      ['257 roles', create({ mappings: [map({ rolesAdd: roles(loginLimits.roles + 1) })] })],
      ['257 mappings', create({ mappings: Array.from({ length: loginLimits.mappings + 1 }, (_, index) => map({ database: `d${index}` })) })],
      ['no roles', create({ mappings: [{ database: 'A', user: 'u' }] })],
      ['an extra member', create({ mappings: [map({ previousUser: 'x' })] })],
      ['more than 512 statements', create({ mappings: [map({ rolesAdd: roles(256) }), map({ database: 'B', rolesAdd: roles(256) })] })]
    ] as const) expect(valid(request), name).toBe(false)
    const tooMany = actionScriptRequestSchema.safeParse(create({ mappings: [map({ rolesAdd: roles(256) }), map({ database: 'B', rolesAdd: roles(256) })] }))
    expect(tooMany.error?.issues.map(issue => issue.message)).toContain(tooManyStatementsMessage(actionLimits.statements))
  })
  it('counts the statements a plan can run as C# does: CREATE LOGIN, Deny, Disable, server roles, and per mapping a user, two for a schema and one per role', () => {
    expect(newLoginStatements({ serverRoles: ['sysadmin'], status: { connect: 'deny', enabled: false }, mappings: [{ defaultSchema: 's', rolesAdd: ['a', 'b', 'c'] }, { rolesAdd: [] }] })).toBe(1 + 1 + 1 + 1 + (1 + 2 + 3) + 1)
    expect(tooManyStatementsMessage(512)).toBe('This login would need more than 512 statements. Map fewer databases, or apply the rest afterwards.')
  })
  it('reads a database\'s roles for any database, SQL Server\'s own included, and nothing else', () => {
    const describe = (target: unknown) => actionDescribeSchema.safeParse({ ...ids(), dialog: loginDatabaseRolesDescribe, target }).success
    expect(describe({ kind: 'database', name: 'master' })).toBe(true)
    expect(describe({ kind: 'database', name: "Ap]p'x" })).toBe(true)
    expect(describe(server)).toBe(false)
    expect(describe({ kind: 'table', database: 'AppData', schema: 'dbo', name: 'T' })).toBe(false)
    expect(describe({ kind: 'database', name: '' })).toBe(false)
  })
})

describe('User Mapping\'s draft and request', () => {
  it('fills a blank User with the login name when Map is checked, and keeps a row\'s edits when Map is cleared', () => {
    let current = draft()
    const apply = (patch: Partial<NewLoginDraft>) => { current = { ...current, ...patch } }
    apply(setMapped(current, 'Sales', true))
    expect(mappingOf(current, 'Sales')).toEqual({ database: 'Sales', map: true, user: 'app', defaultSchema: '', roles: [] })
    apply(setMappingUser(current, 'Sales', 'reader'))
    apply(setMappingSchema(current, 'Sales', 'reporting'))
    apply(setMappingRole(current, 'Sales', 'db_datareader', true))
    apply(setMappingRole(current, 'Sales', 'public', true))
    apply(setMapped(current, 'Sales', false))
    expect(mappingOf(current, 'Sales')).toEqual({ database: 'Sales', map: false, user: 'reader', defaultSchema: 'reporting', roles: ['db_datareader'] })
    apply(setMapped(current, 'Sales', true))
    expect(mappingOf(current, 'Sales').user).toBe('reader')
    apply(setMappingRole(current, 'Sales', 'db_datareader', false))
    expect(mappingOf(current, 'Sales').roles).toEqual([])
    expect(mappingOf(current, 'AppData')).toEqual({ database: 'AppData', map: false, user: '', defaultSchema: '', roles: [] })
  })
  it('lets mapped users and default schemas named after the login follow a new login name, as SSMS does', () => {
    let current = draft({ name: 'old' })
    current = { ...current, ...setMapped(current, 'Sales', true) }
    current = { ...current, ...setMappingSchema(current, 'Sales', 'old') }
    current = { ...current, ...setMapped(current, 'AppData', true) }
    current = { ...current, ...setMappingUser(current, 'AppData', 'kept') }
    current = { ...current, ...setMapped(current, 'master', true) }
    current = { ...current, ...setMapped(current, 'master', false) }
    current = { ...current, ...renameLogin(current, 'new') }
    expect(current.name).toBe('new')
    expect(mappingOf(current, 'Sales')).toMatchObject({ user: 'new', defaultSchema: 'new' })
    expect(mappingOf(current, 'AppData').user).toBe('kept')
    // An unmapped row's User named after the login follows it too, so checking Map again never maps a user named after an
    // earlier login name.
    expect(mappingOf(current, 'master')).toMatchObject({ map: false, user: 'new' })
    current = { ...current, ...setMapped(current, 'master', true) }
    expect(userMappings(model(), current).find(mapping => mapping.database === 'master')).toEqual({ database: 'master', user: 'new', rolesAdd: [] })
  })
  it('never fills a blank Default Schema with the login name: Map checked before the name is typed, or the name cleared and typed again', () => {
    const typing = (from: NewLoginDraft, ...names: string[]) => names.reduce<NewLoginDraft>((current, name) => ({ ...current, ...renameLogin(current, name) }), from)
    let first = draft({ name: '' })
    first = { ...first, ...setMapped(first, 'AppData', true) }
    first = typing(first, 'D', 'DO', 'DOM\\u')
    expect(mappingOf(first, 'AppData')).toMatchObject({ map: true, user: '', defaultSchema: '' })
    expect(userMappings(model(), first)).toEqual([{ database: 'AppData', user: 'DOM\\u', rolesAdd: [] }])
    let again = draft({ name: 'bob' })
    again = { ...again, ...setMapped(again, 'Sales', true) }
    again = typing(again, 'bo', 'b', '', 'a', 'al')
    expect(mappingOf(again, 'Sales')).toMatchObject({ map: true, defaultSchema: '' })
    expect(userMappings(model(), again)).toEqual([{ database: 'Sales', user: 'al', rolesAdd: [] }])
  })
  it('sends mapped databases the server can map, in the describe\'s order: a blank User is the login, a blank schema none, roles by name', () => {
    let current = draft()
    for (const database of ['Sales', 'Old', 'Closed', 'Shelf', 'AppData', 'Gone']) current = { ...current, mappings: [...current.mappings, { database, map: true, user: '', defaultSchema: '', roles: [] }] }
    current = { ...current, ...setMappingSchema(current, 'Sales', 'reporting') }
    current = { ...current, ...setMappingRole(current, 'Sales', 'db_owner', true) }
    current = { ...current, ...setMappingRole(current, 'Sales', 'Readers', true) }
    current = { ...current, ...setMappingRole(current, 'Sales', 'db_datareader', true) }
    expect(userMappings(model(), current)).toEqual([
      { database: 'AppData', user: 'app', rolesAdd: [] },
      { database: 'Sales', user: 'app', defaultSchema: 'reporting', rolesAdd: ['Readers', 'db_datareader', 'db_owner'] }
    ])
    const built = newLoginRequest(server, model(), current, set) as Omit<CreateLoginRequest, 'connectionId' | 'requestId'>
    expect(built.mappings).toEqual(userMappings(model(), current))
    expect(valid({ ...built, ...ids() })).toBe(true)
    expect(mappable(model().databases[1])).toBe(false)
    expect(mappable(model().databases[3])).toBe(false)
    // A read-only database (set READ_ONLY, a standby or a snapshot) would fail CREATE USER after CREATE LOGIN had run.
    expect(mappable(model().databases[5])).toBe(false)
    expect(mappable(model().databases[4])).toBe(true)
  })
  it('names a plan too large for one request before anything is sent', () => {
    const many = { ...model(), databases: Array.from({ length: loginLimits.mappings + 1 }, (_, index) => ({ name: `d${index}`, state: 0, accessible: true, readOnly: false })) }
    const mapped = draft({ defaultDatabase: 'd0', mappings: many.databases.map(database => ({ database: database.name, map: true, user: '', defaultSchema: '', roles: [] })) })
    expect(newLoginRequest(server, many, mapped, set)).toEqual({ problem: userMappingMessages.mappingsLimit })
    const heavy = draft({ mappings: ['AppData', 'Sales'].map(database => ({ database, map: true, user: '', defaultSchema: '', roles: roles(256) })) })
    expect(newLoginRequest(server, model(), heavy, set)).toEqual({ problem: tooManyStatementsMessage(actionLimits.statements) })
  })
})

describe('User Mapping\'s grid helpers', () => {
  it('greys databases SSMS cannot map with their state, and renders only the rows in view', () => {
    expect(unavailableChip({ name: 'Old', state: 6, accessible: false, readOnly: false })).toMatchObject({ label: 'OFFLINE', tone: 'warning' })
    expect(unavailableChip({ name: 'R', state: 1, accessible: false, readOnly: false })).toMatchObject({ label: 'RESTORING' })
    expect(unavailableChip({ name: 'Closed', state: 0, accessible: false, readOnly: false })).toMatchObject({ label: 'NO ACCESS' })
    expect(unavailableChip({ name: 'Open', state: 0, accessible: true, readOnly: false })).toBeUndefined()
    expect(unavailableChip({ name: 'Shelf', state: 0, accessible: true, readOnly: true })).toMatchObject({ label: 'READ-ONLY', tone: 'warning' })
    expect(unavailableChip({ name: 'Old', state: 6, accessible: false, readOnly: true })).toMatchObject({ label: 'OFFLINE' })
    expect(userMappingRowHeight).toBe(22)
    expect(mappingRange(0, 198, 4_096)).toEqual({ first: 0, last: 15 })
    expect(mappingRange(22 * 1_000, 198, 4_096)).toEqual({ first: 994, last: 1_015 })
    expect(mappingRange(0, 198, 3)).toEqual({ first: 0, last: 3 })
  })
})

function setup() {
  const execute = deferred<ApiResult<ActionExecuteResult>>()
  const reads = new Map<string, ReturnType<typeof deferred<ApiResult<ActionDescribeResult>>>>()
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async request => {
      if (request.dialog === 'newLogin') return { ok: true, value: { newLogin: model(), elapsedMs: 1 } }
      const read = deferred<ApiResult<ActionDescribeResult>>()
      reads.set(request.target.name ?? '', read)
      return read.promise
    }),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async () => ({ ok: true, value: { text: '', database: 'master', warnings: [] } })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async cancelled => ({ ok: true, value: { cancelled: cancelled.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  const explorer = {
    listingFolderOf: vi.fn(() => undefined as number | undefined), reconcile: vi.fn(),
    folderNode: vi.fn((_connection: string, owner: ObjectRef, folder: string) => folder === 'logins' ? 5 : owner.name === 'Sales' ? 9 : undefined)
  }
  let count = 0
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() }, newId: () => `id-${++count}` })
  cleanups.push(() => dialogs.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const folder: ExplorerMenuNode = { id: 5, connectionId: 'server-a', ref: { type: 'folder', owner: server, folder: 'logins' }, kind: 'folder', folder: 'logins', label: 'Logins', lost: false, engine: 'box' }
  const open = async () => {
    dialogs.open('newLogin', folder)
    await settle()
    dialogs.updateDraft({ auth: 'windows', name: 'CONTOSO\\ann' })
  }
  return { dialogs, api, connections, explorer, execute, reads, settle, open }
}
const roleRead = (changes: Partial<LoginDatabaseRoles> = {}): ApiResult<ActionDescribeResult> =>
  ({ ok: true, value: { elapsedMs: 1, loginDatabaseRoles: { roles: ['db_datareader', 'db_owner', 'public'], rolesTruncated: false, guest: false, schemas: ['dbo', 'sales'], schemasTruncated: false, ...changes } } })

describe('User Mapping in the object dialog service', () => {
  it('reads a database\'s roles once, when its row is first selected, and keeps the answer while the dialog is open', async () => {
    const { dialogs, api, reads, settle, open } = setup()
    await open()
    dialogs.loadDatabaseRoles('Sales')
    expect(api.describeObject.mock.calls[1][0]).toMatchObject({ dialog: 'loginDatabaseRoles', target: { kind: 'database', name: 'Sales' } })
    expect(dialogs.current?.databaseRoles?.get('Sales')).toEqual({ state: 'loading' })
    dialogs.loadDatabaseRoles('Sales')
    reads.get('Sales')!.resolve(roleRead({ guest: true }))
    await settle()
    expect(dialogs.current?.databaseRoles?.get('Sales')).toMatchObject({ state: 'ready', value: { guest: true, roles: ['db_datareader', 'db_owner', 'public'] } })
    dialogs.loadDatabaseRoles('Sales')
    expect(api.describeObject).toHaveBeenCalledTimes(2)
  })
  it('never reads a database that cannot be mapped (offline, closed to this login, or read-only)', async () => {
    const { dialogs, api, open } = setup()
    await open()
    dialogs.loadDatabaseRoles('Old')
    dialogs.loadDatabaseRoles('Closed')
    dialogs.loadDatabaseRoles('Shelf')
    expect(api.describeObject).toHaveBeenCalledTimes(1)
    expect(dialogs.current?.databaseRoles?.size ?? 0).toBe(0)
  })
  it('cancels and forgets a read still running when another row is selected, so the grid never queues reads', async () => {
    const { dialogs, api, reads, settle, open } = setup()
    await open()
    dialogs.loadDatabaseRoles('Sales')
    dialogs.loadDatabaseRoles('AppData')
    expect(api.cancelObjectActions).toHaveBeenCalledWith(['id-2'])
    expect(dialogs.current?.databaseRoles?.has('Sales')).toBe(false)
    reads.get('Sales')!.resolve({ ok: false, error: 'cancelled', code: 'CANCELLED' })
    reads.get('AppData')!.resolve(roleRead())
    await settle()
    expect(dialogs.current?.databaseRoles?.get('Sales')).toBeUndefined()
    expect(dialogs.current?.databaseRoles?.get('AppData')).toMatchObject({ state: 'ready' })
    // Selecting Sales again reads it anew.
    dialogs.loadDatabaseRoles('Sales')
    expect(api.describeObject).toHaveBeenCalledTimes(4)
  })
  it('shows a failed read as a value and reads again on Retry', async () => {
    const { dialogs, api, reads, settle, open } = setup()
    await open()
    dialogs.loadDatabaseRoles('Sales')
    reads.get('Sales')!.resolve({ ok: true, value: { elapsedMs: 1, error: { code: 'DATABASE_UNAVAILABLE', message: 'The database Sales is offline, so it cannot be mapped.', retryable: true } } })
    await settle()
    expect(dialogs.current?.databaseRoles?.get('Sales')).toEqual({ state: 'failed', error: { code: 'DATABASE_UNAVAILABLE', message: 'The database Sales is offline, so it cannot be mapped.', retryable: true } })
    dialogs.loadDatabaseRoles('Sales')
    expect(api.describeObject).toHaveBeenCalledTimes(3)
    expect(dialogs.current?.databaseRoles?.get('Sales')).toEqual({ state: 'loading' })
  })
  it('cancels its read when the dialog closes or the server disconnects, and reads nothing for a dialog without User Mapping', async () => {
    const { dialogs, api, connections, settle, open } = setup()
    await open()
    dialogs.loadDatabaseRoles('Sales')
    dialogs.close()
    expect(api.cancelObjectActions).toHaveBeenLastCalledWith(['id-2'])
    await open()
    dialogs.loadDatabaseRoles('Sales')
    connections.remove('server-a')
    await settle()
    expect(api.cancelObjectActions).toHaveBeenLastCalledWith(['id-4'])
    expect(dialogs.current?.phase).toBe('disconnected')
    dialogs.loadDatabaseRoles('AppData')
    expect(api.describeObject).toHaveBeenCalledTimes(4)
  })
  it('sends the mappings with OK, then reloads Logins with the login selected and each mapped database\'s listed Users folder', async () => {
    const { dialogs, api, explorer, execute, settle, open } = setup()
    await open()
    const current = dialogs.current!.draft as NewLoginDraft
    dialogs.updateDraft(setMapped(current, 'Sales', true))
    dialogs.updateDraft(setMapped(dialogs.current!.draft as NewLoginDraft, 'AppData', true))
    const ok = dialogs.ok()
    await settle()
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ mappings: [{ database: 'AppData', user: 'CONTOSO\\ann', rolesAdd: [] }, { database: 'Sales', user: 'CONTOSO\\ann', rolesAdd: [] }] })
    execute.resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await ok
    expect(explorer.folderNode).toHaveBeenCalledWith('server-a', { kind: 'database', name: 'Sales' }, 'users')
    expect(explorer.folderNode).toHaveBeenCalledWith('server-a', { kind: 'database', name: 'AppData' }, 'users')
    expect(explorer.reconcile).toHaveBeenCalledWith(9)
    expect(explorer.reconcile).toHaveBeenCalledWith(5, { select: { type: 'object', object: { kind: 'login', name: 'CONTOSO\\ann' } } })
    expect(explorer.reconcile).toHaveBeenCalledTimes(2)
  })
  it('reloads the mapped databases\' Users folders after a run that created the login and then stopped', () => {
    const effects = { refreshListing: vi.fn(), reveal: vi.fn(), reload: vi.fn(), databaseState: vi.fn(), notify: vi.fn() }
    newLoginDefinition.afterPartial!(effects, { ...create({ mappings: [{ database: 'Sales', user: 'u', rolesAdd: [] }] }) } as never)
    expect(effects.reveal).toHaveBeenCalledWith('logins', { kind: 'login', name: 'app' })
    expect(effects.reload).toHaveBeenCalledWith({ kind: 'database', name: 'Sales' }, 'users')
  })
})
