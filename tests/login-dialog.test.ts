// New Login (D2a): the draft, SSMS's defaults, enablement and the request it maps to (src/renderer/src/dialogs/new-login.ts), the
// object dialog service's secret slot (never in a snapshot, only on OK, cleared on close, disconnect, success and a new open), and
// no logging in the backend's login sources.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginLimits, newLoginMessages, type NewLoginModel } from '../src/shared/actions/logins'
import type { ActionDescribeResult, ActionExecuteResult, ActionScriptResult } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { newLoginDefinition } from '../src/renderer/src/dialogs/definitions'
import { emptySecrets, initialNewLoginDraft, newLoginEnabled, newLoginHints, newLoginRequest, newLoginTarget, passwordFieldLength, type NewLoginDraft, type SecretState } from '../src/renderer/src/dialogs/new-login'
import { ObjectDialogService } from '../src/renderer/src/dialogs/ObjectDialogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const server: ObjectRef = { kind: 'server' }
const model = (changes: Partial<NewLoginModel['server']> = {}): NewLoginModel => ({
  server: { level: 17, linux: false, windowsOnly: false, canCreate: true, engine: 'box', ...changes },
  databases: [{ name: 'AppData', state: 0, accessible: true, readOnly: false }, { name: 'master', state: 0, accessible: true, readOnly: false }], databasesTruncated: false,
  languages: [{ name: 'Deutsch', alias: 'German' }, { name: 'us_english', alias: 'English' }],
  serverRoles: [{ name: 'bulkadmin', fixed: true }, { name: 'public', fixed: true }, { name: 'sysadmin', fixed: true }], serverRolesTruncated: false,
  certificates: ['AppSigning'], certificatesTruncated: false, asymmetricKeys: ['AppKey'], asymmetricKeysTruncated: false, credentials: [{ name: 'AzureBlob' }, { name: 'Vault', provider: 'EkmProv' }], credentialsTruncated: false
})
const sqlDraft = (changes: Partial<NewLoginDraft> = {}): NewLoginDraft => ({ ...initialNewLoginDraft(model()), auth: 'sql', name: 'app', ...changes })
const set: SecretState = { password: 'set', matches: true, wellFormed: true, tooLong: false }
const folder = (folderId: 'logins' | 'serverSecurity' | 'tables', engine: 'box' | 'cloud' | 'managedInstance' = 'box', id = 5): ExplorerMenuNode => ({
  id, connectionId: 'server-a', ref: { type: 'folder', owner: folderId === 'tables' ? { kind: 'database', name: 'AppData' } : server, folder: folderId }, kind: 'folder', folder: folderId, label: folderId, lost: false, engine
})

