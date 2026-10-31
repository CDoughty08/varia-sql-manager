import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionLimits } from '../src/shared/actions/catalog'
import {
  changedFrom, defaultFileName, fileNameProblem, filegroupChanges, newDatabaseBaseline, newDatabaseProblems, newDatabaseStatements, sanitiseFileName, type NewDatabaseDesign, type NewDatabaseFacts,
  type NewDatabaseModel
} from '../src/shared/actions/new-database'
import { actionRequestSchema, type ActionDescribeResult, type ActionExecuteResult, type ActionRequest, type ActionScriptResult } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import { setScriptOpen } from '../src/renderer/src/kit/document-frame'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { newDatabaseDesign, newDatabaseMessages, previewDelayMs } from '../src/renderer/src/new-database/NewDatabaseService'
import { databaseModel } from './fixtures/database-properties'
import { deferred } from './fixtures/documents'
import { connectionInfo, manualTimers, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

const windows: NewDatabaseFacts = { level: 16, separator: '\\', linux: false, filestreamLevel: 0, containedAuthentication: false }
const linux: NewDatabaseFacts = { ...windows, separator: '/', linux: true }
/** The design New Database starts with for Sales on a Windows server. */
const design = (patch: Partial<NewDatabaseDesign> = {}): NewDatabaseDesign => ({
  files: [
    { name: 'Sales', type: 'rows', filegroup: 'PRIMARY', sizeMb: 8, growth: { enabled: true, unit: 'mb', by: 64 }, path: 'C:\\Data', fileName: 'Sales.mdf' },
    { name: 'Sales_log', type: 'log', sizeMb: 8, growth: { enabled: true, unit: 'mb', by: 64 }, path: 'C:\\Data', fileName: 'Sales_log.ldf' }
  ],
  filegroups: [{ name: 'PRIMARY', type: 'rows', isDefault: true }], containment: 'NONE', options: {}, scoped: {}, ...patch
})
const messages = (name: string, value: NewDatabaseDesign, facts?: NewDatabaseFacts) => newDatabaseProblems(name, value, facts).map(problem => problem.message)

describe('New Database without the DOM', () => {
  it('names files as SSMS does, made safe for the server\'s platform (critic A23)', () => {
    expect(defaultFileName('Sales', 'rows', true, '\\')).toBe('Sales.mdf')
    expect(defaultFileName('Sales2', 'rows', false, '\\')).toBe('Sales2.ndf')
    expect(defaultFileName('Sales_log', 'log', false, '/')).toBe('Sales_log.ldf')
    expect(defaultFileName('Stream', 'filestream', false, '\\')).toBe('Stream')
    // Windows refuses \ / : * ? " < > |, trailing dots and spaces, and device names; Linux only / and what ServerPath refuses.
    expect(sanitiseFileName('a\\b/c:d*e?"<>|', '\\')).toBe('a_b_c_d_e_____')
    expect(sanitiseFileName('a\\b:c', '/')).toBe('a\\b:c')
    expect(sanitiseFileName('a/b', '/')).toBe('a_b')
    expect(sanitiseFileName('name. ', '\\')).toBe('name__')
    expect(sanitiseFileName('CON', '\\')).toBe('_CON')
    expect(sanitiseFileName('con.txt', '\\')).toBe('_con.txt')
    expect(sanitiseFileName('CON', '/')).toBe('CON')
    expect(sanitiseFileName('..', '/')).toBe('_')
    expect(sanitiseFileName('a\u0001b\uD800', '\\')).toBe('a_b_')
    // The extension always fits; a long name is cut, never between the halves of a pair.
    const long = defaultFileName('x'.repeat(actionLimits.serverPath - 5) + '\u{1F600}', 'rows', true, '\\')
    expect(long.endsWith('.mdf')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(actionLimits.serverPath)
    expect(/[\uD800-\uDBFF]\.mdf$/.test(long)).toBe(false)
    expect(fileNameProblem('a:b.mdf', '\\')).toMatch(/cannot contain/)
    expect(fileNameProblem('a:b.mdf', '/')).toBeUndefined()
    expect(fileNameProblem('NUL', '\\')).toMatch(/device name/)
    expect(fileNameProblem('x.', '\\')).toMatch(/dot or a space/)
  })
  it('accepts the starting design and refuses what SQL Server or the document would', () => {
    expect(newDatabaseProblems('Sales', design(), windows)).toEqual([])
    expect(messages('', design())).toContain('Enter a database name.')
    expect(messages('tempdb', design())).toContain('tempdb is a system database\'s name.')
    expect(messages('Sales', design({ files: [design().files[0]] }))).toContain('A database needs a log file.')
    const twice = design({ files: [...design().files, { ...design().files[1], name: 'SALES_LOG' }] })
    expect(messages('Sales', twice)).toEqual(expect.arrayContaining(['Two files are named SALES_LOG.']))
    const samePath = design({ files: [...design().files, { ...design().files[1], name: 'other', fileName: 'sales_log.LDF' }] })
    expect(messages('Sales', samePath, windows)).toEqual(['Two files have the path C:\\Data\\sales_log.LDF.'])
    // A filegroup needs a file; Linux has no FILESTREAM; ledger needs 2022; Partial needs contained authentication.
    const empty = design({ filegroups: [...design().filegroups, { name: 'Archive', type: 'rows' }] })
    expect(messages('Sales', empty)).toEqual(['The filegroup Archive has no files. Add a file to it, or remove it.'])
    const stream = design({ files: [...design().files, { name: 'Stream', type: 'filestream', filegroup: 'FS', growth: { enabled: false }, path: '/var/opt', fileName: 'Stream' }], filegroups: [...design().filegroups, { name: 'FS', type: 'filestream' }] })
    expect(messages('Sales', stream, linux)).toContain('SQL Server on Linux has no FILESTREAM.')
    expect(messages('Sales', stream, windows)).toContain('FILESTREAM is not enabled on this server.')
    expect(messages('Sales', design({ ledger: true }), { ...windows, level: 15 })).toEqual(['A ledger database needs SQL Server 2022 or later.'])
    expect(messages('Sales', design({ containment: 'PARTIAL' }), windows)).toEqual(['Partial containment needs the server option contained database authentication.'])
    // Limits.
    const big = design({ files: [{ ...design().files[0], sizeMb: actionLimits.dataFileMb + 1 }, design().files[1]] })
    expect(messages('Sales', big)[0]).toMatch(/initial size is a whole number of MB from 1 to 16,777,216/)
    const log = design({ files: [design().files[0], { ...design().files[1], sizeMb: actionLimits.logFileMb + 1 }] })
    expect(messages('Sales', log)[0]).toMatch(/from 1 to 2,097,152/)
    const growth = design({ files: [{ ...design().files[0], growth: { enabled: true, unit: 'percent', by: 101 } }, design().files[1]] })
    expect(messages('Sales', growth)[0]).toMatch(/percent is a whole number from 1 to 100/)
    const max = design({ files: [{ ...design().files[0], growth: { enabled: true, unit: 'mb', by: 1, maxMb: 4 } }, design().files[1]] })
    expect(messages('Sales', max)[0]).toMatch(/maximum file size/)
  })
  it('orders the filegroup changes after CREATE and counts every statement', () => {
    const value = design({
      files: [...design().files, { ...design().files[0], name: 'a', filegroup: 'A', fileName: 'a.ndf' }, { ...design().files[0], name: 'b', filegroup: 'B', fileName: 'b.ndf' }],
      filegroups: [{ name: 'PRIMARY', type: 'rows' }, { name: 'A', type: 'rows', isDefault: true, autogrowAllFiles: true }, { name: 'B', type: 'rows', readOnly: true }],
      owner: 'AppUser', options: { recoveryModel: 'SIMPLE', autoCreateStatistics: 'true', autoCreateIncrementalStatistics: 'true' }, scoped: { maxDop: '4' }
    })
    expect(filegroupChanges(value)).toEqual([{ kind: 'autogrowAll', filegroup: 'A' }, { kind: 'default', filegroup: 'A' }, { kind: 'readOnly', filegroup: 'B' }])
    // CREATE, two option statements (incremental statistics shares one), a scoped one, three filegroup changes and the owner.
    expect(newDatabaseStatements(value)).toBe(1 + 2 + 1 + 3 + 1)
    expect(newDatabaseProblems('Sales', value, windows)).toEqual([])
  })
  it('starts from model\'s options and sends only what differs from them', () => {
    const model = databaseModel()
    const baseline = newDatabaseBaseline(model)
    expect(baseline.options).toMatchObject({ recoveryModel: 'FULL', autoClose: 'false' })
    // CREATE DATABASE writes collation and containment itself, and what cannot be set is never sent.
    expect(baseline.options).not.toHaveProperty('collation')
    expect(baseline.options).not.toHaveProperty('containmentType')
    expect(changedFrom(baseline.options, { ...baseline.options, recoveryModel: 'SIMPLE' })).toEqual({ recoveryModel: 'SIMPLE' })
    // CREATE DATABASE enables Service Broker whatever model says, so leaving it on sends nothing and turning it off is a change.
    const brokerOff = newDatabaseBaseline({ ...model, options: { ...model.options, brokerEnabled: 'false' } })
    expect(brokerOff.options.brokerEnabled).toBe('true')
    expect(changedFrom(brokerOff.options, brokerOff.options)).toEqual({})
    expect(changedFrom(brokerOff.options, { ...brokerOff.options, brokerEnabled: 'false' })).toEqual({ brokerEnabled: 'false' })
  })
  it('validates OK\'s request in main as the backend does', () => {
    const request = { action: 'createDatabase', connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), target: { kind: 'database', name: 'Sales' }, design: design() }
    expect(actionRequestSchema.safeParse(request).success).toBe(true)
    expect(actionRequestSchema.safeParse({ ...request, target: { kind: 'database', name: 'Sales', database: 'master' } }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, design: { ...design(), filestream: true } }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, target: { kind: 'database', name: 'model' } }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, design: design({ options: { collation: 'Latin1_General_BIN2' } }) }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, design: design({ files: Array.from({ length: actionLimits.newDatabaseFiles + 1 }, () => design().files[0]) }) }).success).toBe(false)
  })
})

