import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { liveProbes } from '../src/shared/live/catalog'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { operationStatuses, operationTiles, ssisLimits } from '../src/shared/ssis/catalog'
import { operationStatusOrder, operationStoppable, operationsPresetSpecs, operationsWindows, windowLabel } from '../src/shared/ssis/operations'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import SsisOperations from '../src/renderer/src/ssis/SsisOperations'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import type { LiveSnapshot } from '../src/renderer/src/live/LiveService'
import { pillStatus } from '../src/renderer/src/live/status'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import {
  filtered, operationsArgs, operationsText, stopNotice, tilePressed, toggleKind, toggleStatus, toggleTile, withText, type SsisOperationsFilters
} from '../src/renderer/src/ssis/SsisOperationsService'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { SsisOperationsArgs } from '../src/shared/ssis/schema'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const base: SsisOperationsFilters = { windowHours: 24, limit: 1000 }
const ssisdb = (connectionId: string, lost = false): ExplorerMenuNode => ({
  id: 9, lost, kind: 'ssisCatalog', connectionId, label: 'SSISDB', ref: { type: 'object', object: { kind: 'ssisCatalog', name: 'SSISDB' } }
})

/** A LiveGrid stand-in whose active row is one operation: its cells as the grid stores them (labels for codes). */
class FakeGrid extends SnapshotStore<LiveGridSnapshot> {
  copy = vi.fn(async (_headers: boolean) => ({ ok: true as const, value: { rows: 1, bytes: 1, truncatedCells: 0, partial: false } }))
  cells: string[] = []
  /** With `read`, the cells arrive only when the test resolves it, as a worker round trip would. */
  select(key: string | undefined, cells: string[] = [], read?: Promise<void>) {
    this.cells = cells
    const handle = { getWindow: async () => { await read; return { first: 0, count: 1, colStart: 0, colEnd: 7, text: cells, flags: new Uint8Array(7) } } }
    this.publish({ newRows: 0, following: true, lost: false, ...key === undefined ? {} : { activeKey: key, selection: { resultIndex: 0, active: { row: 3, col: 1 }, anchor: { row: 3, col: 1 }, blocks: [] }, table: { handle } } } as unknown as LiveGridSnapshot)
  }
}

function operations(settings: Record<string, unknown> = {}) {
  const fixture = workbenchFixture({ settings })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const handle = () => fixture.live.handles.at(-1) as FakeLiveHandle
  return { ...fixture, handle }
}

