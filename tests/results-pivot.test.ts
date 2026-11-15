import { describe, expect, it, vi } from 'vitest'
import type { ResolvedViewFilter, ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { followsByItself, pivotFollow, pivotGroup, PivotService, pivotShown, type PivotFollowHost, type ResultsLayout } from '../src/renderer/src/results/PivotService'
import { aggregateFits, columnGroupLimit, draftSpec, emptyDraft, fitDraft, isNumericColumn, outOfDateText, pivotFacts, pivotStrip, pivotText, remapDraft, valueLabel } from '../src/renderer/src/results/pivot'
import { carriedState, pivotOutOfDate, resultLimits, ResultsService, sameFilters, setKey, uniqueNames } from '../src/renderer/src/results/ResultsService'
import { DerivedJobs, derivedLimits } from '../src/renderer/src/results/derived-jobs'
import type { ResultHandle, ResultView } from '../src/renderer/src/results/ResultClient'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt } from './fixtures/entries'
import { deferred } from './fixtures/documents'
import { selectAll } from '../src/renderer/src/grid/selection'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const column = (name: string, dataType: string, patch: Partial<ResultColumn> = {}): ResultColumn => ({ name, dataType, wire: 'text', nullable: true, ...patch }) as ResultColumn
const columns = [column('Region', 'nvarchar(20)'), column('Year', 'int'), column('Amount', 'decimal(10,2)'), column('Flag', 'bit'), column('Blob', 'varbinary(max)', { wire: 'binary' })]

