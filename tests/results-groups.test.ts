// Groups (grouped results PR 9): each original result is a group that owns its Table and at most one Pivot, drawn directly
// under it; comparisons are slots of their own after the groups. These checks are ResultsService's model and the services
// that add to it; the stack's drawing is in results-stack.test.ts and the Pivot rules in results-pivot.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { CompareService } from '../src/renderer/src/results/CompareService'
import { PivotService } from '../src/renderer/src/results/PivotService'
import { groupOf, ResultsService, setKey, slotOf, type TabResults } from '../src/renderer/src/results/ResultsService'
import { TransposeService } from '../src/renderer/src/results/TransposeService'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
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
  const pivot = new PivotService(results), compare = new CompareService(results), transpose = new TransposeService(results)
  let next = 1
  /** Runs a query of `count` complete sets (of `kinds`, rows unless said) in tab `tabId`. */
  const run = (count: number, o: { queryId?: string; tabId?: string; plan?: number; bare?: boolean; batches?: number[] } = {}) => {
    const queryId = o.queryId ?? 'q1', tabId = o.tabId ?? 't1'
    results.begin(tabId, queryId, undefined, { bare: o.bare })
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index, batchNumber: o.batches?.[index] ?? 1, ...index === o.plan ? { kind: 'executionPlan' as const } : {} }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    void results.finish(tabId, queryId, { summary: summaryOf(values) })
    return results.getSnapshot()[tabId].sets.map(set => set.key)
  }
  const tab = (tabId = 't1'): TabResults => results.getSnapshot()[tabId]
  /** The stack's items as a reader names them, in the order drawn. */
  const names = (tabId = 't1') => tab(tabId).sets.map(set => set.label ?? `Result ${set.number}`)
  /** Builds the Pivot of the group whose Table is `key`. */
  const build = async (key: string) => {
    pivot.open('t1', key)
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    await settle()
  }
  return { client, results, pivot, compare, transpose, run, tab, names, build }
}

