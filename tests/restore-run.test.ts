import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { restoreStepTitles, type BackupSetRow, type RestoreModel, type RestoreServerFacts } from '../src/shared/actions/restore'
import type { RestoreRequest } from '../src/shared/actions/restore-schema'
import type { ActionDescribeResult, ActionExecuteResult, ActionProgress, ActionScriptResult } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import { longRunMessages } from '../src/shared/long-runs'
import { restoreServiceMessages } from '../src/renderer/src/restore/RestoreService'
import { confirmLines, confirmTabNames, outcomeOf, overallPercent, plannedSteps, restoredText, runSteps, sectionSummaries, setWhere, stopQuestion } from '../src/renderer/src/restore/run'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const settled = async () => { for (let turn = 0; turn < 12; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const conn = '00000000-0000-4000-8000-0000000000c1'
const row = (id: string, name: string, type: BackupSetRow['type'], position: number, first: string, last: string, checkpoint: string, base: string, finish: string, devices: string[]): BackupSetRow => ({
  id, name, type, server: 'SQLHOST', database: 'Sales', position, firstLsn: first, lastLsn: last, checkpointLsn: checkpoint, databaseBackupLsn: base,
  start: `2026-10-29T${finish}`, finish: `2026-10-29T${finish}`, sizeBytes: 2 * 1024 * 1024, userName: 'CONTOSO\\dba', copyOnly: false, damaged: false, devices
})
// A full striped over two files, a differential, and two logs after it: the plan is full, differential and log3.
const history = [
  row(uuid(5), 'log3', 'log', 3, '56800001', '68800001', '68800001', '43200001', '21:05:46', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(4), 'diff', 'differential', 1, '56800001', '68000001', '68000001', '43200001', '21:05:45', ['B:\\Backup\\Sales_diff.bak']),
  row(uuid(3), 'log2', 'log', 2, '51200001', '56800001', '56800001', '43200001', '21:05:44', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(2), 'log1', 'log', 1, '43200001', '51200001', '51200001', '43200001', '21:05:41', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(1), 'full', 'full', 1, '43200001', '45600001', '43200001', '0', '21:05:40', ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak'])
]
const sales = { name: 'Sales', id: 7, created: '2026-01-01T00:00:00.000', state: 'ONLINE', recoveryModel: 'FULL', sessions: 3, withTransaction: 1 }
const other = { name: 'Other', id: 9, created: '2026-01-02T00:00:00.000', state: 'ONLINE', recoveryModel: 'SIMPLE', sessions: 0 }
const server: RestoreServerFacts = {
  separator: '\\', dataPath: 'D:\\DATA\\', logPath: 'L:\\LOG\\', backupPath: 'B:\\Backup\\', canRestore: true, destinationsTruncated: false, filesTruncated: false,
  destinations: [sales, other], files: [{ database: 'Sales', path: 'D:\\DATA\\Sales.mdf' }, { database: 'Sales', path: 'L:\\LOG\\Sales_log.ldf' }]
}
const files = [{ logical: 'Sales', physical: 'D:\\DATA\\Sales.mdf', type: 'data' as const, filegroup: 'PRIMARY', sizeBytes: 8_388_608, fileId: 1 }, { logical: 'Sales_log', physical: 'L:\\LOG\\Sales_log.ldf', type: 'log' as const, sizeBytes: 8_388_608, fileId: 2 }]
const reply = (value: Partial<ActionExecuteResult>): ApiResult<ActionExecuteResult> => ({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, ...value } })

/** A Restore Database document on Sales, read; `facts` answers the server reads once it returns a value (the run's own read, say). */
async function opened(options: { readonly facts?: () => RestoreServerFacts | undefined } = {}) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo(conn))
  fixture.api.describeObject.mockImplementation(async params => {
    const source = params.restore
    const facts = options.facts?.() ?? server
    const model: RestoreModel = !source ? {} : source.kind === 'history' ? (source.database ? { server: facts, historyDatabases: ['Sales'], sets: history, setsTruncated: false } : { server: facts, historyDatabases: ['Sales'], historyTruncated: false })
      : { files, filesTruncated: false }
    return { ok: true, value: { elapsedMs: 1, restore: model } as ActionDescribeResult }
  })
  fixture.api.scriptObjectAction.mockImplementation(async () => ({ ok: true, value: { text: 'USE [master]\n', database: 'master', warnings: [] } as ActionScriptResult }))
  const pending = deferred<ApiResult<ActionExecuteResult>>()
  fixture.api.executeObjectAction.mockImplementation(() => pending.promise)
  const reconcile = vi.spyOn(fixture.explorer, 'reconcile')
  const id = fixture.restore.open(conn, 'Sales', 41)
  await settled()
  const state = () => fixture.restore.get(id)!
  const sent = () => fixture.api.executeObjectAction.mock.calls.map(([request]) => request as RestoreRequest)
  // Main's varia:actions-progress, as the preload delivers it.
  const progress = (value: Omit<ActionProgress, 'type'>) => { for (const [listener] of fixture.api.onActionProgress.mock.calls) listener({ type: 'action.progress', ...value } as ActionProgress) }
  const keys = () => { const values = fixture.context.getState(); return { runnable: values.restoreRunnable, running: values.restoreRunning, refreshable: values.restoreRefreshable, active: values.activeDocumentIsRestore } }
  return { ...fixture, id, state, sent, pending, progress, keys, reconcile }
}

