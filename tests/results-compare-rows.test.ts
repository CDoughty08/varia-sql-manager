// A comparison's Rows (All rows or Changes only), its refusal of All rows (in the popover, else an actionable results
// notice that a later notice leaves), its remembered match (written by every change of match and every swap, and given
// up for Automatic only when the backend refuses its key columns as too long), its kind chips and its notices.
import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { CompareService, comparisonNotices, contextOf, rememberedLabel, rowsRefusedText, type CompareInfo, type CompareRows } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import { ResultError, type ResultHandle } from '../src/renderer/src/results/ResultClient'
import { ResultsService, setKey, type TabResults } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
type DiffOptions = Parameters<ResultHandle['diff']>[1]
type DiffAnswer = Awaited<ReturnType<ResultHandle['diff']>>

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  let rows: CompareRows = 'all'
  const compare = new CompareService(results, { jobs: new DerivedJobs({ timers: timers.timers }), rows: () => rows })
  const counts = { same: 1, changed: 1, added: 1, removed: 0 }
  let nextId = 1000
  const answer = (right: ResultHandle, options?: DiffOptions): DiffAnswer => {
    const data = right.columns.filter(item => item.role === undefined)
    const match = options?.match?.mode === 'columns' ? { mode: 'columns' as const, columns: options.match.columns.map(index => data[index]?.name ?? '') } : options?.match ? { mode: options.match.mode, columns: [] } : { mode: 'auto' as const, columns: ['Id'] }
    return {
      descriptor: descriptor(nextId++, { index: 9, kind: 'diff', rowsRead: 3, rowsStored: 3, rowsAvailable: 3, columns: [...data, { name: 'Change', dataType: 'int', wire: 'text', nullable: false, role: 'mark' }, { name: '', dataType: 'int', wire: 'text', nullable: false, role: 'tone' }] }),
      match, ...counts, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false,
      nothingPaired: false, columnChanges: data.map(() => ({ changed: 1, soft: 0 })), trailingHidden: 0, overview: [], units: 2, layout: 'unified'
    }
  }
  const run = (count: number) => {
    results.begin('t1', 'q1')
    const values = Array.from({ length: count }, (_, index) => descriptor(index + 1, { index, rowsRead: 5, rowsStored: 5, rowsAvailable: 5 }))
    for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q1', { summary: summaryOf(values) })
    for (const value of values) vi.mocked(client.handle(value.resultId)!.diff).mockImplementation(async (right, options) => answer(right, options))
    return results.getSnapshot().t1.sets.map(set => set.key)
  }
  const tab = (): TabResults => results.getSnapshot().t1
  const handle = (key: string) => tab().sets.find(set => set.key === key)!.handle as FakeHandle
  const slot = () => tab().comparisons[0]
  const info = () => compare.getSnapshot().info.get(setKey(slot().entry.descriptor))!
  return { results, compare, run, tab, handle, slot, info, counts, setRows: (value: CompareRows) => { rows = value } }
}

describe('a comparison\'s rows', () => {
  it('keeps every row by default, and only the changes when the setting says so', async () => {
    expect(contextOf('all')).toBe(-1)
    expect(contextOf('changes')).toBe(0)
    const view = fixture()
    const keys = view.run(3)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    expect(view.handle(keys[0]).diff).toHaveBeenLastCalledWith(view.handle(keys[1]), expect.objectContaining({ context: -1 }))
    view.setRows('changes')
    await view.compare.comparePair('t1', keys[1], keys[2], { exact: false })
    expect(view.handle(keys[1]).diff).toHaveBeenLastCalledWith(view.handle(keys[2]), expect.objectContaining({ context: 0 }))
  })

  it('changes Rows in place', async () => {
    const view = fixture()
    const keys = view.run(2)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await view.compare.replace('t1', view.slot().key, { context: 0 })
    await settle()
    expect(view.handle(keys[0]).diff).toHaveBeenLastCalledWith(view.handle(keys[1]), expect.objectContaining({ context: 0, replaces: expect.anything() }))
    expect(view.info().context).toBe(0)
    expect(view.compare.toggles.getSnapshot().t1).toBeUndefined()
  })

  it('says a first run All rows could not fit in the results area, and a later notice leaves it there', async () => {
    const view = fixture()
    const keys = view.run(2)
    vi.mocked(view.handle(keys[0]).diff).mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    const notice = view.compare.getSnapshot().actionable.t1
    expect(notice).toMatchObject({ old: keys[0], neu: keys[1], text: rowsRefusedText })
    expect(view.tab().jobNotice).toBeFalsy()
    // A copy or save says its own notice; the actionable one stays.
    view.results.notify('t1', 'Copied 3 rows.')
    expect(view.tab().jobNotice).toBe('Copied 3 rows.')
    expect(view.compare.getSnapshot().actionable.t1).toBe(notice)
    // Show changes only runs the same comparison with Changes only, and clears it.
    const made = await view.compare.runActionable('t1')
    expect(made).toBe(view.slot().key)
    expect(view.handle(keys[0]).diff).toHaveBeenLastCalledWith(view.handle(keys[1]), expect.objectContaining({ context: 0 }))
    expect(view.compare.getSnapshot().actionable.t1).toBeUndefined()
  })

  it('makes the actionable notice\'s button unavailable while an input is closed, saying which (D10)', async () => {
    const view = fixture()
    const keys = view.run(2)
    vi.mocked(view.handle(keys[0]).diff).mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    expect(view.compare.actionableReason('t1')).toBeUndefined()
    view.results.removeEntry('t1', keys[1])
    // Closing an input takes the notice away, so its button never runs on a closed result.
    expect(view.compare.getSnapshot().actionable.t1).toBeUndefined()
    expect(view.compare.actionableReason('t1')).toBeUndefined()
    await expect(view.compare.runActionable('t1')).resolves.toBeUndefined()
    expect(view.handle(keys[0]).diff).toHaveBeenCalledTimes(1)
  })

  it('says a refused change on its comparison, and offers Changes only there', async () => {
    const view = fixture()
    const keys = view.run(2)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    const key = view.slot().key
    vi.mocked(view.handle(keys[0]).diff).mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await view.compare.replace('t1', key, { exact: true })
    await settle()
    const notices = view.compare.visibleNotices(key, view.info())
    expect(notices[0]).toMatchObject({ kind: 'change', tone: 'warning', text: rowsRefusedText, actions: ['changesOnly'] })
    // Show changes only asks the refused change again, with Changes only.
    expect(view.compare.refusedChange(key)).toEqual({ exact: true, context: 0 })
    // Dismissed, it goes.
    view.compare.dismiss(key, notices[0])
    expect(view.compare.visibleNotices(key, view.info()).some(notice => notice.kind === 'change')).toBe(false)
  })
})

