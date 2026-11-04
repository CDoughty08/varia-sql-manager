// D3d, Delete Database parity (D3 §8): Managed Instance greys Close existing connections, the sessions and open transactions
// a DROP meets are named, and a database Varia deletes leaves orphaned Properties documents and a toast for its query windows.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { promptLimits } from '../src/shared/actions/prompts'
import { dropDatabaseStepTitle, type ActionDescribeResult, type ActionExecuteResult, type DeleteTarget } from '../src/shared/actions/schema'
import type { ApiResult } from '../src/shared/contracts'
import { displayText, type ObjectRef } from '../src/shared/explorer/refs'
import { databaseGoneHandler, queryWindowsNotice } from '../src/renderer/src/dialogs/database-gone'
import { closeDescription, deleteObjectDefinition, rollbackNote } from '../src/renderer/src/dialogs/definitions'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { goneMessage } from '../src/renderer/src/properties/DatabasePropertiesService'
import { databaseModel } from './fixtures/database-properties'
import { deferred } from './fixtures/documents'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const appData: ObjectRef = { kind: 'database', name: 'AppData' }
const orders: ObjectRef = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }
const node = (object: ObjectRef = appData, connectionId = 'c1', id = 12): ExplorerMenuNode => ({ id, connectionId, ref: { type: 'object', object }, kind: object.kind, label: object.name ?? '', lost: false })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const target = (changes: Partial<DeleteTarget> = {}): DeleteTarget => ({ name: 'AppData', type: 'Database', warnings: [], dependentsTruncated: false, isSnapshot: false, sessions: 0, ...changes })
const dropped: ActionExecuteResult = { steps: [{ status: 'done', title: 'Close existing connections' }, { status: 'done', title: dropDatabaseStepTitle }], messages: [], elapsedMs: 1 }

/** A workbench connected to c1 whose describe answers Delete Object's `deleteTarget` and Database Properties' model. */
function workbench(deleteTarget = target()) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.connect(connectionInfo('c1'))
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'databaseProperties'
    ? { databaseProperties: databaseModel(), elapsedMs: 1 } : { deleteTarget, elapsedMs: 1 }) as ActionDescribeResult }))
  return fixture
}

