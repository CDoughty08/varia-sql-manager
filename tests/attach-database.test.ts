// Attach Databases (PR D1d): the request's schema, the page's operations and row statuses, and the dialog service on the
// Databases folder (its describes, the picker, the long run and the listing it reloads).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionLimits } from '../src/shared/actions/catalog'
import { actionDescribeSchema, actionRequestSchema, actionTargetProblems, attachProblems, type ActionDescribeResult, type ActionExecuteResult, type ActionStep, type AttachDescribeModel } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import {
  addAttachDatabase, attachBlocked, attachMessages, attachRequest, attachRowStates, browseAttachFile, checkAttachFile, initialAttachDraft, removeAttachDatabase, removeAttachFile, setAttachFilePath,
  setAttachName, setAttachOwner, type AttachDraft, type AttachHost, type AttachRow
} from '../src/renderer/src/dialogs/attach-database'
import { attachDatabaseDefinition } from '../src/renderer/src/dialogs/definitions'
import { ObjectDialogService, type DialogPhase } from '../src/renderer/src/dialogs/ObjectDialogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

const ids = { connectionId: '0b1e7c1e-8f43-4b8e-9d4a-8d5a3c3e2f10', requestId: '7d3f0a52-3c9e-4a51-a1f0-5b2a8e8c9d21' }
const server: ObjectRef = { kind: 'server' }
const facts = { logins: ['sa', 'app_owner'], loginsTruncated: false, separator: '\\' as const, dataPath: 'C:\\Data\\' }
const sales: AttachDescribeModel['database'] = {
  mdf: 'C:\\Data\\Sales.mdf', databaseName: 'Sales', version: 957,
  files: [{ original: 'D:\\Old\\Sales.mdf', type: 'data', current: 'C:\\Data\\Sales.mdf', found: true }, { original: 'D:\\Old\\Sales_2.ndf', type: 'data', current: 'D:\\Old\\Sales_2.ndf', found: false },
    { original: 'D:\\Old\\Sales_log.ldf', type: 'log', current: 'D:\\Old\\Sales_log.ldf', found: true }]
}
const row = (key: number, name: string, changes: Partial<AttachRow> = {}): AttachRow => ({
  key, mdf: `C:\\Data\\${name}.mdf`, databaseName: name, name, files: [{ original: `C:\\Data\\${name}.mdf`, type: 'data', current: `C:\\Data\\${name}.mdf`, found: true }, { original: `C:\\Data\\${name}_log.ldf`, type: 'log', current: `C:\\Data\\${name}_log.ldf`, found: true }], ...changes
})
const draftOf = (rows: AttachRow[], changes: Partial<AttachDraft> = {}): AttachDraft => ({ rows, nextKey: rows.length + 1, ...changes })