describe('a comparison\'s remembered match', () => {
  it('is written by a change of match and by a swap, and used by the pair\'s next first run', async () => {
    const view = fixture()
    const keys = view.run(2)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await view.compare.replace('t1', view.slot().key, { match: { mode: 'columns', columns: [0] } })
    await settle()
    expect(view.compare.rememberedMatch('t1', 'Result 1', 'Result 2')).toEqual({ mode: 'columns', columns: [{ name: 'Id', type: 'int' }] })
    expect(rememberedLabel(view.compare.rememberedMatch('t1', 'Result 1', 'Result 2')!)).toBe('⚷ Id')
    // A swap remembers the match for the pair the other way round.
    await view.compare.replace('t1', view.slot().key, { swap: true })
    await settle()
    expect(view.compare.rememberedMatch('t1', 'Result 2', 'Result 1')).toMatchObject({ mode: 'columns' })
    // Closed and compared again, the pair matches by its remembered key columns.
    view.results.removeEntry('t1', view.slot().key)
    await settle()
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false, remember: true })
    expect(view.handle(keys[0]).diff).toHaveBeenLastCalledWith(view.handle(keys[1]), expect.objectContaining({ match: { mode: 'columns', columns: [0] } }))
    expect(view.info().rememberedLost).toBeUndefined()
    // Asked without remembering (a palette command's own options), it is Automatic.
    expect(view.compare.pickerMatch('t1')).toBeUndefined()
  })

  it('falls back to Automatic only when the backend refuses the remembered key columns as too long, and says so', async () => {
    const view = fixture()
    const keys = view.run(2)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    await view.compare.replace('t1', view.slot().key, { match: { mode: 'columns', columns: [0] } })
    await settle()
    view.results.removeEntry('t1', view.slot().key)
    await settle()
    const diff = vi.mocked(view.handle(keys[0]).diff)
    diff.mockClear()
    diff.mockRejectedValueOnce(new ResultError('DIFF_KEY_TRUNCATED', 'Key too long.'))
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false, remember: true })
    expect(diff).toHaveBeenCalledTimes(2)
    expect(diff.mock.calls[0][1]).toMatchObject({ match: { mode: 'columns', columns: [0] } })
    expect(diff.mock.calls[1][1]?.match).toBeUndefined()
    expect(view.info().rememberedLost).toBe('Id')
    expect(comparisonNotices(view.info())[0]).toMatchObject({ kind: 'remembered', tone: 'warning' })
  })

  it('does not fall back for any other refusal, nor without a remembered match', async () => {
    for (const code of ['DIFF_ROWS_TOO_LARGE', 'TOO_LARGE', 'BACKEND_ERROR'] as const) {
      const view = fixture()
      const keys = view.run(2)
      await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
      await view.compare.replace('t1', view.slot().key, { match: { mode: 'columns', columns: [0] } })
      await settle()
      view.results.removeEntry('t1', view.slot().key)
      await settle()
      const diff = vi.mocked(view.handle(keys[0]).diff)
      diff.mockClear()
      diff.mockRejectedValueOnce(new ResultError(code, 'Refused.'))
      const outcome = await view.compare.comparePair('t1', keys[0], keys[1], { exact: false, remember: true, quiet: true })
      expect(diff, code).toHaveBeenCalledTimes(1)
      expect(outcome, code).toMatchObject({ code })
    }
    // Key columns asked for directly (not remembered) are not given up either.
    const view = fixture()
    const keys = view.run(2)
    const diff = vi.mocked(view.handle(keys[0]).diff)
    diff.mockRejectedValueOnce(new ResultError('DIFF_KEY_TRUNCATED', 'Key too long.'))
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false, match: { mode: 'columns', columns: [0] }, quiet: true })
    expect(diff).toHaveBeenCalledTimes(1)
  })
})

