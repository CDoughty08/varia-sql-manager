import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { pivotGroup, PivotService } from '../src/renderer/src/results/PivotService'
import { aggregateFits, columnGroupLimit, draftSpec, emptyDraft, fitDraft, isNumericColumn, pivotFacts, pivotStrip, pivotText, remapDraft, valueLabel } from '../src/renderer/src/results/pivot'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt } from './fixtures/entries'
import { deferred } from './fixtures/documents'

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
    expect(pivot.getSnapshot().info.get(setKey(sets[2].descriptor))).toEqual({ source: table, sourceLabel: 'Result 2', viewed: false, rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, pivot: sets[2].key })
    // Closing the builder keeps the group's draft for the next open, from the Table or from the Pivot (which edits it).
    pivot.close('t1')
    expect(pivot.getSnapshot().tabs.t1.open).toBe(false)
    pivot.open('t1', sets[2].key)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ open: true, source: table, draft: { rows: [0] } })
  })

  it('makes no pivot of a Pivot, a comparison, a transpose or a plan set, and none in a bare run', async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const made = results.getSnapshot().t1.sets[1]
    expect(made.label).toBe('Pivot of Result 1')
    const diff = results.addSet('t1', descriptor(901, { index: 0, kind: 'diff' }), 'Differences: Result 1 → Result 2', [setKey(results.getSnapshot().t1.sets[0].descriptor), setKey(results.getSnapshot().t1.sets[2].descriptor)])!
    const turned = results.addSet('t1', descriptor(701, { index: 0, kind: 'transpose' }), 'Transpose of Result 1', [setKey(results.getSnapshot().t1.sets[0].descriptor)])!
    // The builder is the group's whichever of its views is named: on the Pivot it edits the Pivot, read from the Table.
    expect(pivotGroup(results.getSnapshot().t1, made.key)?.table.key).toBe(one)
    expect(pivot.canPivot('t1', made.key)).toBe(true)
    // A comparison and a stored transpose have no group to pivot.
    for (const key of [diff, turned]) {
      expect(pivotGroup(results.getSnapshot().t1, key)).toBeUndefined()
      expect(pivot.canPivot('t1', key)).toBe(false)
    }
    // Opened on one of them, the builder stays on the group it had: what it builds is still read from Result 1.
    pivot.open('t1', diff)
    expect(pivot.getSnapshot().tabs.t1.source).toBe(one)
    vi.mocked(first.pivot).mockClear()
    await pivot.run('t1')
    expect(first.pivot).toHaveBeenCalledOnce()
    expect(client.handle(801)!.pivot).not.toHaveBeenCalled()
    expect(results.getSnapshot().t1.sets.filter(set => set.descriptor.kind === 'pivot')).toHaveLength(1)
    // The service itself takes a pivot only from a group's Table of rows: one made of a Pivot, a comparison or a
    // transpose is refused and released, whoever asks.
    const sets = results.getSnapshot().t1.sets
    const pivotNow = sets.find(set => set.descriptor.kind === 'pivot')!
    for (const [id, source] of [[811, pivotNow], [812, sets.find(set => set.key === diff)!], [813, sets.find(set => set.key === turned)!]] as const) {
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

  it("replaces a group's Pivot when it is built again: the old one is released first, then the new one shown in its place", async () => {
    const { client, results, pivot, run } = fixture()
    const [first] = run(2)
    const one = keyAt(results, 't1', 0)
    pivot.open('t1', one)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    const old = results.getSnapshot().t1.sets[1]
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: old.key, revision: 1 })
    // The Pivot's grid has the focus when it is built again.
    results.focusEntry('t1', old.key)
    expect(results.getSnapshot().t1.groups[0].selected).toBe('pivot')
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, pivot: old.key })
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(first.pivot).mockImplementationOnce(() => building.promise)
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    const pivoting = pivot.run('t1')
    // Released before the new one is built (not yet atomic): the group has no Pivot meanwhile, and the focus is on its
    // Table, so the builder stays with the group.
    expect(client.released()).toEqual([801])
    expect(results.getSnapshot().t1.sets.map(set => set.number)).toEqual([1, 2])
    expect(results.getSnapshot().t1.groups[0].pivot).toBeUndefined()
    expect(results.getSnapshot().t1.focused).toBe(one)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, running: true })
    expect(pivot.getSnapshot().tabs.t1.pivot).toBeUndefined()
    building.resolve({ descriptor: descriptor(811, { index: 0, kind: 'pivot' }), rows: 3, rowGroups: 2, columnGroups: 0, approximate: false })
    await pivoting
    await settle()
    const tab = results.getSnapshot().t1
    // One Pivot, in the old one's place under the Table, as the slot's second result; the old one's strip went with it.
    expect(tab.sets.map(set => [set.number, set.label])).toEqual([[1, undefined], [4, 'Pivot of Result 1'], [2, undefined]])
    expect(tab.groups[0].pivot).toMatchObject({ key: tab.sets[1].key, revision: 2, entry: { descriptor: { resultId: 811 } } })
    expect(tab.groups[0].pivot!.key).not.toBe(old.key)
    expect([...pivot.getSnapshot().info.keys()]).toEqual(['1:811'])
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, pivot: tab.sets[1].key })
    // The old Pivot's grid had the focus: the new one has it, and is its group's selected view again.
    expect(tab.focused).toBe(tab.sets[1].key)
    expect(tab.groups[0].selected).toBe('pivot')
    // The service keeps the rule whoever adds one: a second pivot of the Table takes the slot, releasing the one in it.
    const third = results.addSet('t1', descriptor(821, { index: 0, kind: 'pivot' }), 'Pivot of Result 1', [setKey(tab.sets[0].descriptor)])!
    expect(client.released()).toEqual([801, 811])
    expect(results.getSnapshot().t1.groups[0].pivot).toMatchObject({ key: third, revision: 3 })
    expect(results.getSnapshot().t1.sets.filter(set => set.descriptor.kind === 'pivot')).toHaveLength(1)
    // A build that fails after the release leaves the group without a Pivot, and says why.
    vi.mocked(first.pivot).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to pivot these rows. Close other results and try again.'))
    await pivot.run('t1')
    expect(client.released()).toEqual([801, 811, 821])
    expect(results.getSnapshot().t1.groups[0].pivot).toBeUndefined()
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ running: false, error: 'There is not enough result memory to pivot these rows. Close other results and try again.' })
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

  it('keeps a build and its failure with the group they are for when the builder moves to another', async () => {
    const { results, pivot, run } = fixture()
    const [first] = run(2)
    const [one, two] = results.getSnapshot().t1.sets.map(set => set.key)
    pivot.open('t1', one)
    const building = deferred<Awaited<ReturnType<FakeHandle['pivot']>>>()
    let fail!: (reason: unknown) => void
    vi.mocked(first.pivot).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; void building.promise }))
    const pivoting = pivot.run('t1')
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, running: true })
    // Another grid takes the focus while Result 1 builds: the builder is Result 2's, which is not building, and says
    // whose build is in the way.
    results.focusEntry('t1', two)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: two, running: false, busy: 'Result 1' })
    expect(pivot.canPivot('t1', two)).toBe(false)
    fail(new ResultError('TOO_LARGE', 'Not enough memory for Result 1.'))
    await pivoting
    // The failure is Result 1's: Result 2's builder shows none, and Result 1's shows it when the builder is back.
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: two, running: false })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
    expect(pivot.getSnapshot().tabs.t1.busy).toBeUndefined()
    expect(pivot.canPivot('t1', two)).toBe(true)
    results.focusEntry('t1', one)
    expect(pivot.getSnapshot().tabs.t1).toMatchObject({ source: one, error: 'Not enough memory for Result 1.' })
    // Editing Result 2's draft leaves it; editing Result 1's clears it.
    results.focusEntry('t1', two)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    results.focusEntry('t1', one)
    expect(pivot.getSnapshot().tabs.t1.error).toBe('Not enough memory for Result 1.')
    pivot.setDraft('t1', { rows: [1], values: [{ aggregate: 'count' }] })
    expect(pivot.getSnapshot().tabs.t1.error).toBeUndefined()
  })

  it('follows a stored transpose to its group, and keeps a group\'s draft untouched while a new run has yet to return it', async () => {
    const { client, results, pivot, run } = fixture()
    run(2)
    const sets = () => results.getSnapshot().t1.sets
    const two = sets()[1].key
    pivot.open('t1', two)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    const turned = results.addSet('t1', descriptor(702, { index: 1, kind: 'transpose' }), 'Transpose of Result 2', [setKey(sets()[1].descriptor)])!
    results.focusEntry('t1', sets()[0].key)
    expect(pivot.getSnapshot().tabs.t1.sourceName).toBe('Result 1')
    // The transpose is one of Result 2's views: the builder is Result 2's, not the first group's.
    results.focusEntry('t1', turned)
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