describe('Delete Object on a database (D3d)', () => {
  it('keeps the DROP step\'s title equal to the backend\'s, which says whether a reply removed the database', () => {
    const service = readFileSync(new URL('../backend/Varia.Backend/Actions/ActionService.cs', import.meta.url), 'utf8')
    expect(service).toContain(`ActionTemplate.DropDatabase => "${dropDatabaseStepTitle}"`)
    const removes = deleteObjectDefinition.removesDatabase!
    expect(removes(appData, dropped.steps, true)).toBe(true)
    // The DROP completed, then the history step failed: the database is gone all the same.
    expect(removes(appData, [{ status: 'done', title: dropDatabaseStepTitle }, { status: 'failed', title: 'Delete backup and restore history' }], false)).toBe(true)
    // The DROP failed (a snapshot) and single-user mode was undone: the database is still there.
    expect(removes(appData, [{ status: 'done', title: 'Close existing connections' }, { status: 'failed', title: dropDatabaseStepTitle }, { status: 'done', title: 'Restore multi-user access', compensates: true }], false)).toBe(false)
    expect(removes(orders, [{ status: 'done', title: 'Drop the object' }], true)).toBe(false)
  })

  it('greys Close existing connections where the server cannot set SINGLE_USER, and never sends it there', () => {
    const managed = target({ closeConnectionsNote: 'Managed Instance cannot set SINGLE_USER.' })
    expect(deleteObjectDefinition.request(appData, managed, { deleteHistory: true, closeConnections: true })).toMatchObject({ closeConnections: false, deleteHistory: true })
    expect(deleteObjectDefinition.request(appData, target(), { deleteHistory: true, closeConnections: true })).toMatchObject({ closeConnections: true })
    // The backend greys it for an offline database too, which has no connections to close.
    const offline = target({ closeConnectionsNote: 'An offline database has no connections to close.' })
    expect(deleteObjectDefinition.request(appData, offline, { deleteHistory: true, closeConnections: true })).toMatchObject({ closeConnections: false })
    const service = readFileSync(new URL('../backend/Varia.Backend/Actions/ActionService.cs', import.meta.url), 'utf8')
    expect(service).toContain(`OfflineCloseNote = "${offline.closeConnectionsNote}"`)
  })

  it('says what Close existing connections rolls back under it, and only counts the transactions where it is greyed (A7)', () => {
    const tabs = { tabsWithTransactions: ['Load.sql'], moreTabsWithTransactions: 1 }
    const busy = target({ withTransaction: 2 })
    expect(rollbackNote(busy, tabs)).toBe('2 sessions have open transactions, which Close existing connections rolls back. Varia\'s query windows with an open transaction: Load.sql and 1 more.')
    expect(closeDescription(busy, rollbackNote(busy, tabs))).toBe('delete-object-rollback-note')
    // Managed Instance, an offline database and a snapshot grey the option: the note names no option the user cannot choose.
    for (const greyed of [target({ withTransaction: 1, closeConnectionsNote: 'Managed Instance cannot set SINGLE_USER.' }), target({ withTransaction: 1, closeConnectionsNote: 'An offline database has no connections to close.' }),
      target({ withTransaction: 1, isSnapshot: true })])
      expect(rollbackNote(greyed, {})).toBe('1 session has an open transaction.')
    const managed = target({ withTransaction: 4, closeConnectionsNote: 'Managed Instance cannot set SINGLE_USER.' })
    expect(closeDescription(managed, rollbackNote(managed, {}))).toBe('delete-object-close-note delete-object-rollback-note')
    expect(closeDescription(target(), rollbackNote(target(), {}))).toBeUndefined()
    // A greyed option's label greys with it, and with GrayText in forced colours.
    const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('.object-dialog-options .checkbox-label:has(input:disabled) { color: var(--varia-disabledForeground); }')
    expect(css).toContain('@media (forced-colors: active) { .object-dialog-options .checkbox-label:has(input:disabled) { color: GrayText; } }')
  })

  it('names the query tabs whose session the describe found holding a transaction in the database, whatever database each is in (A7)', async () => {
    const fixture = workbench()
    const names = Array.from({ length: promptLimits.tabs + 1 }, (_, index) => `Query ${index + 1}.sql`)
    const holding = names.map(name => fixture.documents.newQuery('', name, 'c1', 'AppData').id)
    // A tab in master whose transaction wrote to AppData is named; a tab on AppData without one is not.
    holding.push(fixture.documents.newQuery('', 'FromMaster.sql', 'c1', 'master').id)
    fixture.documents.newQuery('', 'Clean.sql', 'c1', 'AppData')
    fixture.api.describeObject.mockResolvedValueOnce({ ok: true, value: { deleteTarget: target({ sessions: 12, withTransaction: 10, transactionTabs: [...holding, 'closed-tab'] }), elapsedMs: 1 } })
    fixture.dialogs.open('deleteObject', node())
    await settled()
    expect(fixture.dialogs.current).toMatchObject({ phase: 'ready', tabsWithTransactions: names.slice(0, promptLimits.tabs), moreTabsWithTransactions: 2 })
    fixture.dialogs.close()
    fixture.dialogs.open('deleteObject', node(orders))
    await settled()
    expect(fixture.dialogs.current?.tabsWithTransactions).toBeUndefined()
  })

  it('orphans the database\'s Properties document and counts its query windows in a toast once it is deleted', async () => {
    const fixture = workbench()
    const id = fixture.properties.open(node())
    await settled()
    fixture.properties.updateDraft(id, { owner: 'AppUser' })
    expect(fixture.documents.get(id)?.dirty).toBe(true)
    for (const name of ['One.sql', 'Two.sql', 'Three.sql']) fixture.documents.newQuery('', name, 'c1', 'AppData')
    fixture.documents.newQuery('', 'Other.sql', 'c1', 'Sales')
    const execute = deferred<ApiResult<ActionExecuteResult>>()
    fixture.api.executeObjectAction.mockImplementation(() => execute.promise)
    fixture.dialogs.open('deleteObject', node())
    await settled()
    fixture.dialogs.updateDraft({ closeConnections: true })
    const ok = fixture.dialogs.ok()
    execute.resolve({ ok: true, value: dropped })
    await ok
    expect(fixture.dialogs.current).toBeUndefined()
    const state = fixture.properties.get(id)!
    expect(state).toMatchObject({ gone: true, changed: false, error: { code: 'NOT_FOUND', message: goneMessage('c1.example') } })
    expect(goneMessage('c1.example')).toBe('This database no longer exists on c1.example.')
    expect(fixture.documents.get(id)?.dirty).toBe(false)
    expect([fixture.properties.canRefresh(id), fixture.properties.canApply(id), fixture.properties.canEdit(id), fixture.properties.canDiscard(id)]).toEqual([false, false, false, false])
    expect(fixture.notifications.getSnapshot().visible.map(toast => [toast.severity, toast.message])).toEqual([['info', '3 query windows were using AppData.']])
    // Close is the banner's way out, and asks nothing.
    fixture.properties.closeGone(id)
    await settled()
    expect(fixture.documents.get(id)).toBeUndefined()
  })

  it('orphans nothing when the DROP failed, and orphans the documents when only a later step failed', async () => {
    const fixture = workbench()
    const id = fixture.properties.open(node())
    await settled()
    fixture.api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Close existing connections' }, { status: 'failed', title: dropDatabaseStepTitle, message: 'snapshot' },
      { status: 'done', title: 'Restore multi-user access', compensates: true }], messages: [], elapsedMs: 1, error: { code: 'DEPENDENTS', message: 'snapshot', retryable: false } } })
    fixture.dialogs.open('deleteObject', node())
    await settled()
    await fixture.dialogs.ok()
    expect(fixture.dialogs.current?.phase).toBe('failed')
    expect(fixture.properties.get(id)?.gone).toBeUndefined()
    fixture.api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: dropDatabaseStepTitle }, { status: 'failed', title: 'Delete backup and restore history', message: 'denied' }],
      messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'denied', retryable: false } } })
    await fixture.dialogs.ok()
    expect(fixture.properties.get(id)?.gone).toBe(true)
    // No query window used it: no toast.
    expect(fixture.notifications.getSnapshot().visible).toEqual([])
    // Properties on a database that has taken the name since reads that one.
    fixture.dialogs.close()
    fixture.properties.open(node())
    await settled()
    expect(fixture.properties.get(id)).toMatchObject({ phase: 'ready' })
    expect(fixture.properties.get(id)?.gone).toBeUndefined()
    expect(fixture.properties.canRefresh(id)).toBe(true)
  })

  it('counts only query windows on that connection and database, and words the toast for one', () => {
    const calls: string[] = [], toasts: string[] = []
    const handler = databaseGoneHandler({
      documents: { getSnapshot: () => ({ documents: [{ connectionId: 'c1', database: 'AppData' }, { connectionId: 'c2', database: 'AppData' }, { connectionId: 'c1', database: 'AppData', kind: 'databaseProperties' }] }) },
      properties: { databaseGone: (connectionId, database) => { calls.push(`${connectionId}/${database}`) } },
      notify: toast => { toasts.push(toast.message) }
    })
    handler({ connectionId: 'c1', server: 'c1.example', database: 'AppData' })
    expect(calls).toEqual(['c1/AppData'])
    expect(toasts).toEqual(['1 query window was using AppData.'])
    // A name's control characters are shown, not obeyed.
    expect(queryWindowsNotice(1_200, 'Sales‮Db')).toBe(`1,200 query windows were using ${displayText('Sales‮Db')}.`)
    expect(queryWindowsNotice(2, 'Sales‮Db')).not.toContain('‮')
  })
})
