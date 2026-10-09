import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ResultsJobProgress, ResultsJobResult, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { ResultsService, resultLimits } from '../src/renderer/src/results/ResultsService'
import { selectAll } from '../src/renderer/src/grid/selection'
import { openEnd } from '../src/renderer/src/grid/constants'
import { deferred } from './fixtures/documents'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const frames: (() => void)[] = []
  const progress = new Set<(value: ResultsJobProgress) => void>()
  let ids = 0
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(async () => ({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false } })),
    cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(async () => ({ ok: true, value: { cancelled: true } })),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const service = new ResultsService({ client, api, events, frame: callback => { frames.push(callback) }, timers: timers.timers, now: () => 1000, newId: () => `job-${++ids}` })
  const published = { count: 0 }
  service.subscribe(() => { published.count++ })
  const flush = () => { for (const callback of frames.splice(0)) callback() }
  const tab = (id = 't1') => service.getSnapshot()[id]
  return { client, events, timers, api, service, published, flush, tab, progress }
}

describe('results service', () => {
  it('opens each set as the backend announces it, in order, and publishes at most once a frame', () => {
    const { client, service, published, flush, tab } = fixture()
    service.begin('t1', 'q1')
    expect(client.listening('q1')).toBe(1)
    expect(tab()).toMatchObject({ status: 'running', sets: [], view: 'messages', startedAt: 1000 })
    const before = published.count
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(2, { index: 1, state: 'open', rowsRead: 0, rowsAvailable: 0 }) })
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { index: 0, state: 'open', rowsRead: 0, rowsAvailable: 0 }) })
    client.emit('q1', { type: 'progress', completedBatches: 0, totalBatches: 2, batchNumber: 1, iteration: 1, results: [{ resultId: 1, rowsRead: 50, rowsStored: 50, rowsAvailable: 40, bytesStored: 1 }, { resultId: 9, rowsRead: 5, rowsStored: 5, rowsAvailable: 5, bytesStored: 1 }] })
    client.emit('q1', { type: 'messages', messages: [{ text: '(50 rows affected)', kind: 'info' }] })
    expect(published.count).toBe(before)
    flush()
    expect(published.count).toBe(before + 1)
    expect(tab().sets.map(set => [set.index, set.descriptor.resultId])).toEqual([[0, 1], [1, 2]])
    // Rows count only for the run's own sets; the first set switches the view to Results.
    expect(tab()).toMatchObject({ rowsRead: 50, completedBatches: 0, totalBatches: 2, view: 'results', messages: [{ text: '(50 rows affected)', kind: 'info' }] })
    // Opening the same set again (its closed event) keeps one handle.
    client.emit('q1', { type: 'resultSet.closed', descriptor: descriptor(1, { index: 0 }) })
    flush()
    expect(tab().sets).toHaveLength(2)
    expect(client.open).toHaveBeenCalledTimes(2)
  })
  it('keeps a thousand sets in the backend\'s order, never changing an array a snapshot already holds', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { index: 0, state: 'open' }) })
    flush()
    const published = tab().sets
    // Set 500's opened event was lost: it arrives last (as the summary brings it), after the sets that follow it.
    for (let index = 1; index < 1000; index++) if (index !== 500) client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(index + 1, { index, state: 'open' }) })
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(501, { index: 500, state: 'open' }) })
    for (let index = 0; index < 1000; index++) client.emit('q1', { type: 'resultSet.closed', descriptor: descriptor(index + 1, { index }) })
    expect(published).toHaveLength(1)
    flush()
    const sets = tab().sets
    expect(sets.map(set => [set.index, set.descriptor.index, set.descriptor.resultId])).toEqual(Array.from({ length: 1000 }, (_, index) => [index, index, index + 1]))
    expect(client.open).toHaveBeenCalledTimes(1000)
    // A set past the limit is not kept, and the published array stays as it was.
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(2000, { index: 1000, state: 'open' }) })
    flush()
    expect(tab().sets).toHaveLength(resultLimits.sets)
    expect(sets).toHaveLength(1000)
  })
  it('settles with the summary: missing sets open, its messages replace the streamed ones, and later events change nothing', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open' }) })
    client.emit('q1', { type: 'messages', messages: [{ text: 'partial', kind: 'info' }] })
    flush()
    const summary = summaryOf([descriptor(1), descriptor(2, { index: 1 })], { messages: [{ text: 'partial', kind: 'info' }, { text: 'dropped frame', kind: 'info' }], completedBatches: 1, totalBatches: 1 })
    service.finish('t1', 'q1', { summary })
    expect(client.applySummary).toHaveBeenCalledWith(summary)
    expect(tab()).toMatchObject({ status: 'completed', rowsRead: 4, summary, messages: summary.messages, view: 'results' })
    expect(tab().sets.map(set => set.descriptor.resultId)).toEqual([1, 2])
    expect(client.listening('q1')).toBe(0)
    client.emit('q1', { type: 'messages', messages: [{ text: 'late', kind: 'info' }] })
    flush()
    expect(tab().messages).toEqual(summary.messages)
    // A finish for another run, or a second one, is ignored.
    service.finish('t1', 'other', { error: 'x' })
    service.finish('t1', 'q1', { error: 'x' })
    expect(tab().status).toBe('completed')
  })
  it('switches to Messages when a run fails or returns no sets, until the user picks a tab', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open' }) })
    flush()
    expect(tab().view).toBe('results')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)], { status: 'failed', messages: [{ text: 'Msg 1, Level 16, State 1, Line 1\nBad.', kind: 'error' }] }) })
    expect(tab()).toMatchObject({ status: 'failed', view: 'messages', manualView: false })
    service.setView('t1', 'results')
    expect(tab()).toMatchObject({ view: 'results', manualView: true })
    service.begin('t1', 'q2')
    expect(tab()).toMatchObject({ view: 'messages', manualView: false })
    service.setView('t1', 'messages')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(3, { state: 'open' }) })
    flush()
    expect(tab().view).toBe('messages')
    service.finish('t2', 'q2', { summary: summaryOf([]) })
    service.begin('t3', 'q3')
    service.finish('t3', 'q3', { summary: summaryOf([]) })
    expect(tab('t3')).toMatchObject({ status: 'completed', view: 'messages' })
  })
  it('ends a run main failed as an error entry, and a lost backend as lost', () => {
    const { service, tab } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { error: 'The SQL backend stopped while this script was running. It was not re-run.', code: 'BACKEND_LOST' })
    expect(tab()).toMatchObject({ status: 'lost', error: 'The SQL backend stopped while this script was running. It was not re-run.', messages: [{ text: 'The SQL backend stopped while this script was running. It was not re-run.', kind: 'error' }] })
    service.begin('t1', 'q2')
    service.finish('t1', 'q2', { error: 'Connect to a SQL Server first.', code: 'NOT_CONNECTED' })
    expect(tab()).toMatchObject({ status: 'failed', messages: [{ text: 'Connect to a SQL Server first.', kind: 'error' }] })
    // A notice comes first, and the summary's messages after it.
    service.begin('t1', 'q3')
    service.finish('t1', 'q3', { summary: summaryOf([], { messages: [{ text: 'mine', kind: 'info' }] }), notice: 'New session.' })
    expect(tab().messages).toEqual([{ text: 'New session.', kind: 'info' }, { text: 'mine', kind: 'info' }])
  })
  it('bounds a run\'s sets and messages', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    for (let id = 1; id <= resultLimits.sets + 5; id++) client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(id, { index: id - 1 }) })
    client.emit('q1', { type: 'messages', messages: Array.from({ length: 1500 }, (_, index) => ({ text: String(index), kind: 'info' as const })) })
    flush()
    expect(tab().sets).toHaveLength(resultLimits.sets)
    expect(tab()).toMatchObject({ messagesTruncated: true })
    expect(tab().messages).toHaveLength(resultLimits.messages)
  })
  it('releases a tab\'s results when it runs again, closes, or the user closes them, and keeps its view state otherwise', () => {
    const { client, events, service, tab } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1), descriptor(2, { index: 1 })]) })
    const first = client.handle(1)!, second = client.handle(2)!
    service.gridState('t1', 1).scrollLeft = 40
    service.setSelection('t1', 1, selectAll(1))
    expect(service.viewState('t1').grids.get(1)).toMatchObject({ scrollLeft: 40, selection: selectAll(1) })
    // Closing results keeps Messages and frees the sets; a running query's results cannot be closed.
    service.closeResults('t1')
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(tab()).toMatchObject({ status: 'closed', sets: [] })
    expect(service.viewState('t1').grids.size).toBe(0)
    service.begin('t1', 'q2')
    service.closeResults('t1')
    expect(tab().status).toBe('running')
    service.finish('t1', 'q2', { summary: summaryOf([descriptor(3)]) })
    // Running again releases the last run's results first.
    service.begin('t1', 'q3')
    expect(client.handle(3)!.close).toHaveBeenCalledOnce()
    service.finish('t1', 'q3', { summary: summaryOf([descriptor(4)]) })
    events.emit({ type: 'documents.closed', tabId: 't1' })
    expect(client.handle(4)!.close).toHaveBeenCalledOnce()
    expect(tab()).toBeUndefined()
    service.release('missing')
  })
  it('copies a selection through main, shows its strip after 300 ms, and announces it', async () => {
    const { api, service, tab, timers, flush, progress } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    expect(await service.copy('t1', 0, false)).toBeUndefined()
    expect(api.copyResults).not.toHaveBeenCalled()
    service.setSelection('t1', 0, selectAll(0))
    const pending = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(pending.promise)
    const copying = service.copy('t1', 0, true)
    expect(api.copyResults).toHaveBeenCalledWith({ jobId: 'job-1', generation: 1, resultId: 1, headers: true, parts: [{ rows: [[0, openEnd]], columns: [[0, 1]] }] })
    flush()
    expect(tab().jobs).toEqual([expect.objectContaining({ jobId: 'job-1', kind: 'copy', visible: false })])
    timers.advance(300)
    flush()
    expect(tab().jobs[0]).toMatchObject({ visible: true })
    for (const listener of progress) listener({ jobId: 'job-1', kind: 'copy', rowsDone: 1, rowsTotal: 2, bytes: 5 })
    flush()
    expect(tab().jobs[0]).toMatchObject({ rowsDone: 1, rowsTotal: 2 })
    pending.resolve({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: true } })
    expect(await copying).toBeUndefined()
    flush()
    expect(tab().jobs).toEqual([])
    timers.advance(300)
    expect(tab().announcement).toBe('Copied 2 rows; the query is still running.')
    // The same sentence again is still a change, so it is read out again.
    await service.copy('t1', 0, false)
    timers.advance(300)
    expect(tab().announcement).toBe('Copied 2 rows.')
  })
  it('runs one copy at a time, cancels it on Escape or a new run, and returns failures as sentences', async () => {
    const { api, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.setSelection('t1', 0, selectAll(0))
    const first = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(first.promise)
    const copying = service.copy('t1', 0, false)
    expect(service.cancelTabJob('other')).toBe(false)
    expect(service.cancelTabJob('t1')).toBe(true)
    expect(api.cancelResultsJob).toHaveBeenLastCalledWith('job-1')
    // A new copy cancels the one running.
    api.copyResults.mockResolvedValueOnce({ ok: false, code: 'TOO_LARGE', error: 'The selection is too large to copy (70 MB; the limit is 64 MB). Use Save Results As instead.' })
    expect(await service.copy('t1', 0, false)).toBe('The selection is too large to copy (70 MB; the limit is 64 MB). Use Save Results As instead.')
    expect(api.cancelResultsJob).toHaveBeenCalledTimes(2)
    first.resolve({ ok: false, code: 'CANCELLED', error: 'The operation was cancelled.' })
    expect(await copying).toBeUndefined()
    api.copyResults.mockResolvedValueOnce({ ok: false, code: 'RESULT_UNAVAILABLE', error: 'These results are no longer available.' })
    expect(await service.copy('t1', 0, false)).toBe('Could not copy the results: These results are no longer available.')
    const hung = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(hung.promise)
    void service.copy('t1', 0, false)
    service.begin('t1', 'q2')
    expect(api.cancelResultsJob).toHaveBeenLastCalledWith('job-4')
    hung.resolve({ ok: false, code: 'CANCELLED', error: 'The operation was cancelled.' })
  })
  it('refuses to copy results the backend lost or the user closed', async () => {
    const { api, client, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.setSelection('t1', 0, selectAll(0))
    client.lose()
    expect(await service.copy('t1', 0, false)).toBe('These results are no longer available because the SQL backend restarted.')
    expect(api.copyResults).not.toHaveBeenCalled()
  })
  it('routes Select All to the mounted grid, else to the view state', () => {
    const { service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.selectAll('t1', 0)
    expect(service.selection('t1', 0)).toEqual(selectAll(0))
    const controller = { selectAll: vi.fn(), repaint: vi.fn() }
    const registration = service.registerGrid('t1', 0, controller)
    service.selectAll('t1', 0)
    expect(controller.selectAll).toHaveBeenCalledOnce()
    service.clearSelections('t1')
    expect(controller.repaint).toHaveBeenCalled()
    expect(service.selection('t1', 0)).toBeUndefined()
    registration.dispose()
    service.selectAll('t1', 0)
    expect(controller.selectAll).toHaveBeenCalledOnce()
  })
  it('stops listening and frees its timers when disposed', () => {
    const { client, service, timers, progress } = fixture()
    service.begin('t1', 'q1')
    service.announce('t1', 'hello')
    service.dispose()
    expect(client.listening('q1')).toBe(0)
    expect(progress.size).toBe(0)
    expect(timers.pending.size).toBe(0)
    service.begin('t1', 'q2')
    expect(client.listening('q2')).toBe(0)
  })
})
