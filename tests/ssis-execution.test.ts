import { afterEach, describe, expect, it } from 'vitest'
import type { ApiResult } from '../src/shared/contracts'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { gestureDescriptor } from '../src/shared/commands/gestures'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { messageTypeOrder, ssisLimits } from '../src/shared/ssis/catalog'
import {
  durationText, executionSeconds, executionText, firstError, isExecutionId, isProblems, messageColumns, messageEventName, messageTime, problemCount, problemTypes, secondsBetween, toggleType,
  totalMessages, typeChipLabel, typeCounts, usualSeconds
} from '../src/shared/ssis/execution'
import { canGoBack, canGoForward, currentPlace, keptKeys, navigationLimits, placeName, pushPlace, startTrail, stepTrail, updatePlace } from '../src/shared/ssis/navigation'
import { ssisExecutionSchema, ssisPackageRunsSchema, type SsisExecutionModel, type SsisExecutionResult, type SsisPackageRunsResult } from '../src/shared/ssis/schema'
import { cellPasses, keptRows, localFacet, withFilter } from '../src/renderer/src/grid/local-filter'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { messageCell, messagesTable, overviewRows, parametersTable, runStrip, runsTable, timeline } from '../src/renderer/src/ssis/run-page'
import { deferred } from './fixtures/documents'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const uuid = '00000000-0000-4000-8000-000000000001'
const at = (seconds: number) => new Date(Date.parse('2026-11-15T01:31:00Z') + seconds * 1000).toISOString().replace('Z', '+00:00')
const model = (id = 48213, patch: Partial<SsisExecutionModel> = {}): SsisExecutionModel => ({
  overview: {
    id, folder: 'Finance', project: 'Loads', package: 'Daily.dtsx', executedAs: 'CONTOSO\\agent', caller: 'CONTOSO\\agent', use32bit: false, status: 4,
    created: '2026-11-15T02:30:58.0000000+01:00', started: '2026-11-15T02:31:00.0000000+01:00', ended: '2026-11-15T02:32:05.5000000+01:00', now: '2026-11-15T08:00:00.0000000+01:00'
  },
  counts: [{ type: 30, count: 1 }, { type: 70, count: 4 }, { type: 110, count: 2 }, { type: 120, count: 1 }, { type: 130, count: 1 }, { type: 555, count: 3 }],
  messages: [
    { id: 9, time: '2026-11-15T02:32:05.1230000+01:00', type: 120, sourceType: 40, source: 'Load facts', package: 'Daily.dtsx', event: 'OnError', path: '\\Daily\\Load facts', code: -1071636471, message: 'Line one\r\nLine two\tcol\u0007' },
    { id: 5, time: '2026-11-15T02:31:30.0000000+01:00', type: 120, source: 'Load facts', message: 'The first error.' },
    { id: 1, time: '2026-11-15T02:31:00.0000000+01:00', type: 30, message: 'Operation started.' }
  ],
  truncated: false,
  tasks: [
    { path: '\\Daily', name: 'Daily', started: at(0), ended: at(65), durationMs: 65_000, runs: 1, failed: true },
    { path: '\\Daily\\Load facts', name: 'Load facts', started: at(5), ended: at(45), durationMs: 40_000, runs: 2, failed: true, usualMs: 30_000 },
    { path: '\\Daily\\Rebuild', name: 'Rebuild', started: at(45), ended: at(55), durationMs: 10_000, runs: 1, failed: false, usualMs: 12_000 },
    { path: '\\Daily\\Notify', name: 'Notify', runs: 0, failed: false }
  ],
  tasksTruncated: false,
  parameters: [
    { objectType: 30, name: 'BatchSize', dataType: 'Int32', value: '5000', sensitive: false, required: false, valueSet: true, runtimeOverride: true },
    { objectType: 20, name: 'Password', dataType: 'String', sensitive: true, required: true, valueSet: true, runtimeOverride: false }
  ],
  runs: [
    { id, status: 4, started: at(0), ended: at(65) },
    { id: id - 1, status: 7, started: at(-3600), ended: at(-3600 + 60) },
    { id: id - 2, status: 7, started: at(-7200), ended: at(-7200 + 120) },
    { id: id - 3, status: 7, started: at(-9000), ended: at(-9000 + 30) }
  ],
  ...patch
})
const answer = (value: SsisExecutionResult): ApiResult<SsisExecutionResult> => ({ ok: true, value })
const packageAnswer = (value: SsisPackageRunsResult): ApiResult<SsisPackageRunsResult> => ({ ok: true, value })

