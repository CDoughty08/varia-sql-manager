// D3b, Detach Database (D3 §6): the dialog's choices and what blocks OK (sessions, SQL Server's refusals, an offline database
// on Windows, A27), the request it sends, Copy paths, and what a detach leaves behind: orphaned Properties documents and a toast
// that says the files stay and offers their paths.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { actionRequestSchema, actionExecuteResultSchema, detachDatabaseStepTitle, type ActionDescribeResult, type ActionExecuteResult, type DatabaseFileRef, type DatabaseStateModel } from '../src/shared/actions/schema'
import { actionLimits } from '../src/shared/actions/catalog'
import type { ApiResult } from '../src/shared/contracts'
import { displayText, type ObjectRef } from '../src/shared/explorer/refs'
import { databaseGoneHandler, detachedNotice, filePathsText } from '../src/renderer/src/dialogs/database-gone'
import { detachBlocked, detachConfirmLabel, detachDatabaseDefinition, detachStateWords, detachStatisticsBlocked } from '../src/renderer/src/dialogs/definitions'
import { detachMessage } from '../src/renderer/src/dialogs/pages/DetachDatabasePage'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { goneMessage } from '../src/renderer/src/properties/DatabasePropertiesService'
import { databaseModel } from './fixtures/database-properties'
import { deferred } from './fixtures/documents'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const appData: ObjectRef = { kind: 'database', name: 'AppData' }
const identity = { id: 7, created: '2026-01-02T03:04:05.678' }
const node = (object: ObjectRef = appData, connectionId = 'c1', id = 12): ExplorerMenuNode => ({ id, connectionId, ref: { type: 'object', object }, kind: object.kind, label: object.name ?? '', lost: false })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const files: DatabaseFileRef[] = [{ fileId: 1, name: 'AppData', type: 'rows', path: 'D:\\Data\\AppData.mdf' }, { fileId: 2, name: 'AppData_log', type: 'log', path: 'D:\\Data\\AppData_log.ldf' }]
const model = (changes: Partial<DatabaseStateModel> = {}): DatabaseStateModel => ({
  name: 'AppData', identity, state: 0, userAccess: 0, readOnly: false, standby: false, sessions: 0, withTransaction: 0, sessionList: [], sessionsTruncated: false, warnings: [], files, filesTruncated: false, ...changes
})
const detached: ActionExecuteResult = { steps: [{ status: 'done', title: 'Close existing connections' }, { status: 'done', title: detachDatabaseStepTitle }], messages: [], elapsedMs: 1, filesKept: files }
const draft = { dropConnections: false, updateStatistics: false, detachOffline: false }

/** A workbench connected to c1 whose describe answers Detach Database's model and Database Properties'. */
function workbench(state = model()) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo('c1'))
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'databaseProperties'
    ? { databaseProperties: databaseModel(), elapsedMs: 1 } : { databaseState: state, elapsedMs: 1 }) as ActionDescribeResult }))
  return fixture
}