describe('Integration Services Operations filters', () => {
  it('send only what filters, with the window and limit always', () => {
    expect(operationsArgs(base)).toEqual({ windowHours: 24, limit: 1000 })
    expect(operationsArgs({ ...base, folder: '', prefix: true, kinds: [], statuses: [] })).toEqual({ windowHours: 24, limit: 1000 })
    expect(operationsArgs({ ...base, folder: 'Fin', prefix: true, caller: 'CORP\\etl', kinds: ['execution'], statuses: [2] }))
      .toEqual({ kinds: ['execution'], statuses: [2], folder: 'Fin', prefix: true, caller: 'CORP\\etl', windowHours: 24, limit: 1000 })
    // Whatever the filters, the args pass main's schema for the source.
    for (const filters of [base, { ...base, folder: 'x'.repeat(ssisLimits.name), package: 'p'.repeat(ssisLimits.packageName), prefix: true, windowHours: ssisLimits.operationsWindowHours, limit: ssisLimits.operationsRows }]) {
      expect(liveArgsSchemas['ssis.operations'].safeParse(operationsArgs(filters)).success).toBe(true)
    }
    expect(filtered(base)).toBe(false)
    expect(filtered({ ...base, caller: 'sa' })).toBe(true)
  })
  it('pass main\'s schema exactly where the backend accepts them (the args fixture both suites read)', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/live/ssis-operations-args.json', 'utf8')) as { accepted: unknown[]; refused: unknown[] }
    const schema = liveArgsSchemas['ssis.operations']
    expect(fixture.accepted.length).toBeGreaterThanOrEqual(3)
    expect(fixture.refused.length).toBeGreaterThanOrEqual(20)
    expect(fixture.accepted.filter(args => !schema.safeParse(args).success)).toEqual([])
    expect(fixture.refused.filter(args => schema.safeParse(args).success)).toEqual([])
  })
  it('toggle chips, where every value on is no filter, and cut names to the source\'s bounds', () => {
    const one = toggleKind(base, 'deploy')
    expect(one.kinds).toEqual(['deploy'])
    expect(toggleKind(one, 'deploy').kinds).toBeUndefined()
    const all = ['execution', 'validation', 'deploy'].reduce((filters, kind) => toggleKind(filters, kind as 'execution'), base)
    expect(all.kinds).toEqual(['execution', 'validation', 'deploy'])
    expect(toggleKind(all, 'other').kinds).toBeUndefined()
    expect(toggleStatus(toggleStatus(base, 4), 2).statuses).toEqual([2, 4])
    expect(withText(base, 'folder', 'f'.repeat(300)).folder).toHaveLength(ssisLimits.name)
    expect(withText({ ...base, folder: 'x' }, 'folder', '')).toEqual(base)
  })
  it('press a tile for its statuses, and its hours when it counts a window; pressing again shows every status', () => {
    const [running, , failed] = operationTiles
    const pressed = toggleTile({ ...base, windowHours: 168 }, failed)
    expect(pressed).toEqual({ ...base, statuses: [4, 6] })
    expect(tilePressed(pressed, failed)).toBe(true)
    expect(tilePressed(pressed, running)).toBe(false)
    expect(toggleTile(pressed, failed)).toEqual(base)
    expect(toggleTile({ ...base, windowHours: 168 }, running)).toEqual({ ...base, windowHours: 168, statuses: [2] })
  })
  it('order the status chips as the tiles are, open statuses first, naming every status once', () => {
    expect(operationStatusOrder.slice(0, 2)).toEqual(operationTiles.slice(0, 2).flatMap(tile => tile.statuses))
    expect([...operationStatusOrder].sort((a, b) => a - b)).toEqual(operationStatuses.map(status => status.code))
    expect(operationStatusOrder.indexOf(4)).toBeLessThan(operationStatusOrder.indexOf(7))
    expect(operationStatusOrder.indexOf(7)).toBeLessThan(operationStatusOrder.indexOf(3))
  })
  it('offer the windows D-ssis names, and word others', () => {
    expect(operationsWindows.map(choice => choice.hours)).toEqual([1, 24, 168, 720, ssisLimits.operationsWindowHours])
    expect(windowLabel(24)).toBe('Last 24 hours')
    expect(windowLabel(36)).toBe('Last 36 hours')
  })
  it('stop only running or pending executions and validations', () => {
    expect(operationStoppable(200, 2)).toBe(true)
    expect(operationStoppable(301, 5)).toBe(true)
    expect(operationStoppable(200, 1)).toBe(false)
    expect(operationStoppable(200, 8)).toBe(false)
    expect(operationStoppable(101, 2)).toBe(false)
    expect(operationStoppable(undefined, 2)).toBe(false)
  })
})