const folderNode = (connectionId = 'c1', id = 3): ExplorerMenuNode => ({
  id, connectionId, ref: { type: 'folder', owner: { kind: 'server' }, folder: 'databases' }, kind: 'folder', folder: 'databases', label: 'Databases', lost: false, engine: 'box'
} as ExplorerMenuNode)
const newDatabaseModel = (patch: Partial<NewDatabaseModel> = {}): NewDatabaseModel => ({
  model: databaseModel(), dataPath: 'C:\\Data\\', logPath: 'C:\\Logs', serverCollation: 'Latin1_General_CI_AS', canCreate: true, masterLevel: 160, linux: false, ...patch
})
const created: ApiResult<ActionExecuteResult> = { ok: true, value: { steps: [{ status: 'done', title: 'Create the database' }], messages: [], elapsedMs: 1 } }

function opened(model = newDatabaseModel(), readFails = false) {
  const clock = manualTimers()
  const fixture = workbenchFixture({ timers: clock.timers })
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo('c1'))
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'newDatabase' ? { newDatabase: model, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.scriptObjectAction.mockImplementation(async () => ({ ok: true, value: { text: 'CREATE DATABASE [Sales]', database: 'master', warnings: [] } as ActionScriptResult }))
  if (readFails) fixture.api.describeObject.mockResolvedValueOnce({ ok: false, error: 'The server could not be read.' })
  const reconcile = vi.spyOn(fixture.explorer, 'reconcile').mockImplementation(() => {})
  const begin = vi.spyOn(fixture.longRuns, 'begin')
  const { newDatabase, documents } = fixture
  const id = newDatabase.open(folderNode())
  const state = () => newDatabase.get(id)!
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([request]) => request as ActionRequest)
  return { ...fixture, newDatabase, documents, id, state, executes, clock, reconcile, begin }
}

