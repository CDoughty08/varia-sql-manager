import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { PivotService } from '../src/renderer/src/results/PivotService'
import { aggregateFits, columnGroupLimit, draftSpec, emptyDraft, fitDraft, isNumericColumn, pivotFacts, pivotStrip, pivotText, remapDraft, valueLabel } from '../src/renderer/src/results/pivot'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt } from './fixtures/entries'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const column = (name: string, dataType: string, patch: Partial<ResultColumn> = {}): ResultColumn => ({ name, dataType, wire: 'text', nullable: true, ...patch }) as ResultColumn
const columns = [column('Region', 'nvarchar(20)'), column('Year', 'int'), column('Amount', 'decimal(10,2)'), column('Flag', 'bit'), column('Blob', 'varbinary(max)', { wire: 'binary' })]

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const pivot = new PivotService(results)
  let next = 1
  /** Runs a query of `count` complete sets of `columns`; `finish: false` leaves it running. */
  const run = (count: number, o: { finish?: boolean; queryId?: string; columns?: ResultColumn[] } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index, columns: o.columns ?? columns }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    if (o.finish !== false) void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.handle as FakeHandle)
  }
  return { client, results, pivot, run }
}

describe('pivot helpers', () => {
  it('offers Sum and Average only for numbers, names values as a spreadsheet does, and fits a draft to the columns', () => {
    expect(columns.map(isNumericColumn)).toEqual([false, true, true, false, false])
    expect(aggregateFits('sum', columns[0])).toBe(false)
    expect(aggregateFits('avg', columns[2])).toBe(true)
    expect(aggregateFits('max', columns[0])).toBe(true)
    expect(aggregateFits('count', undefined)).toBe(true)
    expect(aggregateFits('min', undefined)).toBe(false)
    expect(valueLabel({ aggregate: 'count' }, columns)).toBe('Count of rows')
    expect(valueLabel({ aggregate: 'countDistinct', column: 1 }, columns)).toBe('Distinct Count of Year')
    expect(valueLabel({ aggregate: 'avg', column: 2 }, columns)).toBe('Average of Amount')
    // Row columns that are gone or repeated drop out, a column group among them goes, and a value that no longer fits counts.
    expect(fitDraft({ rows: [0, 0, 9], column: 0, values: [{ aggregate: 'sum', column: 0 }, { aggregate: 'max', column: 9 }] }, columns))
      .toEqual({ rows: [0], values: [{ aggregate: 'count', column: 0 }, { aggregate: 'count' }] })
    expect(fitDraft({ rows: [], values: [] }, columns)).toEqual(emptyDraft)
    // A diff's tone column is never offered.
    expect(fitDraft({ rows: [1], values: [{ aggregate: 'count' }] }, [columns[0], column('', 'tinyint', { role: 'tone' } as Partial<ResultColumn>)]).rows).toEqual([])
    expect(draftSpec({ rows: [1], column: 0, values: [{ aggregate: 'sum', column: 2 }] })).toEqual({ rows: [1], column: 0, values: [{ aggregate: 'sum', column: 2 }] })
    // A draft follows its columns by name when they move; one that is gone drops out when fitted.
    const moved = [columns[2], columns[0], columns[3]]
    const remapped = remapDraft({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count' }] }, columns, moved)
    expect(remapped).toEqual({ rows: [1], column: -1, values: [{ aggregate: 'sum', column: 0 }, { aggregate: 'count' }] })
    expect(fitDraft(remapped, moved)).toEqual({ rows: [1], values: [{ aggregate: 'sum', column: 0 }, { aggregate: 'count' }] })
    // Columns sharing a name map by their place among them: the second Id stays the second Id.
    const ids = [column('Id', 'int'), column('Name', 'nvarchar(20)'), column('Id', 'int')]
    expect(remapDraft({ rows: [2], values: [{ aggregate: 'max', column: 0 }] }, ids, [ids[1], ids[0], ids[2]])).toEqual({ rows: [2], values: [{ aggregate: 'max', column: 1 }] })
    expect(remapDraft({ rows: [2], values: [] }, ids, [ids[0], ids[1]])).toEqual({ rows: [-1], values: [] })
    // The column-group bound the panel names is the backend's (ResultPivoter.ColumnGroupLimit): lower with many values.
    expect([columnGroupLimit(0, 1), columnGroupLimit(1, 2), columnGroupLimit(0, 16), columnGroupLimit(8, 16)]).toEqual([256, 256, 255, 254])
    // The panel counts the rows the pivot reads: the view's when the grid shows one.
    expect(pivotFacts(10_000, undefined)).toBe('10,000 rows')
    expect(pivotFacts(10_000, 300)).toBe('300 rows as sorted and filtered')
  })

  it('says what a pivot read, how many groups it has, and when long values were grouped by a prefix', () => {
    const info = { source: 'e1', sourceLabel: 'Result 1', viewed: false, rows: 1200, rowGroups: 3, columnGroups: 4, approximate: false }
    expect(pivotText(info)).toBe('Pivot of Result 1: 1,200 rows in 3 row groups × 4 column groups.')
    expect(pivotText({ ...info, source: 'e2', sourceLabel: 'Result 2', viewed: true, rows: 1, rowGroups: 1, columnGroups: 0 })).toBe('Pivot of Result 2 (as sorted and filtered): 1 row in 1 row group.')
    expect(pivotText({ ...info, sourceLabel: 'Pivot of Result 1', rows: 2 })).toBe('Pivot of Pivot of Result 1: 2 rows in 3 row groups × 4 column groups.')
    // The strip keeps what the grid's highlights say after it.
    expect(pivotStrip(info, 'Some rows here are identical, so a highlight covers each of them.'))
      .toBe('Pivot of Result 1: 1,200 rows in 3 row groups × 4 column groups. Some rows here are identical, so a highlight covers each of them.')
    expect(pivotStrip(info, undefined)).toBe(pivotText(info))
    expect(pivotText({ ...info, rowGroups: 100_000, columnGroups: 256, approximate: true }))
      .toBe('Pivot of Result 1: 1,200 rows in 100,000 row groups × 256 column groups. Long values were grouped by the part these results keep.')
  })
})

describe('PivotService', () => {
  it("opens on a grid's set, builds the pivot from the draft, appends it as the run's last set, and says what it pivoted", async () => {
    const { results, pivot, run } = fixture()
    const [, second] = run(2)
    expect(pivot.canPivot('t1', keyAt(results, 't1', 1))).toBe(true)
    pivot.open('t1', keyAt(results, 't1', 1))
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: keyAt(results, 't1', 1), draft: emptyDraft, running: false })
    // A draft is fitted to the set: a text Sum becomes a Count of that column.
    pivot.setDraft('t1', { rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'sum', column: 0 }] })
    expect(pivot.getSnapshot().tabs.t1.draft).toEqual({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] })
    await pivot.run('t1')
    await settle()
    expect(second.pivot).toHaveBeenCalledWith({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] }, { signal: expect.any(AbortSignal) })
    const sets = results.getSnapshot().t1.sets
    expect(sets).toHaveLength(3)
    expect(sets[2]).toMatchObject({ number: 3, label: 'Pivot of Result 2', descriptor: { kind: 'pivot', resultId: 802 } })
    expect(pivot.getSnapshot().info.get(setKey(sets[2].descriptor))).toEqual({ source: keyAt(results, 't1', 1), sourceLabel: 'Result 2', viewed: false, rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    expect(pivot.getSnapshot().tabs.t1.running).toBe(false)
    // A pivot can be pivoted again; closing the panel keeps its draft for the next open on the same set.
    expect(pivot.canPivot('t1', keyAt(results, 't1', 2))).toBe(true)
    pivot.close('t1')
    expect(pivot.getSnapshot().tabs.t1.open).toBe(false)
    pivot.open('t1', keyAt(results, 't1', 1))
    expect(pivot.getSnapshot().tabs.t1.draft.rows).toEqual([0])
  })

  it('follows the entry it pivots and not its place: when a middle entry goes, and by its number into the next run', async () => {
    const { results, pivot, run } = fixture()
    const [, , third] = run(3)
    const sets = () => results.getSnapshot().t1.sets
    pivot.open('t1', keyAt(results, 't1', 2))
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    results.removeEntry('t1', sets()[1].key)
    // Result 3 moved up a place: the panel is still on it, with its draft.
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: keyAt(results, 't1', 1), draft: { rows: [0] } })
    await pivot.run('t1')
    await settle()
    expect(third.pivot).toHaveBeenCalledOnce()
    // The pivot is named after its source's number, and numbered after the run's highest, whatever places they have.
    expect(sets()[2]).toMatchObject({ number: 4, label: 'Pivot of Result 3', descriptor: { kind: 'pivot', resultId: 803 } })
    expect(pivot.getSnapshot().info.get(setKey(sets()[2].descriptor))).toMatchObject({ source: keyAt(results, 't1', 1), sourceLabel: 'Result 3' })
    // A derived entry is followed by its key.
    pivot.setSource('t1', keyAt(results, 't1', 2))
    results.removeEntry('t1', sets()[0].key)
    expect(pivot.getSnapshot().tabs.t1.source).toBe(keyAt(results, 't1', 1))
    expect(sets()[1].label).toBe('Pivot of Result 3')
    // When the entry it pivots goes, the panel moves to the first set it can pivot, not to whatever took its place.
    run(3, { queryId: 'q0' })
    pivot.setSource('t1', keyAt(results, 't1', 1))
    results.removeEntry('t1', sets()[1].key)
    expect(pivot.getSnapshot().tabs.t1.source).toBe(keyAt(results, 't1', 0))
    expect(sets()[0]).toMatchObject({ ordinal: 1 })
    results.removeEntry('t1', sets()[0].key)
    // An original result is followed by its number into the next run: Result 3, though it stood first when the run began.
    pivot.setSource('t1', keyAt(results, 't1', 0))
    expect(sets()[0]).toMatchObject({ ordinal: 3 })
    run(3, { queryId: 'q2' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: keyAt(results, 't1', 2), draft: { rows: [0] } })
    expect(sets()[2]).toMatchObject({ ordinal: 3 })
  })

  it("pivots nothing while the query runs, shows why a pivot failed, and keeps a new run's panel on its set", async () => {
    const { results, pivot, run } = fixture()
    run(2, { finish: false })
    expect(pivot.canPivot('t1', keyAt(results, 't1', 0))).toBe(false)
    const [first] = run(2, { queryId: 'q2' })
    pivot.open('t1', keyAt(results, 't1', 0))
    vi.mocked(first.pivot).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, error: 'There is not enough result memory to pivot these rows. Close other results and try again.' })
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    // Editing the draft clears the failure; a new run keeps the draft and points the panel at its first set.
    pivot.setSource('t1', keyAt(results, 't1', 1))
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    run(2, { queryId: 'q3' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: keyAt(results, 't1', 1), draft: { rows: [1] }, running: false })
    // A run without that set starts the panel on its first set.
    run(1, { queryId: 'q4' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: keyAt(results, 't1', 0), draft: { rows: [1] } })
    // A closed tab forgets its panel.
    results.release('t1')
    expect(pivot.getSnapshot().tabs.t1).toBeUndefined()
  })

  it("keeps a draft on its columns by name when a re-run moves them, and says why a pivot its run refused was not added", async () => {
    const { results, pivot, run } = fixture()
    run(1)
    pivot.open('t1', keyAt(results, 't1', 0))
    pivot.setDraft('t1', { rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }] })
    // The query now returns Amount, Region and Year: the draft still groups by Region and Year and sums Amount.
    const [moved] = run(1, { queryId: 'q2', columns: [columns[2], columns[0], columns[1]] })
    expect(pivot.getSnapshot().tabs.t1.draft).toEqual({ rows: [1], column: 2, values: [{ aggregate: 'sum', column: 0 }] })
    vi.spyOn(results, 'addSet').mockReturnValueOnce(undefined)
    await pivot.run('t1')
    expect(moved.pivot).toHaveBeenCalledWith({ rows: [1], column: 2, values: [{ aggregate: 'sum', column: 0 }] }, { signal: expect.any(AbortSignal) })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, error: 'These results were closed, so the pivot was not added.' })
  })

  it("waits for the grid's sort or filter to be built, and drops a closed pivot's strip", async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(1)
    pivot.open('t1', keyAt(results, 't1', 0))
    const sortOf = vi.spyOn(results, 'sortOf')
    const view = { rows: 3 } as unknown as NonNullable<ReturnType<ResultsService['sortOf']>>['view']
    const sort = { keys: [], filters: [], applied: [], view, sorting: false, approximate: false, stale: false }
    // A filter still being built (or one built while rows streamed, or none yet) would pivot the rows the grid is leaving.
    for (const pending of [{ sorting: true }, { stale: true }, { view: undefined }]) {
      sortOf.mockReturnValue({ ...sort, ...pending })
      expect(pivot.canPivot('t1', keyAt(results, 't1', 0))).toBe(false)
      await pivot.run('t1')
      expect(first.pivot).not.toHaveBeenCalled()
    }
    sortOf.mockRestore()
    await pivot.run('t1')
    expect(pivot.getSnapshot().info.size).toBe(1)
    // Close Results changes no panel, but the closed pivot's strip goes.
    results.closeResults('t1')
    expect(pivot.getSnapshot().info.size).toBe(0)
  })

  it('gives up a pivot a new run replaces, releases its late answer, and keeps strips only for pivots a run still shows', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(1)
    pivot.open('t1', keyAt(results, 't1', 0))
    await pivot.run('t1')
    expect(pivot.getSnapshot().info.size).toBe(1)
    let answer!: (value: Awaited<ReturnType<FakeHandle['pivot']>>) => void
    let signal: AbortSignal | undefined
    vi.mocked(first.pivot).mockImplementationOnce((_spec, o) => { signal = o?.signal; return new Promise(resolve => { answer = resolve }) })
    const pivoting = pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1.running).toBe(true)
    // Only one pivot runs per tab.
    expect(pivot.canPivot('t1', keyAt(results, 't1', 0))).toBe(false)
    run(1, { queryId: 'q2', finish: false })
    expect(signal?.aborted).toBe(true)
    answer({ descriptor: descriptor(990, { index: 1, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    expect(client.released()).toContain(990)
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    // The earlier pivot's run is gone, and its strip with it.
    expect(pivot.getSnapshot().info.size).toBe(0)
  })
})