describe('Integration Services Operations documents', () => {
  it('open one document per connection, subscribed with the preset\'s filters and the settings\' window, limit and interval', () => {
    const { operations: service, documents, handle, live } = operations({ 'integrationServices.operationsWindowHours': 48, 'integrationServices.operationsLimit': 500, 'integrationServices.operationsRefreshSeconds': 5 })
    const id = service.open('c1', 'active')
    expect(documents.active).toMatchObject({ id, kind: 'ssisOperations', name: 'Operations - c1.example', connectionId: 'c1', database: 'SSISDB', dirty: false })
    expect(live.open).toHaveBeenCalledTimes(1)
    expect(handle().spec).toEqual({ connectionId: 'c1', source: 'ssis.operations', args: { statuses: [1, 2, 5, 8], windowHours: 48, limit: 500 }, probes: [{ probe: 'ssis.operations.list', intervalMs: 5000 }] })
    expect(handle().owner.key).toBe('tab:' + id)
    expect(service.get(id)).toMatchObject({ preset: 'active', server: 'c1.example', label: 'c1.example', stopping: [] })
    // All Executions on the same connection shows the open document with its own filters, and reads the window again.
    documents.newQuery()
    expect(service.open('c1', 'executions')).toBe(id)
    expect(documents.active?.id).toBe(id)
    expect(live.open).toHaveBeenCalledTimes(1)
    expect(handle().args).toEqual([{ kinds: ['execution'], windowHours: 48, limit: 500 }])
    expect(service.get(id)?.preset).toBe('executions')
    expect(() => service.open('nope', 'operations')).toThrow('Connect to the server first.')
  })
  it('keeps the tiles\' counts from each sample, follows the interval setting, and clears filters but the window', async () => {
    const { operations: service, handle, settings } = operations()
    const id = service.open('c1', 'operations')
    handle().deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'ssis.operations.list', costMs: 1, effectiveIntervalMs: 2000, metrics: [3, 0, 2, 40, null] }] })
    expect(service.get(id)?.counts).toEqual([3, 0, 2, 40, null])
    await settings.update({ 'integrationServices.operationsRefreshSeconds': 10 })
    expect(handle().probes.at(-1)).toEqual({ probe: 'ssis.operations.list', patch: { intervalMs: 10_000 } })
    expect(handle().args).toEqual([])
    service.update(id, filters => toggleKind(withText(filters, 'caller', 'sa'), 'deploy'))
    expect(handle().args.at(-1)).toEqual({ kinds: ['deploy'], caller: 'sa', windowHours: 24, limit: 1000 })
    // The same args again send nothing.
    service.update(id, filters => ({ ...filters }))
    expect(handle().args).toHaveLength(1)
    service.clearFilters(id)
    expect(handle().args.at(-1)).toEqual({ windowHours: 24, limit: 1000 })
  })
  it('reads the selected operation from the grid and stops it after asking, saying what the catalog answered', async () => {
    const { operations: service, handle, api, context, commands } = operations()
    const id = service.open('c1', 'active')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select('42', ['42', 'Create and start execution', 'Running', 'Finance', 'Loads', 'Daily.dtsx', ''])
    await settled()
    expect(service.get(id)?.selected).toEqual({ id: 42, type: 200, status: 2, name: 'Daily.dtsx' })
    expect(context.getState().ssisOperationStoppable).toBe(true)
    expect(evaluateWhen(compileWhen(commandDescriptor('ssis.stopOperation').precondition!), context.getState())).toBe(true)
    await commands.execute('ssis.stopOperation', undefined, 'api')
    expect(service.get(id)?.confirm).toEqual({ id: 42, type: 200, status: 2, name: 'Daily.dtsx' })
    expect(operationsText.stopQuestion('Daily.dtsx')).toBe('Stop Daily.dtsx? It stops after its current work.')
    // Keep running: nothing is sent.
    service.answerStop(id, false)
    expect(api.executeSsis).not.toHaveBeenCalled()
    await service.requestStop(id)
    service.answerStop(id, true)
    expect(service.get(id)?.stopping).toEqual([42])
    expect(context.getState().ssisOperationStoppable).toBe(false)
    await settled()
    expect(api.executeSsis).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1', action: { verb: 'stopOperation', operationId: 42 } }))
    expect(service.get(id)).toMatchObject({ stopping: [], notice: { tone: 'info', text: operationsText.stopSent(42) } })
    // The row turns Stopping on the next sample; reading at once shows it sooner.
    expect(handle().refreshes).toBe(1)
    // A created, a stopping or a finished operation is not offered.
    grid.select('43', ['43', 'Create and start execution', 'Stopping', 'Finance', 'Loads', 'Daily.dtsx', ''])
    await settled()
    expect(service.stoppable(id)).toBe(false)
    grid.select('44', ['44', 'Deploy project', 'Running', '', '', '', 'Loads'])
    await settled()
    expect(service.get(id)?.selected).toEqual({ id: 44, type: 101, status: 2, name: 'Loads' })
    expect(service.stoppable(id)).toBe(false)
    grid.select(undefined)
    expect(service.get(id)?.selected).toBeUndefined()
  })
  it('treats nothing left to stop as information and a refusal as an error, and stops at once when Options says not to ask', async () => {
    const { operations: service, api } = operations({ 'integrationServices.confirmStop': false })
    const id = service.open('c1', 'active')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select('7', ['7', 'Validate project', 'Pending', '', '', '', 'Loads'])
    await settled()
    api.executeSsis.mockResolvedValueOnce({ ok: true, value: { steps: [], elapsedMs: 1, error: { code: 'ALREADY_FINAL', message: 'Operation 7 has already ended.', retryable: false } } })
    await service.requestStop(id)
    expect(service.get(id)?.confirm).toBeUndefined()
    await settled()
    expect(service.get(id)?.notice).toEqual({ tone: 'info', text: 'Operation 7 has already ended.', code: 'ALREADY_FINAL' })
    const operation = { id: 7, name: 'Loads' }
    expect(stopNotice(operation, { ok: true, value: { steps: [], elapsedMs: 1, error: { code: 'NOT_STARTED', message: 'Never started.', retryable: false } } })).toMatchObject({ tone: 'info', code: 'NOT_STARTED' })
    expect(stopNotice(operation, { ok: true, value: { steps: [], elapsedMs: 1, error: { code: 'WINDOWS_AUTH_REQUIRED', message: 'Use Windows authentication.', retryable: false } } }))
      .toEqual({ tone: 'error', text: 'Stop Operation failed: Use Windows authentication.', code: 'WINDOWS_AUTH_REQUIRED' })
    expect(stopNotice(operation, { ok: false, error: 'The backend restarted.', code: 'BACKEND_LOST' })).toEqual({ tone: 'error', text: 'Stop Operation failed: The backend restarted.', code: 'BACKEND_LOST' })
  })
  it('offers Stop Operation while the chosen row is read, and decides once its cells are there', async () => {
    const { operations: service, context, api } = operations()
    const id = service.open('c1', 'operations')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(id, grid as unknown as LiveGrid)
    // A right-click on another row opens the menu at once: the verb must not be greyed while the row is read.
    let release!: () => void
    grid.select('105', ['105', 'Create and start execution', 'Canceled', 'Finance', 'Loads', 'Hourly.dtsx', ''], new Promise(resolve => { release = resolve }))
    expect(service.get(id)?.selected).toEqual({ id: 105, name: 'operation 105', pending: true })
    expect(context.getState().ssisOperationStoppable).toBe(true)
    const asked = service.requestStop(id)
    release()
    await asked
    // Canceled: nothing to stop, said as information; nothing is asked or sent.
    expect(service.get(id)).toMatchObject({ selected: { id: 105, status: 3 }, notice: { tone: 'info', text: operationsText.notStoppable(105) } })
    expect(service.get(id)?.confirm).toBeUndefined()
    expect(api.executeSsis).not.toHaveBeenCalled()
    expect(context.getState().ssisOperationStoppable).toBe(false)
  })
  it('lets a confirmed stop finish when its document closes, and withdraws one still on its way only when the app closes', async () => {
    const { operations: service, handle, api, documents } = operations({ 'integrationServices.confirmStop': false })
    const id = service.open('c1', 'active')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select('8', ['8', 'Create and start execution', 'Running', 'F', 'P', 'Long.dtsx', ''])
    await settled()
    let answer!: (value: Awaited<ReturnType<typeof api.executeSsis>>) => void
    api.executeSsis.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    await service.requestStop(id)
    await settled()
    // Stop Operation waits for locks as SSMS does, so it may be on its way a while; closing the tab never withdraws it.
    await documents.close(id)
    expect(api.cancelSsis).not.toHaveBeenCalled()
    expect(handle().disposed).toBe(true)
    expect(service.get(id)).toBeUndefined()
    answer({ ok: true, value: { steps: [{ status: 'done' }], elapsedMs: 1 } })
    await settled()
    expect(service.get(id)).toBeUndefined()
    // The app closing withdraws a stop still on its way, rather than leave it with nothing to say how it ended.
    const next = service.open('c1', 'active')
    const other = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(next, other as unknown as LiveGrid)
    other.select('9', ['9', 'Create and start execution', 'Running', 'F', 'P', 'Long.dtsx', ''])
    await settled()
    api.executeSsis.mockReturnValueOnce(new Promise(() => {}))
    await service.requestStop(next)
    await settled()
    const requestId = api.executeSsis.mock.calls[1][0].requestId
    service.dispose()
    expect(api.cancelSsis).toHaveBeenCalledWith([requestId])
  })
  it('says when the server has no catalog, offering neither Refresh nor Pause, and opens again once there may be one', async () => {
    const { operations: service, handle, context, commands } = operations()
    const id = service.open('c1', 'operations')
    expect(commands.isEnabled('ssis.refreshOperations')).toBe(true)
    expect(commands.isEnabled('ssis.pauseOperations')).toBe(true)
    const missing = 'This server has no SSIS Catalog (it may have been deleted).'
    handle().set({ status: 'ended', ended: { ended: 'failed', code: 'CATALOG_MISSING', message: missing, ticks: 0, elapsedMs: 1 }, error: { code: 'CATALOG_MISSING', message: missing } })
    expect(service.ended(id)).toEqual({ code: 'CATALOG_MISSING', message: operationsText.noCatalog, missing: true })
    expect(service.get(id)?.notice).toBeUndefined()
    expect(context.getState()).toMatchObject({ ssisOperationsRefreshable: false, ssisOperationsPausable: false })
    expect(commands.isEnabled('ssis.refreshOperations')).toBe(false)
    expect(commands.isEnabled('ssis.pauseOperations')).toBe(false)
    // SSISDB › All Executions again (the catalog may exist now): the document subscribes again with the preset's filters.
    expect(service.open('c1', 'executions')).toBe(id)
    expect(handle().args.at(-1)).toEqual({ kinds: ['execution'], windowHours: 24, limit: 1000 })
    expect(handle().refreshes).toBe(1)
    handle().set({ status: 'live', ended: undefined, error: undefined })
    expect(service.ended(id)).toBeUndefined()
    expect(commands.isEnabled('ssis.refreshOperations')).toBe(true)
  })
  it('offers Retry for a view that failed, and subscribes again on Retry, Refresh or new filters', async () => {
    const { operations: service, handle, commands } = operations()
    const id = service.open('c1', 'active')
    handle().set({ status: 'ended', ended: { ended: 'failed', code: 'PERMISSION_DENIED', message: 'This login cannot read the SSIS Catalog.', ticks: 0, elapsedMs: 1 }, error: { code: 'PERMISSION_DENIED', message: 'This login cannot read the SSIS Catalog.' } })
    expect(service.ended(id)).toEqual({ code: 'PERMISSION_DENIED', message: 'This login cannot read the SSIS Catalog.', missing: false })
    expect(commands.isEnabled('ssis.refreshOperations')).toBe(true)
    expect(commands.isEnabled('ssis.pauseOperations')).toBe(false)
    await commands.execute('ssis.refreshOperations', undefined, 'api')
    expect(handle().refreshes).toBe(1)
    service.update(id, filters => toggleKind(filters, 'deploy'))
    expect(handle().args.at(-1)).toMatchObject({ kinds: ['deploy'] })
    expect(handle().refreshes).toBe(2)
    // A refused subscription (main's BUSY) is a failure too; a disconnect is not (a Reconnect resumes the view).
    handle().set({ status: 'ended', ended: undefined, error: { code: 'BUSY', message: 'Too many live views.' } })
    expect(service.ended(id)).toMatchObject({ code: 'BUSY', missing: false })
    handle().set({ status: 'ended', ended: { ended: 'disconnected', ticks: 1, elapsedMs: 1 }, error: undefined })
    expect(service.ended(id)).toBeUndefined()
    expect(commands.isEnabled('ssis.refreshOperations')).toBe(false)
  })
  it('pauses and resumes, and copies the selected rows', async () => {
    const { operations: service, handle, context, commands } = operations()
    const id = service.open('c1', 'operations')
    handle().set({ status: 'live' })
    await commands.execute('ssis.pauseOperations', undefined, 'api')
    expect(handle().paused).toEqual([true])
    expect(context.getState().ssisOperationsPaused).toBe(true)
    await commands.execute('ssis.pauseOperations', undefined, 'api')
    expect(handle().paused).toEqual([true, false])
    expect(context.getState().ssisOperationsPaused).toBe(false)
    await commands.execute('ssis.refreshOperations', undefined, 'api')
    expect(handle().refreshes).toBe(1)
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(id, grid as unknown as LiveGrid)
    await commands.execute('ssis.copyOperationsWithHeaders', undefined, 'api')
    expect(grid.copy).toHaveBeenCalledWith(true)
    grid.copy.mockResolvedValueOnce({ ok: false, error: 'This live view stopped; its rows are no longer available.', code: 'RESULT_RELEASED' } as never)
    await commands.execute('ssis.copyOperations', undefined, 'api')
    expect(service.get(id)?.notice).toMatchObject({ tone: 'error', text: 'Could not copy the rows: This live view stopped; its rows are no longer available.' })
  })
  it('opens from the SSISDB node with its preset, from View on the selection\'s or active document\'s server, and never on a lost one', async () => {
    const fixture = operations()
    const { operations: service, commands, documents, handle } = fixture
    for (const preset of ['active', 'executions', 'validations', 'operations'] as const) {
      const command = operationsPresetSpecs[preset].command
      expect(commands.isEnabled(command, { target: { kind: 'explorer', node: ssisdb('c1', true) } })).toBe(false)
      await commands.execute(command, { target: { kind: 'explorer', node: ssisdb('c1') } }, 'api')
      expect(service.get(documents.getSnapshot().activeId)?.preset).toBe(preset)
    }
    expect(handle().args.map(args => { const value = args as SsisOperationsArgs; return value.kinds ?? value.statuses ?? 'all' })).toEqual([['execution'], ['validation'], 'all'])
    // From View with one connected server, and none once it is lost.
    await commands.execute('ssis.allOperations', undefined, 'api')
    expect(documents.getSnapshot().documents.filter(document => document.kind === 'ssisOperations')).toHaveLength(1)
    fixture.api.push(readyBackend(2))
    expect(commands.isEnabled('ssis.allOperations')).toBe(false)
    expect(service.stoppable(documents.getSnapshot().activeId)).toBe(false)
  })
  it('follows a Reconnect to its own server, so Stop Operation acts on the new connection', async () => {
    const fixture = operations()
    const { operations: service, connections, targets, api } = fixture
    const id = service.open('c1', 'active')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select('42', ['42', 'Create and start execution', 'Running', 'Finance', 'Loads', 'Daily.dtsx', ''])
    await settled()
    expect(service.stoppable(id)).toBe(true)
    // The connection is lost: Stop Operation waits for a Reconnect.
    connections.markLostBefore(2)
    expect(service.stoppable(id)).toBe(false)
    // Reconnected to the same server (any case): the document moves to the new connection, and Stop Operation goes there.
    connections.replace('c1', { ...connectionInfo('c2', 2), server: 'C1.EXAMPLE' }, connectionOptions)
    targets.retarget('c1', 'c2')
    expect(service.get(id)?.connectionId).toBe('c2')
    expect(service.stoppable(id)).toBe(true)
    await service.requestStop(id)
    service.answerStop(id, true)
    await settled()
    expect(api.executeSsis).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c2', action: { verb: 'stopOperation', operationId: 42 } }))
  })
  it('applies a new Show at most to open documents at once', async () => {
    const { operations: service, handle, settings } = operations()
    const id = service.open('c1', 'executions')
    await settings.update({ 'integrationServices.operationsLimit': 5000 })
    expect(service.get(id)?.filters.limit).toBe(5000)
    expect(handle().args.at(-1)).toEqual({ kinds: ['execution'], windowHours: 24, limit: 5000 })
  })
})

