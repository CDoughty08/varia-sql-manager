// Closing one result (grouped results PR 3): every way a result leaves a run goes through one cleanup, which releases it
// once, gives up the work that depends on it, and drops answers that come late. These checks close a source under pending
// work, let answers arrive late, hold save, copy and retained-plan leases across a close, run again after a close, lose
// the backend, and close the last result.
import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ResultColumn, ResultsJobProgress, ResultsJobResult, SavedResults, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import type { DistinctList, ResultView } from '../src/renderer/src/results/ResultClient'
import { CompareService } from '../src/renderer/src/results/CompareService'
import { HighlightsService } from '../src/renderer/src/results/HighlightsService'
import { emptyResultsText, hasResultsView, outputViewOf } from '../src/renderer/src/results/OutputPane'
import { PivotService } from '../src/renderer/src/results/PivotService'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import { TransposeService } from '../src/renderer/src/results/TransposeService'
import type { RetainedPlansService } from '../src/renderer/src/plans/RetainedPlansService'
import type { DocumentService } from '../src/renderer/src/services/documents'
import { selectAll } from '../src/renderer/src/grid/selection'
import { deferred } from './fixtures/documents'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const plan = { name: 'Plan', dataType: 'xml', wire: 'text', nullable: true, role: 'plan' } as ResultColumn

function fixture(o: { retainedPlans?: RetainedPlansService } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  let ids = 0
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(async () => ({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0 } })),
    saveResults: vi.fn<VariaApi['saveResults']>(async () => ({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0, fileName: 'out.csv', format: 'csv' as const } })),
    cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(async () => ({ ok: true, value: { cancelled: true } })),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const documents = { openText: vi.fn<DocumentService['openText']>(value => ({ id: 'doc', name: value.name, kind: value.kind, database: '', dirty: false, savedVersionId: 1 })) }
  // Publishes at once, so the services that follow the results hear a close when it happens.
  const results = new ResultsService({ client, api, events, documents, frame: callback => callback(), timers: timers.timers, newId: () => `job-${++ids}`, ...o })
  const pivot = new PivotService(results), transpose = new TransposeService(results), compare = new CompareService(results), highlights = new HighlightsService(results, { timers: timers.timers })
  /** Runs a query of `count` complete sets, results `first` onwards. */
  const run = (count: number, queryId = 'q1', first = 1, patch: Parameters<typeof descriptor>[1] = {}) => {
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(first + index, { index, ...patch }))
    void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.key)
  }
  const tab = () => results.getSnapshot().t1
  const handle = (id: number) => client.handle(id) as FakeHandle
  /** How often each result was released. */
  const releases = () => { const counts = new Map<number, number>(); for (const id of client.released()) counts.set(id, (counts.get(id) ?? 0) + 1); return Object.fromEntries(counts) }
  return { client, api, events, timers, documents, progress, results, pivot, transpose, compare, highlights, run, tab, handle, releases }
}

/** A handle method that answers when the test says, and records the signal it was given. */
function held<T>() {
  const answer = deferred<T>()
  const state: { signal?: AbortSignal } = {}
  const take = (signal: AbortSignal | undefined) => {
    state.signal = signal
    // As ResultClient: an aborted request rejects, whatever the backend answers later.
    return new Promise<T>((resolve, reject) => { answer.promise.then(resolve, reject); signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))) })
  }
  return { answer, state, take }
}

