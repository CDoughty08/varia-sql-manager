import { afterEach, describe, expect, it } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { messageGroupOf, ssisLimits } from '../src/shared/ssis/catalog'
import {
  durationText, executionSeconds, executionText, executionTitle, groupChipLabel, groupCounts, isExecutionId, messageColumns, messageTime, requestGroups, secondsBetween, sourceTypeLabel, toggleGroup, totalMessages
} from '../src/shared/ssis/execution'
import { ssisExecutionSchema, type SsisExecutionModel, type SsisExecutionResult } from '../src/shared/ssis/schema'
import { isCustomKind, kindInfo } from '../src/renderer/src/documents'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { executionFacts, messageCell, messagesTable, overviewRows } from '../src/renderer/src/ssis/SsisExecution'
import { deferred } from './fixtures/documents'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const uuid = '00000000-0000-4000-8000-000000000001'
const model = (id = 48213, patch: Partial<SsisExecutionModel> = {}): SsisExecutionModel => ({
  overview: {
    id, folder: 'Finance', project: 'Loads', package: 'Daily.dtsx', executedAs: 'CONTOSO\\agent', caller: 'CONTOSO\\agent', use32bit: false, status: 4,
    created: '2026-11-15T02:30:58.0000000+01:00', started: '2026-11-15T02:31:00.0000000+01:00', ended: '2026-11-15T02:32:05.5000000+01:00', now: '2026-11-15T08:00:00.0000000+01:00'
  },
  counts: [{ type: 30, count: 1 }, { type: 70, count: 4 }, { type: 110, count: 2 }, { type: 120, count: 1 }, { type: 130, count: 1 }],
  groups: ['error', 'warning', 'information', 'other'],
  messages: [
    { id: 9, time: '2026-11-15T02:32:05.1230000+01:00', type: 120, sourceType: 40, source: 'Load facts', package: 'Daily.dtsx', event: 'OnError', path: '\\Daily\\Load facts', code: -1071636471, message: 'Line one\r\nLine two\tcol\u0007' },
    { id: 1, time: '2026-11-15T02:31:00.0000000+01:00', type: 30, message: 'Operation started.' }
  ],
  truncated: false,
  ...patch
})
const answer = (value: SsisExecutionResult): ApiResult<SsisExecutionResult> => ({ ok: true, value })

/** A LiveGrid stand-in for the Operations document: its active row is one operation, as the grid stores its cells. */
class FakeGrid extends SnapshotStore<LiveGridSnapshot> {
  select(key: string, cells: string[], read?: Promise<void>) {
    const handle = { getWindow: async () => { await read; return { first: 0, count: 1, colStart: 0, colEnd: 7, text: cells, flags: new Uint8Array(7) } } }
    this.publish({ newRows: 0, following: true, lost: false, activeKey: key, selection: { entry: 'live', active: { row: 3, col: 1 }, anchor: { row: 3, col: 1 }, blocks: [] }, table: { handle } } as unknown as LiveGridSnapshot)
  }
}

function executions() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.api.executionSsis.mockImplementation(async params => answer({ model: model(params.executionId, params.groups ? { groups: params.groups } : {}), elapsedMs: 1 }))
  fixture.connect(connectionInfo('c1'))
  const requests = () => fixture.api.executionSsis.mock.calls.map(([request]) => request)
  const state = (id: string) => fixture.ssisExecutions.get(id)!
  return { ...fixture, requests, state }
}