describe('Integration Services Operations document view', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
  function view() {
    const fixture = operations()
    const workbench = { ...fixture, platform: 'win32' } as unknown as Workbench
    const id = fixture.operations.open('c1', 'operations')
    const html = () => renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(SsisOperations, { documentId: id }) }))
    return { ...fixture, id, html }
  }
  // The grid itself needs a browser, so these draw the document where it shows no rows: a server that cannot run it, or a view that stopped.
  it('names the server and SSISDB before a short title, labels its chip rows, and says so where its rows would be when the server cannot run it', () => {
    const { html, handle } = view()
    handle().set({ status: 'live', probes: { 'ssis.operations.list': { state: 'unavailable', intervalMs: 2000, effectiveIntervalMs: 2000, reason: 'NOT_SUPPORTED', note: 'The SSIS Catalog is not supported on SQL Server on Linux.' } } })
    const markup = html()
    expect(markup).toContain('Operations are not available')
    expect(markup).toContain('The SSIS Catalog is not supported on SQL Server on Linux.')
    expect(markup).toMatch(/<h1 class="document-title"[^>]*>Operations<\/h1>/)
    expect(markup).toContain('title="c1.example"')
    expect(markup).not.toContain('Integration Services Catalogs')
    expect(markup).toContain('aria-label="Operation counts"')
    expect(markup).toMatch(/<span class="ssis-filter-label" aria-hidden="true">Kind<\/span><div class="chip-group" role="group" aria-label="Kind">/)
    expect(markup).toMatch(/<span class="ssis-filter-label" aria-hidden="true">Status<\/span>/)
    // While the view is not out of date, no age badge takes the header's room.
    expect(markup).not.toContain('stale-badge')
  })
  it('replaces its tiles, filters and rows with why it stopped: no catalog, or a failure with Retry', () => {
    const { html, handle } = view()
    const missing = 'This server has no SSIS Catalog (it may have been deleted).'
    handle().set({ status: 'ended', ended: { ended: 'failed', code: 'CATALOG_MISSING', message: missing, ticks: 0, elapsedMs: 1 }, error: { code: 'CATALOG_MISSING', message: missing } })
    let markup = html()
    expect(markup).toContain('No SSIS Catalog')
    expect(markup).toContain(operationsText.noCatalog)
    expect(markup).not.toContain('aria-label="Operation counts"')
    expect(markup).not.toContain('aria-label="Filters"')
    expect(markup).not.toContain('>Retry<')
    expect(markup).not.toContain('Waiting for data')
    handle().set({ ended: { ended: 'failed', code: 'PERMISSION_DENIED', message: 'This login cannot read the SSIS Catalog.', ticks: 0, elapsedMs: 1 }, error: { code: 'PERMISSION_DENIED', message: 'This login cannot read the SSIS Catalog.' } })
    markup = html()
    expect(markup).toContain('This login cannot read the SSIS Catalog.')
    expect(markup).toContain('>Retry<')
    expect(markup).not.toContain('aria-label="Operation counts"')
  })
})

