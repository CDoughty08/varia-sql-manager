import { afterEach, describe, expect, it, vi } from 'vitest'
import { unknownOutcomeMessage } from '../src/shared/actions/catalog'
import { loginMessages, type LoginFacts, type LoginLockFacts } from '../src/shared/actions/logins'
import type { ActionDescribeResult, ActionExecuteResult, ActionScriptResult, DatabaseStateModel, DeleteTarget } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { dialogMessages, ObjectDialogService } from '../src/renderer/src/dialogs/ObjectDialogService'
import { unlockChooseMode, unlockSuccessNotice } from '../src/renderer/src/dialogs/definitions'
import { unlockStateLines } from '../src/renderer/src/dialogs/pages/UnlockLoginPage'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const ordersRef: ObjectRef = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }
const databaseRef: ObjectRef = { kind: 'database', name: 'AppData' }
const node = (object: ObjectRef, id = 7): ExplorerMenuNode => ({ id, connectionId: 'server-a', ref: { type: 'object', object }, kind: object.kind, label: object.name ?? '', lost: false })
const row = (changes: Partial<DeleteTarget> = {}): ApiResult<ActionDescribeResult> => ({ ok: true, value: { deleteTarget: { name: 'dbo.Orders', type: 'Table', owner: 'dbo', warnings: [], dependentsTruncated: false, ...changes }, elapsedMs: 1 } })
const done: ApiResult<ActionExecuteResult> = { ok: true, value: { steps: [{ status: 'done', title: 'Drop the object' }], messages: [], elapsedMs: 1 } }

/** The service over fakes: describe answers at once unless a test holds it, and every request is recorded. */
function setup() {
  const execute = deferred<ApiResult<ActionExecuteResult>>()
  let held: Promise<ApiResult<ActionDescribeResult>> | undefined
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async () => held ?? row()),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async params => ({ ok: true, value: { text: `DROP ${params.target.name}`, database: 'AppData', warnings: [] } as ActionScriptResult })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  const explorer = { listingFolderOf: vi.fn(() => 3 as number | undefined), reconcile: vi.fn() }
  const documents = { newQuery: vi.fn() }, files = { saveCopy: vi.fn(async (name: string) => ({ id: 'f', name, path: '/x/' + name, encoding: 'utf8' as const, readOnly: false })) }
  let ids = 0
  const notify = vi.fn<(message: string) => void>()
  const databaseState = vi.fn<(connectionId: string, database: string, offline: boolean) => void>()
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents, files, notify, databaseState, newId: () => `id-${++ids}` })
  cleanups.push(() => dialogs.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { dialogs, api, connections, explorer, documents, execute, settle, notify, databaseState, hold: (promise: Promise<ApiResult<ActionDescribeResult>>) => { held = promise } }
}