describe('a comparison\'s kind chips', () => {
  it('press and release kinds as one kind filter, and stay available while an input is closed', async () => {
    const view = fixture()
    const keys = view.run(2)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    const key = view.slot().key
    const setKindFilter = vi.spyOn(view.results, 'setKindFilter')
    // The comparison's filtered view (the fake only answers what a view is).
    const diff = view.slot().entry.handle as FakeHandle
    let viewId = 1
    vi.mocked(diff.sort).mockImplementation(async () => ({ ...diff, base: diff, viewId: viewId++, keys: [], filters: [], rows: 1, baseRows: 3, complete: true, approximate: false, close: async () => {} }) as never)
    view.compare.toggleKind('t1', key, 'changed')
    expect(setKindFilter).toHaveBeenLastCalledWith('t1', key, ['changed'])
    await settle()
    expect(view.compare.pressedKinds('t1', key)).toEqual(['changed'])
    // A second kind joins it, in chip order.
    view.compare.toggleKind('t1', key, 'added')
    expect(setKindFilter).toHaveBeenLastCalledWith('t1', key, ['added', 'changed'])
    await settle()
    view.compare.toggleKind('t1', key, 'changed')
    expect(setKindFilter).toHaveBeenLastCalledWith('t1', key, ['added'])
    await settle()
    view.results.removeEntry('t1', keys[0])
    view.compare.toggleKind('t1', key, 'added')
    expect(setKindFilter).toHaveBeenLastCalledWith('t1', key, [])
  })
})

describe('a comparison\'s notices', () => {
  const base: CompareInfo = { left: 'e1', right: 'e2', leftNumber: 1, rightNumber: 2, match: { mode: 'auto', columns: ['Id'] }, layout: 'unified', pairs: 2, columnChanges: [], exact: false, same: 4, changed: 0, added: 0, removed: 0, soft: 0, leftOnly: [], rightOnly: [], approximate: false, repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, trailingHidden: 0, leftRows: 4, rightRows: 4 }
  it('say what matching found, with buttons where a choice helps', () => {
    expect(comparisonNotices({ ...base, context: 0 }).map(notice => notice.text)).toEqual(['No differences. 4 unchanged rows hidden.'])
    expect(comparisonNotices({ ...base, leftRows: 0, rightRows: 0, same: 0 }).map(notice => notice.text)).toEqual(['Both results are empty.'])
    const nothing = comparisonNotices({ ...base, same: 0, added: 4, removed: 4, nothingPaired: true, possible: 4 })
    expect(nothing.map(notice => [notice.kind, notice.actions])).toEqual([['nothingPaired', ['chooseKeys', 'byPosition']], ['possible', undefined]])
    expect(nothing[0].text).toBe('No rows matched by Id, so every row shows as removed or added.')
    // Match by row position is offered only when both sides have as many rows.
    expect(comparisonNotices({ ...base, same: 0, added: 5, removed: 4, rightRows: 5, nothingPaired: true })[0].actions).toEqual(['chooseKeys'])
    expect(comparisonNotices({ ...base, changed: 1, possible: 1 })[0]).toMatchObject({ kind: 'possible', text: '1 removed and 1 added row look like the same row with a changed key (Id). Counts and colours are unchanged.' })
  })

  it('offers nothing when the refused change asked only for All rows, and forgets a pair set back to Automatic', async () => {
    const view = fixture()
    view.setRows('changes')
    const keys = view.run(2)
    await view.compare.comparePair('t1', keys[0], keys[1], { exact: false })
    const key = view.slot().key
    vi.mocked(view.handle(keys[0]).diff).mockRejectedValueOnce(new ResultError('DIFF_ROWS_TOO_LARGE', 'Too many rows.'))
    await view.compare.replace('t1', key, { context: -1 })
    await settle()
    expect(view.compare.refusedChange(key)).toBeUndefined()
    expect(view.compare.visibleNotices(key, view.info())[0]).toMatchObject({ kind: 'change', text: rowsRefusedText })
    expect(view.compare.visibleNotices(key, view.info())[0].actions).toBeUndefined()
    await view.compare.replace('t1', key, { match: { mode: 'position' } })
    await settle()
    expect(view.compare.rememberedMatch('t1', 'Result 1', 'Result 2')).toEqual({ mode: 'position' })
    await view.compare.replace('t1', view.slot().key, { match: { mode: 'auto' } })
    await settle()
    expect(view.compare.rememberedMatch('t1', 'Result 1', 'Result 2')).toBeUndefined()
  })
})