describe('live pill status', () => {
  const snapshot = (patch: Partial<LiveSnapshot>): LiveSnapshot => ({ status: 'live', connectionId: 'c', probes: { 'ssis.operations.list': { state: 'fresh', intervalMs: 2000, effectiveIntervalMs: 2000, series: [] } as never }, ...patch })
  it('maps a view\'s snapshot to the kit\'s states', () => {
    const probe = 'ssis.operations.list', fallback = liveProbes[probe].intervalMs.default
    expect(pillStatus(snapshot({}), probe, fallback)).toEqual({ state: 'live', intervalMs: 2000 })
    expect(pillStatus(snapshot({ probes: { [probe]: { state: 'fresh', intervalMs: 2000, effectiveIntervalMs: 4000 } as never } }), probe, fallback)).toEqual({ state: 'slowed', intervalMs: 2000, effectiveMs: 4000 })
    expect(pillStatus(snapshot({ status: 'paused', pausedBy: 'hidden' }), probe, fallback)).toEqual({ state: 'paused', intervalMs: 2000, pausedBy: 'hidden' })
    expect(pillStatus(snapshot({ status: 'ended', ended: { ended: 'failed', ticks: 0, elapsedMs: 1 } }), probe, fallback)).toEqual({ state: 'ended', intervalMs: 2000, ended: 'failed' })
    expect(pillStatus({ status: 'connecting', connectionId: 'c', probes: {} }, probe, fallback)).toEqual({ state: 'connecting', intervalMs: 2000 })
    expect(pillStatus(snapshot({ status: 'dormant' }), probe, fallback).state).toBe('dormant')
  })
})