describe('Restore Database\'s run, pure', () => {
  const request = (patch: Partial<RestoreRequest['restore']> = {}, identity = true): RestoreRequest => ({
    action: 'restore', connectionId: conn, requestId: uuid(9), target: { kind: 'database', name: 'Sales' }, ...identity ? { identity: { id: 7, created: '2026-01-01T00:00:00.000' } } : {},
    restore: {
      sets: [{ id: uuid(1), devices: ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak'], file: 1, type: 'full' }, { id: uuid(4), devices: ['B:\\Backup\\Sales_diff.bak'], file: 1, type: 'differential' },
        { id: uuid(2), devices: ['B:\\Backup\\Sales_log.trn'], file: 1, type: 'log' }, { id: uuid(3), devices: ['/var/opt/mssql/Sales_log.trn'], file: 2, type: 'log' }],
      relocate: [], replace: false, keepReplication: false, restrictedUser: false, recovery: 'recovery', closeConnections: true, tailLog: { file: 'B:\\Backup\\Sales_LogBackup.bak', noRecovery: true }, ...patch
    }
  })
  it('lists the steps RestoreRun.cs takes, in its order and with its titles: close, tail-log backup, a RESTORE per set, multi-user access', () => {
    expect(plannedSteps(request()).map(step => [step.title, step.detail ?? '', step.set])).toEqual([
      [restoreStepTitles.close, '', false], [restoreStepTitles.tailLog, 'Sales_LogBackup.bak', false], [restoreStepTitles.full, 'Sales_full1.bak (+1 files), position 1', true],
      [restoreStepTitles.differential, 'Sales_diff.bak, position 1', true], [`${restoreStepTitles.log} 1 of 2`, 'Sales_log.trn, position 1', true], [`${restoreStepTitles.log} 2 of 2`, 'Sales_log.trn, position 2', true],
      [restoreStepTitles.multiUser, '', false]
    ])
    // A new database has no connections to close, and NORECOVERY or Restrict access leaves its access alone; one log has no count.
    expect(plannedSteps(request({ tailLog: undefined, sets: request().restore.sets.slice(0, 3) }, false)).map(step => step.title)).toEqual([restoreStepTitles.full, restoreStepTitles.differential, restoreStepTitles.log])
    expect(plannedSteps(request({ recovery: 'norecovery' })).map(step => step.title)).not.toContain(restoreStepTitles.multiUser)
    expect(plannedSteps(request({ restrictedUser: true })).map(step => step.title)).not.toContain(restoreStepTitles.multiUser)
    expect(setWhere({ devices: ['C:\\a\\b.bak'] })).toBe('b.bak')
  })
  it('counts the sets done and the running set\'s percent alike for the overall percent, and shows the step in progress', () => {
    const planned = plannedSteps(request())
    expect(overallPercent(planned, undefined)).toBe(0)
    // Close and the tail-log backup count nothing; the full at 50 % is half of one set in four.
    expect(overallPercent(planned, { step: 1, percent: 100 })).toBe(0)
    expect(overallPercent(planned, { step: 2, percent: 50 })).toBe(13)
    expect(overallPercent(planned, { step: 5, percent: 100 })).toBe(100)
    const steps = runSteps(planned, undefined, { step: 2, percent: 40 }, true)
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'running', 'pending', 'pending', 'pending', 'pending'])
    expect(steps[2]).toMatchObject({ meta: '40 %', progress: 40, progressText: '40 percent processed' })
    // Before the first event, the first step runs; the reply's steps replace the plan, a stopped one keeping its percent.
    expect(runSteps(planned, undefined, undefined, true)[0]!.state).toBe('running')
    expect(runSteps(planned, [{ status: 'cancelled', title: restoreStepTitles.full, detail: 'Sales_full1.bak, position 1', progress: 30 }, { status: 'done', title: restoreStepTitles.remove, compensates: true }], undefined, false))
      .toEqual([{ state: 'cancelled', text: `${restoreStepTitles.full} (Sales_full1.bak, position 1)`, meta: '30 %' }, { state: 'done', text: restoreStepTitles.remove }])
  })
  it('names the outcome and the database\'s state as the run left it (critic A12)', () => {
    expect(outcomeOf(undefined, false)).toBe('done')
    expect(outcomeOf({ code: 'CANCELLED', message: 'Stopped.', retryable: true }, false)).toBe('stopped')
    expect(outcomeOf({ code: 'MEDIA', message: 'Bad.', retryable: false }, false)).toBe('failed')
    expect(outcomeOf(undefined, true)).toBe('unknown')
    expect(restoredText('Sales', { state: 0, userAccess: 0 }, true)).toBe('Sales is online.')
    expect(restoredText('Sales', { state: 0, userAccess: 1 }, true)).toBe('Sales is online in single-user mode.')
    expect(restoredText('Sales', { state: 1, userAccess: 0 }, true)).toBe('Sales is restoring and cannot be used until a restore finishes.')
    expect(restoredText('New', undefined, false)).toBe('New is not on the server: the partly restored database was removed.')
    expect(restoredText('Sales', undefined, true)).toBeUndefined()
    expect(stopQuestion('Sales', true)).toBe('Stop the restore? Stopping leaves Sales restoring and unusable until a restore finishes. Its previous contents are replaced as the restore runs (WITH REPLACE).')
  })
})

