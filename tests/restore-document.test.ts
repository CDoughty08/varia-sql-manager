import { afterEach, describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { restoreMessages, type BackupSetRow, type RestoreModel, type RestoreServerFacts } from '../src/shared/actions/restore'
import type { RestoreRequest } from '../src/shared/actions/restore-schema'
import type { ActionDescribeResult, ActionScriptResult } from '../src/shared/actions/schema'
import { setScriptOpen } from '../src/renderer/src/kit/document-frame'
import { draftPlan, draftProblems, fileRows, restoreRequest, setCells, setColumns, toggleSet } from '../src/renderer/src/restore/model'
import { restorePreviewDelayMs, restoreServiceMessages } from '../src/renderer/src/restore/RestoreService'
import { restoreTestHook } from '../src/renderer/src/restore/test-hook'
import { coverage, stepPoint, timeMs, timelineWindow, timeText } from '../src/renderer/src/restore/timeline'
import { connectionInfo, manualTimers, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const conn = '00000000-0000-4000-8000-0000000000c1'
const row = (id: string, name: string, type: BackupSetRow['type'], position: number, first: string, last: string, checkpoint: string, base: string, finish: string, devices: string[]): BackupSetRow => ({
  id, name, type, server: 'SQLHOST', database: 'Sales', position, firstLsn: first, lastLsn: last, checkpointLsn: checkpoint, databaseBackupLsn: base,
  start: `2026-10-29T${finish}`, finish: `2026-10-29T${finish}`, sizeBytes: 2 * 1024 * 1024, userName: 'CONTOSO\\dba', copyOnly: false, damaged: false, devices
})
const history = [
  row(uuid(5), 'log3', 'log', 3, '56800001', '68800001', '68800001', '43200001', '21:05:46', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(4), 'diff', 'differential', 1, '56800001', '68000001', '68000001', '43200001', '21:05:45', ['B:\\Backup\\Sales_diff.bak']),
  row(uuid(3), 'log2', 'log', 2, '51200001', '56800001', '56800001', '43200001', '21:05:44', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(2), 'log1', 'log', 1, '43200001', '51200001', '51200001', '43200001', '21:05:41', ['B:\\Backup\\Sales_log.trn']),
  row(uuid(1), 'full', 'full', 1, '43200001', '45600001', '43200001', '0', '21:05:40', ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak'])
]
const media = history.map((set, index) => ({ ...set, id: `${index + 1}:${set.position}` }))
const server: RestoreServerFacts = {
  separator: '\\', dataPath: 'D:\\DATA\\', logPath: 'L:\\LOG\\', backupPath: 'B:\\Backup\\', canRestore: true, destinationsTruncated: false, filesTruncated: false,
  destinations: [{ name: 'Sales', id: 7, created: '2026-01-01T00:00:00.000', state: 'ONLINE', recoveryModel: 'FULL', sessions: 0 }, { name: 'model', id: 3, created: '2026-01-01T00:00:00.000', state: 'ONLINE', recoveryModel: 'FULL' }],
  files: [{ database: 'Sales', path: 'D:\\DATA\\Sales.mdf' }, { database: 'Sales', path: 'L:\\LOG\\Sales_log.ldf' }, { database: 'Other', path: 'D:\\DATA\\Taken.mdf' }]
}
const files = [{ logical: 'Sales', physical: 'D:\\DATA\\Sales.mdf', type: 'data' as const, filegroup: 'PRIMARY', sizeBytes: 8_388_608, fileId: 1 }, { logical: 'Sales_log', physical: 'L:\\LOG\\Sales_log.ldf', type: 'log' as const, sizeBytes: 8_388_608, fileId: 2 }]

function opened(database: string | undefined = 'Sales') {
  const clock = manualTimers()
  const fixture = workbenchFixture({ timers: clock.timers })
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo(conn))
  fixture.api.describeObject.mockImplementation(async params => {
    const source = params.restore
    const model: RestoreModel = !source ? {} : source.kind === 'history' ? (source.database ? { server, historyDatabases: ['Sales', 'msdb'], sets: history, setsTruncated: false } : { server, historyDatabases: ['Sales', 'msdb'], historyTruncated: false })
      : source.kind === 'devices' ? { server, sets: media, setsTruncated: false } : { files, filesTruncated: false }
    return { ok: true, value: { elapsedMs: 1, restore: model } as ActionDescribeResult }
  })
  fixture.api.scriptObjectAction.mockImplementation(async () => ({ ok: true, value: { text: 'USE [master]\nRESTORE DATABASE [Sales]\n\nGO\n', database: 'master', warnings: [] } as ActionScriptResult }))
  const { restore, documents, api } = fixture
  const id = restore.open(conn, database)
  const state = () => restore.get(id)!
  const scripts = () => api.scriptObjectAction.mock.calls.map(([request]) => request as RestoreRequest)
  const describes = () => api.describeObject.mock.calls.map(([request]) => request.restore)
  return { ...fixture, restore, documents, id, state, scripts, describes, clock }
}

describe('Restore Database as a document', () => {
  it('opens a tab, reads the server, the database\'s history and its full backup\'s files, and plans the last backup', async () => {
    const { documents, id, state, describes, api } = opened()
    expect(documents.active).toMatchObject({ id, kind: 'restoreDatabase', name: 'Restore Database - Sales', connectionId: conn, database: 'master', dirty: false })
    expect(state()).toMatchObject({ phase: 'loading', frame: { section: 'general', scriptOpen: false } })
    await settled()
    expect(describes()).toEqual([{ kind: 'history' }, { kind: 'history', database: 'Sales' }, { kind: 'historyFiles', setId: uuid(1) }])
    expect(state()).toMatchObject({ phase: 'ready', sets: 'ready', files: 'ready', draft: { source: 'database', database: 'Sales', destination: 'Sales', tailLog: true, leaveRestoring: true } })
    expect(draftPlan(state().draft!, state().facts).ids).toEqual([uuid(1), uuid(4), uuid(5)])
    // Each read went to the backend as the describe schema has it, under the restore deadline.
    for (const [request] of api.describeObject.mock.calls) expect(validateRequest('actions.describe', request)).toEqual(request)
  })
  it('scripts the restore through actions.script once the drawer opens: over the source with its tail-log backup, then as a copy with its files moved', async () => {
    const { restore, id, state, scripts, clock } = opened()
    await settled()
    restore.setFrame(id, setScriptOpen(state().frame, true))
    clock.advance(0)
    await settled()
    const [request] = scripts()
    expect(validateRequest('actions.script', request)).toEqual(request)
    expect(request).toMatchObject({ action: 'restore', target: { kind: 'database', name: 'Sales' }, identity: { id: 7, created: '2026-01-01T00:00:00.000' },
      restore: { sets: [{ id: uuid(1), devices: ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak'], file: 1, type: 'full' }, { id: uuid(4), type: 'differential' }, { id: uuid(5), file: 3, type: 'log' }],
        relocate: [], replace: false, recovery: 'recovery', tailLog: { file: 'B:\\Backup\\Sales_LogBackup_2026-10-30_12-00-00.bak', noRecovery: true }, closeConnections: false } })
    expect(state().script).toEqual({ state: 'ready', text: 'USE [master]\nRESTORE DATABASE [Sales]\n\nGO\n' })
    // A copy: no tail-log backup (the destination is not the source), and the files go to the default folders under its name.
    restore.updateDraft(id, { destination: 'Sales_copy' })
    expect(state().draft).toMatchObject({ tailLog: false })
    clock.advance(restorePreviewDelayMs)
    await settled()
    const copy = scripts().at(-1)!
    expect(validateRequest('actions.script', copy)).toEqual(copy)
    expect(copy.identity).toBeUndefined()
    expect(copy.restore.tailLog).toBeUndefined()
    expect(copy.restore.relocate).toEqual([{ logical: 'Sales', physical: 'D:\\DATA\\Sales_copy.mdf' }, { logical: 'Sales_log', physical: 'L:\\LOG\\Sales_copy_log.ldf' }])
    // Relocate all files to folder keeps the names and changes the folders.
    restore.updateDraft(id, { relocate: true, dataFolder: 'E:\\Data', logFolder: 'F:\\Logs\\' })
    expect(fileRows(state().draft!, state().facts).map(item => item.restoreAs)).toEqual(['E:\\Data\\Sales_copy.mdf', 'F:\\Logs\\Sales_copy_log.ldf'])
  })
  it('greys SQL Server\'s own databases and says why (critic A19), and scripts nothing for them', async () => {
    const { restore, id, state, scripts, clock } = opened()
    await settled()
    restore.setFrame(id, setScriptOpen(state().frame, true))
    restore.updateDraft(id, { destination: 'msdb' })
    clock.advance(restorePreviewDelayMs)
    await settled()
    expect(scripts().every(request => request.target.name !== 'msdb')).toBe(true)
    expect(state().script).toEqual({ state: 'idle', message: restoreMessages.systemDatabase })
    expect(draftProblems(state().draft!, state().facts).general).toContain(restoreMessages.systemDatabase)
  })
  it('restores to a point in time and follows Manual Selection, unchecking the sets that depend on one', async () => {
    const { restore, id, state } = opened()
    await settled()
    restore.updateDraft(id, { stopAt: '2026-10-29T21:05:43' })
    const ids = { connectionId: conn, requestId: '00000000-0000-4000-8000-000000000009' }
    const pointed = restoreRequest(state().draft!, state().facts, ids) as RestoreRequest
    expect(pointed.restore.sets.map(set => set.id)).toEqual([uuid(1), uuid(2), uuid(3)])
    expect(pointed.restore.stopAt).toBe('2026-10-29T21:05:43')
    restore.updateDraft(id, { stopAt: undefined })
    expect(state().draft!.stopAt).toBeUndefined()
    // Unchecking the differential unchecks the log after it; checking log1 then makes a valid chain from the full.
    restore.updateDraft(id, toggleSet(state().draft!, state().facts, uuid(4), false))
    expect(draftPlan(state().draft!, state().facts)).toMatchObject({ ids: [uuid(1)], manual: true })
    restore.updateDraft(id, toggleSet(state().draft!, state().facts, uuid(2), true))
    expect(draftPlan(state().draft!, state().facts)).toEqual({ ids: [uuid(1), uuid(2)], manual: true })
    restore.updateDraft(id, toggleSet(state().draft!, state().facts, uuid(3), false))
    restore.updateDraft(id, toggleSet(state().draft!, state().facts, uuid(5), true))
    expect(draftPlan(state().draft!, state().facts).problem).toBe(restoreMessages.invalidPlan)
    expect('problem' in restoreRequest(state().draft!, state().facts, ids)).toBe(true)
  })
  it('reads backup files from Device: the headers, then the full backup\'s files from its media', async () => {
    const { restore, id, state, describes } = opened()
    await settled()
    restore.updateDraft(id, { source: 'device', devices: ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak', 'B:\\Backup\\Sales_log.trn'] })
    await settled()
    expect(describes().slice(3)).toEqual([{ kind: 'devices', devices: ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak', 'B:\\Backup\\Sales_log.trn'] },
      { kind: 'mediaFiles', devices: ['B:\\Backup\\Sales_full1.bak', 'B:\\Backup\\Sales_full2.bak'], file: 1 }])
    expect(state()).toMatchObject({ sets: 'ready', files: 'ready', draft: { destination: 'Sales' } })
    expect(draftPlan(state().draft!, state().facts).ids).toEqual(['5:1', '2:1', '1:3'])
  })
  it('marks a Restore As path another database holds, or two files on one path', async () => {
    const { restore, id, state } = opened()
    await settled()
    restore.updateDraft(id, { destination: 'Sales_copy', restoreAs: { Sales: 'D:\\DATA\\Taken.mdf' } })
    expect(fileRows(state().draft!, state().facts)[0]).toMatchObject({ typed: true, problem: 'The file is in use by the database Other.' })
    restore.updateDraft(id, { restoreAs: { Sales: 'L:\\LOG\\Sales_copy_log.ldf' } })
    expect(fileRows(state().draft!, state().facts).map(item => item.problem)).toEqual(['Another file is restored to this path.', 'Another file is restored to this path.'])
    expect(draftProblems(state().draft!, state().facts).files).toHaveLength(2)
  })
  it('says when the server goes while it reads, and the test hook opens it only on a live connection', async () => {
    const { restore, state, connections } = opened()
    connections.markLostBefore(2)
    await settled()
    expect(state()).toMatchObject({ phase: 'loadFailed', error: { code: 'CONNECTION_LOST', message: restoreServiceMessages.disconnected } })
    expect(restoreTestHook(restore, connections).open('Sales')).toBeUndefined()
  })
  it('names the grid\'s sixteen columns as SSMS does (recalled), with a cell for each', () => {
    expect(setColumns).toEqual(['Restore', 'Name', 'Component', 'Type', 'Server', 'Database', 'Position', 'First LSN', 'Last LSN', 'Checkpoint LSN', 'Full LSN', 'Start Date', 'Finish Date', 'Size', 'User Name', 'Expiration'])
    expect(setCells(history[0])).toEqual(['log3', 'Database', 'Transaction Log', 'SQLHOST', 'Sales', '3', '56800001', '68800001', '68800001', '43200001', '2026-10-29 21:05:46', '2026-10-29 21:05:46', '2.00 MB', 'CONTOSO\\dba', ''])
    expect(setCells(history[0])).toHaveLength(setColumns.length - 1)
  })
})

describe('the Backup Timeline', () => {
  it('keeps server-local times on a zone-free clock and moves the point by a minute, or an hour with Shift', () => {
    const at = timeMs('2026-10-29T21:05:43')!
    expect(timeText(at)).toBe('2026-10-29T21:05:43')
    expect([timeMs('2026-02-30T00:00:00'), timeMs('2026-10-29 21:05:43')]).toEqual([undefined, undefined])
    const span = timelineWindow(history, 'hour')
    expect([timeText(span.from), timeText(span.to)]).toEqual(['2026-10-29T20:05:46', '2026-10-29T21:05:46'])
    expect(timeText(stepPoint('ArrowRight', false, at, span)!)).toBe('2026-10-29T21:06:43')
    expect(timeText(stepPoint('ArrowLeft', true, at, span)!)).toBe('2026-10-29T20:05:43')
    expect(timeText(stepPoint('Home', false, at, span)!)).toBe('2026-10-29T20:05:46')
    expect(stepPoint('a', false, at, span)).toBeUndefined()
    // A point after the last backup moves the window's end with it.
    expect(timeText(timelineWindow(history, 'day', timeMs('2026-10-30T09:00:00')).to)).toBe('2026-10-30T09:00:00')
    // The logs cover from the full backup's finish to the last log's, as one stretch at the end of an hour's window.
    const stretches = coverage(history, span)
    expect(stretches).toHaveLength(1)
    expect(stretches[0].to).toBe(1)
    expect(stretches[0].from).toBeCloseTo(1 - 6 / 3600, 6)
  })
})
