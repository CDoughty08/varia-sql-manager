// D4c, a login's Delete: Delete Object's login branch (the request with the option and the identity it read, OK greyed by the
// rules, the Users folders a Delete changed, Varia's other connections that sign in as the login) and its texts.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginDeleteText, loginMessages, mappedUserKept, type LoginFacts, type MappedUser } from '../src/shared/actions/logins'
import { loginConnectionsText } from '../src/shared/actions/prompts'
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
const user = (database: string, name: string, changes: Partial<MappedUser> = {}): MappedUser =>
  ({ database, user: name, ownedSchemas: 0, ownedRoles: 0, readOnly: false, ownedSecurables: 0, grantedPermissions: 0, canDrop: true, ...changes })
const users = [user('AppData', 'app'), user('Sales', 'owner', { ownedSchemas: 1 }), user('Hr', 'app')]
const login = (changes: Partial<DeleteTarget> = {}, factChanges: Partial<LoginFacts> = {}): DeleteTarget => ({
  name: 'AppUser', type: 'Login', warnings: [], dependentsTruncated: false, login: facts(factChanges), mappings: { users, mapped: users.length, checked: 4, notChecked: 1 }, ...changes
})
const draft = (dropMappedUsers: boolean) => ({ deleteHistory: false, closeConnections: false, dropMappedUsers })
const backend = (name: string) => readFileSync(new URL(`../backend/Varia.Backend/Actions/${name}`, import.meta.url), 'utf8')

describe('Delete Object on a login (D4c)', () => {
  it('keeps the user step\'s title and the kept rule equal to the backend\'s', () => {
    expect(backend('ActionService.cs')).toContain(`ActionTemplate.DropUser or ActionTemplate.DropMappedUser => "${dropUserStepTitle}"`)
    expect(backend('LoginDelete.cs')).toContain('Kept(MappedUserDto user) => user.OwnedSchemas > 0 || user.OwnedRoles > 0 || user.OwnedSecurables > 0 || user.GrantedPermissions > 0 || user.ReadOnly || !user.CanDrop;')
    // Every reason DROP USER fails keeps the user: a schema, a role or another securable it owns, a permission it granted, a
    // read-only database, or no ALTER ANY USER there.
    expect([user('A', 'a'), user('A', 'a', { ownedSchemas: 1 }), user('A', 'a', { ownedRoles: 2 }), user('A', 'a', { readOnly: true }), user('A', 'a', { ownedSecurables: 1 }),
      user('A', 'a', { grantedPermissions: 3 }), user('A', 'a', { canDrop: false })].map(mappedUserKept)).toEqual([false, true, true, true, true, true, true])
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
    // No user mapped, or every one kept: greyed, each with its reason (A7), never the hint about schema owners.
    const none = login({ mappings: { users: [], mapped: 0, checked: 4, notChecked: 0 } })
    expect([canDropMappedUsers(none), dropMappedUsersNote(none)]).toEqual([false, loginDeleteText.noneToDrop])
    expect(dropMappedUsersNote(keptOnly)).toBe(loginDeleteText.allKept)
    // Sessions it cannot count (no VIEW SERVER STATE): one would fail the login's DROP after its users were gone, so the option is
    // greyed, as the backend refuses it.
    const blind = login({}, { sessions: undefined })
    expect([canDropMappedUsers(blind), dropMappedUsersNote(blind), request(appUser, blind, draft(true))])
      .toEqual([false, loginMessages.sessionsUncounted, expect.objectContaining({ dropMappedUsers: false })])
    expect(loginDeleteText.sessionsUncounted).toBe(loginMessages.sessionsUncounted)
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
    expect(changed(login(), [{ status: 'done', title: dropUserStepTitle, detail: 'app in AppData' }, { status: 'done', title: 'Drop the login' }])).toEqual({ folder: 'users', databases: ['AppData', 'Hr'] })
    expect(changed(login(), [{ status: 'failed', title: dropUserStepTitle }, { status: 'skipped', title: 'Drop the login' }])).toBeUndefined()
    expect(changed(login(), [{ status: 'done', title: 'Drop the login' }])).toBeUndefined()
  })

  it('words the kept users, the databases not checked and the rest', () => {
    expect(loginDeleteText.kept(user('A', 'a', { ownedSchemas: 1 }))).toBe('kept: owns 1 schema')
    expect(loginDeleteText.kept(user('A', 'a', { ownedSchemas: 2, ownedRoles: 1 }))).toBe('kept: owns 2 schemas and 1 role')
    expect(loginDeleteText.kept(user('A', 'a', { ownedRoles: 3 }))).toBe('kept: owns 3 roles')
    expect(loginDeleteText.kept(user('A', 'a', { readOnly: true, ownedSchemas: 1 }))).toBe('kept: the database is read-only; owns 1 schema')
    expect(loginDeleteText.kept(user('A', 'a', { ownedSecurables: 2, grantedPermissions: 1 }))).toBe('kept: owns 2 other securables; has granted 1 permission')
    expect(loginDeleteText.kept(user('A', 'a', { canDrop: false }))).toBe('kept: you cannot delete users there (ALTER ANY USER)')
    // The hint names every kind of user a Delete keeps, not only schema owners.
    expect(loginDeleteText.dropHint).toBe('Users that own schemas or other securables, or have granted permissions, are kept. Transfer or revoke those first, then delete the users in each database.')
    // Varia's other connections as the login fail the DROP until they disconnect (their pools' sessions; Activity Monitor hides and
    // will not end Varia's own).
    expect(loginConnectionsText(['Prod (AppUser)'], loginDeleteText.connections(1))).toBe("Varia's connection Prod (AppUser) signs in as this login, and its sessions fail the DROP until it is disconnected.")
    expect(loginConnectionsText(['A', 'B'], loginDeleteText.connections(2))).toBe("Varia's connections A, B sign in as this login, and their sessions fail the DROP until they are disconnected.")
    expect(loginDeleteText.noneMappedChecked).toBe('No database user is mapped to this login in the databases checked.')
    expect([loginDeleteText.notChecked(1), loginDeleteText.notChecked(1234), loginDeleteText.more(1500)])
      .toEqual(['1 database was not checked (offline or not accessible).', '1,234 databases were not checked (offline or not accessible).', '…and 1,500 more'])
  })
})

