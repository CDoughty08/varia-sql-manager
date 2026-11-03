import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { restoreLimits, restoreMessages, restoreStepTitles, type BackupFileRow, type BackupSetRow, type RestoreModel, type RestoreServerFacts } from '../src/shared/actions/restore'
import { fileBaseSets, fileRestoreLogs } from '../src/shared/actions/restore-plan'
import { restoreFilesOptionsProblems, restoreFilesOptionsSchema, restoreFilesParameters, type RestoreFilesRequest } from '../src/shared/actions/restore-schema'
import type { ActionDescribeResult, ActionExecuteResult, ActionScriptResult } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import { setScriptOpen } from '../src/renderer/src/kit/document-frame'
import {
  filesConfirmLines, filesDestinationNote, filesGridRows, filesMoveRows, filesProblems, filesRestoringText, filesRowLabel, filesRunNote, filesSectionSummaries, filesSetCells, filesSetColumns, filesStopQuestion,
  logBackupPossible, plannedFileSteps, primaryRefused, restoreFilesRequest, stateLabel, toggleFile
} from '../src/renderer/src/restore/files'
import { restoredText } from '../src/renderer/src/restore/run'
import { restoreTestHook } from '../src/renderer/src/restore/test-hook'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const settled = async () => { for (let turn = 0; turn < 16; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const conn = '00000000-0000-4000-8000-0000000000c1'
const row = (id: string, name: string, type: BackupSetRow['type'], first: string, last: string, finish: string, devices: string[], patch: Partial<BackupSetRow> = {}): BackupSetRow => ({
  id, name, type, server: 'SQLHOST', database: 'Sales', position: 1, firstLsn: first, lastLsn: last, checkpointLsn: first, databaseBackupLsn: '0',
  start: `2026-10-29T${finish}`, finish: `2026-10-29T${finish}`, sizeBytes: 2 * 1024 * 1024, userName: 'CONTOSO\\dba', copyOnly: false, damaged: false, devices, ...patch
})
// A full backup, a log, a file backup of FG2, a log after both, and a copy-only log, which never chains.
const history = [
  row(uuid(5), 'copy', 'log', '500', '600', '21:09:00', ['B:\\Backup\\Sales_copy.trn'], { copyOnly: true }),
  row(uuid(4), 'log2', 'log', '350', '500', '21:08:00', ['B:\\Backup\\Sales_log.trn'], { position: 2 }),
  row(uuid(2), 'fg2', 'file', '300', '400', '21:07:00', ['B:\\Backup\\Sales_FG2.bak']),
  row(uuid(3), 'log1', 'log', '100', '350', '21:06:00', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(1), 'full', 'full', '100', '200', '21:05:00', ['B:\\Backup\\Sales_full.bak'])
]
const file = (logical: string, physical: string, type: BackupFileRow['type'], filegroup: string | undefined, fileId: number, absent = false): BackupFileRow =>
  ({ logical, physical, type, ...filegroup ? { filegroup } : {}, sizeBytes: 8_388_608, fileId, ...absent ? { absent: true } : {} })
const fullFiles = [file('Sales', 'D:\\DATA\\Sales.mdf', 'data', 'PRIMARY', 1), file('Sales_log', 'L:\\LOG\\Sales_log.ldf', 'log', undefined, 2), file('Sales_2', 'D:\\DATA\\Sales_2.ndf', 'data', 'FG2', 3), file('Sales_3', 'D:\\DATA\\Sales_3.ndf', 'data', 'FG2', 4)]
// A file backup lists every file of the database and holds only some (is_present).
const fgFiles = fullFiles.map(item => item.filegroup === 'FG2' || item.type === 'log' ? item : { ...item, absent: true as const })
const sales = { name: 'Sales', id: 7, created: '2026-01-01T00:00:00.000', state: 'ONLINE', recoveryModel: 'FULL', sessions: 3 }
const simple = { name: 'Simple', id: 9, created: '2026-01-02T00:00:00.000', state: 'ONLINE', recoveryModel: 'SIMPLE' }
const server: RestoreServerFacts = {
  separator: '\\', dataPath: 'D:\\DATA\\', logPath: 'L:\\LOG\\', backupPath: 'B:\\Backup\\', canRestore: true, destinationsTruncated: false, filesTruncated: false,
  destinations: [sales, simple, { name: 'msdb', id: 4, created: '2026-01-01T00:00:00.000', state: 'ONLINE', recoveryModel: 'SIMPLE' }],
  files: [{ database: 'Sales', path: 'D:\\DATA\\Sales.mdf' }, { database: 'Sales', path: 'D:\\DATA\\Sales_2.ndf' }, { database: 'Simple', path: 'D:\\DATA\\Simple.mdf' }]
}
const reply = (value: Partial<ActionExecuteResult>): ApiResult<ActionExecuteResult> => ({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, ...value } })

/** A Restore Files and Filegroups document on `database`, read. */
async function opened(database: string | undefined = 'Sales', options: { readonly facts?: RestoreServerFacts } = {}) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo(conn))
  fixture.api.describeObject.mockImplementation(async params => {
    const source = params.restore
    const facts = options.facts ?? server
    const model: RestoreModel = !source ? {} : source.kind === 'history' ? (source.database ? { server: facts, historyDatabases: ['Sales', 'msdb'], sets: history, setsTruncated: false } : { server: facts, historyDatabases: ['msdb', 'Sales'], historyTruncated: false })
      : source.kind === 'historyFiles' ? { files: source.setId === uuid(2) ? fgFiles : fullFiles, filesTruncated: false } : { files: [], filesTruncated: false }
    return { ok: true, value: { elapsedMs: 1, restore: model } as ActionDescribeResult }
  })
  fixture.api.scriptObjectAction.mockImplementation(async () => ({ ok: true, value: { text: 'USE [master]\n', database: 'master', warnings: [] } as ActionScriptResult }))
  const pending = deferred<ApiResult<ActionExecuteResult>>()
  fixture.api.executeObjectAction.mockImplementation(() => pending.promise)
  const reconcile = vi.spyOn(fixture.explorer, 'reconcile')
  const id = fixture.restore.open(conn, database, 41, 'files')
  await settled()
  const state = () => fixture.restore.get(id)!
  const draft = () => state().draft!
  const sent = () => fixture.api.executeObjectAction.mock.calls.map(([request]) => request as RestoreFilesRequest)
  const scripts = () => fixture.api.scriptObjectAction.mock.calls.map(([request]) => request as RestoreFilesRequest)
  const request = () => restoreFilesRequest(draft(), state().facts, { connectionId: conn, requestId: uuid(9) })
  const check = (set: string, name: string, checked = true) => fixture.restore.updateDraft(id, toggleFile(draft(), state().facts, set, name, checked))
  return { ...fixture, id, state, draft, sent, scripts, request, check, pending, reconcile }
}

