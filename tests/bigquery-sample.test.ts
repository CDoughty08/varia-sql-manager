import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, ResultDescriptor, VariaApi } from '../src/shared/contracts'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import { remoteDryRunSchema, remoteResultIds, remoteViewLimits, type RemoteDryRun } from '../src/shared/bigquery/remote-view'
import { validateRequest } from '../src/main/validation'
import { RemoteDeclined, RemoteViews, remoteStop } from '../src/renderer/src/results/remote-views'
import { entryName, groupOf, resultTitle, ResultsService } from '../src/renderer/src/results/ResultsService'
import { defaultSampleRows, maxSampleRows, parseSampleRows, rowBytesOf, sampleName, sampleNote, sampleStatus, sampleTooLarge } from '../src/renderer/src/results/sample'
import { SampleDialogService } from '../src/renderer/src/results/sample-dialog'
import { loadingState, loadingText, loadOffer, windowedFullText, windowedText } from '../src/renderer/src/grid/ResultGrid'
import { EventBus } from '../src/renderer/src/core/events'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

// Load sample and in-place Re-run of a result windowed in BigQuery (docs/bigquery.md, Load a sample, Expiry): the contract
// main checks, the dialog's words and arithmetic, the strip's offers, and what the results service does with a sample or a
// re-run. The backend's own checks are BigQueryExecutionChecks.Sample.cs.

const columns = [{ name: 'id', dataType: 'INT64', wire: 'text', nullable: true }, { name: 'name', dataType: 'STRING', wire: 'text', nullable: true }] as ResultColumn[]
const windowed = (resultId = 1, total = 52_341_118) => descriptor(resultId, { columns, rowsStored: 0, rowsAvailable: total, residence: 'remote', revision: 1, rowsTotal: total, projectedBytes: total * 100 })

describe('results.remoteQuery sample and rerun', () => {
  const head = { queryId: crypto.randomUUID(), resultId: 7, generation: 1 }
  it('takes a sample\'s rows and method, and a rerun bare, strictly', () => {
    for (const value of [{ ...head, kind: 'sample', rows: 1, method: 'first' }, { ...head, kind: 'sample', rows: remoteViewLimits.sampleRows, method: 'random' }, { ...head, kind: 'rerun' }])
      expect(validateRequest('results.remoteQuery', value)).toEqual(value)
    const refused: Record<string, unknown>[] = [
      { ...head, kind: 'sample' }, { ...head, kind: 'sample', rows: 10 }, { ...head, kind: 'sample', rows: 0, method: 'first' },
      { ...head, kind: 'sample', rows: remoteViewLimits.sampleRows + 1, method: 'first' }, { ...head, kind: 'sample', rows: 1.5, method: 'first' },
      { ...head, kind: 'sample', rows: 10, method: 'last' }, { ...head, kind: 'sample', rows: 10, method: 'random', fallback: true },
      { ...head, kind: 'sample', rows: 10, method: 'random', sort: [{ column: 0, descending: false }] }, { ...head, kind: 'sample', rows: 10, method: 'first', jobKey: crypto.randomUUID() },
      { ...head, kind: 'rerun', rows: 10 }, { ...head, kind: 'rerun', fallback: true }, { ...head, kind: 'rerun', jobKey: crypto.randomUUID() }
    ]
    for (const value of refused) expect(() => validateRequest('results.remoteQuery', value), JSON.stringify(value)).toThrow('Invalid request')
    expect(remoteResultIds({ resultId: 7, kind: 'sample', rows: 1, method: 'first' } as never)).toEqual([7])
  })
  it('estimates a sample or a rerun through bigquery.dryRun, never with a query id', () => {
    const connectionId = crypto.randomUUID()
    for (const remote of [{ resultId: 7, generation: 1, kind: 'sample', rows: 10, method: 'random' }, { resultId: 7, generation: 1, kind: 'rerun' }] as RemoteDryRun[]) {
      expect(remoteDryRunSchema.safeParse(remote).success).toBe(true)
      expect(validateRequest('bigquery.dryRun', { connectionId, remote })).toEqual({ connectionId, remote })
      expect(() => validateRequest('bigquery.dryRun', { connectionId, remote: { ...remote, queryId: head.queryId } })).toThrow('Invalid request')
    }
  })
})