/** `frames`: the results publish on frames the test runs (`flush`), not at once. */
function fixture(o: { frames?: boolean; jobs?: DerivedJobs; follow?: PivotFollowHost; now?: () => number } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const queued: (() => void)[] = []
  const results = new ResultsService({ client, api, events, frame: o.frames ? callback => { queued.push(callback) } : callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const pivot = new PivotService(results, { ...o.jobs ? { jobs: o.jobs } : {}, ...o.follow ? { follow: o.follow } : {}, ...o.now ? { now: o.now } : {} })
  const flush = () => { for (const frame of queued.splice(0)) frame() }
  let next = 1
  /** Runs a query of `count` complete sets of `columns`; `finish: false` leaves it running. */
  const run = (count: number, o: { finish?: boolean; queryId?: string; columns?: ResultColumn[]; names?: Record<number, string> } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index, columns: o.columns ?? columns, ...o.names?.[index] ? { name: o.names[index] } : {} }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    if (o.finish !== false) void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.handle as FakeHandle)
  }
  return { client, api, results, pivot, run, flush, timers }
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
  it('shows a build in the toolbar and on its Table, with the backend progress, until it is cancelled', async () => {
    const { results, pivot, run, timers } = fixture()
    const [, second] = run(3)
    const table = keyAt(results, 't1', 1)
    pivot.open('t1', table)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    vi.mocked(second.pivot).mockImplementationOnce((_spec, o) => new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('Cancelled')))))
    const built = pivot.run('t1')
    await settle()
    vi.mocked(second.pivot).mock.lastCall![1]!.onProgress!('aggregate', 60)
    timers.advance(300)
    expect(results.operations.getSnapshot().t1?.items).toMatchObject([{ kind: 'pivot', target: 'Result 2', entry: table, phase: 'aggregate', percent: 60, shown: true }])
    results.operations.cancel('t1')
    await built
    await settle()
    expect(results.operations.getSnapshot().t1).toMatchObject({ items: [], notice: 'Pivot cancelled.' })
    expect(results.getSnapshot().t1.sets).toHaveLength(3)
  })
  it("closes the builder once its tab's results are gone, as the Compare popover does, and keeps its drafts for the next Pivot…", async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(2)
    const open = () => { pivot.open('t1', keyAt(results, 't1', 1)); pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] }) }
    open()
    // A result closed while another is left keeps the builder.
    results.removeEntry('t1', keyAt(results, 't1', 0))
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: keyAt(results, 't1', 0) })
    // The last one closed (an emptied run, whose captured plans may stay) closes it: nothing is left to show it beside.
    results.removeEntry('t1', keyAt(results, 't1', 0))
    expect(results.getSnapshot().t1).toMatchObject({ sets: [], emptied: true })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: false, running: false })
    expect(pivot.getSnapshot().tabs.t1.source).toBeUndefined()
    // Nothing reopens it there, and Build makes nothing.
    pivot.open('t1')
    expect(pivot.getSnapshot().tabs.t1.open).toBe(false)
    await pivot.run('t1')
    expect(first.pivot).not.toHaveBeenCalled()
    // The next run does not bring it back; Pivot… there finds the group's draft as it was left.
    run(2, { queryId: 'q2' })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: false, source: keyAt(results, 't1', 1), draft: { rows: [0] } })
    open()
    expect(pivot.getSnapshot().tabs.t1.open).toBe(true)
    // A re-run releases the old results before its first set arrives: while it runs the builder stays.
    run(0, { queryId: 'q3', finish: false })
    expect(results.getSnapshot().t1).toMatchObject({ status: 'running', sets: [] })
    expect(pivot.getSnapshot().tabs.t1.open).toBe(true)
    // A finished run that returned no result closes it.
    void results.finish('t1', 'q3', { summary: summaryOf([]) })
    expect(pivot.getSnapshot().tabs.t1.open).toBe(false)
    // And so does Close Results.
    run(2, { queryId: 'q4' })
    open()
    results.closeResults('t1')
    expect(results.getSnapshot().t1.status).toBe('closed')
    expect(pivot.getSnapshot().tabs.t1.open).toBe(false)
    // A comparison left alone is still a result: the builder stays, with no group to pivot.
    run(2, { queryId: 'q5' })
    const kept = results.getSnapshot().t1.sets.map(set => set.descriptor)
    open()
    expect(results.addSet('t1', descriptor(990, { index: 2, kind: 'diff' }), 'Differences: Result 1 → Result 2', [setKey(kept[0]), setKey(kept[1])])).toBeDefined()
    results.removeEntry('t1', keyAt(results, 't1', 0))
    results.removeEntry('t1', keyAt(results, 't1', 0))
    expect(results.getSnapshot().t1.sets.map(set => set.label)).toEqual(['Differences: Result 1 → Result 2'])
    expect(pivot.getSnapshot().tabs.t1.open).toBe(true)
    expect(pivot.getSnapshot().tabs.t1.source).toBeUndefined()
  })
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
    expect(second.pivot).toHaveBeenCalledWith({ rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] }, { signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    const tab = results.getSnapshot().t1, sets = tab.sets
    expect(sets).toHaveLength(4)
    // Directly under Result 2, before Result 3; numbered after the run's highest, and named after its Table.
    expect(sets[2]).toMatchObject({ number: 4, label: 'Pivot of Result 2', descriptor: { kind: 'pivot', resultId: 802 } })
    expect(sets[3]).toMatchObject({ ordinal: 3 })
    expect(tab.groups[1]).toMatchObject({ ordinal: 2, table: { key: table, view: 'table' }, pivot: { key: sets[2].key, view: 'pivot', revision: 1, group: 2, sources: [{ key: table, set: setKey(sets[1].descriptor), number: 2, name: 'Result 2', ordinal: 2 }] } })
    expect(pivot.getSnapshot().info.get(setKey(sets[2].descriptor))).toEqual({ source: table, sourceLabel: 'Result 2', viewed: false, rows: 3, rowGroups: 2, columnGroups: 0, approximate: false, partial: false })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, pivot: sets[2].key })
    // The slot records what the build read: its recipe, no filters (it read the stored rows), its rows, and a whole source.
    expect(tab.groups[1].pivot!.pivot).toEqual({ recipe: { rows: [0], column: 1, values: [{ aggregate: 'sum', column: 2 }, { aggregate: 'count', column: 0 }] }, filters: [], inputRows: 3, truncated: false, incomplete: false, approximate: false, buildMs: expect.any(Number) })
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

  it("names the builder's source, the Pivot and what it says by a named Table's name, and an unnamed one's by its number", async () => {
    const { results, pivot, run } = fixture()
    run(2, { names: { 0: 'Open orders' } })
    const named = keyAt(results, 't1', 0), unnamed = keyAt(results, 't1', 1)
    pivot.open('t1', unnamed)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: unnamed, sourceName: 'Result 2' })
    pivot.open('t1', named)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: named, sourceName: 'Open orders' })
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    await settle()
    const made = results.getSnapshot().t1.sets[1]
    // The title is frozen when made, from the Table's name then.
    expect(made.label).toBe('Pivot of Open orders')
    expect(pivot.getSnapshot().info.get(setKey(made.descriptor))).toMatchObject({ sourceLabel: 'Open orders' })
    expect(results.getSnapshot().t1.groups[0].pivot!.sources).toEqual([expect.objectContaining({ name: 'Open orders', number: 1 })])
  })

  it('names the build of one of two results of one name with its number in the toolbar', async () => {
    const { results, pivot, run } = fixture()
    const [, second] = run(2, { names: { 0: 'Totals', 1: 'Totals' } })
    pivot.open('t1', keyAt(results, 't1', 1))
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    vi.mocked(second.pivot).mockImplementationOnce((_spec, o) => new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('Cancelled')))))
    const built = pivot.run('t1')
    await settle()
    expect(results.operations.getSnapshot().t1?.items).toMatchObject([{ kind: 'pivot', target: 'Totals (Result 2)' }])
    pivot.cancel('t1')
    await built
    await settle()
  })
  it('names a Pivot of one of two results of one name with its number, so the two Pivots are told apart', async () => {
    const { results, pivot, run } = fixture()
    run(2, { names: { 0: 'Totals', 1: 'Totals' } })
    const second = keyAt(results, 't1', 1)
    pivot.open('t1', second)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ sourceName: 'Totals (Result 2)' })
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    await settle()
    const made = results.getSnapshot().t1.sets.at(-1)!
    expect(made.label).toBe('Pivot of Totals (Result 2)')
    expect(results.getSnapshot().t1.groups[1].pivot!.sources).toEqual([expect.objectContaining({ name: 'Totals (Result 2)', number: 2 })])
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
    expect(next().sort).toHaveBeenCalledWith([{ column: 0, descending: true, mode: 'value' }], { signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
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
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot).toEqual({ recipe: emptyDraft, filters: [{ op: 'in', column: 0, rows: [2], nulls: false }], inputRows: 1, truncated: false, incomplete: false, approximate: false, buildMs: expect.any(Number) })
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
    // The filters it records are those the grid shows: the Pivot built again this way is not out of date.
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(false)
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
    expect(moved.pivot).toHaveBeenCalledWith({ rows: [1], column: 2, values: [{ aggregate: 'sum', column: 0 }] }, { signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
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
    // Close Results closes the builder (as it does the Compare popover), and the closed pivot's strip goes.
    results.closeResults('t1')
    expect(pivot.getSnapshot().info.size).toBe(0)
    expect(pivot.getSnapshot().tabs.t1?.open ?? false).toBe(false)
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

describe('an out-of-date Pivot and Update', () => {
  const view = (first: FakeHandle, viewId: number, filters: ResultView['filters']) => ({ ...first, viewId, base: first, keys: [], filters, rows: 1, baseRows: 3, complete: true, approximate: false, close: vi.fn(async () => {}), pivot: vi.fn<ResultHandle['pivot']>() }) as unknown as ResultView & { close: ReturnType<typeof vi.fn>; pivot: ReturnType<typeof vi.fn> }
  /** Shows `shown` in the Table's grid, as a sort or filter the backend built would. */
  const show = async (results: ResultsService, first: FakeHandle, key: string, shown: ResultView, column = 0) => {
    vi.mocked(first.sort).mockResolvedValueOnce(shown)
    results.sortBy('t1', key, column, 'ascending')
    await settle()
    results.viewShown('t1', key, shown)
  }
  const pivoted = (resultId: number, rows = 1) => ({ descriptor: descriptor(resultId, { index: 0, kind: 'pivot' }), rows, rowGroups: 1, columnGroups: 0, approximate: false })

  it('compares resolved filters by what they keep: a groups filter by its digest, value rows in any order, a range in order, the list in order', () => {
    const inRows: ResolvedViewFilter = { op: 'in', column: 0, rows: [4, 2], nulls: false }
    expect(sameFilters([], [])).toBe(true)
    expect(sameFilters([inRows], [{ ...inRows, rows: [2, 4] }])).toBe(true)
    expect(sameFilters([inRows], [{ ...inRows, nulls: true }])).toBe(false)
    expect(sameFilters([inRows], [{ ...inRows, op: 'notIn' }])).toBe(false)
    expect(sameFilters([inRows], [{ ...inRows, column: 1 }])).toBe(false)
    expect(sameFilters([{ op: 'between', column: 0, rows: [1, 9], nulls: false }], [{ op: 'between', column: 0, rows: [9, 1], nulls: false }])).toBe(false)
    // A groups filter is its digest (the backend's hash of its column, keep or drop, NULL and its values' rows): another
    // snapshot ticking the same values is the same filter, and the same snapshot is too.
    const groups: ResolvedViewFilter = { op: 'groups', column: 1, snapshotId: 7, keep: true, values: 2, nulls: false, digest: 'a'.repeat(32) }
    expect(sameFilters([groups], [{ ...groups, row: 3 }])).toBe(true)
    expect(sameFilters([groups], [{ ...groups, snapshotId: 8 }])).toBe(true)
    expect(sameFilters([groups], [{ ...groups, digest: 'b'.repeat(32) }])).toBe(false)
    expect(sameFilters([{ op: 'keepRows', rows: [3, 1] }], [{ op: 'keepRows', rows: [1, 3] }])).toBe(true)
    expect(sameFilters([{ op: 'duplicates', columns: [0, 1] }, inRows], [inRows, { op: 'duplicates', columns: [0, 1] }])).toBe(false)
    // Filters keep the rows all of them keep, so their order counts only around a duplicates filter (re-applying one moves
    // it last).
    const keep: ResolvedViewFilter = { op: 'keepRows', rows: [1] }, dup: ResolvedViewFilter = { op: 'duplicates', columns: [0] }
    expect(sameFilters([inRows, keep], [keep, inRows])).toBe(true)
    expect(sameFilters([inRows, keep, dup, keep], [keep, inRows, dup, keep])).toBe(true)
    expect(sameFilters([inRows, dup, keep], [keep, dup, inRows])).toBe(false)
    expect(sameFilters([inRows, inRows], [inRows, keep])).toBe(false)
    expect(sameFilters([inRows], [inRows, { op: 'keepRows', rows: [1] }])).toBe(false)
  })

  it("marks a Pivot out of date when its Table's filters change, not when it is only sorted or its filters are named, and says so in its strip", async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const stale = () => { const tab = results.getSnapshot().t1; return pivotOutOfDate(tab, tab.groups[0]) }
    // Built from the stored rows: no filters recorded, none shown.
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot!.filters).toEqual([])
    expect(stale()).toBe(false)
    // A sort alone changes no aggregate.
    await show(results, first, one, view(first, 1, []))
    expect(stale()).toBe(false)
    // A filter does.
    await show(results, first, one, view(first, 2, [{ op: 'in', column: 0, rows: [2], nulls: false }]), 1)
    expect(stale()).toBe(true)
    // Its label being named later (the view's filters are the same) is no change back or forth.
    const named = results.sortOf('t1', one)!
    expect(named.view!.filters).toEqual([{ op: 'in', column: 0, rows: [2], nulls: false }])
    expect(stale()).toBe(true)
    // A filter built but not yet shown does not count until it shows: the mark changes with the grid.
    const building = deferred<ResultView>()
    vi.mocked(first.sort).mockImplementationOnce(() => building.promise)
    results.sortBy('t1', one, 2, 'ascending')
    expect(results.sortOf('t1', one)!.sorting).toBe(true)
    expect(stale()).toBe(true)
    building.resolve(view(first, 3, []))
    await settle()
    expect(stale()).toBe(false)
    // The strip says it first, and what Update does.
    expect(outOfDateText('Result 1')).toBe("Out of date: Result 1's filters changed after this Pivot was built. Update builds it again from Result 1 as it is filtered now.")
    const info = { source: one, sourceLabel: 'Result 1', viewed: false, rows: 1, rowGroups: 1, columnGroups: 0, approximate: false }
    expect(pivotStrip(info, undefined, true)).toBe(`${outOfDateText('Result 1')} ${pivotText(info)}`)
    expect(pivotStrip(info, 'Marked.', true)).toBe(`${outOfDateText('Result 1')} ${pivotText(info)} Marked.`)
    // A group without a Pivot, or a Pivot added without provenance, is never marked.
    expect(pivotOutOfDate(results.getSnapshot().t1, { table: results.getSnapshot().t1.groups[0].table })).toBe(false)
  })

  it('does not mark a Pivot for a filter made again of the same values, and does for other values', async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    const checklist = (snapshotId: number, digest: string): ResolvedViewFilter => ({ op: 'groups', column: 1, snapshotId, keep: true, values: 2, nulls: false, digest })
    const selection: ResolvedViewFilter = { op: 'in', column: 0, rows: [0, 3], nulls: false }
    const filtered = view(first, 1, [checklist(4, '1'.repeat(32)), selection])
    filtered.pivot.mockResolvedValueOnce(pivoted(901))
    await show(results, first, one, filtered)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const stale = () => { const tab = results.getSnapshot().t1; return pivotOutOfDate(tab, tab.groups[0]) }
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot!.filters).toEqual([checklist(4, '1'.repeat(32)), selection])
    expect(stale()).toBe(false)
    // The same values ticked again in the header's checklist: a new snapshot, the same digest. The selection filter made
    // again from other cells of the same values: the backend resolves each value to its lowest row, the same rows; applying
    // it again moved it last, which changes nothing.
    await show(results, first, one, view(first, 2, [{ ...selection, rows: [3, 0] }, checklist(9, '1'.repeat(32))]))
    expect(stale()).toBe(false)
    // Other values ticked are another digest; another value selected is another row.
    await show(results, first, one, view(first, 3, [checklist(10, '2'.repeat(32)), selection]))
    expect(stale()).toBe(true)
    await show(results, first, one, view(first, 4, [checklist(11, '1'.repeat(32)), { ...selection, rows: [0, 5] }]))
    expect(stale()).toBe(true)
    await show(results, first, one, view(first, 5, [checklist(12, '1'.repeat(32)), selection]))
    expect(stale()).toBe(false)
  })

  it("updates from the Pivot's own recipe over the Table as filtered now, keeping the old Pivot until the new one publishes, and leaves the draft alone", async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const old = results.getSnapshot().t1.groups[0].pivot!
    // The draft is edited and not built: Update does not take it.
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    const draft = pivot.getSnapshot().tabs.t1.draft
    const filtered = view(first, 1, [{ op: 'notIn', column: 0, rows: [5], nulls: true }])
    await show(results, first, one, filtered)
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(true)
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    filtered.pivot.mockImplementationOnce(() => building.promise)
    const updating = pivot.update('t1', old.key)
    expect(filtered.pivot).toHaveBeenCalledWith({ rows: [0], values: [{ aggregate: 'count' }] }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    // While it builds the old Pivot is the group's, readable, and the caption's state says the group is building.
    expect(pivot.building('t1', 1)).toBe(true)
    expect(pivot.getSnapshot().building).toEqual({ t1: [1] })
    expect(results.getSnapshot().t1.groups[0].pivot).toBe(old)
    expect(client.released()).toEqual([])
    // A second Update while it builds asks for nothing more.
    await pivot.update('t1', old.key)
    expect(filtered.pivot).toHaveBeenCalledOnce()
    building.resolve(pivoted(901, 4))
    await updating
    await settle()
    const tab = results.getSnapshot().t1
    expect(tab.groups[0].pivot).toMatchObject({ key: old.key, revision: 2, entry: { descriptor: { resultId: 901 } }, pivot: { recipe: { rows: [0] }, filters: [{ op: 'notIn', column: 0, rows: [5], nulls: true }], inputRows: 4 } })
    expect(pivotOutOfDate(tab, tab.groups[0])).toBe(false)
    expect(client.released()).toEqual([old.entry.descriptor.resultId])
    expect(pivot.getSnapshot().building).toEqual({})
    expect(pivot.getSnapshot().tabs.t1.draft).toBe(draft)
    expect(tab.jobNotice).toBe('')
    // Named from the Table's grid too: the filter removed (the grid still sorted), it is out of date again, and Update
    // reads the sorted view, which applies no filter.
    const sorted = view(first, 2, [])
    await show(results, first, one, sorted, 1)
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(true)
    sorted.pivot.mockResolvedValueOnce(pivoted(902, 9))
    await pivot.update('t1', one)
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: old.key, revision: 3, pivot: { filters: [], inputRows: 9 } })
    // With no Pivot, Update does nothing.
    results.removeEntry('t1', old.key)
    await pivot.update('t1', one)
    expect(results.getSnapshot().t1.groups[0].pivot).toBeUndefined()
  })

  it('shows the rebuilt Pivot before its build stops reading as building, so its old mark and Update never come back between', async () => {
    const { results, pivot, run, flush } = fixture({ frames: true })
    const [first] = run(1)
    flush()
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    flush()
    const old = results.getSnapshot().t1.groups[0].pivot!
    const filtered = view(first, 1, [{ op: 'in', column: 0, rows: [1], nulls: false }])
    vi.mocked(first.sort).mockResolvedValueOnce(filtered)
    results.sortBy('t1', one, 0, 'ascending')
    await settle()
    flush()
    results.viewShown('t1', one, filtered)
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(true)
    filtered.pivot.mockResolvedValueOnce(pivoted(941, 1))
    // Whenever the builds change, the run the results publish says whether the Pivot is out of date: while one is in
    // flight the caption shows Cancel; once none is, the published Pivot is already the new one, up to date. Results that
    // publish on frames (no flush here) still publish a replacement at once (ResultsService.replaceSet).
    const seen: string[] = []
    const unsubscribe = pivot.subscribe(() => {
      const tab = results.getSnapshot().t1
      seen.push(`${pivot.building('t1', 1) ? 'building' : 'idle'} ${tab.groups[0].pivot!.entry.descriptor.resultId} ${pivotOutOfDate(tab, tab.groups[0]) ? 'stale' : 'current'}`)
    })
    await pivot.update('t1', old.key)
    unsubscribe()
    expect(seen.filter(line => line.startsWith('idle')).length).toBeGreaterThan(0)
    expect(new Set(seen.filter(line => line.startsWith('idle')))).toEqual(new Set(['idle 941 current']))
    expect(seen).not.toContain(`idle ${old.entry.descriptor.resultId} stale`)
  })

  it('keeps the old Pivot when Update fails, is cancelled or is refused, and says why in the toolbar and the builder', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    const kept = results.getSnapshot().t1.groups[0].pivot!
    // The builder is closed: Update's sentences still reach the toolbar.
    pivot.close('t1')
    await show(results, first, one, view(first, 1, [{ op: 'in', column: 0, rows: [1], nulls: false }]))
    const shown = results.sortOf('t1', one)!.view as ResultView & { pivot: ReturnType<typeof vi.fn> }
    // Refused by memory: the old Pivot is never freed to make room.
    shown.pivot.mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await pivot.update('t1', kept.key)
    const tooLarge = 'There is not enough result memory to pivot these rows. Close other results and try again, or close Pivot of Result 1 and build it again.'
    expect(results.getSnapshot().t1.groups[0].pivot).toBe(kept)
    expect(results.getSnapshot().t1.jobNotice).toBe(tooLarge)
    expect(pivot.getSnapshot().tabs.t1.error).toBe(tooLarge)
    expect(client.released()).toEqual([])
    // Refused because the query's budget stopped: the backend's sentence.
    shown.pivot.mockRejectedValueOnce(new ResultError('BUDGET_STOPPED', "This query's results filled its result memory, so it can store nothing more. Run the query again returning fewer rows."))
    await pivot.update('t1', kept.key)
    expect(results.getSnapshot().t1.jobNotice).toBe("This query's results filled its result memory, so it can store nothing more. Run the query again returning fewer rows.")
    // Cancelled from the caption by the group's number, while the builder follows another group: the builder's own Cancel
    // stops nothing of this group's, the caption's does, and the late answer is released.
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    shown.pivot.mockImplementationOnce(() => building.promise)
    const updating = pivot.update('t1', kept.key)
    pivot.open('t1', keyAt(results, 't1', 2))
    expect(pivot.getSnapshot().tabs.t1.source).toBe(keyAt(results, 't1', 2))
    pivot.cancel('t1')
    expect(pivot.building('t1', 1)).toBe(true)
    pivot.cancel('t1', 1)
    building.resolve(pivoted(911))
    await updating
    expect(results.getSnapshot().t1.groups[0].pivot).toBe(kept)
    expect(client.released()).toEqual([911])
    expect(results.getSnapshot().t1.jobNotice).toBe('Building was cancelled, so Pivot of Result 1 still shows its last build.')
    expect(pivot.getSnapshot().building).toEqual({})
    // Still out of date: Update stays offered.
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(true)
    // Build Pivot on the group while an Update runs gives the Update up silently; the new build takes the slot.
    results.notify('t1', 'Earlier notice.')
    const slow = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    let updateSignal: AbortSignal | undefined
    shown.pivot.mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => { updateSignal = o?.signal; return slow.promise })
    const superseded = pivot.update('t1', kept.key)
    pivot.open('t1', one)
    shown.pivot.mockResolvedValueOnce(pivoted(912, 2))
    await pivot.run('t1')
    expect(updateSignal?.aborted).toBe(true)
    slow.resolve(pivoted(913))
    await superseded
    await settle()
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: kept.key, entry: { descriptor: { resultId: 912 } } })
    expect(client.released()).toContain(913)
    expect(results.getSnapshot().t1.jobNotice).toBe('Earlier notice.')
    expect(pivot.getSnapshot().building).toEqual({})
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(false)
  })

  it('updates nothing while the query runs or the backend is gone, and gives up an Update whose Table, Pivot or run goes', async () => {
    const { client, results, pivot, run } = fixture()
    let [first] = run(2)
    let one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    let old = results.getSnapshot().t1.groups[0].pivot!.key
    await show(results, first, one, view(first, 1, [{ op: 'in', column: 0, rows: [1], nulls: false }]))
    let shown = results.sortOf('t1', one)!.view as ResultView & { pivot: ReturnType<typeof vi.fn> }
    // Its Table closes while it builds (which closes the Pivot with it): the answer is released and recreates nothing.
    let building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    let signal: AbortSignal | undefined
    shown.pivot.mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => { signal = o?.signal; return building.promise })
    let updating = pivot.update('t1', old)
    results.removeEntry('t1', one)
    expect(signal?.aborted).toBe(true)
    building.resolve(pivoted(921))
    await updating
    await settle()
    expect(client.released()).toContain(921)
    expect(results.getSnapshot().t1.groups.map(group => group.ordinal)).toEqual([2])
    expect(results.getSnapshot().t1.jobNotice).toBe('')
    // A new run gives up an Update of the last one, and says nothing about it.
    ;[first] = run(1, { queryId: 'q2' })
    one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    old = results.getSnapshot().t1.groups[0].pivot!.key
    await show(results, first, one, view(first, 2, [{ op: 'in', column: 0, rows: [2], nulls: false }]))
    shown = results.sortOf('t1', one)!.view as ResultView & { pivot: ReturnType<typeof vi.fn> }
    building = deferred()
    shown.pivot.mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => { signal = o?.signal; return building.promise })
    updating = pivot.update('t1', old)
    run(1, { queryId: 'q3', finish: false })
    expect(signal?.aborted).toBe(true)
    building.resolve(pivoted(931))
    await updating
    await settle()
    expect(client.released()).toContain(931)
    expect(results.getSnapshot().t1.jobNotice).toBe('')
    expect(pivot.getSnapshot().building).toEqual({})
    // While a query runs nothing is updated.
    const runningTable = keyAt(results, 't1', 0)
    expect(pivot.canPivot('t1', runningTable)).toBe(false)
    // The backend lost: a Table it no longer holds cannot be pivoted, so Update asks for nothing.
    ;[first] = run(1, { queryId: 'q4' })
    one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    old = results.getSnapshot().t1.groups[0].pivot!.key
    await show(results, first, one, view(first, 3, [{ op: 'in', column: 0, rows: [3], nulls: false }]))
    shown = results.sortOf('t1', one)!.view as ResultView & { pivot: ReturnType<typeof vi.fn> }
    client.lose()
    await settle()
    await pivot.update('t1', old)
    expect(shown.pivot).not.toHaveBeenCalled()
    expect(pivot.getSnapshot().building).toEqual({})
  })
})