describe('attach request schema', () => {
  const request = (databases: unknown[], target: unknown = server) => actionRequestSchema.safeParse({ action: 'attach', ...ids, target, databases })
  it('takes 1 to 16 databases on the server, each with 1 to 1,000 bounded paths, a name and an optional owner', () => {
    expect(request([{ name: 'Sales', files: ['C:\\Data\\Sales.mdf'], rebuildLog: true }]).success).toBe(true)
    expect(request([{ name: 'Sales', owner: 'app_owner', files: ['/var/opt/mssql/data/Sales.mdf', '/var/opt/mssql/data/Sales_log.ldf'], rebuildLog: false }]).success).toBe(true)
    expect(request([]).success).toBe(false)
    expect(request(Array.from({ length: actionLimits.attachDatabases + 1 }, (_, index) => ({ name: `d${index}`, files: [`C:\\d${index}.mdf`], rebuildLog: true }))).success).toBe(false)
    expect(request([{ name: 'Sales', files: Array.from({ length: actionLimits.attachFiles + 1 }, (_, index) => `C:\\f${index}.ndf`), rebuildLog: true }]).success).toBe(false)
    expect(request([{ name: 'Sales', files: [], rebuildLog: true }]).success).toBe(false)
    expect(request([{ name: 'x'.repeat(129), files: ['C:\\a.mdf'], rebuildLog: true }]).success).toBe(false)
    expect(request([{ name: 'Sales', files: ['C:\\' + 'a'.repeat(300) + '.mdf'], rebuildLog: true }]).success).toBe(false)
    expect(request([{ name: 'Sales', files: ['C:\\a\u0000.mdf'], rebuildLog: true }]).success).toBe(false)
    expect(request([{ name: 'Sales', files: ['C:\\a.mdf'], rebuildLog: true, extra: 1 }]).success).toBe(false)
    // A folder's action acts on the server alone.
    expect(request([{ name: 'Sales', files: ['C:\\a.mdf'], rebuildLog: true }], { kind: 'database', name: 'Sales' }).success).toBe(false)
    expect(actionTargetProblems({ kind: 'server', name: 'x' }, 'attach')).not.toEqual([])
    expect(actionTargetProblems(server, 'attach')).toEqual([])
  })
  it('refuses a name twice, or a file twice in one database', () => {
    expect(attachProblems([{ name: 'A', files: ['C:\\a.mdf'], rebuildLog: true }, { name: 'A', files: ['C:\\b.mdf'], rebuildLog: true }])).toHaveLength(1)
    expect(attachProblems([{ name: 'A', files: ['C:\\a.mdf', 'C:\\a.mdf'], rebuildLog: true }])).toHaveLength(1)
    expect(attachProblems([{ name: 'A', files: ['C:\\a.mdf'], rebuildLog: true }, { name: 'B', files: ['C:\\b.mdf'], rebuildLog: true }])).toEqual([])
    expect(request([{ name: 'A', files: ['C:\\a.mdf'], rebuildLog: true }, { name: 'A', files: ['C:\\b.mdf'], rebuildLog: true }]).success).toBe(false)
  })
  it('reads a primary data file only for Attach Databases, by a bounded path', () => {
    const describe = (dialog: string, attach: unknown) => actionDescribeSchema.safeParse({ ...ids, dialog, target: server, attach })
    expect(describe('attachDatabase', { mdf: 'C:\\Data\\Sales.mdf' }).success).toBe(true)
    expect(describe('attachDatabase', undefined).success).toBe(true)
    expect(describe('deleteObject', { mdf: 'C:\\Data\\Sales.mdf' }).success).toBe(false)
    expect(describe('attachDatabase', { mdf: '' }).success).toBe(false)
    expect(describe('attachDatabase', { mdf: 'C:\\Data\\Sales.mdf', more: true }).success).toBe(false)
  })
})