describe('the sample\'s words and arithmetic', () => {
  it('names a sample for what it holds, wherever it shows', () => {
    expect(sampleName(1_000_000, 52_341_118)).toBe('Sample: 1,000,000 of 52,341,118 rows')
    expect(sampleName(1, 1)).toBe('Sample: 1 of 1 row')
  })
  it('offers a million rows, or fewer that fit half the memory free, rounded to two figures', () => {
    expect(defaultSampleRows(52_341_118, undefined, undefined)).toBe(1_000_000)
    expect(defaultSampleRows(52_341_118, 100, 50_000_000)).toBe(250_000)
    expect(defaultSampleRows(52_341_118, 100, 47_123_456)).toBe(230_000)
    expect(defaultSampleRows(4_321, 100, undefined)).toBe(4_300)
    expect(defaultSampleRows(57, 100, undefined)).toBe(57)
    expect(defaultSampleRows(0, 100, 10)).toBe(1)
  })
  it('reads the rows typed, separators and all, from 1 to the most a sample takes', () => {
    expect(parseSampleRows('1,000,000', 52_341_118)).toBe(1_000_000)
    expect(parseSampleRows(' 250 000 ', 52_341_118)).toBe(250_000)
    expect(parseSampleRows('1_000', 52_341_118)).toBe(1_000)
    for (const text of ['', '0', '-5', '1.5', '1e6', 'abc', '10,000,001', '1234567890']) expect(parseSampleRows(text, 52_341_118), text).toBeUndefined()
    expect(parseSampleRows('5,000', 4_000)).toBeUndefined()
    expect(maxSampleRows(52_341_118)).toBe(10_000_000)
    expect(maxSampleRows(4_000)).toBe(4_000)
    expect(rowBytesOf(5_000, 50)).toBe(100)
    expect(rowBytesOf(undefined, 50)).toBeUndefined()
  })
  it('says what a sample costs to make and the memory it needs', () => {
    const first = sampleNote({ method: 'first', rows: 1_000, rowBytes: 2_097_152, freeBytes: 4_194_304_000, prices: true })
    expect(first).toContain('The first rows are free')
    expect(first).toContain('needs about 2,000 MB of result memory, of 4,000 MB free.')
    expect(sampleNote({ method: 'random', rows: 1_000, rowBytes: undefined, freeBytes: undefined, prices: true })).toBe('Estimating what the random sample processes…')
    expect(sampleNote({ method: 'random', rows: undefined, rowBytes: undefined, freeBytes: undefined, prices: true })).toBe('The random sample is estimated once the rows are a number in range.')
    expect(sampleNote({ method: 'random', rows: 1_000, rowBytes: undefined, freeBytes: undefined, prices: true, estimate: { state: 'failed', reason: 'No.' } })).toBe('The random sample could not be estimated: No.')
    const priced = sampleNote({ method: 'random', rows: 1_000, rowBytes: undefined, freeBytes: undefined, prices: true, estimate: { state: 'done', bytes: 2 ** 40, incomplete: true } })
    expect(priced).toBe('The random sample processes about 1.00 TiB (about $6.25), which may be low. BigQuery bills only the blocks it reads.')
    expect(sampleNote({ method: 'random', rows: 1_000, rowBytes: undefined, freeBytes: undefined, prices: false, estimate: { state: 'done', bytes: 2 ** 40, incomplete: false } })).not.toContain('$')
    expect(sampleStatus('first', 1_000, 52_341_118)).toBe('Creates “Sample: 1,000 of 52,341,118 rows”')
    expect(sampleStatus('random', 1_000, 52_341_118)).toBe('Creates a sample of up to 1,000 of 52,341,118 rows')
    expect(sampleTooLarge(1_000, 100, 99_999)).toBe(true)
    expect(sampleTooLarge(1_000, 100, 100_000)).toBe(false)
    expect(sampleTooLarge(1_000, undefined, 1)).toBe(false)
  })
})