describe('New Login draft and request', () => {
  it('starts from SSMS\'s defaults: Windows authentication, or SQL Server authentication on Linux; master; the three options; Grant; Enabled', () => {
    expect(initialNewLoginDraft(model())).toEqual({
      auth: 'windows', name: '', defaultDatabase: 'master', checkPolicy: true, checkExpiration: true, mustChange: true, serverRoles: [], connect: 'grant', enabled: true, mappings: [],
      certificate: 'AppSigning', asymmetricKey: 'AppKey', mapCredential: false, credential: 'AzureBlob', credentials: []
    })
    expect(initialNewLoginDraft(model({ linux: true })).auth).toBe('sql')
  })
  it('greys the password fields for Windows logins and each option unless the one before it is checked', () => {
    const box = model().server
    expect(newLoginEnabled(initialNewLoginDraft(model()), box)).toMatchObject({ password: false, checkPolicy: false, checkExpiration: false, mustChange: false, oldPassword: false })
    expect(newLoginEnabled(sqlDraft(), box)).toMatchObject({ password: true, checkPolicy: true, checkExpiration: true, mustChange: true, oldPassword: false })
    expect(newLoginEnabled(sqlDraft({ checkPolicy: false }), box)).toMatchObject({ checkExpiration: false, mustChange: false })
    expect(newLoginEnabled(sqlDraft({ checkExpiration: false }), box)).toMatchObject({ checkExpiration: true, mustChange: false })
  })
  it('maps the draft to createLogin: options only for SQL Server logins and as enabled, a language only when chosen, roles in the describe\'s order', () => {
    expect(newLoginRequest(server, model(), sqlDraft({ serverRoles: ['sysadmin', 'bulkadmin', 'gone'], connect: 'deny', enabled: false, defaultLanguage: 'Deutsch' }), set)).toEqual({
      action: 'createLogin', target: server, serverRoles: ['bulkadmin', 'sysadmin'], mappings: [], status: { connect: 'deny', enabled: false },
      login: { auth: 'sql', name: 'app', defaultDatabase: 'master', defaultLanguage: 'Deutsch', checkPolicy: true, checkExpiration: true, mustChange: true }
    })
    // Unchecking the policy greys and clears the options after it, whatever they held.
    expect(newLoginRequest(server, model(), sqlDraft({ checkPolicy: false }), set)).toMatchObject({ login: { checkPolicy: false, checkExpiration: false, mustChange: false } })
    expect(newLoginRequest(server, model(), sqlDraft({ checkExpiration: false }), set)).toMatchObject({ login: { checkPolicy: true, checkExpiration: false, mustChange: false } })
    const windows = newLoginRequest(server, model(), { ...initialNewLoginDraft(model()), name: 'CONTOSO\\ann', serverRoles: ['public', 'sysadmin'] }, emptySecrets)
    expect(windows).toEqual({ action: 'createLogin', target: server, serverRoles: ['sysadmin'], mappings: [], status: { connect: 'grant', enabled: true }, login: { auth: 'windows', name: 'CONTOSO\\ann', defaultDatabase: 'master' } })
    expect(JSON.stringify(windows)).not.toContain('secrets')
  })
  it('names what is missing in the page\'s words, never a value', () => {
    const problem = (draft: NewLoginDraft, secrets = set) => { const built = newLoginRequest(server, model(), draft, secrets); return 'problem' in built ? built.problem : undefined }
    expect(problem(sqlDraft({ name: '' }))).toBe(newLoginMessages.nameRequired)
    expect(problem(sqlDraft({ name: 'D\\x' }))).toBe(newLoginMessages.sqlBackslash)
    expect(problem({ ...initialNewLoginDraft(model()), name: 'ann' })).toBe(newLoginMessages.windowsName)
    expect(problem(sqlDraft({ defaultDatabase: 'Gone' }))).toBe(newLoginMessages.defaultDatabase)
    expect(problem(sqlDraft({ defaultLanguage: 'Klingon' }))).toBe(newLoginMessages.defaultLanguage)
    expect(problem(sqlDraft(), { ...set, matches: false })).toBe(newLoginMessages.mismatch)
    expect(problem(sqlDraft(), { ...set, wellFormed: false })).toBe(newLoginMessages.broken)
    expect(problem(sqlDraft({ checkPolicy: false }), { ...set, password: 'empty' })).toBe(newLoginMessages.blankWithoutPolicy)
    // A blank password under the policy is the server's to refuse.
    expect(problem(sqlDraft(), { ...set, password: 'empty' })).toBeUndefined()
    // A Windows login ignores the password fields.
    expect(problem({ ...initialNewLoginDraft(model()), name: 'D\\a' }, { password: 'set', matches: false, wellFormed: false, tooLong: true })).toBeUndefined()
    // A password longer than SQL Server takes is refused, not cut short: the field allows one character more to show it.
    expect(problem(sqlDraft(), { ...set, tooLong: true })).toBe(newLoginMessages.tooLong)
    expect(newLoginMessages.tooLong).toContain(String(loginLimits.password))
    expect(passwordFieldLength).toBe(loginLimits.password + 1)
  })
  it('notes the server\'s password policy only while it is checked', () => {
    const box = model().server
    expect(newLoginHints(sqlDraft(), box)).toEqual([newLoginMessages.policyServer, newLoginMessages.passwordScript])
    expect(newLoginHints(sqlDraft({ checkPolicy: false }), box)).toEqual([newLoginMessages.passwordScript])
    expect(newLoginHints(initialNewLoginDraft(model()), box)).toEqual([])
  })
  it('opens on the Security or Logins folder or a login of a SQL Server or a Managed Instance (D2e), with the server as its target', () => {
    expect(newLoginTarget(folder('logins'))).toEqual(server)
    expect(newLoginTarget(folder('serverSecurity'))).toEqual(server)
    expect(newLoginTarget({ id: 9, connectionId: 'server-a', ref: { type: 'object', object: { kind: 'login', name: 'sa' } }, kind: 'login', label: 'sa', lost: false, engine: 'box' })).toEqual(server)
    expect(newLoginTarget(folder('tables'))).toBeUndefined()
    expect(newLoginTarget(folder('logins', 'cloud'))).toBeUndefined()
    expect(newLoginTarget(folder('logins', 'managedInstance'))).toEqual(server)
    expect(newLoginDefinition.secrets?.(sqlDraft())).toBe(true)
    expect(newLoginDefinition.secrets?.(initialNewLoginDraft(model()))).toBe(false)
    expect(newLoginDefinition.longRun).toBe('newLogin')
  })
})

