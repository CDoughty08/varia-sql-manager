import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ResolvedViewFilter, ResultColumn, ResultsJobProgress, ResultsJobResult, SavedResults, VariaApi, ViewSortKey, ViewSortMode } from '../src/shared/contracts'
import type { ResultHandle, ResultView } from '../src/renderer/src/results/ResultClient'
import type { DocumentService } from '../src/renderer/src/services/documents'
import { EventBus } from '../src/renderer/src/core/events'
import { filterLabel, filteredColumns, ResultsService, resultLimits, suggestedName, transposedView } from '../src/renderer/src/results/ResultsService'
import { limits } from '../src/shared/ipc/wire/protocol'
import { selectAll } from '../src/renderer/src/grid/selection'
import { openEnd } from '../src/renderer/src/grid/constants'
import { deferred } from './fixtures/documents'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt, noEntry } from './fixtures/entries'

function fixture(o: { sortText?: () => ViewSortMode; onSortTextChange?: (listener: () => void) => () => void } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const frames: (() => void)[] = []
  const progress = new Set<(value: ResultsJobProgress) => void>()
  let ids = 0
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(async () => ({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0 } })),
    saveResults: vi.fn<VariaApi['saveResults']>(async () => ({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0, fileName: 'SQLQuery1-Result1.csv', format: 'csv' as const } })),
    cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(async () => ({ ok: true, value: { cancelled: true } })),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const documents = { openText: vi.fn<DocumentService['openText']>(o => ({ id: 'doc', name: o.name, kind: o.kind, database: '', dirty: false, savedVersionId: 1 })) }
  const clock = { now: 1000 }
  const service = new ResultsService({ client, api, events, documents, frame: callback => { frames.push(callback) }, timers: timers.timers, now: () => clock.now, newId: () => `job-${++ids}`, ...o })
  const published = { count: 0 }
  service.subscribe(() => { published.count++ })
  const flush = () => { for (const callback of frames.splice(0)) callback() }
  const tab = (id = 't1') => service.getSnapshot()[id]
  return { client, events, timers, api, service, published, flush, tab, progress, documents, clock }
}

