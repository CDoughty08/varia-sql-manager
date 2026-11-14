import { afterEach, describe, expect, it } from 'vitest'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { connectionInfo, connectionOptions, manualTimers, readyBackend, workbenchFixture } from './fixtures/workbench'
import { databaseModel } from './fixtures/database-properties'
import { deferred } from './fixtures/documents'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
const session = { sessionId: 57, loginTime: '2026-11-09T08:00:00.000', hostProcessId: 4100 }
function fixture() {
  const value = workbenchFixture({ timers: manualTimers().timers }), targetId = id(1), handle = id(50)
  cleanups.push(value.dispose)
  value.api.push(readyBackend())
  const accept = (connectionId: string) => {
    const attempt = value.connections.beginConnect(connectionOptions, 1, targetId)!
    expect(value.connections.accept(connectionInfo(connectionId), connectionOptions, targetId, { principal: { provider: 'sqlServer', authentication: 'sql', id: 'reader' } }, attempt).status).toBe('accepted')
  }
  accept(handle)
  const beginDisconnect = () => value.connectionTargets.beginDisconnect(targetId, crypto.randomUUID())!
  const completeDisconnect = (operation: ReturnType<typeof beginDisconnect>) => { value.connectionTargets.completeDisconnect(operation); value.targets.detached(targetId, { id: handle, generation: 1 }) }
  return { ...value, targetId, handle, accept, beginDisconnect, completeDisconnect }
}
const node = (connectionId: string, tables = false): ExplorerMenuNode => ({ id: tables ? 5 : 3, connectionId, lost: false, kind: 'folder', folder: tables ? 'tables' : 'databases', label: tables ? 'Tables' : 'Databases',
  ref: { type: 'folder', owner: tables ? { kind: 'database', name: 'AppData' } : { kind: 'server' }, folder: tables ? 'tables' : 'databases' } })

/** One selected operation read through the same worker contract as the mounted live grid. */
class OperationGrid extends SnapshotStore<LiveGridSnapshot> {
  constructor() { super({ newRows: 0, following: true, lost: false }) }
  select() {
    const handle = { getWindow: async () => ({ first: 0, count: 1, colStart: 0, colEnd: 7, text: ['42', 'Create and start execution', 'Running', 'Finance', 'Loads', 'Daily.dtsx', ''], flags: new Uint8Array(7) }) }
    this.publish({ newRows: 0, following: true, lost: false, activeKey: '42', selection: { entry: 'live', active: { row: 3, col: 1 }, anchor: { row: 3, col: 1 }, blocks: [] }, table: { handle } } as unknown as LiveGridSnapshot)
  }
}