describe('closing one result', () => {
  it('releases only that result, once, and leaves the run its status, summary, row total and numbering', () => {
    const { results, run, tab, releases, client } = fixture()
    const keys = run(3, 'q1', 1, { rowsRead: 5, rowsStored: 5, rowsAvailable: 5 })
    const summary = tab().summary
    expect(tab()).toMatchObject({ rowsRead: 15, numbered: 3 })
    expect(results.removeEntry('t1', keys[1])).toBe(true)
    expect(releases()).toEqual({ 2: 1 })
    expect(client.handle(2)!.dispose).toHaveBeenCalledOnce()
    // Closing does not subtract its rows, and the others keep their numbers of three.
    expect(tab()).toMatchObject({ status: 'completed', rowsRead: 15, numbered: 3, view: 'results' })
    expect(tab().summary).toBe(summary)
    expect(tab().emptied).toBeUndefined()
    expect(tab().sets.map(set => set.number)).toEqual([1, 3])
    // A second close of it, by a late click, does nothing.
    expect(results.removeEntry('t1', keys[1])).toBe(false)
    expect(releases()).toEqual({ 2: 1 })
  })

  it('counts only the query\'s own rows in the run total: a derived result adds none', async () => {
    const { results, pivot, run, tab } = fixture()
    const keys = run(2, 'q1', 1, { rowsRead: 7, rowsStored: 7, rowsAvailable: 7 })
    expect(tab().rowsRead).toBe(14)
    pivot.open('t1', keys[0])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    await settle()
    expect(tab().sets).toHaveLength(3)
    expect(tab().rowsRead).toBe(14)
    expect(results.addSet('t1', descriptor(950, { index: 0, kind: 'diff', rowsRead: 40, rowsStored: 40, rowsAvailable: 40 }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])).toBeDefined()
    expect(tab().rowsRead).toBe(14)
    expect(tab().numbered).toBe(4)
  })

  it('gives up a pivot, a transpose and a comparison whose source is closed, and releases an answer that comes anyway', async () => {
    const { results, pivot, transpose, compare, run, tab, handle, client, releases } = fixture()
    const keys = run(3)
    // A pivot of Result 2 is being built when Result 2 is closed.
    const building = held<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(handle(2).pivot).mockImplementationOnce((_spec, o) => building.take(o?.signal))
    pivot.open('t1', keys[1])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    const pivoting = pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1.running).toBe(true)
    // So is a transpose of it, and a comparison of it with Result 1.
    const turning = held<Awaited<ReturnType<FakeHandle['transpose']>>>()
    vi.mocked(handle(2).transpose).mockImplementationOnce((_spec, o) => turning.take(o?.signal))
    const transposing = transpose.transpose('t1', keys[1])
    const diffing = held<Awaited<ReturnType<FakeHandle['diff']>>>()
    vi.mocked(handle(1).diff).mockImplementationOnce((_right, o) => diffing.take(o?.signal))
    const comparing = compare.compare('t1', keys[1])
    expect(transpose.isRunning('t1')).toBe(true)

    expect(results.removeEntry('t1', keys[1])).toBe(true)
    expect([building.state.signal?.aborted, turning.state.signal?.aborted, diffing.state.signal?.aborted]).toEqual([true, true, true])
    await Promise.all([pivoting, transposing, comparing])
    await settle()
    // Nothing was added, nothing is running, and the panel moved to a result it can pivot without an error of the old one.
    expect(tab().sets.map(set => set.number)).toEqual([1, 3])
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, source: keys[0] })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    expect(transpose.isRunning('t1')).toBe(false)
    expect(tab().jobNotice).toBe('')
    expect(compare.canCompare('t1', keys[2])).toBe(true)

    // The backend answered just as the source closed, before the abort reached it: the run does not take a result made
    // from one it no longer has. It is released, once, and shown nowhere.
    expect(results.addSet('t1', descriptor(802, { index: 1, kind: 'pivot' }), 'Pivot of Result 2', ['1:2'])).toBeUndefined()
    expect(results.addSet('t1', descriptor(902, { index: 1, kind: 'diff' }), 'Differences: Result 1 → Result 2', ['1:1', '1:2'])).toBeUndefined()
    expect(tab().sets.map(set => set.number)).toEqual([1, 3])
    expect(releases()).toEqual({ 2: 1, 802: 1, 902: 1 })
    expect(client.open).toHaveBeenCalledTimes(3)
  })

  it('releases a pivot, a transpose and a comparison the backend had already answered when their source closed', async () => {
    const { results, pivot, transpose, compare, run, tab, handle, releases } = fixture()
    const keys = run(3)
    // The answers are on their way: these resolve whatever the signal says, as an answer that beat the abort does.
    const built = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>(), turned = deferred<Awaited<ReturnType<FakeHandle['transpose']>>>(), diffed = deferred<Awaited<ReturnType<FakeHandle['diff']>>>()
    const answers = { pivot: await handle(2).pivot({ rows: [0], values: [{ aggregate: 'count' }] }), transpose: await handle(2).transpose(), diff: await handle(1).diff(handle(2)) }
    vi.mocked(handle(2).pivot).mockReturnValueOnce(built.promise)
    vi.mocked(handle(2).transpose).mockReturnValueOnce(turned.promise)
    vi.mocked(handle(1).diff).mockReturnValueOnce(diffed.promise)
    pivot.open('t1', keys[1])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    const working = [pivot.run('t1'), transpose.transpose('t1', keys[1]), compare.compare('t1', keys[1])]
    results.removeEntry('t1', keys[1])
    built.resolve(answers.pivot)
    turned.resolve(answers.transpose)
    diffed.resolve(answers.diff)
    await Promise.all(working)
    await settle()
    // Each is released once and shown nowhere; the panel, which moved to Result 1, says nothing of the pivot given up.
    expect(tab().sets.map(set => set.number)).toEqual([1, 3])
    expect(releases()).toEqual({ 2: 1, 802: 1, 702: 1, 901: 1 })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, source: keys[0] })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    expect(pivot.getSnapshot().info.size).toBe(0)
    expect(transpose.getSnapshot().size).toBe(0)
    expect(compare.getSnapshot().size).toBe(0)
    expect(tab().jobNotice).toBe('')
  })

  it('leaves work on another result alone when one is closed, and a comparison outlives its source under its name', async () => {
    const { results, pivot, compare, run, tab, handle, releases } = fixture()
    const keys = run(3)
    await compare.compare('t1', keys[1])
    pivot.open('t1', keys[2])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    const building = held<Awaited<ReturnType<FakeHandle['pivot']>>>()
    const answer = await handle(3).pivot({ rows: [0], values: [{ aggregate: 'count' }] })
    vi.mocked(handle(3).pivot).mockClear()
    vi.mocked(handle(3).pivot).mockImplementationOnce((_spec, o) => building.take(o?.signal))
    const pivoting = pivot.run('t1')
    // Result 1 is closed while Result 3 is pivoted: the pivot goes on, and the comparison made from Result 1 stays.
    results.removeEntry('t1', keys[0])
    expect(building.state.signal?.aborted).toBe(false)
    building.answer.resolve(answer)
    await pivoting
    await settle()
    // The Pivot stands under its Table, the comparison after the groups.
    expect(tab().sets.map(set => [set.number, set.label])).toEqual([[2, undefined], [3, undefined], [5, 'Pivot of Result 3'], [4, 'Differences: Result 1 → Result 2']])
    expect(releases()).toEqual({ 1: 1 })
    // The comparison's own close releases only the comparison.
    results.removeEntry('t1', tab().sets[3].key)
    expect(releases()).toEqual({ 1: 1, 901: 1 })
    expect(tab().sets.map(set => set.number)).toEqual([2, 3, 5])
  })

  it('closes a sort being built and the filters\' distinct snapshots with their result, and shows no view that answers late', async () => {
    const { results, run, tab, handle } = fixture()
    const keys = run(2)
    const list = await handle(1).distinct(0) as DistinctList & { close: ReturnType<typeof vi.fn> }
    const view = { ...handle(1), viewId: 3, base: handle(1), keys: [], filters: [{ op: 'groups', column: 0, values: 1, nulls: false, keep: true }], rows: 1, baseRows: 2, complete: true, approximate: false, close: vi.fn(async () => {}) } as unknown as ResultView
    handle(1).sort.mockResolvedValueOnce(view)
    expect(results.applyColumnFilter('t1', keys[0], 0, { kind: 'list', list, keep: true, values: [0], nulls: false } as never)).toBe(true)
    await settle()
    expect(tab().sorts.get(keys[0])).toMatchObject({ sorting: false, view })
    // A re-sort is in flight when the result is closed.
    const building = deferred<ResultView>()
    handle(1).sort.mockReturnValueOnce(building.promise)
    results.sortBy('t1', keys[0], 0, 'ascending')
    expect(tab().sorts.get(keys[0])).toMatchObject({ sorting: true })
    results.removeEntry('t1', keys[0])
    expect(list.close).toHaveBeenCalledOnce()
    expect(tab().sorts.size).toBe(0)
    const late = { ...view, viewId: 4, close: vi.fn(async () => {}) } as unknown as ResultView
    building.resolve(late)
    await settle()
    expect(late.close).toHaveBeenCalledOnce()
    expect(tab().sorts.size).toBe(0)
    expect(tab().jobNotice).toBe('')
  })

  it('opens no value that was read for a result closed meanwhile, and says nothing of a read its close failed', async () => {
    const { results, run, tab, handle, documents } = fixture()
    const keys = run(2, 'q1', 1, { columns: [plan] })
    const reading = deferred<Awaited<ReturnType<FakeHandle['getCell']>>>()
    handle(1).getCell.mockReturnValueOnce(reading.promise)
    const opening = results.openValue('t1', keys[0], 0, 0)
    results.removeEntry('t1', keys[0])
    reading.resolve({ text: '<ShowPlanXML/>', isNull: false, truncated: false, error: false, formatted: true })
    expect(await opening).toEqual({ opened: false })
    let fail!: (error: Error) => void
    handle(2).getCell.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    const second = results.openValue('t1', keys[1], 0, 0)
    results.removeEntry('t1', keys[1])
    fail(new Error('These results were closed. Execute the query again to see them.'))
    expect(await second).toEqual({ opened: false })
    expect(documents.openText).not.toHaveBeenCalled()
    expect(tab().emptied).toBe(true)
  })

  it('cancels a copy of the closed result but not of another, and lets a save the backend accepted finish under its lease', async () => {
    const { results, api, run, tab, releases, progress } = fixture()
    const keys = run(3)
    // A save of Result 1 has its file and is writing; a copy of Result 2 runs.
    const saving = deferred<ApiResult<SavedResults | null>>(), copying = deferred<ApiResult<ResultsJobResult>>()
    api.saveResults.mockReturnValueOnce(saving.promise)
    const saved = results.saveAs('t1', keys[0], 'SQLQuery1')
    for (const listener of progress) listener({ jobId: 'job-1', kind: 'save', rowsDone: 1, rowsTotal: 2, bytes: 0, fileName: 'out.csv' })
    results.setSelection('t1', keys[1], selectAll(keys[1]))
    api.copyResults.mockReturnValueOnce(copying.promise)
    const copied = results.copy('t1', keys[1], false)
    expect(tab().jobs.map(job => [job.kind, job.label])).toEqual([['save', 'Result 1'], ['copy', 'Result 2']])
    // Closing Result 3 touches neither job.
    results.removeEntry('t1', keys[2])
    expect(api.cancelResultsJob).not.toHaveBeenCalled()
    // Closing Result 1 releases it (the backend's lease keeps it for the save) and does not cancel its save.
    results.removeEntry('t1', keys[0])
    expect(api.cancelResultsJob).not.toHaveBeenCalled()
    expect(releases()).toEqual({ 3: 1, 1: 1 })
    expect(tab().jobs.map(job => [job.kind, job.label])).toEqual([['save', 'Result 1'], ['copy', 'Result 2']])
    // Closing Result 2 cancels its copy, which ends without a word.
    results.removeEntry('t1', keys[1])
    expect(api.cancelResultsJob.mock.calls).toEqual([['job-2']])
    copying.resolve({ ok: false, error: 'Cancelled', code: 'CANCELLED' })
    expect(await copied).toBeUndefined()
    // The save ends and says so, though its result and every other are gone.
    saving.resolve({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0, fileName: 'out.csv', format: 'csv' } })
    expect(await saved).toBeUndefined()
    expect(tab()).toMatchObject({ jobs: [], jobNotice: 'Saved 2 rows to out.csv.', emptied: true })
  })

  it('waits for a retained-plan copy in progress before releasing a closed result, as Close Results does', async () => {
    const copy = deferred<void>()
    const retainedPlans = { capture: vi.fn(() => copy.promise) } as unknown as RetainedPlansService
    const { results, client, tab, releases } = fixture({ retainedPlans })
    results.begin('t1', 'q1')
    const finished = results.finish('t1', 'q1', {
      summary: summaryOf([descriptor(1, { columns: [plan], kind: 'executionPlan' }), descriptor(2, { index: 1 })], { planSets: [descriptor(7, { index: 0, columns: [plan] })] }),
      planContext: {} as never
    })
    expect(retainedPlans.capture).toHaveBeenCalledOnce()
    const [first, second] = tab().sets.map(set => set.key)
    // The plan set leaves the list at once, but the copy still reads it: nothing is released yet.
    expect(results.removeEntry('t1', first)).toBe(true)
    expect(tab().sets.map(set => set.number)).toEqual([2])
    expect(client.release).not.toHaveBeenCalled()
    expect(client.handle(1)!.getSnapshot().state).toBe('complete')
    copy.resolve()
    await finished
    await settle()
    expect(releases()).toEqual({ 1: 1 })
    // Once the copy is done a close releases at once; captured plans are not a result's to close.
    results.removeEntry('t1', second)
    expect(releases()).toEqual({ 1: 1, 2: 1 })
    expect(tab()).toMatchObject({ emptied: true, planSets: [{ descriptor: { resultId: 7 } }] })
    expect(client.handle(7)!.getSnapshot().state).toBe('complete')
  })

  it('releases on the next run only what was not closed already, and takes highlights of a closed result into that run', async () => {
    const { results, highlights, run, tab, releases, client } = fixture()
    const keys = run(3)
    results.setSelection('t1', keys[1], selectAll(keys[1]))
    await highlights.highlight('t1', keys[1], 1)
    await settle()
    expect(highlights.hasHighlights('t1', keys[1])).toBe(true)
    results.removeEntry('t1', keys[1])
    await settle()
    expect(highlights.getSnapshot().t1).toBeUndefined()
    expect(releases()).toEqual({ 2: 1 })
    // The run again: Results 1 and 3 are released, Result 2 not a second time, and the new run starts unemptied.
    const next = run(3, 'q2', 11)
    expect(releases()).toEqual({ 2: 1, 1: 1, 3: 1 })
    expect(tab()).toMatchObject({ queryId: 'q2', numbered: 3 })
    expect(tab().emptied).toBeUndefined()
    await settle()
    // Its Result 2 has the highlights the closed Result 2 had.
    expect(highlights.hasHighlights('t1', next[1])).toBe(true)
    expect(highlights.hasHighlights('t1', next[0])).toBe(false)
    // An emptied run that runs again is a run like any other.
    for (const key of next) results.removeEntry('t1', key)
    expect(tab().emptied).toBe(true)
    run(1, 'q3', 21)
    expect(tab().emptied).toBeUndefined()
    expect(tab().sets).toHaveLength(1)
    expect(client.released().filter(id => id >= 11 && id <= 13).sort()).toEqual([11, 12, 13])
  })

  it('keeps closing and Messages working when the backend is lost, and lets a lost run\'s results be closed', () => {
    const { results, client, run, tab, releases } = fixture()
    const keys = run(2)
    client.lose()
    expect(results.context.getSnapshot().t1).toBeUndefined()
    // The rows are gone with the backend; the entries can still be closed, one by one.
    expect(results.removeEntry('t1', keys[0])).toBe(true)
    expect(tab().sets.map(set => set.number)).toEqual([2])
    expect(client.handle(1)!.getSnapshot().state).toBe('lost')
    results.setView('t1', 'messages')
    expect(tab().view).toBe('messages')
    expect(results.removeEntry('t1', keys[1])).toBe(true)
    expect(tab()).toMatchObject({ status: 'completed', emptied: true, sets: [] })
    expect(releases()).toEqual({ 1: 1, 2: 1 })
    // A run the backend was lost under ends lost, and its results close the same way.
    results.begin('t1', 'q2')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(5, { index: 0, state: 'open' }) })
    expect(results.removeEntry('t1', tab().sets[0].key)).toBe(false)
    void results.finish('t1', 'q2', { error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    expect(tab().status).toBe('lost')
    expect(results.removeEntry('t1', tab().sets[0].key)).toBe(true)
    expect(tab()).toMatchObject({ status: 'lost', emptied: true })
  })

  it('marks a run emptied when its last result is closed one at a time: Results stays, plans stay, and it does not read as no result sets', () => {
    const { results, client, run, tab, releases } = fixture()
    results.begin('t1', 'q1')
    void results.finish('t1', 'q1', { summary: summaryOf([descriptor(1), descriptor(2, { index: 1 })], { planSets: [descriptor(7, { index: 0, columns: [plan] })], messages: [{ text: '(2 rows affected)', kind: 'info' }] }) })
    const summary = tab().summary, keys = tab().sets.map(set => set.key)
    expect(hasResultsView(tab())).toBe(true)
    results.removeEntry('t1', keys[0])
    expect(tab().emptied).toBeUndefined()
    results.removeEntry('t1', keys[1])
    // The status and the summary are the run's, unchanged; the flag sits beside them.
    expect(tab()).toMatchObject({ status: 'completed', emptied: true, sets: [], view: 'results', rowsRead: 4, numbered: 2, messages: [{ text: '(2 rows affected)' }] })
    expect(tab().summary).toBe(summary)
    expect(tab().closedFrom).toBeUndefined()
    // The output stays on Results, which says the results were closed, not that the query returned none.
    expect(hasResultsView(tab())).toBe(true)
    expect(outputViewOf(tab())).toBe('results')
    expect(emptyResultsText(tab())).toBe('Results were closed. Execute the query again to see them.')
    // A view the user picked is kept, and Results is still there to go back to.
    results.setView('t1', 'messages')
    expect(outputViewOf(tab())).toBe('messages')
    results.setView('t1', 'plan')
    expect(outputViewOf(tab())).toBe('plan')
    results.setView('t1', 'results')
    expect(outputViewOf(tab())).toBe('results')
    // Captured plans and their pane are untouched, so the tab still has something to close (hasResults).
    expect(tab().planSets).toHaveLength(1)
    expect(client.handle(7)!.getSnapshot().state).toBe('complete')
    expect(results.context.getSnapshot().t1).toBe(true)
    expect(releases()).toEqual({ 1: 1, 2: 1 })
    // Close Results then releases the plans and reads closed, as it always has.
    results.closeResults('t1')
    expect(tab()).toMatchObject({ status: 'closed', closedFrom: 'completed', planSets: [] })
    expect(tab().emptied).toBeUndefined()
    expect(emptyResultsText(tab())).toBe('Results were closed to free memory. Execute the query again to see them.')
    expect(releases()).toEqual({ 1: 1, 2: 1, 7: 1 })
    // A run that returned nothing was never emptied, and one still running says so.
    run(0, 'q2')
    expect(hasResultsView(tab())).toBe(false)
    expect(outputViewOf(tab())).toBe('messages')
    expect(emptyResultsText(tab())).toBe('The query returned no result sets.')
    expect(emptyResultsText({ status: 'running' })).toBe('Result sets appear here as the query returns them.')
  })

  it('takes every result out through the same cleanup when the results are closed, the query runs again or the tab closes', async () => {
    const { results, events, api, run, tab, handle, releases, client } = fixture()
    for (const leave of [() => results.closeResults('t1'), () => { results.begin('t1', 'again') }, () => events.emit({ type: 'documents.closed', tabId: 't1' })]) {
      client.release.mockClear()
      api.cancelResultsJob.mockClear()
      const first = 100 * (releasesRun.count++ + 1)
      const keys = run(2, 'q' + first, first)
      const list = await handle(first).distinct(0) as DistinctList & { close: ReturnType<typeof vi.fn> }
      const view = { ...handle(first), viewId: 3, base: handle(first), keys: [], filters: [{ op: 'groups', column: 0, values: 1, nulls: false, keep: true }], rows: 1, baseRows: 2, complete: true, approximate: false, close: vi.fn(async () => {}) } as unknown as ResultView
      handle(first).sort.mockResolvedValueOnce(view)
      results.applyColumnFilter('t1', keys[0], 0, { kind: 'list', list, keep: true, values: [0], nulls: false } as never)
      await settle()
      const building = deferred<ResultView>()
      handle(first + 1).sort.mockReturnValueOnce(building.promise)
      results.sortBy('t1', keys[1], 0, 'ascending')
      results.setSelection('t1', keys[0], selectAll(keys[0]))
      const copying = deferred<ApiResult<ResultsJobResult>>()
      api.copyResults.mockReturnValueOnce(copying.promise)
      const copied = results.copy('t1', keys[0], false)
      leave()
      // One request releases both; the filter's snapshot is closed, the copy cancelled, the late view closed.
      expect(client.release).toHaveBeenCalledOnce()
      expect(releases()).toEqual({ [first]: 1, [first + 1]: 1 })
      expect(list.close).toHaveBeenCalledOnce()
      expect(api.cancelResultsJob).toHaveBeenCalledOnce()
      copying.resolve({ ok: false, error: 'Cancelled', code: 'CANCELLED' })
      expect(await copied).toBeUndefined()
      const late = { ...view, viewId: 4, close: vi.fn(async () => {}) } as unknown as ResultView
      building.resolve(late)
      await settle()
      expect(late.close).toHaveBeenCalledOnce()
      expect(results.sortOf('t1', keys[1])).toBeUndefined()
      expect(tab()?.sorts.size ?? 0).toBe(0)
    }
  })
})

const releasesRun = { count: 0 }