describe('ObjectDialogService', () => {
  it('opens loading, describes the object, and is ready with SSMS\'s default options; one dialog at a time', async () => {
    const { dialogs, api, settle, hold } = setup()
    const describe = deferred<ApiResult<ActionDescribeResult>>()
    hold(describe.promise)
    dialogs.open('deleteObject', node(databaseRef))
    expect(dialogs.current).toMatchObject({ dialog: 'deleteObject', phase: 'loading', page: 'general', server: 'server-a.example', login: 'sa', label: 'AppData' })
    expect(api.describeObject.mock.calls).toEqual([[{ connectionId: 'server-a', requestId: 'id-1', dialog: 'deleteObject', target: databaseRef }]])
    expect(() => dialogs.open('deleteObject', node(ordersRef))).toThrow('Close the open dialog first.')
    describe.resolve(row({ name: 'AppData', type: 'Database', isSnapshot: false }))
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', draft: { deleteHistory: true, closeConnections: false } })
  })
  it('shows a failed describe as a value, and greys a snapshot\'s options', async () => {
    const { dialogs, api, settle } = setup()
    api.describeObject.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'dbo.Orders no longer exists. Refresh Object Explorer.', retryable: false } } })
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'loadFailed', error: { code: 'NOT_FOUND' } })
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
    api.describeObject.mockResolvedValueOnce(row({ isSnapshot: true }))
    dialogs.open('deleteObject', node(databaseRef))
    await settle()
    expect(dialogs.current?.draft).toEqual({ deleteHistory: false, closeConnections: false, dropMappedUsers: false })
  })
  it('scripts the action to each destination through Script As\'s delivery and stays open', async () => {
    const { dialogs, api, documents, settle } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    await dialogs.script('newQuery')
    expect(api.scriptObjectAction.mock.calls[0][0]).toEqual({ action: 'delete', target: ordersRef, closeConnections: false, deleteHistory: false, connectionId: 'server-a', requestId: 'id-2' })
    expect(documents.newQuery.mock.calls).toEqual([['DROP Orders', undefined, 'server-a', 'AppData', false]])
    await dialogs.script('clipboard')
    expect(api.writeClipboardText.mock.calls).toEqual([['DROP Orders']])
    expect(dialogs.current).toMatchObject({ phase: 'ready', notice: 'Script copied to the clipboard.' })
    await dialogs.script('file')
    expect(dialogs.current).toMatchObject({ phase: 'ready', notice: 'Saved dbo.Orders.sql.' })
    expect(api.executeObjectAction).not.toHaveBeenCalled()
  })
  it('runs OK, closes on success and reloads the listing folder', async () => {
    const { dialogs, api, explorer, execute, settle } = setup()
    dialogs.open('deleteObject', node(databaseRef, 12))
    await settle()
    dialogs.updateDraft({ closeConnections: true })
    const ok = dialogs.ok()
    expect(dialogs.current?.phase).toBe('executing')
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'delete', target: databaseRef, closeConnections: true, deleteHistory: true })
    expect(dialogs.close()).toBe(false)
    execute.resolve(done)
    await ok
    expect(dialogs.current).toBeUndefined()
    expect(explorer.listingFolderOf).toHaveBeenCalledWith(12)
    expect(explorer.reconcile.mock.calls).toEqual([[3]])
  })
  it('keeps DEPENDENTS and partial failures open with the steps, and a later OK can retry', async () => {
    const { dialogs, api, settle, execute } = setup()
    dialogs.open('deleteObject', node(databaseRef))
    await settle()
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Delete backup and restore history' }, { status: 'failed', title: 'Drop the database', message: 'Cannot drop database "AppData" because it is currently in use.' }],
      messages: [], elapsedMs: 1, error: { code: 'IN_USE', message: 'Cannot drop database "AppData" because it is currently in use. Completed before the failure: Delete backup and restore history.', retryable: true } } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'IN_USE' }, steps: [{ status: 'done' }, { status: 'failed' }] })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'failed', title: 'Drop the object', message: 'Could not drop object' }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: 'Could not drop object', retryable: false } } })
    await dialogs.ok()
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'DEPENDENTS' } })
  })
  it('stops a running action through cancelObjectActions and reports Stopped', async () => {
    const { dialogs, api, settle, execute } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    const ok = dialogs.ok()
    dialogs.stop()
    expect(api.cancelObjectActions.mock.calls).toEqual([[['id-2']]])
    execute.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'stopped', error: { message: dialogMessages.stopped } })
    expect(dialogs.close()).toBe(true)
  })
  it('reports a Stop SQL Server confirmed with the steps that completed, and reloads the listing they changed', async () => {
    const { dialogs, api, settle, execute, explorer } = setup()
    dialogs.open('deleteObject', node(databaseRef))
    await settle()
    const ok = dialogs.ok()
    dialogs.stop()
    expect(api.cancelObjectActions).toHaveBeenCalledTimes(1)
    const stopped = { code: 'CANCELLED' as const, message: 'The action was stopped at "Delete backup and restore history"; SQL Server cancelled that statement. Completed before Stop: Close existing connections, Drop the database.', retryable: true }
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Close existing connections' }, { status: 'done', title: 'Drop the database' }, { status: 'cancelled', title: 'Delete backup and restore history' }], messages: [], elapsedMs: 1, error: stopped } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'stopped', error: stopped, steps: [{ status: 'done' }, { status: 'done' }, { status: 'cancelled' }] })
    expect(explorer.reconcile).toHaveBeenCalledTimes(1)
    expect(dialogs.close()).toBe(true)
  })
  it('turns a lost backend into the unknown-outcome sentence, and a disconnect into Close only', async () => {
    const { dialogs, connections, settle, execute, api } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    const ok = dialogs.ok()
    execute.resolve({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { message: unknownOutcomeMessage } })
    // Disconnecting while it runs: the request is cancelled, its outcome is unknown, and only Close is left.
    const running = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(running.promise)
    const again = dialogs.ok()
    connections.remove('server-a')
    expect(dialogs.current).toMatchObject({ phase: 'disconnected', error: { message: unknownOutcomeMessage } })
    expect(api.cancelObjectActions).toHaveBeenCalledWith(['id-3'])
    running.resolve(done)
    await again
    expect(dialogs.current?.phase).toBe('disconnected')
    expect(dialogs.close()).toBe(true)
  })
  it('says the server was disconnected when it goes while the dialog waits, and cancels its requests on dispose', async () => {
    const { dialogs, connections, settle, api, hold } = setup()
    dialogs.open('deleteObject', node(ordersRef))
    await settle()
    connections.remove('server-a')
    expect(dialogs.current).toMatchObject({ phase: 'disconnected', error: { message: dialogMessages.disconnected } })
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
    connections.add(connectionInfo('server-a'), connectionOptions)
    hold(new Promise(() => {}))
    dialogs.open('deleteObject', node(ordersRef))
    dialogs.dispose()
    expect(api.cancelObjectActions.mock.calls.at(-1)).toEqual([['id-2']])
  })
})

