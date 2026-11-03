// D4c, a login's Delete: Delete Object's login branch (the request with the option and the identity it read, OK greyed by the
// rules, the Users folders a Delete changed, Varia's other connections that sign in as the login) and its texts.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginDeleteText, loginMessages, mappedUserKept, type LoginFacts, type MappedUser } from '../src/shared/actions/logins'
import { dropUserStepTitle, type ActionDescribeResult, type ActionExecuteResult, type DeleteTarget } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { canDropMappedUsers, deleteObjectDefinition, dropMappedUsersNote, loginDeleteRefusal } from '../src/renderer/src/dialogs/definitions'
import { ObjectDialogService } from '../src/renderer/src/dialogs/ObjectDialogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const appUser: ObjectRef = { kind: 'login', name: 'AppUser' }
const facts = (changes: Partial<LoginFacts> = {}): LoginFacts => ({
  principalId: 300, type: 'S', subtype: 'sql', disabled: false, sid: '0A1B', created: '2026-01-02T03:04:05.000', connectDenied: false, own: false, sysadmin: false, sessions: 0,
  ownedDatabases: 0, ownedDatabaseNames: [], ownedServerObjects: 0, canAlter: true, canControlServer: true, nameInUse: false, ...changes
})
const user = (database: string, name: string, changes: Partial<MappedUser> = {}): MappedUser => ({ database, user: name, ownedSchemas: 0, ownedRoles: 0, readOnly: false, ...changes })
const users = [user('AppData', 'app'), user('Sales', 'owner', { ownedSchemas: 1 }), user('Hr', 'app')]
const login = (changes: Partial<DeleteTarget> = {}, factChanges: Partial<LoginFacts> = {}): DeleteTarget => ({
  name: 'AppUser', type: 'Login', warnings: [], dependentsTruncated: false, login: facts(factChanges), mappings: { users, mapped: users.length, checked: 4, notChecked: 1 }, ...changes
})
const draft = (dropMappedUsers: boolean) => ({ deleteHistory: false, closeConnections: false, dropMappedUsers })
const backend = (name: string) => readFileSync(new URL(`../backend/Varia.Backend/Actions/${name}`, import.meta.url), 'utf8')