describe('results service', () => {
  it('reports an output choice even before the tab has an ordinary result run', () => {
    const { service, events, client } = fixture()
    const choices: unknown[] = []
    events.subscribe(event => { if (event.type === 'query.outputSelected') choices.push(event) })
    service.setView('estimate-only', 'messages')
    expect(choices).toEqual([{ type: 'query.outputSelected', tabId: 'estimate-only', view: 'messages' }])
    expect(service.getSnapshot()).toEqual({})
    expect(client.open).not.toHaveBeenCalled()
    service.dispose()
  })
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
    expect(tab().sets.map(set => set.descriptor.resultId)).toEqual([1, 2])
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
    expect(sets.map(set => [set.descriptor.index, set.descriptor.resultId])).toEqual(Array.from({ length: 1000 }, (_, index) => [index, index + 1]))
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
  it('ends a run without sets on Messages and one with sets on Results, even when it failed, until the user picks a view', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open' }) })
    flush()
    expect(tab().view).toBe('results')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)], { status: 'failed', messages: [{ text: 'Msg 1, Level 16, State 1, Line 1\nBad.', kind: 'error' }] }) })
    // The error shows in the Messages strip under the grid, which it opened.
    expect(tab()).toMatchObject({ status: 'failed', view: 'results', manualView: false, strip: true })
    service.setView('t1', 'plan')
    expect(tab()).toMatchObject({ view: 'plan', manualView: true })
    service.setView('t1', 'results')
    expect(tab()).toMatchObject({ view: 'results', manualView: true })
    service.begin('t1', 'q2')
    flush()
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
  it('ends a run whose later batches ran after an error on Results with the strip open, completed with errors, its sets in batch order', () => {
    const { service, tab } = fixture()
    service.begin('t1', 'q1')
    const sets = [descriptor(1, { batchNumber: 1 }), descriptor(2, { batchNumber: 3 }), descriptor(3, { batchNumber: 3, incomplete: true })]
    const error = { code: 'SQL_ERROR', message: 'Msg 208, Level 16, State 1, Line 3\nInvalid object name.', batchNumber: 2, iteration: 1 }
    service.finish('t1', 'q1', { summary: summaryOf(sets, { status: 'completedWithErrors', error, completedBatches: 3, totalBatches: 3, messages: [
      { text: error.message, kind: 'error' }, { text: 'Batch 2 raised an error; execution continued with the next batch.', kind: 'info' }] }) })
    expect(tab()).toMatchObject({ status: 'completedWithErrors', view: 'results', strip: true, completedBatches: 3, totalBatches: 3 })
    expect(tab().sets.map(set => [set.descriptor.batchNumber, set.descriptor.incomplete])).toEqual([[1, false], [3, false], [3, true]])
    expect(tab().messages.map(entry => entry.kind)).toEqual(['error', 'info'])
    // A summary whose errors fell past the message caps still shows its error.
    service.begin('t1', 'q2')
    service.finish('t1', 'q2', { summary: summaryOf([], { status: 'completedWithErrors', error, messages: [{ text: 'printed', kind: 'info' }] }) })
    expect(tab().messages).toEqual([{ text: 'printed', kind: 'info' }, { text: error.message, kind: 'error' }])
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
  it('opens the Messages strip for an error, PRINT or RAISERROR, not for row counts or SQL Server\'s warnings, until the user opens or closes it', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open' }) })
    client.emit('q1', { type: 'messages', messages: [{ text: '(5 rows affected)', kind: 'info' }] })
    flush()
    expect(tab()).toMatchObject({ view: 'results', strip: false, stripChosen: false })
    // An aggregate's NULL warning (8153) and STATISTICS output show in the strip without opening it.
    client.emit('q1', { type: 'messages', messages: [{ text: 'Warning: Null value is eliminated by an aggregate or other SET operation.', kind: 'server' }, { text: 'Table \'t\'. Scan count 1, logical reads 2.', kind: 'server' }] })
    flush()
    expect(tab().strip).toBe(false)
    client.emit('q1', { type: 'messages', messages: [{ text: 'printed', kind: 'print' }] })
    flush()
    expect(tab()).toMatchObject({ strip: true, stripChosen: false })
    // Closed by the user, it stays closed for the run, whatever arrives, and starts closed next time.
    service.setStrip('t1', false)
    expect(tab()).toMatchObject({ strip: false, stripChosen: true })
    client.emit('q1', { type: 'messages', messages: [{ text: 'Msg 50000, Level 16, State 1, Line 1\nNo.', kind: 'error' }] })
    flush()
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)], { status: 'completedWithErrors', messages: [{ text: 'Msg 50000, Level 16, State 1, Line 1\nNo.', kind: 'error' }] }) })
    expect(tab().strip).toBe(false)
    service.begin('t1', 'q2')
    expect(tab().strip).toBe(false)
    // A summary is enough when its messages' events were dropped; an error that ended the run without one opens it too.
    service.finish('t1', 'q2', { summary: summaryOf([descriptor(2)], { messages: [{ text: 'Table \'t\'. Scan count 1, logical reads 2.', kind: 'server' }, { text: 'printed', kind: 'print' }] }) })
    expect(tab().strip).toBe(true)
    service.begin('t1', 'q3')
    service.finish('t1', 'q3', { error: 'The SQL backend stopped while this script was running. It was not re-run.', code: 'BACKEND_LOST' })
    expect(tab().strip).toBe(true)
    // Opened by the user, it starts open in the next run; another tab keeps its own.
    service.begin('t1', 'q4')
    service.setStrip('t1', true)
    service.begin('t1', 'q5')
    expect(tab().strip).toBe(true)
    service.begin('t2', 'q6')
    expect(tab('t2').strip).toBe(false)
    // Closing the tab forgets the choice.
    service.release('t1')
    service.begin('t1', 'q7')
    expect(tab().strip).toBe(false)
  })
  it('keeps how a run ended, and when, after its results are closed, also without a summary', () => {
    const { client, service, flush, tab, clock } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open' }) })
    flush()
    clock.now = 4500
    service.finish('t1', 'q1', { error: 'The SQL backend stopped while this script was running. It was not re-run.', code: 'BACKEND_LOST' })
    clock.now = 90_000
    service.closeResults('t1')
    expect(tab()).toMatchObject({ status: 'closed', closedFrom: 'lost', endedAt: 4500, startedAt: 1000 })
    expect(tab().summary).toBeUndefined()
    // Closing again keeps it.
    service.closeResults('t1')
    expect(tab().closedFrom).toBe('lost')
    // Main failed the run (no summary): closed, it still failed.
    service.begin('t1', 'q2')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(2, { state: 'open' }) })
    flush()
    service.finish('t1', 'q2', { error: 'The request timed out.', code: 'TIMEOUT' })
    service.closeResults('t1')
    expect(tab()).toMatchObject({ status: 'closed', closedFrom: 'failed' })
    service.begin('t1', 'q3')
    service.finish('t1', 'q3', { summary: summaryOf([descriptor(3)], { status: 'cancelled' }) })
    service.closeResults('t1')
    expect(tab()).toMatchObject({ status: 'closed', closedFrom: 'cancelled' })
  })
  it('records each set once it has all its rows, for sizing the stack, without changing a published map', () => {
    const { client, service, flush, tab } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open', rowsStored: 0 }) })
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(2, { index: 1, state: 'open', rowsStored: 0 }) })
    flush()
    const before = tab().settled
    expect(before.size).toBe(0)
    client.emit('q1', { type: 'resultSet.closed', descriptor: descriptor(1, { rowsStored: 3 }) })
    flush()
    expect(before.size).toBe(0)
    expect([...tab().settled]).toEqual([['1:1', { rows: 3, strip: false }]])
    // A truncated set shows a strip under its grid, which its height counts.
    client.emit('q1', { type: 'resultSet.closed', descriptor: descriptor(2, { index: 1, rowsStored: 50, truncated: 'rowLimit' }) })
    flush()
    expect(tab().settled.get('1:2')).toEqual({ rows: 50, strip: true })
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { rowsStored: 3 }), descriptor(2, { index: 1, rowsStored: 50, truncated: 'rowLimit' })]) })
    expect(tab().settled.size).toBe(2)
    service.closeResults('t1')
    expect(tab().settled.size).toBe(0)
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
    const { client, events, service, tab, flush } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1), descriptor(2, { index: 1 })]) })
    const first = client.handle(1)!, second = client.handle(2)!
    service.gridState('t1', keyAt(service, 't1', 1)).scrollLeft = 40
    service.setSelection('t1', keyAt(service, 't1', 1), selectAll(keyAt(service, 't1', 1)))
    // Grid state is the entry's, by its key.
    expect(service.viewState('t1').grids.get(tab().sets[1].key)).toMatchObject({ scrollLeft: 40, selection: selectAll(keyAt(service, 't1', 1)) })
    // Closing results keeps Messages and frees the sets; a running query's results cannot be closed.
    service.closeResults('t1')
    // One request closes every set of the run.
    expect(client.release).toHaveBeenCalledOnce()
    expect(client.released()).toEqual([1, 2])
    expect([first.close, second.close].map(close => close.mock.calls.length)).toEqual([0, 0])
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(tab()).toMatchObject({ status: 'closed', sets: [] })
    expect(service.viewState('t1').grids.size).toBe(0)
    service.begin('t1', 'q2')
    service.closeResults('t1')
    flush()
    expect(tab().status).toBe('running')
    service.finish('t1', 'q2', { summary: summaryOf([descriptor(3)]) })
    // Running again releases the last run's results first.
    service.begin('t1', 'q3')
    expect(client.released()).toEqual([1, 2, 3])
    service.finish('t1', 'q3', { summary: summaryOf([descriptor(4)]) })
    events.emit({ type: 'documents.closed', tabId: 't1' })
    expect(client.released()).toEqual([1, 2, 3, 4])
    expect(tab()).toBeUndefined()
    service.release('missing')
  })
  it('releases the sets of a run that ends after its tab closed, since nothing else will', () => {
    const { client, events, service, tab } = fixture()
    service.begin('t1', 'q1')
    events.emit({ type: 'documents.closed', tabId: 't1' })
    expect(client.released()).toEqual([])
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1), descriptor(2, { index: 1 })]) })
    expect(client.released()).toEqual([1, 2])
    expect(tab()).toBeUndefined()
    // A failure has no sets, and a run that is still tracked releases nothing early.
    service.finish('t2', 'q2', { error: 'The query failed.' })
    service.begin('t3', 'q3')
    service.finish('t3', 'q3', { summary: summaryOf([descriptor(3)]) })
    expect(client.released()).toEqual([1, 2])
  })
  it('copies a selection through main, shows its strip after 300 ms, and announces it', async () => {
    const { api, service, tab, timers, flush, progress } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    expect(await service.copy('t1', keyAt(service, 't1', 0), false)).toBeUndefined()
    expect(api.copyResults).not.toHaveBeenCalled()
    service.setSelection('t1', keyAt(service, 't1', 0), selectAll(keyAt(service, 't1', 0)))
    const pending = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(pending.promise)
    const copying = service.copy('t1', keyAt(service, 't1', 0), true)
    expect(api.copyResults).toHaveBeenCalledWith({ jobId: 'job-1', generation: 1, resultId: 1, headers: true, parts: [{ rows: [[0, openEnd]], columns: [[0, 1]] }] })
    flush()
    expect(tab().jobs).toEqual([expect.objectContaining({ jobId: 'job-1', kind: 'copy', visible: false })])
    timers.advance(300)
    flush()
    expect(tab().jobs[0]).toMatchObject({ visible: true })
    for (const listener of progress) listener({ jobId: 'job-1', kind: 'copy', rowsDone: 1, rowsTotal: 2, bytes: 5 })
    flush()
    expect(tab().jobs[0]).toMatchObject({ rowsDone: 1, rowsTotal: 2 })
    pending.resolve({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: true, capped: 0 } })
    expect(await copying).toBeUndefined()
    flush()
    expect(tab().jobs).toEqual([])
    timers.advance(300)
    expect(tab().announcement).toBe('Copied 2 rows; the query is still running.')
    // The same sentence again is still a change, so it is read out again.
    await service.copy('t1', keyAt(service, 't1', 0), false)
    timers.advance(300)
    expect(tab().announcement).toBe('Copied 2 rows.')
    // Values stored cut are copied cut: the toolbar and the live region say how many.
    api.copyResults.mockResolvedValueOnce({ ok: true, value: { rows: 3, bytes: 10, truncatedCells: 1, partial: false, capped: 0 } })
    await service.copy('t1', keyAt(service, 't1', 0), false)
    flush()
    expect(tab().jobNotice).toBe('Copied 3 rows. 1 value was truncated.')
    const before = tab().announced
    timers.advance(300)
    expect(tab()).toMatchObject({ announcement: 'Copied 3 rows. 1 value was truncated.', announced: before + 1 })
  })
  it('runs one copy at a time, cancels it on Escape or a new run, and returns failures as sentences', async () => {
    const { api, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.setSelection('t1', keyAt(service, 't1', 0), selectAll(keyAt(service, 't1', 0)))
    const first = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(first.promise)
    const copying = service.copy('t1', keyAt(service, 't1', 0), false)
    expect(service.cancelTabJob('other')).toBe(false)
    expect(service.cancelTabJob('t1')).toBe(true)
    expect(api.cancelResultsJob).toHaveBeenLastCalledWith('job-1')
    // A new copy cancels the one running.
    api.copyResults.mockResolvedValueOnce({ ok: false, code: 'TOO_LARGE', error: 'The selection is too large to copy (70 MB; the limit is 64 MB). Use Save Results As instead.' })
    expect(await service.copy('t1', keyAt(service, 't1', 0), false)).toBe('The selection is too large to copy (70 MB; the limit is 64 MB). Use Save Results As instead.')
    expect(api.cancelResultsJob).toHaveBeenCalledTimes(2)
    first.resolve({ ok: false, code: 'CANCELLED', error: 'The operation was cancelled.' })
    expect(await copying).toBeUndefined()
    api.copyResults.mockResolvedValueOnce({ ok: false, code: 'RESULT_UNAVAILABLE', error: 'These results are no longer available.' })
    expect(await service.copy('t1', keyAt(service, 't1', 0), false)).toBe('Could not copy the results: These results are no longer available.')
    const hung = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(hung.promise)
    void service.copy('t1', keyAt(service, 't1', 0), false)
    service.begin('t1', 'q2')
    expect(api.cancelResultsJob).toHaveBeenLastCalledWith('job-4')
    hung.resolve({ ok: false, code: 'CANCELLED', error: 'The operation was cancelled.' })
  })
  it('refuses to copy results the backend lost or the user closed', async () => {
    const { api, client, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.setSelection('t1', keyAt(service, 't1', 0), selectAll(keyAt(service, 't1', 0)))
    client.lose()
    expect(await service.copy('t1', keyAt(service, 't1', 0), false)).toBe('These results are no longer available because the SQL backend restarted.')
    expect(api.copyResults).not.toHaveBeenCalled()
  })
  it('saves a set through main, shows its strip 300 ms after the file is chosen, and says how the save ended', async () => {
    const { api, service, tab, timers, flush, progress, events } = fixture()
    const saved: unknown[] = []
    events.subscribe(event => { if (event.type === 'results.saved') saved.push(event) })
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1), descriptor(2, { index: 1, rowsRead: 5, rowsStored: 5, rowsAvailable: 5 })]) })
    const pending = deferred<ApiResult<SavedResults | null>>()
    api.saveResults.mockReturnValueOnce(pending.promise)
    const saving = service.saveAs('t1', keyAt(service, 't1', 1), 'SQLQuery1')
    // The renderer names the result and suggests a name; main asks for the path and remembers the last format.
    expect(api.saveResults).toHaveBeenCalledWith({ jobId: 'job-1', generation: 1, resultId: 2, suggestedName: 'SQLQuery1-Result2' })
    flush()
    expect(tab().jobs).toEqual([expect.objectContaining({ jobId: 'job-1', kind: 'save', entry: keyAt(service, 't1', 1), label: 'Result 2', rowsDone: 0, rowsTotal: 5, visible: false })])
    // While the dialog is open there is no strip, however long it stays open, and Escape has nothing to cancel.
    timers.advance(5000)
    flush()
    expect(tab().jobs[0]).toMatchObject({ visible: false })
    expect(service.cancelTabJob('t1')).toBe(false)
    const report = (rowsDone: number, rowsTotal: number) => { for (const listener of progress) listener({ jobId: 'job-1', kind: 'save', rowsDone, rowsTotal, bytes: rowsDone * 10, fileName: 'out.csv' }) }
    report(0, 0)
    timers.advance(299)
    flush()
    expect(tab().jobs[0]).toMatchObject({ visible: false, fileName: 'out.csv', rowsTotal: 5 })
    timers.advance(1)
    report(3, 5)
    flush()
    expect(tab().jobs[0]).toMatchObject({ visible: true, rowsDone: 3, rowsTotal: 5 })
    pending.resolve({ ok: true, value: { rows: 5, bytes: 50, truncatedCells: 1, partial: false, capped: 0, fileName: 'out.csv', format: 'csv' } })
    expect(await saving).toBeUndefined()
    flush()
    expect(tab()).toMatchObject({ jobs: [], jobNotice: 'Saved 5 rows to out.csv. 1 value was truncated.' })
    // The workbench hears of it too, for a toast when the tab is not in view.
    expect(saved).toEqual([{ type: 'results.saved', tabId: 't1', text: 'Saved 5 rows to out.csv. 1 value was truncated.' }])
    timers.advance(300)
    expect(tab().announcement).toBe('Saved 5 rows to out.csv. 1 value was truncated.')
    timers.advance(8000)
    flush()
    expect(tab().jobNotice).toBe('')
    // A cancelled dialog says nothing; a cancelled save says the file was not written.
    api.saveResults.mockResolvedValueOnce({ ok: true, value: null })
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')).toBeUndefined()
    flush()
    expect(tab().jobNotice).toBe('')
    api.saveResults.mockResolvedValueOnce({ ok: false, code: 'CANCELLED', error: 'The operation was cancelled.' })
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')).toBeUndefined()
    flush()
    expect(tab().jobNotice).toBe('Saving was cancelled. The file was not written.')
    // A cancelled dialog or save is no news elsewhere.
    expect(saved).toHaveLength(1)
  })
  it('returns why a save could not run: main\'s and the backend\'s sentences as they are, anything else prefixed', async () => {
    const { api, client, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    for (const [code, error] of [['JOB_BUSY', 'Another Save Results As is in progress. Wait for it to finish or cancel it.'], ['EXPORT_FAILED', 'Could not save the results: access to out.csv is denied.'],
      ['RESULT_UNAVAILABLE', 'These results were closed before they could be saved.'], ['RESULT_OPEN', 'Save the results after this result set finishes loading.']] as const) {
      api.saveResults.mockResolvedValueOnce({ ok: false, code, error })
      expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'q'), code).toBe(error)
    }
    api.saveResults.mockResolvedValueOnce({ ok: false, code: 'BACKEND_LOST', error: 'The SQL backend stopped before answering.' })
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'q')).toBe('Could not save the results: The SQL backend stopped before answering.')
    // Sets still loading, lost or closed never reach main.
    api.saveResults.mockClear()
    service.begin('t1', 'q2')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(3, { state: 'open' }) })
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'q')).toBe('Save the results after this result set finishes loading.')
    service.finish('t1', 'q2', { summary: summaryOf([descriptor(3)]) })
    client.lose()
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'q')).toBe('These results are no longer available because the SQL backend restarted.')
    expect(await service.saveAs('t1', noEntry, 'q')).toBeUndefined()
    expect(api.saveResults).not.toHaveBeenCalled()
  })
  it('keeps a save running when the tab runs again or closes, and cancels it from its strip, Escape, or disposal', async () => {
    const { api, service, tab, flush, progress } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    const pending = deferred<ApiResult<SavedResults | null>>()
    api.saveResults.mockReturnValueOnce(pending.promise)
    const saving = service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')
    for (const listener of progress) listener({ jobId: 'job-1', kind: 'save', rowsDone: 0, rowsTotal: 0, bytes: 0, fileName: 'out.csv' })
    // The backend leases the result, so running the query again neither cancels the save nor hides its strip.
    service.begin('t1', 'q2')
    flush()
    expect(api.cancelResultsJob).not.toHaveBeenCalled()
    expect(tab().jobs).toEqual([expect.objectContaining({ jobId: 'job-1', kind: 'save', fileName: 'out.csv' })])
    expect(service.cancelTabJob('t2')).toBe(false)
    expect(service.cancelTabJob('t1')).toBe(true)
    expect(api.cancelResultsJob).toHaveBeenLastCalledWith('job-1')
    service.cancelJob('job-1')
    expect(api.cancelResultsJob).toHaveBeenCalledTimes(2)
    service.release('t1')
    expect(api.cancelResultsJob).toHaveBeenCalledTimes(2)
    pending.resolve({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0, fileName: 'out.csv', format: 'csv' } })
    expect(await saving).toBeUndefined()
    // Disposal (the window reloading) cancels a save still running.
    service.begin('t1', 'q3')
    service.finish('t1', 'q3', { summary: summaryOf([descriptor(4)]) })
    api.saveResults.mockReturnValueOnce(new Promise(() => {}))
    void service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')
    service.dispose()
    expect(api.cancelResultsJob).toHaveBeenLastCalledWith('job-2')
  })
  it('publishes which tabs have results to save or close, only when that changes', () => {
    const { client, service, flush } = fixture()
    const seen: Readonly<Record<string, true>>[] = []
    service.context.subscribe(() => seen.push(service.context.getSnapshot()))
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open' }) })
    flush()
    client.emit('q1', { type: 'progress', completedBatches: 0, totalBatches: 1, batchNumber: 1, iteration: 1, results: [{ resultId: 1, rowsRead: 9, rowsStored: 9, rowsAvailable: 9, bytesStored: 1 }] })
    flush()
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.begin('t2', 'q2')
    service.finish('t2', 'q2', { summary: summaryOf([]) })
    expect(seen).toEqual([{ t1: true }])
    service.closeResults('t1')
    expect(seen.at(-1)).toEqual({})
    service.begin('t1', 'q3')
    service.finish('t1', 'q3', { summary: summaryOf([descriptor(2)]) })
    expect(seen.at(-1)).toEqual({ t1: true })
    service.release('t1')
    expect(seen.at(-1)).toEqual({})
    service.begin('t3', 'q4')
    client.emit('q4', { type: 'resultSet.opened', descriptor: descriptor(3, { state: 'open' }) })
    service.finish('t3', 'q4', { error: 'The SQL backend stopped.', code: 'BACKEND_LOST' })
    expect(seen.at(-1)).toEqual({})
    expect(seen).toHaveLength(4)
    // A completed run keeps its status when the backend restarts afterwards, but nothing is left to save or close.
    service.begin('t4', 'q5')
    service.finish('t4', 'q5', { summary: summaryOf([descriptor(5)]) })
    expect(seen.at(-1)).toEqual({ t4: true })
    client.lose()
    expect(seen.at(-1)).toEqual({})
    expect(service.getSnapshot().t4.status).toBe('completed')
  })
  it('closes a run of a thousand sets with one request', () => {
    const { client, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf(Array.from({ length: 1000 }, (_, index) => descriptor(index + 1, { index }))) })
    service.begin('t1', 'q2')
    expect(client.release).toHaveBeenCalledOnce()
    expect(client.released()).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1))
  })
  it('keeps the error that stopped a run in Messages, even when the backend could not', () => {
    const { service, tab } = fixture()
    const flood = Array.from({ length: 1001 }, (_, index) => ({ text: String(index), kind: 'info' as const }))
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([], { status: 'failed', messages: flood, messagesTruncated: true, error: { code: 'SQL_ERROR', message: 'Msg 8134, Level 16, State 1, Line 3\nDivide by zero error encountered.', batchNumber: 1, iteration: 1 } }) })
    expect(tab().messages.at(-1)).toEqual({ text: 'Msg 8134, Level 16, State 1, Line 3\nDivide by zero error encountered.', kind: 'error' })
    // The summary's own error entries and the notes after the cap are kept as they are.
    const kept = [...flood, { text: 'Msg 8134, Level 16, State 1, Line 3\nDivide by zero error encountered.', kind: 'error' as const }, ...Array.from({ length: 7 }, (_, index) => ({ text: `note ${index}`, kind: 'info' as const }))]
    service.begin('t1', 'q2')
    service.finish('t1', 'q2', { summary: summaryOf([], { status: 'failed', messages: kept, messagesTruncated: true, error: { code: 'SQL_ERROR', message: 'x', batchNumber: 1, iteration: 1 } }) })
    expect(tab().messages).toEqual(kept)
  })
  it('routes Select All to the mounted grid, else to the view state', () => {
    const { service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    service.selectAll('t1', keyAt(service, 't1', 0))
    expect(service.selection('t1', keyAt(service, 't1', 0))).toEqual(selectAll(keyAt(service, 't1', 0)))
    const controller = { selectAll: vi.fn(), repaint: vi.fn(), fitColumn: vi.fn() }
    const registration = service.registerGrid('t1', keyAt(service, 't1', 0), controller)
    service.selectAll('t1', keyAt(service, 't1', 0))
    expect(controller.selectAll).toHaveBeenCalledOnce()
    service.clearSelections('t1')
    expect(controller.repaint).toHaveBeenCalled()
    expect(service.selection('t1', keyAt(service, 't1', 0))).toBeUndefined()
    registration.dispose()
    service.selectAll('t1', keyAt(service, 't1', 0))
    expect(controller.selectAll).toHaveBeenCalledOnce()
  })
  it('fits only a readable column in its own mounted grid, including a header with no rows', () => {
    const { service, client } = fixture()
    const controller = { selectAll: vi.fn(), repaint: vi.fn(), fitColumn: vi.fn() }
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { rowsAvailable: 0, rowsStored: 0, rowsRead: 0 })]) })
    expect(service.canFitColumn('t1', keyAt(service, 't1', 0), 0)).toBe(false)
    const registration = service.registerGrid('t1', keyAt(service, 't1', 0), controller)
    expect(service.canFitColumn('t1', keyAt(service, 't1', 0), 0)).toBe(true)
    service.fitColumn('t1', keyAt(service, 't1', 0), 1)
    expect(controller.fitColumn.mock.calls).toEqual([[1]])
    for (const column of [-1, 2, 0.5, NaN]) {
      expect(service.canFitColumn('t1', keyAt(service, 't1', 0), column)).toBe(false)
      service.fitColumn('t1', keyAt(service, 't1', 0), column)
    }
    service.fitColumn('other', keyAt(service, 't1', 0), 0)
    service.fitColumn('t1', noEntry, 0)
    expect(controller.fitColumn).toHaveBeenCalledOnce()
    registration.dispose()
    expect(service.canFitColumn('t1', keyAt(service, 't1', 0), 0)).toBe(false)
    service.registerGrid('t1', keyAt(service, 't1', 0), controller)
    client.lose()
    service.fitColumn('t1', keyAt(service, 't1', 0), 0)
    expect(service.canFitColumn('t1', keyAt(service, 't1', 0), 0)).toBe(false)
    expect(controller.fitColumn).toHaveBeenCalledOnce()
  })
  it('opens XML, JSON and plan values as documents named as SSMS names them, formatted by the worker', async () => {
    const { client, service, documents } = fixture()
    const column = (name: string, role?: ResultColumn['role']): ResultColumn => ({ name, dataType: 'nvarchar', wire: 'text', nullable: true, ...role ? { role } : {} })
    const columns = [column('XML_F52E2B61-18A1-11d1-B105-00805F49916B', 'xml'), column('data', 'json'), column('Microsoft SQL Server 2005 XML Showplan', 'plan'), column('a:b/c*', 'xml'), column(' ', 'xml'), column('Id')]
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { columns })]) })
    const handle = client.handle(1)!
    const value = (patch: Partial<Awaited<ReturnType<typeof handle.getCell>>> = {}) => ({ text: '<a />', isNull: false, truncated: false, error: false, formatted: true, ...patch })
    handle.getCell.mockResolvedValue(value())
    const open = async (row: number, column: number) => { const outcome = await service.openValue('t1', keyAt(service, 't1', 0), row, column); return [outcome, documents.openText.mock.lastCall?.[0].name] }
    expect(await open(0, 0)).toEqual([{ opened: true }, 'XML_F52E2B61-18A1-11d1-B105-00805F49916B1.xml'])
    expect(await open(1, 0)).toEqual([{ opened: true }, 'XML_F52E2B61-18A1-11d1-B105-00805F49916B2.xml'])
    expect(await open(0, 1)).toEqual([{ opened: true }, 'data1.json'])
    expect(await open(0, 2)).toEqual([{ opened: true }, 'ExecutionPlan1.sqlplan'])
    expect(await open(0, 3)).toEqual([{ opened: true }, 'a_b_c_1.xml'])
    expect(await open(0, 4)).toEqual([{ opened: true }, 'XML1.xml'])
    expect(handle.getCell.mock.calls.map(([row, col, o]) => [row, col, o?.format])).toEqual([[0, 0, 'xml'], [1, 0, 'xml'], [0, 1, 'json'], [0, 2, 'xml'], [0, 3, 'xml'], [0, 4, 'xml']])
    expect(documents.openText.mock.calls.map(([o]) => o.kind)).toEqual(['xml', 'xml', 'json', 'sqlplan', 'xml', 'xml'])
    expect(documents.openText.mock.calls[0][0].text).toBe('<a />')
    // Not a value column, a NULL, or a read error: nothing opens.
    const calls = documents.openText.mock.calls.length
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 5)).toEqual({ opened: false })
    handle.getCell.mockResolvedValueOnce(value({ text: '', isNull: true }))
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 0)).toEqual({ opened: false })
    handle.getCell.mockResolvedValueOnce(value({ text: '', isNull: true, error: true }))
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 0)).toEqual({ opened: false })
    expect(documents.openText.mock.calls.length).toBe(calls)
    // A value stored as a prefix opens unformatted, and says so; a failed read says why.
    handle.getCell.mockResolvedValueOnce(value({ truncated: true, formatted: false }))
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 2)).toEqual({ opened: true, message: 'This execution plan value was truncated at 2,097,152 characters, so it opened unformatted.' })
    handle.getCell.mockResolvedValueOnce(value({ truncated: true, formatted: false }))
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 1)).toEqual({ opened: true, message: 'This JSON value was truncated at 2,097,152 characters, so it opened unformatted.' })
    handle.getCell.mockRejectedValueOnce(new Error('The results worker stopped. Try again.'))
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 0)).toEqual({ opened: false, message: 'Could not open the value: The results worker stopped. Try again.' })
    client.lose()
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 0)).toEqual({ opened: false, message: 'These results are no longer available because the SQL backend restarted.' })
    expect(await service.openValue('t9', noEntry, 0, 0)).toEqual({ opened: false })
  })
  it('opens a value once while it is opening, and names its tab without bidirectional controls', async () => {
    const { client, service, documents } = fixture()
    const columns: ResultColumn[] = [{ name: 'report\u202egpj.', dataType: 'xml', wire: 'text', nullable: true, role: 'xml' }]
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { columns })]) })
    const handle = client.handle(1)!
    const read = deferred<Awaited<ReturnType<typeof handle.getCell>>>()
    handle.getCell.mockReturnValueOnce(read.promise)
    // A double-click: the second press lands while the first one's value is still being read.
    const first = service.openValue('t1', keyAt(service, 't1', 0), 0, 0), second = service.openValue('t1', keyAt(service, 't1', 0), 0, 0)
    expect(await second).toEqual({ opened: false })
    read.resolve({ text: '<a />', isNull: false, truncated: false, error: false, formatted: true })
    expect(await first).toEqual({ opened: true })
    expect(documents.openText.mock.calls.map(([o]) => o.name)).toEqual(['report_gpj.1.xml'])
    // Once it has opened, another click opens it again, as SSMS does.
    handle.getCell.mockResolvedValueOnce({ text: '<a />', isNull: false, truncated: false, error: false, formatted: true })
    expect(await service.openValue('t1', keyAt(service, 't1', 0), 0, 0)).toEqual({ opened: true })
    expect(handle.getCell).toHaveBeenCalledTimes(2)
  })
  it('suggests a save name main accepts, however long the tab\'s name', () => {
    const name = 'n'.repeat(200)
    expect(suggestedName(name, 3)).toBe('n'.repeat(120) + '-Result3')
    expect(suggestedName(name, 3)).toHaveLength(128)
    expect(suggestedName('SQLQuery1', 1)).toBe('SQLQuery1-Result1')
    // Never cut between the halves of a surrogate pair.
    const astral = 'a'.repeat(119) + '😀'.repeat(10)
    expect(suggestedName(astral, 3)).toBe('a'.repeat(119) + '-Result3')
  })
  it('passes the shortened name to main for a long tab name', async () => {
    const { api, service } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    await service.saveAs('t1', keyAt(service, 't1', 0), 'x'.repeat(200))
    expect(api.saveResults.mock.lastCall?.[0].suggestedName).toHaveLength(128)
  })
  it('reads out a selection only when its size changes, and every copy\'s outcome', () => {
    const { service, timers, tab } = fixture()
    service.begin('t1', 'q1')
    const heard: string[] = []
    const settle = () => { timers.advance(300); heard.push(tab().announcement.replace('\u200b', '')) }
    service.announceSelection('t1', '1 row, 1 column selected')
    settle()
    // Arrow keys move the active cell, which screen readers read themselves: the same size says nothing.
    service.announceSelection('t1', '1 row, 1 column selected')
    expect(timers.pending.size).toBe(0)
    service.announceSelection('t1', '2 rows, 1 column selected')
    settle()
    service.announce('t1', 'Copied 2 rows.')
    settle()
    service.announce('t1', 'Copied 2 rows.')
    timers.advance(300)
    expect(tab().announcement).toBe('Copied 2 rows.\u200b')
    expect(heard).toEqual(['1 row, 1 column selected', '2 rows, 1 column selected', 'Copied 2 rows.'])
    // A new run starts afresh.
    service.begin('t1', 'q2')
    service.announceSelection('t1', '2 rows, 1 column selected')
    expect(timers.pending.size).toBe(1)
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

describe('results service entry keys', () => {
  it('opens a captured plan\'s value by the plan set\'s key, which names no result of the stack, and a result\'s by its own', async () => {
    const { service, client, documents, tab } = fixture()
    const plan = { name: 'Plan', dataType: 'xml', wire: 'text', nullable: true, role: 'plan' } as ResultColumn
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { columns: [plan] })], { planSets: [descriptor(7, { index: 0, columns: [plan] }), descriptor(8, { index: 1, columns: [plan] })] }) })
    const [first, second] = tab().planSets, [result] = tab().sets
    // The first plan set and the first result stand at the same place of their lists and have keys of their own.
    expect(new Set([first.key, second.key, result.key]).size).toBe(3)
    for (const id of [1, 7, 8]) client.handle(id)!.getCell.mockResolvedValue({ text: '<ShowPlanXML/>', isNull: false, truncated: false, error: false, formatted: true })
    expect(await service.openValue('t1', second.key, 0, 0, true)).toEqual({ opened: true })
    expect(client.handle(8)!.getCell).toHaveBeenCalledOnce()
    expect(client.handle(7)!.getCell).not.toHaveBeenCalled()
    // A plan set's key opens nothing as a result's, and a result's nothing as a plan set's.
    expect(await service.openValue('t1', second.key, 0, 0)).toEqual({ opened: false })
    expect(await service.openValue('t1', result.key, 0, 0, true)).toEqual({ opened: false })
    expect(await service.openValue('t1', result.key, 0, 0)).toEqual({ opened: true })
    expect(client.handle(1)!.getCell).toHaveBeenCalledOnce()
    expect(documents.openText).toHaveBeenCalledTimes(2)
  })
  it('keeps a grid\'s state only for an entry the run has', () => {
    const { service, tab } = fixture()
    service.begin('t1', 'q1')
    service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    const key = tab().sets[0].key
    expect(service.gridState('t1', key)).toBe(service.gridState('t1', key))
    // A key that names no entry gets a state to draw with, and nothing is kept for it.
    service.gridState('t1', noEntry).scrollLeft = 9
    expect(service.gridState('t1', noEntry).scrollLeft).toBe(0)
    expect([...service.viewState('t1').grids.keys()]).toEqual([key])
  })
  /** Results 1 to 3 and a pivot of Result 3 appended after them. */
  const four = () => {
    const f = fixture()
    f.service.begin('t1', 'q1')
    f.service.finish('t1', 'q1', { summary: summaryOf([descriptor(1), descriptor(2, { index: 1 }), descriptor(3, { index: 2 })]) })
    const added = f.service.addSet('t1', descriptor(803, { index: 2, kind: 'pivot' }), 'Pivot of Result 3', ['1:3'])
    f.flush()
    // What it added is the run's last entry, named by the key it returns.
    expect(added).toBe(f.tab().sets[3].key)
    return { ...f, keys: f.tab().sets.map(set => set.key) }
  }
  it('mints a key for each entry, numbers an original result by its ordinal and a derived one by the place it was appended at', () => {
    const { service, tab, keys } = four()
    expect(new Set(keys).size).toBe(4)
    expect(tab().sets.map(set => [set.ordinal, set.number, set.label])).toEqual([[1, 1, undefined], [2, 2, undefined], [3, 3, undefined], [undefined, 4, 'Pivot of Result 3']])
    // An entry says nothing of its place: the key is all that names it.
    expect(tab().sets[0]).not.toHaveProperty('index')
    // A key is not the stored result's: another run's entries have other keys, though its results may have the same ids.
    service.begin('t1', 'q2')
    service.finish('t1', 'q2', { summary: summaryOf([descriptor(1)]) })
    expect(keys).not.toContain(tab().sets[0].key)
    // Nothing takes a place for a key: the first run's keys name no entry of this one.
    expect(service.sortOf('t1', keys[0])).toBeUndefined()
    expect(service.canFitColumn('t1', keys[0], 0)).toBe(false)
    expect(service.focusedEntry('t1')).toBe(tab().sets[0])
  })
  it('leaves every other entry its sort, views, grid state, selection, grid, job and names when a middle entry goes', async () => {
    const { service, client, api, tab, flush, keys } = four()
    const third = client.handle(3)!, building = deferred<ResultView>(), copying = deferred<ApiResult<ResultsJobResult>>()
    third.sort.mockReturnValueOnce(building.promise)
    service.sortBy('t1', keys[2], 0, 'descending')
    service.gridState('t1', keys[2]).scrollLeft = 30
    service.gridState('t1', keys[3]).scrollLeft = 70
    service.setSelection('t1', keys[2], selectAll(keys[2]))
    const controller = { selectAll: vi.fn(), repaint: vi.fn(), fitColumn: vi.fn() }
    service.registerGrid('t1', keys[2], controller)
    // The stack's own state is the entries' too: a splitter's shares, what is collapsed, the grid that had the focus.
    const view = service.viewState('t1')
    view.weights = new Map(keys.map((key, place) => [key, (place + 1) * 100]))
    view.collapsed = new Set([keys[1], keys[3]])
    view.focused = keys[2]
    expect(service.focusedEntry('t1')?.key).toBe(keys[2])
    api.copyResults.mockReturnValueOnce(copying.promise)
    const copied = service.copy('t1', keys[2], false)
    flush()
    expect(tab().jobs).toMatchObject([{ kind: 'copy', entry: keys[2], label: 'Result 3' }])
    expect(tab().sorts.get(keys[2])).toMatchObject({ sorting: true })

    expect(service.removeEntry('t1', keys[1])).toBe(true)
    expect(service.removeEntry('t1', keys[1])).toBe(false)
    // The entries after it move up a place and keep their keys, numbers and names; only its result is released.
    expect(tab().sets.map(set => [set.key, set.descriptor.resultId, set.number, set.label])).toEqual([[keys[0], 1, 1, undefined], [keys[2], 3, 3, undefined], [keys[3], 803, 4, 'Pivot of Result 3']])
    expect(client.released()).toEqual([2])
    expect(client.handle(2)!.dispose).toHaveBeenCalledOnce()
    expect(tab().settled.has('1:2')).toBe(false)
    // Result 3's state is still Result 3's, and the pivot that now stands where Result 3 stood has only its own.
    expect(service.gridState('t1', keys[2]).scrollLeft).toBe(30)
    expect(service.gridState('t1', keys[3]).scrollLeft).toBe(70)
    expect(service.selection('t1', keys[2])).toEqual(selectAll(keys[2]))
    expect(service.selection('t1', keys[3])).toBeUndefined()
    expect(service.viewState('t1').grids.has(keys[1])).toBe(false)
    expect(tab().jobs).toMatchObject([{ kind: 'copy', entry: keys[2], label: 'Result 3' }])
    expect(tab().jobs[0]).not.toHaveProperty('index')
    expect([...tab().sorts.keys()]).toEqual([keys[2]])
    expect(tab().sorts.get(keys[2])).toMatchObject({ sorting: true })
    service.fitColumn('t1', keys[2], 0)
    expect(controller.fitColumn).toHaveBeenCalledWith(0)
    expect(service.canFitColumn('t1', keys[3], 0)).toBe(false)
    // The removed entry's share, its collapse and nothing else left the stack; the focus stayed on Result 3.
    expect([...view.weights!]).toEqual([[keys[0], 100], [keys[2], 300], [keys[3], 400]])
    expect([...view.collapsed]).toEqual([keys[3]])
    expect(service.focusedEntry('t1')?.key).toBe(keys[2])

    // A view asked for before the entry moved comes back to that entry, not to the place it had.
    const sorted = fakeView(third, 9, [{ column: 0, descending: true, mode: 'value' }])
    building.resolve(sorted)
    await settle()
    flush()
    expect(tab().sorts.get(keys[2])).toMatchObject({ sorting: false, view: sorted })
    expect(service.sortOf('t1', keys[2])).toBe(tab().sorts.get(keys[2]))
    expect(service.sortOf('t1', keys[3])).toBeUndefined()
    service.viewShown('t1', keys[2], sorted)
    copying.resolve({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0 } })
    await copied
    // Names follow the entry: Result 3 and the pivot save under the numbers they had.
    await service.saveAs('t1', keys[2], 'SQLQuery1')
    await service.saveAs('t1', keys[3], 'SQLQuery1')
    expect(api.saveResults.mock.calls.map(([request]) => [request.resultId, request.suggestedName, request.viewId])).toEqual([[3, 'SQLQuery1-Result3', 9], [803, 'SQLQuery1-Result4', undefined]])
    // A result made afterwards takes the next number, not the pivot's, and has no share of the stack yet.
    const added = service.addSet('t1', descriptor(801, { index: 0, kind: 'pivot' }), 'Pivot of Result 1', ['1:1'])
    flush()
    expect(tab().sets.map(set => set.number)).toEqual([1, 3, 4, 5])
    expect(tab().sets[3].key).toBe(added)
    expect(view.weights!.has(added!)).toBe(false)
    // The entry that had the focus going leaves the first to take it.
    service.removeEntry('t1', keys[2])
    expect(service.focusedEntry('t1')?.key).toBe(keys[0])
  })
  it('moves an entry\'s state with it when a set arrives before it in a streaming run', async () => {
    const { service, client, tab, flush } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1) })
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(3, { index: 2 }) })
    flush()
    const third = client.handle(3)!, key = tab().sets[1].key, building = deferred<ResultView>()
    expect(tab().sets.map(set => set.number)).toEqual([1, 3])
    third.sort.mockReturnValueOnce(building.promise)
    service.sortBy('t1', key, 0, 'ascending')
    service.gridState('t1', key).scrollLeft = 30
    service.setSelection('t1', key, selectAll(key))
    const controller = { selectAll: vi.fn(), repaint: vi.fn(), fitColumn: vi.fn() }
    service.registerGrid('t1', key, controller)
    // The second set's event comes late: it takes the second place and a state of its own.
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(2, { index: 1 }) })
    flush()
    expect(tab().sets.map(set => [set.number, set.descriptor.resultId])).toEqual([[1, 1], [2, 2], [3, 3]])
    expect(tab().sets[2].key).toBe(key)
    const late = tab().sets[1].key
    expect(service.gridState('t1', late).scrollLeft).toBe(0)
    expect(service.gridState('t1', key).scrollLeft).toBe(30)
    expect(service.selection('t1', late)).toBeUndefined()
    expect(service.selection('t1', key)).toEqual(selectAll(key))
    expect(tab().sorts.has(late)).toBe(false)
    expect(tab().sorts.get(key)).toMatchObject({ sorting: true })
    expect(service.canFitColumn('t1', late, 0)).toBe(false)
    service.fitColumn('t1', key, 0)
    expect(controller.fitColumn).toHaveBeenCalledWith(0)
    const view = fakeView(third, 5, [{ column: 0, descending: false, mode: 'value' }])
    building.resolve(view)
    await settle()
    flush()
    expect(tab().sorts.get(key)).toMatchObject({ sorting: false, view })
    expect(tab().sorts.has(late)).toBe(false)
  })
  it('publishes the same map of sorts until a sort changes, and closes a moved entry\'s old view once its grid shows the new one', async () => {
    const { service, client, tab, flush, keys } = four()
    const third = client.handle(3)!
    const first = fakeView(third, 1, [{ column: 0, descending: false, mode: 'value' }]), second = fakeView(third, 2, [{ column: 0, descending: true, mode: 'value' }])
    third.sort.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    service.sortBy('t1', keys[2], 0, 'ascending')
    await settle()
    flush()
    service.viewShown('t1', keys[2], first)
    const sorts = tab().sorts
    expect(sorts.get(keys[2])).toMatchObject({ view: first })
    // A change that is not a sort publishes the map it had.
    service.setStrip('t1', true)
    expect(tab().sorts).toBe(sorts)
    service.removeEntry('t1', keys[1])
    expect(tab().sorts.get(keys[2])).toMatchObject({ view: first })
    // The held views are the entry's: sorted again at its new place, the old view closes once the grid shows the new one.
    service.sortBy('t1', keys[2], 0, 'descending')
    await settle()
    flush()
    expect(first.close).not.toHaveBeenCalled()
    service.viewShown('t1', keys[2], second)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
  })
  it('gives up the removed entry\'s own work, and removes nothing from a run still running or already closed', async () => {
    const { service, client, api, tab, flush, keys } = four()
    const second = client.handle(2)!, building = deferred<ResultView>(), copying = deferred<ApiResult<ResultsJobResult>>()
    second.sort.mockReturnValueOnce(building.promise)
    service.sortBy('t1', keyAt(service, 't1', 1), 0, 'ascending')
    service.setSelection('t1', keyAt(service, 't1', 1), selectAll(keyAt(service, 't1', 1)))
    api.copyResults.mockReturnValueOnce(copying.promise)
    const copied = service.copy('t1', keyAt(service, 't1', 1), false)
    expect(service.removeEntry('t1', keys[1])).toBe(true)
    expect(api.cancelResultsJob).toHaveBeenCalledWith('job-1')
    // Its sort's late view is closed and shows nowhere: not at its old place, where Result 3 stands now.
    const late = fakeView(second, 4, [{ column: 0, descending: false, mode: 'value' }])
    building.resolve(late)
    await settle()
    flush()
    expect(late.close).toHaveBeenCalledOnce()
    expect(tab().sorts.size).toBe(0)
    expect(service.viewState('t1').grids.has(keys[1])).toBe(false)
    copying.resolve({ ok: false, error: 'Cancelled', code: 'CANCELLED' })
    await copied

    service.closeResults('t1')
    expect(service.removeEntry('t1', keys[0])).toBe(false)
    service.begin('t1', 'q2')
    client.emit('q2', { type: 'resultSet.opened', descriptor: descriptor(5, { index: 0, state: 'open' }) })
    flush()
    expect(service.removeEntry('t1', tab().sets[0].key)).toBe(false)
    expect(tab().sets).toHaveLength(1)
  })
})

