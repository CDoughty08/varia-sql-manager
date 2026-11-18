import { describe, expect, it, vi } from 'vitest'
import type { ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { CompareService, compareFullText, compareSources, compareText } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { PivotService } from '../src/renderer/src/results/PivotService'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { ResultsService, resultLimits, setKey, slotOf, type TabResults } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type DiffAnswer = Awaited<ReturnType<FakeHandle['diff']>>
const column = (name: string, wire: 'text' | 'binary' = 'text'): ResultColumn => ({ name, dataType: wire === 'text' ? 'int' : 'varbinary', wire, nullable: false })

function fixture(o: { parallel?: number } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  // One window's places and 1,000 rule, shared as the workbench shares them.
  const jobs = new DerivedJobs({ timers: timers.timers, ...o.parallel ? { limit: o.parallel } : {} })
  const compare: CompareService = new CompareService(results, { jobs, adding: tabId => pivot.adding(tabId) })
  const pivot: PivotService = new PivotService(results, { jobs, adding: tabId => compare.adding(tabId) })
  let next = 1
  /** A finished run of `count` sets; `columns` gives a set's own columns, `plan` makes one a plan set, `open` leaves one loading. */
  const run = (count: number, o: { queryId?: string; columns?: Record<number, ResultColumn[]>; plan?: number; open?: number } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, {
      index, ...o.columns?.[index] ? { columns: o.columns[index] } : {}, ...index === o.plan ? { kind: 'executionPlan' as const } : {}, ...index === o.open ? { state: 'open' as const } : {}
    }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.key)
  }
  const tab = (): TabResults => results.getSnapshot().t1
  const handle = (key: string) => tab().sets.find(set => set.key === key)!.handle as FakeHandle
  return { client, results, compare, pivot, jobs, run, tab, handle, timers }
}