describe('Delete Object on a login (D4c)', () => {
  it('keeps the user step\'s title and the kept rule equal to the backend\'s', () => {
    expect(backend('ActionService.cs')).toContain(`ActionTemplate.DropUser => "${dropUserStepTitle}"`)
    expect(backend('LoginDelete.cs')).toContain('Kept(MappedUserDto user) => user.OwnedSchemas > 0 || user.OwnedRoles > 0 || user.ReadOnly;')
    expect([user('A', 'a'), user('A', 'a', { ownedSchemas: 1 }), user('A', 'a', { ownedRoles: 2 }), user('A', 'a', { readOnly: true })].map(mappedUserKept)).toEqual([false, true, true, true])
  })

  it('sends the option only where users may be dropped, with the identity of the login it read', () => {
    const request = deleteObjectDefinition.request
    expect(request(appUser, login(), draft(true))).toEqual({ action: 'delete', target: appUser, closeConnections: false, deleteHistory: false, dropMappedUsers: true, loginIdentity: { sid: '0A1B', created: '2026-01-02T03:04:05.000' } })
    expect(request(appUser, login(), draft(false))).toMatchObject({ dropMappedUsers: false, loginIdentity: { sid: '0A1B' } })
    // Only users a Delete keeps (a schema owner): nothing to drop, so the option is greyed and never sent checked.
    const keptOnly = login({ mappings: { users: [users[1]], mapped: 1, checked: 4, notChecked: 0 } })
    expect([canDropMappedUsers(keptOnly), request(appUser, keptOnly, draft(true))]).toEqual([false, expect.objectContaining({ dropMappedUsers: false })])
    // More mapped than listed: the backend would refuse, so the option is greyed with the reason.
    const more = login({ mappings: { users, mapped: 101, checked: 4, notChecked: 0 } })
    expect([canDropMappedUsers(more), dropMappedUsersNote(more), request(appUser, more, draft(true))]).toEqual([false, loginDeleteText.tooMany, expect.objectContaining({ dropMappedUsers: false })])
    expect(dropMappedUsersNote(login())).toBeUndefined()
    // A table's Delete carries neither.
    const table: ObjectRef = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }
    const plain = request(table, { name: 'dbo.Orders', type: 'Table', warnings: [], dependentsTruncated: false }, draft(true))
    expect(plain).toEqual({ action: 'delete', target: table, closeConnections: false, deleteHistory: false })
  })

  it('greys OK by the protected-principal rules over the facts it read', () => {
    expect(loginDeleteRefusal(login({}, { subtype: 'sa', principalId: 1 }))).toBe(loginMessages.saDelete)
    expect(loginDeleteRefusal(login({}, { own: true }))).toBe(loginMessages.own)
    expect(loginDeleteRefusal(login({}, { canAlter: false }))).toBe(loginMessages.alterAnyLogin)
    expect(loginDeleteRefusal(login())).toBeUndefined()
    expect(loginDeleteRefusal(login({}, { subtype: 'windowsGroup', type: 'G' }))).toBeUndefined()
    expect(deleteObjectDefinition.blocked!(login({}, { subtype: 'sa' }))).toBe('The sa login cannot be deleted.')
    expect(deleteObjectDefinition.blocked!({ name: 'dbo.Orders', type: 'Table', warnings: [], dependentsTruncated: false })).toBeUndefined()
  })

  it('names the Users folders a Delete changed once a user was dropped', () => {
    const changed = deleteObjectDefinition.changedFolders!
    expect(changed(login(), [{ status: 'done', title: dropUserStepTitle, detail: 'AppData: app' }, { status: 'done', title: 'Drop the login' }])).toEqual({ folder: 'users', databases: ['AppData', 'Hr'] })
    expect(changed(login(), [{ status: 'failed', title: dropUserStepTitle }, { status: 'skipped', title: 'Drop the login' }])).toBeUndefined()
    expect(changed(login(), [{ status: 'done', title: 'Drop the login' }])).toBeUndefined()
  })

  it('words the kept users, the databases not checked and the rest', () => {
    expect(loginDeleteText.kept(user('A', 'a', { ownedSchemas: 1 }))).toBe('kept: owns 1 schema')
    expect(loginDeleteText.kept(user('A', 'a', { ownedSchemas: 2, ownedRoles: 1 }))).toBe('kept: owns 2 schemas and 1 role')
    expect(loginDeleteText.kept(user('A', 'a', { ownedRoles: 3 }))).toBe('kept: owns 3 roles')
    expect(loginDeleteText.kept(user('A', 'a', { readOnly: true, ownedSchemas: 1 }))).toBe('kept: the database is read-only')
    expect([loginDeleteText.notChecked(1), loginDeleteText.notChecked(1234), loginDeleteText.more(1500)])
      .toEqual(['1 database was not checked (offline or not accessible).', '1,234 databases were not checked (offline or not accessible).', '…and 1,500 more'])
  })
})