/** The service over fakes, opened on a Logins folder whose describe answers New Login's model. */
function setup() {
  const execute = deferred<ApiResult<ActionExecuteResult>>()
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async () => ({ ok: true, value: { newLogin: model(), elapsedMs: 1 } as ActionDescribeResult })),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async () => ({ ok: true, value: { text: 'CREATE LOGIN [app] WITH PASSWORD=<password>', database: 'master', warnings: [] } as ActionScriptResult })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(async () => ({ ok: true, value: false })),
    confirmAction: vi.fn<VariaApi['confirmAction']>(async () => ({ ok: true, value: 'cancel' }))
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  const explorer = { listingFolderOf: vi.fn(() => undefined as number | undefined), reconcile: vi.fn(), folderNode: vi.fn(() => 5 as number | undefined) }
  const runs: string[] = []
  const longRuns = { begin: vi.fn((run: { kind: string; refused?(message: string): void }) => { runs.push(run.kind); return { dispose: () => { runs.splice(runs.indexOf(run.kind), 1) } } }) }
  const documents = { newQuery: vi.fn() }, files = { saveCopy: vi.fn(async (name: string) => ({ id: 'f', name, path: '/x/' + name, encoding: 'utf8' as const, readOnly: false })) }
  let ids = 0
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents, files, longRuns, newId: () => `id-${++ids}` })
  cleanups.push(() => dialogs.dispose())
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const open = async () => {
    dialogs.open('newLogin', folder('logins'))
    await settle()
    dialogs.updateDraft({ auth: 'sql', name: 'app' })
  }
  return { dialogs, api, connections, explorer, execute, settle, open, runs, longRuns, files }
}
const secret = 'S3cret!' + 'Q7w'