describe('attach draft', () => {
  it('builds the request in row order, rebuilding the log for a database whose log files were all removed', () => {
    expect(attachRequest(initialAttachDraft())).toBeUndefined()
    const built = attachRequest(draftOf([row(1, 'Sales', { owner: 'app_owner', name: 'Sales_Copy' }), row(2, 'Hr', { files: [row(2, 'Hr').files[0]] })]))
    expect(built).toEqual({
      action: 'attach', target: server,
      databases: [{ name: 'Sales_Copy', owner: 'app_owner', files: ['C:\\Data\\Sales.mdf', 'C:\\Data\\Sales_log.ldf'], rebuildLog: false }, { name: 'Hr', files: ['C:\\Data\\Hr.mdf'], rebuildLog: true }]
    })
  })
  it('blocks OK while a data file is not found, a name is empty, or two rows share a name', () => {
    expect(attachBlocked(draftOf([row(1, 'Sales')]))).toBeUndefined()
    const missing = row(1, 'Sales', { files: [row(1, 'Sales').files[0], { original: 'x.ndf', type: 'data', current: 'D:\\x.ndf', found: false }] })
    expect(attachBlocked(draftOf([missing]))).toBe(attachMessages.missingData('Sales'))
    expect(attachRequest(draftOf([missing]))).toEqual({ problem: attachMessages.missingData('Sales') })
    // A missing log file does not block: removing it rebuilds the log, and SQL Server says why if it is needed.
    expect(attachBlocked(draftOf([row(1, 'Sales', { files: [row(1, 'Sales').files[0], { original: 'l.ldf', type: 'log', current: 'D:\\l.ldf', found: false }] })]))).toBeUndefined()
    expect(attachBlocked(draftOf([row(1, 'Sales', { name: '' })]))).toBe(attachMessages.name)
    expect(attachBlocked(draftOf([row(1, 'Sales'), row(2, 'Hr', { name: 'Sales' })]))).toBe(attachMessages.duplicate('Sales'))
  })
  it('blocks OK while Add… reads a file, any path is checked, or a typed data path waits for its check', () => {
    // The dialog takes no answer while OK runs, so OK waits for these rather than drop them (leaving Add… or a row stuck).
    expect(attachBlocked(draftOf([row(1, 'Sales')], { adding: true }))).toBe(attachMessages.reading)
    expect(attachRequest(draftOf([row(1, 'Sales')], { adding: true }))).toEqual({ problem: attachMessages.reading })
    const log = (changes: Partial<AttachRow['files'][number]>) => row(1, 'Sales', { files: [row(1, 'Sales').files[0], { ...row(1, 'Sales').files[1], ...changes }] })
    const data = (changes: Partial<AttachRow['files'][number]>) => row(1, 'Sales', { files: [{ ...row(1, 'Sales').files[0], ...changes }, row(1, 'Sales').files[1]] })
    expect(attachBlocked(draftOf([log({ checking: true, unchecked: true })]))).toBe(attachMessages.checking('Sales'))
    expect(attachBlocked(draftOf([data({ checking: true, unchecked: true })]))).toBe(attachMessages.checking('Sales'))
    expect(attachBlocked(draftOf([data({ found: undefined, unchecked: true })]))).toBe(attachMessages.unchecked('Sales'))
    // A typed log path is checked too, but a log that is not found does not block (SQL Server rebuilds or refuses).
    expect(attachBlocked(draftOf([log({ found: undefined, unchecked: true })]))).toBeUndefined()
  })
  it('reads each row\'s Status from the steps that name its database', () => {
    const rows = [row(1, 'Sales', { owner: 'app_owner' }), row(2, 'Hr'), row(3, 'Ops')]
    const step = (title: string, status: ActionStep['status'], detail: string, extra: Partial<ActionStep> = {}): ActionStep => ({ title, status, detail, ...extra })
    expect(attachRowStates(rows, 'executing', undefined).map(state => state.status)).toEqual(['In progress', 'In progress', 'In progress'])
    expect(attachRowStates(rows, 'ready', undefined).map(state => state.status)).toEqual(['', '', ''])
    const failed: ActionStep[] = [
      step('Attach the database', 'done', 'Sales'), step('Set the database owner', 'done', 'Sales'), step('Attach the database', 'failed', 'Hr', { message: 'Unable to open the physical file.' }),
      step('Attach the database', 'skipped', 'Ops'), step('Detach the database again', 'done', 'Sales', { compensates: true })
    ]
    expect(attachRowStates(rows, 'failed', failed)).toEqual([{ status: 'Rolled Back', message: attachMessages.rolledBack }, { status: 'Error', message: 'Unable to open the physical file.' }, { status: '', message: '' }])
    // A detach that failed leaves the database attached, and says so.
    const kept = failed.map(item => item.compensates ? { ...item, status: 'failed' as const, message: 'In use.' } : item)
    expect(attachRowStates(rows, 'failed', kept)[0]).toEqual({ status: 'Success', message: attachMessages.keptAttached('In use.') })
    const stopped: ActionStep[] = [step('Attach the database', 'done', 'Sales'), step('Set the database owner', 'cancelled', 'Sales'), step('Detach the database again', 'done', 'Sales', { compensates: true })]
    expect(attachRowStates(rows, 'stopped', stopped)[0].status).toBe('Stopped')
    expect(attachRowStates([row(1, 'Renamed')], 'failed', failed)[0].status).toBe('')
  })
})

/** The page's operations over a fake dialog: the picker and describes answer what a test queues. */
function host(initial: AttachDraft = initialAttachDraft(), phase: DialogPhase = 'ready') {
  const state = { current: { phase, model: facts, draft: initial as AttachDraft } }
  const picks: (string | undefined)[] = [], answers: ApiResult<ActionDescribeResult>[] = []
  const fake = {
    get current() { return state.current },
    updateDraft: vi.fn((patch: (draft: AttachDraft) => Partial<AttachDraft>) => { state.current = { ...state.current, draft: { ...state.current.draft, ...patch(state.current.draft) } } }),
    pickServerFile: vi.fn(async (_request: Parameters<AttachHost['pickServerFile']>[0]) => picks.shift()),
    describeMore: vi.fn(async (_request: Parameters<AttachHost['describeMore']>[0]) => answers.shift())
  } satisfies AttachHost
  return { fake, picks, answers, draft: () => state.current.draft, setPhase: (next: DialogPhase) => { state.current = { ...state.current, phase: next } } }
}
const described = (database = sales): ApiResult<ActionDescribeResult> => ({ ok: true, value: { elapsedMs: 1, attachDatabase: { server: facts, database } } })