describe('ObjectDialogService on a login\'s Delete (D4c)', () => {
  const node = (object: ObjectRef, id = 7): ExplorerMenuNode => ({ id, connectionId: 'server-a', ref: { type: 'object', object }, kind: object.kind, label: object.name ?? '', lost: false })
  function setup(model: DeleteTarget) {
    const execute = deferred<ApiResult<ActionExecuteResult>>()
    const api = {
      describeObject: vi.fn<VariaApi['describeObject']>(async () => ({ ok: true, value: { deleteTarget: model, elapsedMs: 1 } as ActionDescribeResult })),
      scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async () => ({ ok: true, value: { text: 'DROP LOGIN [AppUser]', database: 'master', warnings: [] } })),
      executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
      cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
      writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
      confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false }))
    }
    const connections = new ConnectionService()
    connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
    // Another of Varia's connections to the same server signs in as the login (names compare without case), one to another server does not count.
    connections.add({ ...connectionInfo('server-b'), server: 'server-a.example', login: 'appuser' }, connectionOptions)
    connections.add({ ...connectionInfo('server-c'), login: 'AppUser' }, connectionOptions)
    const explorer = { listingFolderOf: vi.fn(() => 3 as number | undefined), reconcile: vi.fn(), loadedFolders: vi.fn(() => [41, 42]) }
    const dialogs = new ObjectDialogService({ api, connections, explorer, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() }, newId: () => 'id' })
    cleanups.push(() => dialogs.dispose())
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))
    return { dialogs, api, explorer, execute, settle }
  }

  it('sends nothing while the rules refuse the login, though Script still works', async () => {
    const { dialogs, api, settle } = setup(login({}, { own: true }))
    dialogs.open('deleteObject', node(appUser))
    await settle()
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current).toMatchObject({ phase: 'ready', error: { code: 'NOT_SUPPORTED', message: loginMessages.own } })
    await dialogs.script('clipboard')
    expect(api.scriptObjectAction.mock.calls[0][0]).toMatchObject({ action: 'delete', target: appUser, dropMappedUsers: false, loginIdentity: { sid: '0A1B' } })
  })

  it('names Varia\'s other connections that sign in as the login', async () => {
    const { dialogs, settle } = setup(login())
    dialogs.open('deleteObject', node(appUser))
    await settle()
    expect(dialogs.current?.loginConnections).toHaveLength(1)
    expect(dialogs.current?.loginConnections?.[0]).toContain('server-a.example')
  })

  it('reloads the loaded Users folders of the databases it dropped users in, after a success and after a partial failure', async () => {
    const first = setup(login())
    first.dialogs.open('deleteObject', node(appUser))
    await first.settle()
    first.dialogs.updateDraft({ dropMappedUsers: true })
    const ok = first.dialogs.ok()
    expect(first.api.executeObjectAction.mock.calls[0][0]).toMatchObject({ dropMappedUsers: true, loginIdentity: { sid: '0A1B', created: '2026-01-02T03:04:05.000' } })
    first.execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: dropUserStepTitle }, { status: 'done', title: dropUserStepTitle }, { status: 'done', title: 'Drop the login' }], messages: [], elapsedMs: 1 } })
    await ok
    expect(first.dialogs.current).toBeUndefined()
    expect(first.explorer.loadedFolders).toHaveBeenCalledWith('server-a', 'users', ['AppData', 'Hr'])
    expect(first.explorer.reconcile.mock.calls).toEqual([[3], [41], [42]])

    // A user dropped, then the login's DROP failed: the user is gone all the same.
    const second = setup(login())
    second.dialogs.open('deleteObject', node(appUser))
    await second.settle()
    second.dialogs.updateDraft({ dropMappedUsers: true })
    const failed = second.dialogs.ok()
    second.execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: dropUserStepTitle }, { status: 'failed', title: 'Drop the login' }], messages: [], elapsedMs: 1,
      error: { code: 'IN_USE', message: 'The login has sessions.', retryable: true } } })
    await failed
    expect(second.dialogs.current?.phase).toBe('failed')
    expect(second.explorer.reconcile.mock.calls).toEqual([[3], [41], [42]])

    // Without the option nothing but the listing reloads.
    const third = setup(login())
    third.dialogs.open('deleteObject', node(appUser))
    await third.settle()
    const plain = third.dialogs.ok()
    third.execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Drop the login' }], messages: [], elapsedMs: 1 } })
    await plain
    expect(third.explorer.loadedFolders).not.toHaveBeenCalled()
    expect(third.explorer.reconcile.mock.calls).toEqual([[3]])
  })
})