/** A LiveGrid stand-in for the list: its active row is one operation, as the grid stores its cells. */
class FakeGrid extends SnapshotStore<LiveGridSnapshot> {
  select(key: string, cells: string[], read?: Promise<void>) {
    const handle = { getWindow: async () => { await read; return { first: 0, count: 1, colStart: 0, colEnd: 7, text: cells, flags: new Uint8Array(7) } } }
    this.publish({ newRows: 0, following: true, lost: false, activeKey: key, selection: { entry: 'live', active: { row: 3, col: 1 }, anchor: { row: 3, col: 1 }, blocks: [] }, table: { handle } } as unknown as LiveGridSnapshot)
  }
}

function document() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.api.executionSsis.mockImplementation(async params => answer({ model: model(params.executionId, { ...params.types ? { types: params.types } : {}, ...params.source ? { source: params.source } : {} }), elapsedMs: 1 }))
  fixture.api.packageRunsSsis.mockImplementation(async params => packageAnswer({
    model: { folder: params.folder, project: params.project, package: params.package, runs: [{ id: 900, status: 4, started: at(0), ended: at(65), errors: 3, warnings: 1, caller: 'agent' }, { id: 899, status: 7, started: at(-60), ended: at(-30), errors: 0, warnings: 0 }], truncated: false, now: at(100) },
    elapsedMs: 1
  }))
  fixture.connect(connectionInfo('c1'))
  const requests = () => fixture.api.executionSsis.mock.calls.map(([request]) => request)
  const place = (id: string) => fixture.operations.place(id)!
  return { ...fixture, requests, place }
}