describe('ObjectDialogService: documents', () => {
  it('refuses a dialog the catalogue opens as a document (Database Properties)', () => {
    const { dialogs, api } = setup()
    expect(() => dialogs.open('databaseProperties' as never, node(databaseRef, 12))).toThrow('That dialog opens as a document.')
    expect(dialogs.current).toBeUndefined()
    expect(api.describeObject).not.toHaveBeenCalled()
  })
})

describe('ObjectDialogService: Unlock Login', () => {
  const lockedRef: ObjectRef = { kind: 'login', name: 'Locked' }
  const facts = (changes: Partial<LoginFacts> = {}): LoginFacts => ({ principalId: 300, type: 'S', subtype: 'sql', disabled: false, sid: '0A1B', created: '2026-01-02T03:04:05.000', policyChecked: true, expirationChecked: true,
    connectDenied: false, own: false, sysadmin: false, ownedDatabaseNames: [], canAlter: true, canControlServer: true, nameInUse: false, ...changes })
  const lock = (changes: Partial<LoginLockFacts> = {}): LoginLockFacts => ({ locked: true, badPasswords: 11, lockoutTime: '2026-11-02T21:07:12.123', mustChange: false, expired: false, daysUntilExpiration: 42, ...changes })
  const described = (login = facts(), state = lock()): ApiResult<ActionDescribeResult> => ({ ok: true, value: { login, lock: state, elapsedMs: 1 } })
  it('describes the lock-out state of the login, and OK unlocks it keeping the password once chosen, bound to the login it read', async () => {
    const { dialogs, api, explorer, execute, settle, notify } = setup()
    api.describeObject.mockResolvedValueOnce(described())
    dialogs.open('unlockLogin', node(lockedRef))
    expect(dialogs.current).toMatchObject({ dialog: 'unlockLogin', title: 'Unlock Login - Locked', phase: 'loading' })
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ dialog: 'unlockLogin', target: lockedRef })
    await settle()
    // Nothing is chosen (owner decision 9: keeping the password clears its history, so it is never the default): OK, and Enter,
    // which runs the same OK, send nothing until the user picks.
    expect(dialogs.current).toMatchObject({ phase: 'ready', draft: {} })
    expect(dialogs.blockedReason()).toBe(unlockChooseMode)
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current?.phase).toBe('ready')
    dialogs.updateDraft({ mode: 'keepPassword' })
    expect(dialogs.blockedReason()).toBeUndefined()
    await dialogs.script('newQuery')
    expect(api.scriptObjectAction.mock.calls[0][0]).toEqual({ action: 'unlock', target: lockedRef, mode: 'keepPassword', loginIdentity: { sid: '0A1B', created: '2026-01-02T03:04:05.000' }, connectionId: 'server-a', requestId: 'id-2' })
    const ok = dialogs.ok()
    expect(api.executeObjectAction.mock.calls[0][0]).toEqual({ action: 'unlock', target: lockedRef, mode: 'keepPassword', loginIdentity: { sid: '0A1B', created: '2026-01-02T03:04:05.000' }, connectionId: 'server-a', requestId: 'id-3' })
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Turn off the password policy' }, { status: 'done', title: 'Turn the password policy and expiration back on' }, { status: 'done', title: 'Commit' }], messages: [], elapsedMs: 1 } })
    await ok
    expect(dialogs.current).toBeUndefined()
    expect(explorer.reconcile).toHaveBeenCalledWith(3)
    expect(notify.mock.calls).toEqual([[unlockSuccessNotice('Locked')]])
    expect(unlockSuccessNotice('Locked')).toBe('Unlocked the login Locked. Its password history was cleared.')
  })
  it('greys OK, with the reason, for a login that is not locked, has no policy or must change its password; Script stays', async () => {
    for (const [name, login, state, reason] of [
      ['not locked', facts(), lock({ locked: false, badPasswords: 0, lockoutTime: undefined }), loginMessages.notLocked],
      ['no policy', facts({ policyChecked: false }), lock(), loginMessages.unlockNoPolicy],
      ['must change', facts(), lock({ mustChange: true }), loginMessages.unlockMustChange],
      ['no permission', facts({ canAlter: false }), lock(), loginMessages.alterAnyLogin]
    ] as const) {
      const { dialogs, api, settle } = setup()
      api.describeObject.mockResolvedValueOnce(described(login, state))
      dialogs.open('unlockLogin', node(lockedRef))
      await settle()
      expect(dialogs.blockedReason(), name).toBe(reason)
      await dialogs.ok()
      expect(api.executeObjectAction, name).not.toHaveBeenCalled()
      expect(dialogs.current?.phase, name).toBe('ready')
      await dialogs.script('clipboard')
      expect(api.scriptObjectAction, name).toHaveBeenCalledTimes(1)
      dialogs.close()
    }
  })
  it('shows a login unlocked meanwhile as not locked, so OK greys rather than asking again', async () => {
    const { dialogs, api, execute, settle } = setup()
    api.describeObject.mockResolvedValueOnce(described())
    dialogs.open('unlockLogin', node(lockedRef))
    await settle()
    dialogs.updateDraft({ mode: 'keepPassword' })
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ status: 'failed', title: 'Turn off the password policy', message: loginMessages.notLocked }, { status: 'skipped', title: 'Commit' }], messages: [], elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: loginMessages.notLocked, retryable: false } } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { message: loginMessages.notLocked } })
    expect(dialogs.blockedReason()).toBe(loginMessages.notLocked)
  })
  it('words the lock-out state from the describe', () => {
    expect(unlockStateLines(lock())).toEqual(['Locked out since 2026-11-02 21:07:12 (server time) after 11 failed sign-ins.'])
    expect(unlockStateLines(lock({ badPasswords: 1, lockoutTime: undefined, expired: true, mustChange: true }))).toEqual(['Locked out after 1 failed sign-in.', 'The password has expired.', 'The login must change its password at next sign-in.'])
    expect(unlockStateLines(lock({ locked: false }))).toEqual(['This login is not locked out.'])
  })
})