describe('the windowed strip\'s offers', () => {
  it('offers Load sample… beside the note that the result is too large to load, and Stop while a sample or re-run runs', () => {
    expect(loadOffer({ loading: '', loadable: false, other: windowedFullText, stopping: false, sampleable: true })).toBe('sample')
    expect(loadOffer({ loading: '', loadable: false, other: windowedFullText, stopping: false, sampleable: false })).toBeUndefined()
    expect(loadOffer({ loading: '', loadable: true, other: windowedText, stopping: false, sampleable: true })).toBe('load')
    expect(loadOffer({ loading: '', loadable: false, other: windowedFullText, stopping: true, sampleable: true })).toBeUndefined()
    for (const loading of ['sample', 'rerun']) expect(loadOffer({ loading, loadable: false, other: undefined, stopping: false })).toBe('stop')
    for (const loading of ['sampleStopping', 'rerunStopping']) expect(loadOffer({ loading, loadable: true, other: windowedText, stopping: false, sampleable: true })).toBeUndefined()
    expect(windowedFullText).toContain('load a sample')
  })
  it('says what runs over the result and that it is stopping', () => {
    expect(loadingState(undefined)).toBe('')
    expect(loadingState({ stopping: false })).toBe('loading')
    expect(loadingState({ stopping: true })).toBe('stopping')
    expect(loadingState({ stopping: false, kind: 'sample' })).toBe('sample')
    expect(loadingState({ stopping: true, kind: 'rerun' })).toBe('rerunStopping')
    expect(loadingText('sample', { rowsAvailable: 0 })).toBe('Loading a sample from BigQuery into a new result…')
    expect(loadingText('sampleStopping', { rowsAvailable: 0 })).toBe('Stopping the sample.')
    expect(loadingText('rerun', { rowsAvailable: 0 })).toBe('Running the query again in BigQuery: the result is replaced when it finishes.')
    expect(loadingText('rerunStopping', { rowsAvailable: 0 })).toBe('Stopping the re-run: the result stays as it was.')
  })
})

/** A promise the test settles either way. */
function settle<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const estimate = (patch: Partial<BigQueryDryRunResult> = {}): BigQueryDryRunResult => ({ bytesProcessed: 1024, ...patch } as BigQueryDryRunResult)

describe('remote views of a sample and a rerun', () => {
  function views() {
    const client = fakeResultClient()
    const api = {
      remoteQuery: vi.fn<VariaApi['remoteQuery']>(async () => ({ ok: true, value: summaryOf([descriptor(60, { columns, rowsStored: 100, rowsAvailable: 100 })]) })),
      cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } }))
    }
    const asked: RemoteDryRun[] = []
    const remote = new RemoteViews({ api, client, estimate: async (_tabId, value) => { asked.push(value); return estimate() }, newId: () => '00000000-0000-4000-8000-000000000001' })
    return { api, asked, remote, source: client.open(windowed()) }
  }
  it('reads the first rows with no estimate or prompt, and estimates a random sample first', async () => {
    const f = views()
    const sampled = await f.remote.sample('t1', f.source, 100, 'first', new AbortController().signal)
    expect(sampled.resultId).toBe(60)
    expect(f.asked).toEqual([])
    expect(f.api.remoteQuery).toHaveBeenLastCalledWith({ queryId: '00000000-0000-4000-8000-000000000001', resultId: 1, generation: 1, kind: 'sample', rows: 100, method: 'first' })
    await f.remote.sample('t1', f.source, 100, 'random', new AbortController().signal)
    expect(f.asked).toEqual([{ resultId: 1, generation: 1, kind: 'sample', rows: 100, method: 'random' }])
  })
  it('estimates a rerun, and runs nothing when its prompt is declined', async () => {
    const f = views()
    await f.remote.rerun('t1', f.source, new AbortController().signal)
    expect(f.asked).toEqual([{ resultId: 1, generation: 1, kind: 'rerun' }])
    expect(f.api.remoteQuery).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'rerun' }))
    const declined = new RemoteViews({ api: f.api, client: fakeResultClient(), estimate: async () => undefined })
    f.api.remoteQuery.mockClear()
    await expect(declined.rerun('t1', f.source, new AbortController().signal)).rejects.toBeInstanceOf(RemoteDeclined)
    expect(f.api.remoteQuery).not.toHaveBeenCalled()
  })
})