type FakeView = ResultView & { close: ReturnType<typeof vi.fn<() => Promise<void>>>; getCell: FakeHandle['getCell'] }
/** A view of `base` as ResultClient builds one. */
function fakeView(base: FakeHandle, viewId: number, keys: readonly ViewSortKey[], complete = true, filters: ResultView['filters'] = []): FakeView {
  return {
    ...base, viewId, base, keys, filters, rows: 2, baseRows: 2, complete, approximate: false,
    close: vi.fn(async () => {}),
    getCell: vi.fn<ResultHandle['getCell']>(async () => ({ text: '<a/>', isNull: false, truncated: false, error: false, formatted: true }))
  }
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('results service sorting', () => {
  const sorted = () => {
    const f = fixture()
    f.service.begin('t1', 'q1')
    f.service.finish('t1', 'q1', { summary: summaryOf([descriptor(1)]) })
    return { ...f, handle: f.client.handle(1)! }
  }
  it('sorts a grid by a column, keeps showing its rows while the view is built, and closes a view once the grid shows another', async () => {
    const { service, handle, flush, tab } = sorted()
    const first = deferred<ResultView>()
    handle.sort.mockReturnValueOnce(first.promise)
    service.sortBy('t1', keyAt(service, 't1', 0), 1, 'descending')
    expect(handle.sort).toHaveBeenLastCalledWith([{ column: 1, descending: true, mode: 'value' }], { signal: expect.any(AbortSignal) })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toEqual({ keys: [{ column: 1, descending: true, mode: 'value' }], filters: [], applied: [], sorting: true, approximate: false, stale: false })
    const view = fakeView(handle, 1, [{ column: 1, descending: true, mode: 'value' }])
    first.resolve(view)
    await settle()
    flush()
    expect(tab().sorts.get(keyAt(service, 't1', 0))).toEqual({ keys: [{ column: 1, descending: true, mode: 'value' }], filters: [], applied: [], view, sorting: false, approximate: false, stale: false })
    // A second column added after the first: the new view replaces the old one, which the grid shows meanwhile.
    const second = fakeView(handle, 2, [])
    handle.sort.mockResolvedValueOnce(second)
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending', true)
    expect(handle.sort).toHaveBeenLastCalledWith([{ column: 1, descending: true, mode: 'value' }, { column: 0, descending: false, mode: 'value' }], { signal: expect.any(AbortSignal) })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toMatchObject({ view, sorting: true })
    service.viewShown('t1', keyAt(service, 't1', 0), view)
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toMatchObject({ view: second, sorting: false })
    // The grid still paints the first view until it has read the second one's rows and swapped.
    expect(view.close).not.toHaveBeenCalled()
    service.viewShown('t1', keyAt(service, 't1', 0), second)
    expect(view.close).toHaveBeenCalledTimes(1)
    // Clear Sort shows the rows in the order SQL Server sent them; the view closes once the grid shows them.
    service.clearSort('t1', keyAt(service, 't1', 0))
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toBeUndefined()
    expect(second.close).not.toHaveBeenCalled()
    service.viewShown('t1', keyAt(service, 't1', 0), undefined)
    expect(second.close).toHaveBeenCalledTimes(1)
    // A view the grid never showed (its tab hidden) closes as soon as a newer one replaces it.
    const hidden = fakeView(handle, 3, []), newer = fakeView(handle, 4, [])
    handle.sort.mockResolvedValueOnce(hidden).mockResolvedValueOnce(newer)
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending')
    await settle()
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'descending')
    await settle()
    expect([hidden.close.mock.calls.length, newer.close.mock.calls.length]).toEqual([1, 0])
    service.clearSort('t1', keyAt(service, 't1', 0))
    // Out-of-range columns and grids sort nothing.
    service.sortBy('t1', keyAt(service, 't1', 0), 2, 'ascending')
    service.sortBy('t1', noEntry, 0, 'ascending')
    expect(handle.sort).toHaveBeenCalledTimes(4)
  })
  it('cycles a header from ascending to descending to unsorted, and changes an added key in place', async () => {
    const { service, handle } = sorted()
    handle.sort.mockImplementation(async keys => fakeView(handle, 1, keys))
    const keys = async () => { await settle(); return service.sortOf('t1', keyAt(service, 't1', 0))?.keys.map(key => `${key.column}${key.descending ? 'd' : 'a'}`) }
    service.cycleSort('t1', keyAt(service, 't1', 0), 0)
    expect(await keys()).toEqual(['0a'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 1, true)
    expect(await keys()).toEqual(['0a', '1a'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 0, true)
    expect(await keys()).toEqual(['0d', '1a'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 0, true)
    expect(await keys()).toEqual(['1a'])
    // A plain click on a key among several starts a new sort by it, ascending, whatever its direction was.
    service.cycleSort('t1', keyAt(service, 't1', 0), 0, true)
    service.cycleSort('t1', keyAt(service, 't1', 0), 0, true)
    expect(await keys()).toEqual(['1a', '0d'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 0)
    expect(await keys()).toEqual(['0a'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 1, true)
    service.cycleSort('t1', keyAt(service, 't1', 0), 1)
    expect(await keys()).toEqual(['1a'])
    // Without the modifier the column becomes the only key.
    service.cycleSort('t1', keyAt(service, 't1', 0), 0)
    expect(await keys()).toEqual(['0a'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 0)
    expect(await keys()).toEqual(['0d'])
    service.cycleSort('t1', keyAt(service, 't1', 0), 0)
    expect(await keys()).toBeUndefined()
  })
  it('keeps the last view and says why when a sort fails, and closes a view a newer sort overtook', async () => {
    const { service, handle, flush, tab } = sorted()
    const view = fakeView(handle, 1, [{ column: 0, descending: false, mode: 'value' }])
    handle.sort.mockResolvedValueOnce(view)
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending')
    await settle()
    handle.sort.mockRejectedValueOnce(new Error('The results use more memory than the result budget allows.'))
    service.sortBy('t1', keyAt(service, 't1', 0), 1, 'ascending')
    await settle()
    flush()
    expect(tab().sorts.get(keyAt(service, 't1', 0))).toEqual({ keys: view.keys, filters: [], applied: [], view, sorting: false, approximate: false, stale: false })
    expect(tab().jobNotice).toBe('Could not sort the results: The results use more memory than the result budget allows.')
    // A sort overtaken by a newer one: its view is closed as soon as it arrives, and only the newer one shows.
    const slow = deferred<ResultView>(), late = fakeView(handle, 2, []), newest = fakeView(handle, 3, [])
    handle.sort.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(newest)
    service.sortBy('t1', keyAt(service, 't1', 0), 1, 'descending')
    const signal = handle.sort.mock.lastCall![1]!.signal!
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'descending')
    expect(signal.aborted).toBe(true)
    await settle()
    slow.resolve(late)
    await settle()
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.view).toBe(newest)
  })
  it('sorts a view again once its set has every row, and sorts text-sorted grids again when the text mode changes', async () => {
    let mode: ViewSortMode = 'value'
    const changes = new Set<() => void>()
    const { service, client, flush } = fixture({ sortText: () => mode, onSortTextChange: listener => { changes.add(listener); return () => changes.delete(listener) } })
    const change = (next: ViewSortMode) => { mode = next; for (const listener of changes) listener() }
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open', rowsAvailable: 1 }) })
    flush()
    const handle = client.handle(1)!
    const partial = fakeView(handle, 1, [], false)
    handle.sort.mockResolvedValueOnce(partial)
    service.sortBy('t1', keyAt(service, 't1', 0), 1, 'ascending')
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toMatchObject({ view: partial, stale: true })
    const whole = fakeView(handle, 2, [])
    handle.sort.mockResolvedValueOnce(whole)
    client.emit('q1', { type: 'resultSet.closed', descriptor: descriptor(1) })
    expect(handle.sort).toHaveBeenLastCalledWith([{ column: 1, descending: false, mode: 'value' }], { signal: expect.any(AbortSignal) })
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toMatchObject({ view: whole, stale: false })
    // Settings that change something else sort nothing again; Sort text by sorts the text column's grid again.
    handle.sort.mockResolvedValueOnce(fakeView(handle, 3, []))
    change('value')
    expect(handle.sort).toHaveBeenCalledTimes(2)
    change('chars')
    expect(handle.sort).toHaveBeenLastCalledWith([{ column: 1, descending: false, mode: 'chars' }], { signal: expect.any(AbortSignal) })
    await settle()
    // A grid sorted only by an int column keeps its order: the mode cannot change it.
    handle.sort.mockResolvedValueOnce(fakeView(handle, 4, []))
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending')
    await settle()
    const sorts = handle.sort.mock.calls.length
    change('bytes')
    expect(handle.sort).toHaveBeenCalledTimes(sorts)
    service.dispose()
    expect(changes.size).toBe(0)
  })
  it('sorts again when the set finishes while its sort runs', async () => {
    const { service, client, flush } = fixture()
    service.begin('t1', 'q1')
    client.emit('q1', { type: 'resultSet.opened', descriptor: descriptor(1, { state: 'open', rowsAvailable: 1 }) })
    flush()
    const handle = client.handle(1)!
    const pending = deferred<ResultView>()
    handle.sort.mockReturnValueOnce(pending.promise)
    service.sortBy('t1', keyAt(service, 't1', 0), 1, 'ascending')
    // The set completes before the backend answers, with the rows sealed when the sort began.
    client.emit('q1', { type: 'resultSet.closed', descriptor: descriptor(1) })
    expect(handle.sort).toHaveBeenCalledTimes(1)
    const whole = fakeView(handle, 2, [])
    handle.sort.mockResolvedValueOnce(whole)
    pending.resolve(fakeView(handle, 1, [], false))
    await settle()
    expect(handle.sort).toHaveBeenCalledTimes(2)
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toMatchObject({ view: whole, stale: false, sorting: false })
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')).toBeUndefined()
  })
  it('copies and saves in the sorted order, and saves only once the sort is built', async () => {
    const { service, handle, api } = sorted()
    const pending = deferred<ResultView>()
    handle.sort.mockReturnValueOnce(pending.promise)
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'descending')
    expect(await service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')).toBe('Save the results after they are sorted.')
    expect(api.saveResults).not.toHaveBeenCalled()
    const view = fakeView(handle, 7, [{ column: 0, descending: true, mode: 'value' }])
    pending.resolve(view)
    await settle()
    service.setSelection('t1', keyAt(service, 't1', 0), selectAll(keyAt(service, 't1', 0)))
    await service.copy('t1', keyAt(service, 't1', 0), false)
    expect(api.copyResults).toHaveBeenLastCalledWith(expect.objectContaining({ resultId: 1, viewId: 7 }))
    await service.saveAs('t1', keyAt(service, 't1', 0), 'SQLQuery1')
    expect(api.saveResults).toHaveBeenLastCalledWith(expect.objectContaining({ resultId: 1, viewId: 7 }))
    service.clearSort('t1', keyAt(service, 't1', 0))
    await service.copy('t1', keyAt(service, 't1', 0), false)
    expect(api.copyResults.mock.lastCall![0]).not.toHaveProperty('viewId')
  })
  it('copies and saves a grid drawn transposed as drawn: its orientation, header column and the selection it shows', async () => {
    const { service, handle, api, tab, flush, timers } = sorted()
    const key = keyAt(service, 't1', 0), state = service.gridState('t1', key), cap = limits.transpose.maxRows
    const cells = (anchor: [number, number], focus: [number, number]) => ({ kind: 'cells' as const, anchor: { row: anchor[0], column: anchor[1] }, focus: { row: focus[0], column: focus[1] } })
    // A table's requests say nothing of orientation, whatever header column its state keeps.
    state.headerColumn = 1
    service.setSelection('t1', key, { entry: key, active: { row: 1, column: 0 }, blocks: [cells([1, 0], [2, 1])] })
    await service.copy('t1', key, true)
    await service.saveAs('t1', key, 'SQLQuery1')
    for (const request of [api.copyResults.mock.lastCall![0], api.saveResults.mock.lastCall![0]]) { expect(request).not.toHaveProperty('transposed'); expect(request).not.toHaveProperty('headerColumn') }
    // Transposed: the parts stay in the result's rows and columns (the backend turns them), with the header column.
    state.orientation = 'transposed'
    await service.copy('t1', key, true)
    expect(api.copyResults).toHaveBeenLastCalledWith({ jobId: expect.any(String), generation: 1, resultId: 1, headers: true, parts: [{ rows: [[1, 2]], columns: [[0, 1]] }], transposed: true, headerColumn: 1 })
    await service.saveAs('t1', key, 'SQLQuery1')
    expect(api.saveResults).toHaveBeenLastCalledWith({ jobId: expect.any(String), generation: 1, resultId: 1, suggestedName: 'SQLQuery1-Result1', transposed: true, headerColumn: 1 })
    // Through the grid's sorted view, and without a header column once it is not one of the result's.
    handle.sort.mockResolvedValueOnce(fakeView(handle, 7, [{ column: 0, descending: true, mode: 'value' }]))
    service.sortBy('t1', key, 0, 'descending')
    await settle()
    state.headerColumn = 2
    await service.copy('t1', key, false)
    expect(api.copyResults.mock.lastCall![0]).toEqual({ jobId: expect.any(String), generation: 1, resultId: 1, headers: false, parts: [{ rows: [[1, 2]], columns: [[0, 1]] }], viewId: 7, transposed: true })
    await service.saveAs('t1', key, 'SQLQuery1')
    expect(api.saveResults.mock.lastCall![0]).toMatchObject({ viewId: 7, transposed: true })
    expect(api.saveResults.mock.lastCall![0]).not.toHaveProperty('headerColumn')
    delete state.headerColumn
    // Only what the transposed grid shows selected is copied: a block wholly past the rows it draws is left out, and with
    // none left the active cell is the selection, as the grid draws it.
    service.setSelection('t1', key, { entry: key, active: { row: 3, column: 1 }, blocks: [cells([cap, 0], [cap + 5, 1]), cells([cap - 1, 0], [cap + 5, 0])] })
    await service.copy('t1', key, false)
    expect(api.copyResults.mock.lastCall![0].parts).toEqual([{ rows: [[cap - 1, cap + 5]], columns: [[0, 0]] }])
    service.setSelection('t1', key, { entry: key, active: { row: 3, column: 1 }, blocks: [cells([cap, 0], [cap + 5, 1])] })
    await service.copy('t1', key, false)
    expect(api.copyResults.mock.lastCall![0].parts).toEqual([{ rows: [[3, 3]], columns: [[1, 1]] }])
    // An active cell past the rows drawn too (a state the grid has not drawn yet) leaves nothing to copy: no request is
    // made, so the clipboard keeps its text.
    const before = api.copyResults.mock.calls.length
    service.setSelection('t1', key, { entry: key, active: { row: cap + 2, column: 1 }, blocks: [cells([cap, 0], [cap + 5, 1])] })
    expect(await service.copy('t1', key, true)).toBeUndefined()
    expect(api.copyResults.mock.calls).toHaveLength(before)
    // Whole columns (a drawn row) and Select All run to the end of the result: the backend writes the rows drawn and
    // counts the rest, which the toolbar then says.
    service.setSelection('t1', key, selectAll(key))
    api.copyResults.mockResolvedValueOnce({ ok: true, value: { rows: cap, bytes: 10, truncatedCells: 0, partial: false, capped: 905 } })
    await service.copy('t1', key, false)
    expect(api.copyResults.mock.lastCall![0].parts).toEqual([{ rows: [[0, openEnd]], columns: [[0, 1]] }])
    flush()
    expect(tab().jobNotice).toBe('Copied 4,095 rows as columns. 905 rows past the first 4,095 were left out; filter the results to copy or save others.')
    api.copyResults.mockResolvedValueOnce({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0 } })
    await service.copy('t1', key, false)
    timers.advance(300)
    expect(tab().announcement).toBe('Copied 2 rows as columns.')
    api.saveResults.mockResolvedValueOnce({ ok: true, value: { rows: cap, bytes: 10, truncatedCells: 0, partial: false, capped: 1, fileName: 'out.csv', format: 'csv' } })
    await service.saveAs('t1', key, 'SQLQuery1')
    flush()
    expect(tab().jobNotice).toBe('Saved 4,095 rows as columns to out.csv. 1 row past the first 4,095 was left out; filter the results to copy or save others.')
    // The job's strip counts the result's columns (its lines) while a transposed job runs.
    const pending = deferred<ApiResult<ResultsJobResult>>()
    api.copyResults.mockReturnValueOnce(pending.promise)
    const copying = service.copy('t1', key, false)
    flush()
    expect(tab().jobs).toEqual([expect.objectContaining({ kind: 'copy', columns: true })])
    pending.resolve({ ok: true, value: { rows: 2, bytes: 10, truncatedCells: 0, partial: false, capped: 0 } })
    await copying
  })
  it('draws a view transposed by one rule, which a tone column (a comparison) turns off', () => {
    const columns = (roles: (string | undefined)[]) => ({ columns: roles.map((role, index) => ({ name: `c${index}`, dataType: 'int', wire: 'text', nullable: true, ...role ? { role } : {} }) as ResultColumn) })
    expect(transposedView(undefined, columns([undefined]))).toBeUndefined()
    expect(transposedView({ headerColumn: 0 }, columns([undefined]))).toBeUndefined()
    expect(transposedView({ orientation: 'transposed' }, columns([undefined, undefined]))).toEqual({})
    expect(transposedView({ orientation: 'transposed', headerColumn: 1 }, columns([undefined, undefined]))).toEqual({ headerColumn: 1 })
    for (const headerColumn of [2, -1, 0.5]) expect(transposedView({ orientation: 'transposed', headerColumn }, columns([undefined, undefined]))).toEqual({})
    expect(transposedView({ orientation: 'transposed', headerColumn: 0 }, columns([undefined, 'tone']))).toBeUndefined()
  })
  it('opens a sorted grid\'s value from its view\'s row', async () => {
    const f = fixture()
    f.service.begin('t1', 'q1')
    const columns = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }, { name: 'Doc', dataType: 'xml', wire: 'text', nullable: true, role: 'xml' }] as ResultColumn[]
    f.service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { columns })]) })
    const handle = f.client.handle(1)!, view = fakeView(handle, 1, [])
    handle.sort.mockResolvedValueOnce(view)
    f.service.sortBy('t1', keyAt(f.service, 't1', 0), 0, 'descending')
    await settle()
    expect(await f.service.openValue('t1', keyAt(f.service, 't1', 0), 1, 1)).toEqual({ opened: true })
    expect(view.getCell).toHaveBeenCalledWith(1, 1, { format: 'xml' })
    expect(handle.getCell).not.toHaveBeenCalled()
  })
  it('stops a running sort when the results close', () => {
    const { service, handle } = sorted()
    handle.sort.mockReturnValueOnce(new Promise(() => {}))
    const sortedEntry = keyAt(service, 't1', 0)
    service.sortBy('t1', sortedEntry, 0, 'ascending')
    const signal = handle.sort.mock.lastCall![1]!.signal!
    service.closeResults('t1')
    expect(signal.aborted).toBe(true)
    expect(service.sortOf('t1', sortedEntry)).toBeUndefined()
  })
})