describe('ObjectDialogService: Take Offline and Bring Online', () => {
  const identity = { id: 7, created: '2026-01-02T03:04:05.678' }
  const state = (changes: Partial<DatabaseStateModel> = {}): ApiResult<ActionDescribeResult> => ({ ok: true, value: { elapsedMs: 1, databaseState: {
    name: 'AppData', identity, state: 0, userAccess: 0, readOnly: false, standby: false, sessions: 0, withTransaction: 0, sessionList: [], sessionsTruncated: false, warnings: [], ...changes
  } } })
  const busy = state({ sessions: 2, withTransaction: 1, sessionList: [{ sessionId: 61, login: 'app', program: 'App', host: 'web1', openTransactions: 1 }, { sessionId: 62, openTransactions: 0 }] })
  const offline: ApiResult<ActionExecuteResult> = { ok: true, value: { steps: [{ status: 'done', title: 'Take database offline' }], messages: [], elapsedMs: 1 } }

  it('disables OK while sessions are in the database and Drop All Active Connections is cleared, and sends the identity it read', async () => {
    const { dialogs, api, settle, execute, explorer, databaseState } = setup()
    api.describeObject.mockResolvedValueOnce(busy)
    dialogs.open('takeOffline', node(databaseRef, 12))
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', draft: { dropConnections: false } })
    expect(dialogs.blockedReason()).toBe('2 sessions are connected: check Drop All Active Connections, or Check Again once they leave.')
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    dialogs.updateDraft({ dropConnections: true })
    expect(dialogs.blockedReason()).toBeUndefined()
    const ok = dialogs.ok()
    expect(api.executeObjectAction.mock.calls[0][0]).toEqual({ action: 'takeOffline', target: databaseRef, dropConnections: true, identity, connectionId: 'server-a', requestId: 'id-2' })
    execute.resolve(offline)
    await ok
    // SSMS's progress dialog stays open on its steps with Close; the listing and Database Properties follow the new state.
    expect(dialogs.current).toMatchObject({ phase: 'succeeded', steps: [{ status: 'done', title: 'Take database offline' }] })
    expect(dialogs.blockedReason()).toBeUndefined()
    dialogs.updateDraft({ dropConnections: false })
    expect(dialogs.current?.draft).toEqual({ dropConnections: true })
    expect(explorer.reconcile.mock.calls).toEqual([[3]])
    expect(databaseState.mock.calls).toEqual([['server-a', 'AppData', true]])
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
  })
  it('says one session in the singular, and unknown sessions (no VIEW SERVER STATE) leave OK enabled', async () => {
    const { dialogs, api, settle } = setup()
    api.describeObject.mockResolvedValueOnce(state({ sessions: 1, sessionList: [{ sessionId: 61, openTransactions: 0 }] }))
    dialogs.open('takeOffline', node(databaseRef))
    await settle()
    expect(dialogs.blockedReason()).toBe('1 session is connected: check Drop All Active Connections, or Check Again once it leaves.')
    dialogs.close()
    api.describeObject.mockResolvedValueOnce(state({ sessions: undefined, withTransaction: undefined }))
    dialogs.open('takeOffline', node(databaseRef))
    await settle()
    expect(dialogs.blockedReason()).toBeUndefined()
  })
  it('Check Again reads the database again and keeps the choice', async () => {
    const { dialogs, api, settle } = setup()
    api.describeObject.mockResolvedValueOnce(busy)
    dialogs.open('takeOffline', node(databaseRef))
    await settle()
    dialogs.updateDraft({ dropConnections: true })
    const again = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(again.promise)
    dialogs.reload()
    // The model stays on screen while it reads; OK waits for the new count.
    expect(dialogs.current).toMatchObject({ phase: 'loading', model: { sessions: 2 } })
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    again.resolve(state())
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', model: { sessions: 0 }, draft: { dropConnections: true } })
    expect(api.describeObject.mock.calls.map(call => call[0].dialog)).toEqual(['takeOffline', 'takeOffline'])
  })
  it('Bring Online runs as soon as the describe answers, stays open on Success, and shows SQL Server\'s note', async () => {
    const { dialogs, api, settle, execute, databaseState } = setup()
    api.describeObject.mockResolvedValueOnce(state({ state: 6 }))
    dialogs.open('bringOnline', node(databaseRef))
    await settle()
    expect(dialogs.current?.phase).toBe('executing')
    expect(api.executeObjectAction.mock.calls[0][0]).toEqual({ action: 'bringOnline', target: databaseRef, identity, connectionId: 'server-a', requestId: 'id-2' })
    const note = 'The database is online in SINGLE_USER mode: only one connection at a time can use it.'
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Bring database online' }], messages: [note], elapsedMs: 1 } })
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'succeeded', notice: note })
    expect(databaseState.mock.calls).toEqual([['server-a', 'AppData', false]])
    // A refused describe (already online) runs nothing.
    dialogs.close()
    api.describeObject.mockResolvedValueOnce({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: 'The database is online.', retryable: false } } })
    dialogs.open('bringOnline', node(databaseRef))
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'loadFailed', error: { message: 'The database is online.' } })
    expect(api.executeObjectAction).toHaveBeenCalledTimes(1)
  })
  it('a failed Bring Online can be retried with OK, which does not run on its own again', async () => {
    const { dialogs, api, settle, execute } = setup()
    api.describeObject.mockResolvedValueOnce(state({ state: 3 }))
    dialogs.open('bringOnline', node(databaseRef))
    await settle()
    execute.resolve({ ok: true, value: { steps: [{ status: 'failed', title: 'Bring database online', message: 'File activation failure.' }], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'File activation failure.', retryable: false } } })
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'SQL_ERROR' } })
    api.describeObject.mockResolvedValueOnce(state({ state: 3 }))
    dialogs.reload()
    await settle()
    expect(dialogs.current?.phase).toBe('ready')
    expect(api.executeObjectAction).toHaveBeenCalledTimes(1)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Bring database online' }], messages: [], elapsedMs: 1 } })
    await dialogs.ok()
    expect(dialogs.current).toMatchObject({ phase: 'succeeded' })
    expect(dialogs.current?.notice).toBeUndefined()
  })
})