function serviceFixture(o: { total?: number, name?: string } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}), remoteQuery: vi.fn<VariaApi['remoteQuery']>(), cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } }))
  }
  const signals: AbortSignal[] = []
  const answers: ReturnType<typeof settle<ResultDescriptor>>[] = []
  const answer = (signal: AbortSignal) => { signals.push(signal); const next = settle<ResultDescriptor>(); answers.push(next); return next.promise }
  const remote = {
    sample: vi.fn<RemoteViews['sample']>(async (_tabId, _source, _rows, _method, signal) => answer(signal)),
    rerun: vi.fn<RemoteViews['rerun']>(async (_tabId, _source, signal) => answer(signal))
  }
  const service = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, remote: remote as unknown as RemoteViews, memory: () => ({ usedBytes: 1_000, globalBytes: 1_000_000 }) })
  const total = o.total ?? 52_341_118
  service.begin('t1', 'q1')
  service.finish('t1', 'q1', { summary: summaryOf([{ ...windowed(1, total), ...o.name ? { name: o.name } : {} }, descriptor(2, { index: 1, columns })]) })
  const key = service.getSnapshot().t1!.sets[0].key
  const tab = () => service.getSnapshot().t1!
  return { client, service, remote, key, tab, api, signals, answers, timers }
}