describe('Restore Database\'s confirm bar (owner decision 4, critic A7 and A11b)', () => {
  it('asks nothing for a new database, and only what applies over an existing one', async () => {
    const { restore, id, state } = await opened()
    const draft = state().draft!, facts = state().facts
    expect(confirmLines({ ...draft, destination: 'Brand_new', replace: true, closeConnections: true }, facts, { tabs: [] })).toEqual([])
    // Over itself with its tail-log backup and nothing to close: nothing to ask.
    expect(confirmLines({ ...draft, closeConnections: false }, facts, { tabs: [] })).toEqual([])
    expect(confirmLines({ ...draft, replace: true, tailLog: false, closeConnections: false }, facts, { tabs: [] })).toEqual([
      'Restoring over Sales replaces it. If the restore stops or fails part way, Sales is left restoring and cannot be used until a restore finishes.',
      'No tail-log backup is taken: changes to Sales since its last log backup will be lost.'
    ])
    // Another database replaced by Sales' backups: its contents are lost outright, and no tail-log backup is possible there.
    expect(confirmLines({ ...draft, destination: 'Other', replace: true, closeConnections: false }, facts, { tabs: [] })).toEqual([
      'Restoring over Other replaces it. If the restore stops or fails part way, Other is left restoring and cannot be used until a restore finishes.',
      'Other is not the database these backups are of (Sales): everything in it now is lost, and no tail-log backup can keep its recent changes.'
    ])
    // Closing connections names the sessions, those with open transactions, and Varia's own query windows in the database.
    const tabs = Array.from({ length: confirmTabNames + 2 }, (_, index) => `Query${index + 1}.sql`)
    expect(confirmLines({ ...draft, closeConnections: true }, facts, { tabs })).toEqual([
      'Closing existing connections ends 3 sessions in Sales; 1 of them has an open transaction, which is rolled back.',
      `Varia's query windows in Sales that are running or may have an open transaction: ${tabs.slice(0, confirmTabNames).join(', ')}, and 2 more.`
    ])
    const uncounted = { ...facts, server: { ...facts.server!, destinations: [{ ...sales, sessions: undefined, withTransaction: undefined }] } }
    expect(confirmLines({ ...draft, closeConnections: true }, uncounted, { tabs: [] })).toEqual(['Closing existing connections ends every session in Sales, and rolls back any open transaction.'])
    expect(restore.get(id)!.run).toBeUndefined()
  })
  it('reads the server again, waits on the bar, runs on Restore, and withdraws it on Cancel or a change', async () => {
    const { restore, id, state, api, sent, documents, sessionStates, keys } = await opened()
    // A query of this window in Sales with an open transaction, which closing connections would roll back.
    documents.newQuery('BEGIN TRAN', 'Orders.sql', conn, 'Sales')
    sessionStates.set(documents.active!.id, 2)
    documents.activate(id)
    restore.updateDraft(id, { replace: true, closeConnections: true })
    expect(keys()).toMatchObject({ active: true, runnable: true, running: false })
    const reads = api.describeObject.mock.calls.length
    await restore.run(id)
    expect(api.describeObject.mock.calls.length).toBe(reads + 1)
    expect(api.describeObject.mock.calls.at(-1)![0].restore).toEqual({ kind: 'history' })
    expect(state().run).toMatchObject({ phase: 'confirm', database: 'Sales', existed: true, replace: true })
    expect(state().run!.confirm).toEqual([
      'Restoring over Sales replaces it. If the restore stops or fails part way, Sales is left restoring and cannot be used until a restore finishes.',
      'Closing existing connections ends 3 sessions in Sales; 1 of them has an open transaction, which is rolled back.',
      'Varia\'s query windows in Sales that are running or may have an open transaction: Orders.sql.'
    ])
    expect(sent()).toEqual([])
    restore.cancelRun(id)
    expect(state().run).toBeUndefined()
    await restore.run(id)
    restore.updateDraft(id, { replace: false })
    expect(state().run).toBeUndefined()
    restore.updateDraft(id, { replace: true })
    await restore.run(id)
    void restore.confirmRun(id)
    await settled()
    expect(sent()).toHaveLength(1)
    expect(validateRequest('actions.execute', sent()[0])).toEqual(sent()[0])
    expect(sent()[0]).toMatchObject({ action: 'restore', target: { kind: 'database', name: 'Sales' }, identity: { id: 7 }, restore: { replace: true, closeConnections: true, tailLog: { noRecovery: true } } })
    expect(state().run).toMatchObject({ phase: 'running', requestId: sent()[0]!.requestId })
    expect(keys()).toMatchObject({ runnable: false, running: true, refreshable: false })
  })
})