describe("a Pivot following its Table's filters", () => {
  const view = (first: FakeHandle, viewId: number, filters: ResultView['filters']) => ({ ...first, viewId, base: first, keys: [], filters, rows: 1, baseRows: 3, complete: true, approximate: false, close: vi.fn(async () => {}), pivot: vi.fn<ResultHandle['pivot']>() }) as unknown as ResultView & { close: ReturnType<typeof vi.fn>; pivot: ReturnType<typeof vi.fn> }
  const pivoted = (resultId: number, rows = 1) => ({ descriptor: descriptor(resultId, { index: 0, kind: 'pivot' }), rows, rowGroups: 1, columnGroups: 0, approximate: false })
  const wait = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
  /** A results pane laid out as `layout` (which a test changes, as the setting would), a clock a build's answer can move
   *  (`clock.ms`), and a run of `count` sets whose first group has a Pivot built over its stored rows in `buildMs`. */
  async function following(o: { layout?: ResultsLayout; count?: number; buildMs?: number } = {}) {
    let layout: ResultsLayout = o.layout ?? 'stacked'
    const listeners = new Set<() => void>(), clock = { ms: 0 }
    // The Results panel shares one dock group with the other output panels unless a test docks them apart (`panel`):
    // picking Messages then shows Messages in its place, as the dock would report.
    const panel: { results?: boolean } = {}
    const host: PivotFollowHost = {
      layout: () => layout, resultsShowing: () => panel.results ?? base.results.getSnapshot().t1?.view === 'results',
      onLayout: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
    }
    const base = fixture({ follow: host, now: () => clock.ms })
    const { results, pivot, run } = base
    const handles = run(o.count ?? 1)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    vi.mocked(handles[0].pivot).mockImplementationOnce(async () => { clock.ms += o.buildMs ?? 40; return pivoted(801, 3) })
    await pivot.run('t1')
    await wait()
    const setLayout = (next: ResultsLayout) => { layout = next; for (const listener of listeners) listener() }
    /** Docks the Results panel apart and says whether it shows (`undefined`: back in the shared group). */
    const setPanel = (results: boolean | undefined) => { panel.results = results; for (const listener of listeners) listener() }
    /** Shows `shown` in the Table's grid, as a filter (or sort, by `column`) the backend built would. */
    const show = async (shown: ResultView, column = 0) => {
      vi.mocked(handles[0].sort).mockResolvedValueOnce(shown)
      results.sortBy('t1', one, column, 'ascending')
      await settle()
      results.viewShown('t1', one, shown)
      await wait()
    }
    const group = () => results.getSnapshot().t1.groups[0]
    const stale = () => pivotOutOfDate(results.getSnapshot().t1, group())
    return { ...base, first: handles[0], handles, one, clock, setLayout, setPanel, show, group, stale }
  }

  it("rebuilds a shown Pivot by itself when its Table is filtered, from its own recipe, under the owner's figures", async () => {
    const { results, pivot, first, show, group, stale, client } = await following()
    expect(pivotFollow).toEqual({ maxSourceRows: 500_000, maxLastBuildMs: 250 })
    const old = group().pivot!
    expect(old.pivot).toMatchObject({ filters: [], buildMs: 40 })
    // The draft is edited and not built: the rebuild does not take it.
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    const filtered = view(first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    filtered.pivot.mockResolvedValueOnce(pivoted(901, 1))
    await show(filtered)
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(filtered.pivot).toHaveBeenCalledWith({ rows: [0], values: [{ aggregate: 'count' }] }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(group().pivot).toMatchObject({ key: old.key, revision: 2, entry: { descriptor: { resultId: 901 } }, pivot: { filters: [{ op: 'in', column: 0, rows: [2], nulls: false }] } })
    expect(stale()).toBe(false)
    expect(client.released()).toEqual([801])
    expect(pivot.getSnapshot().building).toEqual({})
    expect(results.getSnapshot().t1.jobNotice).toBe('')
    // A sort alone changes no aggregate, so nothing is built.
    const sorted = view(first, 2, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    await show(sorted, 1)
    expect(sorted.pivot).not.toHaveBeenCalled()
  })

  it('stays marked with Update past 500,000 stored rows or a last build of 250 ms or more, and follows at the limits', async () => {
    // Rows: the Table's stored rows, whatever its filters keep.
    let f = await following()
    f.first.snapshot = { ...f.first.snapshot, rowsStored: 500_001 }
    let filtered = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    await f.show(filtered)
    expect(filtered.pivot).not.toHaveBeenCalled()
    expect(f.stale()).toBe(true)
    expect(followsByItself(f.group())).toBe(false)
    // Update still builds it on request.
    filtered.pivot.mockResolvedValueOnce(pivoted(901))
    await f.pivot.update('t1', f.one)
    expect(f.stale()).toBe(false)
    // At 500,000 it follows.
    f.first.snapshot = { ...f.first.snapshot, rowsStored: 500_000 }
    filtered = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    filtered.pivot.mockResolvedValueOnce(pivoted(902))
    await f.show(filtered)
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    // Time: the last build's, from taking its place to its answer. 250 ms is not under 250.
    f = await following({ buildMs: 250 })
    expect(f.group().pivot!.pivot!.buildMs).toBe(250)
    filtered = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    await f.show(filtered)
    expect(filtered.pivot).not.toHaveBeenCalled()
    expect(f.stale()).toBe(true)
    // An Update that takes 249 ms makes the next change follow by itself.
    filtered.pivot.mockImplementationOnce(async () => { f.clock.ms += 249; return pivoted(903) })
    await f.pivot.update('t1', f.one)
    expect(f.group().pivot!.pivot!.buildMs).toBe(249)
    filtered = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    filtered.pivot.mockResolvedValueOnce(pivoted(904))
    await f.show(filtered)
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
  })

  it('measures a build from when it takes its place, leaving out its wait for one', async () => {
    const jobs = new DerivedJobs()
    const clock = { ms: 0 }
    const { results, pivot, run } = fixture({ jobs, follow: { layout: () => 'stacked', resultsShowing: () => true, onLayout: () => () => {} }, now: () => clock.ms })
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    // Every place is taken by other work for 5 s; the build itself then takes 30 ms.
    const others = Array.from({ length: derivedLimits.parallel }, () => deferred<void>())
    const held = others.map(other => jobs.run(() => other.promise))
    pivot.open('t1', one)
    vi.mocked(first.pivot).mockImplementationOnce(async () => { clock.ms += 30; return pivoted(801) })
    const building = pivot.run('t1')
    clock.ms += 5000
    others[0].resolve()
    await building
    for (const other of others) other.resolve()
    await Promise.all(held)
    expect(results.getSnapshot().t1.groups[0].pivot!.pivot!.buildMs).toBe(30)
  })

  it('leaves a hidden Pivot marked and rebuilds it when it is shown: a collapsed item expanded, its view tab selected, Results shown again', async () => {
    // Stacked: collapsed is its caption alone.
    const f = await following({ count: 2 })
    const pivotKey = f.group().pivot!.key
    f.results.setCollapsed('t1', new Set([pivotKey]))
    let filtered = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    filtered.pivot.mockResolvedValue(pivoted(901))
    await f.show(filtered)
    expect(filtered.pivot).not.toHaveBeenCalled()
    expect(f.stale()).toBe(true)
    // Collapsing another item changes nothing; expanding the Pivot rebuilds it.
    f.results.setCollapsed('t1', new Set([pivotKey, keyAt(f.results, 't1', 2)]))
    await wait()
    expect(filtered.pivot).not.toHaveBeenCalled()
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    // Tabs: the Table's view tab is selected while it is filtered, so the Pivot is hidden until its own tab is.
    f.setLayout('tabs')
    f.results.focusEntry('t1', f.one)
    filtered = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    filtered.pivot.mockResolvedValue(pivoted(902))
    await f.show(filtered)
    expect(filtered.pivot).not.toHaveBeenCalled()
    // Another group's tab selected: still hidden.
    f.results.focusEntry('t1', keyAt(f.results, 't1', 2))
    await wait()
    expect(filtered.pivot).not.toHaveBeenCalled()
    f.results.focusEntry('t1', pivotKey)
    await wait()
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    // Messages shown in place of Results: hidden; Results again: shown.
    f.results.setView('t1', 'messages')
    filtered = view(f.first, 3, [{ op: 'in', column: 0, rows: [4], nulls: false }])
    filtered.pivot.mockResolvedValue(pivoted(903))
    await f.show(filtered)
    expect(filtered.pivot).not.toHaveBeenCalled()
    f.results.setView('t1', 'results')
    await wait()
    expect(filtered.pivot).toHaveBeenCalledOnce()
    // Switching the layout shows it too: in Tabs with its Table selected it is hidden; stacked and expanded it is shown.
    f.results.focusEntry('t1', f.one)
    filtered = view(f.first, 4, [{ op: 'in', column: 0, rows: [5], nulls: false }])
    filtered.pivot.mockResolvedValue(pivoted(904))
    await f.show(filtered)
    expect(filtered.pivot).not.toHaveBeenCalled()
    f.setLayout('stacked')
    await wait()
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    // What shown means, as a function of the run, the layout and the collapsed items.
    const tab = f.results.getSnapshot().t1
    expect(pivotShown(tab, f.group(), 'stacked', new Set(), true)).toBe(true)
    expect(pivotShown(tab, f.group(), 'stacked', new Set(), false)).toBe(false)
    expect(pivotShown(tab, f.group(), 'stacked', new Set([pivotKey]), true)).toBe(false)
    expect(pivotShown(tab, f.group(), 'tabs', new Set(), true)).toBe(false)
    expect(pivotShown({ ...tab, focused: pivotKey }, f.group(), 'tabs', new Set([pivotKey]), true)).toBe(true)
    expect(pivotShown({ ...tab, bare: true }, f.group(), 'stacked', new Set(), true)).toBe(false)
    expect(pivotShown(tab, { pivot: undefined }, 'stacked', new Set(), true)).toBe(false)
  })

  it('gives up the build in flight when the filters change again, publishing only the last; a build the user started is not overtaken', async () => {
    const f = await following()
    const old = f.group().pivot!
    const a = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    const slow = deferred<ReturnType<typeof pivoted>>()
    let signal: AbortSignal | undefined
    a.pivot.mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => { signal = o?.signal; return slow.promise })
    await f.show(a)
    expect(f.pivot.building('t1', 1)).toBe(true)
    const b = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    const second = deferred<ReturnType<typeof pivoted>>()
    b.pivot.mockImplementationOnce(() => second.promise)
    await f.show(b)
    expect(signal?.aborted).toBe(true)
    expect(b.pivot).toHaveBeenCalledOnce()
    // The first answers late: released, nothing published; the old Pivot is still the group's.
    slow.resolve(pivoted(901))
    await wait()
    expect(f.client.released()).toContain(901)
    expect(f.group().pivot).toBe(old)
    second.resolve(pivoted(902))
    await wait()
    expect(f.group().pivot).toMatchObject({ key: old.key, revision: 2, entry: { descriptor: { resultId: 902 } }, pivot: { filters: b.filters } })
    expect(f.results.getSnapshot().t1.jobNotice).toBe('')
    // Undoing the change while a rebuild is in flight gives it up too: the Pivot already matches.
    const c = view(f.first, 3, [{ op: 'in', column: 0, rows: [4], nulls: false }])
    const third = deferred<ReturnType<typeof pivoted>>()
    let thirdSignal: AbortSignal | undefined
    c.pivot.mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => { thirdSignal = o?.signal; return third.promise })
    await f.show(c)
    const back = view(f.first, 4, b.filters)
    await f.show(back)
    expect(thirdSignal?.aborted).toBe(true)
    expect(back.pivot).not.toHaveBeenCalled()
    third.resolve(pivoted(903))
    await wait()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(902)
    expect(f.stale()).toBe(false)
    // An Update the user started reads the filters it was asked over; a change meanwhile does not give it up, and once it
    // publishes, the Pivot (out of date again) follows the newer filters.
    const d = view(f.first, 5, [{ op: 'in', column: 0, rows: [5], nulls: false }])
    f.results.setCollapsed('t1', new Set([old.key]))
    await f.show(d)
    const updating = deferred<ReturnType<typeof pivoted>>()
    let updateSignal: AbortSignal | undefined
    d.pivot.mockImplementationOnce((_spec: unknown, o?: { signal?: AbortSignal }) => { updateSignal = o?.signal; return updating.promise })
    const update = f.pivot.update('t1', f.one)
    f.results.setCollapsed('t1', new Set())
    const e = view(f.first, 6, [{ op: 'in', column: 0, rows: [6], nulls: false }])
    e.pivot.mockResolvedValueOnce(pivoted(905))
    await f.show(e)
    expect(updateSignal?.aborted).toBe(false)
    expect(e.pivot).not.toHaveBeenCalled()
    updating.resolve(pivoted(904))
    await update
    await wait()
    expect(e.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot).toMatchObject({ entry: { descriptor: { resultId: 905 } }, pivot: { filters: e.filters } })
  })

  it('keeps the old Pivot and its mark when a rebuild fails, is refused or cancelled, and does not ask again for the same filters', async () => {
    const f = await following()
    const kept = f.group().pivot!
    const filtered = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    filtered.pivot.mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await f.show(filtered)
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot).toBe(kept)
    expect(f.stale()).toBe(true)
    // The toolbar says why: nobody asked for this build, and the builder may be closed or on another group.
    expect(f.results.getSnapshot().t1.jobNotice).toBe('There is not enough result memory to pivot these rows. Close other results and try again, or close Pivot of Result 1 and build it again.')
    // Publishes that change nothing it reads (a sort over the same filters, hiding and showing it) ask nothing more.
    const sorted = view(f.first, 2, filtered.filters)
    await f.show(sorted, 1)
    f.results.setCollapsed('t1', new Set([kept.key]))
    await wait()
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(sorted.pivot).not.toHaveBeenCalled()
    // Other filters try again; this time the user cancels it from the caption: the old Pivot stays, marked, and the same
    // filters are not tried again.
    const other = view(f.first, 3, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    const slow = deferred<ReturnType<typeof pivoted>>()
    other.pivot.mockImplementationOnce(() => slow.promise)
    await f.show(other)
    expect(f.pivot.building('t1', 1)).toBe(true)
    f.pivot.cancel('t1', 1)
    slow.resolve(pivoted(911))
    await wait()
    expect(f.group().pivot).toBe(kept)
    expect(f.stale()).toBe(true)
    expect(f.client.released()).toContain(911)
    expect(f.results.getSnapshot().t1.jobNotice).toBe('Building was cancelled, so Pivot of Result 1 still shows its last build.')
    f.results.setCollapsed('t1', new Set([kept.key]))
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(other.pivot).toHaveBeenCalledOnce()
    // Update stays offered and builds it on request.
    other.pivot.mockResolvedValueOnce(pivoted(912))
    await f.pivot.update('t1', f.one)
    expect(f.stale()).toBe(false)
  })

  it("rebuilds once when a rebuild changes nothing it is compared by, and once for filters of the same rows told apart (PR 11's false positives)", async () => {
    const f = await following()
    // The backend closed the view: the rebuild runs over the same filters built again, which resolve in another form
    // (as a snapshot that froze another way would). The Pivot stays marked; nothing loops.
    const filtered = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    filtered.pivot.mockRejectedValueOnce(new ResultError('VIEW_NOT_FOUND', 'The view was closed.'))
    const rebuilt = view(f.first, 9, [{ op: 'notIn', column: 0, rows: [1, 3], nulls: true }])
    rebuilt.pivot.mockResolvedValueOnce(pivoted(901))
    vi.mocked(f.first.sort).mockResolvedValueOnce(filtered).mockResolvedValueOnce(rebuilt)
    f.results.sortBy('t1', f.one, 0, 'ascending')
    await settle()
    f.results.viewShown('t1', f.one, filtered)
    await wait()
    expect(rebuilt.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    expect(f.stale()).toBe(true)
    // Other publishes (the focus moving, a collapse round trip) build nothing more.
    f.results.focusEntry('t1', f.group().pivot!.key)
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(filtered.pivot).toHaveBeenCalledOnce()
    expect(rebuilt.pivot).toHaveBeenCalledOnce()
    // A header checklist, then the same values ticked over other rows (another digest): told apart, so one rebuild each,
    // and none after it.
    const checklist = view(f.first, 2, [{ op: 'groups', column: 1, snapshotId: 4, keep: true, values: 2, nulls: false, digest: '1'.repeat(32) }])
    checklist.pivot.mockResolvedValue(pivoted(902))
    await f.show(checklist)
    expect(checklist.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    const again = view(f.first, 3, [{ op: 'groups', column: 1, snapshotId: 5, keep: true, values: 2, nulls: false, digest: '2'.repeat(32) }])
    again.pivot.mockResolvedValue(pivoted(903))
    await f.show(again)
    await f.show(view(f.first, 4, again.filters), 1)
    expect(again.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    // The same values ticked again (the same digest): nothing at all.
    const same = view(f.first, 5, [{ ...again.filters[0], snapshotId: 6 } as ResolvedViewFilter])
    await f.show(same)
    expect(same.pivot).not.toHaveBeenCalled()
    expect(f.stale()).toBe(false)
  })

  it('tries filters again after giving up their rebuild itself, follows at once when a user build fails, and leaves a user cancel alone', async () => {
    const f = await following()
    // F1, its rebuild in flight; the change undone (given up); F1 made again: rebuilt, since F1 was never built over.
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    const slow = deferred<ReturnType<typeof pivoted>>()
    f1.pivot.mockImplementationOnce(() => slow.promise)
    await f.show(f1)
    await f.show(view(f.first, 2, []))
    const again = view(f.first, 3, f1.filters)
    again.pivot.mockResolvedValueOnce(pivoted(901))
    await f.show(again)
    expect(again.pivot).toHaveBeenCalledOnce()
    expect(f.stale()).toBe(false)
    slow.resolve(pivoted(900))
    await wait()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    // Build Pivot (the user's) over F2, the filters changed to F3 while it runs, and it fails: F3 is followed at once,
    // with no other publish needed.
    const f2 = view(f.first, 4, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    await f.show(f2)
    let reject: (error: unknown) => void = () => {}
    const failing = { promise: new Promise<ReturnType<typeof pivoted>>((_, no) => { reject = no }), reject: (error: unknown) => reject(error) }
    f2.pivot.mockImplementationOnce(() => failing.promise)
    f.pivot.open('t1', f.one)
    const building = f.pivot.run('t1')
    f.results.setCollapsed('t1', new Set())
    const f3 = view(f.first, 5, [{ op: 'in', column: 0, rows: [4], nulls: false }])
    f3.pivot.mockResolvedValueOnce(pivoted(902))
    await f.show(f3)
    expect(f3.pivot).not.toHaveBeenCalled()
    failing.reject(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await building
    await wait()
    expect(f3.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot).toMatchObject({ entry: { descriptor: { resultId: 902 } }, pivot: { filters: f3.filters } })
    // An Update over F4, the filters changed to F5 while it runs, cancelled from the caption: nothing starts by itself.
    const f4 = view(f.first, 6, [{ op: 'in', column: 0, rows: [5], nulls: false }])
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    await f.show(f4)
    const updating = deferred<ReturnType<typeof pivoted>>()
    f4.pivot.mockImplementationOnce(() => updating.promise)
    const update = f.pivot.update('t1', f.one)
    f.results.setCollapsed('t1', new Set())
    const f5 = view(f.first, 7, [{ op: 'in', column: 0, rows: [6], nulls: false }])
    await f.show(f5)
    f.pivot.cancel('t1', 1)
    updating.resolve(pivoted(903))
    await update
    await wait()
    expect(f5.pivot).not.toHaveBeenCalled()
    expect(f.stale()).toBe(true)
    expect(f.results.getSnapshot().t1.jobNotice).toBe('Building was cancelled, so Pivot of Result 1 still shows its last build.')
  })

  it("keeps a failed Build Pivot's reason when the Pivot then follows the filters from its own recipe, and marks a followed build", async () => {
    const f = await following()
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    await f.show(f1)
    // Another recipe in the draft, built over F1; the filters change to F2 while it runs, and it is refused.
    f.pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    let reject: (error: unknown) => void = () => {}
    f1.pivot.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
    const building = f.pivot.run('t1')
    f.results.setCollapsed('t1', new Set())
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f2.pivot.mockResolvedValueOnce(pivoted(902))
    await f.show(f2)
    reject(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await building
    await wait()
    // The Pivot follows F2 from its own recipe, not the draft, and the builder still says why the Build Pivot failed.
    expect(f2.pivot).toHaveBeenCalledWith({ rows: [0], values: [{ aggregate: 'count' }] }, expect.anything())
    expect(f.group().pivot).toMatchObject({ entry: { descriptor: { resultId: 902 } }, pivot: { filters: f2.filters, followed: true } })
    expect(f.pivot.getSnapshot().tabs.t1.error).toBe('There is not enough result memory to pivot these rows. Close other results and try again, or close Pivot of Result 1 and build it again.')
    // A build the user asks for clears it and is not marked as followed.
    f2.pivot.mockResolvedValueOnce(pivoted(903))
    await f.pivot.run('t1')
    expect(f.pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    expect(f.group().pivot!.pivot!.followed).toBeUndefined()
  })

  it('releases an automatic answer that lands after a copy of the Pivot started, before the copy is published', async () => {
    const clock = { ms: 0 }
    const f = fixture({ frames: true, follow: { layout: () => 'stacked', resultsShowing: () => true, onLayout: () => () => {} }, now: () => clock.ms })
    const [first] = f.run(1)
    f.flush()
    const one = keyAt(f.results, 't1', 0)
    f.pivot.open('t1', one)
    vi.mocked(first.pivot).mockImplementationOnce(async () => pivoted(801, 3))
    await f.pivot.run('t1')
    f.flush()
    await wait()
    const pivotKey = f.results.getSnapshot().t1.groups[0].pivot!.key
    // F1's rebuild runs.
    const f1 = view(first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    const answer = deferred<ReturnType<typeof pivoted>>()
    f1.pivot.mockImplementationOnce(() => answer.promise)
    vi.mocked(first.sort).mockResolvedValueOnce(f1)
    f.results.sortBy('t1', one, 0, 'ascending')
    await settle()
    f.flush()
    f.results.viewShown('t1', one, f1)
    f.flush()
    await wait()
    expect(f1.pivot).toHaveBeenCalledOnce()
    // The user copies the Pivot, and the rebuild's answer lands before the next frame publishes the copy.
    const copying = deferred<Awaited<ReturnType<VariaApi['copyResults']>>>()
    f.api.copyResults.mockReturnValueOnce(copying.promise)
    f.results.setSelection('t1', pivotKey, selectAll(pivotKey))
    const copied = f.results.copy('t1', pivotKey, false)
    answer.resolve(pivoted(901))
    await wait()
    expect(f.api.cancelResultsJob).not.toHaveBeenCalled()
    expect(f.client.released()).toContain(901)
    expect(f.results.getSnapshot().t1.groups[0].pivot!.entry.descriptor.resultId).toBe(801)
    // The copy ends: the same filters are built again.
    f1.pivot.mockResolvedValueOnce(pivoted(902))
    copying.resolve({ ok: true, value: { rows: 3, bytes: 12, partial: false, truncatedCells: 0, capped: 0 } })
    await copied
    f.flush()
    await wait()
    f.flush()
    expect(f1.pivot).toHaveBeenCalledTimes(2)
    expect(f.results.getSnapshot().t1.groups[0].pivot!.entry.descriptor.resultId).toBe(902)
  })

  it("holds a rebuild by itself back while the user's copy of the Pivot runs, giving up one in flight, and follows once it ends", async () => {
    const f = await following()
    const pivotKey = f.group().pivot!.key
    // A copy of the Pivot runs when the Table is filtered: nothing is built, so the copy goes on.
    const copying = deferred<Awaited<ReturnType<VariaApi['copyResults']>>>()
    f.api.copyResults.mockReturnValueOnce(copying.promise)
    f.results.setSelection('t1', pivotKey, selectAll(pivotKey))
    const copied = f.results.copy('t1', pivotKey, false)
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f1.pivot.mockResolvedValueOnce(pivoted(901))
    await f.show(f1)
    expect(f1.pivot).not.toHaveBeenCalled()
    expect(f.api.cancelResultsJob).not.toHaveBeenCalled()
    expect(f.stale()).toBe(true)
    // The copy ends: the Pivot follows.
    copying.resolve({ ok: true, value: { rows: 3, bytes: 12, partial: false, truncatedCells: 0, capped: 0 } })
    await copied
    await wait()
    expect(f1.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    // A rebuild already running when a copy of the Pivot starts is given up, and runs again once the copy ends.
    const newKey = f.group().pivot!.key
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    let signal: AbortSignal | undefined
    f2.pivot.mockImplementationOnce((_spec, options) => new Promise((_, no) => { signal = options?.signal; signal?.addEventListener('abort', () => no(new Error('aborted'))) }))
    await f.show(f2)
    expect(f2.pivot).toHaveBeenCalledOnce()
    const again = deferred<Awaited<ReturnType<VariaApi['copyResults']>>>()
    f.api.copyResults.mockReturnValueOnce(again.promise)
    f.results.setSelection('t1', newKey, selectAll(newKey))
    const second = f.results.copy('t1', newKey, false)
    await wait()
    expect(signal?.aborted).toBe(true)
    expect(f.api.cancelResultsJob).not.toHaveBeenCalled()
    f2.pivot.mockResolvedValueOnce(pivoted(902))
    again.resolve({ ok: true, value: { rows: 3, bytes: 12, partial: false, truncatedCells: 0, capped: 0 } })
    await second
    await wait()
    expect(f2.pivot).toHaveBeenCalledTimes(2)
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(902)
    expect(f.stale()).toBe(false)
  })

  it('asks the dock whether Results shows, not the output view last picked: Messages docked apart, or Results hidden', async () => {
    const f = await following()
    // Messages docked beside Results and picked: Results still shows, so the Pivot follows.
    f.setPanel(true)
    f.results.setView('t1', 'messages')
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f1.pivot.mockResolvedValueOnce(pivoted(901))
    await f.show(f1)
    expect(f1.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    expect(f.results.getSnapshot().t1.view).toBe('messages')
    // The Results panel hidden (closed, or Ctrl+R), the output view still Results: the Pivot is hidden and keeps its mark.
    f.results.setView('t1', 'results')
    f.setPanel(false)
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f2.pivot.mockResolvedValueOnce(pivoted(902))
    await f.show(f2)
    expect(f2.pivot).not.toHaveBeenCalled()
    expect(f.stale()).toBe(true)
    // Shown again: the dock's report alone wakes it.
    f.setPanel(true)
    await wait()
    expect(f2.pivot).toHaveBeenCalledOnce()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(902)
    expect(f.stale()).toBe(false)
  })

  it('gives up an automatic build when its item is collapsed, or another view selected in Tabs, while it runs', async () => {
    const f = await following({ count: 2 })
    const pivotKey = f.group().pivot!.key
    const pending = (target: ReturnType<typeof view>) => {
      const state: { signal?: AbortSignal } = {}
      target.pivot.mockImplementationOnce((_spec, options) => new Promise((_, no) => { state.signal = options?.signal; state.signal?.addEventListener('abort', () => no(new Error('aborted'))) }))
      return state
    }
    // Stacked: collapsed while it builds.
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    const first = pending(f1)
    await f.show(f1)
    f.results.setCollapsed('t1', new Set([pivotKey]))
    await wait()
    expect(first.signal?.aborted).toBe(true)
    expect(f.results.getSnapshot().t1.jobNotice).toBe('')
    expect(f.stale()).toBe(true)
    f1.pivot.mockResolvedValueOnce(pivoted(901))
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(f1.pivot).toHaveBeenCalledTimes(2)
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    // Tabs: the Pivot selected while it builds, then another group's view.
    f.setLayout('tabs')
    f.results.focusEntry('t1', pivotKey)
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    const second = pending(f2)
    // The filter is applied from the Table, then the Pivot's tab selected again before it builds.
    f.results.focusEntry('t1', f.one)
    await f.show(f2)
    expect(f2.pivot).not.toHaveBeenCalled()
    f.results.focusEntry('t1', pivotKey)
    await wait()
    expect(f2.pivot).toHaveBeenCalledOnce()
    f.results.focusEntry('t1', keyAt(f.results, 't1', 2))
    await wait()
    expect(second.signal?.aborted).toBe(true)
    expect(f.results.getSnapshot().t1.jobNotice).toBe('')
    f2.pivot.mockResolvedValueOnce(pivoted(902))
    f.results.focusEntry('t1', pivotKey)
    await wait()
    expect(f2.pivot).toHaveBeenCalledTimes(2)
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(902)
    expect(f.stale()).toBe(false)
  })

  it('gives up an automatic build whose Pivot is hidden while it runs, leaves the pane the user picked, and rebuilds once shown', async () => {
    const f = await following()
    // F1's rebuild starts while the Pivot is shown, then the user shows Messages before it answers.
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    let signal: AbortSignal | undefined
    f1.pivot.mockImplementationOnce((_spec, options) => new Promise((_, no) => { signal = options?.signal; signal?.addEventListener('abort', () => no(new Error('aborted'))) }))
    await f.show(f1)
    expect(f1.pivot).toHaveBeenCalledOnce()
    f.results.setView('t1', 'messages')
    await wait()
    expect(signal?.aborted).toBe(true)
    expect(f.results.getSnapshot().t1.view).toBe('messages')
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(801)
    expect(f.stale()).toBe(true)
    expect(f.results.getSnapshot().t1.jobNotice).toBe('')
    // Results shown again: the same filters are built over, since the given-up build never answered for them.
    f1.pivot.mockResolvedValueOnce(pivoted(901))
    f.results.setView('t1', 'results')
    await wait()
    expect(f1.pivot).toHaveBeenCalledTimes(2)
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    expect(f.stale()).toBe(false)
  })

  it('leaves the pane the user picked when a followed rebuild is added, and shows Results for one the user asked for', async () => {
    const f = await following()
    f.results.setView('t1', 'messages')
    const provenance = { ...f.group().pivot!.pivot!, followed: true as const }
    f.results.addSet('t1', pivoted(905).descriptor, 'Pivot of Result 1', [setKey(f.group().table.entry.descriptor)], { pivot: provenance })
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(905)
    expect(f.results.getSnapshot().t1.view).toBe('messages')
    const { followed: _followed, ...asked } = provenance
    f.results.addSet('t1', pivoted(906).descriptor, 'Pivot of Result 1', [setKey(f.group().table.entry.descriptor)], { pivot: asked })
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(906)
    expect(f.results.getSnapshot().t1.view).toBe('results')
  })

  it("keeps a failed Build Pivot's reason when an automatic rebuild then fails too, which only the toolbar says", async () => {
    const f = await following()
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    await f.show(f1)
    // A Build Pivot of another draft fails over F1.
    f.pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    f1.pivot.mockRejectedValueOnce(new Error('The draft could not be pivoted.'))
    await f.pivot.run('t1')
    expect(f.pivot.getSnapshot().tabs.t1.error).toBe('The draft could not be pivoted.')
    // Expanded over F2, the Pivot follows from its recipe and fails: the builder keeps the draft's reason.
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f2.pivot.mockRejectedValueOnce(new Error('The automatic rebuild failed.'))
    await f.show(f2)
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(f2.pivot).toHaveBeenCalledWith({ rows: [0], values: [{ aggregate: 'count' }] }, expect.anything())
    expect(f.pivot.getSnapshot().tabs.t1.error).toBe('The draft could not be pivoted.')
    expect(f.results.getSnapshot().t1.jobNotice).toBe('The automatic rebuild failed.')
    expect(f.stale()).toBe(true)
  })

  it("clears a cancelled Build Pivot's message once the Pivot follows newer filters", async () => {
    const f = await following()
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    await f.show(f1)
    // The user cancels a Build Pivot over F1: the builder says it was cancelled.
    f1.pivot.mockImplementationOnce((_spec, options) => new Promise((_, no) => options?.signal?.addEventListener('abort', () => no(new Error('aborted')))))
    const building = f.pivot.run('t1')
    await wait()
    f.pivot.cancel('t1')
    await building
    await wait()
    expect(f.pivot.getSnapshot().tabs.t1.error).toMatch(/cancel/i)
    // Expanded over F2, the Pivot follows by itself, and the cancel's message goes with the build it was about.
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f2.pivot.mockResolvedValueOnce(pivoted(902))
    await f.show(f2)
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(902)
    expect(f.pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it('decides nothing over a view the grid shows that the results have yet to publish, and follows it once published', async () => {
    let layout: ResultsLayout = 'tabs'
    const listeners = new Set<() => void>(), clock = { ms: 0 }
    const f = fixture({ frames: true, follow: { layout: () => layout, resultsShowing: () => true, onLayout: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }, now: () => clock.ms })
    const [first] = f.run(1)
    f.flush()
    const one = keyAt(f.results, 't1', 0)
    f.pivot.open('t1', one)
    vi.mocked(first.pivot).mockImplementationOnce(async () => pivoted(801, 3))
    await f.pivot.run('t1')
    f.flush()
    await wait()
    // Tabs, the Table selected: filter A shows and publishes, so the hidden Pivot is marked.
    f.results.focusEntry('t1', one)
    const showView = async (shown: ResultView, publish: boolean) => {
      vi.mocked(first.sort).mockResolvedValueOnce(shown)
      f.results.sortBy('t1', one, 0, 'ascending')
      await settle()
      if (publish) f.flush()
      f.results.viewShown('t1', one, shown)
      if (publish) f.flush()
      await wait()
    }
    const a = view(first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    await showView(a, true)
    expect(pivotOutOfDate(f.results.getSnapshot().t1, f.results.getSnapshot().t1.groups[0])).toBe(true)
    // Filter B's view shows in the grid, its publish still a frame away, when the layout turns stacked (the Pivot shown):
    // nothing starts over A or B until B publishes.
    const b = view(first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    b.pivot.mockResolvedValueOnce(pivoted(902))
    await showView(b, false)
    expect(f.results.sortOf('t1', one)!.view).toBe(b)
    expect(f.results.getSnapshot().t1.sorts.get(one)!.view).toBe(a)
    layout = 'stacked'
    for (const listener of listeners) listener()
    await wait()
    expect(a.pivot).not.toHaveBeenCalled()
    expect(b.pivot).not.toHaveBeenCalled()
    f.flush()
    await wait()
    expect(b.pivot).toHaveBeenCalledOnce()
    f.flush()
    const tab = f.results.getSnapshot().t1
    expect(tab.groups[0].pivot).toMatchObject({ entry: { descriptor: { resultId: 902 } }, pivot: { filters: b.filters } })
    expect(pivotOutOfDate(tab, tab.groups[0])).toBe(false)
  })

  it("clears an automatic rebuild's or an Update's failure once the Pivot follows its filters, keeping only a failed Build Pivot's", async () => {
    const f = await following()
    const failure = 'There is not enough result memory to pivot these rows. Close other results and try again.'
    const said = `${failure.replace(/\.$/, '')}, or close Pivot of Result 1 and build it again.`
    // An automatic rebuild over F1 fails; the one over F2 builds: what F1's said goes.
    const f1 = view(f.first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f1.pivot.mockRejectedValueOnce(new ResultError('TOO_LARGE', failure))
    await f.show(f1)
    expect(f.pivot.getSnapshot().tabs.t1.error).toBe(said)
    const f2 = view(f.first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f2.pivot.mockResolvedValueOnce(pivoted(901))
    await f.show(f2)
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(901)
    expect(f.pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    // An Update over F3 fails (the Pivot collapsed, so it waited for the user); expanded over F4, it follows, and the
    // Update's failure goes.
    f.results.setCollapsed('t1', new Set([f.group().pivot!.key]))
    const f3 = view(f.first, 3, [{ op: 'in', column: 0, rows: [4], nulls: false }])
    await f.show(f3)
    f3.pivot.mockRejectedValueOnce(new ResultError('TOO_LARGE', failure))
    await f.pivot.update('t1', f.one)
    expect(f.pivot.getSnapshot().tabs.t1.error).toBe(said)
    const f4 = view(f.first, 4, [{ op: 'in', column: 0, rows: [5], nulls: false }])
    f4.pivot.mockResolvedValueOnce(pivoted(902))
    await f.show(f4)
    f.results.setCollapsed('t1', new Set())
    await wait()
    expect(f.group().pivot!.entry.descriptor.resultId).toBe(902)
    expect(f.pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it("counts the grid's newest view as tried on a Cancel, even before the results publish it", async () => {
    const clock = { ms: 0 }
    const f = fixture({ frames: true, follow: { layout: () => 'stacked', resultsShowing: () => true, onLayout: () => () => {} }, now: () => clock.ms })
    const [first] = f.run(1)
    f.flush()
    const one = keyAt(f.results, 't1', 0)
    f.pivot.open('t1', one)
    vi.mocked(first.pivot).mockImplementationOnce(async () => pivoted(801, 3))
    await f.pivot.run('t1')
    f.flush()
    await wait()
    const showView = async (shown: ResultView, publish: boolean) => {
      vi.mocked(first.sort).mockResolvedValueOnce(shown)
      f.results.sortBy('t1', one, 0, 'ascending')
      await settle()
      if (publish) f.flush()
      f.results.viewShown('t1', one, shown)
      if (publish) f.flush()
      await wait()
    }
    // F1 published: its rebuild runs. F2 shows in the grid, a frame before it publishes, and the user cancels then.
    const f1 = view(first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    f1.pivot.mockImplementationOnce(() => new Promise(() => {}))
    await showView(f1, true)
    expect(f1.pivot).toHaveBeenCalledOnce()
    const f2 = view(first, 2, [{ op: 'in', column: 0, rows: [3], nulls: false }])
    f2.pivot.mockResolvedValue(pivoted(902))
    await showView(f2, false)
    f.pivot.cancel('t1', 1)
    f.flush()
    await wait()
    f.flush()
    await wait()
    expect(f2.pivot).not.toHaveBeenCalled()
    expect(pivotOutOfDate(f.results.getSnapshot().t1, f.results.getSnapshot().t1.groups[0])).toBe(true)
  })

  it('follows nothing without a layout host, nor in a run that has no Pivot yet', async () => {
    // The checks that build no host: nothing follows.
    const { results, pivot, run } = fixture()
    const [first] = run(1)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    await pivot.run('t1')
    const filtered = view(first, 1, [{ op: 'in', column: 0, rows: [2], nulls: false }])
    vi.mocked(first.sort).mockResolvedValueOnce(filtered)
    results.sortBy('t1', one, 0, 'ascending')
    await settle()
    results.viewShown('t1', one, filtered)
    await wait()
    expect(filtered.pivot).not.toHaveBeenCalled()
    expect(pivotOutOfDate(results.getSnapshot().t1, results.getSnapshot().t1.groups[0])).toBe(true)
    // A re-run releases the Pivot; its group has none to follow until one is built.
    const f = await following()
    f.run(1, { queryId: 'q2', finish: false })
    await wait()
    expect(f.results.getSnapshot().t1.groups[0].pivot).toBeUndefined()
    expect(f.pivot.getSnapshot().building).toEqual({})
  })
})

describe('a closed tab\'s pivots', () => {
  it('keep nothing of the tab once its results go, even when a build fails after the close', async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(1)
    pivot.open('t1', keyAt(results, 't1', 0))
    vi.mocked(first.pivot).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows.'))
    await pivot.run('t1')
    const inside = pivot as unknown as { errors: Map<string, unknown>; tried: Map<string, unknown>; running: Map<string, unknown> }
    expect(inside.errors.has('t1')).toBe(true)
    expect(inside.tried.has('t1')).toBe(true)
    // A second build is in flight when the tab closes, and fails afterwards.
    let fail!: (error: unknown) => void
    vi.mocked(first.pivot).mockReturnValueOnce(new Promise((_yes, no) => { fail = no }))
    const building = pivot.run('t1')
    await settle()
    results.release('t1')
    fail(new ResultError('TIMEOUT', 'The pivot took too long.'))
    await building
    expect([inside.errors.has('t1'), inside.tried.has('t1'), inside.running.has('t1')]).toEqual([false, false, false])
  })
})