describe('Load sample in the results service', () => {
  it('reads a sample into a new result after its source\'s group, named for what it holds, with the focus', async () => {
    const f = serviceFixture()
    expect(f.service.canLoadSample('t1', f.key)).toBe(true)
    expect(f.service.sampleSource('t1', f.key)).toEqual({ name: 'Result 1', resultId: 1, generation: 1, total: 52_341_118, projectedBytes: 5_234_111_800, freeBytes: 999_000 })
    const loading = f.service.loadSample('t1', f.key, 1_000, 'random')
    await vi.waitFor(() => expect(f.remote.sample).toHaveBeenCalled())
    expect(f.remote.sample.mock.calls[0].slice(2, 4)).toEqual([1_000, 'random'])
    expect(f.tab().loads?.get(f.key)).toEqual(expect.objectContaining({ kind: 'sample', stopping: false }))
    expect(f.service.canLoadSample('t1', f.key)).toBe(false)
    expect(await f.service.loadSample('t1', f.key, 10, 'first')).toBe('This result is already loading or running again in BigQuery. Wait for it, or stop it first.')
    f.answers[0].resolve(descriptor(60, { columns, rowsStored: 980, rowsAvailable: 980, residence: 'memory' }))
    expect(await loading).toBeUndefined()
    const sets = f.tab().sets
    const sample = sets[1]
    expect(sets.map(set => set.descriptor.resultId)).toEqual([1, 60, 2])
    expect(sample).toMatchObject({ label: 'Sample: 980 of 52,341,118 rows', sample: true, number: 3, ordinal: -1 })
    expect(entryName(sample)).toBe('Sample: 980 of 52,341,118 rows')
    expect(resultTitle(sample)).toBe('Sample: 980 of 52,341,118 rows')
    // Its group is numbered below the query's own, so no state the next run carries by group reaches its results.
    expect(groupOf(f.tab(), sample.key)).toMatchObject({ ordinal: -1, table: { key: sample.key } })
    expect(f.tab().focused).toBe(sample.key)
    expect(f.tab().loads).toBeUndefined()
    expect(f.service.canLoadSample('t1', f.key)).toBe(true)
    f.service.dispose()
  })
  it('names a second sample of one size apart by its number, and puts it after the first', async () => {
    const f = serviceFixture()
    for (const id of [60, 61]) {
      const loading = f.service.loadSample('t1', f.key, 1_000, 'first')
      await vi.waitFor(() => expect(f.answers.length).toBe(id - 59))
      f.answers.at(-1)!.resolve(descriptor(id, { columns, rowsStored: 1_000, rowsAvailable: 1_000, residence: 'memory' }))
      expect(await loading).toBeUndefined()
    }
    const sets = f.tab().sets
    expect(sets.map(set => set.descriptor.resultId)).toEqual([1, 60, 61, 2])
    expect(sets.map(set => set.label)).toEqual([undefined, 'Sample: 1,000 of 52,341,118 rows', 'Sample: 1,000 of 52,341,118 rows (Result 4)', undefined])
    expect(sets.map(set => set.ordinal)).toEqual([1, -1, -2, 2])
    f.service.dispose()
  })
  it('never gives a later run’s sample the group of an earlier one', async () => {
    const f = serviceFixture()
    const first = f.service.loadSample('t1', f.key, 10, 'first')
    await vi.waitFor(() => expect(f.answers.length).toBe(1))
    f.answers[0].resolve(descriptor(60, { columns, rowsStored: 10, rowsAvailable: 10, residence: 'memory' }))
    await first
    expect(f.tab().sets[1].ordinal).toBe(-1)
    f.service.begin('t1', 'q2')
    f.service.finish('t1', 'q2', { summary: summaryOf([{ ...windowed(3), index: 0 }, descriptor(4, { index: 1, columns })]) })
    const again = f.service.loadSample('t1', f.tab().sets.find(set => set.descriptor.resultId === 3)!.key, 10, 'first')
    await vi.waitFor(() => expect(f.answers.length).toBe(2))
    f.answers[1].resolve(descriptor(61, { columns, rowsStored: 10, rowsAvailable: 10, residence: 'memory' }))
    await again
    expect(f.tab().sets.map(set => [set.descriptor.resultId, set.ordinal])).toEqual([[3, 1], [61, -2], [4, 2]])
    f.service.dispose()
  })
  it('closes the dialog once its result can no longer be sampled', () => {
    const f = serviceFixture()
    const dialog = new SampleDialogService(f.service)
    expect(dialog.open('t1', f.key)).toBe(true)
    expect(dialog.getSnapshot().request).toMatchObject({ key: f.key, total: 52_341_118 })
    f.service.removeEntry('t1', f.key)
    expect(dialog.getSnapshot().request).toBeUndefined()
    dialog.dispose()
    f.service.dispose()
  })
  it('stops a sample through its signal, and says nothing of it', async () => {
    const f = serviceFixture()
    const loading = f.service.loadSample('t1', f.key, 1_000, 'first')
    await vi.waitFor(() => expect(f.signals.length).toBe(1))
    f.service.stopLoad('t1', f.key)
    expect(f.signals[0].aborted && f.signals[0].reason).toBe(remoteStop)
    expect(f.tab().loads?.get(f.key)).toEqual(expect.objectContaining({ kind: 'sample', stopping: true }))
    const before = f.tab().messages.length
    f.answers[0].reject(new RemoteDeclined())
    await loading
    expect(f.tab().messages.length).toBe(before)
    expect(f.tab().sets.length).toBe(2)
    expect(f.tab().loads).toBeUndefined()
    f.service.dispose()
  })
  it('releases a sample that answers after its source closed, and gives up the run\'s samples with the tab', async () => {
    const f = serviceFixture()
    const loading = f.service.loadSample('t1', f.key, 1_000, 'first')
    await vi.waitFor(() => expect(f.signals.length).toBe(1))
    f.service.removeEntry('t1', f.key)
    // Closing the source gives up its sample at once, whatever the backend still answers.
    expect(f.signals[0].aborted).toBe(true)
    expect(f.tab().loads).toBeUndefined()
    f.answers[0].resolve(descriptor(60, { columns, rowsStored: 1_000, rowsAvailable: 1_000 }))
    await loading
    expect(f.client.release).toHaveBeenCalledWith([{ generation: 1, resultId: 60 }])
    expect(f.tab().sets.map(set => set.descriptor.resultId)).toEqual([2])
    const other = serviceFixture()
    void other.service.loadSample('t1', other.key, 1_000, 'first')
    await vi.waitFor(() => expect(other.signals.length).toBe(1))
    other.service.release('t1')
    expect(other.signals[0].aborted).toBe(true)
    f.service.dispose()
    other.service.dispose()
  })
  it('says why a sample failed, and refuses one while its query runs', async () => {
    const f = serviceFixture()
    const loading = f.service.loadSample('t1', f.key, 1_000, 'random')
    await vi.waitFor(() => expect(f.answers.length).toBe(1))
    f.answers[0].reject(new Error('BigQuery no longer has this result.'))
    await loading
    expect(f.tab().messages.at(-1)).toEqual({ text: 'Could not load a sample: BigQuery no longer has this result.', kind: 'error' })
    const running = serviceFixture()
    running.service.begin('t1', 'q2')
    running.client.emit('q2', { type: 'resultSet.opened', descriptor: windowed(5) })
    const opened = running.tab().sets[0].key
    expect(running.service.canLoadSample('t1', opened)).toBe(false)
    expect(await running.service.loadSample('t1', opened, 10, 'first')).toBe('Load a sample of the result once its query has finished.')
    f.service.dispose()
    running.service.dispose()
  })
})

