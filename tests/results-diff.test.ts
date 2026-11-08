import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { cellMarksOf } from '../src/renderer/src/grid/GridView'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { CompareService, compareText } from '../src/renderer/src/results/CompareService'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results)
  /** Runs a query of `count` complete sets (results 1 to count); `finish: false` leaves it running. */
  let next = 1
  const run = (count: number, o: { finish?: boolean; queryId?: string } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    if (o.finish !== false) void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.handle as FakeHandle)
  }
  return { client, results, compare, run }
}

describe('result diffs', () => {
  it('compares a set with the one before it, appends the diff as the run\'s last set, and says what was compared', async () => {
    const { results, compare, run } = fixture()
    const [first, second] = run(2)
    expect(compare.canCompare('t1', 1)).toBe(true)
    expect(compare.canCompare('t1', 0)).toBe(false)
    await compare.compare('t1', 1)
    await settle()
    expect(first.diff).toHaveBeenCalledWith(second, { exact: false, signal: expect.any(AbortSignal) })
    const sets = results.getSnapshot().t1.sets
    expect(sets).toHaveLength(3)
    expect(sets[2]).toMatchObject({ index: 2, label: 'Differences: Result 1 → Result 2', descriptor: { kind: 'diff', resultId: 901 } })
    expect(results.getSnapshot().t1.settled.get(setKey(sets[2].descriptor))).toEqual({ rows: 3, strip: true })
    const info = compare.getSnapshot().get(setKey(sets[2].descriptor))!
    expect(info).toMatchObject({ left: 0, right: 1, key: 'Id', changed: 1, added: 1, removed: 0, same: 1 })
    expect(compareText(info)).toBe('Result 1 → Result 2, rows matched by Id: 1 changed row, 1 added row, 0 removed rows, 1 unchanged.')
    expect(compareText({ ...info, key: null, exact: true, soft: 2, leftOnly: ['Old'], rightOnly: ['New'] }))
      .toBe('Result 1 → Result 2, whole rows matched, text compared exactly: 1 changed row, 1 added row, 0 removed rows, 1 unchanged. 2 values differ only by collation (case or trailing spaces), underlined. Not compared: Old (Result 1), New (Result 2).')
    // A diff is not compared again, nor is a set whose previous one is the diff.
    expect(compare.canCompare('t1', 2)).toBe(false)
  })

  it('compares nothing while the query runs, says why a comparison failed, and keeps only diffs a run still shows', async () => {
    const { results, compare, run } = fixture()
    run(2, { finish: false })
    expect(compare.canCompare('t1', 1)).toBe(false)
    const [first] = run(2, { queryId: 'q2' })
    const notify = vi.spyOn(results, 'notify')
    vi.mocked(first.diff).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to compare these results. Close other results and try again.'))
    await compare.compare('t1', 1)
    expect(notify).toHaveBeenCalledWith('t1', 'There is not enough result memory to compare these results. Close other results and try again.')
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    await compare.compare('t1', 1)
    expect(compare.getSnapshot().size).toBe(1)
    run(2, { queryId: 'q3' })
    await compare.compare('t1', 1)
    expect(compare.getSnapshot().size).toBe(1)
  })

  it('reads a diff row\'s differing cells from its tone text', () => {
    expect(cellMarksOf('')).toBeUndefined()
    expect(cellMarksOf('x')).toBeUndefined()
    const marks = cellMarksOf('4 ~6 x')!
    expect([...marks.keys()]).toEqual([4, 6])
    expect(marks.get(4)).not.toBe(marks.get(6))
  })
})