describe('New Database as a document', () => {
  it('opens a tab on master at once, reads model in master, and starts from model\'s files in the default folders', async () => {
    const { newDatabase, documents, id, state, api } = opened()
    expect(documents.active).toMatchObject({ id, kind: 'newDatabase', name: 'New Database', dirty: false, connectionId: 'c1', database: 'master' })
    expect(state()).toMatchObject({ phase: 'loading', server: 'c1.example', folderNodeId: 3 })
    await settled()
    expect(api.describeObject.mock.calls).toEqual([[expect.objectContaining({ connectionId: 'c1', dialog: 'newDatabase', target: { kind: 'server' } })]])
    expect(state()).toMatchObject({ phase: 'ready', name: '', owner: '', collation: '', containment: 'NONE' })
    expect(state().files.map(row => [row.type, row.sizeMb, row.path])).toEqual([['rows', 8, 'C:\\Data'], ['log', 8, 'C:\\Logs']])
    // The logical names follow the database's name until they are typed, and File Name follows the logical name.
    newDatabase.setName(id, 'Sales')
    expect(newDatabaseDesign(state()).files.map(file => [file.name, file.fileName])).toEqual([['Sales', 'Sales.mdf'], ['Sales_log', 'Sales_log.ldf']])
    newDatabase.setFile(id, state().files[1].key, { name: 'SalesLog' })
    newDatabase.setName(id, 'Sales2')
    expect(newDatabaseDesign(state()).files.map(file => [file.name, file.fileName])).toEqual([['Sales2', 'Sales2.mdf'], ['SalesLog', 'SalesLog.ldf']])
    // Never dirty: nothing to save, and Save All passes it by.
    expect(documents.get(id)?.dirty).toBe(false)
    expect(newDatabase.inSaveAll).toBe(false)
    // A database name a Windows server cannot use in a file name.
    newDatabase.setName(id, 'a:b')
    expect(newDatabaseDesign(state()).files[0].fileName).toBe('a_b.mdf')
  })
  it('sends only the options that differ from model', async () => {
    const { newDatabase, id, state } = opened()
    await settled()
    newDatabase.setName(id, 'Sales')
    expect(newDatabaseDesign(state())).toMatchObject({ options: {}, scoped: {}, containment: 'NONE' })
    expect(newDatabaseDesign(state())).not.toHaveProperty('owner')
    newDatabase.setOptions(id, { options: { ...state().options, recoveryModel: 'SIMPLE' }, scoped: state().scoped })
    newDatabase.setOwner(id, 'AppUser')
    newDatabase.setCollation(id, 'Latin1_General_BIN2')
    expect(newDatabaseDesign(state())).toMatchObject({ options: { recoveryModel: 'SIMPLE' }, owner: 'AppUser', collation: 'Latin1_General_BIN2' })
  })
  it('creates the database as a long run, closes the tab and selects the new database in Databases', async () => {
    const { newDatabase, documents, id, state, executes, api, reconcile, begin } = opened()
    await settled()
    expect(newDatabase.canCreate(id)).toBe(false)
    newDatabase.setName(id, 'Sales')
    expect(newDatabase.canCreate(id)).toBe(true)
    const answer = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(answer.promise)
    const running = newDatabase.create(id)
    expect(state().phase).toBe('creating')
    expect(begin.mock.calls).toEqual([[expect.objectContaining({ kind: 'newDatabase', connectionId: 'c1', server: 'c1.example', refused: expect.any(Function) })]])
    expect(api.setLongRuns).toHaveBeenCalled()
    // It never holds the document task, and the tab cannot close while it runs.
    expect(documents.getSnapshot().busy).toBeFalsy()
    expect(newDatabase.canClose(id)).toBe(newDatabaseMessages.creating)
    expect(executes()).toEqual([{ action: 'createDatabase', connectionId: 'c1', requestId: expect.any(String), target: { kind: 'database', name: 'Sales' }, design: newDatabaseDesign(state()) }])
    answer.resolve(created)
    expect(await running).toBe(true)
    expect(documents.getSnapshot().documents.some(document => document.id === id)).toBe(false)
    expect(reconcile.mock.calls).toEqual([[3, { select: { type: 'object', object: { kind: 'database', name: 'Sales' } } }]])
    expect(newDatabase.get(id)).toBeUndefined()
  })
  it('keeps the tab with the steps and the error when a later step fails, and reloads Databases for what was created', async () => {
    const { newDatabase, id, state, api, reconcile } = opened()
    await settled()
    newDatabase.setName(id, 'Sales')
    newDatabase.setOwner(id, 'Nobody')
    const failed: ApiResult<ActionExecuteResult> = { ok: true, value: { steps: [{ status: 'done', title: 'Create the database' }, { status: 'failed', title: 'Set the owner', message: 'Cannot find the principal.' }], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'Cannot find the principal.', retryable: true } } }
    api.executeObjectAction.mockResolvedValueOnce(failed)
    expect(await newDatabase.create(id)).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', error: { message: 'Cannot find the principal.' }, steps: [{ status: 'done' }, { status: 'failed' }] })
    expect(reconcile).toHaveBeenCalledTimes(1)
    // Nothing created: nothing to reload.
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'failed', title: 'Create the database' }], messages: [], elapsedMs: 1, error: { code: 'NAME_IN_USE', message: 'In use.', retryable: true } } })
    expect(await newDatabase.create(id)).toBe(false)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
  it('refuses OK with a problem and marks the fields, and Stop cancels the run in SQL Server', async () => {
    const { newDatabase, id, state, api, executes } = opened()
    await settled()
    expect(await newDatabase.create(id)).toBe(false)
    expect(executes()).toEqual([])
    expect(state()).toMatchObject({ touched: true, error: { message: 'Enter a database name.' } })
    newDatabase.setName(id, 'Sales')
    const answer = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(answer.promise)
    const running = newDatabase.create(id)
    newDatabase.stop(id)
    expect(api.cancelObjectActions.mock.calls.at(-1)?.[0]).toEqual([executes()[0].requestId])
    answer.resolve({ ok: false, error: 'Cancelled.', code: 'CANCELLED' })
    expect(await running).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', error: { code: 'CANCELLED', message: newDatabaseMessages.stopped } })
  })
  it('says the outcome is unknown when its server disconnects while it runs', async () => {
    const { newDatabase, connections, id, state, api } = opened()
    await settled()
    newDatabase.setName(id, 'Sales')
    const answer = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(answer.promise)
    const running = newDatabase.create(id)
    connections.remove('c1')
    expect(state()).toMatchObject({ phase: 'ready', error: { code: 'CONNECTION_LOST' } })
    answer.resolve(created)
    expect(await running).toBe(false)
    expect(newDatabase.canCreate(id)).toBe(false)
  })
  it('previews the script of the current design once the drawer opens, after a pause in typing', async () => {
    const { newDatabase, id, state, api, clock } = opened()
    await settled()
    newDatabase.setFrame(id, setScriptOpen(state().frame, true))
    clock.advance(0)
    await settled()
    expect(state().script).toEqual({ state: 'idle', message: newDatabaseMessages.noScript })
    expect(api.scriptObjectAction).not.toHaveBeenCalled()
    newDatabase.setName(id, 'Sales')
    clock.advance(previewDelayMs)
    await settled()
    expect(api.scriptObjectAction.mock.calls).toEqual([[expect.objectContaining({ action: 'createDatabase', target: { kind: 'database', name: 'Sales' } })]])
    expect(state().script).toEqual({ state: 'ready', text: 'CREATE DATABASE [Sales]' })
  })
  it('refuses a read that fails as a value, and Retry reads again', async () => {
    const { newDatabase, id, state } = opened(newDatabaseModel(), true)
    await settled()
    expect(state()).toMatchObject({ phase: 'loadFailed', error: { message: 'The server could not be read.' } })
    newDatabase.retry(id)
    await settled()
    expect(state().phase).toBe('ready')
  })
})