describe('Re-run in the results service', () => {
  it('replaces the result where it is, keeping its key and number, and releases the old one', async () => {
    const f = serviceFixture({ total: 5_000 })
    const old = f.tab().sets[0]
    const running = f.service.rerun('t1', f.key)
    await vi.waitFor(() => expect(f.remote.rerun).toHaveBeenCalled())
    expect(f.tab().loads?.get(f.key)).toEqual(expect.objectContaining({ kind: 'rerun' }))
    f.answers[0].resolve(windowed(70, 5_000))
    expect(await running).toBeUndefined()
    const replaced = f.tab().sets[0]
    expect(replaced).toMatchObject({ key: f.key, number: old.number, ordinal: old.ordinal })
    expect(replaced.descriptor.resultId).toBe(70)
    expect(f.tab().sets.map(set => set.descriptor.resultId)).toEqual([70, 2])
    await vi.waitFor(() => expect(f.client.release).toHaveBeenCalledWith([{ generation: 1, resultId: 1 }]))
    expect(f.tab().loads).toBeUndefined()
    f.service.dispose()
  })
  it('keeps the name the query gave its result', async () => {
    const f = serviceFixture({ total: 5_000, name: 'Open orders' })
    const running = f.service.rerun('t1', f.key)
    await vi.waitFor(() => expect(f.answers.length).toBe(1))
    f.answers[0].resolve(windowed(70, 5_000))
    expect(await running).toBeUndefined()
    expect(f.tab().sets[0].descriptor).toMatchObject({ resultId: 70, name: 'Open orders' })
    expect(entryName(f.tab().sets[0])).toBe('Open orders')
    f.service.dispose()
  })
  it('stops a re-run, leaving the result as it was', async () => {
    const f = serviceFixture()
    const running = f.service.rerun('t1', f.key)
    await vi.waitFor(() => expect(f.signals.length).toBe(1))
    f.service.stopLoad('t1', f.key)
    expect(f.signals[0].reason).toBe(remoteStop)
    // Its strip is a status that says it is stopping (loadingText 'rerunStopping'), so nothing is announced besides.
    f.timers.advance(1_000)
    expect(f.tab().announcement ?? '').not.toContain('Stopping')
    expect(f.tab().loads?.get(f.key)).toEqual(expect.objectContaining({ kind: 'rerun', stopping: true }))
    f.answers[0].reject(new RemoteDeclined())
    await running
    expect(f.tab().sets[0].descriptor.resultId).toBe(1)
    f.service.dispose()
  })
})

describe('Load sample\'s dialog', () => {
  it('opens for a result that can be sampled, with what it needs, and not otherwise', () => {
    const source = { name: 'Result 1', resultId: 1, generation: 1, total: 5_000, projectedBytes: 500_000, freeBytes: 10_000 }
    const results = { sampleSource: vi.fn((_tabId: string, key: string) => key === 'k1' ? source : undefined), subscribe: () => () => {} }
    const dialog = new SampleDialogService(results)
    expect(dialog.open('t1', 'k2')).toBe(false)
    expect(dialog.getSnapshot().request).toBeUndefined()
    expect(dialog.open('t1', 'k1')).toBe(true)
    expect(dialog.getSnapshot().request).toEqual({ tabId: 't1', key: 'k1', name: 'Result 1', resultId: 1, generation: 1, total: 5_000, rowBytes: 100, freeBytes: 10_000 })
    dialog.close()
    expect(dialog.getSnapshot().request).toBeUndefined()
    dialog.dispose()
  })
})
