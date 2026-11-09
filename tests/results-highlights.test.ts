import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { colorAt, highlightColors, type RowHighlights } from '../src/renderer/src/grid/highlights'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import type { ResultHandle, ResultView } from '../src/renderer/src/results/ResultClient'
import { HighlightsService, highlightLimits, mergeRows, trackedColumn } from '../src/renderer/src/results/HighlightsService'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const rows = (resultIndex: number, top: number, bottom: number): GridSelection => ({
  resultIndex, blocks: [{ kind: 'rows', anchor: { row: top, column: 0 }, focus: { row: bottom, column: 0 } }], active: { row: top, column: 0 }
})

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const highlights = new HighlightsService(results)
  /** Runs the tab's query once more: its one set is result `resultId`, of `count` complete rows. */
  const run = (resultId: number, count = 10, queryId = `q${resultId}`) => {
    results.begin('t1', queryId)
    const value = descriptor(resultId, { index: 0, rowsRead: count, rowsStored: count, rowsAvailable: count })
    client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', queryId, { summary: summaryOf([value]) })
    return results.getSnapshot().t1.sets[0].handle as FakeHandle
  }
  const shown = () => highlights.getSnapshot().t1?.get(0)
  return { client, results, highlights, run, shown, timers }
}

describe('highlights', () => {
  it('finds a row\'s colour by binary search, and merges selected rows into ranges', () => {
    const marks: RowHighlights = { handle: {} as ResultHandle, positions: Float64Array.from([2, 5, 9]), colors: Uint8Array.from([1, 3, 5]) }
    expect([0, 2, 3, 5, 9, 10].map(row => colorAt(marks, row))).toEqual([0, 1, 0, 3, 5, 0])
    expect(colorAt(undefined, 2)).toBe(0)
    expect(mergeRows([[5, 7], [0, 1], [2, 3], [6, 9], [12, 12]])).toEqual([[0, 3], [5, 9], [12, 12]])
    expect(highlightColors).toEqual(['yellow', 'green', 'blue', 'purple', 'red'])
  })

  it('tells the rows apart on the first highlight, colours the selected rows, and turns a colour off when every row has it', async () => {
    const { results, highlights, run, shown } = fixture()
    const handle = run(1)
    results.setSelection('t1', 0, rows(0, 2, 3))
    await highlights.highlight('t1', 0, 1)
    await settle()
    expect(handle.identify).toHaveBeenCalledWith('auto', { signal: expect.any(AbortSignal) })
    expect(handle.rowIds).toHaveBeenCalledWith(2, 2, expect.any(AbortSignal))
    expect(shown()).toMatchObject({ count: 2, found: 2, by: 'Id', unique: true })
    const drawn = shown()!.rows.find(item => item.handle === handle)!
    expect([...drawn.positions]).toEqual([2, 3])
    expect([...drawn.colors]).toEqual([1, 1])
    // Another colour replaces it; the same colour on rows that all have it takes it off.
    results.setSelection('t1', 0, rows(0, 3, 4))
    await highlights.highlight('t1', 0, 3)
    expect([...shown()!.rows[0].colors]).toEqual([1, 3, 3])
    await highlights.highlight('t1', 0, 3)
    expect(shown()).toMatchObject({ count: 1 })
    expect([...shown()!.rows[0].positions]).toEqual([2])
    expect(handle.identify).toHaveBeenCalledTimes(1)
    expect(highlights.hasHighlights('t1', 0)).toBe(true)
    highlights.clear('t1', 0)
    await settle()
    expect(highlights.hasHighlights('t1', 0)).toBe(false)
    expect(shown()).toBeUndefined()
  })

  it('follows its rows into a sorted view and through a re-run, by the column it first followed', async () => {
    const { results, highlights, run, shown, client } = fixture()
    const first = run(1)
    results.setSelection('t1', 0, rows(0, 1, 1))
    await highlights.highlight('t1', 0, 2)
    // A re-run's result: the same identities, found again by the same column.
    const second = run(2, 6, 'q2')
    await settle()
    expect(second.identify).toHaveBeenCalledWith('column', { column: 0, signal: expect.any(AbortSignal) })
    expect(second.findRows).toHaveBeenCalledWith([1001], expect.any(AbortSignal))
    expect(shown()).toMatchObject({ count: 1, found: 1 })
    expect(shown()!.rows.map(item => item.handle)).toEqual([second])
    expect(first.findRows).toHaveBeenCalledTimes(1)
    // A run without the row keeps the highlight, counted as missing.
    const third = run(3, 1, 'q3')
    await settle()
    expect(third.findRows).toHaveBeenCalled()
    expect(shown()).toMatchObject({ count: 1, found: 0 })
    // A sorted view of the set finds its rows by view position.
    const view = { ...third, base: third, viewId: 4, keys: [], rows: 1, complete: true, approximate: false, findRows: vi.fn<ResultHandle['findRows']>(async () => ({ positions: [0], marks: [0], truncated: false, rows: 1 })) } as unknown as ResultView
    vi.mocked(third.sort).mockResolvedValueOnce(view)
    results.sortBy('t1', 0, 0, 'descending')
    await settle()
    expect(view.findRows).toHaveBeenCalledWith([1001], expect.any(AbortSignal))
    expect(shown()!.rows.find(item => item.handle === view)?.positions[0]).toBe(0)
    expect(client.open).toHaveBeenCalledTimes(3)
  })

  it('follows a key column by its position among columns of one name, and finds none rather than guess', async () => {
    const column = (name: string, dataType = 'int') => ({ name, dataType, wire: 'text' as const, nullable: false })
    const ids = [column('ID'), column('ID')]
    expect(trackedColumn(ids, { column: 'ID', dataType: 'int', ordinal: 1 })).toBe(1)
    expect(trackedColumn([column('Name', 'nvarchar'), ...ids], { column: 'ID', dataType: 'int', ordinal: 1 })).toBe(1)
    expect(trackedColumn([column('Name', 'nvarchar'), column('ID'), column('X'), column('ID')], { column: 'ID', dataType: 'int', ordinal: 0 })).toBe(-1)
    expect(trackedColumn([column('Name', 'nvarchar'), column('ID')], { column: 'ID', dataType: 'int', ordinal: 0 })).toBe(1)
    expect(trackedColumn([column('ID', 'nvarchar')], { column: 'ID', dataType: 'int', ordinal: 0 })).toBe(-1)
    // Auto picked the second of two ID columns; the re-run identifies by that one, not the first of the name.
    const { results, highlights, client } = fixture()
    const runWith = (resultId: number) => {
      const queryId = `q${resultId}`
      results.begin('t1', queryId)
      const value = descriptor(resultId, { index: 0, rowsRead: 10, rowsStored: 10, rowsAvailable: 10, columns: ids })
      client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
      void results.finish('t1', queryId, { summary: summaryOf([value]) })
      return results.getSnapshot().t1.sets[0].handle as FakeHandle
    }
    const first = runWith(1)
    vi.mocked(first.identify).mockResolvedValueOnce({ column: 1, unique: true, approximate: false, rows: 10 })
    results.setSelection('t1', 0, rows(0, 1, 1))
    await highlights.highlight('t1', 0, 1)
    const second = runWith(2)
    await settle()
    expect(second.identify).toHaveBeenCalledWith('column', { column: 1, signal: expect.any(AbortSignal) })
  })

  it('does not search again for rows after a failed search until the highlights change', async () => {
    const { results, highlights, run, shown, timers } = fixture()
    run(1)
    results.setSelection('t1', 0, rows(0, 1, 1))
    await highlights.highlight('t1', 0, 2)
    const second = run(2, 6, 'q2')
    vi.mocked(second.findRows).mockRejectedValue(Object.assign(new Error('Too many requests.'), { code: 'TOO_MANY_REQUESTS' }))
    // The failure's notice publishes the results again, now and when it goes; neither searches again.
    for (let i = 0; i < 5; i++) { await settle(); timers.advance(60_000) }
    expect(second.findRows).toHaveBeenCalledTimes(1)
    expect(shown()).toMatchObject({ count: 1, found: 0 })
    // A new highlight is a new version, searched for again.
    vi.mocked(second.findRows).mockReset()
    vi.mocked(second.findRows).mockResolvedValue({ positions: [1, 2], marks: [0, 1], truncated: false, rows: 6 })
    results.setSelection('t1', 0, rows(0, 2, 2))
    await highlights.highlight('t1', 0, 2)
    expect(second.findRows).toHaveBeenCalledTimes(1)
    expect(shown()).toMatchObject({ count: 2, found: 2 })
  })

  it('keeps the whole-row fallback, refuses too many rows at once, and forgets a closed tab', async () => {
    const { results, highlights, run, shown } = fixture()
    const handle = run(1, 20_000)
    vi.mocked(handle.identify).mockResolvedValueOnce({ column: -1, unique: false, approximate: false, rows: 20_000 })
    results.setSelection('t1', 0, rows(0, 0, 0))
    await highlights.highlight('t1', 0, 1)
    expect(shown()).toMatchObject({ by: '', unique: false })
    const notify = vi.spyOn(results, 'notify')
    results.setSelection('t1', 0, rows(0, 0, highlightLimits.rowsPerCommand))
    await highlights.highlight('t1', 0, 1)
    expect(notify).toHaveBeenCalledWith('t1', 'Highlight up to 10,000 rows at a time.')
    const next = run(2, 5, 'q2')
    await settle()
    expect(next.identify).toHaveBeenCalledWith('row', { signal: expect.any(AbortSignal) })
    results.release('t1')
    await settle()
    expect(highlights.getSnapshot().t1).toBeUndefined()
    expect(highlights.canHighlight('t1', 0)).toBe(false)
  })
})