describe('Restore Files and Filegroups, pure', () => {
  it('plans the steps RestoreFilesRun.cs builds for the shared cases (tests/fixtures/restore/files-steps.json)', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/restore/files-steps.json', 'utf8')) as { cases: { name: string; restoreFiles: RestoreFilesRequest['restoreFiles']; steps: { kind: string; title: string; detail?: string }[] }[] }
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3)
    for (const item of fixture.cases) {
      expect(restoreFilesOptionsSchema.safeParse(item.restoreFiles).success, item.name).toBe(true)
      const request: RestoreFilesRequest = { action: 'restoreFiles', connectionId: conn, requestId: uuid(9), target: { kind: 'database', name: 'Sales' }, identity: { id: 7, created: '2026-01-01T00:00:00.000' }, restoreFiles: item.restoreFiles }
      const planned = plannedFileSteps(request)
      expect(planned.map(step => ({ kind: 'main', title: step.title, ...step.detail ? { detail: step.detail } : {} })), item.name).toEqual(item.steps)
      // Every step is a RESTORE or the BACKUP, which report STATS progress.
      expect(planned.every(step => step.set)).toBe(true)
    }
  })
  it('restores files from the newest full and file backups, rolled forward through the logs that continue the chosen one', () => {
    expect(fileBaseSets(history, restoreLimits.fileSets).map(set => set.name)).toEqual(['fg2', 'full'])
    expect(fileBaseSets(history, 1).map(set => set.name)).toEqual(['fg2'])
    expect(fileBaseSets([...history, row(uuid(6), 'bad', 'full', '1', '2', '21:10:00', [], { damaged: true })], 16).map(set => set.name)).toEqual(['fg2', 'full'])
    expect(fileRestoreLogs(history, history[2]).map(set => set.name)).toEqual(['log2'])
    expect(fileRestoreLogs(history, history[4]).map(set => set.name)).toEqual(['log1', 'log2'])
    expect(fileRestoreLogs(history, history[1])).toEqual([])
  })
  it('refuses what main and the backend refuse: the sets\' shape, nothing named, names twice, too many parameters, standby and the log backup', () => {
    const base = { sets: [{ id: uuid(1), devices: ['B:\\f.bak'], file: 1, type: 'full' as const }], files: ['a'], filegroups: [], relocate: [], replace: false, restrictedUser: false, recovery: 'recovery' as const }
    const problems = (patch: object) => restoreFilesOptionsProblems({ ...base, ...patch }).map(problem => problem.message)
    expect(problems({})).toEqual([])
    expect(problems({ sets: [{ ...base.sets[0], type: 'log' }] })).toEqual(['A file restore starts with a full or file backup.'])
    expect(problems({ sets: [base.sets[0], { ...base.sets[0], id: uuid(2) }] })).toEqual(['Only log backups follow the backup the files restore from.'])
    expect(problems({ files: [] })).toEqual(['Name the files or filegroups to restore.'])
    expect(problems({ files: ['a', 'a'], filegroups: ['g', 'g'] })).toEqual(['A file is named twice.', 'A filegroup is named twice.'])
    expect(problems({ recovery: 'standby' })).toEqual(['RESTORE WITH STANDBY needs a standby file, and only it takes one.'])
    expect(problems({ recovery: 'norecovery', logBackup: { file: 'B:\\l.bak' } })).toEqual(['The log backup brings the files online, so it restores only WITH RECOVERY.'])
    const moves = Array.from({ length: 1000 }, (_, index) => ({ logical: `f${index}`, physical: `D:\\${index}.ndf` }))
    expect(restoreFilesParameters({ ...base, relocate: moves })).toBe(3 + 1 + 1 + 2000)
    const names = (prefix: string) => Array.from({ length: 100 }, (_, index) => prefix + index)
    expect(problems({ relocate: moves })).toEqual([])
    expect(problems({ files: names('f'), filegroups: names('g'), relocate: moves })).toEqual([`One RESTORE takes at most ${(2100).toLocaleString('en-US')} parameters: restore fewer files, or move fewer.`])
    // Bounds: 256 names of at most 128 characters each.
    expect(restoreFilesOptionsSchema.safeParse({ ...base, files: Array.from({ length: 257 }, (_, index) => `f${index}`) }).success).toBe(false)
    expect(restoreFilesOptionsSchema.safeParse({ ...base, files: ['x'.repeat(129)] }).success).toBe(false)
    expect(restoreFilesOptionsSchema.safeParse({ ...base, files: ['x'.repeat(128)] }).success).toBe(true)
    expect(restoreFilesOptionsSchema.safeParse({ ...base, tailLog: { file: 'B:\\t.bak', noRecovery: true } }).success).toBe(false)
  })
})

