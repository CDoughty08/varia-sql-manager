import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { portRequestSchema, transposeResultSchema } from '../src/shared/ipc/port-messages'
import { limits } from '../src/shared/ipc/wire/protocol'
import { EventBus } from '../src/renderer/src/core/events'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { TransposeService, transposable, transposeStrip, transposeText } from '../src/renderer/src/results/TransposeService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const cells = (resultIndex: number, ...blocks: [number, number][]): GridSelection => ({
  resultIndex, blocks: blocks.map(([top, bottom]) => ({ kind: 'cells' as const, anchor: { row: top, column: 1 }, focus: { row: bottom, column: 1 } })), active: { row: blocks[0][0], column: 1 }
})

function fixture(o: { frames?: (() => void)[] } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => { if (o.frames) o.frames.push(callback); else callback() }, timers: timers.timers, newId: () => crypto.randomUUID() })
  const transpose = new TransposeService(results)
  let next = 1
  /** Runs a query of `count` complete sets of 10 rows; `finish: false` leaves it running. */
  const run = (count: number, o: { finish?: boolean; queryId?: string; kind?: 'rows' | 'diff' } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index, rowsRead: 10, rowsStored: 10, rowsAvailable: 10, kind: o.kind ?? 'rows' }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    if (o.finish !== false) void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.handle as FakeHandle)
  }
  return { client, events, results, transpose, run }
}

describe('transpose schemas', () => {
  const backendDescriptor = (columns: number, rows: number, kind = 'transpose') => ({
    resultId: 5, index: 0, batchNumber: 1, iteration: 1, kind, columns: Array.from({ length: columns }, (_, at) => ({ name: at === 0 ? 'Column' : `Row ${at}`, dataType: 'nvarchar(max)', wire: 'text', nullable: true })),
    rowsRead: rows, rowsStored: rows, rowsAvailable: rows, bytesStored: 10, truncatedCells: 0, state: 'complete', incomplete: false
  })

  it('takes a transpose request strictly: positive ranges within the bound and a header column of a page', () => {
    const ok = (request: object) => portRequestSchema.safeParse({ t: 'transpose', rid: 1, generation: 1, resultId: 2, ...request }).success
    expect([ok({}), ok({ viewId: 3, rows: [[0, 1], [9, 4]], headerColumn: 0 }), ok({ rows: Array.from({ length: limits.transpose.maxRanges }, () => [0, 1]) })]).toEqual([true, true, true])
    expect([ok({ rows: [] }), ok({ rows: [[0, 0]] }), ok({ rows: [[-1, 1]] }), ok({ rows: [[0, 1, 2]] }), ok({ rows: Array.from({ length: limits.transpose.maxRanges + 1 }, () => [0, 1]) }),
      ok({ headerColumn: limits.page.maxColumns }), ok({ viewId: 0 }), ok({ extra: 1 })]).toEqual([false, false, false, false, false, false, false, false])
  })

  it("checks a transpose answer's shape: Column and a column per row taken, all text, a row per source column, within the bounds", () => {
    const ok = (answer: object) => transposeResultSchema.safeParse({ descriptor: backendDescriptor(3, 4), rows: 2, transposed: 2, columns: 4, ...answer }).success
    expect(ok({})).toBe(true)
    expect(ok({ rows: 5000, transposed: limits.transpose.maxRows, columns: 4, descriptor: backendDescriptor(limits.transpose.maxRows + 1, 4) })).toBe(true)
    expect([
      ok({ descriptor: backendDescriptor(4, 4) }), ok({ descriptor: backendDescriptor(3, 5) }), ok({ descriptor: backendDescriptor(3, 4, 'pivot') }), ok({ transposed: 3, rows: 2, descriptor: backendDescriptor(4, 4) }),
      ok({ transposed: limits.transpose.maxRows + 1, rows: 5000 }), ok({ columns: 2000, transposed: 2001, rows: 2001, descriptor: backendDescriptor(2002, 2000) }),
      ok({ descriptor: { ...backendDescriptor(3, 4), columns: backendDescriptor(3, 4).columns.map(column => ({ ...column, wire: 'binary' })) } })
    ]).toEqual([false, false, false, false, false, false, false])
  })
})

describe('transpose strip', () => {
  it('says what was transposed, through a view, by selection or header, and how to see rows past the limit', () => {
    const info = { source: 0, sourceLabel: 'Result 1', viewed: false, selected: false, rows: 5, transposed: 5, columns: 3 }
    expect(transposeText(info)).toBe('Transpose of Result 1: 3 columns as rows, 5 rows as columns.')
    expect(transposeText({ ...info, viewed: true, selected: true, rows: 1, transposed: 1, columns: 1, header: 'Name' })).toBe('Transpose of Result 1 (as sorted and filtered): 1 column as rows, 1 selected row as columns, named by Name.')
    expect(transposeText({ ...info, rows: 10_000, transposed: 4095 })).toBe('Transposed the first 4,095 of 10,000 rows; filter or select rows to transpose others.')
    expect(transposeStrip(info, 'Some rows are highlighted.')).toBe('Transpose of Result 1: 3 columns as rows, 5 rows as columns. Some rows are highlighted.')
    expect(transposeStrip(info, undefined)).toBe(transposeText(info))
  })
})