describe('New Login in the object dialog service', () => {
  it('opens on the server with SSMS\'s defaults and empty password fields', async () => {
    const { dialogs, api, open } = setup()
    await open()
    expect(api.describeObject.mock.calls[0][0]).toMatchObject({ dialog: 'newLogin', target: server })
    expect(dialogs.current).toMatchObject({ dialog: 'newLogin', title: 'Login - New', phase: 'ready', target: server, secretState: emptySecrets, draft: { auth: 'sql', name: 'app' } })
  })
  it('keeps the password out of every snapshot: the snapshot only says whether it is set, matches and is well formed', async () => {
    const { dialogs, open } = setup()
    await open()
    const seen: string[] = []
    dialogs.subscribe(() => seen.push(JSON.stringify(dialogs.getSnapshot())))
    dialogs.setSecret('password', secret)
    expect(dialogs.current?.secretState).toEqual({ password: 'set', matches: false, wellFormed: true, tooLong: false })
    dialogs.setSecret('confirm', secret)
    expect(dialogs.current?.secretState).toEqual({ password: 'set', matches: true, wellFormed: true, tooLong: false })
    dialogs.setPage('status')
    dialogs.setPage('general')
    expect(dialogs.current?.secretState).toEqual({ password: 'set', matches: true, wellFormed: true, tooLong: false })
    dialogs.setSecret('confirm', secret + '\uD800')
    dialogs.setSecret('password', secret + '\uD800')
    expect(dialogs.current?.secretState).toEqual({ password: 'set', matches: true, wellFormed: false, tooLong: false })
    dialogs.setSecret('password', 'x'.repeat(loginLimits.password + 1))
    expect(dialogs.current?.secretState).toMatchObject({ tooLong: true })
    expect(seen.length).toBeGreaterThan(0)
    for (const snapshot of [...seen, JSON.stringify(dialogs.getSnapshot())]) expect(snapshot).not.toContain('S3cret!')
  })
  it('scripts without the password and sends it only with OK, once, then forgets it on success and reveals the new login', async () => {
    const { dialogs, api, execute, explorer, settle, open, runs, files } = setup()
    await open()
    dialogs.setSecret('password', secret)
    dialogs.setSecret('confirm', secret)
    await dialogs.script('newQuery')
    await dialogs.script('file')
    expect(files.saveCopy.mock.calls[0][0]).toBe('app.sql')
    expect(JSON.stringify(api.scriptObjectAction.mock.calls)).not.toContain('S3cret!')
    expect(api.scriptObjectAction.mock.calls.every(([request]) => !Object.hasOwn(request, 'secrets'))).toBe(true)
    const ok = dialogs.ok()
    await settle()
    expect(runs).toEqual(['newLogin'])
    expect(api.executeObjectAction.mock.calls).toHaveLength(1)
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ action: 'createLogin', target: server, secrets: { password: secret }, login: { auth: 'sql', name: 'app' } })
    // Typing while OK runs changes nothing.
    dialogs.setSecret('password', 'other')
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Create the login' }], messages: [], elapsedMs: 1 } })
    await ok
    expect(runs).toEqual([])
    expect(dialogs.current).toBeUndefined()
    expect(explorer.folderNode).toHaveBeenCalledWith('server-a', server, 'logins')
    expect(explorer.reconcile).toHaveBeenCalledWith(5, { select: { type: 'object', object: { kind: 'login', name: 'app' } } })
    // The slot is empty for the next dialog: a Windows-free SQL login without a password typed sends an empty one.
    await open()
    expect(dialogs.current?.secretState).toEqual(emptySecrets)
  })
  it('sends no secrets for a Windows login, and refuses a mismatch before anything is sent', async () => {
    const { dialogs, api, execute, settle, open } = setup()
    await open()
    dialogs.setSecret('password', secret)
    await dialogs.ok()
    expect(dialogs.current?.error?.message).toBe(newLoginMessages.mismatch)
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    dialogs.updateDraft({ auth: 'windows', name: 'CONTOSO\\ann' })
    const ok = dialogs.ok()
    await settle()
    expect(api.executeObjectAction.mock.calls[0][0]).not.toHaveProperty('secrets')
    execute.resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await ok
  })
  it('keeps the password after a PASSWORD_POLICY failure, so OK can be pressed again with a better one', async () => {
    const { dialogs, api, execute, settle, open } = setup()
    await open()
    dialogs.setSecret('password', 'Weak')
    dialogs.setSecret('confirm', 'Weak')
    const ok = dialogs.ok()
    await settle()
    execute.resolve({ ok: true, value: { steps: [{ status: 'failed', title: 'Create the login', message: 'Password validation failed.' }], messages: [], elapsedMs: 1, error: { code: 'PASSWORD_POLICY', message: 'Password validation failed.', retryable: true } } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'PASSWORD_POLICY' }, secretState: { password: 'set', matches: true } })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await dialogs.ok()
    expect(api.executeObjectAction.mock.calls[1][0]).toMatchObject({ secrets: { password: 'Weak' } })
  })
  it('empties the slot when the dialog closes, OK succeeds, the server disconnects and the service is disposed', async () => {
    const { dialogs, api, connections, open, settle } = setup()
    await open()
    dialogs.setSecret('password', secret)
    dialogs.setSecret('confirm', secret)
    expect(dialogs.holdsSecrets).toBe(true)
    dialogs.close()
    expect(dialogs.holdsSecrets).toBe(false)
    await open()
    expect(dialogs.current?.secretState).toEqual(emptySecrets)
    dialogs.setSecret('password', secret)
    dialogs.setSecret('confirm', secret)
    api.executeObjectAction.mockResolvedValue({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    await dialogs.ok()
    expect(api.executeObjectAction.mock.calls[0][0]).toMatchObject({ secrets: { password: secret } })
    expect(dialogs.current).toBeUndefined()
    expect(dialogs.holdsSecrets).toBe(false)
    await open()
    dialogs.setSecret('password', secret)
    connections.remove('server-a')
    await settle()
    expect(dialogs.current?.phase).toBe('disconnected')
    expect(dialogs.holdsSecrets).toBe(false)
    // A disconnected dialog takes no more typing.
    dialogs.setSecret('confirm', secret)
    expect(dialogs.holdsSecrets).toBe(false)
    dialogs.close()
    connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
    await open()
    dialogs.setSecret('password', secret)
    dialogs.dispose()
    expect(dialogs.holdsSecrets).toBe(false)
  })
  it('takes down a problem OK showed once an edit resolves it, and keeps the server\'s errors until the next OK', async () => {
    const { dialogs, api, execute, settle, open } = setup()
    await open()
    dialogs.setSecret('password', secret)
    dialogs.setSecret('confirm', secret + 'x')
    await dialogs.ok()
    expect(dialogs.current?.error?.message).toBe(newLoginMessages.mismatch)
    // An edit that leaves the problem keeps it.
    dialogs.updateDraft({ defaultLanguage: 'Deutsch' })
    expect(dialogs.current?.error?.message).toBe(newLoginMessages.mismatch)
    dialogs.setSecret('confirm', secret)
    expect(dialogs.current?.error).toBeUndefined()
    dialogs.updateDraft({ name: '' })
    expect(dialogs.current?.error).toBeUndefined()
    await dialogs.ok()
    expect(dialogs.current?.error?.message).toBe(newLoginMessages.nameRequired)
    dialogs.updateDraft({ name: 'app' })
    expect(dialogs.current?.error).toBeUndefined()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    const ok = dialogs.ok()
    await settle()
    execute.resolve({ ok: true, value: { steps: [{ status: 'failed', title: 'Create the login' }], messages: [], elapsedMs: 1, error: { code: 'PASSWORD_POLICY', message: 'Password validation failed.', retryable: true } } })
    await ok
    dialogs.setSecret('confirm', secret + 'y')
    dialogs.setSecret('confirm', secret)
    expect(dialogs.current?.error?.code).toBe('PASSWORD_POLICY')
  })
  it('reloads Logins and selects the login when a failure or Stop left it created', async () => {
    const { dialogs, execute, explorer, settle, open } = setup()
    await open()
    dialogs.setSecret('password', secret)
    dialogs.setSecret('confirm', secret)
    const ok = dialogs.ok()
    await settle()
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Create the login' }, { status: 'done', title: 'Commit' }, { status: 'failed', title: 'Add to a server role', detail: 'gone' }], messages: [], elapsedMs: 1,
      error: { code: 'NOT_FOUND', message: 'The login was created with the status chosen, but not every server role was added.', retryable: true } } })
    await ok
    expect(dialogs.current?.phase).toBe('failed')
    expect(explorer.listingFolderOf).not.toHaveBeenCalled()
    expect(explorer.folderNode).toHaveBeenCalledWith('server-a', server, 'logins')
    expect(explorer.reconcile).toHaveBeenCalledWith(5, { select: { type: 'object', object: { kind: 'login', name: 'app' } } })
  })
  it('shows a refused window close in the dialog while OK runs, and Stop cancels it', async () => {
    const { dialogs, api, settle, open, longRuns } = setup()
    await open()
    dialogs.setSecret('password', secret)
    dialogs.setSecret('confirm', secret)
    void dialogs.ok()
    await settle()
    const registration = longRuns.begin.mock.calls[0][0]
    registration.refused?.('New Login is running on server-a.example, and closing the window would stop it part way.')
    expect(dialogs.current?.refusal).toContain('New Login is running')
    expect(dialogs.close()).toBe(false)
    dialogs.stop()
    expect(api.cancelObjectActions).toHaveBeenCalledWith([api.executeObjectAction.mock.calls[0][0].requestId])
  })
})

describe('backend login sources', () => {
  it('never write to the console, a trace or a logger', () => {
    const folder = join(__dirname, '..', 'backend', 'Varia.Backend', 'Actions')
    const files = readdirSync(folder).filter(name => /^Login.*\.cs$/.test(name))
    expect(files).toEqual(expect.arrayContaining(['LoginJobs.cs', 'LoginRules.cs', 'LoginSql.cs']))
    for (const name of files) expect(readFileSync(join(folder, name), 'utf8'), name).not.toMatch(/\b(?:Console|Trace|Debug|Logger|ILogger|EventSource)\s*\.|\bLog(?:Information|Warning|Error|Debug|Trace|Critical)?\s*\(/)
  })
})