describe('the Compare popover', () => {
  it('offers the run\'s other Tables that share a column and have every row: never a Pivot, a comparison, a plan set or itself', async () => {
    const { results, compare, pivot, run, tab } = fixture()
    const keys = run(6, { plan: 3, columns: { 5: [column('Other')] } })
    // Result 5's rows were lost with the backend: not readable, so not offered.
    const lost = tab().sets[4].handle as FakeHandle
    lost.snapshot = { ...lost.snapshot, state: 'lost' }
    // Result 1's Pivot, and a comparison of Results 1 and 2.
    pivot.open('t1', keys[0])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    expect(tab().groups[0].pivot).toBeDefined()
    expect(tab().comparisons).toHaveLength(1)
    // Result 3 is offered Results 1 and 2: not the plan set (4), the unreadable result (5), the one with no column in common
    // (6), the Pivot or the comparison.
    expect(compare.targetsOf('t1', keys[2]).map(target => target.entry.number)).toEqual([1, 2])
    expect(compare.canPick('t1', keys[2])).toBe(true)
    // Nothing is offered for what is not a Table of rows.
    for (const key of [tab().groups[0].pivot!.key, tab().comparisons[0].key, keys[3], keys[5]]) expect(compare.canPick('t1', key)).toBe(false)
    // A bare run (Peek) offers nothing, and neither does a run still going.
    results.begin('t1', 'q-running')
    expect(compare.canPick('t1', keys[2])).toBe(false)
  })

  it('pairs only columns of the same wire, so a Table whose shared name holds binary data is not offered', () => {
    const { compare, run } = fixture()
    const keys = run(3, { columns: { 0: [column('Id')], 1: [column('Id', 'binary')], 2: [column('ID')] } })
    expect(compare.targetsOf('t1', keys[2]).map(target => target.entry.number)).toEqual([1])
    expect(compare.previousOf('t1', keys[2])?.key).toBe(keys[0])
  })

  it('opens on a Table as the new side with its previous Table as the old, picks, swaps, and starts that comparison', async () => {
    const { compare, run, tab, handle } = fixture()
    const keys = run(3, { columns: { 0: [column('Id'), column('Name')], 1: [column('Id'), column('Name')], 2: [column('id'), column('Price')] } })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ active: keys[2], target: keys[1], swapped: false, exact: false })
    expect(compare.sidesOf('t1')).toMatchObject({ old: { key: keys[1] }, neu: { key: keys[2] } })
    // Each side's columns left out.
    const pairing = compare.sidesOf('t1')!.pairing
    expect([pairing.pairs, pairing.oldOnly.map(item => item.name), pairing.newOnly.map(item => item.name)]).toEqual([[[0, 0]], ['Name'], ['Price']])
    compare.pick('t1', keys[0])
    compare.swap('t1')
    compare.setExact('t1', true)
    expect(compare.sidesOf('t1')).toMatchObject({ old: { key: keys[2] }, neu: { key: keys[0] } })
    await compare.run('t1')
    await settle()
    expect(handle(keys[2]).diff).toHaveBeenCalledWith(handle(keys[0]), { exact: true, signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    const made = tab().comparisons[0]
    // Named old → new, its frozen sources in that order, and it took the focus; the popover closed, and opens again on that
    // pair, which the run now has (Show It).
    expect(made.entry.label).toBe('Differences: Result 3 → Result 1')
    expect(made.sources.map(source => source.key)).toEqual([keys[2], keys[0]])
    expect(tab().focused).toBe(made.key)
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ active: keys[2], target: keys[0], swapped: true, exact: true })
    expect(compare.existing('t1', keys[2], keys[0], true)?.key).toBe(made.key)
    expect(compare.getSnapshot().info.get(setKey(made.entry.descriptor))).toMatchObject({ left: keys[2], right: keys[0], exact: true, inputRows: 2 })
  })

  it('leaves the focus where the user put it while the comparison ran, and says a cancel in the picker', async () => {
    const { compare, results, run, tab, handle } = fixture()
    const keys = run(3)
    compare.open('t1', keys[1])
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const comparing = compare.run('t1')
    // Moving the focus out of the popover closes it (as the popover does on a press or key elsewhere).
    results.focusEntry('t1', keys[2])
    compare.close('t1')
    answer.resolve({ descriptor: descriptor(990, { index: 3, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await expect(comparing).resolves.toBeUndefined()
    expect(tab().comparisons).toHaveLength(1)
    expect(tab().focused).toBe(keys[2])
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    // Cancel: said in the popover until the next Compare or another choice.
    compare.open('t1', keys[1])
    compare.setExact('t1', true)
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((_right, o) => new Promise((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    const cancelled = compare.run('t1')
    compare.cancel('t1', keys[0], keys[1], true)
    await expect(cancelled).resolves.toBeUndefined()
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ cancelled: true })
    expect(compare.getSnapshot().pickers.t1.error).toBeUndefined()
    compare.swap('t1')
    expect(compare.getSnapshot().pickers.t1.cancelled).toBeUndefined()
    // A new run closes the popover, and what it said with it.
    compare.swap('t1')
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((_right, o) => new Promise((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    const again = compare.run('t1')
    compare.cancel('t1', keys[0], keys[1], true)
    await again
    expect(compare.getSnapshot().pickers.t1.cancelled).toBe(true)
    run(3, { queryId: 'q2' })
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it('shows a comparison the run already has instead of making it again', async () => {
    const { compare, results, run, tab, handle } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    results.focusEntry('t1', keys[1])
    compare.open('t1', keys[1])
    expect(compare.existing('t1', keys[0], keys[1], false)?.key).toBe(tab().comparisons[0].key)
    // Exact text is another comparison.
    expect(compare.existing('t1', keys[0], keys[1], true)).toBeUndefined()
    await expect(compare.run('t1')).resolves.toBe(tab().comparisons[0].key)
    expect(handle(keys[0]).diff).toHaveBeenCalledTimes(1)
    expect(tab().comparisons).toHaveLength(1)
    expect(tab().focused).toBe(tab().comparisons[0].key)
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it('runs one comparison per pair and exact-text choice, other pairs at once, at most four at a time', async () => {
    const { compare, run, tab, handle, jobs } = fixture()
    const keys = run(6)
    const answers: ReturnType<typeof held<DiffAnswer>>[] = []
    for (const key of keys) vi.mocked(handle(key).diff).mockImplementation(() => { const answer = held<DiffAnswer>(); answers.push(answer); return answer.promise })
    const first = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    // The same one again does nothing while it runs.
    await expect(compare.comparePair('t1', keys[0], keys[1], { exact: false })).resolves.toBeUndefined()
    expect(compare.isRunning('t1', keys[0], keys[1], false)).toBe(true)
    expect(compare.getSnapshot().running.t1).toHaveLength(1)
    // Its exact form and other pairs run beside it; a fifth waits for a place.
    const others = [compare.comparePair('t1', keys[0], keys[1], { exact: true }), compare.comparePair('t1', keys[1], keys[2], { exact: false }), compare.comparePair('t1', keys[2], keys[3], { exact: false }),
      compare.comparePair('t1', keys[3], keys[4], { exact: false })]
    expect(answers).toHaveLength(4)
    expect(jobs.load).toEqual({ running: 4, waiting: 1 })
    expect(compare.getSnapshot().running.t1).toHaveLength(5)
    answers[0].resolve({ descriptor: descriptor(950, { index: 6, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await first
    await settle()
    expect(answers).toHaveLength(5)
    expect(tab().comparisons.map(slot => slot.entry.label)).toEqual(['Differences: Result 1 → Result 2'])
    for (const [at, answer] of answers.slice(1).entries()) answer.resolve({ descriptor: descriptor(951 + at, { index: 7 + at, kind: 'diff' }), same: 0, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await Promise.all(others)
    await settle()
    expect(tab().comparisons).toHaveLength(5)
    expect(compare.getSnapshot().running.t1).toBeUndefined()
  })

  it('refuses a comparison that would take the run past 1,000 results, counting those in flight, before asking the backend', async () => {
    const { compare, results, run, tab, handle } = fixture()
    const keys = run(resultLimits.sets - 1)
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const notify = vi.spyOn(results, 'notify')
    const first = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    // 999 results and one comparison in flight: the next is refused, and says why.
    await expect(compare.comparePair('t1', keys[1], keys[2], { exact: false })).resolves.toBeUndefined()
    expect(handle(keys[1]).diff).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('t1', compareFullText)
    // From the picker the sentence is the picker's.
    await expect(compare.comparePair('t1', keys[1], keys[2], { exact: false, quiet: true })).resolves.toEqual({ error: compareFullText })
    answer.resolve({ descriptor: descriptor(5000, { index: 999, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await first
    expect(tab().sets).toHaveLength(resultLimits.sets)
  })

  it('reads not done when its diff came back to a run that no longer takes it', async () => {
    const { compare, results, run, handle, timers } = fixture()
    const keys = run(2)
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const first = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    timers.advance(300)
    expect(results.operations.getSnapshot().t1?.items).toMatchObject([{ kind: 'compare', shown: true }])
    // The run holding both sets went full before the answer came: the diff is released, and the strip does not read done.
    const add = vi.spyOn(results, 'addSet').mockReturnValueOnce(undefined)
    answer.resolve({ descriptor: descriptor(5000, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await first
    expect(add).toHaveBeenCalled()
    expect(results.operations.getSnapshot().t1?.items ?? []).toEqual([])
    expect(results.operations.getSnapshot().t1?.announcement ?? '').not.toBe('Compared')
  })

  it('shares the four places of the window and the 1,000 rule with Pivot builds', async () => {
    const { compare, pivot, results, run, handle, jobs } = fixture()
    const keys = run(resultLimits.sets - 2)
    const answers: ReturnType<typeof held<DiffAnswer>>[] = []
    for (const key of keys.slice(0, 3)) vi.mocked(handle(key).diff).mockImplementation(() => { const answer = held<DiffAnswer>(); answers.push(answer); return answer.promise })
    const building = held<Awaited<ReturnType<FakeHandle['pivot']>>>()
    vi.mocked(handle(keys[0]).pivot).mockReturnValueOnce(building.promise)
    // A first Pivot in flight takes a place and counts as a result to come.
    pivot.open('t1', keys[0])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    const built = pivot.run('t1')
    await settle()
    expect(jobs.load).toEqual({ running: 1, waiting: 0 })
    expect(pivot.adding('t1')).toBe(1)
    // 998 results, a Pivot and a comparison in flight: room for no more of either.
    const first = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    expect(compare.adding('t1')).toBe(1)
    expect(jobs.load).toEqual({ running: 2, waiting: 0 })
    await expect(compare.comparePair('t1', keys[1], keys[2], { exact: false, quiet: true })).resolves.toEqual({ error: compareFullText })
    expect(answers).toHaveLength(1)
    pivot.open('t1', keys[1])
    pivot.setDraft('t1', { rows: [0], values: [{ aggregate: 'count' }] })
    await pivot.run('t1')
    expect(handle(keys[1]).pivot).not.toHaveBeenCalled()
    expect(pivot.getSnapshot().tabs.t1.error).toMatch(/already show 1,000 sets/)
    building.reject(new DOMException('Given up.', 'AbortError'))
    answers[0].resolve({ descriptor: descriptor(7000, { index: 998, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await Promise.allSettled([built, first])
    expect(results.getSnapshot().t1.comparisons).toHaveLength(1)
    expect(jobs.load).toEqual({ running: 0, waiting: 0 })
  })

  it('does not count a comparison of an earlier run that was given up but has not settled yet', async () => {
    const { compare, run, handle } = fixture()
    let keys = run(2)
    // It settles only once its abort reaches it, a turn after the re-run gives it up.
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((_right, o) => new Promise((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    const earlier = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    // The re-run gives it up; before it settles, the new run has room for exactly one more.
    keys = run(resultLimits.sets - 1, { queryId: 'q2' })
    vi.mocked(handle(keys[0]).diff).mockResolvedValueOnce({ descriptor: descriptor(6000, { index: 999, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    const next = compare.comparePair('t1', keys[0], keys[1], { exact: false, quiet: true })
    expect(handle(keys[0]).diff).toHaveBeenCalledTimes(1)
    await expect(earlier).resolves.toBeUndefined()
    await expect(next).resolves.toMatchObject({ key: expect.any(String) })
  })

  it('says a failure in the popover while it shows that pair, and keeps it open', async () => {
    const { compare, run, handle } = fixture()
    const keys = run(2)
    vi.mocked(handle(keys[0]).diff).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to compare these results. Close other results and try again.'))
    compare.open('t1', keys[1])
    await compare.run('t1')
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ error: 'There is not enough result memory to compare these results. Close other results and try again.' })
    // A change in the picker clears it.
    compare.setExact('t1', true)
    expect(compare.getSnapshot().pickers.t1.error).toBeUndefined()
  })

  it('closes when its run or its Table goes, drops a target that closed, and gives up a comparison whose input closes', async () => {
    const { compare, results, run, handle, client } = fixture()
    let keys = run(3)
    compare.open('t1', keys[2], 'toolbar')
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ anchor: 'toolbar', ordinal: 3, targetOrdinal: 2 })
    results.removeEntry('t1', keys[1])
    // Its target closed: it stays on its Table with nothing picked, and picks again.
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ active: keys[2] })
    expect(compare.getSnapshot().pickers.t1.target).toBeUndefined()
    expect(compare.sidesOf('t1')).toBeUndefined()
    compare.pick('t1', keys[0])
    expect(compare.sidesOf('t1')?.old.key).toBe(keys[0])
    expect(compare.getSnapshot().pickers.t1.targetOrdinal).toBe(1)
    // Its own Table closed: it closes.
    results.removeEntry('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    // The query running again closes it at once.
    keys = run(3, { queryId: 'q2' })
    compare.open('t1', keys[2])
    results.begin('t1', 'q3')
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    keys = run(2, { queryId: 'q4' })
    compare.open('t1', keys[1])
    let signal: AbortSignal | undefined
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((_right, o) => { signal = o?.signal; return answer.promise })
    const comparing = compare.run('t1')
    results.removeEntry('t1', keys[0])
    expect(signal?.aborted).toBe(true)
    answer.resolve({ descriptor: descriptor(970, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await comparing
    expect(client.released()).toContain(970)
    // It goes with the results themselves: Close Results, or a run that leaves none.
    keys = run(2, { queryId: 'q5' })
    compare.open('t1', keys[1])
    results.closeResults('t1')
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    keys = run(2, { queryId: 'q6' })
    compare.open('t1', keys[1])
    run(0, { queryId: 'q7' })
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it('offers the last choice made on a group again when it opens on that group, in this run or the next', () => {
    const { compare, run } = fixture()
    let keys = run(3)
    compare.open('t1', keys[2])
    compare.pick('t1', keys[0])
    compare.swap('t1')
    compare.setExact('t1', true)
    compare.close('t1')
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[0], targetOrdinal: 1, swapped: true, exact: true })
    // After a re-run, Result 3 against Result 1 again, the same way round.
    keys = run(3, { queryId: 'q2' })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ queryId: 'q2', active: keys[2], target: keys[0], swapped: true, exact: true })
    // Another group starts from its previous Table, unswapped; exact text is kept.
    compare.open('t1', keys[1])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ active: keys[1], target: keys[0], swapped: false, exact: true })
    // A remembered target that is no longer offered falls back to the previous Table.
    compare.open('t1', keys[2])
    compare.pick('t1', keys[0])
    keys = run(3, { queryId: 'q3', plan: 0 })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[1], swapped: false })
  })

  it('remembers a choice per group, never a bare open, past Close Results, and forgets it with the tab', () => {
    const { compare, results, run } = fixture()
    let keys = run(3)
    compare.open('t1', keys[2])
    compare.pick('t1', keys[0])
    compare.swap('t1')
    compare.close('t1')
    // Opening on another group, and leaving it unchanged, keeps Result 3's choice and records nothing for Result 2.
    compare.open('t1', keys[1])
    compare.close('t1')
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[0], swapped: true })
    compare.open('t1', keys[1])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[0], swapped: false })
    // Close Results keeps it for the next run.
    results.closeResults('t1')
    keys = run(3, { queryId: 'q2' })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[0], swapped: true })
    // A pick whose result then closes stays the choice for the next run, which has that result again; the popover meanwhile
    // has nothing picked, and Exact text changed then is kept.
    compare.pick('t1', keys[1])
    results.removeEntry('t1', keys[1])
    expect(compare.getSnapshot().pickers.t1.targetOrdinal).toBeUndefined()
    compare.setExact('t1', true)
    compare.close('t1')
    keys = run(3, { queryId: 'q3' })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[1], swapped: true, exact: true })
    // The tab going forgets it all.
    compare.pick('t1', keys[0])
    compare.close('t1')
    results.release('t1')
    keys = run(3, { queryId: 'q4' })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[1], swapped: false, exact: false })
  })

  it('says a failure in the toolbar once the popover has closed, and a success closes a popover reopened on that pair', async () => {
    const { compare, results, run, handle } = fixture()
    const keys = run(2)
    const notify = vi.spyOn(results, 'notify')
    compare.open('t1', keys[1])
    const failure = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(failure.promise)
    const failing = compare.run('t1')
    compare.close('t1')
    failure.reject(new ResultError('TOO_LARGE', 'Too large to compare.'))
    await failing
    expect(notify).toHaveBeenCalledWith('t1', 'Too large to compare.')
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
    // Closed and opened again on the same pair while it runs: the success closes the new popover too.
    compare.open('t1', keys[1])
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const comparing = compare.run('t1')
    compare.close('t1')
    compare.open('t1', keys[1])
    answer.resolve({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await comparing
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it('remembers no choice for what it is told of a Compare with Previous Result or a cancel on the pair it shows', async () => {
    const { compare, run, handle } = fixture()
    const other = [{ name: 'Other', dataType: 'int', wire: 'text', nullable: false } as ResultColumn]
    let keys = run(3)
    compare.open('t1', keys[2])
    compare.pick('t1', keys[0])
    compare.close('t1')
    // Result 1 shares no column with Result 3 in the next run, so the popover offers its default, Result 2.
    keys = run(3, { queryId: 'q2', columns: { 0: other } })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[1] })
    // Compare with Previous Result of Result 3 (Result 2 → Result 3, the pair shown) fails, then again and is cancelled.
    vi.mocked(handle(keys[1]).diff).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'Too large to compare.'))
    await compare.compare('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1.error).toBe('Too large to compare.')
    vi.mocked(handle(keys[1]).diff).mockImplementationOnce((_right, o) => new Promise((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError')))))
    const cancelled = compare.compare('t1', keys[2])
    compare.cancel('t1', keys[1], keys[2], false)
    await cancelled
    compare.close('t1')
    // Neither was a choice: back in the first layout, Result 3 offers Result 1 again.
    keys = run(3, { queryId: 'q3' })
    compare.open('t1', keys[2])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ target: keys[0] })
  })

  it('focuses the comparison in a popover reopened on its pair while it ran, though the reopen moved the focus', async () => {
    const { compare, results, run, handle, tab } = fixture()
    const keys = run(2)
    compare.open('t1', keys[1])
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const comparing = compare.run('t1')
    // Escape gives the focus back to the grid; Compare… on it again focuses it and opens on the same, running pair.
    compare.close('t1')
    results.focusEntry('t1', keys[1])
    compare.open('t1', keys[1])
    answer.resolve({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    const made = await comparing
    expect(made).toBeDefined()
    expect(tab().focused).toBe(made)
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it("leaves the focus alone when the popover was closed without moving it (the toolbar's Compare took it back)", async () => {
    const { compare, run, handle, tab } = fixture()
    const keys = run(2)
    compare.open('t1', keys[1], 'toolbar')
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const comparing = compare.run('t1')
    const before = tab().focused
    compare.close('t1')
    answer.resolve({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    expect(await comparing).toBeUndefined()
    expect(tab().focused).toBe(before)
    expect(tab().comparisons).toHaveLength(1)
  })

  it('leaves a popover moved to another pair open, and the focus where it is, when the first comparison is made', async () => {
    const { compare, results, run, handle } = fixture()
    const keys = run(2)
    compare.open('t1', keys[1])
    const focusEntry = vi.spyOn(results, 'focusEntry')
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const comparing = compare.run('t1')
    compare.swap('t1')
    answer.resolve({ descriptor: descriptor(960, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    expect(await comparing).toBeUndefined()
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ swapped: true })
    expect(focusEntry).not.toHaveBeenCalled()
    // The comparison was still added.
    expect(results.getSnapshot().t1.sets.some(set => set.descriptor.kind === 'diff')).toBe(true)
  })
})

describe('a comparison\'s source links', () => {
  it('go to the exact inputs compared, and read closed once one is closed', async () => {
    const { compare, results, run, tab } = fixture()
    const keys = run(3)
    await compare.comparePair('t1', keys[0], keys[2], { exact: false })
    await settle()
    const slot = () => slotOf(tab(), tab().comparisons[0].key)!
    expect(compareSources(tab(), slot().sources)).toEqual([{ name: 'Result 1', entry: keys[0] }, { name: 'Result 3', entry: keys[2] }])
    results.removeEntry('t1', keys[0])
    expect(compareSources(tab(), slot().sources)).toEqual([{ name: 'Result 1' }, { name: 'Result 3', entry: keys[2] }])
    const info = compare.getSnapshot().info.get(setKey(slot().entry.descriptor))!
    expect(compareText(info, compareSources(tab(), slot().sources))).toMatch(/^Result 1 \(closed\) → Result 3, rows matched by Id: /)
    // An entry of that key that shows another result is not the input it compared.
    expect(compareSources(tab(), [{ ...slot().sources[1], set: '1:12345' }])).toEqual([{ name: 'Result 3' }])
  })
})

describe('a comparison given up or gone', () => {
  it('adds nothing and releases the diff when Cancel comes after the backend answered', async () => {
    const { client, compare, run, tab, handle } = fixture()
    const keys = run(2)
    // The backend's answer is already on its way when Cancel is pressed: the diff ignores the abort.
    const answer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockReturnValueOnce(answer.promise)
    const comparing = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    compare.cancel('t1', keys[0], keys[1], false)
    answer.resolve({ descriptor: descriptor(991, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await expect(comparing).resolves.toBeUndefined()
    expect(tab().comparisons).toHaveLength(0)
    expect(compare.getSnapshot().info.size).toBe(0)
    await settle()
    expect(client.released()).toContain(991)
  })

  it('forgets a comparison\'s details once no run shows it, without waiting for the next comparison', async () => {
    const { compare, results, run } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    expect(compare.getSnapshot().info.size).toBe(1)
    results.release('t1')
    expect(compare.getSnapshot().info.size).toBe(0)
  })
})