describe('Detach Database (D3b)', () => {
  it('keeps the detach step\'s title equal to the backend\'s, which says whether a reply removed the database', () => {
    const service = readFileSync(new URL('../backend/Varia.Backend/Actions/ActionService.cs', import.meta.url), 'utf8')
    expect(service).toContain(`ActionTemplate.DetachDatabase => "${detachDatabaseStepTitle}"`)
    const removes = detachDatabaseDefinition.removesDatabase!
    expect(removes(appData, detached.steps, true)).toBe(true)
    // sp_detach_db failed after SINGLE_USER, which was undone: the database is still there.
    expect(removes(appData, [{ status: 'done', title: 'Close existing connections' }, { status: 'failed', title: detachDatabaseStepTitle }, { status: 'done', title: 'Restore multi-user access', compensates: true }], false)).toBe(false)
    expect(removes(appData, [{ status: 'done', title: 'Close existing connections' }, { status: 'cancelled', title: detachDatabaseStepTitle }], false)).toBe(false)
  })

  it('waits for Drop Connections while sessions are connected, for SQL Server\'s refusals, and for Detach while offline on Windows', () => {
    expect(detachBlocked(model(), draft)).toBeUndefined()
    expect(detachBlocked(model({ sessions: 2 }), draft)).toBe('2 sessions are connected: check Drop Connections, or Check Again once they leave.')
    expect(detachBlocked(model({ sessions: 1 }), draft)).toBe('1 session is connected: check Drop Connections, or Check Again once it leaves.')
    expect(detachBlocked(model({ sessions: 2 }), { ...draft, dropConnections: true })).toBeUndefined()
    // Without VIEW SERVER STATE the sessions are unknown, and OK runs.
    expect(detachBlocked(model({ sessions: undefined }), draft)).toBeUndefined()
    const snapshot = 'A database snapshot of this database exists; drop the snapshot before you detach it.'
    expect(detachBlocked(model({ warnings: [{ text: snapshot, blocking: true }] }), { ...draft, dropConnections: true })).toBe(snapshot)
    // On Linux an offline database is a note only.
    expect(detachBlocked(model({ state: 6, warnings: [{ text: 'This database is offline.', blocking: false }] }), draft)).toBeUndefined()
    expect(detachBlocked(model({ state: 6, confirmOffline: true }), draft)).toBe('The database is offline: check Detach while offline, or bring it online first.')
    expect(detachBlocked(model({ state: 6, confirmOffline: true }), { ...draft, detachOffline: true })).toBeUndefined()
  })

  it('asks for its box of any database that is not online on Windows, worded by state as the backend words its refusal', () => {
    expect(detachBlocked(model({ state: 5, confirmOffline: true }), draft)).toBe('The database is in EMERGENCY mode: check Detach anyway, or bring it online first.')
    expect(detachBlocked(model({ state: 5, confirmOffline: true }), { ...draft, detachOffline: true })).toBeUndefined()
    expect([0, 5, 6, 10].map(detachStateWords)).toEqual(['not online', 'in EMERGENCY mode', 'offline', 'an offline secondary'])
    expect([5, 6].map(detachConfirmLabel)).toEqual(['Detach anyway', 'Detach while offline'])
    const service = readFileSync(new URL('../backend/Varia.Backend/Actions/ActionService.cs', import.meta.url), 'utf8')
    expect(service).toContain('== "offline" ? "Detach while offline" : "Detach anyway"')
    for (const words of ['"offline" => "offline"', '"emergency" => "in EMERGENCY mode"', '"offlineSecondary" => "an offline secondary"', '_ => "not online"']) expect(service).toContain(words)
  })

  it('clears Update Statistics where sp_updatestats cannot run, so a read-only, standby, EMERGENCY or offline database is never sent it', () => {
    expect(detachStatisticsBlocked(model())).toBeUndefined()
    expect(detachStatisticsBlocked(model({ readOnly: true }))).toBe('Update Statistics cannot run on a read-only or standby database.')
    expect(detachStatisticsBlocked(model({ standby: true }))).toBe('Update Statistics cannot run on a read-only or standby database.')
    expect(detachStatisticsBlocked(model({ state: 5 }))).toBe('Update Statistics cannot run while the database is in EMERGENCY mode.')
    expect(detachStatisticsBlocked(model({ state: 6 }))).toBe('Update Statistics cannot run while the database is offline.')
    const checked = { ...draft, updateStatistics: true }
    expect(detachDatabaseDefinition.request(appData, model(), checked)).toMatchObject({ updateStatistics: true })
    for (const blocked of [model({ readOnly: true }), model({ standby: true }), model({ state: 6, confirmOffline: true }), model({ state: 5, confirmOffline: true })])
      expect(detachDatabaseDefinition.request(appData, blocked, { ...checked, detachOffline: true })).toMatchObject({ updateStatistics: false })
  })

  it('sends the boxes and the identity it read, and Detach while offline only for a database that asked for it, as detachSchema takes them', () => {
    const request = detachDatabaseDefinition.request(appData, model(), { dropConnections: true, updateStatistics: true, detachOffline: true })
    expect(request).toEqual({ action: 'detach', target: appData, dropConnections: true, updateStatistics: true, identity })
    expect(detachDatabaseDefinition.request(appData, model({ state: 6, confirmOffline: true }), { ...draft, detachOffline: true })).toEqual({
      action: 'detach', target: appData, dropConnections: false, updateStatistics: false, identity, detachOffline: true
    })
    const ids = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    expect(actionRequestSchema.safeParse({ ...request, ...ids }).success).toBe(true)
    expect(actionRequestSchema.safeParse({ ...request, ...ids, updateStatistics: undefined }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request, ...ids, target: { kind: 'database', name: 'master' } }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ action: 'takeOffline', target: appData, dropConnections: false, updateStatistics: false, ...ids }).success).toBe(false)
    // The reply's files are bounded as the backend bounds them.
    expect(actionExecuteResultSchema.safeParse(detached).success).toBe(true)
    expect(actionExecuteResultSchema.safeParse({ ...detached, filesKept: [{ ...files[0], path: 'x'.repeat(actionLimits.filePath + 1) }] }).success).toBe(false)
    expect(actionExecuteResultSchema.safeParse({ ...detached, filesKept: Array.from({ length: actionLimits.detachFiles + 1 }, (_, index) => ({ ...files[0], fileId: index + 1 })) }).success).toBe(false)
  })

  it('runs from Tasks › Detach…, stays open on its steps, orphans the Properties document and says the files stay, with Copy paths', async () => {
    const fixture = workbench(model({ sessions: 1, withTransaction: 1, sessionList: [{ sessionId: 61, openTransactions: 1 }] }))
    const id = fixture.properties.open(node())
    await settled()
    for (const name of ['One.sql', 'Two.sql']) fixture.documents.newQuery('', name, 'c1', 'AppData')
    const execute = deferred<ApiResult<ActionExecuteResult>>()
    fixture.api.executeObjectAction.mockImplementation(() => execute.promise)
    fixture.dialogs.open('detachDatabase', node())
    await settled()
    expect(fixture.dialogs.current).toMatchObject({ dialog: 'detachDatabase', title: 'Detach Database - AppData', phase: 'ready', draft })
    expect(detachMessage(fixture.dialogs.current!, false)).toBe('1 active connection (1 with an open transaction)')
    await fixture.dialogs.ok()
    expect(fixture.api.executeObjectAction).not.toHaveBeenCalled()
    fixture.dialogs.updateDraft({ dropConnections: true })
    const ok = fixture.dialogs.ok()
    expect(detachMessage(fixture.dialogs.current!, false)).toBe('Closing connections and detaching the database…')
    execute.resolve({ ok: true, value: detached })
    await ok
    await settled()
    expect(fixture.dialogs.current).toMatchObject({ phase: 'succeeded', steps: detached.steps })
    expect(detachMessage(fixture.dialogs.current!, false)).toBe('The database was detached.')
    expect(fixture.properties.get(id)).toMatchObject({ gone: true, error: { code: 'NOT_FOUND', message: goneMessage('c1.example') } })
    const toast = fixture.notifications.getSnapshot().visible[0]
    expect(toast).toMatchObject({ severity: 'info', message: 'AppData was detached. Its 2 files stay on the server. 2 query windows were using AppData.' })
    expect(toast.actions?.map(action => action.label)).toEqual(['Copy paths'])
    toast.actions![0].run()
    expect(fixture.api.writeClipboardText).toHaveBeenLastCalledWith('D:\\Data\\AppData.mdf\nD:\\Data\\AppData_log.ldf')
    // The dialog's own Copy paths says so in its message bar.
    await fixture.dialogs.copyPaths()
    expect(fixture.dialogs.current?.notice).toBe('Copied 2 paths.')
  })

  it('leaves the database\'s documents alone when sp_detach_db failed or was stopped', async () => {
    const fixture = workbench()
    const id = fixture.properties.open(node())
    await settled()
    fixture.api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Close existing connections' }, { status: 'failed', title: detachDatabaseStepTitle, message: 'snapshot' },
      { status: 'done', title: 'Restore multi-user access', compensates: true }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: 'snapshot', retryable: false } } })
    fixture.dialogs.open('detachDatabase', node())
    await settled()
    fixture.dialogs.updateDraft({ dropConnections: true })
    await fixture.dialogs.ok()
    expect(fixture.dialogs.current?.phase).toBe('failed')
    expect(detachMessage(fixture.dialogs.current!, false)).toBe('snapshot')
    expect(fixture.properties.get(id)?.gone).toBeUndefined()
    expect(fixture.notifications.getSnapshot().visible).toEqual([])
  })

  it('words the toast for one file and for none listed, and copies paths one per line', () => {
    expect(detachedNotice('AppData', 1)).toBe('AppData was detached. Its file stays on the server.')
    expect(detachedNotice('AppData', 0)).toBe('AppData was detached. Its files stay on the server.')
    expect(detachedNotice('Sales‮Db', 1_200)).toBe(`${displayText('Sales‮Db')} was detached. Its 1,200 files stay on the server.`)
    expect(filePathsText(files)).toBe('D:\\Data\\AppData.mdf\nD:\\Data\\AppData_log.ldf')
    const toasts: { message: string; actions?: readonly unknown[] }[] = []
    const handler = databaseGoneHandler({ documents: { getSnapshot: () => ({ documents: [] }) }, properties: { databaseGone: () => {} }, notify: toast => { toasts.push(toast) }, copy: () => {} })
    handler({ connectionId: 'c1', server: 'c1.example', database: 'AppData', filesKept: [] })
    // A delete with no query window says nothing; a detach always says where the files are.
    handler({ connectionId: 'c1', server: 'c1.example', database: 'Sales' })
    expect(toasts).toEqual([{ severity: 'info', message: 'AppData was detached. Its files stay on the server.', key: 'database-gone:c1:AppData' }])
  })
})