describe('Restore Files and Filegroups as a document', () => {
  it('opens a tab with SSMS\'s General and Options pages, reads the newest full and file backups\' files, and checks nothing yet', async () => {
    const { state, draft, documents, id, api } = await opened()
    expect(documents.get(id)?.name).toBe('Restore Files and Filegroups - Sales')
    expect(documents.get(id)?.kind).toBe('restoreDatabase')
    expect(state()).toMatchObject({ mode: 'files', phase: 'ready', sets: 'ready', files: 'ready', frame: { section: 'general' } })
    expect(api.describeObject.mock.calls.map(([request]) => request.restore)).toEqual([
      { kind: 'history' }, { kind: 'history', database: 'Sales' }, { kind: 'historyFiles', setId: uuid(2) }, { kind: 'historyFiles', setId: uuid(1) }
    ])
    expect(draft()).toMatchObject({ database: 'Sales', destination: 'Sales', files: { chosen: [], asFilegroup: false, logBackup: true, logBackupFile: expect.stringMatching(/^B:\\Backup\\Sales_LogBackup_.*\.bak$/) } })
    // The file backup's two FG2 files (not its absent ones, nor a log file), the full's three data files, then the log after the file backup.
    const rows = filesGridRows(draft(), state().facts)
    expect(rows.map(item => [item.set.name, item.name ?? '', item.checked, item.log])).toEqual([
      ['fg2', 'Sales_2', false, false], ['fg2', 'Sales_3', false, false], ['full', 'Sales', false, false], ['full', 'Sales_2', false, false], ['full', 'Sales_3', false, false], ['log2', '', false, true]
    ])
    expect(filesSetColumns(false)).toEqual(['Restore', 'Name', 'File Type', 'Type', 'Server', 'File Logical Name', 'Database', 'Start Date', 'Finish Date', 'Size', 'User Name'])
    expect(filesSetCells(rows[0])).toEqual(['fg2', 'Rows Data', 'File Full', 'SQLHOST', 'Sales_2', 'Sales', '2026-10-29 21:07:00', '2026-10-29 21:07:00', '2.00 MB', 'CONTOSO\\dba'])
    expect(filesProblems(draft(), state().facts).general).toEqual([restoreMessages.noFiles])
    expect(restoreFilesRequest(draft(), state().facts, { connectionId: conn, requestId: uuid(9) })).toEqual({ problem: restoreMessages.noFiles })
    expect(rows.map(filesRowLabel)).toEqual(['Restore Sales_2 from fg2 (2026-10-29 21:07:00)', 'Restore Sales_3 from fg2 (2026-10-29 21:07:00)', 'Restore Sales from full (2026-10-29 21:05:00)',
      'Restore Sales_2 from full (2026-10-29 21:05:00)', 'Restore Sales_3 from full (2026-10-29 21:05:00)', 'Restore log2 (2026-10-29 21:08:00)'])
    // A PRIMARY file restores only offline, which loses an online database's log tail: its row says why it cannot be checked.
    expect(rows.map(item => item.blocked)).toEqual([undefined, undefined, restoreMessages.primaryOnline, undefined, undefined, undefined])
    // The To database note says the state in sentence case.
    expect(filesDestinationNote(sales)).toBe('Online, FULL recovery model.')
    expect(filesDestinationNote({ state: 'RESTORING', recoveryModel: 'FULL' })).toBe('Restoring, FULL recovery model.')
    expect([stateLabel('OFFLINE'), stateLabel('RECOVERY_PENDING'), stateLabel('SUSPECT')]).toEqual(['Offline', 'Recovery pending', 'Suspect'])
    expect(filesDestinationNote(undefined)).toBeUndefined()
  })
  it('restores the checked files from one backup set and its logs, starting again from another set\'s row, and scripts the request through actions.script', async () => {
    const { restore, id, state, draft, check, request, scripts } = await opened()
    check(uuid(2), 'Sales_2')
    expect(filesGridRows(draft(), state().facts).filter(item => item.checked).map(item => item.name ?? item.set.name)).toEqual(['Sales_2', 'log2'])
    const first = request() as RestoreFilesRequest
    expect(validateRequest('actions.execute', first)).toEqual(first)
    expect(first).toMatchObject({
      action: 'restoreFiles', target: { kind: 'database', name: 'Sales' }, identity: { id: 7, created: '2026-01-01T00:00:00.000' },
      restoreFiles: { sets: [{ id: uuid(2), type: 'file', devices: ['B:\\Backup\\Sales_FG2.bak'], file: 1, name: 'fg2' }, { id: uuid(4), type: 'log', file: 2 }], files: ['Sales_2'], filegroups: [], relocate: [], recovery: 'recovery', logBackup: { file: draft().files!.logBackupFile } }
    })
    // The PRIMARY file is never checked while Sales is online. A row of the full backup: one restore restores from one backup set,
    // so only it stays checked, with the logs after the full.
    check(uuid(1), 'Sales')
    expect(draft().files).toMatchObject({ set: uuid(2), chosen: ['Sales_2'] })
    check(uuid(1), 'Sales_2')
    check(uuid(1), 'Sales_3')
    const second = request() as RestoreFilesRequest
    expect(second.restoreFiles.sets.map(set => set.id)).toEqual([uuid(1), uuid(3), uuid(4)])
    expect(second.restoreFiles.files).toEqual(['Sales_2', 'Sales_3'])
    check(uuid(1), 'Sales_2', false)
    expect((request() as RestoreFilesRequest).restoreFiles.files).toEqual(['Sales_3'])
    // A typed Restore As moves the file; one onto another database's file is refused.
    restore.updateDraft(id, { restoreAs: { Sales_3: 'E:\\DATA\\Sales_3.ndf' } })
    expect((request() as RestoreFilesRequest).restoreFiles.relocate).toEqual([{ logical: 'Sales_3', physical: 'E:\\DATA\\Sales_3.ndf' }])
    restore.updateDraft(id, { restoreAs: { Sales_3: 'd:\\data\\SIMPLE.mdf' } })
    expect(filesMoveRows(draft(), state().facts)[0].problem).toBe('The file is in use by the database Simple.')
    expect(request()).toEqual({ problem: 'Sales_3: The file is in use by the database Simple.' })
    restore.updateDraft(id, { restoreAs: {} })
    restore.setFrame(id, setScriptOpen(state().frame, true))
    await settled()
    expect(scripts().at(-1)).toMatchObject({ action: 'restoreFiles', restoreFiles: { files: ['Sales_3'] } })
    expect(validateRequest('actions.script', scripts().at(-1))).toEqual(scripts().at(-1))
    expect(state().script).toMatchObject({ state: 'ready' })
  })
  it('names filegroups under Restore as filegroup, which starts the checks again', async () => {
    const { restore, id, state, draft, check, request } = await opened()
    check(uuid(2), 'Sales_2')
    restore.updateDraft(id, { files: { ...draft().files!, asFilegroup: true } })
    expect(draft().files).toMatchObject({ asFilegroup: true, chosen: [] })
    expect(draft().files!.set).toBeUndefined()
    const rows = filesGridRows(draft(), state().facts)
    expect(rows.map(item => [item.set.name, item.name ?? '', item.logicalName])).toEqual([['fg2', 'FG2', 'Sales_2, Sales_3'], ['full', 'PRIMARY', 'Sales'], ['full', 'FG2', 'Sales_2, Sales_3'], ['log2', '', '']])
    // Each row shows the filegroup its checkbox names, first; PRIMARY's cannot be checked online.
    expect(filesSetColumns(true)).toEqual(['Restore', 'Filegroup', 'Name', 'File Type', 'Type', 'Server', 'File Logical Name', 'Database', 'Start Date', 'Finish Date', 'Size', 'User Name'])
    expect(rows.map(item => filesSetCells(item, true)[0])).toEqual(['FG2', 'PRIMARY', 'FG2', ''])
    expect(filesSetCells(rows[0], true).slice(1)).toEqual(filesSetCells(rows[0]))
    expect(rows.map(filesRowLabel).slice(0, 2)).toEqual(['Restore FG2 from fg2 (2026-10-29 21:07:00)', 'Restore PRIMARY from full (2026-10-29 21:05:00)'])
    expect(rows[1].blocked).toBe(restoreMessages.primaryOnline)
    check(uuid(1), 'PRIMARY')
    expect(draft().files!.chosen).toEqual([])
    check(uuid(2), 'FG2')
    expect((request() as RestoreFilesRequest).restoreFiles).toMatchObject({ files: [], filegroups: ['FG2'] })
    expect(filesMoveRows(draft(), state().facts).map(item => item.file.logical)).toEqual(['Sales_2', 'Sales_3'])
    expect(filesSectionSummaries(draft(), state().facts)).toEqual({ general: '1 filegroup of Sales from Sales_FG2.bak + 1 log backup', options: 'RESTORE WITH RECOVERY · log backup on' })
  })
  it('offers the log backup only online, under FULL or BULK_LOGGED, WITH RECOVERY, and STANDBY only offline (SQL Server\'s 4302)', async () => {
    const { restore, id, state, draft, check, request } = await opened()
    check(uuid(2), 'Sales_2')
    restore.updateDraft(id, { recovery: 'norecovery' })
    expect(logBackupPossible(draft(), state().facts)).toBe(false)
    expect((request() as RestoreFilesRequest).restoreFiles.logBackup).toBeUndefined()
    restore.updateDraft(id, { recovery: 'standby', standbyFile: 'B:\\Backup\\undo.bak' })
    expect(filesProblems(draft(), state().facts).options).toEqual([restoreMessages.standbyOnline])
    expect(request()).toEqual({ problem: restoreMessages.standbyOnline })
    restore.updateDraft(id, { recovery: 'recovery', files: { ...draft().files!, logBackupFile: 'D:\\DATA\\Sales_2.ndf' } })
    expect(filesProblems(draft(), state().facts).options).toEqual(['Log backup file: The file is a file of the database Sales.'])
    // A SIMPLE database keeps no log: no log backup, and Learn's rule is the backend's to check (it reads which filegroups are read-only).
    restore.updateDraft(id, { destination: 'Simple' })
    expect(draft()).toMatchObject({ database: 'Simple', destination: 'Simple' })
    expect(draft().files!.logBackup).toBe(false)
    expect(logBackupPossible(draft(), state().facts)).toBe(false)
    // A database that is not on the server, or one of SQL Server's own, is refused.
    restore.updateDraft(id, { destination: 'Gone' })
    expect(filesProblems(draft(), state().facts).general[0]).toBe('The database Gone is not on the server: files restore only into an existing database.')
    restore.updateDraft(id, { destination: 'msdb' })
    expect(filesProblems(draft(), state().facts).general).toContain(restoreMessages.systemDatabase.replace('{database}', 'msdb'))
  })
  it('restores PRIMARY files only into a database already restoring, and lets a PRIMARY file chosen there be cleared once it is online', async () => {
    const restoring: RestoreServerFacts = { ...server, destinations: [{ ...sales, state: 'RESTORING' }, ...server.destinations.slice(1)] }
    const { state, draft, check, request } = await opened('Sales', { facts: restoring })
    expect(primaryRefused(draft(), state().facts)).toBe(false)
    expect(filesGridRows(draft(), state().facts).every(item => !item.blocked)).toBe(true)
    check(uuid(1), 'Sales')
    expect((request() as RestoreFilesRequest).restoreFiles).toMatchObject({ files: ['Sales'], sets: [{ id: uuid(1) }, { id: uuid(3) }, { id: uuid(4) }] })
    expect(draft().files!.logBackup).toBe(false)
    // The same choice against the database online (or offline) is refused, and the checked row stays clearable.
    const online = { ...state().facts, server }
    expect(primaryRefused(draft(), online)).toBe(true)
    expect(filesProblems(draft(), online).general).toEqual([restoreMessages.primaryOnline])
    expect(restoreFilesRequest(draft(), online, { connectionId: conn, requestId: uuid(9) })).toEqual({ problem: restoreMessages.primaryOnline })
    const row = filesGridRows(draft(), online).find(item => item.name === 'Sales' && item.set.id === uuid(1))!
    expect(row).toMatchObject({ checked: true, blocked: restoreMessages.primaryOnline })
    expect(toggleFile(draft(), online, uuid(1), 'Sales', false)).toMatchObject({ files: { chosen: [] } })
    expect(primaryRefused(draft(), { ...online, server: { ...server, destinations: [{ ...sales, state: 'OFFLINE' }] } })).toBe(true)
  })
  it('opens on the first user database msdb has backups of from the Databases folder, on SQL Server only (the smoke suite opens it from the real menus)', async () => {
    const fixture = await opened(undefined)
    expect(fixture.draft()).toMatchObject({ database: 'Sales', destination: 'Sales' })
    expect(fixture.documents.get(fixture.id)?.name).toBe('Restore Files and Filegroups - Sales')
    const folder = { id: 41, connectionId: conn, lost: false, kind: 'folder' as const, folder: 'databases' as const, label: 'Databases', ref: { type: 'folder' as const, owner: { kind: 'server' as const }, folder: 'databases' as const } }
    const database = { id: 42, connectionId: conn, lost: false, kind: 'database' as const, label: 'Sales', ref: { type: 'object' as const, object: { kind: 'database' as const, name: 'Sales' } } }
    expect(fixture.actions.canRun('restoreFiles', folder)).toBe(true)
    expect(fixture.actions.canRun('restoreFiles', database)).toBe(true)
    expect(fixture.actions.canRun('restoreFiles', { ...database, engine: 'managedInstance' })).toBe(false)
    expect(fixture.actions.canRun('restoreFiles', { ...database, subtype: 'system' })).toBe(false)
    // The test hook opens either mode, and refuses another.
    const hook = restoreTestHook(fixture.restore, fixture.connections)
    expect(fixture.restore.get(hook.open('Sales', 'files')!)?.mode).toBe('files')
    expect(fixture.restore.get(hook.open('Sales')!)?.mode).toBe('database')
    expect(hook.open('Sales', 'other' as 'files')).toBeUndefined()
  })
})