describe('result groups', () => {
  it('make a group of each original result, with its Table, its batch and a Pivot slot, and a slot of its own for a comparison with frozen inputs', async () => {
    const { results, compare, run, tab, names, build } = fixture()
    const [one, two, three] = run(3, { batches: [1, 1, 2] })
    expect(tab().groups.map(group => [group.ordinal, group.batchNumber, group.planSet, group.table.key, group.table.view, group.pivot, group.selected]))
      .toEqual([[1, 1, false, one, 'table', undefined, 'table'], [2, 1, false, two, 'table', undefined, 'table'], [3, 2, false, three, 'table', undefined, 'table']])
    expect(tab().comparisons).toEqual([])
    expect(tab().groups[0].table).toMatchObject({ key: one, revision: 1, group: 1, sources: [], entry: { key: one, ordinal: 1 } })
    // A comparison first, then pivots of Result 3 and Result 1: each Pivot stands directly under its Table whenever it
    // was made, and the comparison stays after the groups.
    await compare.compare('t1', two)
    await build(three)
    await build(one)
    expect(names()).toEqual(['Result 1', 'Pivot of Result 1', 'Result 2', 'Result 3', 'Pivot of Result 3', 'Differences: Result 1 → Result 2'])
    expect(tab().groups.map(group => [group.ordinal, group.pivot?.entry.label])).toEqual([[1, 'Pivot of Result 1'], [2, undefined], [3, 'Pivot of Result 3']])
    // The comparison is no group's: a slot with its two inputs, old then new, as they were when it was made.
    const [diff] = tab().comparisons
    expect(diff).toMatchObject({
      view: 'comparison', revision: 1, entry: { label: 'Differences: Result 1 → Result 2', descriptor: { kind: 'diff' } },
      sources: [{ key: one, set: '1:1', number: 1, name: 'Result 1', ordinal: 1 }, { key: two, set: '1:2', number: 2, name: 'Result 2', ordinal: 2 }]
    })
    expect(diff.group).toBeUndefined()
    expect(groupOf(tab(), diff.key)).toBeUndefined()
    expect(slotOf(tab(), diff.key)).toBe(diff)
    // Every entry the stack draws is exactly one slot.
    const slots = tab().groups.flatMap(group => [group.table, ...group.pivot ? [group.pivot] : [], ...group.transposes]).concat(tab().comparisons)
    expect(slots.map(slot => slot.key)).toEqual(tab().sets.map(set => set.key))
    expect(tab().sets.every(set => slotOf(tab(), set.key)?.entry === set)).toBe(true)
    expect(groupOf(tab(), tab().groups[2].pivot!.key)?.ordinal).toBe(3)
    // A group's selected view is the one of its two that last had the focus.
    results.focusEntry('t1', tab().groups[2].pivot!.key)
    expect(tab().groups.map(group => group.selected)).toEqual(['table', 'table', 'pivot'])
    expect(tab().focused).toBe(tab().groups[2].pivot!.key)
    results.focusEntry('t1', three)
    expect(tab().groups[2].selected).toBe('table')
  })

  it('close a Table with its Pivot and leave the comparisons, close a Pivot or a comparison alone, and keep order, names and focus when a middle group goes', async () => {
    const { client, results, compare, run, tab, names, build } = fixture()
    const [one, two, three] = run(3)
    await build(two)
    await build(three)
    await compare.compare('t1', two)
    await compare.compare('t1', three)
    expect(names()).toEqual(['Result 1', 'Result 2', 'Pivot of Result 2', 'Result 3', 'Pivot of Result 3', 'Differences: Result 1 → Result 2', 'Differences: Result 2 → Result 3'])
    const pivotOfTwo = tab().groups[1].pivot!.key, pivotOfThree = tab().groups[2].pivot!.key
    const [first, second] = tab().comparisons.map(slot => slot.key)
    // What a close closes, before it does.
    expect(results.closing('t1', two).map(entry => entry.key)).toEqual([two, pivotOfTwo])
    expect(results.closing('t1', pivotOfThree).map(entry => entry.key)).toEqual([pivotOfThree])
    expect(results.closing('t1', first).map(entry => entry.key)).toEqual([first])
    // Result 3 has the focus; the middle group is closed.
    results.focusEntry('t1', three)
    results.gridState('t1', three).scrollLeft = 40
    expect(results.removeEntry('t1', two)).toBe(true)
    // Its Table and its Pivot went, in one release; both comparisons stay, though each compared Result 2.
    expect(client.released()).toEqual([2, 802])
    expect(client.release).toHaveBeenCalledOnce()
    expect(names()).toEqual(['Result 1', 'Result 3', 'Pivot of Result 3', 'Differences: Result 1 → Result 2', 'Differences: Result 2 → Result 3'])
    expect(tab().groups.map(group => group.ordinal)).toEqual([1, 3])
    expect(tab().comparisons.map(slot => slot.key)).toEqual([first, second])
    // The comparisons' references are frozen: they still name the exact input, which the run no longer has.
    expect(tab().comparisons[0].sources.map(source => [source.name, source.set, tab().sets.some(set => set.key === source.key)])).toEqual([['Result 1', '1:1', true], ['Result 2', '1:2', false]])
    // Nothing was renamed or renumbered, and the focus and Result 3's state stayed with Result 3.
    expect(tab().sets.map(set => set.number)).toEqual([1, 3, 5, 6, 7])
    expect(tab().focused).toBe(three)
    expect(results.focusedEntry('t1')?.key).toBe(three)
    expect(results.gridState('t1', three).scrollLeft).toBe(40)
    expect(tab().numbered).toBe(7)
    // A Pivot's close releases the Pivot alone and leaves the focus in its group, on the Table.
    results.focusEntry('t1', pivotOfThree)
    expect(results.removeEntry('t1', pivotOfThree)).toBe(true)
    expect(client.released()).toEqual([2, 802, 803])
    expect(tab().groups[1]).toMatchObject({ ordinal: 3, selected: 'table' })
    expect(tab().groups[1].pivot).toBeUndefined()
    expect(tab().focused).toBe(three)
    // A comparison's close releases only the comparison.
    expect(results.removeEntry('t1', first)).toBe(true)
    expect(client.released()).toEqual([2, 802, 803, 901])
    expect(names()).toEqual(['Result 1', 'Result 3', 'Differences: Result 2 → Result 3'])
    // The focused group closed: the next surviving item takes the focus (the comparison), else the one before.
    expect(results.removeEntry('t1', three)).toBe(true)
    expect(tab().focused).toBe(second)
    expect(results.removeEntry('t1', second)).toBe(true)
    expect(tab().focused).toBe(one)
    // With only comparisons left there are no groups: what the Results badge counts.
    expect(names()).toEqual(['Result 1'])
    expect(tab().groups).toHaveLength(1)
    expect(one).toBe(tab().groups[0].table.key)
  })

  it('keep group order, names and the focus by ordinal through a re-run, with nothing derived rebuilt', async () => {
    const { results, compare, run, tab, names, build } = fixture()
    const [, two] = run(3)
    await build(two)
    await compare.compare('t1', two)
    results.focusEntry('t1', tab().groups[1].pivot!.key)
    expect(tab().focused).toBe(tab().groups[1].pivot!.key)
    const before = tab().groups.map(group => group.table.key)
    run(3, { queryId: 'q2' })
    // The same groups in the same order under the same names; the Pivot and the comparison are not rebuilt.
    expect(names()).toEqual(['Result 1', 'Result 2', 'Result 3'])
    expect(tab().groups.map(group => [group.ordinal, group.pivot])).toEqual([[1, undefined], [2, undefined], [3, undefined]])
    expect(tab().comparisons).toEqual([])
    expect(tab().groups.every((group, at) => group.table.key !== before[at])).toBe(true)
    // The focus was in Result 2's group (on its Pivot): Result 2's Table has it now.
    expect(tab().focused).toBe(tab().groups[1].table.key)
    expect(results.focusedEntry('t1')?.descriptor.index).toBe(1)
    // A run that returns fewer results has no such group: the focus is nobody's, and commands fall to the first.
    run(1, { queryId: 'q3' })
    expect(tab().focused).toBeUndefined()
    expect(results.focusedEntry('t1')?.key).toBe(tab().groups[0].table.key)
    // A focused comparison leaves none to follow either.
    run(2, { queryId: 'q4' })
    await compare.compare('t1', tab().sets[1].key)
    results.focusEntry('t1', tab().comparisons[0].key)
    run(2, { queryId: 'q5' })
    expect(tab().focused).toBeUndefined()
  })

  it('make a SQL-returned plan set a group of its own with Pivot, Compare and Transpose off, and compare Tables only', async () => {
    const { client, results, pivot, compare, transpose, run, tab, names, build } = fixture()
    const [one, plan, three] = run(3, { plan: 1 })
    expect(tab().groups.map(group => [group.ordinal, group.planSet])).toEqual([[1, false], [2, true], [3, false]])
    expect(names()).toEqual(['Result 1', 'Result 2', 'Result 3'])
    expect(pivot.canPivot('t1', plan)).toBe(false)
    expect(compare.canCompare('t1', plan)).toBe(false)
    expect(transpose.canTranspose('t1', plan)).toBe(false)
    // Result 3 is compared with the nearest Table of rows before it: the plan set is passed over.
    expect(compare.previousOf('t1', three)?.key).toBe(one)
    // A Pivot is never an input, though it stands between the Tables now.
    await build(one)
    expect(names()).toEqual(['Result 1', 'Pivot of Result 1', 'Result 2', 'Result 3'])
    expect(compare.canCompare('t1', tab().groups[0].pivot!.key)).toBe(false)
    expect(compare.previousOf('t1', three)?.key).toBe(one)
    await compare.compare('t1', three)
    expect(tab().comparisons.map(slot => slot.entry.label)).toEqual(['Differences: Result 1 → Result 3'])
    expect(compare.canCompare('t1', tab().comparisons[0].key)).toBe(false)
    // Closing the plan set's group releases the set.
    expect(results.removeEntry('t1', plan)).toBe(true)
    expect(client.released()).toEqual([2])
    expect(tab().groups.map(group => group.ordinal)).toEqual([1, 3])
  })

  it('hold a stored transpose in the group of what it transposed until the stored transpose goes, closing it with the group', async () => {
    const { client, results, transpose, run, tab, names, build } = fixture()
    const [one, two] = run(2)
    await build(one)
    await transpose.transpose('t1', one)
    await transpose.transpose('t1', tab().groups[0].pivot!.key)
    await settle()
    // After the group's Table and Pivot, before the next group.
    expect(names()).toEqual(['Result 1', 'Pivot of Result 1', 'Transpose of Result 1', 'Transpose of Pivot of Result 1', 'Result 2'])
    const group = tab().groups[0]
    expect(group.transposes.map(slot => [slot.view, slot.group, slot.sources.map(source => source.name)])).toEqual([['transpose', 1, ['Result 1']], ['transpose', 1, ['Pivot of Result 1']]])
    // It is not a view Pivot acts on, and focusing it leaves the group's selected view alone.
    results.focusEntry('t1', group.transposes[0].key)
    expect(tab().groups[0].selected).toBe('table')
    // Its own close closes it alone; the group's close takes the rest.
    expect(results.closing('t1', group.transposes[0].key)).toHaveLength(1)
    expect(results.removeEntry('t1', group.transposes[0].key)).toBe(true)
    expect(tab().focused).toBe(one)
    expect(results.closing('t1', one).map(entry => entry.label ?? 'Result 1')).toEqual(['Result 1', 'Pivot of Result 1', 'Transpose of Pivot of Result 1'])
    expect(results.removeEntry('t1', one)).toBe(true)
    expect(names()).toEqual(['Result 2'])
    expect(tab().focused).toBe(two)
    expect(client.released().length).toBe(4)
  })

  it('draw a bare run with Pivot, Compare and close off, whoever asks', async () => {
    const { client, results, pivot, compare, run, tab } = fixture()
    const [one, two] = run(2, { tabId: 'peek', bare: true })
    expect(tab('peek')).toMatchObject({ bare: true, groups: [{ ordinal: 1 }, { ordinal: 2 }] })
    expect(run(2, { tabId: 't1' })).toHaveLength(2)
    expect(tab('t1')).not.toHaveProperty('bare')
    expect(pivot.canPivot('peek', one)).toBe(false)
    expect(compare.canCompare('peek', two)).toBe(false)
    expect(compare.previousOf('peek', two)).toBeUndefined()
    await compare.compare('peek', two)
    expect(tab('peek').sets).toHaveLength(2)
    expect(results.removeEntry('peek', one)).toBe(false)
    results.closeResults('peek')
    expect(tab('peek').status).toBe('completed')
    expect(client.released()).toEqual([])
    // Its owner still releases it.
    results.release('peek')
    expect(client.released()).toEqual([1, 2])
    expect(setKey(tab('t1').sets[0].descriptor)).toBe('1:3')
  })
})