describe('SSIS execution messages helpers', () => {
  it('group message types as SSMS\'s report filters do, count them, and never leave no group chosen', () => {
    expect([120, 130, 110, 70, 60, 30, 10].map(messageGroupOf)).toEqual(['error', 'error', 'warning', 'information', 'other', 'other', 'other'])
    const counts = groupCounts(model())
    expect(counts).toEqual({ error: 2, warning: 2, information: 4, other: 1 })
    expect(totalMessages(model())).toBe(9)
    expect(groupChipLabel('error', 1234)).toBe('Errors (1,234)')
    expect(groupChipLabel('other', undefined)).toBe('Other')
    expect(toggleGroup(['error', 'warning', 'information', 'other'], 'warning')).toEqual(['error', 'information', 'other'])
    expect(toggleGroup(['other'], 'error')).toEqual(['error', 'other'])
    expect(toggleGroup(['error'], 'error')).toEqual(['error', 'warning', 'information', 'other'])
    expect(requestGroups(['error', 'warning', 'information', 'other'])).toBeUndefined()
    expect(requestGroups(['other', 'error'])).toEqual(['error', 'other'])
  })
  it('write durations and times as SSMS\'s reports do, in the catalog\'s own offset', () => {
    expect(secondsBetween('2026-11-15T02:31:00+01:00', '2026-11-15T02:32:05.5+01:00')).toBe(65)
    expect(secondsBetween('2026-11-15T02:31:00+01:00', '2026-11-15T01:31:00+00:00')).toBe(0)
    expect(secondsBetween(undefined, '2026-11-15T02:32:05+01:00')).toBeUndefined()
    expect(durationText(65)).toBe('00:01:05')
    expect(durationText(2 * 86_400 + 3 * 3600)).toBe('2.03:00:00')
    expect(durationText(undefined)).toBe('')
    expect(executionSeconds(model().overview)).toBe(65)
    // Still running: up to the server's clock when it was read, not this machine's.
    expect(executionSeconds({ ...model().overview, status: 2, ended: undefined })).toBe(5 * 3600 + 29 * 60)
    expect(messageTime('2026-11-15T02:32:05.1230000+01:00')).toBe('2026-11-15 02:32:05.123 +01:00')
    expect(messageTime('2026-11-15T02:32:05Z')).toBe('2026-11-15 02:32:05.000 +00:00')
  })
  it('lists messages newest first with their columns, keeping line breaks and naming other control characters', () => {
    const table = messagesTable(model().messages)
    expect(table.columns.map(column => column.name)).toEqual(messageColumns.map(column => column.title))
    expect(table.rows[0].slice(0, 4)).toEqual(['2026-11-15 02:32:05.123 +01:00', 'Error', 'Load facts', 'Line one\r\nLine two\tcol⟨U+0007⟩'])
    expect(table.rows[0].slice(4)).toEqual(['Daily.dtsx', 'OnError', 'Control flow task', '\\Daily\\Load facts', '-1071636471'])
    // An operation-only message has no event columns; the backend sends null for them.
    const bare = { id: 2, time: '2026-11-15T02:31:00+01:00', type: 30, sourceType: null, source: null, code: null, message: 'x' } as never
    expect(messagesTable([bare]).rows[0].slice(2)).toEqual(['', 'x', '', '', '', '', ''])
    expect(sourceTypeLabel(null)).toBe('')
    expect(messageCell('a‮b')).not.toContain('‮')
  })
  it('lays the overview out as SSMS\'s Overview report does, with the facts in the header', () => {
    const rows = Object.fromEntries(overviewRows({ ...model().overview, environment: 'Prod', environmentFolder: 'Shared' }))
    expect(rows).toMatchObject({ Execution: '48213', Status: 'Failed', Folder: 'Finance', Package: 'Daily.dtsx', Environment: 'Shared\\Prod', Duration: '00:01:05', 'Stopped by': '' })
    expect(Object.fromEntries(overviewRows({ ...model().overview, environment: 'Test' }))['Environment']).toBe('.\\Test')
    expect(executionFacts(model()).map(fact => `${fact.label} ${fact.value}`)).toEqual(['Package Daily.dtsx', 'Duration 00:01:05', 'Errors 2', 'Warnings 2'])
    expect(executionFacts(undefined)).toEqual([])
  })
  it('send main only a positive id that crosses JSON exactly and distinct known groups', () => {
    const ok = { connectionId: uuid, requestId: uuid, executionId: 48213 }
    expect(ssisExecutionSchema.safeParse(ok).success).toBe(true)
    expect(ssisExecutionSchema.safeParse({ ...ok, groups: ['error', 'other'] }).success).toBe(true)
    for (const bad of [{ ...ok, executionId: 0 }, { ...ok, executionId: 1.5 }, { ...ok, executionId: Number.MAX_SAFE_INTEGER + 1 }, { ...ok, groups: [] }, { ...ok, groups: ['error', 'error'] },
      { ...ok, groups: ['fatal'] }, { ...ok, extra: 1 }, { ...ok, connectionId: 'x' }]) expect(ssisExecutionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(isExecutionId(48213)).toBe(true)
    expect(isExecutionId(0)).toBe(false)
    expect(ssisLimits.executionMessages).toBe(5000)
  })
})

describe('SSIS execution messages documents', () => {
  it('open as a read-only tab named for the execution on SSISDB, read it, and show an open one again', async () => {
    const { ssisExecutions: service, documents, requests, state } = executions()
    const id = service.open('c1', 48213)
    expect(documents.active).toMatchObject({ id, kind: 'ssisExecution', name: executionTitle(48213), connectionId: 'c1', database: 'SSISDB', dirty: false })
    expect(isCustomKind('ssisExecution')).toBe(true)
    expect(kindInfo.ssisExecution.icon).toBe('output')
    expect(state(id)).toMatchObject({ loading: true, executionId: 48213, serverLabel: 'c1.example' })
    await settled()
    expect(requests()).toEqual([{ connectionId: 'c1', requestId: expect.any(String), executionId: 48213 }])
    expect(state(id)).toMatchObject({ loading: false, gone: false, model: { overview: { id: 48213 } } })
    documents.newQuery()
    expect(service.open('c1', 48213)).toBe(id)
    expect(documents.active?.id).toBe(id)
    await settled()
    expect(requests()).toHaveLength(2)
    expect(service.open('c1', 7)).not.toBe(id)
    expect(() => service.open('c1', 0)).toThrow()
    expect(() => service.open('nope', 5)).toThrow('Connect to the server first.')
  })
  it('read again with only the chosen types, keeping the shown model while it reads, and F5 refreshes', async () => {
    const { ssisExecutions: service, api, requests, state, commands } = executions()
    const id = service.open('c1', 48213)
    await settled()
    const pending = deferred<ApiResult<SsisExecutionResult>>()
    api.executionSsis.mockReturnValueOnce(pending.promise)
    service.toggleGroup(id, 'information')
    expect(state(id)).toMatchObject({ loading: true, groups: ['error', 'warning', 'other'], model: { groups: ['error', 'warning', 'information', 'other'] } })
    expect(requests().at(-1)).toMatchObject({ groups: ['error', 'warning', 'other'] })
    // A second change cancels the first read; its late answer is ignored.
    service.toggleGroup(id, 'other')
    expect(api.cancelSsis).toHaveBeenCalledWith([requests().at(-2)!.requestId])
    pending.resolve(answer({ model: model(48213, { groups: ['error', 'warning', 'other'] }), elapsedMs: 1 }))
    await settled()
    expect(state(id).model?.groups).toEqual(['error', 'warning'])
    service.showAll(id)
    await settled()
    expect(requests().at(-1)?.groups).toBeUndefined()
    expect(evaluateWhen(compileWhen(commandDescriptor('ssis.refreshExecution').keybindings![0].when!), { activeDocumentIsSsisExecution: true } as never)).toBe(true)
    expect(await commands.execute('ssis.refreshExecution', { tabId: id }, 'toolbar')).not.toBe(false)
    await settled()
    expect(requests()).toHaveLength(5)
  })
  it('says a purged execution, a missing catalog and a refused login as values, and drops the model only when it is gone', async () => {
    const { ssisExecutions: service, api, state } = executions()
    api.executionSsis.mockResolvedValueOnce(answer({ elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'Execution 5 is not in the SSIS Catalog: the catalog\'s retention cleanup may have removed it.', retryable: false } }))
    const purged = service.open('c1', 5)
    await settled()
    expect(state(purged)).toMatchObject({ gone: true, loading: false, error: { code: 'NOT_FOUND' } })
    expect(state(purged).model).toBeUndefined()
    api.executionSsis.mockResolvedValueOnce(answer({ elapsedMs: 1, error: { code: 'CATALOG_MISSING', message: 'No SSISDB.', retryable: false } }))
    expect(state(service.open('c1', 6))).toBeDefined()
    await settled()
    expect(Object.values(service.getSnapshot().documents).find(item => item.executionId === 6)).toMatchObject({ gone: true, error: { code: 'CATALOG_MISSING' } })
    const shown = service.open('c1', 7)
    await settled()
    api.executionSsis.mockResolvedValueOnce(answer({ elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Not allowed.', retryable: false } }))
    service.refresh(shown)
    await settled()
    expect(state(shown)).toMatchObject({ gone: false, error: { code: 'PERMISSION_DENIED' }, model: { overview: { id: 7 } } })
    api.executionSsis.mockResolvedValueOnce({ ok: false, error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    service.refresh(shown)
    await settled()
    expect(state(shown).error).toEqual({ code: 'BACKEND_LOST', message: 'The SQL backend stopped.', retryable: true })
    // A failed type change puts the chips back to the list still shown.
    api.executionSsis.mockResolvedValueOnce(answer({ elapsedMs: 1, error: { code: 'TIMEOUT', message: 'Too slow.', retryable: true } }))
    service.toggleGroup(shown, 'information')
    expect(state(shown).groups).toEqual(['error', 'warning', 'other'])
    await settled()
    expect(state(shown)).toMatchObject({ groups: ['error', 'warning', 'information', 'other'], error: { code: 'TIMEOUT' } })
    // A gone document may read again: a catalog created since answers.
    expect(service.canRefresh(Object.values(service.getSnapshot().documents).find(item => item.executionId === 6)!.id)).toBe(true)
  })
  it('cancels a read when its tab closes or its server disconnects, keeping the last model', async () => {
    const { ssisExecutions: service, api, documents, requests, state, connections } = executions()
    const pending = deferred<ApiResult<SsisExecutionResult>>()
    api.executionSsis.mockReturnValueOnce(pending.promise)
    const closing = service.open('c1', 1)
    await documents.close(closing)
    expect(api.cancelSsis).toHaveBeenCalledWith([requests()[0].requestId])
    expect(service.get(closing)).toBeUndefined()
    pending.resolve(answer({ model: model(1), elapsedMs: 1 }))
    const id = service.open('c1', 2)
    await settled()
    api.executionSsis.mockReturnValueOnce(new Promise(() => {}))
    service.refresh(id)
    connections.markLostBefore(2)
    await settled()
    expect(api.cancelSsis).toHaveBeenLastCalledWith([requests().at(-1)!.requestId])
    expect(state(id)).toMatchObject({ disconnected: true, loading: false, model: { overview: { id: 2 } } })
    expect(service.canRefresh(id)).toBe(false)
  })
  it('opens from an execution\'s row in Integration Services Operations, and says why another operation has none', async () => {
    const { operations, ssisExecutions: service, commands, documents, context } = executions()
    const tab = operations.open('c1', 'executions')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    operations.attachGrid(tab, grid as unknown as LiveGrid)
    grid.select('103', ['103', 'Create and start execution', 'Failed', 'Finance', 'Loads', 'Daily.dtsx', ''])
    await settled()
    expect(context.getState().activeDocumentIsSsisOperations).toBe(true)
    expect(commands.isEnabled('ssis.viewExecutionMessages', { tabId: tab })).toBe(true)
    await commands.execute('ssis.viewExecutionMessages', { tabId: tab }, 'toolbar')
    await settled()
    expect(documents.active).toMatchObject({ kind: 'ssisExecution', name: 'Execution 103', connectionId: 'c1' })
    expect(service.get(documents.active!.id)?.model?.overview.id).toBe(103)
    documents.activate(tab)
    grid.select('44', ['44', 'Deploy project', 'Succeeded', '', '', '', 'Loads'])
    await settled()
    expect(commands.isEnabled('ssis.viewExecutionMessages', { tabId: tab })).toBe(false)
    // An operation whose cells are still being read when View Messages runs says why, once they arrive, instead of opening nothing.
    grid.select('45', ['45', 'Deploy project', 'Succeeded', '', '', '', 'Loads'], new Promise(resolve => setTimeout(resolve, 0)))
    expect(operations.executionSelected(tab)).toBe(true)
    expect(await operations.selectedExecution(tab)).toBeUndefined()
    expect(operations.get(tab)?.notice).toEqual({ tone: 'info', text: executionText.notExecution(45) })
    expect(commandDescriptor('ssis.viewExecutionMessages').menus?.some(menu => menu.menu === 'ssis.operation.context')).toBe(true)
  })
})