describe('results service filters', () => {
  const filtered = (rows = 10, columns?: ResultColumn[]) => {
    const f = fixture()
    f.service.begin('t1', 'q1')
    f.service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { rowsAvailable: rows, rowsRead: rows, rowsStored: rows, ...columns ? { columns } : {} })]) })
    const handle = f.client.handle(1)!
    handle.snapshot = { ...handle.snapshot, rowsAvailable: rows, rowsRead: rows, rowsStored: rows, state: 'complete' }
    // Base row r's value in column c reads "v<r>" ("NULL" for row 9).
    handle.getWindow = async (first, count, o) => ({ first, count, colStart: o?.colStart ?? 0, colEnd: o?.colEnd ?? 2, text: [first === 9 ? '' : `v${first}`], flags: new Uint8Array([first === 9 ? 1 : 0]) })
    const select = (blocks: { top: number; bottom: number; left: number; right: number }[], active = { row: blocks[0].top, column: blocks[0].left }) =>
      f.service.setSelection('t1', keyAt(f.service, 't1', 0), { entry: keyAt(f.service, 't1', 0), active, blocks: blocks.map(block => ({ kind: 'cells' as const, anchor: { row: block.top, column: block.left }, focus: { row: block.bottom, column: block.right } })) })
    return { ...f, handle, select }
  }
  const resolvedView = (handle: FakeHandle, viewId: number, filters: ResultView['filters'], rows = 2) => ({ ...fakeView(handle, viewId, [], true, filters), rows })

  it('filters by the selected cells of one column, names the filter by its value, and stacks filters in order', async () => {
    const { service, handle, select, flush, tab } = filtered()
    select([{ top: 2, bottom: 2, left: 1, right: 1 }])
    expect(service.canFilterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(true)
    expect(service.canFilterSelection('t1', keyAt(service, 't1', 0), 'between')).toBe(false)
    const first = resolvedView(handle, 1, [{ op: 'in', column: 1, rows: [2], nulls: false }])
    handle.sort.mockResolvedValueOnce(first)
    expect(service.filterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(true)
    // Selected cells go to the backend as ranges of the rows the grid shows (its own order, before any view).
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: [{ op: 'in', column: 1, cells: { ranges: [[2, 1]] } }], signal: expect.any(AbortSignal) })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.map(item => item.label)).toEqual(['(No column name): filtering…'])
    await settle()
    await settle()
    flush()
    expect(tab().sorts.get(keyAt(service, 't1', 0))).toMatchObject({ view: first, filters: [{ filter: { op: 'in', column: 1, rows: [2], nulls: false }, label: "(No column name) = 'v2'" }] })
    // The grid now shows the view: cells selected in it name its positions, with its id.
    service.viewShown('t1', keyAt(service, 't1', 0), first)
    select([{ top: 0, bottom: 1, left: 0, right: 0 }])
    const second = resolvedView(handle, 2, [{ op: 'in', column: 1, rows: [2], nulls: false }, { op: 'between', column: 0, rows: [2, 5], nulls: false }])
    handle.sort.mockResolvedValueOnce(second)
    service.filterSelection('t1', keyAt(service, 't1', 0), 'between')
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: [{ op: 'in', column: 1, rows: [2], nulls: false }, { op: 'between', column: 0, cells: { ranges: [[0, 2]], viewId: 1 } }], signal: expect.any(AbortSignal) })
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.map(item => item.label)).toEqual(["(No column name) = 'v2'", "Id between 'v2' and 'v5'"])
    // A sort keeps the filters; Clear Sort leaves them; removing one applies the others again.
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 3, second.filters))
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'descending')
    expect(handle.sort).toHaveBeenLastCalledWith([{ column: 0, descending: true, mode: 'value' }], { filters: second.filters, signal: expect.any(AbortSignal) })
    await settle()
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 4, second.filters))
    service.clearSort('t1', keyAt(service, 't1', 0))
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: second.filters, signal: expect.any(AbortSignal) })
    await settle()
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 5, [second.filters[1]]))
    service.removeFilter('t1', keyAt(service, 't1', 0), 0)
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: [second.filters[1]], signal: expect.any(AbortSignal) })
    await settle()
    // Clearing the last filter of an unsorted grid shows its own rows again.
    service.clearFilters('t1', keyAt(service, 't1', 0))
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toBeUndefined()
  })

  it('replaces a filter of the same kind on a column, excludes NULLs, and filters duplicates of the selected or every column', async () => {
    const { service, handle, select } = filtered()
    select([{ top: 0, bottom: 0, left: 1, right: 1 }, { top: 4, bottom: 5, left: 1, right: 1 }])
    handle.sort.mockResolvedValue(resolvedView(handle, 1, []))
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notIn')
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: [{ op: 'notIn', column: 1, cells: { ranges: [[0, 1], [4, 2]] } }], signal: expect.any(AbortSignal) })
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notIn')
    expect(handle.sort.mock.lastCall?.[1]?.filters).toHaveLength(1)
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notNull')
    expect(handle.sort.mock.lastCall?.[1]?.filters?.at(-1)).toEqual({ op: 'notIn', column: 1, rows: [], nulls: true })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.at(-1)?.label).toBe('(No column name) is not NULL')
    // Exclude NULLs and Exclude Selected Values on one column are different kinds: neither replaces the other.
    expect(handle.sort.mock.lastCall?.[1]?.filters).toHaveLength(2)
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notIn')
    expect(handle.sort.mock.lastCall?.[1]?.filters?.map(filter => 'nulls' in filter && filter.nulls === true)).toEqual([true, false])
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notNull')
    expect(handle.sort.mock.lastCall?.[1]?.filters).toHaveLength(2)
    // A selection across columns cannot filter by values, but names the columns for duplicates.
    select([{ top: 0, bottom: 3, left: 0, right: 1 }])
    expect(service.canFilterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(false)
    expect(service.filterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(false)
    service.filterDuplicates('t1', keyAt(service, 't1', 0))
    expect(handle.sort.mock.lastCall?.[1]?.filters?.at(-1)).toEqual({ op: 'duplicates', columns: [0, 1] })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.at(-1)?.label).toBe('Duplicate rows')
    select([{ top: 0, bottom: 0, left: 0, right: 0 }])
    service.filterDuplicates('t1', keyAt(service, 't1', 0))
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.at(-1)?.label).toBe('Duplicates in Id')
  })

  it('goes back to the last view and its filters when a filter fails, and builds a stale view again with its resolved filters', async () => {
    const { service, handle, select, flush, tab } = filtered()
    select([{ top: 1, bottom: 1, left: 0, right: 0 }])
    const resolved = [{ op: 'in' as const, column: 0, rows: [1], nulls: false }]
    // Built from the rows sealed so far, and the set finished meanwhile: it is built again from every row, with the filter
    // its cells resolved to.
    const pending = deferred<ResultView>()
    handle.sort.mockReturnValueOnce(pending.promise)
    service.filterSelection('t1', keyAt(service, 't1', 0), 'in')
    const whole = resolvedView(handle, 2, resolved)
    handle.sort.mockResolvedValueOnce(whole)
    pending.resolve({ ...resolvedView(handle, 1, resolved), complete: false })
    await settle()
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: resolved, signal: expect.any(AbortSignal) })
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toMatchObject({ view: whole, stale: false })
    select([{ top: 0, bottom: 4, left: 0, right: 0 }])
    handle.sort.mockRejectedValueOnce(new Error('Select at most 4,096 different values to filter by.'))
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notIn')
    await settle()
    flush()
    expect(tab().sorts.get(keyAt(service, 't1', 0))).toMatchObject({ view: whole, sorting: false, filters: [{ filter: resolved[0] }] })
    expect(tab().sorts.get(keyAt(service, 't1', 0))?.filters).toHaveLength(1)
    expect(tab().jobNotice).toBe('Could not filter the results: Select at most 4,096 different values to filter by.')
  })

  it('leaves the hidden tone column of a diff out of duplicate rows', () => {
    const f = fixture()
    const columns: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }, { name: 'tone', dataType: 'tinyint', wire: 'text', nullable: false, role: 'tone' }]
    f.service.begin('t1', 'q1')
    f.service.finish('t1', 'q1', { summary: summaryOf([descriptor(1, { columns, rowsAvailable: 4 })]) })
    const handle = f.client.handle(1)!
    handle.snapshot = { ...handle.snapshot, rowsAvailable: 4, state: 'complete' }
    handle.sort.mockResolvedValue({ ...fakeView(handle, 1, []), filters: [] })
    expect(f.service.filterDuplicates('t1', keyAt(f.service, 't1', 0), true)).toBe(true)
    expect(handle.sort.mock.lastCall?.[1]?.filters).toEqual([{ op: 'duplicates', columns: [0] }])
    expect(f.service.sortOf('t1', keyAt(f.service, 't1', 0))?.filters[0].label).toBe('Duplicate rows')
  })
  describe('Keep Selected Rows', () => {
    const wide = () => filtered(10_000, Array.from({ length: 17 }, (_, at): ResultColumn => ({ name: `c${at}`, dataType: 'int', wire: 'text', nullable: true })))
    /** A backend that resolves each filter as asked: a keepRows filter's cells to one base row per position they cover. */
    const resolving = (handle: FakeHandle) => {
      let viewId = 0
      handle.sort.mockImplementation(async (_keys, o) => resolvedView(handle, ++viewId, (o?.filters ?? []).map((filter): ResolvedViewFilter => {
        if (filter.op === 'duplicates' || filter.op === 'groups') return filter as ResolvedViewFilter
        if (filter.op === 'keepRows') return { op: 'keepRows', rows: 'rows' in filter ? filter.rows : filter.cells.ranges.flatMap(([first, count]) => Array.from({ length: count }, (_, at) => 100 + first + at)) }
        return { op: filter.op, column: filter.column, rows: 'rows' in filter ? filter.rows : [0], nulls: 'nulls' in filter ? !!filter.nulls : false }
      })))
    }
    const sent = (handle: FakeHandle) => handle.sort.mock.lastCall?.[1]?.filters

    it('keeps the rows the selection covers as one filter, named by its rows, that marks no column', async () => {
      const { service, handle, select, flush, tab } = wide()
      const key = keyAt(service, 't1', 0)
      expect(service.canKeepSelectedRows('t1', key)).toBe(false)
      expect(service.keepSelectedRows('t1', key)).toBe(false)
      // Blocks over any columns: their rows, overlapping and adjacent runs joined.
      select([{ top: 2, bottom: 4, left: 0, right: 1 }, { top: 4, bottom: 6, left: 5, right: 5 }, { top: 20, bottom: 20, left: 0, right: 0 }])
      expect(service.canKeepSelectedRows('t1', key)).toBe(true)
      const rows = [2, 3, 4, 5, 6, 20]
      const first = resolvedView(handle, 1, [{ op: 'keepRows', rows }], 6)
      handle.sort.mockResolvedValueOnce(first)
      expect(service.keepSelectedRows('t1', key)).toBe(true)
      expect(handle.sort).toHaveBeenLastCalledWith([], { filters: [{ op: 'keepRows', cells: { ranges: [[2, 5], [20, 1]] } }], signal: expect.any(AbortSignal) })
      expect(service.sortOf('t1', key)?.filters.map(item => item.label)).toEqual(['6 selected rows'])
      await settle()
      await settle()
      flush()
      expect(tab().sorts.get(key)).toMatchObject({ view: first, filters: [{ filter: { op: 'keepRows', rows }, label: '6 selected rows', named: true }] })
      expect(filteredColumns(service.sortOf('t1', key))).toEqual(new Set())
      // A sort re-sends it resolved, like any filter.
      handle.sort.mockResolvedValueOnce(resolvedView(handle, 2, first.filters, 6))
      service.sortBy('t1', key, 0, 'descending')
      expect(handle.sort).toHaveBeenLastCalledWith([{ column: 0, descending: true, mode: 'value' }], { filters: [{ op: 'keepRows', rows }], signal: expect.any(AbortSignal) })
    })

    it('counts the rows the view resolved, which are fewer than selected while rows still arrive, and keeps them when the set completes', async () => {
      const { service, handle, select } = wide()
      const key = keyAt(service, 't1', 0)
      select([{ top: 0, bottom: 11, left: 0, right: 0 }])
      const pending = deferred<ResultView>()
      handle.sort.mockReturnValueOnce(pending.promise)
      service.keepSelectedRows('t1', key)
      expect(service.sortOf('t1', key)?.filters[0].label).toBe('12 selected rows')
      // Built from the rows sealed so far (one of the twelve was), and the set finished meanwhile: the view is built again
      // with the row it resolved, not the selection.
      const resolved: ResolvedViewFilter[] = [{ op: 'keepRows', rows: [0] }]
      handle.sort.mockResolvedValueOnce(resolvedView(handle, 2, resolved, 1))
      pending.resolve({ ...resolvedView(handle, 1, resolved, 1), complete: false })
      await settle()
      expect(handle.sort).toHaveBeenLastCalledWith([], { filters: resolved, signal: expect.any(AbortSignal) })
      await settle()
      await settle()
      expect(service.sortOf('t1', key)).toMatchObject({ stale: false, filters: [{ filter: resolved[0], label: '1 selected row', named: true }] })
    })

    it('replaces the grid\'s one keepRows filter in its place among the filters, from the rows of the view shown', async () => {
      const { service, handle, select } = wide()
      const key = keyAt(service, 't1', 0)
      resolving(handle)
      select([{ top: 0, bottom: 0, left: 1, right: 1 }])
      service.filterSelection('t1', key, 'in')
      select([{ top: 0, bottom: 2, left: 0, right: 0 }])
      service.keepSelectedRows('t1', key)
      select([{ top: 0, bottom: 0, left: 2, right: 2 }])
      service.filterSelection('t1', key, 'notIn')
      await settle()
      await settle()
      expect(service.sortOf('t1', key)?.filters.map(item => item.filter.op)).toEqual(['in', 'keepRows', 'notIn'])
      const shown = service.sortOf('t1', key)!.view!
      service.viewShown('t1', key, shown)
      select([{ top: 1, bottom: 1, left: 3, right: 4 }])
      expect(service.keepSelectedRows('t1', key)).toBe(true)
      // The new one stands where the old one stood, and names positions of the view the grid shows.
      expect(sent(handle)).toEqual([{ op: 'in', column: 1, rows: [0], nulls: false }, { op: 'keepRows', cells: { ranges: [[1, 1]], viewId: shown.viewId } }, { op: 'notIn', column: 2, rows: [0], nulls: false }])
      await settle()
      await settle()
      expect(service.sortOf('t1', key)?.filters.map(item => item.label)).toEqual(["c1 = 'v0'", '1 selected row', "c2 \u2260 'v0'"])
      // Its chip comes off like any other.
      service.removeFilter('t1', key, 1)
      expect(sent(handle)?.map(filter => filter.op)).toEqual(['in', 'notIn'])
    })

    it('goes last instead when a duplicates filter follows the one it replaces, so the grid shows the rows selected', async () => {
      const { service, handle, select } = wide()
      const key = keyAt(service, 't1', 0)
      resolving(handle)
      const ops = () => sent(handle)?.map(filter => filter.op)
      select([{ top: 0, bottom: 5, left: 0, right: 0 }])
      service.keepSelectedRows('t1', key)
      service.filterDuplicates('t1', key, true)
      select([{ top: 0, bottom: 0, left: 1, right: 1 }])
      service.filterSelection('t1', key, 'in')
      await settle()
      await settle()
      expect(ops()).toEqual(['keepRows', 'duplicates', 'in'])
      // In the old one's place, duplicates would count only the one row kept and show none.
      select([{ top: 2, bottom: 2, left: 0, right: 0 }])
      expect(service.keepSelectedRows('t1', key)).toBe(true)
      expect(ops()).toEqual(['duplicates', 'in', 'keepRows'])
      expect(sent(handle)?.at(-1)).toEqual({ op: 'keepRows', cells: { ranges: [[2, 1]] } })
      await settle()
      await settle()
      // With the duplicates filter before it, the next one replaces in place again.
      select([{ top: 3, bottom: 3, left: 0, right: 0 }])
      service.filterSelection('t1', key, 'notNull')
      select([{ top: 4, bottom: 4, left: 0, right: 0 }])
      service.keepSelectedRows('t1', key)
      expect(ops()).toEqual(['duplicates', 'in', 'keepRows', 'notIn'])
    })

    it('says so in the toolbar and applies nothing when more rows or ranges are selected than it takes', async () => {
      const { service, handle, select, flush, tab } = wide()
      const key = keyAt(service, 't1', 0)
      resolving(handle)
      select([{ top: 0, bottom: 4095, left: 0, right: 0 }])
      expect(service.canKeepSelectedRows('t1', key)).toBe(true)
      expect(service.keepSelectedRows('t1', key)).toBe(false)
      flush()
      expect(tab().jobNotice).toBe('Keep Selected Rows takes at most 4,095 rows in 256 ranges; 4,096 rows are selected. Nothing was applied.')
      expect(handle.sort).not.toHaveBeenCalled()
      expect(service.sortOf('t1', key)).toBeUndefined()
      select(Array.from({ length: 257 }, (_, at) => ({ top: at * 2, bottom: at * 2, left: 0, right: 0 })))
      expect(service.keepSelectedRows('t1', key)).toBe(false)
      flush()
      expect(tab().jobNotice).toBe('Keep Selected Rows takes at most 4,095 rows in 256 ranges; 257 ranges are selected. Nothing was applied.')
      expect(handle.sort).not.toHaveBeenCalled()
      // Exactly the limits apply; a refusal after that leaves the filter the grid has.
      select([{ top: 0, bottom: 4094, left: 0, right: 0 }])
      expect(service.keepSelectedRows('t1', key)).toBe(true)
      await settle()
      await settle()
      expect(service.sortOf('t1', key)?.filters.map(item => item.label)).toEqual(['4,095 selected rows'])
      select(Array.from({ length: 256 }, (_, at) => ({ top: at * 2, bottom: at * 2, left: 0, right: 0 })))
      expect(service.keepSelectedRows('t1', key)).toBe(true)
      await settle()
      await settle()
      expect(service.sortOf('t1', key)?.filters.map(item => item.label)).toEqual(['256 selected rows'])
      const calls = handle.sort.mock.calls.length
      select([{ top: 0, bottom: 9999, left: 0, right: 0 }])
      expect(service.keepSelectedRows('t1', key)).toBe(false)
      expect(handle.sort.mock.calls.length).toBe(calls)
      expect(service.sortOf('t1', key)?.filters.map(item => item.label)).toEqual(['256 selected rows'])
    })

    it('takes every row of a grid selected whole when they fit, and refuses when they do not', async () => {
      const small = filtered(100)
      const key = keyAt(small.service, 't1', 0)
      resolving(small.handle)
      small.service.setSelection('t1', key, selectAll(key))
      expect(small.service.keepSelectedRows('t1', key)).toBe(true)
      expect(sent(small.handle)).toEqual([{ op: 'keepRows', cells: { ranges: [[0, 100]] } }])
      const large = wide()
      const largeKey = keyAt(large.service, 't1', 0)
      large.service.setSelection('t1', largeKey, selectAll(largeKey))
      expect(large.service.keepSelectedRows('t1', largeKey)).toBe(false)
      large.flush()
      expect(large.tab().jobNotice).toBe('Keep Selected Rows takes at most 4,095 rows in 256 ranges; 10,000 rows are selected. Nothing was applied.')
      expect(large.handle.sort).not.toHaveBeenCalled()
    })

    it('is one of the grid\'s 16 filters', async () => {
      const { service, handle, select, flush, tab } = wide()
      const key = keyAt(service, 't1', 0)
      resolving(handle)
      const full = 'Could not filter the results: a grid takes at most 16 filters. Remove one first.'
      select([{ top: 0, bottom: 1, left: 0, right: 0 }])
      service.keepSelectedRows('t1', key)
      for (let column = 0; column < 15; column++) {
        select([{ top: 0, bottom: 0, left: column, right: column }])
        expect(service.filterSelection('t1', key, 'in')).toBe(true)
      }
      expect(service.sortOf('t1', key)?.filters).toHaveLength(16)
      // With it the grid is full: a seventeenth filter is refused, and a new keepRows still replaces the one it has.
      select([{ top: 0, bottom: 0, left: 15, right: 15 }])
      expect(service.filterSelection('t1', key, 'in')).toBe(false)
      flush()
      expect(tab().jobNotice).toBe(full)
      select([{ top: 5, bottom: 7, left: 0, right: 0 }])
      expect(service.keepSelectedRows('t1', key)).toBe(true)
      expect(sent(handle)).toHaveLength(16)
      expect(sent(handle)?.[0]).toEqual({ op: 'keepRows', cells: { ranges: [[5, 3]] } })
      // Sixteen other filters leave it no room.
      service.removeFilter('t1', key, 0)
      select([{ top: 0, bottom: 0, left: 15, right: 15 }])
      expect(service.filterSelection('t1', key, 'in')).toBe(true)
      service.notify('t1', '')
      select([{ top: 5, bottom: 7, left: 0, right: 0 }])
      const calls = handle.sort.mock.calls.length
      expect(service.keepSelectedRows('t1', key)).toBe(false)
      expect(handle.sort.mock.calls.length).toBe(calls)
      flush()
      expect(tab().jobNotice).toBe(full)
    })
  })

  it('takes at most 16 filters, saying so, and filters only by selections whose runs of rows fit a request', async () => {
    const { service, handle, select, flush, tab } = filtered(1000, Array.from({ length: 17 }, (_, at): ResultColumn => ({ name: `c${at}`, dataType: 'int', wire: 'text', nullable: true })))
    handle.sort.mockImplementation(async (_keys, o) => resolvedView(handle, 1, (o?.filters ?? []).map((filter): ResolvedViewFilter => filter.op === 'duplicates' || filter.op === 'groups' || filter.op === 'keepRows' ? filter as ResolvedViewFilter : { op: filter.op, column: filter.column, rows: 'rows' in filter ? filter.rows : [0], nulls: 'nulls' in filter ? !!filter.nulls : false })))
    for (let column = 0; column < 16; column++) {
      select([{ top: 0, bottom: 0, left: column, right: column }])
      expect(service.filterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(true)
    }
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters).toHaveLength(16)
    select([{ top: 1, bottom: 1, left: 16, right: 16 }])
    const calls = handle.sort.mock.calls.length
    expect(service.filterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(false)
    expect(handle.sort.mock.calls.length).toBe(calls)
    flush()
    expect(tab().jobNotice).toBe('Could not filter the results: a grid takes at most 16 filters. Remove one first.')
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters).toHaveLength(16)
    // Replacing a filter of the same kind still works at the limit.
    select([{ top: 2, bottom: 2, left: 3, right: 3 }])
    expect(service.filterSelection('t1', keyAt(service, 't1', 0), 'in')).toBe(true)
    service.clearFilters('t1', keyAt(service, 't1', 0))
    await settle()
    // Overlapping and adjacent cells join into one run; more separate runs than a request takes cannot filter.
    select([{ top: 0, bottom: 3, left: 1, right: 1 }, { top: 2, bottom: 5, left: 1, right: 1 }, { top: 6, bottom: 6, left: 1, right: 1 }])
    service.filterSelection('t1', keyAt(service, 't1', 0), 'in')
    expect(handle.sort.mock.lastCall?.[1]?.filters?.at(-1)).toEqual({ op: 'in', column: 1, cells: { ranges: [[0, 7]] } })
    select(Array.from({ length: 257 }, (_, at) => ({ top: at * 2, bottom: at * 2, left: 1, right: 1 })))
    expect(service.canFilterSelection('t1', keyAt(service, 't1', 0), 'notIn')).toBe(false)
    select(Array.from({ length: 256 }, (_, at) => ({ top: at * 2, bottom: at * 2, left: 1, right: 1 })))
    expect(service.canFilterSelection('t1', keyAt(service, 't1', 0), 'notIn')).toBe(true)
  })

  it('names a view\'s filters only onto that view, reads only labels not yet named, and says a failed replacement could not filter', async () => {
    const { service, handle, select, flush, tab } = filtered()
    const reads = vi.fn(handle.getWindow)
    handle.getWindow = reads
    let release = () => {}
    const slow = new Promise<void>(done => { release = done })
    const read = handle.getWindow
    handle.getWindow = async (first, count, o) => { await slow; return read(first, count, o) }
    select([{ top: 2, bottom: 2, left: 1, right: 1 }])
    const first = [{ op: 'in' as const, column: 1, rows: [2], nulls: false }]
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 1, first))
    service.filterSelection('t1', keyAt(service, 't1', 0), 'in')
    await settle()
    await settle()
    // A second filter starts building before the first one's value is read: the late label leaves the pending filters alone.
    select([{ top: 0, bottom: 0, left: 0, right: 0 }])
    const pending = deferred<ResultView>()
    handle.sort.mockReturnValueOnce(pending.promise)
    service.filterSelection('t1', keyAt(service, 't1', 0), 'notNull')
    release()
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.map(item => item.label)).toEqual(['(No column name): filtering…', 'Id is not NULL'])
    const second = [...first, { op: 'notIn' as const, column: 0, rows: [], nulls: true }]
    pending.resolve(resolvedView(handle, 2, second))
    await settle()
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.map(item => item.label)).toEqual(["(No column name) = 'v2'", 'Id is not NULL'])
    // A sort builds the view again without reading the named labels' values again.
    reads.mockClear()
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 3, second))
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending')
    await settle()
    await settle()
    expect(reads).not.toHaveBeenCalled()
    // Replacing a filter on a sorted grid that fails says it could not filter.
    select([{ top: 4, bottom: 4, left: 1, right: 1 }])
    handle.sort.mockRejectedValueOnce(new Error('No room.'))
    service.filterSelection('t1', keyAt(service, 't1', 0), 'in')
    await settle()
    flush()
    expect(tab().jobNotice).toBe('Could not filter the results: No room.')
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters).toHaveLength(2)
  })

  it('reads a filter\'s value again on the next build when it could not be read', async () => {
    const { service, handle, select } = filtered()
    const read = handle.getWindow
    handle.getWindow = vi.fn(async () => { throw new Error('busy') })
    select([{ top: 2, bottom: 2, left: 1, right: 1 }])
    const resolved = [{ op: 'in' as const, column: 1, rows: [2], nulls: false }]
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 1, resolved))
    service.filterSelection('t1', keyAt(service, 't1', 0), 'in')
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters[0]).toMatchObject({ label: '(No column name) in (1 value)' })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters[0]?.named).toBeUndefined()
    handle.getWindow = read
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 2, resolved))
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending')
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters[0]).toMatchObject({ label: "(No column name) = 'v2'", named: true })
  })

  it('names filters by their values, counts and NULL', () => {
    const columns: ResultColumn[] = [{ name: 'Id', dataType: 'int', wire: 'text', nullable: false }, { name: 'Name', dataType: 'nvarchar', wire: 'text', nullable: true }]
    expect(filterLabel({ op: 'in', column: 1, rows: [3], nulls: false }, columns, ["'x'"])).toBe("Name = 'x'")
    expect(filterLabel({ op: 'notIn', column: 1, rows: [3], nulls: false }, columns, ["'x'"])).toBe("Name ≠ 'x'")
    expect(filterLabel({ op: 'in', column: 1, rows: [3, 4], nulls: true }, columns)).toBe('Name in (3 values)')
    expect(filterLabel({ op: 'notIn', column: 1, rows: [], nulls: true }, columns)).toBe('Name is not NULL')
    expect(filterLabel({ op: 'in', column: 1, rows: [], nulls: true }, columns)).toBe('Name is NULL')
    expect(filterLabel({ op: 'between', column: 0, rows: [1, 2], nulls: false }, columns)).toBe('Id between 2 values')
    expect(filterLabel({ op: 'duplicates', columns: [0, 1] }, columns)).toBe('Duplicate rows')
    expect(filterLabel({ op: 'duplicates', columns: [1] }, columns)).toBe('Duplicates in Name')
    // Keep Selected Rows names no column: its words are the rows it names.
    expect(filterLabel({ op: 'keepRows', rows: Array.from({ length: 12 }, (_, row) => row) }, columns)).toBe('12 selected rows')
    expect(filterLabel({ op: 'keepRows', rows: [7] }, columns)).toBe('1 selected row')
    expect(filterLabel({ op: 'keepRows', rows: Array.from({ length: 4095 }, (_, row) => row) }, columns)).toBe('4,095 selected rows')
    // A checklist's filter names what it keeps or drops: the one value, a count, NULL, or nothing at all.
    const groups = { op: 'groups' as const, column: 1, snapshotId: 4 }
    expect(filterLabel({ ...groups, keep: true, values: 1, nulls: false, row: 3 }, columns, ["'x'"])).toBe("Name = 'x'")
    expect(filterLabel({ ...groups, keep: false, values: 1, nulls: false, row: 3 }, columns, ["'x'"])).toBe("Name ≠ 'x'")
    expect(filterLabel({ ...groups, keep: false, values: 999_999, nulls: true }, columns)).toBe('Name not in (1,000,000 values)')
    expect(filterLabel({ ...groups, keep: true, values: 0, nulls: true }, columns)).toBe('Name is NULL')
    expect(filterLabel({ ...groups, keep: false, values: 0, nulls: false }, columns)).toBe('Name: every value')
    // A diff's hidden tone column is not a value: every other column is every row's.
    expect(filterLabel({ op: 'duplicates', columns: [0, 1] }, [...columns, { name: 'tone', dataType: 'tinyint', wire: 'text', nullable: false, role: 'tone' }])).toBe('Duplicate rows')
  })
  it('applies the funnel conditions to a column, each replacing the filter of its kind on the column, and opens the funnel through the grid', async () => {
    const { service, handle } = filtered()
    handle.sort.mockResolvedValue(resolvedView(handle, 1, []))
    const filters = () => handle.sort.mock.lastCall?.[1]?.filters
    expect(service.canFilterColumn('t1', keyAt(service, 't1', 0), 1)).toBe(false)
    const filterColumn = vi.fn()
    service.registerGrid('t1', keyAt(service, 't1', 0), { selectAll: () => {}, repaint: () => {}, fitColumn: () => {}, filterColumn })
    expect(service.canFilterColumn('t1', keyAt(service, 't1', 0), 1)).toBe(true)
    expect(service.canFilterColumn('t1', keyAt(service, 't1', 0), 2)).toBe(false)
    service.filterColumn('t1', keyAt(service, 't1', 0), 1)
    expect(filterColumn).toHaveBeenCalledWith(1)
    const list = await handle.distinct(1)
    expect(service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list })).toBe(true)
    expect(filters()).toEqual([{ op: 'groups', column: 1, snapshotId: list.snapshotId }])
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.map(item => item.label)).toEqual(['(No column name): filtering…'])
    await settle()
    // Another checklist replaces it, and the grid closes the snapshot it no longer filters by once the new view is shown;
    // not NULL replaces a checklist too (the checklist lists NULL as a value); between is a kind of its own.
    const next = await handle.distinct(1)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list: next })
    expect(filters()).toEqual([{ op: 'groups', column: 1, snapshotId: next.snapshotId }])
    expect(list.close).not.toHaveBeenCalled()
    await settle()
    expect(list.close).toHaveBeenCalledTimes(1)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'notNull' })
    await settle()
    expect(next.close).toHaveBeenCalledTimes(1)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'between', rows: [2, 6] })
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 0, { kind: 'equals', row: 1 })
    expect(filters()).toEqual([{ op: 'notIn', column: 1, rows: [], nulls: true }, { op: 'between', column: 1, rows: [2, 6] }, { op: 'in', column: 0, rows: [1], nulls: false }])
    expect(filteredColumns(service.sortOf('t1', keyAt(service, 't1', 0)))).toEqual(new Set([0, 1]))
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'notEquals', row: 5 })
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'null' })
    // A replacement takes the place of the filter it replaces: filters apply in order.
    expect(filters()).toEqual([{ op: 'in', column: 1, rows: [], nulls: true }, { op: 'between', column: 1, rows: [2, 6] }, { op: 'in', column: 0, rows: [1], nulls: false }])
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters[0]?.label).toBe('(No column name) is NULL')
    service.filterDuplicates('t1', keyAt(service, 't1', 0), true)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 0, { kind: 'equals', row: 1 })
    expect(filters()?.map(filter => filter.op)).toEqual(['in', 'between', 'in', 'duplicates'])
    expect(filters()?.[2]).toEqual({ op: 'in', column: 0, rows: [1], nulls: false })
    service.removeFilter('t1', keyAt(service, 't1', 0), 3)
    await settle()
    // Every value ticked takes a checklist off, closing its snapshot.
    const third = await handle.distinct(1)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list: third })
    await settle()
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'all' })
    expect(filters()).toEqual([{ op: 'between', column: 1, rows: [2, 6] }, { op: 'in', column: 0, rows: [1], nulls: false }])
    await settle()
    expect(third.close).toHaveBeenCalledTimes(1)
    // A view that fails to build goes back to the filters it had, closing the snapshot it was given and keeping its own.
    const kept = await handle.distinct(1), failed = await handle.distinct(1)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list: kept })
    await settle()
    handle.sort.mockRejectedValueOnce(new Error('Not enough memory.'))
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list: failed })
    await settle()
    expect(failed.close).toHaveBeenCalledTimes(1)
    expect(kept.close).not.toHaveBeenCalled()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters.map(item => item.filter)).toContainEqual({ op: 'groups', column: 1, snapshotId: kept.snapshotId })
    // A snapshot of another column, or of another result, is refused.
    const calls = handle.sort.mock.calls.length
    expect(service.applyColumnFilter('t1', keyAt(service, 't1', 0), 0, { kind: 'list', list: await handle.distinct(1) })).toBe(false)
    expect(service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list: { ...await handle.distinct(1), resultId: 999 } })).toBe(false)
    expect(handle.sort.mock.calls.length).toBe(calls)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'clear' })
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 0, { kind: 'clear' })
    expect(service.sortOf('t1', keyAt(service, 't1', 0))).toBeUndefined()
    expect(kept.close).toHaveBeenCalledTimes(1)
  })

  it('names a checklist\'s filter by what the view says it keeps', async () => {
    const { service, handle } = filtered()
    const list = await handle.distinct(1)
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 1, [{ op: 'groups', column: 1, snapshotId: list.snapshotId, keep: false, values: 2, nulls: true }]))
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'list', list })
    await settle()
    await settle()
    expect(service.sortOf('t1', keyAt(service, 't1', 0))?.filters[0]).toMatchObject({ label: '(No column name) not in (3 values)', named: true, list })
    // Built again (a sort), the filter goes as it was asked, and the grid keeps its snapshot.
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 2, [{ op: 'groups', column: 1, snapshotId: list.snapshotId, keep: false, values: 2, nulls: true }]))
    service.sortBy('t1', keyAt(service, 't1', 0), 0, 'ascending')
    await settle()
    expect(handle.sort.mock.lastCall?.[1]?.filters?.[0]).toMatchObject({ op: 'groups', column: 1, snapshotId: list.snapshotId })
    expect(list.close).not.toHaveBeenCalled()
  })

  it('keeps the values of a column over the rows its other filters keep, ticked by what the grid shows now', async () => {
    const { service, handle } = filtered()
    const list = await service.columnValues('t1', keyAt(service, 't1', 0), 1)
    expect(list.column).toBe(1)
    expect(handle.distinct).toHaveBeenLastCalledWith(1, {})
    // A value list on the column and a not-NULL on another: the snapshot comes from a view of the other filter alone,
    // closed once it is built, and the grid's own view starts its ticks.
    const own = { op: 'in' as const, column: 1, rows: [0], nulls: false }, other = { op: 'notIn' as const, column: 0, rows: [], nulls: true }
    const shown = resolvedView(handle, 1, [own, other])
    handle.sort.mockResolvedValueOnce(shown)
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 1, { kind: 'equals', row: 0 })
    handle.sort.mockResolvedValueOnce({ ...shown, viewId: 2 })
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 0, { kind: 'notNull' })
    await settle()
    await settle()
    const others = { ...resolvedView(handle, 3, [other]), distinct: vi.fn<ResultHandle['distinct']>(async column => ({ ...await handle.distinct(column), snapshotId: 77 })) }
    handle.sort.mockResolvedValueOnce(others)
    const abort = new AbortController()
    const values = await service.columnValues('t1', keyAt(service, 't1', 0), 1, { signal: abort.signal })
    expect(handle.sort).toHaveBeenLastCalledWith([], { filters: [{ op: 'notIn', column: 0, rows: [], nulls: true }], signal: abort.signal })
    expect(others.distinct).toHaveBeenCalledWith(1, { signal: abort.signal, kept: expect.objectContaining({ viewId: 2 }) })
    expect(values.snapshotId).toBe(77)
    expect(others.close).toHaveBeenCalled()
    // No other filter: the snapshot is the result's own, ticked by the grid's view of the column's filter.
    handle.sort.mockResolvedValueOnce(resolvedView(handle, 4, [own]))
    service.applyColumnFilter('t1', keyAt(service, 't1', 0), 0, { kind: 'clear' })
    await settle()
    const sorts = handle.sort.mock.calls.length
    await service.columnValues('t1', keyAt(service, 't1', 0), 1)
    expect(handle.sort.mock.calls.length).toBe(sorts)
    expect(handle.distinct).toHaveBeenLastCalledWith(1, { kept: expect.objectContaining({ viewId: 4 }) })
  })
})
