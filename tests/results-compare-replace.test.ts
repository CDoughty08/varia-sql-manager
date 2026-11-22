import { describe, expect, it, vi } from 'vitest'
import type { DiffLayout, ResultColumn, ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import type { GridSelection } from '../src/renderer/src/grid/selection'
import { comparisonTabLabel } from '../src/renderer/src/grid/result-picker'
import { CompareService, comparisonNotices, fallbackText, layoutFor, publishText } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { HighlightsService, highlightText } from '../src/renderer/src/results/HighlightsService'
import type { ResultHandle } from '../src/renderer/src/results/ResultClient'
import { comparisonColumns, ResultsService, resultLimits, setKey, type TabResults } from '../src/renderer/src/results/ResultsService'
import { limits as wire } from '../src/shared/ipc/wire/protocol'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const column = (name: string, role?: ResultColumn['role']): ResultColumn => ({ name, dataType: 'int', wire: 'text', nullable: false, ...role ? { role } : {} })
const suffix = [column('Change', 'mark'), column('Old row', 'leftRow'), column('New row', 'rightRow'), column('', 'tone')]
type DiffOptions = Parameters<ResultHandle['diff']>[1]
type DiffAnswer = Awaited<ReturnType<ResultHandle['diff']>>
const rows = (entry: string, top: number, bottom: number): GridSelection => ({
  entry, blocks: [{ kind: 'rows', anchor: { row: top, column: 0 }, focus: { row: bottom, column: 0 } }], active: { row: top, column: 0 }
})
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
/** A diff that waits until it is given up. */
const hanging = (_right: ResultHandle, o?: DiffOptions) => new Promise<DiffAnswer>((_yes, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Given up.', 'AbortError'))))

function fixture(o: { columns?: Record<number, ResultColumn[]> } = {}) {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const highlights = new HighlightsService(results, { timers: timers.timers })
  let layout: DiffLayout = 'entry'
  const compare = new CompareService(results, { jobs: new DerivedJobs({ timers: timers.timers }), layout: () => layout, carry: (tabId, key, carry) => highlights.carry(tabId, key, carry) })
  /** The rows the next diffs store (`stored`), and their match. */
  const answers = { stored: 5, match: { mode: 'auto' as const, columns: ['Id'] } as DiffAnswer['match'] }
  let nextId = 1000
  /** A diff of the right side's columns (each pair's previous value too in one row per entry), then the hidden suffix. */
  const answer = (right: ResultHandle, options?: DiffOptions): DiffAnswer => {
    const data = right.columns.filter(item => item.role === undefined)
    return {
      descriptor: descriptor(nextId++, { index: 9, kind: 'diff', rowsRead: answers.stored, rowsStored: answers.stored, rowsAvailable: answers.stored,
        columns: [...data, ...options?.layout === 'entry' ? data.map(item => ({ ...item, role: 'old' as const })) : [], ...suffix] }),
      match: answers.match, same: 1, changed: 1, added: 1, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false,
      nothingPaired: false, columnChanges: data.map(() => ({ changed: 1, soft: 0 })), trailingHidden: 0, overview: [], units: 2, layout: options?.layout ?? 'unified'
    }
  }
  const run = (count: number) => {
    results.begin('t1', 'q1')
    const values = Array.from({ length: count }, (_, index) => descriptor(index + 1, { index, rowsRead: 5, rowsStored: 5, rowsAvailable: 5, ...o.columns?.[index] ? { columns: o.columns[index] } : {} }))
    for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q1', { summary: summaryOf(values) })
    for (const value of values) vi.mocked(client.handle(value.resultId)!.diff).mockImplementation(async (right, options) => answer(right, options))
    return results.getSnapshot().t1.sets.map(set => set.key)
  }
  const tab = (): TabResults => results.getSnapshot().t1
  const handle = (key: string) => tab().sets.find(set => set.key === key)!.handle as FakeHandle
  const slot = () => tab().comparisons[0]
  const info = () => compare.getSnapshot().info.get(setKey(slot().entry.descriptor))!
  const marked = () => highlights.getSnapshot().t1?.get(slot().key)
  return { client, results, compare, highlights, run, tab, handle, slot, info, marked, answers, answer, setLayout: (value: DiffLayout) => { layout = value } }
}

describe('a comparison changed in place', () => {
  it('shows the new result in the same slot, asks with the old one as its allowance, and releases the old one after', async () => {
    const { client, compare, run, tab, handle, slot, info } = fixture()
    const keys = run(2)
    const made = await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    expect(made).toEqual({ key: slot().key })
    // A first comparison takes the layout setting: one row per entry, with each pair's previous value.
    expect(handle(keys[0]).diff).toHaveBeenLastCalledWith(handle(keys[1]), { exact: false, layout: 'entry', context: -1, signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    expect(info()).toMatchObject({ layout: 'entry', pairs: 2, exact: false })
    expect(compare.getSnapshot().announcements.get(slot().key)?.text).toBe('Comparison ready: matched by Id, 1 changed, 1 added, 0 removed.')
    const before = slot(), sets = tab().sets.length
    await compare.replace('t1', before.key, { layout: 'unified' })
    await settle()
    expect(handle(keys[0]).diff).toHaveBeenLastCalledWith(handle(keys[1]), { exact: false, layout: 'unified', context: -1, replaces: before.entry.handle, signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    // The same entry, number, place and name; another result, the old one released once the new one was shown.
    expect(slot()).toMatchObject({ key: before.key, entry: { number: before.entry.number, label: before.entry.label } })
    expect(slot().entry.descriptor.resultId).not.toBe(before.entry.descriptor.resultId)
    expect(slot().revision).toBe(before.revision + 1)
    expect(tab().sets).toHaveLength(sets)
    expect(client.released()).toContain(before.entry.descriptor.resultId)
    expect(info()).toMatchObject({ layout: 'unified' })
    expect(compare.getSnapshot().announcements.get(slot().key)?.text).toBe('Comparison updated: matched by Id, 1 changed, 1 added, 0 removed.')
    // Nothing runs; the old result's details went with it.
    expect(compare.getSnapshot().running.t1).toBeUndefined()
    expect(compare.getSnapshot().info.has(setKey(before.entry.descriptor))).toBe(false)
  })

  it('names Exact text "(exact text)" in its title and tab, and drops it when Exact text is turned off', async () => {
    const { compare, run, slot, info } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    expect(slot().entry.label).toBe('Differences: Result 1 → Result 2')
    await compare.replace('t1', slot().key, { exact: true })
    await settle()
    expect(info().exact).toBe(true)
    expect(slot().entry.label).toBe('Differences: Result 1 → Result 2 (exact text)')
    expect(comparisonTabLabel(slot())).toBe('Result 1 → Result 2 (exact text)')
    // One comparison per ordered pair, whatever its Exact text: the run has it either way.
    expect(compare.existing('t1', keys[0], keys[1])?.key).toBe(slot().key)
    await compare.replace('t1', slot().key, { exact: false })
    await settle()
    expect(slot().entry.label).toBe('Differences: Result 1 → Result 2')
  })

  it('lets a newer change cancel an older one, and keeps the old comparison on a failure or a Cancel, saying so', async () => {
    const { compare, results, run, handle, slot, info, answer } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const key = slot().key, shown = slot().entry.descriptor.resultId
    // A change in flight, then another: the first is given up and says nothing; the second shows.
    let first: DiffOptions | undefined
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((right, o) => { first = o; return hanging(right, o) })
    const older = compare.replace('t1', key, { layout: 'unified' })
    expect(compare.isReplacing('t1', key)).toBe(true)
    expect(compare.getSnapshot().running.t1).toEqual([`replace|${key}`])
    const newer = held<DiffAnswer>()
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce(() => newer.promise)
    const latest = compare.replace('t1', key, { exact: true })
    expect(first?.signal?.aborted).toBe(true)
    await expect(older).resolves.toBeUndefined()
    newer.resolve(answer(handle(keys[1]), { exact: true, layout: 'entry' }))
    await expect(latest).resolves.toEqual({ key })
    expect(info()).toMatchObject({ exact: true, layout: 'entry' })
    expect(compare.getSnapshot().notices.get(key)).toBeUndefined()
    // A failure leaves the comparison as it was and says why on it, until its next change.
    const now = slot().entry.descriptor.resultId
    expect(now).not.toBe(shown)
    vi.mocked(handle(keys[0]).diff).mockRejectedValueOnce(new Error('The backend is busy.'))
    await compare.replace('t1', key, { layout: 'unified' })
    expect(slot().entry.descriptor.resultId).toBe(now)
    expect(compare.getSnapshot().notices.get(key)).toBe('The comparison was not changed: The backend is busy.')
    expect(compare.getSnapshot().announcements.get(key)?.text).toBe('The comparison was not changed: The backend is busy.')
    // Cancel (its operation's): the same, and the notice says it was cancelled.
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce(hanging)
    const cancelled = compare.replace('t1', key, { layout: 'unified' })
    expect(compare.getSnapshot().notices.get(key)).toBeUndefined()
    expect(results.operations.getSnapshot().t1?.items.some(item => item.kind === 'compare')).toBe(true)
    compare.cancelChange('t1', key)
    await expect(cancelled).resolves.toBeUndefined()
    expect(slot().entry.descriptor.resultId).toBe(now)
    expect(compare.getSnapshot().notices.get(key)).toBe('The change was cancelled.')
    expect(compare.getSnapshot().running.t1).toBeUndefined()
    // The same sentence said again is a new announcement, so the live region reads it again.
    const at = compare.getSnapshot().announcements.get(key)!.at
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce(hanging)
    const again = compare.replace('t1', key, { layout: 'unified' })
    compare.cancelChange('t1', key)
    await again
    expect(compare.getSnapshot().announcements.get(key)).toEqual({ text: 'The change was cancelled.', at: at + 1 })
  })

  it('cancels a change when an input closes, and refuses every change while one is closed (D10)', async () => {
    const { compare, results, run, handle, slot } = fixture()
    const keys = run(3)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const key = slot().key
    expect(compare.closedReason('t1', key)).toBeUndefined()
    let asked: DiffOptions | undefined
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((right, o) => { asked = o; return hanging(right, o) })
    const change = compare.replace('t1', key, { layout: 'unified' })
    results.removeEntry('t1', keys[0])
    expect(asked?.signal?.aborted).toBe(true)
    await expect(change).resolves.toBeUndefined()
    expect(compare.getSnapshot().notices.get(key)).toBe('Result 1 was closed, so the change was cancelled.')
    // The comparison stays readable; each control that runs it again is refused with the reason.
    expect(slot().key).toBe(key)
    expect(compare.closedReason('t1', key)).toBe('Result 1 is closed')
    const calls = vi.mocked(handle(keys[1]).diff).mock.calls.length
    for (const change of [{ layout: 'unified' as const }, { exact: true }, { swap: true }]) await expect(compare.replace('t1', key, change)).resolves.toBeUndefined()
    expect(vi.mocked(handle(keys[1]).diff).mock.calls.length).toBe(calls)
    expect(results.comparing.getSnapshot().t1).toBeUndefined()
    results.focusEntry('t1', key)
    expect(results.comparing.getSnapshot().t1).toEqual({ entry: key, inputsOpen: false })
  })

  it('leaves the run\'s 1,000-result count alone: a change replaces, never adds', async () => {
    const { compare, run, tab, slot, info } = fixture()
    const keys = run(resultLimits.sets - 1)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    expect(tab().sets).toHaveLength(resultLimits.sets)
    expect(compare.adding('t1')).toBe(0)
    await compare.replace('t1', slot().key, { layout: 'unified' })
    await settle()
    expect(info().layout).toBe('unified')
    expect(tab().sets).toHaveLength(resultLimits.sets)
    expect(compare.getSnapshot().notices.get(slot().key)).toBeUndefined()
  })

  it('swaps its sides in place, carrying its widths and key columns by name, or focuses the pair the run has the other way round', async () => {
    const a = [column('Id'), column('Name'), column('Price')], b = [column('Name'), column('Id'), column('Price')]
    const { compare, results, run, tab, handle, slot, info, answers } = fixture({ columns: { 0: a, 1: b } })
    const keys = run(2)
    answers.match = { mode: 'columns', columns: ['Id'] }
    // Matched by Id, pair 0 of A → B (pairs follow the old side's columns).
    await compare.comparePair('t1', keys[0], keys[1], { exact: false, match: { mode: 'columns', columns: [0] } })
    await settle()
    const key = slot().key
    expect(info()).toMatchObject({ asked: { mode: 'columns', columns: [0] } })
    // The grid's widths: its columns are B's (Name, Id, Price), then their previous values.
    const state = results.gridState('t1', key)
    state.widths = Float64Array.from([110, 120, 130, 111, 121, 131, 10, 10, 10, 10]); state.userSized = new Set([0, 1, 2])
    await compare.replace('t1', key, { swap: true })
    await settle()
    // B → A, matched by Id again: B's pairs put Id second.
    expect(handle(keys[1]).diff).toHaveBeenLastCalledWith(handle(keys[0]), expect.objectContaining({ match: { mode: 'columns', columns: [1] }, replaces: expect.anything() }))
    expect(slot()).toMatchObject({ key, entry: { label: 'Differences: Result 2 → Result 1' } })
    expect(slot().sources.map(source => source.key)).toEqual([keys[1], keys[0]])
    expect(info()).toMatchObject({ left: keys[1], right: keys[0], asked: { mode: 'columns', columns: [1] } })
    // Now A's columns (Id, Name, Price): each width followed its column's name.
    const widths = [...results.gridState('t1', key).widths!].slice(0, 3)
    expect(widths).toEqual([120, 110, 130])
    expect(comparisonColumns(b.concat(suffix), a.concat(suffix))).toEqual(new Map([[0, 1], [1, 0], [2, 2]]))
    // Swapped back onto A → B while the run also has B → A made separately: that one is focused, nothing runs.
    const other = await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    expect(tab().comparisons).toHaveLength(2)
    const calls = vi.mocked(handle(keys[1]).diff).mock.calls.length
    await expect(compare.replace('t1', key, { swap: true })).resolves.toEqual(other)
    expect(vi.mocked(handle(keys[1]).diff).mock.calls.length).toBe(calls)
    expect(tab().focused).toBe((other as { key: string }).key)
  })

  it('builds a change on one still running, so quick changes compose and a toggle twice turns back', async () => {
    const { compare, run, handle, slot, info } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const key = slot().key
    vi.mocked(handle(keys[0]).diff).mockImplementation(hanging)
    vi.mocked(handle(keys[1]).diff).mockImplementation(hanging)
    // Swap, then Exact text before the swap lands: the swapped sides with Exact text, not Exact text on the old sides.
    void compare.replace('t1', key, { swap: true })
    expect(compare.pendingChange('t1', key)).toMatchObject({ left: keys[1], right: keys[0], exact: false })
    void compare.replace('t1', key, { exact: !compare.pendingChange('t1', key)!.exact })
    expect(handle(keys[1]).diff).toHaveBeenLastCalledWith(handle(keys[0]), expect.objectContaining({ exact: true }))
    expect(compare.pendingChange('t1', key)).toMatchObject({ left: keys[1], right: keys[0], exact: true })
    // Swap again while that runs: back to the comparison's own sides, still with Exact text.
    void compare.replace('t1', key, { swap: true })
    expect(handle(keys[0]).diff).toHaveBeenLastCalledWith(handle(keys[1]), expect.objectContaining({ exact: true }))
    expect(compare.pendingChange('t1', key)).toMatchObject({ left: keys[0], right: keys[1], exact: true })
    compare.cancelChange('t1', key)
    await settle()
    expect(compare.pendingChange('t1', key)).toBeUndefined()
    expect(info()).toMatchObject({ left: keys[0], right: keys[1], exact: false })
  })

  it('keeps one comparison per ordered pair while a swap or a first run of that pair is in flight (D9)', async () => {
    const { compare, run, tab, handle, slot } = fixture()
    const keys = run(3)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const key = slot().key
    vi.mocked(handle(keys[1]).diff).mockImplementation(hanging)
    // A → B swapping to B → A: asking for B → A focuses that comparison and runs nothing more.
    void compare.replace('t1', key, { swap: true })
    const calls = vi.mocked(handle(keys[1]).diff).mock.calls.length
    await expect(compare.comparePair('t1', keys[1], keys[0], { exact: false })).resolves.toEqual({ key })
    expect(vi.mocked(handle(keys[1]).diff).mock.calls.length).toBe(calls)
    compare.cancelChange('t1', key)
    await settle()
    // While A → B swaps away, A → B is free: the popover's Update or Compare with Previous never builds on the swap.
    void compare.replace('t1', key, { swap: true })
    expect(compare.existing('t1', keys[0], keys[1])).toBeUndefined()
    expect(compare.existing('t1', keys[1], keys[0])?.key).toBe(key)
    compare.cancelChange('t1', key)
    await settle()
    expect(compare.existing('t1', keys[0], keys[1])?.key).toBe(key)
    // B → A as a first run in flight: swapping A → B onto it is refused, saying why, and only the first run is left running.
    void compare.comparePair('t1', keys[1], keys[0], { exact: false })
    await expect(compare.replace('t1', key, { swap: true })).resolves.toBeUndefined()
    expect(compare.getSnapshot().announcements.get(key)?.text).toBe('Result 2 → Result 1 is already being compared.')
    expect(compare.getSnapshot().notices.get(key)).not.toContain('already being compared')
    expect(compare.isReplacing('t1', key)).toBe(false)
    expect(compare.isRunning('t1', keys[1], keys[0])).toBe(true)
    compare.cancel('t1', keys[1], keys[0])
    await settle()
    expect(tab().comparisons).toHaveLength(1)
    // A → B asked for while its comparison swaps away: it counts as running, and nothing starts until the swap settles
    // (cancelled or failed, the comparison stays A → B).
    void compare.replace('t1', key, { swap: true })
    expect(compare.isRunning('t1', keys[0], keys[1])).toBe(true)
    const before = vi.mocked(handle(keys[0]).diff).mock.calls.length
    await expect(compare.comparePair('t1', keys[0], keys[1], { exact: false })).resolves.toBeUndefined()
    expect(vi.mocked(handle(keys[0]).diff).mock.calls.length).toBe(before)
    expect(tab().focused).toBe(key)
    // The pair's Cancel (the popover's) stops that swap; the comparison stays A → B.
    compare.cancel('t1', keys[0], keys[1])
    await settle()
    expect(compare.isReplacing('t1', key)).toBe(false)
    expect(compare.getSnapshot().notices.get(key)).toBe('The change was cancelled.')
    expect(compare.isRunning('t1', keys[0], keys[1])).toBe(false)
    expect(tab().comparisons).toHaveLength(1)
  })

  it('judges Exact text by a change in flight, in Show It and Compare with Previous', async () => {
    const { compare, run, handle, slot } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const key = slot().key
    vi.mocked(handle(keys[0]).diff).mockImplementation(hanging)
    void compare.replace('t1', key, { exact: true })
    expect(compare.stateOf('t1', slot().entry)?.exact).toBe(true)
    // Compare with Previous Result's Exact Text form: already on its way to Exact text, so nothing more runs.
    const calls = vi.mocked(handle(keys[0]).diff).mock.calls.length
    await compare.compare('t1', keys[1], { exact: true })
    expect(vi.mocked(handle(keys[0]).diff).mock.calls.length).toBe(calls)
    compare.cancelChange('t1', key)
    await settle()
    expect(compare.stateOf('t1', slot().entry)?.exact).toBe(false)
  })

  it('carries widths by name and type, so same-named text and binary columns keep theirs across a swap', () => {
    const from = [column('a'), { ...column('a'), wire: 'binary' as const }], to = [{ ...column('a'), wire: 'binary' as const }, column('a')]
    expect(comparisonColumns(from.concat(suffix), to.concat(suffix))).toEqual(new Map([[0, 1], [1, 0]]))
  })

  it('drops the details of a change the run refuses to show', async () => {
    const { compare, results, run, slot } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const shown = compare.getSnapshot().info.size
    vi.spyOn(results, 'replaceComparison').mockImplementation(() => undefined)
    await expect(compare.replace('t1', slot().key, { layout: 'unified' })).resolves.toBeUndefined()
    await settle()
    expect(compare.getSnapshot().info.size).toBe(shown)
  })

  it('falls back to two rows past the pairs one row can show (D12), and says so', () => {
    expect(layoutFor('entry', wire.diff.maxEntryPairs)).toEqual({ layout: 'entry', fallback: false })
    expect(layoutFor('entry', wire.diff.maxEntryPairs + 1)).toEqual({ layout: 'unified', fallback: true })
    expect(layoutFor('unified', wire.diff.maxEntryPairs + 1)).toEqual({ layout: 'unified', fallback: false })
    const info = { left: 'e1', right: 'e2', leftNumber: 1, rightNumber: 2, match: { mode: 'auto' as const, columns: ['Id'] }, layout: 'unified' as const, fallback: true as const, pairs: 3000, columnChanges: [], exact: false, same: 1, changed: 2, added: 0, removed: 1, soft: 0, leftOnly: [], rightOnly: [], approximate: false, repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, trailingHidden: 0, leftRows: 4, rightRows: 4 }
    expect(comparisonNotices(info).map(notice => notice.text)).toEqual([fallbackText])
    expect(publishText(info, false, comparisonNotices(info).map(notice => notice.text))).toBe(`Comparison ready: matched by Id, 2 changed, 0 added, 1 removed. ${fallbackText}`)
  })
})

describe('a comparison\'s first run and Exact text (D13)', () => {
  it('gives up a first run asked again with other options, and runs it with those', async () => {
    const { compare, run, tab, handle, info } = fixture()
    const keys = run(2)
    let first: DiffOptions | undefined
    vi.mocked(handle(keys[0]).diff).mockImplementationOnce((right, o) => { first = o; return hanging(right, o) })
    const older = compare.comparePair('t1', keys[0], keys[1], { exact: false })
    // The same options again do nothing.
    await expect(compare.comparePair('t1', keys[0], keys[1], { exact: false })).resolves.toBeUndefined()
    expect(first?.signal?.aborted).toBe(false)
    const newer = compare.comparePair('t1', keys[0], keys[1], { exact: true })
    expect(first?.signal?.aborted).toBe(true)
    await expect(older).resolves.toBeUndefined()
    await newer
    await settle()
    expect(tab().comparisons).toHaveLength(1)
    expect(info().exact).toBe(true)
  })

  it('applies the popover\'s Exact text to the comparison the run has (Update), and Show It only focuses one that matches', async () => {
    const { compare, results, run, tab, handle, slot, info } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    const key = slot().key
    results.focusEntry('t1', keys[1])
    compare.open('t1', keys[1])
    expect(compare.getSnapshot().pickers.t1).toMatchObject({ exact: false })
    // Show It: the comparison matches the popover, so it is focused, not run again.
    await expect(compare.run('t1')).resolves.toBe(key)
    expect(handle(keys[0]).diff).toHaveBeenCalledTimes(1)
    expect(tab().focused).toBe(key)
    // Update: Exact text turned on in the popover replaces it in place.
    results.focusEntry('t1', keys[1])
    compare.open('t1', keys[1])
    compare.setExact('t1', true)
    await expect(compare.run('t1')).resolves.toBe(key)
    expect(handle(keys[0]).diff).toHaveBeenCalledTimes(2)
    expect(handle(keys[0]).diff).toHaveBeenLastCalledWith(handle(keys[1]), expect.objectContaining({ exact: true, replaces: expect.anything() }))
    expect(tab().comparisons).toHaveLength(1)
    expect(info().exact).toBe(true)
    expect(tab().focused).toBe(key)
    expect(compare.getSnapshot().pickers.t1).toBeUndefined()
  })

  it('never turns Exact text off from Compare with Previous Result; its Exact Text form turns it on', async () => {
    const { compare, run, tab, handle, slot, info } = fixture()
    const keys = run(2)
    await compare.comparePair('t1', keys[0], keys[1], { exact: true })
    await settle()
    await compare.compare('t1', keys[1])
    expect(handle(keys[0]).diff).toHaveBeenCalledTimes(1)
    expect(info().exact).toBe(true)
    expect(tab().focused).toBe(slot().key)
    await compare.replace('t1', slot().key, { exact: false })
    await settle()
    await compare.compare('t1', keys[1], { exact: true })
    await settle()
    expect(info().exact).toBe(true)
    expect(handle(keys[0]).diff).toHaveBeenCalledTimes(3)
    expect(tab().comparisons).toHaveLength(1)
  })
})

describe('a comparison\'s highlights through a change (D15)', () => {
  /** A comparison of five stored rows with row 2 highlighted (the fake's identity of row r is 1000 + r). */
  async function highlighted() {
    const f = fixture()
    const keys = f.run(2)
    await f.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await settle()
    f.results.setSelection('t1', f.slot().key, rows(f.slot().key, 2, 2))
    await f.highlights.highlight('t1', f.slot().key, 1)
    await settle()
    expect(f.marked()).toMatchObject({ count: 1, found: 1 })
    return { ...f, keys }
  }

  it('carry through a layout switch and a swap, drawn on the new result', async () => {
    const { compare, slot, marked } = await highlighted()
    for (const change of [{ layout: 'unified' as const }, { swap: true }]) {
      await compare.replace('t1', slot().key, change)
      await settle()
      expect(marked()).toMatchObject({ count: 1, found: 1 })
      expect(marked()!.rows.map(item => item.handle)).toEqual([slot().entry.handle])
    }
    expect(compare.getSnapshot().announcements.get(slot().key)?.text).toMatch(/^Comparison updated/)
  })

  it('drop and count those whose entry is gone once every row is stored', async () => {
    const { compare, slot, marked, answers, highlights } = await highlighted()
    // Every row stored (context -1) and only two of them: entry 1002 is gone.
    answers.stored = 2
    await compare.replace('t1', slot().key, { context: -1 })
    await settle()
    await settle()
    expect(marked()?.count ?? 0).toBe(0)
    expect(highlights.hasHighlights('t1', slot().key)).toBe(false)
    expect(compare.getSnapshot().announcements.get(slot().key)?.text).toBe('1 highlight removed')
  })

  it('keep those Changes only does not store, silently, and draw them again with All rows; never say they are missing', async () => {
    const { compare, slot, marked, answers } = await highlighted()
    // All rows: five rows, the highlight found.
    await compare.replace('t1', slot().key, { context: -1 })
    await settle()
    expect(marked()).toMatchObject({ count: 1, found: 1 })
    // Changes only: two rows; the unchanged entry's highlight is kept, not counted removed.
    answers.stored = 2
    const said = compare.getSnapshot().announcements.get(slot().key)?.text
    await compare.replace('t1', slot().key, { context: 1 })
    await settle()
    expect(marked()).toMatchObject({ count: 1, found: 0 })
    expect(compare.getSnapshot().announcements.get(slot().key)?.text).toMatch(/^Comparison updated/)
    expect(said).toMatch(/^Comparison updated/)
    // The strip never says "not in these results" on a comparison; a plain result would.
    expect(highlightText(marked(), { comparison: true })).toBeUndefined()
    expect(highlightText(marked())).toMatch(/not in these results/)
    // All rows again: drawn again.
    answers.stored = 5
    await compare.replace('t1', slot().key, { context: -1 })
    await settle()
    expect(marked()).toMatchObject({ count: 1, found: 1 })
  })

  it('keep every highlight when the new result\'s search is truncated, though every row is stored', async () => {
    const { compare, slot, marked, answers, client } = await highlighted()
    answers.stored = 2
    // The next result's search lists only some rows.
    const open = client.open.getMockImplementation()!
    client.open.mockImplementation(value => {
      const made = open(value) as FakeHandle
      if (value.kind === 'diff') vi.mocked(made.findRows).mockImplementation(async () => ({ positions: [], marks: [], truncated: true, rows: 2 }))
      return made
    })
    await compare.replace('t1', slot().key, { context: -1 })
    await settle()
    expect(marked()).toMatchObject({ count: 1, found: 0, truncated: true })
    expect(compare.getSnapshot().announcements.get(slot().key)?.text).toMatch(/^Comparison updated/)
  })
})
