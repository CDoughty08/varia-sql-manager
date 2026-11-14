import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { pivotGroup, PivotService } from '../src/renderer/src/results/PivotService'
import { aggregateFits, columnGroupLimit, draftSpec, emptyDraft, fitDraft, isNumericColumn, pivotFacts, pivotStrip, pivotText, remapDraft, valueLabel } from '../src/renderer/src/results/pivot'
import { carriedState, resultLimits, ResultsService, setKey, uniqueNames } from '../src/renderer/src/results/ResultsService'
import { DerivedJobs, derivedLimits } from '../src/renderer/src/results/derived-jobs'
import type { ResultHandle, ResultView } from '../src/renderer/src/results/ResultClient'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt } from './fixtures/entries'
import { deferred } from './fixtures/documents'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const column = (name: string, dataType: string, patch: Partial<ResultColumn> = {}): ResultColumn => ({ name, dataType, wire: 'text', nullable: true, ...patch }) as ResultColumn
const columns = [column('Region', 'nvarchar(20)'), column('Year', 'int'), column('Amount', 'decimal(10,2)'), column('Flag', 'bit'), column('Blob', 'varbinary(max)', { wire: 'binary' })]

/** `frames`: the results publish on frames the test runs (`flush`), not at once. */
function fixture(o: { frames?: boolean; jobs?: DerivedJobs } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const queued: (() => void)[] = []
  const results = new ResultsService({ client, api, events, frame: o.frames ? callback => { queued.push(callback) } : callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const pivot = new PivotService(results, o.jobs ? { jobs: o.jobs } : {})
  const flush = () => { for (const frame of queued.splice(0)) frame() }
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
  return { client, api, results, pivot, run, flush }
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

describe('a rebuilt Pivot', () => {
  it('carries over what names a column once in both results, and nothing that names the old rows', () => {
    const named = (...names: string[]) => names.map(name => column(name, 'int'))
    // Region and Year move; Total is named twice in the new result, so it carries nothing; Gone is gone.
    const moved = uniqueNames(named('Region', 'Year', 'Total', 'Gone'), named('Year', 'Region', 'Total', 'Total'))
    expect([...moved]).toEqual([[0, 1], [1, 0]])
    expect([...uniqueNames(named('A', 'A'), named('A'))]).toEqual([])
    const state = {
      topRow: 9, virtualTop: 300, scrollLeft: 40, sized: true, widths: Float64Array.from([70, 80, 90, 100]), userSized: new Set([1, 2]),
      orientation: 'transposed' as const, headerColumn: 0, selection: { anchor: { row: 1, column: 1 } } as never,
      transposed: { topRow: 3, virtualTop: 90, scrollLeft: 12, width: 120, overrides: new Map([[2, 60]]), sized: true, nameWidth: 140 }
    }
    const next = carriedState(state, moved, 4)
    expect({ ...next, widths: [...next.widths!].map(width => Number.isNaN(width) ? 'new' : width), userSized: [...next.userSized!] }).toEqual({
      topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false, widths: [80, 'new', 'new', 'new'], userSized: [0], orientation: 'transposed', headerColumn: 1,
      transposed: { topRow: 0, virtualTop: 0, scrollLeft: 0, width: 120, overrides: new Map(), sized: true, nameWidth: 140 }
    })
    // A table never sized by hand starts fresh, as does a header column whose name is not unique in both.
    expect(carriedState({ topRow: 2, virtualTop: 0, scrollLeft: 0, sized: true, widths: Float64Array.from([50]), headerColumn: 2 }, moved, 4)).toEqual({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
  })
})

describe('PivotService', () => {
  it("opens on a grid's group, builds the pivot from the draft, shows it under the Table as the group's Pivot, and says what it pivoted", async () => {
    const { results, pivot, run } = fixture()
    const [, second] = run(3)
    const table = keyAt(results, 't1', 1)
    expect(pivot.canPivot('t1', table)).toBe(true)
    pivot.open('t1', table)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: table, sourceName: 'Result 2', draft: emptyDraft, running: false })
    expect(pivot.getSnapshot().tabs.t1.pivot).toBeUndefined()
    // A draft is fitted to the Table: a text Sum becomes a Count of that column.
    pivot.setDraft('t1', { rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'sum', column: 0 }] })
    expect(pivot.getSnapshot().tabs.t1.draft).toEqual({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] })
    await pivot.run('t1')
    await settle()
    expect(second.pivot).toHaveBeenCalledWith({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] }, { signal: expect.any(AbortSignal) })
    const tab = results.getSnapshot().t1, sets = tab.sets
    expect(sets).toHaveLength(4)
    // Directly under Result 2, before Result 3; numbered after the run's highest, and named after its Table.
    expect(sets[2]).toMatchObject({ number: 4, label: 'Pivot of Result 2', descriptor: { kind: 'pivot', resultId: 802 } })
    expect(sets[3]).toMatchObject({ ordinal: 3 })
    expect(tab.groups[1]).toMatchObject({ ordinal: 2, table: { key: table, view: 'table' }, pivot: { key: sets[2].key, view: 'pivot', revision: 1, group: 2, sources: [{ key: table, set: setKey(sets[1].descriptor), number: 2, name: 'Result 2', ordinal: 2 }] } })
    expect(pivot.getSnapshot().info.get(setKey(sets[2].descriptor))).toEqual({ source: table, sourceLabel: 'Result 2', viewed: false, rows: 3, rowGroups: 2, columnGroups: 0, approximate: false, partial: false })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, pivot: sets[2].key })
    // The slot records what the build read: its recipe, no filters (it read the stored rows), its rows, and a whole source.
    expect(tab.groups[1].pivot!.pivot).toEqual({ recipe: { rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] }, filters: [], inputRows: 3, truncated: false, incomplete: false, approximate: false })
    // Edit Pivot: opened on the Pivot, the builder starts from its recipe, whatever the draft became since.
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    pivot.open('t1', sets[2].key)
    expect(pivot.getSnapshot().tabs.t1.draft).toEqual({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] })
    // Opened on the Table, it keeps the draft as it is.
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    pivot.open('t1', table)
    expect(pivot.getSnapshot().tabs.t1.draft).toEqual({ rows: [1], values: [{ aggregate: 'count' }] })
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    // Closing the builder keeps the group's draft for the next open, from the Table or from the Pivot (which edits it).
    pivot.close('t1')
    expect(pivot.getSnapshot().tabs.t1.open).toBe(false)
    pivot.open('t1', sets[2].key)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: table, draft: { rows: [0] } })
  })

  it('makes no pivot of a Pivot, a comparison or a plan set, and none in a bare run', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const made = results.getSnapshot().t1.sets[1]
    expect(made.label).toBe('Pivot of Result 1')
    const diff = results.addSet('t1', descriptor(901, { index: 0, kind: 'diff' }), 'Differences: Result 1 → Result 2', [setKey(results.getSnapshot().t1.sets[0].descriptor), setKey(results.getSnapshot().t1.sets[2].descriptor)])!
    // The builder is the group's whichever of its views is named: on the Pivot it edits the Pivot, read from the Table.
    expect(pivotGroup(results.getSnapshot().t1, made.key)?.table.key).toBe(one)
    expect(pivot.canPivot('t1', made.key)).toBe(true)
    // A comparison has no group to pivot.
    expect(pivotGroup(results.getSnapshot().t1, diff)).toBeUndefined()
    expect(pivot.canPivot('t1', diff)).toBe(false)
    // Drawn transposed, the Pivot is still the group's one Pivot: transposed is how a view is drawn, not another view.
    expect(results.setOrientation('t1', made.key, { transposed: true })).toBe(true)
    expect(results.getSnapshot().t1.sets).toHaveLength(4)
    expect(pivotGroup(results.getSnapshot().t1, made.key)?.pivot?.key).toBe(made.key)
    // Opened on one of them, the builder stays on the group it had: what it builds is still read from Result 1.
    pivot.open('t1', diff)
    expect(pivot.getSnapshot().tabs.t1.source).toBe(one)
    vi.mocked(first.pivot).mockClear()
    await pivot.run('t1')
    expect(first.pivot).toHaveBeenCalledOnce()
    expect(client.handle(801)!.pivot).not.toHaveBeenCalled()
    expect(results.getSnapshot().t1.sets.filter(set => set.descriptor.kind === 'pivot')).toHaveLength(1)
    // The service itself takes a pivot only from a group's Table of rows: one made of a Pivot or a comparison is refused
    // and released, whoever asks.
    const sets = results.getSnapshot().t1.sets
    const pivotNow = sets.find(set => set.descriptor.kind === 'pivot')!
    for (const [id, source] of [[811, pivotNow], [812, sets.find(set => set.key === diff)!]] as const) {
      expect(results.addSet('t1', descriptor(id, { index: 0, kind: 'pivot' }), 'Pivot of ' + source.label, [setKey(source.descriptor)])).toBeUndefined()
      expect(client.released()).toContain(id)
    }
    expect(results.addSet('t1', descriptor(814, { index: 0, kind: 'pivot' }), 'Pivot of nothing')).toBeUndefined()
    expect(results.getSnapshot().t1.sets.filter(set => set.descriptor.kind === 'pivot')).toHaveLength(1)

    // A SQL-returned plan set is a group with data operations off.
    results.begin('t1', 'q-plan')
    const plan = descriptor(60, { index: 0, kind: 'executionPlan' }), rows = descriptor(61, { index: 1, columns })
    for (const value of [plan, rows]) client.emit('q-plan', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q-plan', { summary: summaryOf([plan, rows]) })
    const planned = results.getSnapshot().t1
    expect(planned.groups.map(group => [group.ordinal, group.planSet])).toEqual([[1, true], [2, false]])
    expect(pivot.canPivot('t1', planned.sets[0].key)).toBe(false)
    expect(results.addSet('t1', descriptor(860, { index: 0, kind: 'pivot' }), 'Pivot of Result 1', [setKey(plan)])).toBeUndefined()
    // The builder followed Result 1 by number; that is a plan set now, so it moves to the first group it can pivot.
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: planned.sets[1].key, sourceName: 'Result 2' })
    pivot.open('t1', planned.sets[0].key)
    expect(pivot.getSnapshot().tabs.t1.source).toBe(planned.sets[1].key)

    // A bare run (Peek's rows): no builder, no pivot, whoever asks.
    results.begin('peek', 'q-peek', undefined, { bare: true })
    const peeked = descriptor(70, { index: 0, columns })
    client.emit('q-peek', { type: 'resultSet.opened', descriptor: peeked })
    void results.finish('peek', 'q-peek', { summary: summaryOf([peeked]) })
    const bare = results.getSnapshot().peek
    expect(bare.bare).toBe(true)
    expect(pivotGroup(bare, bare.sets[0].key)).toBeUndefined()
    expect(pivot.canPivot('peek', bare.sets[0].key)).toBe(false)
    pivot.open('peek', bare.sets[0].key)
    expect(pivot.getSnapshot().tabs.peek).toBeUndefined()
    expect(results.addSet('peek', descriptor(870, { index: 0, kind: 'pivot' }), 'Pivot of Result 1', [setKey(peeked)])).toBeUndefined()
    expect(results.addSet('peek', descriptor(970, { index: 0, kind: 'diff' }), 'Differences', [setKey(peeked)])).toBeUndefined()
    expect(results.removeEntry('peek', bare.sets[0].key)).toBe(false)
    results.closeResults('peek')
    expect(results.getSnapshot().peek).toMatchObject({ status: 'completed', sets: [{ key: bare.sets[0].key }] })
    expect(client.released()).toEqual(expect.arrayContaining([860, 870, 970]))
    expect(client.released()).not.toContain(70)
  })

  it("replaces a group's Pivot atomically: the old one stays until the new one is built, which takes its slot and key", async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const old = results.getSnapshot().t1.sets[1]
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: old.key, revision: 1 })
    results.focusEntry('t1', old.key)
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(first.pivot).mockImplementationOnce(() => building.promise)
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    const pivoting = pivot.run('t1')
    // While the new one is built the old one is still the group's Pivot, still readable, and still has the focus.
    expect(client.released()).toEqual([])
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: old.key, revision: 1, entry: { descriptor: { resultId: 801 } } })
    expect(client.handle(801)!.getSnapshot().state).toBe('complete')
    expect(results.getSnapshot().t1.focused).toBe(old.key)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, running: true, pivot: old.key })
    building.resolve({ descriptor: descriptor(811, { index: 0, kind: 'pivot', columns: [columns[1]] }), rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    await pivoting
    await settle()
    const tab = results.getSnapshot().t1
    // The same slot, key, number and name show the new result as its second revision; then the old one was released.
    expect(tab.sets.map(set => [set.key, set.number, set.label])).toEqual([[one, 1, undefined], [old.key, 3, 'Pivot of Result 1'], [keyAt(results, 't1', 2), 2, undefined]])
    expect(tab.groups[0].pivot).toMatchObject({ key: old.key, revision: 2, entry: { descriptor: { resultId: 811 } }, pivot: { recipe: { rows: [1] }, inputRows: 3 } })
    expect(client.released()).toEqual([801])
    expect([...pivot.getSnapshot().info.keys()]).toEqual(['1:811'])
    expect(tab.focused).toBe(old.key)
    expect(tab.groups[0].selected).toBe('pivot')
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, pivot: old.key })
    // The service keeps the rule whoever adds one: a second pivot of the Table takes the slot, as its next revision.
    expect(results.addSet('t1', descriptor(821, { index: 0, kind: 'pivot' }), 'Pivot of Result 1', [setKey(tab.sets[0].descriptor)])).toBe(old.key)
    expect(client.released()).toEqual([801, 811])
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: old.key, revision: 3 })
    // Added without provenance, the slot keeps none of the last build's.
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot).toBeUndefined()
    expect(results.getSnapshot().t1.sets.filter(set => set.descriptor.kind === 'pivot')).toHaveLength(1)
  })

  it('keeps the old Pivot when a replacement fails, is cancelled or is refused, and says why', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    const kept = results.getSnapshot().t1.groups[0].pivot!
    // Out of memory: the old Pivot is never freed to make room, and the builder says closing it is the user's choice.
    vi.mocked(first.pivot).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await pivot.run('t1')
    expect(results.getSnapshot().t1.groups[0].pivot).toBe(kept)
    expect(client.released()).toEqual([])
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, error: 'There is not enough result memory to pivot these rows. Close other results and try again, or close Pivot of Result 1 and build it again.' })
    // Another failure keeps it too, with the backend's own sentence.
    vi.mocked(first.pivot).mockRejectedValueOnce(new ResultError('BUDGET_STOPPED', "This query's results filled its result memory, so it can store nothing more. Run the query again returning fewer rows."))
    await pivot.run('t1')
    expect(results.getSnapshot().t1.groups[0].pivot).toBe(kept)
    expect(pivot.getSnapshot().tabs.t1.error).toBe("This query's results filled its result memory, so it can store nothing more. Run the query again returning fewer rows.")
    // Cancelled: the old one stays, and the builder says so; the answer the backend sent anyway is released, not shown.
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    let signal: AbortSignal | undefined
    vi.mocked(first.pivot).mockImplementationOnce((_spec, o) => { signal = o?.signal; return building.promise })
    const pivoting = pivot.run('t1')
    pivot.cancel('t1')
    expect(signal?.aborted).toBe(true)
    building.resolve({ descriptor: descriptor(831, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    expect(results.getSnapshot().t1.groups[0].pivot).toBe(kept)
    expect(client.released()).toEqual([831])
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, error: 'Building was cancelled, so Pivot of Result 1 still shows its last build.' })
    // Cancelling a group's first build says nothing: there is no Pivot to keep.
    results.removeEntry('t1', kept.key)
    vi.mocked(first.pivot).mockImplementationOnce((_spec, o) => new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new ResultError('CANCELLED', 'Cancelled.')))))
    const firstBuild = pivot.run('t1')
    pivot.cancel('t1')
    await firstBuild
    expect(results.getSnapshot().t1.groups[0].pivot).toBeUndefined()
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it('releases the old Pivot only after a save of it ends, so a rebuild during its file dialog fails no save', async () => {
    const { client, api, results, pivot, run } = fixture()
    const [first] = run(1)
    pivot.open('t1', keyAt(results, 't1', 0))
    await pivot.run('t1')
    const old = results.getSnapshot().t1.groups[0].pivot!
    const dialog = deferred<Awaited<ReturnType<VariaApi['saveResults']>>>()
    api.saveResults.mockImplementationOnce(() => dialog.promise)
    const saving = results.saveAs('t1', old.key, 'Query')
    expect(api.saveResults).toHaveBeenCalledWith(expect.objectContaining({ resultId: old.entry.descriptor.resultId }))
    vi.mocked(first.pivot).mockResolvedValueOnce({ descriptor: descriptor(851, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivot.run('t1')
    await settle()
    // Rebuilt and shown, but the old result stays until its save ends.
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: old.key, revision: 2 })
    expect(client.released()).not.toContain(old.entry.descriptor.resultId)
    // The dialog closes (cancelled, which says nothing): the save ends either way.
    dialog.resolve({ ok: true, value: null })
    await expect(saving).resolves.toBeUndefined()
    await settle()
    expect(client.released()).toContain(old.entry.descriptor.resultId)
  })

  it('gives up a replacement whose Pivot is closed while it is built: its late answer is released and recreates nothing', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    pivot.open('t1', keyAt(results, 't1', 0))
    await pivot.run('t1')
    const old = results.getSnapshot().t1.groups[0].pivot!.key
    let signal: AbortSignal | undefined
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(first.pivot).mockImplementationOnce((_spec, o) => { signal = o?.signal; return building.promise })
    const pivoting = pivot.run('t1')
    results.removeEntry('t1', old)
    expect(signal?.aborted).toBe(true)
    building.resolve({ descriptor: descriptor(841, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    await settle()
    expect(client.released()).toEqual([801, 841])
    expect(results.getSnapshot().t1.groups[0].pivot).toBeUndefined()
    expect(results.getSnapshot().t1.sets.map(set => set.number)).toEqual([1, 2])
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it('holds the result memory of the old and the new Pivot together until the new one publishes, and then frees the old', async () => {
    const { client, results, pivot, run, flush } = fixture({ frames: true })
    const [first] = run(1)
    flush()
    pivot.open('t1', keyAt(results, 't1', 0))
    await pivot.run('t1')
    flush()
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(first.pivot).mockImplementationOnce(() => building.promise)
    const pivoting = pivot.run('t1')
    // The backend stores the new pivot before it answers: both are held, and the renderer releases neither.
    const made = descriptor(851, { index: 0, kind: 'pivot' })
    // What the published snapshot shows when the old result is released: never the released one.
    const shownWhenReleased: number[] = []
    const release = client.release.getMockImplementation()!
    client.release.mockImplementation(async keys => { shownWhenReleased.push(results.getSnapshot().t1.groups[0].pivot!.entry.descriptor.resultId); return release(keys) })
    const open = () => [801, 851].filter(id => !client.released().includes(id))
    expect(open()).toEqual([801, 851])
    building.resolve({ descriptor: made, rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    await pivoting
    // Published, then the old one released, in that order and once.
    expect(open()).toEqual([851])
    expect(shownWhenReleased).toEqual([851])
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(results.getSnapshot().t1.groups[0].pivot!.entry.descriptor.resultId).toBe(851)
  })

  it('keeps the orientation, the focus, and the sort keys, widths and header column of columns named once in both; drops filters, selection and scroll', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0, 1], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const key = results.getSnapshot().t1.groups[0].pivot!.key
    const handle = results.getSnapshot().t1.groups[0].pivot!.entry.handle as FakeHandle
    // The Pivot (Region, Year, Count of rows) is sorted by Year, filtered, sized, selected, scrolled, drawn transposed
    // under Region, and has the focus.
    const view = (base: FakeHandle, viewId: number, filters: ResultView['filters']) => ({ ...base, viewId, base, keys: [], filters, rows: 1, baseRows: 2, complete: true, approximate: false, close: vi.fn(async () => {}) }) as unknown as ResultView
    vi.mocked(handle.sort).mockResolvedValueOnce(view(handle, 1, []))
    results.sortBy('t1', key, 1, 'descending')
    await settle()
    vi.mocked(handle.sort).mockResolvedValueOnce(view(handle, 2, [{ op: 'in', column: 2, rows: [0], nulls: false }]))
    results.applyColumnFilter('t1', key, 2, { kind: 'notNull' } as never)
    await settle()
    const state = results.gridState('t1', key)
    state.widths = Float64Array.from([80, 90, 100]); state.userSized = new Set([0, 1, 2]); state.topRow = 5; state.scrollLeft = 30
    state.selection = { anchor: { row: 1, column: 1 }, ranges: [] } as never
    expect(results.setOrientation('t1', key, { transposed: true, headerColumn: 0 })).toBe(true)
    results.focusEntry('t1', key)
    // Built again as (Year, Region, Count of rows, Count of rows): Year and Region are named once in both; Count of rows
    // now twice, so its width and filter do not follow.
    const twice = { name: 'Count of rows', dataType: 'bigint', wire: 'text', nullable: false } as ResultColumn
    vi.mocked(first.pivot).mockResolvedValueOnce({ descriptor: descriptor(861, { index: 0, kind: 'pivot', columns: [columns[1], columns[0], twice, twice] }), rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    const opened = client.open.getMockImplementation()!
    client.open.mockImplementation(value => {
      const made = opened(value) as FakeHandle
      if (value.resultId === 861) vi.mocked(made.sort).mockResolvedValue(view(made, 3, []))
      return made
    })
    const next = () => client.handle(861)!
    const notices: string[] = []
    vi.spyOn(results, 'notify').mockImplementation((_tabId, text) => { notices.push(text) })
    await pivot.run('t1')
    await settle()
    const tab = results.getSnapshot().t1
    expect(tab.groups[0].pivot).toMatchObject({ key, revision: 2 })
    expect(tab.focused).toBe(key)
    expect(results.orientation('t1', key)).toEqual({ transposed: true, headerColumn: 1 })
    const carried = results.gridState('t1', key)
    expect([carried.topRow, carried.scrollLeft, carried.selection, carried.sized]).toEqual([0, 0, undefined, false])
    expect([...carried.widths!].map(width => Number.isNaN(width) ? 'new' : width)).toEqual([90, 80, 'new', 'new'])
    expect([...carried.userSized!]).toEqual([1, 0])
    // The sort follows Year to its new place and is built again over the new result; the filter is gone, and said so.
    expect(next().sort).toHaveBeenCalledWith([{ column: 0, descending: true, mode: 'value' }], { signal: expect.any(AbortSignal) })
    expect(results.sortOf('t1', key)).toMatchObject({ keys: [{ column: 0, descending: true }], filters: [] })
    expect(notices).toEqual(['Pivot of Result 1 was built again, so its filters were removed.'])
  })

  it('builds the Pivots of different groups at once, keeps each build and failure with its group, and a newer build of a group gives up the older', async () => {
    const { client, results, pivot, run } = fixture()
    const [first, second] = run(2)
    const [one, two] = results.getSnapshot().t1.sets.map(set => set.key)
    pivot.open('t1', one)
    let fail!: (reason: unknown) => void
    vi.mocked(first.pivot).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pivoting = pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, running: true })
    // Another grid takes the focus while Result 1 builds: Result 2 can be built beside it.
    results.focusEntry('t1', two)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: two, running: false })
    expect(pivot.canPivot('t1', two)).toBe(true)
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(second.pivot).mockImplementationOnce(() => building.promise)
    const other = pivot.run('t1')
    expect(second.pivot).toHaveBeenCalledOnce()
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: two, running: true })
    fail(new ResultError('TOO_LARGE', 'Not enough memory for Result 1.'))
    await pivoting
    // The failure is Result 1's: Result 2's builder shows none, and Result 1's shows it when the builder is back.
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    building.resolve({ descriptor: descriptor(802, { index: 1, kind: 'pivot' }), rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    await other
    await settle()
    expect(results.getSnapshot().t1.groups[1].pivot).toBeDefined()
    results.focusEntry('t1', one)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, error: 'Not enough memory for Result 1.' })
    // Editing Result 2's draft leaves it; editing Result 1's clears it.
    results.focusEntry('t1', two)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    results.focusEntry('t1', one)
    expect(pivot.getSnapshot().tabs.t1.error).toBe('Not enough memory for Result 1.')
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    // Built again while it builds: the older build of the group is given up, and only the newer one is shown.
    let older: AbortSignal | undefined
    const slow = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(first.pivot).mockImplementationOnce((_spec, o) => { older = o?.signal; return slow.promise })
    const superseded = pivot.run('t1')
    await pivot.run('t1')
    expect(older?.aborted).toBe(true)
    slow.resolve({ descriptor: descriptor(871, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await superseded
    await settle()
    // The older build's late answer is released, never shown.
    expect(client.released()).toContain(871)
    expect(results.getSnapshot().t1.groups[0].pivot!.entry.descriptor.resultId).toBe(801)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it('runs at most four builds and comparisons in a window, the rest waiting, and asks again when the backend is busy', async () => {
    const timers = manualTimers()
    const jobs = new DerivedJobs({ timers: timers.timers })
    const client = fakeResultClient(), events = new EventBus()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
    const pivot = new PivotService(results, { jobs })
    results.begin('t1', 'q1')
    const values = Array.from({ length: 6 }, (_, index) => descriptor(index + 1, { index, columns }))
    for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q1', { summary: summaryOf(values) })
    const answers = values.map(() => deferred<Awaited<ReturnType<FakeHandle['pivot']>>>())
    values.forEach((value, at) => vi.mocked(client.handle(value.resultId)!.pivot).mockImplementationOnce(() => answers[at].promise))
    // Another derived job (PR 16's comparisons are to take places here too) holds one of the four.
    const comparing = deferred<void>()
    const compared = jobs.run(() => comparing.promise)
    const builds = results.getSnapshot().t1.sets.slice(0, 5).map(set => { results.focusEntry('t1', set.key); pivot.open('t1', set.key); return pivot.run('t1') })
    const asked = () => values.filter(value => vi.mocked(client.handle(value.resultId)!.pivot).mock.calls.length > 0).map(value => value.resultId)
    expect(asked()).toEqual([1, 2, 3])
    expect(jobs.load).toEqual({ running: 4, waiting: 2 })
    // The builder of a group that waits says so.
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: results.getSnapshot().t1.sets[4].key, running: true, queued: 'place' })
    // Cancelled while it waits: it leaves the line, never asked, and building again joins the line anew.
    pivot.cancel('t1')
    await builds[4]
    expect(jobs.load).toEqual({ running: 4, waiting: 1 })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false })
    expect(pivot.getSnapshot().tabs.t1.queued).toBeUndefined()
    expect(asked()).toEqual([1, 2, 3])
    builds[4] = pivot.run('t1')
    expect(jobs.load).toEqual({ running: 4, waiting: 2 })
    // A place frees: the first that waited is asked.
    answers[0].resolve({ descriptor: descriptor(801, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await builds[0]
    await settle()
    expect(asked()).toEqual([1, 2, 3, 4])
    comparing.resolve()
    await compared
    await settle()
    expect(asked()).toEqual([1, 2, 3, 4, 5])
    expect(pivot.getSnapshot().tabs.t1.queued).toBeUndefined()
    answers.forEach((answer, at) => answer.resolve({ descriptor: descriptor(801 + at, { index: at, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false }))
    await Promise.all(builds)
    await settle()
    expect(jobs.load).toEqual({ running: 0, waiting: 0 })
    // BUSY and TOO_MANY_REQUESTS came before anything ran: asked again after 1 s, then 4 s, then 16 s, then the refusal's
    // own sentence. Its place is given up while it waits.
    const fifth = client.handle(5)!
    vi.mocked(fifth.pivot).mockReset()
    vi.mocked(fifth.pivot).mockRejectedValue(new ResultError('BUSY', 'The SQL backend is busy. Try again.'))
    results.focusEntry('t1', results.getSnapshot().t1.sets.find(set => set.ordinal === 5)!.key)
    const busy = pivot.run('t1')
    await settle()
    const calls = () => vi.mocked(fifth.pivot).mock.calls.length
    expect(calls()).toBe(1)
    // While it waits to ask again, the builder says the backend is busy.
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: true, queued: 'busy' })
    for (const [ms, count] of [[1_000, 2], [4_000, 3], [16_000, 4]] as const) {
      timers.advance(ms - 1)
      await settle()
      expect(calls()).toBe(count - 1)
      timers.advance(1)
      await settle()
      expect(calls()).toBe(count)
    }
    await busy
    expect(pivot.getSnapshot().tabs.t1.error).toBe('The SQL backend is busy. Try again.')
    expect(pivot.getSnapshot().tabs.t1.queued).toBeUndefined()
    // TIMEOUT ran: it is never asked again.
    vi.mocked(fifth.pivot).mockRejectedValueOnce(new ResultError('TIMEOUT', 'The pivot took too long.'))
    await pivot.run('t1')
    expect(calls()).toBe(5)
    expect(pivot.getSnapshot().tabs.t1.error).toBe('The pivot took too long.')
    expect(derivedLimits).toEqual({ parallel: 4, retryMs: [1_000, 4_000, 16_000] })
  })

  it('refuses a new Pivot that would take a run past 1,000 results, counting builds in flight; a replacement counts once', async () => {
    const { results, pivot, run } = fixture()
    const handles = run(resultLimits.sets - 2)
    const keys = results.getSnapshot().t1.sets.map(set => set.key)
    // Pivots get ids no query set of this run has.
    let made = 10_000
    handles.forEach((handle, at) => vi.mocked(handle.pivot).mockImplementation(async () => ({ descriptor: descriptor(made++, { index: at, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })))
    results.focusEntry('t1', keys[0])
    pivot.open('t1', keys[0])
    await pivot.run('t1')
    await settle()
    expect(results.getSnapshot().t1.sets).toHaveLength(resultLimits.sets - 1)
    // Result 2's first Pivot is the 1,000th: allowed.
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(handles[1].pivot).mockImplementationOnce(() => building.promise)
    results.focusEntry('t1', keys[1])
    const pivoting = pivot.run('t1')
    expect(handles[1].pivot).toHaveBeenCalledOnce()
    // While it is built, Result 3's first Pivot would pass 1,000: refused before the backend is asked.
    results.focusEntry('t1', keys[2])
    await pivot.run('t1')
    expect(handles[2].pivot).not.toHaveBeenCalled()
    expect(pivot.getSnapshot().tabs.t1.error).toBe('These results already show 1,000 sets, so no pivot can be added. Close some results, or run the query again.')
    // Replacing Result 1's Pivot takes no more room.
    results.focusEntry('t1', keys[0])
    await pivot.run('t1')
    expect(handles[0].pivot).toHaveBeenCalledTimes(2)
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    building.resolve({ descriptor: descriptor(5002, { index: 1, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    await settle()
    expect(results.getSnapshot().t1.sets).toHaveLength(resultLimits.sets)
    // Full: a new Pivot is refused, a replacement still built.
    results.focusEntry('t1', keys[2])
    await pivot.run('t1')
    expect(handles[2].pivot).not.toHaveBeenCalled()
    results.focusEntry('t1', keys[1])
    await pivot.run('t1')
    expect(handles[1].pivot).toHaveBeenCalledTimes(2)
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it("keeps the Table's view open while a build reads it, and builds once more from the grid's view when the backend closed it", async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    const view = (viewId: number, filters: ResultView['filters']) => ({ ...first, viewId, base: first, keys: [], filters, rows: 1, baseRows: 3, complete: true, approximate: false, close: vi.fn(async () => {}), pivot: vi.fn<ResultHandle['pivot']>() }) as unknown as ResultView & { close: ReturnType<typeof vi.fn>; pivot: ReturnType<typeof vi.fn> }
    const filtered = view(1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    vi.mocked(first.sort).mockResolvedValueOnce(filtered)
    results.sortBy('t1', one, 0, 'ascending')
    await settle()
    results.viewShown('t1', one, filtered)
    expect(results.sortOf('t1', one)?.view).toBe(filtered)
    pivot.open('t1', one)
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    filtered.pivot.mockImplementationOnce(() => building.promise)
    const pivoting = pivot.run('t1')
    // The grid is filtered again and shows the new view: the one the build reads stays open until it ends.
    const refiltered = view(2, [{ op: 'notIn', column: 0, rows: [2], nulls: false }])
    vi.mocked(first.sort).mockResolvedValueOnce(refiltered)
    results.sortBy('t1', one, 1, 'ascending')
    await settle()
    results.viewShown('t1', one, refiltered)
    expect(filtered.close).not.toHaveBeenCalled()
    building.resolve({ descriptor: descriptor(881, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    await settle()
    expect(filtered.close).toHaveBeenCalledOnce()
    // The Pivot records the filters it applied.
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot).toEqual({ recipe: emptyDraft, filters: [{ op: 'in', column: 0, rows: [2], nulls: false }], inputRows: 1, truncated: false, incomplete: false, approximate: false })
    // The backend evicted the grid's view, which stays evicted: the build runs once more over the same order and filters
    // built again for it alone, and closes that view after.
    const evicted = new ResultError('VIEW_NOT_FOUND', 'This sorted view was closed. Sort the results again.')
    refiltered.pivot.mockRejectedValue(evicted)
    const again = view(3, refiltered.filters)
    again.pivot.mockResolvedValueOnce({ descriptor: descriptor(882, { index: 0, kind: 'pivot' }), rows: 2, rowGroups: 1, columnGroups: 0, approximate: false })
    vi.mocked(first.sort).mockClear()
    vi.mocked(first.sort).mockResolvedValueOnce(again)
    await pivot.run('t1')
    await settle()
    expect(first.sort).toHaveBeenCalledWith(refiltered.keys, { filters: refiltered.filters, signal: expect.any(AbortSignal) })
    expect(again.pivot).toHaveBeenCalledOnce()
    expect(again.close).toHaveBeenCalledOnce()
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ revision: 2, pivot: { filters: [{ op: 'notIn', column: 0, rows: [2], nulls: false }], inputRows: 2 } })
    // The second try fails too: the old Pivot stays and the builder says why.
    const lost = view(4, refiltered.filters)
    lost.pivot.mockRejectedValueOnce(evicted)
    vi.mocked(first.sort).mockResolvedValueOnce(lost)
    await pivot.run('t1')
    expect(lost.close).toHaveBeenCalledOnce()
    expect(pivot.getSnapshot().tabs.t1.error).toBe('This sorted view was closed. Sort the results again.')
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ revision: 2 })
    // A grid that built another view meanwhile: the second try reads that one.
    const newer = view(5, [])
    newer.pivot.mockResolvedValueOnce({ descriptor: descriptor(883, { index: 0, kind: 'pivot' }), rows: 3, rowGroups: 1, columnGroups: 0, approximate: false })
    refiltered.pivot.mockImplementationOnce(async () => {
      vi.mocked(first.sort).mockResolvedValueOnce(newer)
      results.sortBy('t1', one, 0, 'descending')
      await settle()
      throw evicted
    })
    await pivot.run('t1')
    await settle()
    expect(newer.pivot).toHaveBeenCalledOnce()
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ revision: 3, pivot: { filters: [], inputRows: 3 } })
  })

  it('reads the view the grid showed at the click, even when it waits for a place while the grid is filtered again', async () => {
    const jobs = new DerivedJobs({ limit: 1 })
    const { results, pivot, run } = fixture({ jobs })
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    const view = (viewId: number, filters: ResultView['filters']) => ({ ...first, viewId, base: first, keys: [], filters, rows: 1, baseRows: 3, complete: true, approximate: false, close: vi.fn(async () => {}), pivot: vi.fn<ResultHandle['pivot']>() }) as unknown as ResultView & { close: ReturnType<typeof vi.fn>; pivot: ReturnType<typeof vi.fn> }
    const filtered = view(1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    vi.mocked(first.sort).mockResolvedValueOnce(filtered)
    results.sortBy('t1', one, 0, 'ascending')
    await settle()
    results.viewShown('t1', one, filtered)
    const reading = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    filtered.pivot.mockImplementationOnce(() => reading.promise)
    // Another derived job holds the only place.
    const other = deferred<void>()
    const holding = jobs.run(() => other.promise)
    pivot.open('t1', one)
    const pivoting = pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1.queued).toBe('place')
    // The grid starts building another filter, and is still building it when the place frees.
    const refiltering = deferred<ResultView>()
    vi.mocked(first.sort).mockImplementationOnce(() => refiltering.promise)
    results.sortBy('t1', one, 1, 'ascending')
    expect(results.sortOf('t1', one)?.sorting).toBe(true)
    // The grid shows its new view while the build still waits: the click's view is held, so it stays open.
    const unfiltered = view(2, [])
    refiltering.resolve(unfiltered)
    await settle()
    results.viewShown('t1', one, unfiltered)
    expect(filtered.close).not.toHaveBeenCalled()
    other.resolve()
    await holding
    await settle()
    // It reads the view shown at the click, never the stored rows nor the grid's new view.
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(first.pivot).not.toHaveBeenCalled()
    expect(unfiltered.pivot).not.toHaveBeenCalled()
    reading.resolve({ descriptor: descriptor(891, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    await settle()
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot).toMatchObject({ filters: [{ op: 'in', column: 0, rows: [2], nulls: false }] })
    // Its hold ended with the build, and the grid had moved on: it is closed, once.
    expect(filtered.close).toHaveBeenCalledOnce()
    expect(unfiltered.close).not.toHaveBeenCalled()
  })

  it('follows the focused group with a draft per group, falls back to the first it can pivot, and keeps its group by number into the next run', async () => {
    const { client, results, pivot, run } = fixture()
    run(3)
    const sets = () => results.getSnapshot().t1.sets
    const [one, two, three] = sets().map(set => set.key)
    pivot.open('t1', three)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    // Another grid takes the focus: the builder is that group's, with that group's own draft.
    results.focusEntry('t1', two)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: two, sourceName: 'Result 2', draft: emptyDraft })
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    results.focusEntry('t1', three)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: three, sourceName: 'Result 3', draft: { rows: [0] } })
    // A comparison takes the focus: the builder falls back to the first group it can pivot.
    const diff = results.addSet('t1', descriptor(901, { index: 0, kind: 'diff' }), 'Differences: Result 1 → Result 2', [setKey(sets()[0].descriptor), setKey(sets()[1].descriptor)])!
    results.focusEntry('t1', diff)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, sourceName: 'Result 1', draft: emptyDraft })
    results.focusEntry('t1', three)
    // A middle group goes: the builder is still Result 3's, with its draft.
    results.removeEntry('t1', two)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: three, draft: { rows: [0] } })
    await pivot.run('t1')
    await settle()
    expect(sets().map(set => set.label ?? set.number)).toEqual([1, 3, 'Pivot of Result 3', 'Differences: Result 1 → Result 2'])
    // The group it belongs to goes (its Pivot with it): the focus moves on, and the builder with it. The comparison is
    // next, so the builder falls back to the first group it can pivot.
    results.removeEntry('t1', three)
    expect(sets().map(set => set.label ?? set.number)).toEqual([1, 'Differences: Result 1 → Result 2'])
    expect(results.getSnapshot().t1.focused).toBe(diff)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, sourceName: 'Result 1' })
    // An original result is followed by its number into the next run, with its group's draft.
    run(3, { queryId: 'q0' })
    results.focusEntry('t1', keyAt(results, 't1', 2))
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ sourceName: 'Result 3', draft: { rows: [0] } })
    // While the next run has returned only its first result, the builder waits for Result 3 and still names it.
    results.begin('t1', 'q-streaming')
    client.emit('q-streaming', { type: 'resultSet.opened', descriptor: descriptor(50, { index: 0, columns }) })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: undefined, sourceName: 'Result 3', draft: { rows: [0] } })
    run(3, { queryId: 'q2' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: keyAt(results, 't1', 2), sourceName: 'Result 3', draft: { rows: [0] } })
    expect(sets()[2]).toMatchObject({ ordinal: 3 })
    // The focus came along by number too: Result 3's Table has it in the new run.
    expect(results.getSnapshot().t1.focused).toBe(keyAt(results, 't1', 2))
  })

  it("pivots nothing while the query runs, shows why a pivot failed, and keeps a new run's builder on its group", async () => {
    const { results, pivot, run } = fixture()
    run(2, { finish: false })
    expect(pivot.canPivot('t1', keyAt(results, 't1', 0))).toBe(false)
    const [first] = run(2, { queryId: 'q2' })
    pivot.open('t1', keyAt(results, 't1', 0))
    vi.mocked(first.pivot).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, error: 'There is not enough result memory to pivot these rows. Close other results and try again.' })
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    // Editing the draft clears the failure; a new run keeps the draft and the group.
    pivot.open('t1', keyAt(results, 't1', 1))
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    run(2, { queryId: 'q3' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: keyAt(results, 't1', 1), draft: { rows: [1] }, running: false })
    // A run without that group starts the builder on its first, which has a draft of its own.
    run(1, { queryId: 'q4' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: keyAt(results, 't1', 0), sourceName: 'Result 1', draft: emptyDraft })
    // A closed tab forgets its builder.
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
    // Close Results changes no builder, but the closed pivot's strip goes.
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
    run(1, { queryId: 'q2', finish: false })
    expect(signal?.aborted).toBe(true)
    answer({ descriptor: descriptor(990, { index: 1, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    expect(client.released()).toContain(990)
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    // The earlier pivot's run is gone, and its strip with it.
    expect(pivot.getSnapshot().info.size).toBe(0)
  })

  it('keeps a group\'s draft untouched while a new run has yet to return the group', async () => {
    const { client, results, pivot, run } = fixture()
    run(2)
    const sets = () => results.getSnapshot().t1.sets
    const two = sets()[1].key
    pivot.open('t1', two)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: two, sourceName: 'Result 2', draft: { rows: [0] } })
    // A new run that has returned only Result 1: the builder still names Result 2, and an edit made now writes nothing
    // over the draft it keeps for it.
    results.begin('t1', 'q-streaming')
    client.emit('q-streaming', { type: 'resultSet.opened', descriptor: descriptor(50, { index: 0, columns }) })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: undefined, sourceName: 'Result 2' })
    pivot.setDraft('t1', { rows: [], values: [{ aggregate: 'count' }] })
    run(2, { queryId: 'q2', columns: [columns[1], columns[0]] })
    // Fitted by name to the moved columns: Region is the second column now.
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ sourceName: 'Result 2', draft: { rows: [1] } })
  })

  it('keeps a new Pivot\'s strip when another tab publishes before the frame that shows the Pivot', async () => {
    const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
    const api = { copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(), onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}) }
    const frames: (() => void)[] = []
    const results = new ResultsService({ client, api, events, frame: callback => { frames.push(callback) }, timers: timers.timers, newId: () => crypto.randomUUID() })
    const pivot = new PivotService(results)
    for (const [tabId, id] of [['a', 1], ['b', 2]] as const) {
      const value = descriptor(id, { index: 0, columns })
      results.begin(tabId, 'q' + tabId)
      client.emit('q' + tabId, { type: 'resultSet.opened', descriptor: value })
      void results.finish(tabId, 'q' + tabId, { summary: summaryOf([value]) })
    }
    pivot.open('a', results.getSnapshot().a.sets[0].key)
    await pivot.run('a')
    // The pivot is added, but tab a's snapshot shows it only on the next frame.
    expect(results.getSnapshot().a.sets).toHaveLength(1)
    expect([...pivot.getSnapshot().info.keys()]).toEqual(['1:801'])
    // Tab b publishes first.
    results.focusEntry('b', results.getSnapshot().b.sets[0].key)
    expect([...pivot.getSnapshot().info.keys()]).toEqual(['1:801'])
    for (const frame of frames.splice(0)) frame()
    expect(results.getSnapshot().a.sets).toHaveLength(2)
    expect([...pivot.getSnapshot().info.keys()]).toEqual(['1:801'])
    // Once shown it is kept only while shown.
    results.removeEntry('a', results.getSnapshot().a.sets[1].key)
    expect(pivot.getSnapshot().info.size).toBe(0)
  })

  it('gives up a pivot whose Table is closed while it is built, and adds nothing when it answers', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    pivot.open('t1', keyAt(results, 't1', 0))
    let signal: AbortSignal | undefined
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(first.pivot).mockImplementationOnce((_spec, o) => { signal = o?.signal; return building.promise })
    const pivoting = pivot.run('t1')
    results.removeEntry('t1', keyAt(results, 't1', 0))
    expect(signal?.aborted).toBe(true)
    building.resolve({ descriptor: descriptor(991, { index: 0, kind: 'pivot' }), rows: 1, rowGroups: 1, columnGroups: 0, approximate: false })
    await pivoting
    expect(client.released()).toEqual([1, 991])
    expect(results.getSnapshot().t1.sets.map(set => set.number)).toEqual([2])
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })
})