describe('Delete Object\'s login styles (D4c)', () => {
  it('rings the scrolling mapped-user list with the theme\'s focus border, insets it as its caption, and tells notes and the refusal from warnings', () => {
    const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('.object-dialog-mapped-list:focus-visible { outline: 1px solid var(--varia-focusBorder); outline-offset: -1px; }')
    expect(css).toMatch(/\.object-dialog-mapped-list \{[^}]*padding: 0 calc\(var\(--varia-space-2\) \+ var\(--varia-space-0\)\);/)
    expect(css).toContain('.object-dialog-warnings > li.is-refusal { background: var(--varia-banner-errorBackground); color: var(--varia-banner-errorForeground); }')
    expect(css).toContain('.object-dialog-warnings > li.is-note { background: transparent; color: var(--varia-descriptionForeground); }')
  })
})

describe('ObjectDialogService on a login\'s Delete (D4c)', () => {
  it('reads the login again after a partial failure, so the users it dropped leave the list while the failure stays', async () => {
    const after = login({ mappings: { users: [users[1]], mapped: 1, checked: 4, notChecked: 1 } })
    const { dialogs, api, execute, settle } = setup(login(), after)
    dialogs.open('deleteObject', node(appUser))
    await settle()
    dialogs.updateDraft({ dropMappedUsers: true })
    const failed = dialogs.ok()
    const steps = [{ status: 'done', title: dropUserStepTitle, detail: 'app in AppData' }, { status: 'done', title: dropUserStepTitle, detail: 'app in Hr' },
      { status: 'failed', title: 'Drop the login', message: 'The login has granted permissions.' }] as const
    execute.resolve({ ok: true, value: { steps: [...steps], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: 'The login has granted permissions.', retryable: false } } })
    await failed
    await settle()
    expect(api.describeObject).toHaveBeenCalledTimes(2)
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'DEPENDENTS' }, steps: [...steps], model: after })
    // Only the schema owner is left, and it is kept: the option is greyed with that reason.
    expect(dropMappedUsersNote(dialogs.current!.model as DeleteTarget)).toBe(loginDeleteText.allKept)
    // Stopped after a user was dropped: read again too. A plain failure (nothing done) is not.
    const stopped = setup(login(), after)
    stopped.dialogs.open('deleteObject', node(appUser))
    await stopped.settle()
    const stop = stopped.dialogs.ok()
    stopped.execute.resolve({ ok: true, value: { steps: [steps[0], { status: 'skipped', title: 'Drop the login' }], messages: [], elapsedMs: 1, error: { code: 'CANCELLED', message: 'Stopped.', retryable: true } } })
    await stop
    await stopped.settle()
    expect(stopped.api.describeObject).toHaveBeenCalledTimes(2)
    expect(stopped.dialogs.current).toMatchObject({ phase: 'stopped', model: after })
    const refused = setup(login(), after)
    refused.dialogs.open('deleteObject', node(appUser))
    await refused.settle()
    const nothing = refused.dialogs.ok()
    refused.execute.resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'IN_USE', message: 'Sessions.', retryable: true } } })
    await nothing
    await refused.settle()
    expect(refused.api.describeObject).toHaveBeenCalledTimes(1)
  })

  const node = (object: ObjectRef, id = 7): ExplorerMenuNode => ({ id, connectionId: 'server-a', ref: { type: 'object', object }, kind: object.kind, label: object.name ?? '', lost: false })
  function setup(model: DeleteTarget, ...later: DeleteTarget[]) {
    const execute = deferred<ApiResult<ActionExecuteResult>>()
    const models = [model, ...later]
    const api = {
      describeObject: vi.fn<VariaApi['describeObject']>(async () => ({ ok: true, value: { deleteTarget: models.length > 1 ? models.shift()! : models[0], elapsedMs: 1 } as ActionDescribeResult })),
      scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async () => ({ ok: true, value: { text: 'DROP LOGIN [AppUser]', database: 'master', warnings: [] } })),
      executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
      cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
      writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
      confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false })),
      confirmAction: vi.fn<VariaApi['confirmAction']>(async () => ({ ok: true, value: 'cancel' }))
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
    // It is read again (the describe answers the same model here), and the failure stays shown.
    await second.settle()
    expect(second.api.describeObject).toHaveBeenCalledTimes(2)
    expect(second.dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'IN_USE' } })

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