describe('Restore Files and Filegroups\' run', () => {
  it('asks when no log backup ends the restore, runs as a long run, asks before Stop, and names the files left restoring', async () => {
    const { restore, id, state, draft, check, sent, pending, api, reconcile, longRuns } = await opened()
    check(uuid(2), 'Sales_2')
    restore.updateDraft(id, { files: { ...draft().files!, logBackup: false } })
    expect(filesConfirmLines(draft(), state().facts)).toEqual([
      'No log backup is taken: under the full or bulk-logged recovery model, restored files stay restoring until a log backup taken after they are restored is restored.'
    ])
    await restore.run(id)
    expect(state().run).toMatchObject({ phase: 'confirm', database: 'Sales', existed: true, replace: false })
    expect(sent()).toEqual([])
    restore.cancelRun(id)
    restore.updateDraft(id, { replace: true })
    expect(filesConfirmLines(draft(), state().facts)[0]).toBe('Restoring files over Sales WITH REPLACE skips SQL Server\'s safety checks. If the restore stops or fails part way, the files are left restoring and cannot be used until a restore finishes.')
    await restore.run(id)
    void restore.confirmRun(id)
    await settled()
    expect(sent()).toHaveLength(1)
    const request = sent()[0]!
    expect(validateRequest('actions.execute', request)).toEqual(request)
    expect(request).toMatchObject({ action: 'restoreFiles', restoreFiles: { replace: true, files: ['Sales_2'] } })
    expect(request.restoreFiles.logBackup).toBeUndefined()
    expect(state().run!.planned.map(step => step.title)).toEqual([restoreStepTitles.files, restoreStepTitles.log])
    expect(longRuns.getSnapshot().runs).toMatchObject([{ kind: 'restore', connectionId: conn }])
    // The database existed: Stop asks first, and its question says what stopping leaves.
    restore.stop(id)
    expect(state().run).toMatchObject({ stopConfirm: true })
    expect(filesStopQuestion('Sales')).toBe('Stop the restore? Stopping leaves the files being restored in Sales restoring and unusable until a restore finishes.')
    restore.answerStop(id, true)
    expect(api.cancelObjectActions).toHaveBeenCalledWith([request.requestId])
    pending.resolve(reply({
      steps: [{ status: 'done', title: restoreStepTitles.files }, { status: 'cancelled', title: restoreStepTitles.log, progress: 20 }],
      error: { code: 'CANCELLED', message: 'Stopped.', retryable: true }, restored: { state: 0, userAccess: 0, filesRestoring: ['Sales_2'] }
    }))
    await settled()
    expect(state().run).toMatchObject({ phase: 'stopped', restored: { state: 0, filesRestoring: ['Sales_2'] } })
    expect(restoredText('Sales', state().run!.restored, state().run!.steps)).toBe('Sales is online.')
    expect(filesRestoringText('Sales', state().run!.restored)).toBe('The file Sales_2 of Sales is restoring and cannot be used until a restore finishes.')
    expect(filesRestoringText('Sales', { state: 0, userAccess: 0, filesRestoring: ['a', 'b'] })).toBe('The files a, b of Sales are restoring and cannot be used until a restore finishes.')
    expect(filesRestoringText('Sales', { state: 0, userAccess: 0 })).toBeUndefined()
    expect(filesRunNote('Sales')).toContain('Sales stays on the server')
    expect(reconcile).toHaveBeenCalledWith(41, { select: { type: 'object', object: { kind: 'database', name: 'Sales' } } })
    expect(longRuns.getSnapshot().runs).toEqual([])
  })
  it('runs at once with the log backup, whose two steps follow the logs', async () => {
    const { restore, id, state, check, sent } = await opened()
    check(uuid(1), 'Sales_3')
    void restore.run(id)
    await settled()
    expect(sent()).toHaveLength(1)
    expect(state().run).toMatchObject({ phase: 'running', existed: true })
    expect(state().run!.planned.map(step => step.title)).toEqual([restoreStepTitles.files, `${restoreStepTitles.log} 1 of 2`, `${restoreStepTitles.log} 2 of 2`, restoreStepTitles.logBackup, restoreStepTitles.logBackupRestore])
  })
})