describe('TransposeService', () => {
  it("transposes a grid's set, appends it as the run's last set named after its source, and says what it holds", async () => {
    const { results, transpose, run } = fixture()
    const [, second] = run(2)
    expect(transpose.canTranspose('t1', 1)).toBe(true)
    await transpose.transpose('t1', 1)
    await settle()
    expect(second.transpose).toHaveBeenCalledWith({}, { signal: expect.any(AbortSignal) })
    const sets = results.getSnapshot().t1.sets
    expect(sets).toHaveLength(3)
    expect(sets[2]).toMatchObject({ index: 2, label: 'Transpose of Result 2', descriptor: { kind: 'transpose', resultId: 702 } })
    expect(transpose.getSnapshot().get(setKey(sets[2].descriptor))).toEqual({ source: 1, sourceLabel: 'Result 2', viewed: false, selected: false, rows: 10, transposed: 10, columns: 2 })
    // A transpose can be transposed again; a diff cannot.
    expect(transposable(sets[2])).toBe(true)
    expect(transpose.canTranspose('t1', 2)).toBe(true)
  })

  it('transposes only the selected rows, merged, and names the columns by the active column', async () => {
    const { results, transpose, run } = fixture()
    const [first] = run(1)
    expect(transpose.selectedRows('t1', 0)).toBeUndefined()
    results.setSelection('t1', 0, cells(0, [6, 7], [0, 1], [2, 2], [7, 8]))
    expect(transpose.selectedRows('t1', 0)).toEqual([[0, 3], [6, 3]])
    expect(transpose.activeColumn('t1', 0)).toBe(1)
    await transpose.transpose('t1', 0, { selected: true, header: 0 })
    expect(first.transpose).toHaveBeenCalledWith({ rows: [[0, 3], [6, 3]], headerColumn: 0 }, { signal: expect.any(AbortSignal) })
    const sets = results.getSnapshot().t1.sets
    expect(transpose.getSnapshot().get(setKey(sets[1].descriptor))).toMatchObject({ selected: true, rows: 6, transposed: 6, header: 'Id' })
  })

  it('says why it transposes no selection of more than 256 separate runs of rows', async () => {
    const { results, transpose, run } = fixture()
    const [first] = run(1)
    first.snapshot = { ...first.snapshot, rowsAvailable: 1000, rowsStored: 1000 }
    const runs = Array.from({ length: limits.transpose.maxRanges + 1 }, (_, at) => [2 * at, 2 * at] as [number, number])
    results.setSelection('t1', 0, cells(0, ...runs))
    expect(transpose.selectedRows('t1', 0)).toHaveLength(limits.transpose.maxRanges + 1)
    const notify = vi.spyOn(results, 'notify')
    await transpose.transpose('t1', 0, { selected: true })
    expect(first.transpose).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('t1', 'Transpose takes up to 256 separate runs of selected rows; these are 257. Select fewer runs, or filter the rows and transpose them all.')
  })

  it("transposes nothing while the query runs or of a diff, waits for the grid's sort, and says why one failed", async () => {
    const { results, transpose, run } = fixture()
    run(1, { finish: false })
    expect(transpose.canTranspose('t1', 0)).toBe(false)
    run(1, { queryId: 'q2', kind: 'diff' })
    expect(transpose.canTranspose('t1', 0)).toBe(false)
    const [first] = run(1, { queryId: 'q3' })
    const sortOf = vi.spyOn(results, 'sortOf')
    const view = { rows: 3 } as unknown as NonNullable<ReturnType<ResultsService['sortOf']>>['view']
    const sort = { keys: [], filters: [], applied: [], view, sorting: false, approximate: false, stale: false }
    for (const pending of [{ sorting: true }, { stale: true }, { view: undefined }]) {
      sortOf.mockReturnValue({ ...sort, ...pending })
      expect(transpose.canTranspose('t1', 0)).toBe(false)
      await transpose.transpose('t1', 0)
      expect(first.transpose).not.toHaveBeenCalled()
    }
    sortOf.mockRestore()
    const notify = vi.spyOn(results, 'notify')
    vi.mocked(first.transpose).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to transpose these rows. Close other results, or select fewer rows, and try again.'))
    await transpose.transpose('t1', 0)
    expect(notify).toHaveBeenCalledWith('t1', 'There is not enough result memory to transpose these rows. Close other results, or select fewer rows, and try again.')
    expect(results.getSnapshot().t1.sets).toHaveLength(1)
  })

  it("releases a transpose with its run's others when the tab closes, and offers none of a backend that was lost", async () => {
    const { client, events, results, transpose, run } = fixture()
    run(1)
    await transpose.transpose('t1', 0)
    const id = results.getSnapshot().t1.sets[1].descriptor.resultId
    events.emit({ type: 'documents.closed', tabId: 't1' })
    expect(client.released()).toEqual(expect.arrayContaining([1, id]))
    expect(results.getSnapshot().t1).toBeUndefined()
    expect(transpose.getSnapshot().size).toBe(0)
    // A new backend lost every result: the transpose (and its source) can be transposed no more.
    run(1, { queryId: 'q2' })
    await transpose.transpose('t1', 0)
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    client.lose()
    expect(results.getSnapshot().t1.sets.map(set => set.handle.getSnapshot().state)).toEqual(['lost', 'lost'])
    expect([transpose.canTranspose('t1', 0), transpose.canTranspose('t1', 1)]).toEqual([false, false])
  })

  it("keeps a new transpose's strip when the results show its set only on the next frame", async () => {
    const frames: (() => void)[] = []
    const { results, transpose, run } = fixture({ frames })
    run(1)
    while (frames.length > 0) frames.shift()!()
    await transpose.transpose('t1', 0)
    while (frames.length > 0) frames.shift()!()
    const sets = results.getSnapshot().t1.sets
    expect(sets).toHaveLength(2)
    expect(transpose.getSnapshot().get(setKey(sets[1].descriptor))).toMatchObject({ sourceLabel: 'Result 1', transposed: 10 })
  })

  it("keeps a new transpose's strip when another tab publishes before the frame that shows its set, and drops it once its tab runs again", async () => {
    const frames: (() => void)[] = []
    const { results, transpose, run } = fixture({ frames })
    run(1)
    while (frames.length > 0) frames.shift()!()
    await transpose.transpose('t1', 0)
    // Another tab starts a query at once: the results publish it now, still without the transpose's set.
    results.begin('t2', 'other')
    expect(transpose.getSnapshot().size).toBe(1)
    while (frames.length > 0) frames.shift()!()
    const sets = results.getSnapshot().t1.sets
    expect(transpose.getSnapshot().get(setKey(sets[1].descriptor))).toMatchObject({ sourceLabel: 'Result 1' })
    // Shown once, the strip goes with its set as any other: a new run in its tab drops it.
    run(1, { queryId: 'q2' })
    while (frames.length > 0) frames.shift()!()
    expect(transpose.getSnapshot().size).toBe(0)
  })

  it('says a transpose runs: its tab is busy from the request to the answer, and subscribers hear both', async () => {
    const { transpose, run } = fixture()
    const [first] = run(1)
    let answer!: (value: Awaited<ReturnType<FakeHandle['transpose']>>) => void
    vi.mocked(first.transpose).mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const heard = vi.fn()
    transpose.subscribe(heard)
    const transposing = transpose.transpose('t1', 0)
    expect([transpose.isRunning('t1'), heard.mock.calls.length]).toEqual([true, 1])
    answer({ descriptor: descriptor(980, { index: 1, kind: 'transpose' }), rows: 10, transposed: 10, columns: 2 })
    await transposing
    expect(transpose.isRunning('t1')).toBe(false)
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('gives up a transpose a new run replaces, releases its late answer, and drops strips of closed transposes', async () => {
    const { client, results, transpose, run } = fixture()
    const [first] = run(1)
    await transpose.transpose('t1', 0)
    expect(transpose.getSnapshot().size).toBe(1)
    // Close Results drops the transpose's strip with the transpose.
    results.closeResults('t1')
    expect(transpose.getSnapshot().size).toBe(0)
    const [again] = run(1, { queryId: 'q2' })
    let answer!: (value: Awaited<ReturnType<FakeHandle['transpose']>>) => void
    let signal: AbortSignal | undefined
    vi.mocked(again.transpose).mockImplementationOnce((_spec, o) => { signal = o?.signal; return new Promise(resolve => { answer = resolve }) })
    const transposing = transpose.transpose('t1', 0)
    // Only one transpose runs per tab.
    expect(transpose.canTranspose('t1', 0)).toBe(false)
    run(1, { queryId: 'q3', finish: false })
    expect(signal?.aborted).toBe(true)
    answer({ descriptor: descriptor(990, { index: 1, kind: 'transpose' }), rows: 1, transposed: 1, columns: 2 })
    await transposing
    expect(client.released()).toContain(990)
    expect(first.transpose).toHaveBeenCalledTimes(1)
    expect(transpose.getSnapshot().size).toBe(0)
  })
})