describe('attach operations', () => {
  it('Add… opens Locate Database Files in the default data folder, then lists the database its .mdf names', async () => {
    const { fake, picks, answers, draft } = host()
    picks.push('C:\\Data\\Sales.mdf')
    answers.push(described())
    await addAttachDatabase(fake)
    expect(fake.pickServerFile.mock.calls).toEqual([[{ purpose: 'database', initialPath: 'C:\\Data\\', mustExist: true }]])
    expect(fake.describeMore.mock.calls).toEqual([[{ attach: { mdf: 'C:\\Data\\Sales.mdf' } }]])
    expect(draft().rows).toEqual([{ key: 1, mdf: 'C:\\Data\\Sales.mdf', databaseName: 'Sales', name: 'Sales', files: sales!.files }])
    expect(draft()).toMatchObject({ selected: 1, adding: false, nextKey: 2 })
    // The next Add… opens in the last file's folder; the same file again is refused before it is read.
    picks.push('C:\\Data\\Sales.mdf')
    await addAttachDatabase(fake)
    expect(fake.pickServerFile.mock.calls[1]).toEqual([{ purpose: 'database', initialPath: 'C:\\Data\\', mustExist: true }])
    expect(fake.describeMore).toHaveBeenCalledTimes(1)
    expect(draft().problem).toBe(attachMessages.listed('C:\\Data\\Sales.mdf'))
  })
  it('Add… shows why a file could not be read, and nothing happens when the picker is cancelled', async () => {
    const { fake, picks, answers, draft } = host()
    picks.push(undefined)
    await addAttachDatabase(fake)
    expect(fake.describeMore).not.toHaveBeenCalled()
    expect(draft()).toMatchObject({ rows: [], adding: false })
    picks.push('C:\\Data\\Notes.mdf')
    answers.push({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_SUPPORTED', message: 'C:\\Data\\Notes.mdf is not a primary data file.', retryable: false } } })
    await addAttachDatabase(fake)
    expect(draft()).toMatchObject({ rows: [], adding: false, problem: 'C:\\Data\\Notes.mdf is not a primary data file.' })
  })
  it('stops at the limit of databases, and changes nothing while OK runs', async () => {
    const full = draftOf(Array.from({ length: actionLimits.attachDatabases }, (_, index) => row(index + 1, `d${index}`)))
    const { fake, draft } = host(full)
    await addAttachDatabase(fake)
    expect(fake.pickServerFile).not.toHaveBeenCalled()
    expect(draft().problem).toBe(attachMessages.limit)
    const running = host(draftOf([row(1, 'Sales')]), 'executing')
    setAttachName(running.fake, 1, 'Other')
    removeAttachDatabase(running.fake)
    await addAttachDatabase(running.fake)
    expect(running.fake.updateDraft).not.toHaveBeenCalled()
  })
  it('edits Attach As and Owner, removes the selected row, and removes log files only', () => {
    const { fake, draft } = host(draftOf([row(1, 'Sales'), row(2, 'Hr')], { selected: 1 }))
    setAttachName(fake, 2, 'Hr_Copy')
    setAttachOwner(fake, 2, 'app_owner')
    expect(draft().rows[1]).toMatchObject({ name: 'Hr_Copy', owner: 'app_owner' })
    setAttachOwner(fake, 2, undefined)
    expect('owner' in draft().rows[1]).toBe(false)
    removeAttachFile(fake, 2, 0)
    expect(draft().rows[1].files).toHaveLength(2)
    removeAttachFile(fake, 2, 1)
    expect(draft().rows[1].files.map(file => file.type)).toEqual(['data'])
    removeAttachDatabase(fake)
    expect(draft()).toMatchObject({ selected: 2 })
    expect(draft().rows.map(item => item.key)).toEqual([2])
  })
  it('checks a typed path when the field is left, and "…" picks one the picker found', async () => {
    const { fake, picks, answers, draft } = host(draftOf([row(1, 'Sales')], { selected: 1 }))
    setAttachFilePath(fake, 1, 0, 'E:\\Moved\\Sales.mdf')
    // Typing does not turn "Not found" into a path OK would take: the path waits for its check (Enter, or leaving the field).
    expect(draft().rows[0].files[0]).toEqual({ original: 'C:\\Data\\Sales.mdf', type: 'data', current: 'E:\\Moved\\Sales.mdf', unchecked: true })
    expect(attachBlocked(draft())).toBe(attachMessages.unchecked('Sales'))
    answers.push({ ok: true, value: { elapsedMs: 1, serverFiles: { separator: '\\', path: 'E:\\Moved\\Sales.mdf', roots: [], entries: [], truncated: false } } })
    const checked = checkAttachFile(fake, 1, 0)
    expect(draft().rows[0].files[0]).toMatchObject({ checking: true })
    expect(attachBlocked(draft())).toBe(attachMessages.checking('Sales'))
    await checked
    expect(fake.describeMore.mock.calls).toEqual([[{ dialog: 'serverFiles', files: { purpose: 'database', path: 'E:\\Moved\\Sales.mdf', exists: true } }]])
    expect(draft().rows[0].files[0]).toEqual({ original: 'C:\\Data\\Sales.mdf', type: 'data', current: 'E:\\Moved\\Sales.mdf', found: false })
    expect(attachBlocked(draft())).toBe(attachMessages.missingData('Sales'))
    // Checked once, it is not checked again until it is typed again.
    await checkAttachFile(fake, 1, 0)
    expect(fake.describeMore).toHaveBeenCalledTimes(1)
    // SQL Server 2016 outside sysadmin: unknown, so OK stays possible and SQL Server decides.
    setAttachFilePath(fake, 1, 0, 'F:\\Sales.mdf')
    answers.push({ ok: true, value: { elapsedMs: 1, serverFiles: { separator: '\\', path: 'F:\\Sales.mdf', roots: [], entries: [], truncated: false, notice: 'legacyEmpty' } } })
    await checkAttachFile(fake, 1, 0)
    expect(draft().rows[0].files[0].found).toBeUndefined()
    expect(attachBlocked(draft())).toBeUndefined()
    picks.push('G:\\Sales.mdf')
    await browseAttachFile(fake, 1, 0)
    expect(fake.pickServerFile.mock.calls.at(-1)).toEqual([{ purpose: 'database', initialPath: 'F:\\Sales.mdf', mustExist: true }])
    expect(draft().rows[0].files[0]).toEqual({ original: 'C:\\Data\\Sales.mdf', type: 'data', current: 'G:\\Sales.mdf', found: true })
    // A log file browses for .ldf files.
    picks.push(undefined)
    await browseAttachFile(fake, 1, 1)
    expect(fake.pickServerFile.mock.calls.at(-1)?.[0]).toMatchObject({ purpose: 'log' })
  })
})

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

describe('Attach Databases dialog', () => {
  function setup() {
    const execute = deferred<ApiResult<ActionExecuteResult>>()
    const api = {
      describeObject: vi.fn<VariaApi['describeObject']>(async params => ({ ok: true, value: { elapsedMs: 1, attachDatabase: { server: facts, ...params.attach ? { database: sales } : {} } } })),
      scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(),
      executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(() => execute.promise),
      cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
      writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(),
      confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>()
    }
    const connections = new ConnectionService()
    connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
    const explorer = { listingFolderOf: vi.fn(() => 99 as number | undefined), reconcile: vi.fn() }
    const run = { dispose: vi.fn() }
    const longRuns = { begin: vi.fn((_run: { readonly kind: string; readonly connectionId: string; readonly server: string }) => run) }
    const serverFiles = { pick: vi.fn(async () => 'C:\\Data\\Sales.mdf' as string | undefined) }
    let count = 0
    const dialogs = new ObjectDialogService({ api, connections, explorer, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() }, serverFiles, longRuns, newId: () => `id-${++count}` })
    cleanups.push(() => dialogs.dispose())
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))
    return { dialogs, api, explorer, longRuns, run, serverFiles, execute, settle }
  }
  const folder: ExplorerMenuNode = { id: 5, connectionId: 'server-a', ref: { type: 'folder', owner: server, folder: 'databases' }, kind: 'folder', folder: 'databases', label: 'Databases', lost: false }

  it('opens on the Databases folder with the server as its target, and nowhere else', async () => {
    const { dialogs, api, settle } = setup()
    expect(() => dialogs.open('attachDatabase', { ...folder, ref: { type: 'folder', owner: server, folder: 'tables' }, folder: 'tables' })).toThrow()
    expect(() => dialogs.open('attachDatabase', { id: 6, connectionId: 'server-a', ref: { type: 'object', object: { kind: 'database', name: 'Sales' } }, kind: 'database', label: 'Sales', lost: false })).toThrow()
    expect(dialogs.current).toBeUndefined()
    dialogs.open('attachDatabase', folder)
    expect(dialogs.current).toMatchObject({ dialog: 'attachDatabase', folder: true, target: server, label: 'server-a.example', title: 'Attach Databases' })
    expect(api.describeObject.mock.calls).toEqual([[{ connectionId: 'server-a', requestId: 'id-1', dialog: 'attachDatabase', target: server }]])
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', model: facts, draft: { rows: [], nextKey: 1 } })
  })
  it('reads an .mdf through the picker, runs OK as a long run, and selects the attached database in the folder', async () => {
    const { dialogs, api, explorer, longRuns, run, serverFiles, execute, settle } = setup()
    dialogs.open('attachDatabase', folder)
    await settle()
    await addAttachDatabase(dialogs as unknown as AttachHost)
    expect(serverFiles.pick.mock.calls).toEqual([[{ connectionId: 'server-a', purpose: 'database', initialPath: 'C:\\Data\\', mustExist: true }]])
    expect(api.describeObject.mock.calls[1][0]).toEqual({ connectionId: 'server-a', requestId: 'id-2', dialog: 'attachDatabase', target: server, attach: { mdf: 'C:\\Data\\Sales.mdf' } })
    expect((dialogs.current?.draft as AttachDraft).rows.map(item => item.name)).toEqual(['Sales'])
    // Sales_2.ndf is not found, so OK is blocked until it is found or corrected.
    expect(attachDatabaseDefinition.blocked?.(facts, dialogs.current?.draft as AttachDraft)).toBe(attachMessages.missingData('Sales'))
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current?.error?.message).toBe(attachMessages.missingData('Sales'))
    dialogs.updateDraft(draft => ({ rows: (draft as AttachDraft).rows.map(item => ({ ...item, files: item.files.filter(file => file.found !== false) })) }))
    const ok = dialogs.ok()
    expect(longRuns.begin.mock.calls[0]).toMatchObject([{ kind: 'attach', connectionId: 'server-a', server: 'server-a.example' }])
    expect(api.executeObjectAction.mock.calls[0][0]).toEqual({ action: 'attach', target: server, databases: [{ name: 'Sales', files: ['C:\\Data\\Sales.mdf', 'D:\\Old\\Sales_log.ldf'], rebuildLog: false }], connectionId: 'server-a', requestId: 'id-3' })
    expect(run.dispose).not.toHaveBeenCalled()
    execute.resolve({ ok: true, value: { steps: [{ title: 'Attach the database', status: 'done', detail: 'Sales' }], messages: [], elapsedMs: 1 } })
    await ok
    expect(run.dispose).toHaveBeenCalledTimes(1)
    expect(dialogs.current).toBeUndefined()
    // The folder it opened on is the listing; the attached database is selected once it is listed.
    expect(explorer.listingFolderOf).not.toHaveBeenCalled()
    expect(explorer.reconcile.mock.calls).toEqual([[5, { select: { type: 'object', object: { kind: 'database', name: 'Sales' } } }]])
  })
  it('ends the long run when OK fails, keeps the rows, and cancels a page\'s describe on Close', async () => {
    const { dialogs, api, run, execute, settle } = setup()
    dialogs.open('attachDatabase', folder)
    await settle()
    dialogs.updateDraft({ rows: [row(1, 'Sales')], nextKey: 2 } as Partial<AttachDraft>)
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ title: 'Attach the database', status: 'failed', detail: 'Sales', message: 'Unable to open.' }], messages: [], elapsedMs: 1, error: { code: 'FILE_ACCESS', message: 'Unable to open.', retryable: true } } })
    await ok
    expect(run.dispose).toHaveBeenCalledTimes(1)
    expect(dialogs.current).toMatchObject({ phase: 'failed', error: { code: 'FILE_ACCESS' } })
    expect(attachRowStates((dialogs.current?.draft as AttachDraft).rows, 'failed', dialogs.current?.steps)[0]).toEqual({ status: 'Error', message: 'Unable to open.' })
    const held = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(held.promise)
    const more = dialogs.describeMore({ attach: { mdf: 'C:\\Data\\Hr.mdf' } })
    expect(dialogs.close()).toBe(true)
    expect(api.cancelObjectActions.mock.calls.at(-1)).toEqual([['id-3']])
    held.resolve(described())
    expect(await more).toBeUndefined()
  })
  it('reloads Databases after a Stop that reached an attach, whose database may be attached and detached again', async () => {
    const { dialogs, explorer, execute, settle } = setup()
    dialogs.open('attachDatabase', folder)
    await settle()
    dialogs.updateDraft({ rows: [row(1, 'Sales')], nextKey: 2 } as Partial<AttachDraft>)
    const ok = dialogs.ok()
    execute.resolve({ ok: true, value: { steps: [{ title: 'Attach the database', status: 'cancelled', detail: 'Sales' }], messages: [], elapsedMs: 1, error: { code: 'CANCELLED', message: 'Stopped.', retryable: false } } })
    await ok
    expect(dialogs.current).toMatchObject({ phase: 'stopped' })
    expect(explorer.reconcile.mock.calls).toEqual([[5]])
  })
  it('does not run OK while Add… reads a file, so its answer is never dropped', async () => {
    const { dialogs, api, settle } = setup()
    dialogs.open('attachDatabase', folder)
    await settle()
    const held = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(held.promise)
    dialogs.updateDraft({ rows: [row(1, 'Hr')], nextKey: 2 } as Partial<AttachDraft>)
    const adding = addAttachDatabase(dialogs as unknown as AttachHost)
    await settle()
    expect((dialogs.current?.draft as AttachDraft).adding).toBe(true)
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current?.error?.message).toBe(attachMessages.reading)
    held.resolve(described())
    await adding
    expect(dialogs.current?.draft).toMatchObject({ adding: false, rows: [{ name: 'Hr' }, { name: 'Sales' }] })
  })
})