describe('custom document reconnect context', () => {
  it('enables valid preserved drafts immediately on exact manual document attachment, with no new describe or premature detach', async () => {
    const f = fixture()
    f.api.describeObject.mockImplementation(async request => ({ ok: true, value: (request.dialog === 'newDatabase' ? {
      newDatabase: { model: databaseModel(), dataPath: 'C:\\Data', logPath: 'C:\\Logs', serverCollation: 'Latin1_General_CI_AS', canCreate: true, masterLevel: 160, linux: false }, elapsedMs: 1
    } : { tableDesigner: { database: 'AppData', band: 16, schemas: ['dbo'], schemasTruncated: false, defaultSchema: 'dbo', defaultFilegroup: 'PRIMARY', caseSensitiveNames: false, accentSensitiveNames: true, canCreate: true }, elapsedMs: 1 }) as ActionDescribeResult }))
    const database = f.newDatabase.open(node(f.handle)), table = f.designers.open(node(f.handle, true))
    await expect.poll(() => [f.newDatabase.get(database)?.phase, f.designers.get(table)?.phase]).toEqual(['ready', 'ready'])
    f.newDatabase.setName(database, 'Sales')
    f.designers.setCell(table, 0, 'name', 'DraftId')
    expect(f.newDatabase.context.getSnapshot().byDocument[database].creatable).toBe(true)
    expect(f.designers.context.getSnapshot().byDocument[table].editable).toBe(true)
    const rows = f.designers.get(table)?.rows, operation = f.beginDisconnect()
    expect(f.documents.get(database)?.connectionId).toBe(f.handle)
    expect(f.documents.get(table)?.connectionId).toBe(f.handle)
    expect(f.newDatabase.context.getSnapshot().byDocument[database].creatable).toBe(false)
    expect(f.designers.context.getSnapshot().byDocument[table].editable).toBe(false)
    f.completeDisconnect(operation)
    f.accept(id(51))
    f.targets.attachTarget(f.targetId, id(51))
    expect(f.documents.get(database)?.connectionId).toBeUndefined()
    expect(f.newDatabase.context.getSnapshot().byDocument[database].creatable).toBe(false)
    f.targets.attachTarget(f.targetId, id(51), true)
    expect(f.newDatabase.context.getSnapshot().byDocument[database].creatable).toBe(true)
    expect(f.designers.context.getSnapshot().byDocument[table].editable).toBe(true)
    expect(f.newDatabase.get(database)?.name).toBe('Sales')
    expect(f.designers.get(table)?.rows).toBe(rows)
    expect(f.api.describeObject).toHaveBeenCalledTimes(2)
  })

  it('drops a late Kill report and refresh when its monitor now belongs to a fresh handle', async () => {
    const f = fixture(), monitor = f.activity.open(f.handle), pending = deferred<Awaited<ReturnType<typeof f.api.activityKill>>>()
    f.api.activityKill.mockReturnValueOnce(pending.promise)
    f.activity.askKill(monitor, session)
    const killing = f.activity.confirmKill(monitor)
    const operation = f.beginDisconnect()
    expect(f.activity.killOffer(monitor, session).allowed).toBe(false)
    f.completeDisconnect(operation)
    f.accept(id(51)); f.targets.attachTarget(f.targetId, id(51), true)
    const refreshes = f.liveViews.last.calls.filter(call => call.method === 'refresh').length
    pending.resolve({ ok: true, value: { results: [{ sessionId: 57, outcome: 'killed' }], elapsedMs: 3 } })
    await killing
    expect(f.activity.get(monitor)?.kill).toBeUndefined()
    expect(f.activity.get(monitor)?.killReport).toBeUndefined()
    expect(f.liveViews.last.calls.filter(call => call.method === 'refresh')).toHaveLength(refreshes)
    expect(f.documents.get(monitor)?.connectionId).toBe(id(51))
  })

  it('drops a late Stop notice and refresh after exact reconnect, and refuses a new stop while disconnecting', async () => {
    const f = fixture(), operations = f.operations.open(f.handle, 'active'), grid = new OperationGrid()
    f.operations.attachGrid(operations, grid as unknown as LiveGrid)
    grid.select()
    await expect.poll(() => f.operations.get(operations)?.selected?.id).toBe(42)
    const pending = deferred<Awaited<ReturnType<typeof f.api.executeSsis>>>()
    f.api.executeSsis.mockReturnValueOnce(pending.promise)
    await f.operations.requestStop(operations)
    f.operations.answerStop(operations, true)
    expect(f.api.executeSsis).toHaveBeenCalledOnce()
    const operation = f.beginDisconnect()
    expect(f.operations.stoppable(operations)).toBe(false)
    expect(f.operations.refreshable(operations)).toBe(false)
    await f.operations.requestStop(operations)
    expect(f.api.executeSsis).toHaveBeenCalledOnce()
    f.completeDisconnect(operation)
    f.accept(id(51)); f.targets.attachTarget(f.targetId, id(51), true)
    pending.resolve({ ok: true, value: { steps: [], elapsedMs: 1 } })
    await pending.promise
    await Promise.resolve()
    expect(f.operations.get(operations)).toMatchObject({ connectionId: id(51), stopping: [] })
    expect(f.operations.get(operations)?.notice).toBeUndefined()
    expect(f.operations.get(operations)?.confirm).toBeUndefined()
    expect((f.operations.handle(operations) as unknown as { refreshes: number }).refreshes).toBe(0)
  })
})
