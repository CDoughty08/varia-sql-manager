import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { colorAt, highlightColors, type RowHighlights } from '../src/renderer/src/grid/highlights'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import type { ResultHandle, ResultView } from '../src/renderer/src/results/ResultClient'
import { HighlightsService, highlightLimits, highlightText, mergeRows, trackedColumn } from '../src/renderer/src/results/HighlightsService'
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
  const highlights = new HighlightsService(results, { timers: timers.timers })
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
    const view = { ...third, base: third, viewId: 4, keys: [], rows: 1, baseRows: 1, complete: true, approximate: false, findRows: vi.fn<ResultHandle['findRows']>(async () => ({ positions: [0], marks: [0], truncated: false, rows: 1 })) } as unknown as ResultView
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
    // Several of the name, none where it was: ambiguous (-2), not missing (-1).
    expect(trackedColumn([column('Name', 'nvarchar'), column('ID'), column('X'), column('ID')], { column: 'ID', dataType: 'int', ordinal: 0 })).toBe(-2)
    expect(highlightText({ count: 2, found: 0, unique: true, truncated: false, rows: [], lacks: 'ID', ambiguous: true }))
      .toBe('2 highlights follow ID, which these results have more than once, in other places. Clear All Highlights to highlight rows here.')
    expect(trackedColumn([column('Name', 'nvarchar'), column('ID')], { column: 'ID', dataType: 'int', ordinal: 0 })).toBe(1)
    expect(trackedColumn([column('ID', 'nvarchar')], { column: 'ID', dataType: 'int', ordinal: 0 })).toBe(-1)
    // A re-run that widens the column keeps following it: the backend hashes its values alike.
    expect(trackedColumn([column('Code', 'nvarchar(60)')], { column: 'Code', dataType: 'nvarchar(50)', ordinal: 0 })).toBe(0)
    expect(trackedColumn([column('Price', 'decimal(12,4)')], { column: 'Price', dataType: 'decimal(10,2)', ordinal: 0 })).toBe(0)
    // A change of precision that changes the values themselves (time rounded to whole seconds) is a different column.
    expect(trackedColumn([column('At', 'datetime2(0)')], { column: 'At', dataType: 'datetime2(7)', ordinal: 0 })).toBe(-1)
    expect(trackedColumn([column('At', 'DateTime2(7)')], { column: 'At', dataType: 'datetime2(7)', ordinal: 0 })).toBe(0)
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
    vi.mocked(second.findRows).mockRejectedValue(Object.assign(new Error('Tell the rows apart first.'), { code: 'IDENTITY_NOT_FOUND' }))
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

  it('tries a search that failed with a passing error again after a backoff, and again when the user highlights', async () => {
    const { results, highlights, run, shown, timers } = fixture()
    run(1)
    results.setSelection('t1', 0, rows(0, 1, 1))
    await highlights.highlight('t1', 0, 2)
    const notify = vi.spyOn(results, 'notify')
    const second = run(2, 6, 'q2')
    vi.mocked(second.findRows).mockRejectedValue(Object.assign(new Error('The backend is busy.'), { code: 'BUSY' }))
    await settle()
    expect(second.findRows).toHaveBeenCalledTimes(1)
    // Each retry waits longer; after the last the error is said, and nothing more is tried.
    for (const ms of highlightLimits.retryMs) {
      // Nothing is said while a retry is still to come.
      expect(notify).not.toHaveBeenCalled()
      timers.advance(ms)
      await settle()
    }
    expect(second.findRows).toHaveBeenCalledTimes(1 + highlightLimits.retryMs.length)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('t1', 'Could not find the highlighted rows: The backend is busy.')
    timers.advance(60_000)
    await settle()
    expect(second.findRows).toHaveBeenCalledTimes(1 + highlightLimits.retryMs.length)
    // The user acting searches again at once, even when the command changes nothing, and earns a fresh set of retries.
    results.setSelection('t1', 0, undefined)
    await highlights.highlight('t1', 0, 2)
    await settle()
    expect(second.findRows).toHaveBeenCalledTimes(2 + highlightLimits.retryMs.length)
    expect(notify).toHaveBeenCalledTimes(1)
    vi.mocked(second.findRows).mockResolvedValue({ positions: [1], marks: [0], truncated: false, rows: 6 })
    timers.advance(highlightLimits.retryMs[0])
    await settle()
    expect(second.findRows).toHaveBeenCalledTimes(3 + highlightLimits.retryMs.length)
    expect(shown()).toMatchObject({ count: 1, found: 1 })
  })

  it('says when the key column is gone, or more rows match than one search draws', async () => {
    const { results, highlights, run, shown, client } = fixture()
    run(1)
    results.setSelection('t1', 0, rows(0, 1, 2))
    await highlights.highlight('t1', 0, 1)
    // Re-run without the Id column highlights follow: nothing can be found, and the strip and the command say why.
    results.begin('t1', 'q2')
    const value = descriptor(2, { index: 0, rowsRead: 5, rowsStored: 5, rowsAvailable: 5, columns: [{ name: 'Name', dataType: 'nvarchar', wire: 'text', nullable: true }] })
    client.emit('q2', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q2', { summary: summaryOf([value]) })
    await settle()
    const second = results.getSnapshot().t1.sets[0].handle as FakeHandle
    expect(second.identify).not.toHaveBeenCalled()
    expect(shown()).toMatchObject({ count: 2, lacks: 'Id' })
    expect(highlightText(shown())).toBe('2 highlights follow Id, which these results lack. Clear All Highlights to highlight rows here.')
    const notify = vi.spyOn(results, 'notify')
    results.setSelection('t1', 0, rows(0, 0, 0))
    await highlights.highlight('t1', 0, 1)
    expect(notify).toHaveBeenCalledWith('t1', '2 highlights follow Id, which these results lack. Clear All Highlights to highlight rows here.')
    // A search that lists only the first matches says so instead of calling the rest missing.
    const third = run(3, 10, 'q3')
    vi.mocked(third.findRows).mockResolvedValue({ positions: [1], marks: [0], truncated: true, rows: 10 })
    await settle()
    expect(shown()).toMatchObject({ truncated: true, found: 1 })
    expect(highlightText(shown())).toBe('More than 100,000 rows have these highlights; only the first 100,000 are drawn.')
  })

  it('keeps highlights on their entries when a middle entry goes: an original result\'s by its number, a derived entry\'s by the entry', async () => {
    const { client, results, highlights } = fixture()
    /** A run of three sets of ten rows: results `first` to `first + 2`. */
    const three = (queryId: string, first: number) => {
      results.begin('t1', queryId)
      const values = [0, 1, 2].map(index => descriptor(first + index, { index, rowsRead: 10, rowsStored: 10, rowsAvailable: 10 }))
      void results.finish('t1', queryId, { summary: summaryOf(values) })
      return values.map(value => client.handle(value.resultId)!)
    }
    const at = (index: number) => highlights.getSnapshot().t1?.get(index)
    const [, , third] = three('q1', 1)
    results.addSet('t1', descriptor(803, { index: 2, kind: 'pivot', rowsRead: 10, rowsStored: 10, rowsAvailable: 10 }), 'Pivot of Result 3', ['1:3'])
    const pivot = client.handle(803)!
    results.setSelection('t1', 2, rows(2, 2, 3))
    await highlights.highlight('t1', 2, 1)
    results.setSelection('t1', 3, rows(3, 5, 5))
    await highlights.highlight('t1', 3, 2)
    await settle()
    expect(at(2)).toMatchObject({ count: 2, found: 2 })
    expect(at(3)).toMatchObject({ count: 1, found: 1 })

    results.removeEntry('t1', results.getSnapshot().t1.sets[1].key)
    await settle()
    // Result 3 and the pivot each moved up a place with their highlights; neither was bound or searched again.
    expect(at(1)).toMatchObject({ count: 2, found: 2 })
    expect(at(1)!.rows.map(item => item.handle)).toEqual([third])
    expect(at(2)).toMatchObject({ count: 1, found: 1 })
    expect(at(2)!.rows.map(item => item.handle)).toEqual([pivot])
    expect(at(3)).toBeUndefined()
    expect(highlights.rowsFor('t1', 1).map(item => item.handle)).toEqual([third])
    expect([1, 2, 3].map(index => highlights.hasHighlights('t1', index))).toEqual([true, true, false])
    expect(third.identify).toHaveBeenCalledTimes(1)
    expect(third.findRows).toHaveBeenCalledTimes(1)
    // A command on the grid at the new place reaches Result 3's highlights.
    results.setSelection('t1', 1, rows(1, 7, 7))
    await highlights.highlight('t1', 1, 1)
    expect(at(1)).toMatchObject({ count: 3, found: 3 })
    expect(at(2)).toMatchObject({ count: 1 })

    // The next run's third result takes Result 3's highlights, though they were last drawn at the second place; the
    // pivot's went with the pivot.
    const [, second, again] = three('q2', 11)
    await settle()
    expect(at(2)).toMatchObject({ count: 3, found: 3 })
    expect(at(2)!.rows.map(item => item.handle)).toEqual([again])
    expect(at(1)).toBeUndefined()
    expect(second.identify).not.toHaveBeenCalled()
    expect(highlights.hasHighlights('t1', 2)).toBe(true)
    highlights.clear('t1', 2)
    await settle()
    expect(highlights.getSnapshot().t1).toBeUndefined()
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