describe('Attach command', () => {
  it('runs on the Databases folder of a live SQL Server only, opening Attach Databases, and not while a dialog is open', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connections.add(connectionInfo('server-a'), connectionOptions)
    const databases: ExplorerMenuNode = { id: 4, connectionId: 'server-a', ref: { type: 'folder', owner: server, folder: 'databases' }, kind: 'folder', folder: 'databases', label: 'Databases', lost: false }
    const on = (node: ExplorerMenuNode) => ({ target: { kind: 'explorer' as const, node } })
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ ...databases, ref: { type: 'folder', owner: server, folder: 'systemDatabases' }, folder: 'systemDatabases' }))).toBe(false)
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ id: 6, connectionId: 'server-a', ref: { type: 'object', object: { kind: 'database', name: 'Sales' } }, kind: 'database', label: 'Sales', lost: false }))).toBe(false)
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ ...databases, engine: 'managedInstance' }))).toBe(false)
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ ...databases, lost: true }))).toBe(false)
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ ...databases, connectionId: 'server-b' }))).toBe(false)
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ ...databases, engine: 'box' }))).toBe(true)
    await fixture.commands.run('explorer.attachDatabase', on({ ...databases, engine: 'box' }))
    expect(fixture.dialogs.current).toMatchObject({ dialog: 'attachDatabase', folder: true, target: server, nodeId: 4 })
    expect(fixture.commands.canRun('explorer.attachDatabase', on({ ...databases, engine: 'box' }))).toBe(false)
  })
})