describe('SSIS run page helpers', () => {
  it('count messages by SSIS event in the order a run logs them, folding unknown types into Unknown', () => {
    expect(typeCounts(model()).map(item => `${messageEventName(item.type)} ${item.count}`)).toEqual(['PreExecute 1', 'Information 4', 'Warning 2', 'Error 1', 'TaskFailed 1', 'Unknown 3'])
    expect(totalMessages(model())).toBe(12)
    expect(problemCount(model())).toBe(4)
    expect(messageEventName(555)).toBe('Unknown')
    expect(typeChipLabel(120, 1234)).toBe('Error 1,234')
    expect(new Set(messageTypeOrder).size).toBe(messageTypeOrder.length)
  })
  it('choose event chips as agreed: the first click shows only that event, later ones add or remove, none is All', () => {
    expect(toggleType(undefined, 120)).toEqual([120])
    expect(toggleType([120], 10)).toEqual([10, 120])
    expect(toggleType([10, 120], 120)).toEqual([10])
    expect(toggleType([10], 10)).toBeUndefined()
    expect(isProblems(problemTypes)).toBe(true)
    expect(isProblems([110, 120])).toBe(false)
    expect(isProblems(undefined)).toBe(false)
  })
  it('pin the earliest error, and take the usual duration from the earlier succeeded runs', () => {
    expect(firstError(model().messages)?.message).toBe('The first error.')
    expect(firstError([])).toBeUndefined()
    // 60, 120 and 30 seconds succeeded: the median is 60; this run (failed) is left out.
    expect(usualSeconds(model().runs, 48213)).toBe(60)
    expect(usualSeconds([], 1)).toBeUndefined()
  })
  it('write durations and times as SSMS\'s reports do, in the catalog\'s own offset', () => {
    expect(secondsBetween('2026-11-15T02:31:00+01:00', '2026-11-15T02:32:05.5+01:00')).toBe(65)
    expect(secondsBetween(undefined, '2026-11-15T02:32:05+01:00')).toBeUndefined()
    expect(durationText(65)).toBe('00:01:05')
    expect(durationText(2 * 86_400 + 3 * 3600)).toBe('2.03:00:00')
    expect(executionSeconds(model().overview)).toBe(65)
    expect(executionSeconds({ ...model().overview, status: 2, ended: undefined })).toBe(5 * 3600 + 29 * 60)
    expect(messageTime('2026-11-15T02:32:05.1230000+01:00')).toBe('2026-11-15 02:32:05.123 +01:00')
  })
  it('lists messages in the mock\'s columns, keeping line breaks and naming other control characters', () => {
    const table = messagesTable(model().messages)
    expect(table.columns.map(column => column.name)).toEqual(['Time', 'Event', 'Source', 'Message', 'Execution path', 'Source type', 'Package'])
    expect(table.columns.map(column => column.name)).toEqual(messageColumns.map(column => column.title))
    expect(table.rows[0]).toEqual(['2026-11-15 02:32:05.123 +01:00', 'Error', 'Load facts', 'Line one\r\nLine two\tcol⟨U+0007⟩', '\\Daily\\Load facts', 'Control flow task', 'Daily.dtsx'])
    expect(messageCell('a‮b')).not.toContain('‮')
  })
  it('lays out the run\'s details, its parameters (never a sensitive value) and a package\'s runs', () => {
    const rows = Object.fromEntries(overviewRows({ ...model().overview, environment: 'Prod', environmentFolder: 'Shared' }, 60))
    expect(rows).toMatchObject({ Execution: '48213', Status: 'Failed', Environment: 'Shared\\Prod', Duration: '00:01:05 (usual 00:01:00)', 'Stopped by': '' })
    const parameters = parametersTable(model().parameters)
    expect(parameters.rows).toEqual([['BatchSize', '5000', 'Int32', 'Package', 'Set for this run', 'No'], ['Password', 'Sensitive (not shown)', 'String', 'Project', 'Configured', 'Yes']])
    const runs = runsTable([{ id: 7, status: 7, started: '2026-11-15T02:31:00+01:00', ended: '2026-11-15T02:32:05+01:00', errors: 0, warnings: 2, caller: 'agent' }, { id: 6, status: 1, created: '2026-11-15T01:00:00+01:00' }])
    expect(runs.columns.map(column => column.name)).toEqual(['ID', 'Status', 'Started', 'Duration', 'Errors', 'Warnings', 'Caller'])
    expect(runs.rows).toEqual([['7', 'Succeeded', '2026-11-15 02:31:00 +01:00', '00:01:05', '0', '2', 'agent'], ['6', 'Created', '2026-11-15 01:00:00 +01:00', '', null, null, null]])
  })
  it('draws the run strip oldest first against the longest run, marking this run and the failed ones', () => {
    const strip = runStrip(model().runs, 48213)
    expect(strip.bars.map(bar => bar.id)).toEqual([48210, 48211, 48212, 48213])
    expect(strip.bars.map(bar => bar.height)).toEqual([0.25, 1, 0.5, 65 / 120])
    expect(strip.bars.filter(bar => bar.current).map(bar => bar.id)).toEqual([48213])
    expect(strip.bars.filter(bar => bar.failed).map(bar => bar.id)).toEqual([48213])
    expect(strip).toMatchObject({ usual: 60, usualAt: 0.5 })
    expect(strip.bars[3].label).toContain('Execution 48213: Failed, 00:01:05')
  })
  it('places each task on the run\'s time, with its usual end and how it compared, and a task never reached unplaced', () => {
    const rows = timeline(model())
    expect(rows.map(row => [row.name, row.depth])).toEqual([['Daily', 0], ['Load facts', 1], ['Rebuild', 1], ['Notify', 1]])
    // The run ended at 65.5 s, its last moment.
    expect(rows[1]).toMatchObject({ left: 5 / 65.5, width: 40 / 65.5, usualEnd: 35 / 65.5, duration: '00:00:40', delta: 'failed', runs: 2 })
    expect(rows[2]).toMatchObject({ delta: '−2 s', slower: false })
    expect(rows[3]).toMatchObject({ duration: '', delta: '' })
    expect(rows[3].left).toBeUndefined()
  })
  it('send main only known distinct types, a bounded task, and a package\'s names', () => {
    const ok = { connectionId: uuid, requestId: uuid, executionId: 48213 }
    expect(ssisExecutionSchema.safeParse(ok).success).toBe(true)
    expect(ssisExecutionSchema.safeParse({ ...ok, types: [120, -1], source: 'Load facts' }).success).toBe(true)
    for (const bad of [{ ...ok, executionId: 0 }, { ...ok, types: [] }, { ...ok, types: [120, 120] }, { ...ok, types: [555] }, { ...ok, source: '' }, { ...ok, source: 'x'.repeat(ssisLimits.executionMessageChars + 1) }, { ...ok, extra: 1 }])
      expect(ssisExecutionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    const runs = { connectionId: uuid, requestId: uuid, folder: 'Finance', project: 'Loads', package: 'Daily.dtsx' }
    expect(ssisPackageRunsSchema.safeParse(runs).success).toBe(true)
    for (const bad of [{ ...runs, folder: '' }, { ...runs, package: 'x'.repeat(ssisLimits.packageName + 1) }, { ...runs, extra: 1 }]) expect(ssisPackageRunsSchema.safeParse(bad).success).toBe(false)
    expect(isExecutionId(48213)).toBe(true)
    expect(isExecutionId(1.5)).toBe(false)
  })
})

describe('SSIS document history', () => {
  it('adds a step after the shown one, drops the steps ahead as a browser does, and stays put on the same place', () => {
    let trail = startTrail('l')
    expect(canGoBack(trail)).toBe(false)
    trail = pushPlace(trail, { kind: 'execution', executionId: 1 }, 'a').trail
    trail = pushPlace(trail, { kind: 'package', folder: 'F', project: 'P', package: 'D.dtsx' }, 'b').trail
    expect(pushPlace(trail, { kind: 'package', folder: 'F', project: 'P', package: 'D.dtsx' }, 'x').trail).toBe(trail)
    trail = stepTrail(trail, -1)!
    expect(currentPlace(trail)).toMatchObject({ kind: 'execution', executionId: 1 })
    expect(canGoForward(trail)).toBe(true)
    expect(stepTrail(startTrail('l'), -1)).toBeUndefined()
    const pushed = pushPlace(trail, { kind: 'execution', executionId: 2 }, 'c')
    expect(pushed.dropped).toEqual(['b'])
    expect(pushed.trail.places.map(place => place.key)).toEqual(['l', 'a', 'c'])
    expect(canGoForward(pushed.trail)).toBe(false)
    const changed = updatePlace(pushed.trail, place => ({ ...place, types: [120] } as never))
    expect(currentPlace(changed)).toMatchObject({ key: 'c', types: [120] })
    expect(changed.places.length).toBe(3)
    expect([placeName({ kind: 'list' }), placeName({ kind: 'execution', executionId: 9 }), placeName({ kind: 'package', folder: 'F', project: 'P', package: 'D.dtsx' })]).toEqual(['SSISDB', 'Execution 9', 'D.dtsx'])
  })
  it('forgets the oldest places past its limit and keeps reads only near the shown one', () => {
    let trail = startTrail('k0'), dropped: string[] = []
    for (let index = 1; index <= navigationLimits.places + 5; index++) {
      const result = pushPlace(trail, { kind: 'execution', executionId: index }, `k${index}`)
      trail = result.trail
      dropped = [...dropped, ...result.dropped]
    }
    expect(trail.places).toHaveLength(navigationLimits.places)
    expect(dropped).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5'])
    expect([...keptKeys(trail)]).toEqual(['k52', 'k53', 'k54', 'k55'])
  })
})

describe('Local grid filters', () => {
  const table = { columns: [{ name: 'Event' }, { name: 'Source' }], rows: [['Error', 'Load'], ['Warning', 'Load'], ['Error', null], ['Information', '']] }
  it('keep a value, leave one out, or keep blanks, as the backend\'s value filters do', () => {
    expect(cellPasses('Error', { values: ['Error'] })).toBe(true)
    expect(cellPasses('Error', { values: ['Error'], exclude: true })).toBe(false)
    expect(cellPasses(null, { values: ['Error'] })).toBe(false)
    expect(cellPasses('', { blanks: true })).toBe(true)
    expect(cellPasses('x', { nonBlanks: true })).toBe(true)
    expect(keptRows(table, new Map())).toBeUndefined()
    const errors = withFilter(new Map(), 0, { values: ['Error'] })
    expect(keptRows(table, errors)).toEqual([0, 2])
    expect(keptRows(table, withFilter(errors, 1, { values: ['Load'] }))).toEqual([0])
    expect(withFilter(errors, 0, undefined).size).toBe(0)
  })
  it('list a column\'s values over the rows the other columns keep, blanks as one entry', () => {
    const errors = withFilter(new Map(), 0, { values: ['Error'] })
    expect(localFacet(table, 1, errors).values).toEqual([{ text: 'Load', count: 1 }, { text: '', count: 1 }])
    // A column's own filter never empties its own list.
    expect(localFacet(table, 0, errors).values.map(value => value.text)).toEqual(['Error', 'Warning', 'Information'])
  })
})

describe('The Integration Services document', () => {
  it('drills from an execution\'s row to its run page in place, and Back and Forward walk it without reading again', async () => {
    const { operations, commands, documents, requests, place, ssisPlaces, context } = document()
    const tab = operations.open('c1', 'executions')
    const grid = new FakeGrid({ newRows: 0, following: true, lost: false })
    operations.attachGrid(tab, grid as unknown as LiveGrid)
    grid.select('103', ['103', 'Create and start execution', 'Failed', 'Finance', 'Loads', 'Daily.dtsx', ''])
    await settled()
    expect(context.getState()).toMatchObject({ activeDocumentIsSsisOperations: true, ssisPlace: 'list', ssisCanGoBack: false })
    expect(commands.isEnabled('ssis.openExecution', { tabId: tab })).toBe(true)
    await commands.execute('ssis.openExecution', { tabId: tab }, 'toolbar')
    await settled()
    expect(documents.active?.id).toBe(tab)
    expect(place(tab)).toMatchObject({ kind: 'execution', executionId: 103 })
    expect(requests()).toEqual([{ connectionId: 'c1', requestId: expect.any(String), executionId: 103 }])
    expect(ssisPlaces.run(place(tab).key)?.model?.overview.id).toBe(103)
    expect(context.getState()).toMatchObject({ ssisPlace: 'execution', ssisCanGoBack: true, ssisCanGoForward: false })
    // Open on a row is only for the list: on a run page there is no row.
    expect(operations.executionSelected(tab)).toBe(false)
    await commands.execute('ssis.goBack', { tabId: tab }, 'toolbar')
    expect(place(tab).kind).toBe('list')
    expect(context.getState()).toMatchObject({ ssisPlace: 'list', ssisCanGoForward: true })
    await commands.execute('ssis.goForward', { tabId: tab }, 'toolbar')
    await settled()
    expect(place(tab)).toMatchObject({ kind: 'execution', executionId: 103 })
    expect(requests()).toHaveLength(1)
    // Another operation has no run page: it says why.
    await commands.execute('ssis.goBack', { tabId: tab }, 'toolbar')
    grid.select('44', ['44', 'Deploy project', 'Succeeded', '', '', '', 'Loads'], new Promise(resolve => setTimeout(resolve, 0)))
    expect(await operations.selectedExecution(tab)).toBeUndefined()
    expect(operations.get(tab)?.notice).toEqual({ tone: 'info', text: executionText.notExecution(44) })
  })
  it('remembers each run page\'s event chips and task, reading again under them, and Refresh reads the shown place', async () => {
    const { operations, api, requests, place, ssisPlaces, commands } = document()
    const tab = operations.openExecution('c1', 7)
    await settled()
    const pending = deferred<ApiResult<SsisExecutionResult>>()
    api.executionSsis.mockReturnValueOnce(pending.promise)
    operations.setRunFilters(tab, { types: [120] })
    expect(place(tab)).toMatchObject({ kind: 'execution', executionId: 7, types: [120] })
    expect(requests().at(-1)).toMatchObject({ executionId: 7, types: [120] })
    // The shown model stays while the new read is on its way, and a newer change cancels it.
    expect(ssisPlaces.run(place(tab).key)).toMatchObject({ loading: true, model: { overview: { id: 7 } } })
    operations.setRunFilters(tab, { source: 'Load facts' })
    expect(api.cancelSsis).toHaveBeenCalledWith([requests().at(-2)!.requestId])
    expect(requests().at(-1)).toMatchObject({ types: [120], source: 'Load facts' })
    pending.resolve(answer({ model: model(7, { types: [120] }), elapsedMs: 1 }))
    await settled()
    expect(ssisPlaces.run(place(tab).key)?.model).toMatchObject({ types: [120], source: 'Load facts' })
    operations.setRunFilters(tab, { types: null, source: null })
    expect(place(tab).kind === 'execution' && place(tab)).toEqual({ kind: 'execution', key: place(tab).key, executionId: 7 })
    await settled()
    const before = requests().length
    expect(evaluateWhen(compileWhen(commandDescriptor('ssis.refreshOperations').keybindings![0].when!), { activeDocumentIsSsisOperations: true } as never)).toBe(true)
    await commands.execute('ssis.refreshOperations', { tabId: tab }, 'toolbar')
    expect(requests()).toHaveLength(before + 1)
  })
  it('switches a run page to Details and back without reading again, keeping the view through filters and history', async () => {
    const { operations, requests, place } = document()
    const tab = operations.openExecution('c1', 7)
    await settled()
    const before = requests().length
    operations.setRunView(tab, 'details')
    expect(place(tab)).toMatchObject({ kind: 'execution', executionId: 7, view: 'details' })
    expect(requests()).toHaveLength(before)
    // A filter keeps the view; Messages drops it.
    operations.setRunFilters(tab, { types: [120] })
    expect(place(tab)).toMatchObject({ view: 'details', types: [120] })
    operations.setRunView(tab, undefined)
    expect(place(tab)).not.toHaveProperty('view')
    // Each step keeps its own view.
    operations.setRunView(tab, 'details')
    operations.go(tab, { kind: 'execution', executionId: 8 })
    await settled()
    expect(place(tab)).not.toHaveProperty('view')
    operations.step(tab, -1)
    expect(place(tab)).toMatchObject({ executionId: 7, view: 'details' })
  })
  it('opens a package\'s runs and its last run from Object Explorer\'s package node', async () => {
    const { operations, api, place, ssisPlaces, requests } = document()
    const tab = operations.openPackage('c1', 'Finance', 'Loads', 'Daily.dtsx')
    await settled()
    expect(api.packageRunsSsis).toHaveBeenCalledWith({ connectionId: 'c1', requestId: expect.any(String), folder: 'Finance', project: 'Loads', package: 'Daily.dtsx' })
    expect(place(tab)).toMatchObject({ kind: 'package', package: 'Daily.dtsx' })
    expect(ssisPlaces.package(place(tab).key)?.model?.runs).toHaveLength(2)
    expect(operations.canGoBack(tab)).toBe(true)
    expect(operations.openLastRun('c1', 'Finance', 'Loads', 'Daily.dtsx')).toBe(tab)
    await settled()
    expect(place(tab)).toMatchObject({ kind: 'execution', executionId: 900 })
    expect(requests().at(-1)?.executionId).toBe(900)
    // The package step was kept: Back shows it without asking the catalog again.
    operations.step(tab, -1)
    expect(place(tab).kind).toBe('package')
    expect(api.packageRunsSsis).toHaveBeenCalledTimes(1)
    api.packageRunsSsis.mockResolvedValueOnce(packageAnswer({ model: { folder: 'Finance', project: 'Loads', package: 'Empty.dtsx', runs: [], truncated: false, now: at(0) }, elapsedMs: 1 }))
    operations.openLastRun('c1', 'Finance', 'Loads', 'Empty.dtsx')
    await settled()
    expect(place(tab)).toMatchObject({ kind: 'package', package: 'Empty.dtsx' })
    expect(operations.get(tab)?.notice?.text).toContain('no runs of Empty.dtsx')
    for (const command of ['ssis.packageExecutions', 'ssis.lastRun'] as const)
      expect(commandDescriptor(command).menus?.find(menu => menu.menu === 'explorer.context')?.when).toBe("explorerNode == 'ssisPackage' && !explorerServerLost")
  })
  it('says a purged execution as a value and drops what it showed, and keeps a page on a lost connection', async () => {
    const { operations, api, place, ssisPlaces, connections, requests } = document()
    api.executionSsis.mockResolvedValueOnce(answer({ elapsedMs: 1, error: { code: 'NOT_FOUND', message: 'Execution 5 is not in the SSIS Catalog.', retryable: false } }))
    const tab = operations.openExecution('c1', 5)
    await settled()
    expect(ssisPlaces.run(place(tab).key)).toMatchObject({ gone: true, loading: false, error: { code: 'NOT_FOUND' } })
    operations.openExecution('c1', 6)
    await settled()
    api.executionSsis.mockReturnValueOnce(new Promise(() => {}))
    operations.refreshPlace(tab)
    connections.markLostBefore(2)
    await settled()
    expect(api.cancelSsis).toHaveBeenLastCalledWith([requests().at(-1)!.requestId])
    expect(ssisPlaces.run(place(tab).key)).toMatchObject({ loading: false, model: { overview: { id: 6 } } })
    expect(operations.placeRefreshable(tab)).toBe(false)
  })
  it('lets go of what it read when its tab closes', async () => {
    const { operations, api, documents, requests, place, ssisPlaces } = document()
    api.executionSsis.mockReturnValueOnce(new Promise(() => {}))
    const tab = operations.openExecution('c1', 1)
    const key = place(tab).key
    await documents.close(tab)
    expect(api.cancelSsis).toHaveBeenCalledWith([requests()[0].requestId])
    expect(ssisPlaces.get(key)).toBeUndefined()
  })
  it('binds Back and Forward to Alt+Left and Alt+Right (Cmd+[ and Cmd+] on macOS) outside text, and to the mouse\'s buttons', () => {
    const back = commandDescriptor('ssis.goBack').keybindings![0]
    expect(back).toMatchObject({ win: 'alt+left', linux: 'alt+left', mac: 'mod+[' })
    expect(evaluateWhen(compileWhen(back.when!), { activeDocumentIsSsisOperations: true, textInputFocus: false } as never)).toBe(true)
    expect(evaluateWhen(compileWhen(back.when!), { activeDocumentIsSsisOperations: true, textInputFocus: true } as never)).toBe(false)
    expect(commandDescriptor('ssis.goForward').keybindings![0]).toMatchObject({ win: 'alt+right', mac: 'mod+]' })
    expect(gestureDescriptor('ssis.mouseBack')).toMatchObject({ action: 'backButton', keyboard: ['ssis.goBack'] })
    expect(gestureDescriptor('ssis.mouseForward')).toMatchObject({ action: 'forwardButton', keyboard: ['ssis.goForward'] })
  })
})