describe('Restore Database\'s run and Stop', () => {
  it('runs a new database at once as a long run, follows its progress, refuses a close, and on Stop shows the cleanup and reconciles the folder', async () => {
    const { restore, id, state, sent, pending, progress, keys, longRuns, api, documents, reconcile } = await opened()
    restore.updateDraft(id, { destination: 'Sales_copy' })
    await settled()
    void restore.run(id)
    await settled()
    expect(sent()).toHaveLength(1)
    const request = sent()[0]!
    expect(validateRequest('actions.execute', request)).toEqual(request)
    expect(request.identity).toBeUndefined()
    expect(state().run).toMatchObject({ phase: 'running', database: 'Sales_copy', existed: false })
    expect(state().run!.planned.map(step => step.title)).toEqual([restoreStepTitles.full, restoreStepTitles.differential, restoreStepTitles.log])
    // A long run: the window, a Disconnect of its server and the tab itself refuse to close while it restores.
    expect(longRuns.getSnapshot().runs).toMatchObject([{ kind: 'restore', connectionId: conn }])
    expect(longRuns.closeRefusal()).toBe(longRunMessages.close({ kind: 'restore', server: `${conn}.example` }))
    expect(state().refusal).toBe(longRunMessages.close({ kind: 'restore', server: `${conn}.example` }))
    expect(documents.closeRefusal(id)).toBe(restoreServiceMessages.running)
    expect(keys()).toMatchObject({ running: true, runnable: false })
    // The differential's STATS, and an event for a request nobody tracks, which changes nothing.
    progress({ requestId: request.requestId, step: 1, percent: 40 })
    progress({ requestId: uuid(8), step: 2, percent: 90 })
    expect(restore.isRunning(id)).toBe(true)
    expect(overallPercent(state().run!.planned, { step: 1, percent: 40 })).toBe(47)
    // Stop on a database the restore creates cancels at once: nothing of the user's is at stake.
    restore.stop(id)
    expect(api.cancelObjectActions).toHaveBeenCalledWith([request.requestId])
    expect(state().run).toMatchObject({ stopping: true })
    pending.resolve(reply({
      steps: [{ status: 'done', title: restoreStepTitles.full }, { status: 'cancelled', title: restoreStepTitles.differential, progress: 40 }, { status: 'done', title: restoreStepTitles.remove, compensates: true }],
      error: { code: 'CANCELLED', message: `The action was stopped at "${restoreStepTitles.differential}"; SQL Server cancelled that statement.`, retryable: true }
    }))
    await settled()
    expect(state().run).toMatchObject({ phase: 'stopped', error: { code: 'CANCELLED' } })
    expect(state().run!.stopping).toBeUndefined()
    expect(state().run!.restored).toBeUndefined()
    expect(longRuns.getSnapshot().runs).toEqual([])
    expect(documents.closeRefusal(id)).toBeUndefined()
    expect(reconcile).toHaveBeenCalledWith(41, {})
    expect(keys()).toMatchObject({ running: false, runnable: true, refreshable: true })
  })
  it('asks before stopping over a database that existed, Keep restoring leaving it running (critic A11c)', async () => {
    const { restore, id, state, sent, pending, api, reconcile } = await opened()
    restore.updateDraft(id, { closeConnections: false })
    void restore.run(id)
    await settled()
    expect(state().run).toMatchObject({ phase: 'running', existed: true })
    restore.stop(id)
    expect(state().run).toMatchObject({ stopConfirm: true })
    expect(api.cancelObjectActions).not.toHaveBeenCalledWith([sent()[0]!.requestId])
    restore.answerStop(id, false)
    expect(state().run!.stopConfirm).toBeUndefined()
    expect(api.cancelObjectActions).not.toHaveBeenCalledWith([sent()[0]!.requestId])
    restore.stop(id)
    restore.answerStop(id, true)
    expect(api.cancelObjectActions).toHaveBeenCalledWith([sent()[0]!.requestId])
    pending.resolve(reply({ steps: [{ status: 'done', title: restoreStepTitles.tailLog }, { status: 'cancelled', title: restoreStepTitles.full }], error: { code: 'CANCELLED', message: 'Stopped.', retryable: true }, restored: { state: 1, userAccess: 0 } }))
    await settled()
    expect(state().run).toMatchObject({ phase: 'stopped', restored: { state: 1, userAccess: 0 } })
    expect(restoredText('Sales', state().run!.restored, true)).toContain('restoring')
    expect(reconcile).toHaveBeenCalledWith(41, { select: { type: 'object', object: { kind: 'database', name: 'Sales' } } })
  })
  it('says how far it got is unknown when the backend goes, and that a restore which finished is online', async () => {
    const first = await opened()
    void first.restore.run(first.id)
    await settled()
    first.pending.resolve({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    await settled()
    expect(first.state().run).toMatchObject({ phase: 'unknown', error: { code: 'CONNECTION_LOST', message: restoreServiceMessages.unknown } })
    const second = await opened()
    void second.restore.run(second.id)
    await settled()
    second.pending.resolve(reply({ steps: [{ status: 'done', title: restoreStepTitles.full }], restored: { state: 0, userAccess: 0 } }))
    await settled()
    expect(second.state().run).toMatchObject({ phase: 'done', restored: { state: 0, userAccess: 0 } })
    expect(second.state().run!.error).toBeUndefined()
    // Restore again keeps the choices.
    expect(second.restore.canRun(second.id)).toBe(true)
    expect(second.state().draft).toMatchObject({ destination: 'Sales' })
  })
  it('starts nothing when the server, read again, no longer lets the choices restore', async () => {
    // Since the document read the server, another database took the path a file of the copy restores to.
    let later = false
    const { restore, id, state, sent } = await opened({ facts: () => later ? { ...server, files: [...server.files, { database: 'Taken', path: 'D:\\DATA\\Sales_copy.mdf' }] } : undefined })
    restore.updateDraft(id, { destination: 'Sales_copy' })
    await settled()
    later = true
    await restore.run(id)
    await settled()
    expect(sent()).toEqual([])
    expect(state().run).toBeUndefined()
    expect(state().runNotice).toBe('Sales: The file is in use by the database Taken.')
  })
  it('summarises each section in a line while it runs', async () => {
    const { state } = await opened()
    expect(sectionSummaries(state().draft!, state().facts)).toEqual({
      general: 'From Sales_full1.bak (+1 files) + 2 more · to Sales · the last backup taken', files: 'Default locations · 2 files', options: 'RESTORE WITH RECOVERY · tail-log backup on'
    })
  })
  it('opens from the Databases folder and from a user database, on SQL Server only (the smoke suite opens it from the real menus)', async () => {
    const { actions } = await opened()
    const folder = { id: 41, connectionId: conn, lost: false, kind: 'folder' as const, folder: 'databases' as const, label: 'Databases', ref: { type: 'folder' as const, owner: { kind: 'server' as const }, folder: 'databases' as const } }
    const database = { id: 42, connectionId: conn, lost: false, kind: 'database' as const, label: 'Sales', ref: { type: 'object' as const, object: { kind: 'database' as const, name: 'Sales' } } }
    expect(actions.canRun('restore', folder)).toBe(true)
    expect(actions.canRun('restore', { ...folder, engine: 'cloud' })).toBe(false)
    expect(actions.canRun('restore', { ...folder, folder: 'tables', ref: { ...folder.ref, folder: 'tables' } })).toBe(false)
    expect(actions.canRun('restore', database)).toBe(true)
    expect(actions.canRun('restore', { ...database, subtype: 'system' })).toBe(false)
    expect(actions.canRun('rename', folder)).toBe(false)
    expect(actions.canRun('restore', { ...folder, lost: true })).toBe(false)
  })
  it('names its tab after the destination, also when the Databases folder opened it with none', async () => {
    const fixture = await opened()
    expect(fixture.documents.get(fixture.id)?.name).toBe('Restore Database - Sales')
    const folderOpened = fixture.restore.open(conn, undefined, 41)
    expect(fixture.documents.get(folderOpened)?.name).toBe('Restore Database')
    await settled()
    expect(fixture.restore.get(folderOpened)?.draft?.destination).toBe('Sales')
    expect(fixture.documents.get(folderOpened)?.name).toBe('Restore Database - Sales')
    fixture.restore.updateDraft(folderOpened, { destination: 'Sales_copy' })
    expect(fixture.documents.get(folderOpened)?.name).toBe('Restore Database - Sales_copy')
  })
})
